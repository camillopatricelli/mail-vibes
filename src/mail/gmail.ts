import i18n from '../i18n'
import { ApiError } from '../providers/graph'
import { google, googleBatch } from '../providers/google'
import { useSettings } from '../settings/store'
import { sanitizeForEditor, escapeHtml } from './html'
import { buildMime, decodeBase64Url, decodeText, parseAddressHeader, type MimeAttachment } from './mime'
import type { Address, Attachment, DraftContent, FolderKind, ListTarget, MailFolder, MailMessage, MailProvider, MailSummary, MailTag } from './types'

/**
 * Gmail via the Gmail REST API. Gmail has labels instead of folders: well-known folders map to
 * system labels, the user's labels are shown as folders, and "moving" means adding the target
 * label and removing INBOX.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'
const BATCH = 'https://gmail.googleapis.com/batch/gmail/v1'

interface GHeader {
  name: string
  value: string
}
interface GPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GPart[]
}
interface GMsg {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GPart
}
interface GLabel {
  id: string
  name: string
  type?: 'system' | 'user'
  threadsUnread?: number
  messagesUnread?: number
  labelListVisibility?: string
  color?: { backgroundColor?: string; textColor?: string }
}

/** The account's user labels, by id and by lower-case name. */
interface LabelInfo {
  byId: Map<string, GLabel>
  byName: Map<string, GLabel>
}
const labelCache = new Map<string, Promise<LabelInfo>>()
function labelInfo(accountId: string, refresh = false): Promise<LabelInfo> {
  let p = labelCache.get(accountId)
  if (!p || refresh) {
    p = google<{ labels?: GLabel[] }>(accountId, `${API}/labels`).then((r) => {
      const user = (r.labels ?? []).filter((l) => l.type === 'user')
      return { byId: new Map(user.map((l) => [l.id, l])), byName: new Map(user.map((l) => [l.name.toLowerCase(), l])) }
    })
    labelCache.set(accountId, p)
    p.catch(() => labelCache.delete(accountId))
  }
  return p
}

/** Labels made elsewhere since the last look (e.g. in Gmail) trigger one refresh. */
async function labelsFor(accountId: string, msgs: { labelIds?: string[] }[]) {
  const info = await labelInfo(accountId)
  const unknown = msgs.some((m) => m.labelIds?.some((l) => l.startsWith('Label_') && !info.byId.has(l)))
  return unknown ? labelInfo(accountId, true) : info
}

const tagsOf = (m: GMsg, labels?: LabelInfo) => (m.labelIds ?? []).flatMap((id) => labels?.byId.get(id)?.name ?? [])

const header = (p: GPart | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value

function decodeEntities(s: string) {
  if (!s.includes('&')) return s
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s
}

function charsetOf(p: GPart) {
  return /charset="?([^";\s]+)"?/i.exec(header(p, 'Content-Type') ?? '')?.[1]
}

const isAttachmentPart = (p: GPart) => !!p.filename && !!(p.body?.attachmentId || p.body?.data)
const contentIdOf = (p: GPart) => header(p, 'Content-ID')?.replace(/^<|>$/g, '')
const isInlinePart = (p: GPart) => {
  const disp = header(p, 'Content-Disposition') ?? ''
  return /^inline/i.test(disp) || (!/^attachment/i.test(disp) && !!contentIdOf(p) && (p.mimeType ?? '').startsWith('image/'))
}

function walk(p: GPart | undefined, visit: (p: GPart) => void) {
  if (!p) return
  visit(p)
  p.parts?.forEach((c) => walk(c, visit))
}

function bodyOf(payload: GPart | undefined): { html: string; isHtml: boolean } {
  let html: GPart | undefined
  let text: GPart | undefined
  walk(payload, (p) => {
    if (isAttachmentPart(p) || !p.body?.data) return
    if (p.mimeType === 'text/html') html ??= p
    else if (p.mimeType === 'text/plain') text ??= p
  })
  if (html) return { html: decodeText(decodeBase64Url(html.body!.data!), charsetOf(html)), isHtml: true }
  const plain = text ? decodeText(decodeBase64Url(text.body!.data!), charsetOf(text)) : ''
  return { html: `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(plain)}</pre>`, isHtml: false }
}

