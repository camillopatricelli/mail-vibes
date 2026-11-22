import i18n from '../../i18n'
import { specialFolders, useSettings, type SpecialFolder } from '../../settings/store'
import { useStatus } from '../../status/store'
import { escapeHtml, sanitizeForEditor } from '../html'
import { buildMime } from '../mime'
import type { Address, Attachment, DraftContent, FolderKind, ListTarget, MailFolder, MailMessage, MailProvider, MailSummary, PecDetails, ReplyKind } from '../types'
import { isDeleted, isDraftFlag, isFlagged, isSeen, parseInternalDate, parseSummary, SUMMARY_ITEMS, threadRoot, type FetchedSummary } from './envelope'
import { isInbox, type ListedFolder } from './folders'
import { folderId, folderPath, messageId, parseMessageId, parseThreadId, threadIdOf } from './ids'
import { parseMessage, type ParsedMessage } from './message'
import { originalSender, originalSubject, pecHeaders, pecView } from './pec'
import type { CommandResult, Part } from './client'
import { asList, asText, encodeMailboxName, fetchAttributes, type ImapResponse } from './parse'
import { copiedUids, searchCriteria } from './search'
import { getPassword, smtpKey } from './passwords'
import { NotYetError, session, type Ctx } from './session'
import { SmtpClient } from './smtp'

/**
 * Mail adapter for IMAP accounts (through the user's bridge, see bridge/worker.js).
 *
 * Threads are built by the app from References / In-Reply-To (IMAP has no conversations): a
 * thread is identified by its first Message-ID, and opening it searches the folders where its
 * messages were seen, plus Inbox, Sent and Archive. PEC servers search headers very slowly
 * (half a minute on a big Inbox), so PEC threads hold only the messages already listed.
 */

// ---------- Caches (memory only) ----------

/** Folders where each thread's messages were listed, to find them again when it's opened */
const threadFolders = new Map<string, Set<string>>()
/** Messages listed for each thread (PEC accounts open threads from these, without searching) */
const threadMessages = new Map<string, Set<string>>()
/** When each PEC account's latest sent messages were last listed (see thread) */
const sentPrimed = new Map<string, number>()
/** Where moved messages came from (new id -> old folder), so "Undo" from Starred or a search puts them back */
const movedFrom = new Map<string, string>()
/** Whole messages already downloaded and parsed (a few, for attachments and re-opening) */
type Shown = ParsedMessage & { pec?: PecDetails }
const parsed = new Map<string, Shown>()
const PARSED_MAX = 30

function remember(key: string, p: Shown) {
  parsed.delete(key)
  parsed.set(key, p)
  while (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!)
}

const cacheKey = (accountId: string, id: string) => `${accountId}|${id}`

// ---------- Helpers ----------

type Special = Partial<Record<SpecialFolder, string>>

function kindOfPath(path: string, special: Special): Exclude<FolderKind, 'starred'> | undefined {
  if (isInbox(path)) return 'inbox'
  for (const [k, p] of Object.entries(special) as [SpecialFolder, string][]) if (p === path) return k
  return undefined
}

function toSummary(accountId: string, path: string, uidValidity: number, s: FetchedSummary): MailSummary {
  const id = messageId({ path, uidValidity, uid: s.uid })
  const threadId = threadIdOf(threadRoot(s), id)
  if (threadId.startsWith('m')) {
    const k = cacheKey(accountId, threadId)
    const set = threadFolders.get(k) ?? new Set<string>()
    set.add(path)
    threadFolders.set(k, set)
    const ids = threadMessages.get(k) ?? new Set<string>()
    ids.add(id)
    threadMessages.set(k, ids)
  }
  // A certified message shows its original sender and subject, not the PEC provider's.
  const certified = s.pec && !s.pec.ricevuta && s.pec.trasporto !== 'errore'
  return {
    accountId,
    id,
    threadId,
    subject: certified ? originalSubject(s.subject) : s.subject,
    snippet: parsed.get(cacheKey(accountId, id))?.snippet ?? '',
    from: certified ? originalSender(s.from, s.replyTo) : s.from,
    to: s.to,
    date: s.date,
    isRead: isSeen(s.flags),
    isFlagged: isFlagged(s.flags),
    hasAttachments: s.hasAttachments,
    isDraft: isDraftFlag(s.flags),
    tags: [],
  }
}

function summariesFrom(responses: ImapResponse[]) {
  return responses
    .filter((r) => r.type === 'FETCH')
    .map((r) => fetchAttributes(r))
    .filter((a) => a.has('ENVELOPE') && a.has('UID'))
    .map(parseSummary)
    .filter((s) => !isDeleted(s.flags))
}

