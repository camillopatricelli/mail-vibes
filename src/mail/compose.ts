import { shortDateTime } from '../lib/format'
import { create } from 'zustand'
import i18n from '../i18n'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { canSend, isMailCapable, providerFor } from './api'
import { isValidEmail } from './addressBook'
import { refreshAccountMail } from './data'
import { escapeHtml, htmlToText, sanitizeForEditor, withSignature } from './html'
import type { Address, Attachment, DraftContent, DraftRef, MailMessage, ReplyKind } from './types'

/**
 * Compose windows. Drafts are saved to the user's mailbox (Drafts folder) as they type, so
 * nothing is kept on the device and work survives closing the app. A message is reported as
 * sent only after the provider accepted it; on failure the composer stays open with the error.
 */

export type ComposeMode = 'new' | ReplyKind | 'draft'

export interface Upload {
  id: string
  name: string
  progress: number
}

export interface Composer {
  id: string
  accountId: string
  mode: ComposeMode
  sourceMessageId?: string
  draft?: DraftRef
  content: DraftContent
  /** HTML to load into the editor when it mounts */
  initialHtml: string
  attachments: Attachment[]
  uploads: Upload[]
  phase: 'preparing' | 'ready' | 'sending'
  saveState: 'clean' | 'dirty' | 'saving' | 'saved' | 'error'
  saveError?: string
  /** Error preparing the reply or sending */
  error?: string
  minimized: boolean
  /** A notice shown above the message (e.g. a forwarded PEC has no legal value) */
  note?: string
  /** Files forwarded from another account, attached again if the sending account changes */
  forwardFiles?: File[]
  /** Forwarded from an account that can't send (see openForwardFrom) */
  forwardFrom?: boolean
  /** The signature last put in the message (by the user or as the account's default) */
  signatureId?: string
}

interface ComposeState {
  composers: Composer[]
  patch: (id: string, p: Partial<Composer>) => void
  remove: (id: string) => void
  add: (c: Composer) => void
}

export const useCompose = create<ComposeState>()((set, get) => ({
  composers: [],
  patch: (id, p) => set({ composers: get().composers.map((c) => (c.id === id ? { ...c, ...p } : c)) }),
  remove: (id) => set({ composers: get().composers.filter((c) => c.id !== id) }),
  add: (c) => set({ composers: [...get().composers.filter((x) => x.id !== c.id), c] }),
}))

const t = (k: string, o: Record<string, unknown> = {}) => i18n.t(k, o)
const get = (id: string) => useCompose.getState().composers.find((c) => c.id === id)
const patch = (id: string, p: Partial<Composer>) => useCompose.getState().patch(id, p)
const emptyContent = (): DraftContent => ({ to: [], cc: [], bcc: [], subject: '', html: '' })

// One operation at a time per composer (create/update/attach/send never overlap).
const chains = new Map<string, Promise<unknown>>()
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  chains.set(id, next)
  return next
}
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** True if the body has nothing but (perhaps) the signature. */
function bodyIsEmpty(html: string) {
  const own = withSignature(html, null)
  return !htmlToText(own) && !/<img/i.test(own)
}

function isEmpty(c: DraftContent) {
  return !c.to.length && !c.cc.length && !c.bcc.length && !c.subject.trim() && bodyIsEmpty(c.html)
}

// ---------- Signatures ----------

/** The signature an account adds by itself: to new messages, and to replies/forwards if chosen. */
function defaultSignature(accountId: string, reply: boolean) {
  const s = useSettings.getState()
  const d = s.signatureDefaults[accountId]
  if (!d || (reply && !d.replies)) return undefined
  return s.signatures.find((x) => x.id === d.id)
}

/** The body with the account's default signature added, if it has one. */
function withDefaultSignature(html: string, accountId: string, reply: boolean) {
  const sig = defaultSignature(accountId, reply)
  return { html: sig ? withSignature(html, sig.html) : html, signatureId: sig?.id }
}

/** Puts a signature in the message, replacing the one there; null removes it. */
export function setSignature(id: string, signatureId: string | null) {
  const c = get(id)
  if (!c) return
  const sig = signatureId ? useSettings.getState().signatures.find((x) => x.id === signatureId) : undefined
  const html = withSignature(c.content.html, sig ? sig.html : null)
  // A new initialHtml makes the editor show the changed body.
  patch(id, { signatureId: sig?.id, initialHtml: html })
  updateContent(id, { html })
}

/** Creates the server draft if needed. Must run inside `serial`. */
async function ensureDraftInner(id: string) {
  const c = get(id)
  if (!c) throw new Error('closed')
  if (c.draft) return c.draft
  const created = await providerFor(c.accountId).createDraft(c.accountId, { ...c.content, html: sanitizeForEditor(c.content.html) })
  patch(id, { draft: { id: created.id, quotedHtml: created.quotedHtml } })
  return { id: created.id, quotedHtml: created.quotedHtml }
}