function attachmentsOf(payload: GPart | undefined): Attachment[] {
  const out: Attachment[] = []
  walk(payload, (p) => {
    if (!isAttachmentPart(p)) return
    out.push({
      id: p.partId ?? '',
      name: p.filename || 'attachment',
      contentType: p.mimeType ?? 'application/octet-stream',
      size: p.body?.size ?? 0,
      isInline: isInlinePart(p),
    })
  })
  return out
}

function kindOf(labels: string[]): Exclude<FolderKind, 'starred'> {
  if (labels.includes('TRASH')) return 'trash'
  if (labels.includes('SPAM')) return 'spam'
  if (labels.includes('DRAFT')) return 'drafts'
  if (labels.includes('INBOX')) return 'inbox'
  if (labels.includes('SENT')) return 'sent'
  return 'archive'
}

function toSummary(accountId: string, m: GMsg, info?: LabelInfo): MailSummary {
  const labels = m.labelIds ?? []
  return {
    accountId,
    id: m.id,
    threadId: m.threadId,
    subject: header(m.payload, 'Subject') ?? '',
    snippet: decodeEntities(m.snippet ?? ''),
    from: parseAddressHeader(header(m.payload, 'From'))[0] ?? { name: '', email: '' },
    to: parseAddressHeader(header(m.payload, 'To')),
    date: Number(m.internalDate) || 0,
    isRead: !labels.includes('UNREAD'),
    isFlagged: labels.includes('STARRED'),
    hasAttachments: m.payload?.mimeType === 'multipart/mixed' || attachmentsOf(m.payload).some((a) => !a.isInline),
    isDraft: labels.includes('DRAFT'),
    tags: tagsOf(m, info),
  }
}

function toMessage(accountId: string, m: GMsg, labels?: LabelInfo): MailMessage {
  const { html, isHtml } = bodyOf(m.payload)
  const atts = attachmentsOf(m.payload)
  return {
    ...toSummary(accountId, m, labels),
    hasAttachments: atts.some((a) => !a.isInline),
    cc: parseAddressHeader(header(m.payload, 'Cc')),
    bcc: parseAddressHeader(header(m.payload, 'Bcc')),
    replyTo: parseAddressHeader(header(m.payload, 'Reply-To')),
    bodyHtml: html,
    bodyIsHtml: isHtml,
    folderId: '',
    folderKind: kindOf(m.labelIds ?? []),
  }
}

const listQuery: Record<FolderKind, { labelIds?: string; q?: string; spamTrash?: boolean }> = {
  inbox: { labelIds: 'INBOX' },
  starred: { labelIds: 'STARRED' },
  sent: { labelIds: 'SENT' },
  drafts: { labelIds: 'DRAFT' },
  // Gmail has no Archive label: "archived" is everything that is not in another well-known place.
  archive: { q: '-in:inbox -in:sent -in:drafts -in:chats' },
  trash: { labelIds: 'TRASH', spamTrash: true },
  spam: { labelIds: 'SPAM', spamTrash: true },
}

const SUMMARY_QS =
  'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&fields=id,threadId,labelIds,snippet,internalDate,payload(mimeType,headers)'

/** Full messages are immutable, so their payload is cached (in memory) for attachment lookups. */
const fullCache = new Map<string, Promise<GMsg>>()
function fullMessage(accountId: string, id: string): Promise<GMsg> {
  const key = `${accountId}|${id}`
  let p = fullCache.get(key)
  if (!p) {
    p = google<GMsg>(accountId, `${API}/messages/${id}?format=full`)
    fullCache.set(key, p)
    p.catch(() => fullCache.delete(key))
    if (fullCache.size > 60) fullCache.delete(fullCache.keys().next().value!)
  }
  return p
}

async function partData(accountId: string, messageId: string, part: GPart): Promise<Uint8Array> {
  if (part.body?.data) return decodeBase64Url(part.body.data)
  const r = await google<{ data: string }>(accountId, `${API}/messages/${messageId}/attachments/${part.body!.attachmentId}`)
  return decodeBase64Url(r.data)
}

function findPart(payload: GPart | undefined, partId: string) {
  let found: GPart | undefined
  walk(payload, (p) => {
    if (p.partId === partId) found = p
  })
  return found
}