/**
 * Arrival dates of all messages of a folder (UID -> INTERNALDATE). The order messages were added
 * in isn't their date order (old mail moved or archived into a folder comes last), so lists pick
 * the newest by date. Built once per folder, then only new messages are fetched.
 */
interface DateIndex {
  uidValidity: number
  dates: Map<number, number>
  maxUid: number
}
const dateIndexes = new Map<string, DateIndex>()

function addDates(idx: DateIndex, responses: ImapResponse[]) {
  for (const r of responses) {
    if (r.type !== 'FETCH') continue
    const a = fetchAttributes(r)
    const uid = Number(asText(a.get('UID')))
    if (!uid) continue
    idx.dates.set(uid, parseInternalDate(asText(a.get('INTERNALDATE'))))
    idx.maxUid = Math.max(idx.maxUid, uid)
  }
}

async function datesOf(ctx: Ctx, accountId: string, path: string, box: { uidValidity: number; exists: number }) {
  const key = cacheKey(accountId, path)
  let idx = dateIndexes.get(key)
  if (idx && idx.uidValidity !== box.uidValidity) idx = undefined
  if (idx && idx.dates.size < box.exists) addDates(idx, (await ctx.client.run([`UID FETCH ${idx.maxUid + 1}:* (UID INTERNALDATE)`], 120_000)).untagged)
  // Messages removed elsewhere (or several new ones in odd order): read all dates again.
  if (!idx || idx.dates.size !== box.exists) {
    idx = { uidValidity: box.uidValidity, dates: new Map(), maxUid: 0 }
    addDates(idx, (await ctx.client.run(['FETCH 1:* (UID INTERNALDATE)'], 180_000)).untagged)
  }
  dateIndexes.set(key, idx)
  return idx
}

/** After this app moved or deleted messages: they're no longer in the folder. */
function forgetDates(accountId: string, path: string, uids: number[]) {
  const idx = dateIndexes.get(cacheKey(accountId, path))
  for (const u of uids) idx?.dates.delete(u)
}

/** The newest `count` messages of a folder, by arrival date. */
async function listFolder(ctx: Ctx, accountId: string, path: string, count: number) {
  const box = await ctx.select(path, true)
  if (!box.exists) return { messages: [], hasMore: false }
  const idx = await datesOf(ctx, accountId, path, box)
  const newest = [...idx.dates].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, count).map(([uid]) => uid)
  if (!newest.length) return { messages: [], hasMore: false }
  const r = await ctx.client.run([`UID FETCH ${newest.join(',')} ${SUMMARY_ITEMS}`], 120_000)
  const summaries = summariesFrom(r.untagged)
  if (!ctx.account.imap?.pec && summaries.some((s) => s.pec)) suggestPec(accountId)
  return { messages: summaries.map((s) => toSummary(accountId, path, box.uidValidity, s)), hasMore: idx.dates.size > count }
}

/** PEC messages in an account not marked as PEC: offer to mark it (once per session). */
const pecSuggested = new Set<string>()
function suggestPec(accountId: string) {
  if (pecSuggested.has(accountId)) return
  pecSuggested.add(accountId)
  const account = useSettings.getState().accounts.find((a) => a.id === accountId)
  if (!account?.imap) return
  useStatus.getState().toast({
    tone: 'info',
    message: i18n.t('imap.pecDetected', { account: account.email }),
    action: {
      label: i18n.t('imap.pecTurnOn'),
      run: () => {
        const now = useSettings.getState().accounts.find((a) => a.id === accountId)
        if (now?.imap) useSettings.getState().updateAccount(accountId, { imap: { ...now.imap, pec: true } })
      },
    },
  })
}

/** UIDs found by a search in the open folder. */
async function search(ctx: Ctx, criteria: string | Part[]): Promise<number[]> {
  const r = await ctx.client.run(['UID SEARCH ', ...(typeof criteria === 'string' ? [criteria] : criteria)], 180_000)
  return r.untagged.filter((u) => u.type === 'SEARCH').flatMap((u) => u.values.map((v) => Number(asText(v)))).filter(Boolean)
}

async function fetchByUid(ctx: Ctx, accountId: string, path: string, uids: number[]) {
  if (!uids.length) return []
  const box = await ctx.select(path)
  const r = await ctx.client.run([`UID FETCH ${uids.join(',')} ${SUMMARY_ITEMS}`], 120_000)
  return summariesFrom(r.untagged).map((s) => toSummary(accountId, path, box.uidValidity, s))
}

