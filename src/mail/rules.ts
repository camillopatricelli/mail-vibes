import { AuthRequiredError } from '../auth/errors'
import { MAILBOX_SCOPES } from '../auth/msal'
import { google } from '../providers/google'
import { ApiError, graph, type GraphPage } from '../providers/graph'
import { useSettings, type ImapRule } from '../settings/store'
import { isImap, providerFor } from './api'
import { refreshAccountMail } from './data'
import type { MailSummary } from './types'

/**
 * Mail rules are the accounts' own rules, run by Google and Microsoft on their servers (so they
 * work while Mail Vibes is closed): Gmail filters and Outlook Inbox rules. The app edits the
 * simple kind (from / contains → mark as read, archive, move, delete) and lists the others
 * read-only, with a link to Gmail or Outlook.
 *
 * IMAP servers have no rules: an IMAP account's rules are kept in the settings and run by the
 * app on new Inbox mail (src/mail/imap/provider.ts), so only while Mail Vibes is open.
 */

export type RuleMove = { kind: 'none' } | { kind: 'archive' } | { kind: 'folder'; id: string } | { kind: 'delete' }

export interface RuleSpec {
  /** Sender address, or part of it */
  from: string
  /** Words the subject or body must contain (one phrase) */
  words: string
  markRead: boolean
  move: RuleMove
  /** Outlook only: the rule's name */
  name?: string
}

export interface MailRule {
  accountId: string
  id: string
  /** Set when Mail Vibes can edit the rule; other rules are shown read-only */
  spec?: RuleSpec
  /** Outlook: the rule's name; Gmail: a search-style description (for read-only rules) */
  label: string
  enabled: boolean
  hasError: boolean
  /** Outlook: position in the rule order */
  sequence?: number
}

export interface RuleList {
  rules: MailRule[]
  /** The account hasn't granted the permission rules need yet */
  needsConsent: boolean
}

export const isEmptySpec = (s: RuleSpec) => !s.from.trim() && !s.words.trim()
export const hasNoAction = (s: RuleSpec) => !s.markRead && s.move.kind === 'none'

// ---- Gmail filters --------------------------------------------------------------------------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GFilter {
  id?: string
  criteria?: {
    from?: string
    to?: string
    subject?: string
    query?: string
    negatedQuery?: string
    hasAttachment?: boolean
    excludeChats?: boolean
    size?: number
    sizeComparison?: string
  }
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string }
}