async function modify(accountId: string, ids: string[], add: string[], remove: string[]) {
  patchLabels(accountId, ids, add, remove)
  for (let i = 0; i < ids.length; i += 1000)
    await google(accountId, `${API}/messages/batchModify`, {
      method: 'POST',
      body: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove },
    })
}

async function perMessage(accountId: string, ids: string[], action: 'trash' | 'untrash') {
  const parts = await googleBatch(
    accountId,
    BATCH,
    ids.map((id) => ({ method: 'POST', path: `/gmail/v1/users/me/messages/${id}/${action}` })),
  )
  const failed = parts.filter((p) => p.status >= 400)
  if (failed.length)
    throw new ApiError(
      (failed[0].body as { error?: { message?: string } }).error?.message ?? `${failed.length} of ${ids.length} failed`,
      failed[0].status,
    )
}

// ---- List cache ---------------------------------------------------------------------------
// Fetching every listed message on every poll quickly hits Gmail's per-user limits. Message
// headers never change, so list entries are kept in memory and only their labels (read, starred,
// folders) are kept up to date through Gmail's change history: one small request per refresh.

interface ListCache {
  historyId?: string
  messages: Map<string, GMsg>
  chain: Promise<unknown>
}
const listCaches = new Map<string, ListCache>()
const MAX_CACHED = 3000

interface HistoryPage {
  history?: {
    messagesDeleted?: { message: { id: string } }[]
    labelsAdded?: { message: { id: string; labelIds?: string[] } }[]
    labelsRemoved?: { message: { id: string; labelIds?: string[] } }[]
  }[]
  historyId?: string
  nextPageToken?: string
}

async function applyHistory(accountId: string, c: ListCache) {
  if (!c.historyId) {
    c.messages.clear()
    c.historyId = (await google<{ historyId: string }>(accountId, `${API}/profile?fields=historyId`)).historyId
    return
  }
  let pageToken: string | undefined
  let latest = c.historyId
  try {
    do {
      const q = new URLSearchParams({ startHistoryId: c.historyId, maxResults: '500' })
      for (const t of ['labelAdded', 'labelRemoved', 'messageDeleted']) q.append('historyTypes', t)
      if (pageToken) q.set('pageToken', pageToken)
      const r = await google<HistoryPage>(accountId, `${API}/history?${q}`)
      for (const h of r.history ?? []) {
        for (const d of h.messagesDeleted ?? []) c.messages.delete(d.message.id)
        for (const ch of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
          const m = c.messages.get(ch.message.id)
          if (m && ch.message.labelIds) m.labelIds = ch.message.labelIds
        }
      }
      if (r.historyId) latest = r.historyId
      pageToken = r.nextPageToken
    } while (pageToken)
    c.historyId = latest
  } catch (e) {
    // The starting point is too old (Gmail keeps about a week of history): start over.
    if (e instanceof ApiError && e.status === 404) {
      c.historyId = undefined
      return applyHistory(accountId, c)
    }
    throw e
  }
}

/** Brings the cache up to date and returns it, with every id in `ids` present (unless deleted). */
function summaries(accountId: string, ids: string[]): Promise<Map<string, GMsg>> {
  let c = listCaches.get(accountId)
  if (!c) listCaches.set(accountId, (c = { messages: new Map(), chain: Promise.resolve() }))
  const cache = c
  const run = cache.chain.catch(() => undefined).then(async () => {
    await applyHistory(accountId, cache)
    if (cache.messages.size > MAX_CACHED) cache.messages.clear()
    const missing = ids.filter((id) => !cache.messages.has(id))
    const parts = await googleBatch<GMsg>(
      accountId,
      BATCH,
      missing.map((id) => ({ path: `/gmail/v1/users/me/messages/${id}?${SUMMARY_QS}` })),
    )
    // A message deleted between the calls answers 404: skip it rather than failing the list.
    const bad = parts.filter((p) => p.status >= 400 && p.status !== 404)
    if (bad.length)
      throw new ApiError((bad[0].body as { error?: { message?: string } }).error?.message ?? `HTTP ${bad[0].status}`, bad[0].status)
    for (const p of parts) if (p.status < 400) cache.messages.set((p.body as GMsg).id, p.body as GMsg)
    return cache.messages
  })
  cache.chain = run
  return run
}