/** A message's folder must still have the same UIDVALIDITY, or its UIDs mean other messages. */
async function selectFor(ctx: Ctx, id: string) {
  const ref = parseMessageId(id)
  const box = await ctx.select(ref.path)
  if (box.uidValidity !== ref.uidValidity) throw new Error('The folder was reset on the server; reload the list.')
  return ref
}

async function loadParsed(ctx: Ctx, accountId: string, id: string): Promise<Shown> {
  const cached = parsed.get(cacheKey(accountId, id))
  if (cached) return cached
  const ref = await selectFor(ctx, id)
  // BODY.PEEK: downloading a message doesn't mark it as read.
  const r = await ctx.client.run([`UID FETCH ${ref.uid} (BODY.PEEK[])`], 300_000)
  const raw = r.untagged.filter((u) => u.type === 'FETCH').map(fetchAttributes).find((a) => a.has('BODY[]'))?.get('BODY[]')
  if (!(raw instanceof Uint8Array)) throw new Error('The message is no longer on the server.')
  const outer = await parseMessage(raw)
  const h = pecHeaders(['x-trasporto', 'x-ricevuta', 'x-riferimento-message-id'].map((k) => `${k}: ${outer.headers.get(k) ?? ''}`).join('\n'))
  const p: Shown = h ? await pecView(raw, outer, h) : outer
  remember(cacheKey(accountId, id), p)
  return p
}

function groupByFolder(ids: string[]) {
  const m = new Map<string, string[]>()
  for (const id of ids) {
    const path = parseMessageId(id).path
    m.set(path, [...(m.get(path) ?? []), id])
  }
  return m
}

async function storeFlags(accountId: string, ids: string[], op: '+' | '-', flag: string) {
  await session(accountId).run(async (ctx) => {
    for (const [, group] of groupByFolder(ids)) {
      const uids = []
      for (const id of group) uids.push((await selectFor(ctx, id)).uid)
      await ctx.client.run([`UID STORE ${uids.join(',')} ${op}FLAGS.SILENT (${flag})`])
    }
  })
}

/** Removes messages of the open folder for good (marked \Deleted, then expunged). */
async function expunge(ctx: Ctx, uidSet: string) {
  await ctx.client.run([`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`])
  // Without UIDPLUS, EXPUNGE also removes other messages marked deleted (the app hides those anyway).
  await ctx.client.run([ctx.client.has('UIDPLUS') ? `UID EXPUNGE ${uidSet}` : 'EXPUNGE'], 120_000)
}

/** Search the Inbox, Sent, Archive and the user's folders (not Trash, Junk, Drafts); newest first. */
async function searchMail(ctx: Ctx, accountId: string, target: { search: string; inbox?: boolean }, count: number) {
  const criteria = searchCriteria(target.search, !!ctx.account.imap?.pec)
  if (!criteria) return { messages: [], hasMore: false }
  const { list, special } = await ctx.folders()
  const skip = new Set([special.trash, special.spam, special.drafts])
  const paths = target.inbox ? ['INBOX'] : ['INBOX', ...list.filter((f) => f.selectable && !isInbox(f.path) && !skip.has(f.path)).map((f) => f.path)]
  const out: MailSummary[] = []
  let hasMore = false
  for (const path of paths) {
    await ctx.select(path)
    const uids = (await search(ctx, criteria)).sort((a, b) => a - b)
    if (uids.length > count) hasMore = true
    out.push(...(await fetchByUid(ctx, accountId, path, uids.slice(-count))))
  }
  out.sort((a, b) => b.date - a.date)
  return { messages: out.slice(0, count), hasMore: hasMore || out.length > count }
}

/** The folder a move goes to. A missing Archive folder is created (Archive must always work). */
async function destination(ctx: Ctx, dest: ListTarget, from: string): Promise<string> {
  if (typeof dest === 'object' && 'folderId' in dest) return folderPath(dest.folderId)
  if (dest === 'inbox') return 'INBOX'
  if (typeof dest === 'string' && (specialFolders as string[]).includes(dest)) {
    const kind = dest as SpecialFolder
    const { special } = await ctx.folders()
    if (special[kind]) return special[kind]!
    if (kind === 'archive') return createArchive(ctx)
    throw new Error(i18n.t('imap.noSpecialFolder', { folder: i18n.t(`imap.folder.${kind}`) }))
  }
  // Back from Starred or a search ("Undo"): where the message was before.
  return from
}