/** Gmail matches separate words anywhere; quotes make it look for the exact phrase. */
export function gmailPhrase(words: string) {
  const w = words.trim().replace(/"/g, '')
  return /\s/.test(w) ? `"${w}"` : w
}

/** The words of a Gmail query the app can edit: one word or one quoted phrase, no search operators. */
function phraseOf(query: string): string | undefined {
  const q = query.trim()
  const quoted = /^"([^"]*)"$/.exec(q)
  if (quoted) return quoted[1]
  if (/[\s:"(){}\-]/.test(q) || /^(OR|AND)$/.test(q)) return undefined
  return q
}

export function specToGmail(s: RuleSpec): GFilter {
  const criteria: NonNullable<GFilter['criteria']> = {}
  if (s.from.trim()) criteria.from = s.from.trim()
  if (s.words.trim()) criteria.query = gmailPhrase(s.words)
  const add: string[] = []
  const remove: string[] = []
  if (s.markRead) remove.push('UNREAD')
  if (s.move.kind === 'delete') add.push('TRASH')
  else if (s.move.kind === 'archive') remove.push('INBOX')
  else if (s.move.kind === 'folder') {
    add.push(s.move.id)
    remove.push('INBOX')
  }
  return { criteria, action: { ...(add.length ? { addLabelIds: add } : {}), ...(remove.length ? { removeLabelIds: remove } : {}) } }
}

export function gmailToSpec(f: GFilter): RuleSpec | undefined {
  const c = f.criteria ?? {}
  const a = f.action ?? {}
  const extra = Object.entries(c).some(([k, v]) => k !== 'from' && k !== 'query' && v !== undefined && v !== false && v !== '')
  if (extra || a.forward) return undefined
  const words = c.query ? phraseOf(c.query) : ''
  if (words === undefined) return undefined
  const add = a.addLabelIds ?? []
  const remove = a.removeLabelIds ?? []
  if (add.length > 1 || remove.some((l) => l !== 'UNREAD' && l !== 'INBOX')) return undefined
  const outOfInbox = remove.includes('INBOX')
  let move: RuleMove = { kind: 'none' }
  if (add[0] === 'TRASH') move = { kind: 'delete' }
  else if (add[0]) {
    // Only "move to a label" (label + out of the Inbox); labelling alone, or system labels, are other features.
    if (!outOfInbox || !add[0].startsWith('Label_')) return undefined
    move = { kind: 'folder', id: add[0] }
  } else if (outOfInbox) move = { kind: 'archive' }
  const spec: RuleSpec = { from: c.from ?? '', words, markRead: remove.includes('UNREAD'), move }
  return isEmptySpec(spec) || hasNoAction(spec) ? undefined : spec
}

/** A Gmail-search-style description of any filter, for the ones the app can't edit. */
export function describeGmail(f: GFilter, labelName: (id: string) => string) {
  const c = f.criteria ?? {}
  const a = f.action ?? {}
  const parts = [
    c.from && `from:(${c.from})`,
    c.to && `to:(${c.to})`,
    c.subject && `subject:(${c.subject})`,
    c.query,
    c.negatedQuery && `-{${c.negatedQuery}}`,
    c.hasAttachment && 'has:attachment',
    c.size && `${c.sizeComparison === 'smaller' ? 'smaller' : 'larger'}:${c.size}`,
  ].filter(Boolean)
  const actions = [
    ...(a.addLabelIds ?? []).map((id) => `+${labelName(id)}`),
    ...(a.removeLabelIds ?? []).map((id) => `−${labelName(id)}`),
    a.forward && `→ ${a.forward}`,
  ].filter(Boolean)
  return `${parts.join(' ')}  ⇒  ${actions.join(', ')}`
}

const isScopeError = (e: unknown) => e instanceof AuthRequiredError || (e instanceof ApiError && e.status === 403)

async function gmailLabelNames(accountId: string) {
  const r = await google<{ labels?: { id: string; name: string }[] }>(accountId, `${GMAIL}/labels`)
  return new Map((r.labels ?? []).map((l) => [l.id, l.name]))
}

async function listGmail(accountId: string): Promise<RuleList> {
  let filters: GFilter[]
  try {
    filters = (await google<{ filter?: GFilter[] }>(accountId, `${GMAIL}/settings/filters`, { quiet: true })).filter ?? []
  } catch (e) {
    // 403: the token predates the filters permission (or it wasn't ticked).
    if (e instanceof ApiError && e.status === 403) return { rules: [], needsConsent: true }
    throw e
  }
  const names = filters.length ? await gmailLabelNames(accountId) : new Map<string, string>()
  return {
    needsConsent: false,
    rules: filters.map((f) => ({
      accountId,
      id: f.id!,
      spec: gmailToSpec(f),
      label: describeGmail(f, (id) => names.get(id) ?? id),
      enabled: true,
      hasError: false,
    })),
  }
}

// ---- Outlook rules --------------------------------------------------------------------------

type Addr = { emailAddress?: { address?: string; name?: string } }
export interface ORule {
  id?: string
  displayName?: string
  sequence?: number
  isEnabled?: boolean
  hasError?: boolean
  isReadOnly?: boolean
  conditions?: Record<string, unknown> | null
  actions?: Record<string, unknown> | null
  exceptions?: Record<string, unknown> | null
}

const blank = (v: unknown) => v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)
const looksLikeAddress = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