/** Applies a label change made by this app right away (the history catches up on the next sync). */
function patchLabels(accountId: string, ids: string[], add: string[], remove: string[]) {
  const c = listCaches.get(accountId)
  if (!c) return
  for (const id of ids) {
    const m = c.messages.get(id)
    if (m) m.labelIds = [...new Set([...(m.labelIds ?? []).filter((l) => !remove.includes(l)), ...add])]
  }
}

// ---- Drafts -------------------------------------------------------------------------------
// Gmail replaces the whole raw message on every draft update, so the composer's draft state
// (including attachment contents) is kept in memory for as long as the composer is open.

interface DraftAttachment {
  meta: Attachment
  blob: Blob
  contentId?: string
}
interface DraftState {
  draftId: string
  threadId?: string
  inReplyTo?: string
  references?: string
  quotedHtml: string
  content: DraftContent
  attachments: DraftAttachment[]
}
const drafts = new Map<string, DraftState>()
const draftKey = (accountId: string, id: string) => `${accountId}|${id}`

const MAX_TOTAL = 25 * 1024 * 1024

function ownAddress(accountId: string): Address {
  const a = useSettings.getState().accounts.find((x) => x.id === accountId)
  return { name: a?.displayName ?? '', email: a?.email ?? '' }
}

async function uploadDraft(accountId: string, d: DraftState, create: boolean) {
  const total = d.attachments.reduce((n, a) => n + a.blob.size, 0)
  if (total > MAX_TOTAL) throw new ApiError(i18n.t('compose.gmailTooLarge'), 413)
  const html = d.quotedHtml ? `${d.content.html}<br>${d.quotedHtml}` : d.content.html
  const mime = await buildMime({
    from: ownAddress(accountId),
    ...d.content,
    html,
    inReplyTo: d.inReplyTo,
    references: d.references,
    attachments: d.attachments.map(
      (a): MimeAttachment => ({ name: a.meta.name, contentType: a.meta.contentType, blob: a.blob, contentId: a.contentId }),
    ),
  })
  const b = `mv_${crypto.randomUUID().replace(/-/g, '')}`
  const meta = JSON.stringify(create ? { message: { threadId: d.threadId } } : { id: d.draftId, message: { threadId: d.threadId } })
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`,
    mime,
    `\r\n--${b}--`,
  ])
  const url = create ? `${UPLOAD}/drafts?uploadType=multipart` : `${UPLOAD}/drafts/${d.draftId}?uploadType=multipart`
  return google<{ id: string; message?: { id: string; threadId: string } }>(accountId, url, {
    method: create ? 'POST' : 'PUT',
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body,
  })
}

function dedupe(list: Address[], exclude: string[]) {
  const seen = new Set(exclude.map((e) => e.toLowerCase()))
  return list.filter((a) => {
    const k = a.email.toLowerCase()
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd') {
  const re = prefix === 'Re' ? /^\s*re\s*:/i : /^\s*(fwd?|i)\s*:/i
  return re.test(subject) ? subject : `${prefix}: ${subject}`
}

const who = (a?: Address) => (a ? (a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.email)}&gt;` : escapeHtml(a.email)) : '')

async function originalAttachments(accountId: string, m: GMsg, includeFiles: boolean): Promise<DraftAttachment[]> {
  const out: DraftAttachment[] = []
  const parts: GPart[] = []
  walk(m.payload, (p) => {
    if (isAttachmentPart(p) && (includeFiles || (isInlinePart(p) && contentIdOf(p)))) parts.push(p)
  })
  for (const p of parts) {
    const bytes = await partData(accountId, m.id, p)
    const inline = isInlinePart(p) && !!contentIdOf(p)
    out.push({
      meta: {
        id: crypto.randomUUID(),
        name: p.filename || 'attachment',
        contentType: p.mimeType ?? 'application/octet-stream',
        size: bytes.length,
        isInline: inline,
      },
      blob: new Blob([bytes as BlobPart], { type: p.mimeType }),
      contentId: inline ? contentIdOf(p) : undefined,
    })
  }
  return out
}

const visibleAttachments = (d: DraftState) => d.attachments.filter((a) => !a.contentId).map((a) => a.meta)