async function createArchive(ctx: Ctx): Promise<string> {
  const { list } = await ctx.folders()
  const delim = list.find((f) => f.delimiter)?.delimiter ?? null
  const others = list.filter((f) => !isInbox(f.path))
  // Servers that keep every folder under "INBOX." want new ones there too.
  const prefix = delim && others.length && others.every((f) => f.path.toUpperCase().startsWith(`INBOX${delim}`)) ? `INBOX${delim}` : ''
  const path = prefix + encodeMailboxName(i18n.t('imap.folder.archive'))
  await ctx.client.run(['CREATE ', { str: path }])
  await ctx.client.run(['SUBSCRIBE ', { str: path }]).catch(() => undefined)
  ctx.forgetFolders()
  return (await ctx.folders()).special.archive ?? path
}

const notYet = async (): Promise<never> => {
  throw new NotYetError()
}

// ---------- Writing mail ----------

interface DraftFile {
  meta: Attachment
  blob: Blob
  contentId?: string
}

/**
 * A message being written. The composer knows it by a handle that never changes; each save puts
 * a new copy in the Drafts folder (IMAP messages can't be edited) and removes the previous one.
 */
interface ImapDraft {
  content: DraftContent
  quotedHtml: string
  files: DraftFile[]
  /** Message-ID header, the same in every saved copy and in the sent message */
  messageId: string
  inReplyTo?: string
  references?: string
  /** The message replied to or forwarded, flagged as answered / forwarded once sent */
  source?: { id: string; kind: ReplyKind }
  /** The copy in the Drafts folder (unknown id: saved on a server without UIDPLUS) */
  saved?: { id?: string }
}
const drafts = new Map<string, ImapDraft>()
/** Whether each account's outgoing server puts a copy of sent mail in Sent by itself */
const serverSavesSent = new Map<string, boolean>()

function accountOf(accountId: string) {
  const a = useSettings.getState().accounts.find((x) => x.id === accountId)
  if (!a?.imap) throw new Error('Unknown IMAP account')
  return a
}

const ownAddress = (accountId: string): Address => {
  const a = accountOf(accountId)
  return { name: a.displayName && a.displayName !== a.email ? a.displayName : '', email: a.email }
}

function draftOf(accountId: string, handle: string) {
  const d = drafts.get(cacheKey(accountId, handle))
  if (!d) throw new Error('This draft is no longer open; open it again from Drafts.')
  return d
}

const newMessageId = (email: string) => `<${crypto.randomUUID()}@${email.split('@')[1] || 'mail-vibes'}>`
const prefixed = (subject: string, prefix: 'Re' | 'Fwd') =>
  (prefix === 'Re' ? /^\s*re\s*:/i : /^\s*(fwd?|i)\s*:/i).test(subject) ? subject : `${prefix}: ${subject}`
const who = (a: Address) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)
function dedupe(list: Address[], skip: string[]) {
  const seen = new Set(skip.map((e) => e.toLowerCase()))
  return list.filter((a) => {
    const e = a.email.toLowerCase()
    if (seen.has(e)) return false
    seen.add(e)
    return true
  })
}