async function saveInner(id: string) {
  const c = get(id)
  if (!c || c.saveState === 'clean' || c.saveState === 'saved') return
  patch(id, { saveState: 'saving', saveError: undefined })
  const snapshot = c.content
  try {
    const existed = !!c.draft
    const draft = await ensureDraftInner(id)
    if (existed) await providerFor(c.accountId).updateDraft(c.accountId, draft, { ...snapshot, html: sanitizeForEditor(snapshot.html) })
    const now = get(id)
    // If the user typed while we were saving, stay dirty so the next save picks it up.
    if (now) patch(id, { saveState: now.content === snapshot ? 'saved' : 'dirty' })
  } catch (e) {
    patch(id, { saveState: 'error', saveError: (e as Error).message })
    throw e
  }
}

export function saveNow(id: string) {
  clearTimeout(timers.get(id))
  return serial(id, () => saveInner(id))
}

function scheduleSave(id: string) {
  clearTimeout(timers.get(id))
  timers.set(
    id,
    setTimeout(() => void saveNow(id).catch(() => undefined), 2500),
  )
}

export function updateContent(id: string, p: Partial<DraftContent>) {
  const c = get(id)
  if (!c) return
  patch(id, { content: { ...c.content, ...p }, saveState: 'dirty', error: c.phase === 'sending' ? c.error : undefined })
  scheduleSave(id)
}

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function defaultSendAccount() {
  const s = useSettings.getState()
  const capable = s.accounts.filter((a) => isMailCapable(a.id) && canSend(a.id))
  return capable.find((a) => a.id === s.defaults.sendAccountId)?.id ?? capable[0]?.id
}

export function openNew(accountId = defaultSendAccount(), prefill?: Partial<DraftContent>) {
  if (!accountId) {
    useStatus.getState().toast({ tone: 'error', message: t('compose.noAccount') })
    return
  }
  const signed = withDefaultSignature(prefill?.html ?? '', accountId, false)
  const content = { ...emptyContent(), ...prefill, html: signed.html }
  useCompose.getState().add({
    id: newId(),
    accountId,
    mode: 'new',
    content,
    initialHtml: content.html,
    signatureId: signed.signatureId,
    attachments: [],
    uploads: [],
    phase: 'ready',
    saveState: prefill ? 'dirty' : 'clean',
    minimized: false,
  })
}

/** Reply/forward: the draft is created right away, from the account that received the message. */
export async function openReply(message: MailMessage, kind: ReplyKind) {
  const id = newId()
  const signed = withDefaultSignature('', message.accountId, true)
  useCompose.getState().add({
    id,
    accountId: message.accountId,
    mode: kind,
    sourceMessageId: message.id,
    content: { ...emptyContent(), subject: message.subject, html: signed.html },
    initialHtml: signed.html,
    signatureId: signed.signatureId,
    attachments: [],
    uploads: [],
    phase: 'preparing',
    saveState: 'saved',
    minimized: false,
  })
  await prepareReply(id)
}

const who = (a: Address) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)

/**
 * Forwards a message from an account that can't send (an IMAP account without outgoing server,
 * e.g. a PEC mailbox): a new message from the default sending account, with the original's text
 * and attachments. For a PEC, the attachments include the whole certified envelope as proof.
 */