async function draftState(accountId: string, id: string): Promise<DraftState> {
  const d = drafts.get(draftKey(accountId, id))
  if (d) return d
  await gmail.loadDraft(accountId, id)
  return drafts.get(draftKey(accountId, id))!
}

export const gmail: MailProvider = {
  async list(accountId, target: ListTarget, count) {
    const params = new URLSearchParams({ maxResults: String(Math.min(count, 500)) })
    if (typeof target === 'string') {
      const q = listQuery[target]
      if (q.labelIds) params.set('labelIds', q.labelIds)
      if (q.q) params.set('q', q.q)
      if (q.spamTrash) params.set('includeSpamTrash', 'true')
    } else if ('tag' in target) {
      const label = (await labelInfo(accountId)).byName.get(target.tag.toLowerCase())
      if (!label) return { messages: [], hasMore: false }
      params.set('labelIds', label.id)
    } else params.set('labelIds', target.folderId)
    const page = await google<{ messages?: { id: string }[]; nextPageToken?: string }>(accountId, `${API}/messages?${params}`)
    const ids = (page.messages ?? []).map((m) => m.id)
    const cache = await summaries(accountId, ids)
    const found = ids.flatMap((id) => cache.get(id) ?? [])
    const labels = await labelsFor(accountId, found)
    return {
      messages: found.map((m) => toSummary(accountId, m, labels)),
      hasMore: !!page.nextPageToken,
    }
  },

  async thread(accountId, threadId) {
    const t = await google<{ messages?: GMsg[] }>(accountId, `${API}/threads/${threadId}?format=full`)
    const labels = await labelsFor(accountId, t.messages ?? [])
    return (t.messages ?? []).map((m) => {
      fullCache.set(`${accountId}|${m.id}`, Promise.resolve(m))
      return toMessage(accountId, m, labels)
    }).sort((a, b) => a.date - b.date)
  },

  setRead: (accountId, ids, read) => (read ? modify(accountId, ids, [], ['UNREAD']) : modify(accountId, ids, ['UNREAD'], [])),

  setFlagged: (accountId, ids, flagged) =>
    flagged ? modify(accountId, ids, ['STARRED'], []) : modify(accountId, ids, [], ['STARRED']),

  async tags(accountId) {
    const info = await labelInfo(accountId, true)
    return [...info.byId.values()].map((l): MailTag => ({ name: l.name, color: l.color?.backgroundColor }))
  },

  async setTags(accountId, messages, add, remove) {
    let info = await labelInfo(accountId)
    const addIds: string[] = []
    for (const name of add) {
      let label = info.byName.get(name.toLowerCase())
      if (!label) {
        label = await google<GLabel>(accountId, `${API}/labels`, {
          method: 'POST',
          body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        })
        info = await labelInfo(accountId, true)
      }
      addIds.push(label.id)
    }
    const removeIds = remove.flatMap((n) => info.byName.get(n.toLowerCase())?.id ?? [])
    if (addIds.length || removeIds.length) await modify(accountId, messages.map((m) => m.id), addIds, removeIds)
  },

  async move(accountId, ids, dest) {
    if (typeof dest !== 'string') {
      if ('tag' in dest) throw new ApiError(`Cannot move messages to ${dest.tag}`, 400)
      return modify(accountId, ids, [dest.folderId], ['INBOX', 'SPAM'])
    }
    switch (dest) {
      case 'trash':
        return perMessage(accountId, ids, 'trash')
      case 'spam':
        return modify(accountId, ids, ['SPAM'], ['INBOX'])
      case 'archive':
        return modify(accountId, ids, [], ['INBOX', 'SPAM'])
      case 'inbox':
      case 'starred':
        // Restoring from Trash needs "untrash"; for other messages it is harmless.
        await perMessage(accountId, ids, 'untrash')
        return modify(accountId, ids, ['INBOX'], ['SPAM'])
      default:
        throw new ApiError(`Cannot move messages to ${dest}`, 400)
    }
  },

  async deleteForever() {
    // Permanent deletion needs full mailbox access (https://mail.google.com/), which this app
    // deliberately does not request. Gmail empties Trash and Spam after 30 days.
    throw new ApiError(i18n.t('mail.gmailNoDeleteForever'), 403)
  },

  async folders(accountId) {
    const r = await google<{ labels?: GLabel[] }>(accountId, `${API}/labels`)
    const user = (r.labels ?? []).filter((l) => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name))
    const parts = await googleBatch<GLabel>(
      accountId,
      BATCH,
      user.map((l) => ({ path: `/gmail/v1/users/me/labels/${l.id}?fields=id,threadsUnread` })),
    )
    return user.map((l, i): MailFolder => {
      const segments = l.name.split('/')
      const counted = parts[i]?.status < 400 ? (parts[i].body as GLabel) : undefined
      return { id: l.id, name: segments[segments.length - 1], depth: segments.length - 1, unread: counted?.threadsUnread ?? 0 }
    })
  },

  async unreadCount(accountId, folder) {
    const label = { inbox: 'INBOX', spam: 'SPAM', trash: 'TRASH', drafts: 'DRAFT', sent: 'SENT' }[folder as string]
    if (!label) return 0
    const l = await google<GLabel>(accountId, `${API}/labels/${label}?fields=threadsUnread`)
    return l.threadsUnread ?? 0
  },

  async attachments(accountId, messageId) {
    const d = drafts.get(draftKey(accountId, messageId))
    if (d) return d.attachments.map((a) => a.meta)
    return attachmentsOf((await fullMessage(accountId, messageId)).payload)
  },

  async downloadAttachment(accountId, messageId, attachmentId) {
    const d = drafts.get(draftKey(accountId, messageId))
    const own = d?.attachments.find((a) => a.meta.id === attachmentId)
    if (own) return own.blob
    const m = await fullMessage(accountId, messageId)
    const part = findPart(m.payload, attachmentId)
    if (!part) throw new ApiError('Attachment not found', 404)
    return new Blob([(await partData(accountId, messageId, part)) as BlobPart], { type: part.mimeType })
  },

  async inlineImages(accountId, messageId) {
    const m = await fullMessage(accountId, messageId)
    const map = new Map<string, Blob>()
    const parts: GPart[] = []
    walk(m.payload, (p) => {
      if (isAttachmentPart(p) && contentIdOf(p) && (p.mimeType ?? '').startsWith('image/')) parts.push(p)
    })
    await Promise.all(
      parts.map(async (p) => {
        try {
          map.set(contentIdOf(p)!, new Blob([(await partData(accountId, messageId, p)) as BlobPart], { type: p.mimeType }))
        } catch {
          // A missing inline image is shown as a broken image, not an error for the whole message.
        }
      }),
    )
    return map
  },

  async createDraft(accountId, content, replyTo) {
    const me = ownAddress(accountId)
    const state: DraftState = { draftId: '', quotedHtml: '', content, attachments: [] }
    if (replyTo) {
      const orig = await fullMessage(accountId, replyTo.messageId)
      const o = toMessage(accountId, orig)
      const messageId = header(orig.payload, 'Message-ID') ?? header(orig.payload, 'Message-Id')
      const date = new Date(o.date).toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'short' })
      const quoted = sanitizeForEditor(o.bodyHtml)
      if (replyTo.kind === 'forward') {
        state.content = { ...content, subject: prefixed(o.subject, 'Fwd') }
        state.quotedHtml =
          `<div class="gmail_quote">${escapeHtml(i18n.t('compose.forwardHeader'))}<br>` +
          `${escapeHtml(i18n.t('compose.fieldFrom'))}: ${who(o.from)}<br>` +
          `${escapeHtml(i18n.t('compose.fieldDate'))}: ${escapeHtml(date)}<br>` +
          `${escapeHtml(i18n.t('compose.subject'))}: ${escapeHtml(o.subject)}<br>` +
          `${escapeHtml(i18n.t('compose.to'))}: ${o.to.map(who).join(', ')}<br><br>${quoted}</div>`
        state.attachments = await originalAttachments(accountId, orig, true)
      } else {
        const fromMe = o.from.email.toLowerCase() === me.email.toLowerCase()
        const primary = fromMe ? o.to : o.replyTo.length ? o.replyTo : [o.from]
        const to = replyTo.kind === 'replyAll' ? dedupe([...primary, ...o.to], [me.email]) : dedupe(primary, [])
        const cc = replyTo.kind === 'replyAll' ? dedupe(o.cc, [me.email, ...to.map((a) => a.email)]) : []
        state.content = { ...content, to, cc, bcc: [], subject: prefixed(o.subject, 'Re') }
        state.threadId = orig.threadId
        state.inReplyTo = messageId
        state.references = [header(orig.payload, 'References'), messageId].filter(Boolean).join(' ') || undefined
        state.quotedHtml =
          `<div class="gmail_quote"><div>${escapeHtml(i18n.t('compose.quoteHeader', { date, name: o.from.name || o.from.email }))}</div>` +
          `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`
        // Inline images of the quoted message keep working in the reply.
        state.attachments = await originalAttachments(accountId, orig, false)
      }
    }
    const r = await uploadDraft(accountId, state, true)
    state.draftId = r.id
    state.threadId = r.message?.threadId ?? state.threadId
    drafts.set(draftKey(accountId, r.id), state)
    return { id: r.id, quotedHtml: state.quotedHtml, content: state.content }
  },

  async updateDraft(accountId, draft, content) {
    const d = await draftState(accountId, draft.id)
    d.content = content
    await uploadDraft(accountId, d, false)
  },

  async addAttachment(accountId, draftId, file, onProgress) {
    const d = await draftState(accountId, draftId)
    const added: DraftAttachment = {
      meta: { id: crypto.randomUUID(), name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, isInline: false },
      blob: file,
    }
    d.attachments.push(added)
    try {
      await uploadDraft(accountId, d, false)
    } catch (e) {
      d.attachments = d.attachments.filter((a) => a !== added)
      throw e
    }
    onProgress?.(1)
    return visibleAttachments(d)
  },

  async removeAttachment(accountId, draftId, attachmentId) {
    const d = await draftState(accountId, draftId)
    const before = d.attachments
    d.attachments = d.attachments.filter((a) => a.meta.id !== attachmentId)
    try {
      await uploadDraft(accountId, d, false)
    } catch (e) {
      d.attachments = before
      throw e
    }
  },

  async sendDraft(accountId, draftId) {
    const d = await draftState(accountId, draftId)
    // Answers with the sent message once Gmail has accepted it.
    await google(accountId, `${API}/drafts/send`, { method: 'POST', body: { id: d.draftId } })
    drafts.delete(draftKey(accountId, draftId))
  },

  async deleteDraft(accountId, draftId) {
    const d = drafts.get(draftKey(accountId, draftId))
    const id = d?.draftId ?? (await resolveDraftId(accountId, draftId))
    await google(accountId, `${API}/drafts/${id}`, { method: 'DELETE' })
    drafts.delete(draftKey(accountId, draftId))
  },

  /** Accepts a draft id or the id of the draft's message (as shown in the Drafts list). */
  async loadDraft(accountId, id) {
    const draftId = await resolveDraftId(accountId, id)
    const r = await google<{ id: string; message: GMsg }>(accountId, `${API}/drafts/${draftId}?format=full`)
    const m = r.message
    const o = toMessage(accountId, m)
    const content: DraftContent = { to: o.to, cc: o.cc, bcc: o.bcc, subject: o.subject, html: o.bodyHtml }
    const state: DraftState = {
      draftId: r.id,
      threadId: m.threadId,
      inReplyTo: header(m.payload, 'In-Reply-To'),
      references: header(m.payload, 'References'),
      quotedHtml: '',
      content,
      attachments: await originalAttachments(accountId, m, true),
    }
    drafts.set(draftKey(accountId, id), state)
    return { content, attachments: visibleAttachments(state) }
  },
}

async function resolveDraftId(accountId: string, id: string): Promise<string> {
  let pageToken: string | undefined
  do {
    const r = await google<{ drafts?: { id: string; message?: { id: string } }[]; nextPageToken?: string }>(
      accountId,
      `${API}/drafts?maxResults=500&fields=drafts(id,message/id),nextPageToken${pageToken ? `&pageToken=${pageToken}` : ''}`,
    )
    const hit = r.drafts?.find((d) => d.message?.id === id || d.id === id)
    if (hit) return hit.id
    pageToken = r.nextPageToken
  } while (pageToken)
  throw new ApiError(i18n.t('compose.draftGone'), 404)
}