async function draftBytes(accountId: string, d: ImapDraft, withBcc: boolean) {
  const blob = await buildMime({
    from: ownAddress(accountId),
    to: d.content.to,
    cc: d.content.cc,
    bcc: withBcc ? d.content.bcc : [],
    subject: d.content.subject,
    html: d.quotedHtml ? `${d.content.html}<br>${d.quotedHtml}` : d.content.html,
    inReplyTo: d.inReplyTo,
    references: d.references,
    attachments: d.files.map((f) => ({ name: f.meta.name, contentType: f.meta.contentType, blob: f.blob, contentId: f.contentId })),
    messageId: d.messageId,
    date: new Date(),
  })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Adds a message to a folder; answers its id if the server says (UIDPLUS). */
async function append(ctx: Ctx, path: string, raw: Uint8Array, flags: string) {
  const r = await ctx.client.run(['APPEND ', { str: path }, ` (${flags}) `, raw], 300_000)
  const code = [r.done, ...r.untagged].find((x) => x.code?.name === 'APPENDUID')?.code
  const uid = Number(asText(code?.args[1]))
  return code && uid ? messageId({ path, uidValidity: Number(asText(code.args[0])), uid }) : undefined
}

/** UIDs in the Drafts folder holding a draft's copies (servers without UIDPLUS) */
async function draftCopies(ctx: Ctx, path: string, d: ImapDraft) {
  await ctx.select(path)
  return search(ctx, ['HEADER Message-ID ', { str: d.messageId }])
}

async function removeMessages(ctx: Ctx, accountId: string, path: string, uids: number[]) {
  if (!uids.length) return
  await ctx.select(path)
  await expunge(ctx, uids.join(','))
  forgetDates(accountId, path, uids)
}

/** Removes the draft's saved copy, if any. */
async function removeSaved(ctx: Ctx, accountId: string, d: ImapDraft) {
  if (!d.saved) return
  if (d.saved.id) {
    const ref = parseMessageId(d.saved.id)
    const box = await ctx.select(ref.path)
    if (box.uidValidity === ref.uidValidity) await removeMessages(ctx, accountId, ref.path, [ref.uid])
  } else {
    const path = (await ctx.folders()).special.drafts
    if (path) await removeMessages(ctx, accountId, path, await draftCopies(ctx, path, d))
  }
  d.saved = undefined
}

/** Saves the draft in the Drafts folder (without a Drafts folder it stays in the window only). */
async function saveDraft(accountId: string, d: ImapDraft) {
  await session(accountId).run(async (ctx) => {
    const path = (await ctx.folders()).special.drafts
    if (!path) return
    // Without UIDPLUS the previous copies are found by Message-ID, before adding the new one.
    const old = d.saved && !d.saved.id ? await draftCopies(ctx, path, d) : undefined
    const id = await append(ctx, path, await draftBytes(accountId, d, true), '\\Draft \\Seen')
    if (old) await removeMessages(ctx, accountId, path, old)
    else await removeSaved(ctx, accountId, d)
    d.saved = { id }
  })
}

/** After sending: a copy in Sent, unless the server puts one there itself (checked once). */
async function keepSentCopy(ctx: Ctx, accountId: string, d: ImapDraft) {
  const path = (await ctx.folders()).special.sent
  if (!path) return
  if (!serverSavesSent.has(accountId)) {
    await new Promise((r) => setTimeout(r, 3000))
    await ctx.select(path, true)
    serverSavesSent.set(accountId, (await search(ctx, ['HEADER Message-ID ', { str: d.messageId }])).length > 0)
  }
  if (serverSavesSent.get(accountId)) return
  await append(ctx, path, await draftBytes(accountId, d, true), '\\Seen')
}

const composeMethods: Pick<MailProvider, 'createDraft' | 'updateDraft' | 'addAttachment' | 'removeAttachment' | 'sendDraft' | 'deleteDraft' | 'loadDraft'> = {
  async createDraft(accountId, content, replyTo) {
    const me = ownAddress(accountId)
    const d: ImapDraft = { content, quotedHtml: '', files: [], messageId: newMessageId(me.email) }
    if (replyTo) {
      const o = await session(accountId).run((ctx) => loadParsed(ctx, accountId, replyTo.messageId))
      const from = o.from ?? { name: '', email: '' }
      const origId = o.headers.get('message-id')
      const date = new Date(o.date || Date.now()).toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'short' })
      const quoted = sanitizeForEditor(o.bodyHtml)
      d.source = { id: replyTo.messageId, kind: replyTo.kind }
      if (replyTo.kind === 'forward') {
        d.content = { ...content, subject: prefixed(o.subject, 'Fwd') }
        d.quotedHtml =
          `<div class="gmail_quote">${escapeHtml(i18n.t('compose.forwardHeader'))}<br>` +
          `${escapeHtml(i18n.t('compose.fieldFrom'))}: ${who(from)}<br>` +
          `${escapeHtml(i18n.t('compose.fieldDate'))}: ${escapeHtml(date)}<br>` +
          `${escapeHtml(i18n.t('compose.subject'))}: ${escapeHtml(o.subject)}<br>` +
          `${escapeHtml(i18n.t('compose.to'))}: ${o.to.map(who).join(', ')}<br><br>${quoted}</div>`
        d.files = o.attachments.map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId }))
      } else {
        const fromMe = from.email.toLowerCase() === me.email.toLowerCase()
        const primary = fromMe ? o.to : o.replyTo.length ? o.replyTo : [from]
        const to = replyTo.kind === 'replyAll' ? dedupe([...primary, ...o.to], [me.email]) : dedupe(primary, [])
        const cc = replyTo.kind === 'replyAll' ? dedupe(o.cc, [me.email, ...to.map((a) => a.email)]) : []
        d.content = { ...content, to, cc, bcc: [], subject: prefixed(o.subject, 'Re') }
        d.inReplyTo = origId
        d.references = [o.headers.get('references'), origId].filter(Boolean).join(' ') || undefined
        d.quotedHtml =
          `<div class="gmail_quote"><div>${escapeHtml(i18n.t('compose.quoteHeader', { date, name: from.name || from.email }))}</div>` +
          `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`
        // Inline images of the quoted message keep working in the reply.
        d.files = o.attachments.filter((a) => a.contentId && a.meta.isInline).map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId }))
      }
    }
    const handle = `draft-${crypto.randomUUID()}`
    drafts.set(cacheKey(accountId, handle), d)
    // Saved to Drafts once the user writes something (an untouched reply is simply closed).
    return { id: handle, quotedHtml: d.quotedHtml, content: d.content }
  },

  async updateDraft(accountId, draft, content) {
    const d = draftOf(accountId, draft.id)
    d.content = content
    await saveDraft(accountId, d)
  },

  async addAttachment(accountId, draftId, file, onProgress) {
    const d = draftOf(accountId, draftId)
    d.files.push({
      meta: { id: crypto.randomUUID(), name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, isInline: false },
      blob: file,
    })
    await saveDraft(accountId, d)
    onProgress?.(1)
    return d.files.map((f) => f.meta)
  },

  async removeAttachment(accountId, draftId, attachmentId) {
    const d = draftOf(accountId, draftId)
    d.files = d.files.filter((f) => f.meta.id !== attachmentId)
    await saveDraft(accountId, d)
  },

  async sendDraft(accountId, draftId) {
    const d = draftOf(accountId, draftId)
    const account = accountOf(accountId)
    const out = account.imap?.outgoing
    const bridge = useSettings.getState().bridge
    if (!out) throw new Error(i18n.t('imap.receiveOnly'))
    if (!bridge) throw new Error(i18n.t('imap.noBridge'))
    const password = await getPassword(out.samePassword ? accountId : smtpKey(accountId))
    if (!password) throw new Error(i18n.t('imap.smtpPasswordMissing'))
    const recipients = [...d.content.to, ...d.content.cc, ...d.content.bcc].map((a) => a.email)
    let smtp: SmtpClient | undefined
    try {
      smtp = await SmtpClient.connect(bridge, out)
      await smtp.login(out.username, password)
      await smtp.send(account.email, recipients, await draftBytes(accountId, d, false))
    } catch (e) {
      throw new Error(i18n.t('imap.smtpFailed', { reason: (e as Error).message }))
    } finally {
      await smtp?.quit()
    }
    drafts.delete(cacheKey(accountId, draftId))
    // Sent. The rest is tidying up: a failure there is reported but doesn't undo the sending.
    await session(accountId)
      .run(async (ctx) => {
        await removeSaved(ctx, accountId, d)
        await keepSentCopy(ctx, accountId, d)
        if (d.source) {
          const ref = await selectFor(ctx, d.source.id)
          await ctx.client.run([`UID STORE ${ref.uid} +FLAGS.SILENT (${d.source.kind === 'forward' ? '$Forwarded' : '\\Answered'})`])
        }
      })
      .catch((e) => useStatus.getState().toast({ tone: 'error', message: i18n.t('imap.afterSendFailed', { reason: (e as Error).message }) }))
  },

  async deleteDraft(accountId, draftId) {
    const d = drafts.get(cacheKey(accountId, draftId))
    await session(accountId).run(async (ctx) => {
      if (d) await removeSaved(ctx, accountId, d)
      else {
        // A draft in the Drafts folder that isn't open
        const ref = await selectFor(ctx, draftId)
        await removeMessages(ctx, accountId, ref.path, [ref.uid])
      }
    })
    drafts.delete(cacheKey(accountId, draftId))
  },

  async loadDraft(accountId, id) {
    const p = await session(accountId).run((ctx) => loadParsed(ctx, accountId, id))
    const d: ImapDraft = {
      content: { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, html: p.bodyHtml },
      quotedHtml: '',
      files: p.attachments.map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId })),
      messageId: p.headers.get('message-id') || newMessageId(accountOf(accountId).email),
      inReplyTo: p.headers.get('in-reply-to'),
      references: p.headers.get('references'),
      saved: { id },
    }
    drafts.set(cacheKey(accountId, id), d)
    return { content: d.content, attachments: d.files.map((f) => f.meta) }
  },
}