export async function openForwardFrom(message: MailMessage) {
  const accountId = defaultSendAccount()
  if (!accountId) {
    useStatus.getState().toast({ tone: 'error', message: t('compose.noAccount') })
    return
  }
  const date = new Date(message.date).toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'short' })
  const quoted =
    `<p></p><div class="gmail_quote">${escapeHtml(t('compose.forwardHeader'))}<br>` +
    `${escapeHtml(t('compose.fieldFrom'))}: ${who(message.from)}<br>` +
    `${escapeHtml(t('compose.fieldDate'))}: ${escapeHtml(date)}<br>` +
    `${escapeHtml(t('compose.subject'))}: ${escapeHtml(message.subject)}<br>` +
    `${escapeHtml(t('compose.to'))}: ${message.to.map(who).join(', ')}<br><br>${sanitizeForEditor(message.bodyHtml)}</div>`
  const signed = withDefaultSignature(quoted, accountId, true)
  const html = signed.html
  const id = newId()
  useCompose.getState().add({
    id,
    accountId,
    mode: 'new',
    content: { ...emptyContent(), subject: /^\s*(fwd?|i)\s*:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`, html },
    initialHtml: html,
    attachments: [],
    uploads: [],
    phase: 'ready',
    saveState: 'dirty',
    minimized: false,
    note: message.pec ? t('imap.pecForwardNote') : undefined,
    forwardFrom: true,
    signatureId: signed.signatureId,
  })
  scheduleSave(id)
  try {
    const p = providerFor(message.accountId)
    const files: File[] = []
    for (const a of (await p.attachments(message.accountId, message.id)).filter((x) => !x.isInline)) {
      files.push(new File([await p.downloadAttachment(message.accountId, message.id, a.id)], a.name, { type: a.contentType }))
    }
    if (!get(id)) return
    patch(id, { forwardFiles: files })
    await attachFiles(id, files)
  } catch (e) {
    patch(id, { error: t('compose.prepareFailed', { reason: (e as Error).message }) })
  }
}

export async function prepareReply(id: string) {
  const c = get(id)
  if (!c || !c.sourceMessageId || c.mode === 'new' || c.mode === 'draft') return
  patch(id, { phase: 'preparing', error: undefined })
  try {
    await serial(id, async () => {
      const created = await providerFor(c.accountId).createDraft(c.accountId, emptyContent(), {
        messageId: c.sourceMessageId!,
        kind: c.mode as ReplyKind,
      })
      const attachments = c.mode === 'forward' ? await providerFor(c.accountId).attachments(c.accountId, created.id) : []
      const now = get(id)
      if (!now) {
        // Closed while preparing: don't leave an empty draft behind.
        await providerFor(c.accountId).deleteDraft(c.accountId, created.id).catch(() => undefined)
        return
      }
      patch(id, {
        draft: { id: created.id, quotedHtml: created.quotedHtml },
        content: { ...created.content, html: now.content.html },
        attachments: attachments.filter((a) => !a.isInline),
        phase: 'ready',
        // The draft was created empty: a signature (or text typed meanwhile) still needs saving.
        saveState: now.content.html ? 'dirty' : 'saved',
      })
      if (now.content.html) scheduleSave(id)
    })
  } catch (e) {
    patch(id, { phase: 'ready', error: t('compose.prepareFailed', { reason: (e as Error).message }) })
  }
}

export async function openDraft(accountId: string, draftId: string) {
  if (useCompose.getState().composers.some((c) => c.draft?.id === draftId)) return
  const id = newId()
  useCompose.getState().add({
    id,
    accountId,
    mode: 'draft',
    draft: { id: draftId, quotedHtml: '' },
    content: emptyContent(),
    initialHtml: '',
    attachments: [],
    uploads: [],
    phase: 'preparing',
    saveState: 'saved',
    minimized: false,
  })
  try {
    const d = await providerFor(accountId).loadDraft(accountId, draftId)
    const html = sanitizeForEditor(d.content.html)
    patch(id, { content: { ...d.content, html }, initialHtml: html, attachments: d.attachments, phase: 'ready' })
  } catch (e) {
    patch(id, { phase: 'ready', error: t('compose.loadFailed', { reason: (e as Error).message }) })
  }
}

/** Changes the sending account of a new message (the server draft moves to the new account). */
export async function changeAccount(id: string, accountId: string) {
  const c = get(id)
  if (!c || c.mode !== 'new' || c.accountId === accountId) return
  clearTimeout(timers.get(id))
  await serial(id, async () => {
    const cur = get(id)
    if (!cur) return
    if (cur.draft) {
      await providerFor(cur.accountId)
        .deleteDraft(cur.accountId, cur.draft.id)
        .catch((e) => useStatus.getState().toast({ tone: 'error', message: t('compose.oldDraftNotDeleted', { reason: (e as Error).message }) }))
    }
    patch(id, { accountId, draft: undefined, attachments: [], saveState: 'dirty' })
  })
  // The old account's default signature gives way to the new account's (one picked by hand stays).
  const now = get(id)
  if (now?.signatureId && now.signatureId === defaultSignature(c.accountId, false)?.id) setSignature(id, defaultSignature(accountId, false)?.id ?? null)
  else if (now && !now.signatureId && bodyIsEmpty(now.content.html)) {
    const sig = defaultSignature(accountId, false)
    if (sig) setSignature(id, sig.id)
  }
  scheduleSave(id)
  const files = get(id)?.forwardFiles
  if (files?.length) await attachFiles(id, files)
}

export async function attachFiles(id: string, files: File[]) {
  const MAX = 150 * 1024 * 1024
  for (const file of files) {
    const c = get(id)
    if (!c) return
    if (file.size > MAX) {
      useStatus.getState().toast({ tone: 'error', message: t('compose.tooLarge', { name: file.name }) })
      continue
    }
    const up: Upload = { id: newId(), name: file.name, progress: 0 }
    patch(id, { uploads: [...c.uploads, up] })
    const setProgress = (p: number) => {
      const now = get(id)
      if (now) patch(id, { uploads: now.uploads.map((u) => (u.id === up.id ? { ...u, progress: p } : u)) })
    }
    try {
      await serial(id, async () => {
        const draft = await ensureDraftInner(id)
        const cur = get(id)!
        const list = await providerFor(cur.accountId).addAttachment(cur.accountId, draft.id, file, setProgress)
        patch(id, { attachments: list.filter((a) => !a.isInline) })
      })
    } catch (e) {
      useStatus.getState().toast({ tone: 'error', message: t('compose.attachFailed', { name: file.name, reason: (e as Error).message }) })
    } finally {
      const now = get(id)
      if (now) patch(id, { uploads: now.uploads.filter((u) => u.id !== up.id) })
    }
  }
}

export async function removeAttachment(id: string, attachmentId: string) {
  try {
    await serial(id, async () => {
      const c = get(id)
      if (!c?.draft) return
      await providerFor(c.accountId).removeAttachment(c.accountId, c.draft.id, attachmentId)
      patch(id, { attachments: c.attachments.filter((a) => a.id !== attachmentId) })
    })
  } catch (e) {
    useStatus.getState().toast({ tone: 'error', message: t('compose.removeAttachmentFailed', { reason: (e as Error).message }) })
  }
}

export function validate(c: Composer): string | null {
  const all = [...c.content.to, ...c.content.cc, ...c.content.bcc]
  if (!all.length) return t('compose.needRecipient')
  const bad = all.filter((a) => !isValidEmail(a.email))
  if (bad.length) return t('compose.invalidRecipients', { list: bad.map((a) => a.email).join(', ') })
  if (c.uploads.length) return t('compose.waitUploads')
  return null
}

/** Sends now, or at `at` (see snooze.ts). */
export async function send(id: string, at?: number) {
  const c = get(id)
  if (!c || c.phase !== 'ready') return
  const problem = validate(c)
  if (problem) {
    patch(id, { error: problem })
    return
  }
  if (!c.content.subject.trim() && !confirm(t('compose.confirmNoSubject'))) return
  clearTimeout(timers.get(id))
  patch(id, { phase: 'sending', error: undefined })
  try {
    await serial(id, async () => {
      await saveInner(id)
      const cur = get(id)!
      const draft = await ensureDraftInner(id)
      if (at) await providerFor(cur.accountId).scheduleDraft(cur.accountId, draft.id, at)
      else await providerFor(cur.accountId).sendDraft(cur.accountId, draft.id)
    })
    // Only now — after the provider accepted the message — do we say it was sent.
    useStatus.getState().toast({ tone: 'success', message: at ? t('compose.scheduled', { time: shortDateTime(at) }) : t('compose.sent') })
    useCompose.getState().remove(id)
    refreshAccountMail(c.accountId)
  } catch (e) {
    patch(id, { phase: 'ready', error: t('compose.notSent', { reason: (e as Error).message }) })
  }
}

/** Closes the window, keeping the draft in the mailbox (saved first). Stays open if saving fails. */
export async function closeKeep(id: string) {
  const c = get(id)
  if (!c) return
  if (c.phase === 'sending') return
  // A reply/forward nobody typed into is discarded (as Gmail does); so is an untouched new message.
  const c0 = c.content
  const empty = c.forwardFrom
    ? !c0.to.length && !c0.cc.length && !c0.bcc.length && c0.html === c.initialHtml
    : c.mode === 'new'
      ? isEmpty(c.content) && !c.attachments.length
      : c.mode !== 'draft' && bodyIsEmpty(c.content.html)
  if (empty) return discard(id, true)
  try {
    await saveNow(id)
    const now = get(id)
    if (now?.draft) useStatus.getState().toast({ tone: 'info', message: t('compose.draftSaved') })
    useCompose.getState().remove(id)
    refreshAccountMail(c.accountId)
  } catch {
    patch(id, { minimized: false })
    useStatus.getState().toast({ tone: 'error', message: t('compose.closeSaveFailed') })
  }
}

/** Deletes the draft from the mailbox and closes the window. */
export async function discard(id: string, silent = false) {
  clearTimeout(timers.get(id))
  try {
    await serial(id, async () => {
      const c = get(id)
      if (c?.draft) await providerFor(c.accountId).deleteDraft(c.accountId, c.draft.id)
    })
    const c = get(id)
    useCompose.getState().remove(id)
    if (c) refreshAccountMail(c.accountId)
    if (!silent && c?.draft) useStatus.getState().toast({ tone: 'info', message: t('compose.discarded') })
  } catch (e) {
    patch(id, { error: t('compose.discardFailed', { reason: (e as Error).message }) })
  }
}