export function outlookToSpec(r: ORule, archiveId?: string): RuleSpec | undefined {
  if (r.isReadOnly) return undefined
  const c = r.conditions ?? {}
  const a = r.actions ?? {}
  if (Object.values(r.exceptions ?? {}).some((v) => !blank(v))) return undefined
  if (Object.entries(c).some(([k, v]) => !['fromAddresses', 'senderContains', 'bodyOrSubjectContains'].includes(k) && !blank(v))) return undefined
  if (Object.entries(a).some(([k, v]) => !['markAsRead', 'moveToFolder', 'delete', 'stopProcessingRules'].includes(k) && !blank(v))) return undefined
  const fromAddresses = (c.fromAddresses as Addr[] | undefined) ?? []
  const senderContains = (c.senderContains as string[] | undefined) ?? []
  const words = (c.bodyOrSubjectContains as string[] | undefined) ?? []
  if (fromAddresses.length + senderContains.length > 1 || words.length > 1) return undefined
  if (a.delete && a.moveToFolder) return undefined
  const folder = a.moveToFolder as string | undefined
  const move: RuleMove = a.delete ? { kind: 'delete' } : folder ? (folder === archiveId ? { kind: 'archive' } : { kind: 'folder', id: folder }) : { kind: 'none' }
  const spec: RuleSpec = {
    from: fromAddresses[0]?.emailAddress?.address ?? senderContains[0] ?? '',
    words: words[0] ?? '',
    markRead: a.markAsRead === true,
    move,
    name: r.displayName,
  }
  return isEmptySpec(spec) || hasNoAction(spec) ? undefined : spec
}

/** Conditions and actions for a create (`full` = false) or a PATCH that clears what is no longer used. */
export function specToOutlook(s: RuleSpec, archiveId: string | undefined, full: boolean) {
  const from = s.from.trim()
  const words = s.words.trim()
  const folder = s.move.kind === 'folder' ? s.move.id : s.move.kind === 'archive' ? archiveId : undefined
  const conditions: Record<string, unknown> = {
    fromAddresses: from && looksLikeAddress(from) ? [{ emailAddress: { address: from } }] : [],
    senderContains: from && !looksLikeAddress(from) ? [from] : [],
    bodyOrSubjectContains: words ? [words] : [],
  }
  const actions: Record<string, unknown> = { markAsRead: s.markRead, delete: s.move.kind === 'delete', moveToFolder: folder ?? null }
  const prune = (o: Record<string, unknown>) => (full ? o : Object.fromEntries(Object.entries(o).filter(([, v]) => !blank(v))))
  return { conditions: prune(conditions), actions: prune(actions) }
}

/** The name Outlook shows in its rule list when the user didn't give one. */
export function defaultRuleName(s: RuleSpec) {
  const parts = [s.from.trim(), s.words.trim() && `"${s.words.trim()}"`].filter(Boolean)
  return `Mail Vibes: ${parts.join(' · ')}`.slice(0, 250)
}

const RULES = '/me/mailFolders/inbox/messageRules'
const archiveIds = new Map<string, Promise<string | undefined>>()
function archiveId(accountId: string) {
  let p = archiveIds.get(accountId)
  if (!p) {
    p = graph<{ id: string }>(accountId, '/me/mailFolders/archive?$select=id', { quiet: true }).then(
      (f) => f.id,
      () => undefined,
    )
    archiveIds.set(accountId, p)
  }
  return p
}

async function listOutlook(accountId: string): Promise<RuleList> {
  let rules: ORule[]
  try {
    rules = (await graph<GraphPage<ORule>>(accountId, RULES, { quiet: true, scopes: MAILBOX_SCOPES })).value
  } catch (e) {
    if (isScopeError(e)) return { rules: [], needsConsent: true }
    throw e
  }
  const archive = await archiveId(accountId)
  return {
    needsConsent: false,
    rules: rules
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((r) => ({
        accountId,
        id: r.id!,
        spec: outlookToSpec(r, archive),
        label: r.displayName ?? '',
        enabled: r.isEnabled !== false,
        hasError: r.hasError === true,
        sequence: r.sequence,
      })),
  }
}

// ---- IMAP rules (kept in the settings) ------------------------------------------------------

const imapRules = (accountId: string) => useSettings.getState().accounts.find((a) => a.id === accountId)?.imap?.rules ?? []

function setImapRules(accountId: string, rules: ImapRule[]) {
  const s = useSettings.getState()
  const imap = s.accounts.find((a) => a.id === accountId)?.imap
  if (imap) s.updateAccount(accountId, { imap: { ...imap, rules: rules.length ? rules : undefined } })
}

async function listImap(accountId: string): Promise<RuleList> {
  return {
    needsConsent: false,
    rules: imapRules(accountId).map(({ id, ...spec }) => ({ accountId, id, spec, label: defaultRuleName(spec), enabled: true, hasError: false })),
  }
}

// ---- Shared ---------------------------------------------------------------------------------