// ---------- The adapter ----------

export const imap: MailProvider = {
  async list(accountId, target: ListTarget, count) {
    return session(accountId).run(async (ctx) => {
      if (typeof target === 'string') {
        if (target === 'inbox') return listFolder(ctx, accountId, 'INBOX', count)
        if (target === 'snoozed' || target === 'scheduled') return { messages: [], hasMore: false }
        const { special } = await ctx.folders()
        if (target === 'starred') {
          // Flagged messages of the Inbox and the Archive, newest first.
          const out: MailSummary[] = []
          for (const path of ['INBOX', special.archive].filter((p): p is string => !!p)) {
            await ctx.select(path)
            const uids = (await search(ctx, 'FLAGGED')).slice(-count)
            out.push(...(await fetchByUid(ctx, accountId, path, uids)))
          }
          return { messages: out, hasMore: false }
        }
        const path = special[target as SpecialFolder]
        return path ? listFolder(ctx, accountId, path, count) : { messages: [], hasMore: false }
      }
      if ('folderId' in target) return listFolder(ctx, accountId, folderPath(target.folderId), count)
      if ('search' in target) return searchMail(ctx, accountId, target, count)
      // Tags come in a later version.
      return { messages: [], hasMore: false }
    })
  },

  async thread(accountId, threadId) {
    return session(accountId).run(async (ctx) => {
      const { special, list } = await ctx.folders()
      const t = parseThreadId(threadId)
      let summaries: MailSummary[] = []
      if ('message' in t) {
        const ref = parseMessageId(t.message)
        summaries = await fetchByUid(ctx, accountId, ref.path, [ref.uid])
      } else if (ctx.account.imap?.pec && threadMessages.get(cacheKey(accountId, threadId))?.size) {
        // Receipts belong with the message they're about, usually among the latest in Sent: list
        // those (a quick fetch, unlike a header search) so they join the conversation.
        if (special.sent && Date.now() - (sentPrimed.get(accountId) ?? 0) > 120_000) {
          await listFolder(ctx, accountId, special.sent, 100)
          sentPrimed.set(accountId, Date.now())
        }
        for (const [path, ids] of groupByFolder([...threadMessages.get(cacheKey(accountId, threadId))!])) {
          const box = await ctx.select(path)
          const uids = ids.map(parseMessageId).filter((r) => r.uidValidity === box.uidValidity).map((r) => r.uid)
          summaries.push(...(await fetchByUid(ctx, accountId, path, uids)))
        }
      } else {
        const seen = threadFolders.get(cacheKey(accountId, threadId))
        const where = new Set<string>([...(seen ?? []), 'INBOX', special.sent, special.archive].filter((p): p is string => !!p))
        // Opened from an address without a list (e.g. a link): look in every folder.
        if (!seen) for (const f of list) if (f.selectable && f.path !== special.trash && f.path !== special.spam) where.add(f.path)
        const id = t.root.replace(/["\\]/g, '')
        for (const path of where) {
          await ctx.select(path)
          const uids = await search(ctx, `OR HEADER Message-ID "${id}" HEADER References "${id}"`)
          summaries.push(...(await fetchByUid(ctx, accountId, path, uids)))
        }
      }
      // The same message can sit in two folders (e.g. a copy): keep one.
      const unique = new Map<string, MailSummary>()
      for (const s of summaries.sort((a, b) => a.date - b.date)) unique.set(`${s.from.email}|${s.date}|${s.subject}`, s)
      const out: MailMessage[] = []
      for (const s of unique.values()) {
        const p = await loadParsed(ctx, accountId, s.id)
        const path = parseMessageId(s.id).path
        out.push({
          ...s,
          ...(p.pec && { from: p.from ?? s.from, to: p.to, subject: p.subject || s.subject, pec: p.pec }),
          threadId,
          snippet: p.snippet,
          hasAttachments: p.attachments.some((a) => !a.meta.isInline),
          cc: p.cc,
          bcc: p.bcc,
          replyTo: p.replyTo,
          bodyHtml: p.bodyHtml,
          bodyIsHtml: p.bodyIsHtml,
          folderId: folderId(path),
          folderKind: kindOfPath(path, special),
        })
      }
      return out
    })
  },

  setRead: (accountId, ids, read) => storeFlags(accountId, ids, read ? '+' : '-', '\\Seen'),
  setFlagged: (accountId, ids, flagged) => storeFlags(accountId, ids, flagged ? '+' : '-', '\\Flagged'),

  /** Answers the messages' new ids (a moved message gets a new UID in its new folder). */
  async move(accountId, ids, dest) {
    return session(accountId).run(async (ctx) => {
      const newIds: string[] = []
      for (const [path, group] of groupByFolder(ids)) {
        const to = await destination(ctx, dest, movedFrom.get(group[0]) ?? 'INBOX')
        if (to === path) {
          newIds.push(...group)
          continue
        }
        const refs = []
        for (const id of group) refs.push(await selectFor(ctx, id))
        const set = refs.map((r) => r.uid).join(',')
        let r: CommandResult
        if (ctx.client.has('MOVE')) r = await ctx.client.run([`UID MOVE ${set} `, { str: to }], 120_000)
        else {
          r = await ctx.client.run([`UID COPY ${set} `, { str: to }], 120_000)
          await expunge(ctx, set)
        }
        forgetDates(accountId, path, refs.map((x) => x.uid))
        const copied = copiedUids([...r.untagged, r.done])
        for (const ref of refs) {
          const uid = copied?.map.get(ref.uid)
          const id = copied && uid ? messageId({ path: to, uidValidity: copied.uidValidity, uid }) : messageId(ref)
          movedFrom.set(id, path)
          newIds.push(id)
        }
      }
      return newIds
    })
  },

  async deleteForever(accountId, ids) {
    await session(accountId).run(async (ctx) => {
      for (const [path, group] of groupByFolder(ids)) {
        const uids = []
        for (const id of group) uids.push((await selectFor(ctx, id)).uid)
        await expunge(ctx, uids.join(','))
        forgetDates(accountId, path, uids)
      }
    })
  },
  snooze: notYet,
  unsnooze: notYet,

  async folders(accountId) {
    return session(accountId).run(async (ctx) => {
      const { list, special } = await ctx.folders(true)
      const specialPaths = new Set(Object.values(special))
      const own = list.filter((f) => !isInbox(f.path) && !specialPaths.has(f.path))
      const out: MailFolder[] = []
      for (const f of own) {
        out.push({ id: folderId(f.path), name: f.name, depth: f.depth, unread: f.selectable ? await unseen(ctx, f) : 0 })
      }
      return out
    })
  },

  tags: async () => [],
  setTags: notYet,

  async unreadCount(accountId, folder) {
    return session(accountId).run(async (ctx) => {
      if (folder === 'inbox') return unseen(ctx, { path: 'INBOX' })
      const path = (await ctx.folders()).special[folder as SpecialFolder]
      return path ? unseen(ctx, { path }) : 0
    }, true)
  },

  async attachments(accountId, id): Promise<Attachment[]> {
    const d = drafts.get(cacheKey(accountId, id))
    if (d) return d.files.map((f) => f.meta)
    return session(accountId).run(async (ctx) => (await loadParsed(ctx, accountId, id)).attachments.map((a) => a.meta))
  },

  async downloadAttachment(accountId, id, attachmentId) {
    const file = drafts.get(cacheKey(accountId, id))?.files.find((f) => f.meta.id === attachmentId)
    if (file) return file.blob
    return session(accountId).run(async (ctx) => {
      const a = (await loadParsed(ctx, accountId, id)).attachments.find((x) => x.meta.id === attachmentId)
      if (!a) throw new Error('Attachment not found')
      return a.blob
    })
  },

  async inlineImages(accountId, id) {
    return session(accountId).run(async (ctx) => {
      const map = new Map<string, Blob>()
      for (const a of (await loadParsed(ctx, accountId, id)).attachments) if (a.contentId && a.meta.contentType.startsWith('image/')) map.set(a.contentId, a.blob)
      return map
    })
  },

  ...composeMethods,
  // Sending later comes in a later version (the composer doesn't offer it for IMAP accounts yet).
  scheduleDraft: notYet,
  unschedule: notYet,
  sendsScheduledItself: false,
  sendScheduled: notYet,
}

/** Unread messages of a folder (STATUS doesn't change the open folder). */
async function unseen(ctx: Ctx, f: Pick<ListedFolder, 'path'>) {
  try {
    const r = await ctx.client.run(['STATUS ', { str: f.path }, ' (UNSEEN)'])
    const st = r.untagged.find((u) => u.type === 'STATUS')
    const items = asList(st?.values[1])
    for (let i = 0; i + 1 < items.length; i += 2) if (asText(items[i]).toUpperCase() === 'UNSEEN') return Number(asText(items[i + 1])) || 0
    return 0
  } catch {
    return 0 // some servers refuse STATUS on special mailboxes
  }
}

/** All folders of an account (for choosing special folders by hand in its settings). */
export function listFolders(accountId: string) {
  return session(accountId).run(async (ctx) => {
    const { list, special } = await ctx.folders(true)
    return { list: list.filter((f) => f.selectable), special }
  })
}