const isGoogle = (accountId: string) => accountId.startsWith('google:')

export const listRules = (accountId: string) =>
  isImap(accountId) ? listImap(accountId) : isGoogle(accountId) ? listGmail(accountId) : listOutlook(accountId)

/** Creates a rule, or replaces `existing`. Gmail filters can't be edited, so a new one replaces the old. */
export async function saveRule(accountId: string, spec: RuleSpec, existing?: MailRule, nextSequence = 1) {
  if (isImap(accountId)) {
    const rule: ImapRule = { id: existing?.id ?? crypto.randomUUID(), from: spec.from.trim(), words: spec.words.trim(), markRead: spec.markRead, move: spec.move }
    const rules = imapRules(accountId)
    setImapRules(accountId, existing ? rules.map((r) => (r.id === existing.id ? rule : r)) : [...rules, rule])
    return
  }
  if (isGoogle(accountId)) {
    await google(accountId, `${GMAIL}/settings/filters`, { method: 'POST', body: specToGmail(spec) })
    if (existing) await google(accountId, `${GMAIL}/settings/filters/${existing.id}`, { method: 'DELETE' })
    return
  }
  const archive = spec.move.kind === 'archive' ? await archiveId(accountId) : undefined
  const name = spec.name?.trim() || defaultRuleName(spec)
  if (existing) {
    await graph(accountId, `${RULES}/${existing.id}`, { method: 'PATCH', scopes: MAILBOX_SCOPES, body: { displayName: name, ...specToOutlook(spec, archive, true) } })
  } else {
    await graph(accountId, RULES, {
      method: 'POST',
      scopes: MAILBOX_SCOPES,
      body: { displayName: name, sequence: nextSequence, isEnabled: true, ...specToOutlook(spec, archive, false) },
    })
  }
}

export async function deleteRule(rule: MailRule) {
  if (isImap(rule.accountId)) setImapRules(rule.accountId, imapRules(rule.accountId).filter((r) => r.id !== rule.id))
  else if (isGoogle(rule.accountId)) await google(rule.accountId, `${GMAIL}/settings/filters/${rule.id}`, { method: 'DELETE' })
  else await graph(rule.accountId, `${RULES}/${rule.id}`, { method: 'DELETE', scopes: MAILBOX_SCOPES })
}

/** Where to manage the account's rules on the provider's own site. */
export function providerRulesUrl(accountId: string) {
  const email = useSettings.getState().accounts.find((a) => a.id === accountId)?.email ?? ''
  return isGoogle(accountId)
    ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#settings/filters`
    : 'https://outlook.office.com/mail/options/mail/rules'
}

const MAX_EXISTING = 100

/** Messages already in the Inbox that the rule would have caught (rules only act on new mail). */
export async function findExisting(accountId: string, spec: RuleSpec): Promise<MailSummary[]> {
  const from = spec.from.trim().toLowerCase()
  const words = spec.words.trim()
  // Gmail understands its own search syntax (IMAP accounts the same few words); Outlook gets one
  // phrase and the sender is checked here.
  const unquote = (s: string) => s.replace(/"/g, '')
  const search = isGoogle(accountId)
    ? [from && `from:(${from.replace(/[()]/g, '')})`, words && gmailPhrase(words)].filter(Boolean).join(' ')
    : isImap(accountId)
      ? [from && `from:"${unquote(from)}"`, words && `"${unquote(words)}"`].filter(Boolean).join(' ')
      : words || from
  const r = await providerFor(accountId).list(accountId, { search, inbox: true }, MAX_EXISTING)
  return r.messages.filter((m) => !from || `${m.from.email} ${m.from.name ?? ''}`.toLowerCase().includes(from))
}

/** Does to existing messages what the rule does to new ones. */
export async function applyToExisting(accountId: string, spec: RuleSpec, ids: string[]) {
  if (!ids.length) return
  const p = providerFor(accountId)
  if (spec.markRead) await p.setRead(accountId, ids, true)
  const m = spec.move
  if (m.kind === 'delete') await p.move(accountId, ids, 'trash')
  else if (m.kind === 'archive') await p.move(accountId, ids, 'archive')
  else if (m.kind === 'folder') await p.move(accountId, ids, { folderId: m.id })
  refreshAccountMail(accountId)
}
