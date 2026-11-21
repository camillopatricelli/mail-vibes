import { graph, ApiError, type GraphPage } from '../providers/graph'
import { AuthRequiredError } from '../auth/errors'
import { MAILBOX_SCOPES } from '../auth/msal'
import type {
  Address,
  Attachment,
  DraftContent,
  DraftRef,
  FolderKind,
  ListResult,
  ListTarget,
  MailFolder,
  MailMessage,
  MailProvider,
  MailSummary,
  MailTag,
  ReplyKind,
} from './types'
import { SNOOZE_FOLDER } from './snooze'
import { escapeHtml, insertIntoBody } from './html'

/** Outlook mail via Microsoft Graph. */

interface GRecipient {
  emailAddress?: { name?: string; address?: string }
}
interface GMessage {
  id: string
  conversationId: string
  singleValueExtendedProperties?: { id: string; value?: string }[]
  subject?: string
  bodyPreview?: string
  from?: GRecipient
  sender?: GRecipient
  toRecipients?: GRecipient[]
  ccRecipients?: GRecipient[]
  bccRecipients?: GRecipient[]
  replyTo?: GRecipient[]
  receivedDateTime?: string
  sentDateTime?: string
  createdDateTime?: string
  isRead?: boolean
  isDraft?: boolean
  flag?: { flagStatus?: string }
  hasAttachments?: boolean
  parentFolderId?: string
  categories?: string[]
  body?: { contentType?: string; content?: string }
}
interface GAttachment {
  id: string
  name?: string
  contentType?: string
  size?: number
  isInline?: boolean
  contentId?: string
  contentBytes?: string
}

type PlainFolder = Exclude<FolderKind, 'starred' | 'snoozed' | 'scheduled'>
const wellKnown: Record<PlainFolder, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  archive: 'archive',
  trash: 'deleteditems',
  spam: 'junkemail',
}

/** Wake-up time of a snoozed message (ISO date), stored invisibly on the message. */
const SNOOZE_PROP = 'String {6c1f7e0a-3b5d-4f2e-9a8c-1d4b7e2f9c35} Name MailVibesSnoozedUntil'
const SNOOZE_EXPAND = `$expand=singleValueExtendedProperties($filter=id eq '${SNOOZE_PROP}')`
/** Exchange's own "send at" time (PidTagDeferredSendTime): the message waits in the Outbox until then. */
const DEFERRED_PROP = 'SystemTime 0x3FEF'
const DEFERRED_EXPAND = `$expand=singleValueExtendedProperties($filter=id eq '${DEFERRED_PROP}')`
const propValue = (m: GMessage, id: string) => m.singleValueExtendedProperties?.find((p) => p.id.toLowerCase() === id.toLowerCase())?.value

const snoozeFolderCache = new Map<string, string>()
/** The "Snoozed" folder (at the top of the mailbox), created when asked to. */
async function snoozeFolderId(accountId: string, create: boolean): Promise<string | undefined> {
  const known = snoozeFolderCache.get(accountId)
  if (known) return known
  const page = await graph<GraphPage<{ id: string }>>(accountId, `/me/mailFolders?$filter=displayName eq '${SNOOZE_FOLDER}'&$select=id`)
  let id = page.value[0]?.id
  if (!id && create) id = (await graph<{ id: string }>(accountId, '/me/mailFolders', { method: 'POST', body: { displayName: SNOOZE_FOLDER } })).id
  if (id) snoozeFolderCache.set(accountId, id)
  return id
}

const SUMMARY_FIELDS =
  'id,conversationId,subject,bodyPreview,from,sender,toRecipients,receivedDateTime,sentDateTime,isRead,isDraft,flag,hasAttachments,categories'
const FULL_FIELDS = `${SUMMARY_FIELDS},ccRecipients,bccRecipients,replyTo,parentFolderId,body`
const HTML_BODY = { Prefer: 'outlook.body-content-type="html"' }

const addr = (r?: GRecipient): Address => ({
  name: r?.emailAddress?.name ?? '',
  email: r?.emailAddress?.address ?? '',
})
const addrs = (rs?: GRecipient[]) => (rs ?? []).map(addr).filter((a) => a.email)
const toRecipients = (list: Address[]) => list.map((a) => ({ emailAddress: { name: a.name || undefined, address: a.email } }))

function toSummary(accountId: string, m: GMessage): MailSummary {
  const date = Date.parse(m.receivedDateTime ?? m.sentDateTime ?? m.createdDateTime ?? '') || 0
  return {
    accountId,
    id: m.id,
    threadId: m.conversationId,
    subject: m.subject ?? '',
    snippet: m.bodyPreview ?? '',
    from: addr(m.from ?? m.sender),
    to: addrs(m.toRecipients),
    date,
    isRead: m.isRead ?? true,
    isFlagged: m.flag?.flagStatus === 'flagged',
    hasAttachments: !!m.hasAttachments,
    isDraft: !!m.isDraft,
    tags: m.categories ?? [],
    snoozedUntil: Date.parse(propValue(m, SNOOZE_PROP) ?? '') || undefined,
    scheduledAt: Date.parse(propValue(m, DEFERRED_PROP) ?? '') || undefined,
  }
}

// Well-known folder ids per account, as folderId -> kind (to know where each thread message is).
const folderIdCache = new Map<string, Promise<Map<string, PlainFolder>>>()
function specialFolderIds(accountId: string) {
  let p = folderIdCache.get(accountId)
  if (!p) {
    p = (async () => {
      const out = new Map<string, PlainFolder>()
      await Promise.all(
        (Object.entries(wellKnown) as [PlainFolder, string][]).map(async ([kind, wk]) => {
          try {
            const f = await graph<{ id: string }>(accountId, `/me/mailFolders/${wk}?$select=id`)
            out.set(f.id, kind)
          } catch (e) {
            // Some mailboxes have no Archive folder yet; that's fine.
            if (!(e instanceof ApiError && e.status === 404)) throw e
          }
        }),
      )
      return out
    })()
    folderIdCache.set(accountId, p)
    p.catch(() => folderIdCache.delete(accountId))
  }
  return p
}

// System folders that are not shown as user folders (besides the well-known ones above).
const HIDDEN_SYSTEM = ['outbox', 'conversationhistory', 'syncissues', 'scheduled', 'searchfolders', 'recoverableitemsdeletions']
const hiddenCache = new Map<string, Promise<Set<string>>>()
function hiddenFolderIds(accountId: string) {
  let p = hiddenCache.get(accountId)
  if (!p) {
    p = (async () => {
      const out = new Set<string>()
      await Promise.all(
        HIDDEN_SYSTEM.map(async (wk) => {
          try {
            const f = await graph<{ id: string }>(accountId, `/me/mailFolders/${wk}?$select=id`, { quiet: true })
            out.add(f.id)
          } catch {
            // Not present in this mailbox (or not accessible): nothing to hide.
          }
        }),
      )
      return out
    })()
    hiddenCache.set(accountId, p)
  }
  return p
}

/** Runs up to 20 requests per Graph JSON batch; throws if any of them failed. */
async function batch(accountId: string, requests: { method: string; url: string; body?: unknown }[]) {
  const failures: string[] = []
  for (let i = 0; i < requests.length; i += 20) {
    const chunk = requests.slice(i, i + 20)
    const res = await graph<{ responses: { id: string; status: number; body?: { error?: { message?: string } } }[] }>(
      accountId,
      '/$batch',
      {
        method: 'POST',
        body: {
          requests: chunk.map((r, j) => ({
            id: String(j),
            method: r.method,
            url: r.url,
            ...(r.body !== undefined ? { body: r.body, headers: { 'Content-Type': 'application/json' } } : {}),
          })),
        },
      },
    )
    for (const r of res.responses) if (r.status >= 400) failures.push(r.body?.error?.message ?? `HTTP ${r.status}`)
  }
  if (failures.length) {
    throw new ApiError(
      failures.length === requests.length ? failures[0] : `${failures.length} of ${requests.length} failed: ${failures[0]}`,
      400,
    )
  }
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Outlook's category colour presets (approximately as Outlook shows them). */
const PRESETS = [
  '#e74856', '#f7894a', '#a5774f', '#fcd116', '#4cae4c', '#30c5b5', '#8fa34a', '#4f8bd6', '#8764b8', '#e3008c',
  '#6f8a9e', '#4a5f70', '#a0a0a0', '#5d5d5d', '#2b2b2b', '#a4262c', '#ca5010', '#8e562e', '#c19c00', '#0b6a0b',
  '#038387', '#5c7e10', '#004e8c', '#5c2e91', '#990051',
]
const presetColor = (c?: string) => {
  const i = /^preset(\d+)$/.exec(c ?? '')?.[1]
  return i === undefined ? undefined : PRESETS[Number(i)]
}
const quote = (s: string) => s.replace(/'/g, "''")

type MasterCategory = { displayName: string; color?: string }
/** Per account: whether the category list could be read ('needsConsent': permission not granted yet). */
const categoryAccess = new Map<string, 'ok' | 'needsConsent'>()
export const outlookNeedsCategoryConsent = (accountId: string) => categoryAccess.get(accountId) === 'needsConsent'

/** The account's category list, or undefined without the mailbox-settings permission. */
async function masterCategories(accountId: string): Promise<MasterCategory[] | undefined> {
  try {
    const r = await graph<GraphPage<MasterCategory>>(accountId, '/me/outlook/masterCategories', { quiet: true, scopes: MAILBOX_SCOPES })
    categoryAccess.set(accountId, 'ok')
    return r.value
  } catch (e) {
    if (e instanceof AuthRequiredError || (e instanceof ApiError && e.status === 403)) {
      categoryAccess.set(accountId, 'needsConsent')
      return undefined
    }
    throw e
  }
}

/** A colour for a new category, chosen from the name so it is stable. */
function presetFor(name: string) {
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0
  return `preset${Math.abs(h) % 10}`
}

function toAttachment(a: GAttachment): Attachment {
  return {
    id: a.id,
    name: a.name ?? 'attachment',
    contentType: a.contentType ?? 'application/octet-stream',
    size: a.size ?? 0,
    isInline: !!a.isInline,
  }
}

export const outlook: MailProvider = {
  async list(accountId, target: ListTarget, count): Promise<ListResult> {
    const top = Math.min(count, 500)
    if (target === 'snoozed') {
      const folderId = await snoozeFolderId(accountId, false)
      if (!folderId) return { messages: [], hasMore: false }
      const page = await graph<GraphPage<GMessage>>(
        accountId,
        `/me/mailFolders/${encodeURIComponent(folderId)}/messages?$orderby=receivedDateTime desc&$top=${top}&$select=${SUMMARY_FIELDS}&${SNOOZE_EXPAND}`,
      )
      return { messages: page.value.map((m) => toSummary(accountId, m)), hasMore: !!page['@odata.nextLink'] }
    }
    if (target === 'scheduled') {
      const page = await graph<GraphPage<GMessage>>(accountId, `/me/mailFolders/outbox/messages?$top=${top}&$select=${SUMMARY_FIELDS}&${DEFERRED_EXPAND}`)
      return { messages: page.value.map((m) => toSummary(accountId, m)).sort((a, b) => b.date - a.date), hasMore: !!page['@odata.nextLink'] }
    }
    if (typeof target === 'object' && 'search' in target) {
      // $search can't be combined with $orderby; Outlook returns the newest matches first.
      const kql = encodeURIComponent(`"${target.search.replace(/["\\]/g, ' ')}"`)
      const page = await graph<GraphPage<GMessage>>(accountId, `/me/messages?$search=${kql}&$top=${top}&$select=${SUMMARY_FIELDS}`)
      return { messages: page.value.map((m) => toSummary(accountId, m)), hasMore: !!page['@odata.nextLink'] }
    }
    const path =
      typeof target === 'object' && 'tag' in target
        ? `/me/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and categories/any(c:c eq '${encodeURIComponent(quote(target.tag))}')&$orderby=receivedDateTime desc`
        : target === 'starred'
        ? `/me/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'&$orderby=receivedDateTime desc`
        : `/me/mailFolders/${typeof target === 'string' ? wellKnown[target] : encodeURIComponent((target as { folderId: string }).folderId)}/messages?$orderby=receivedDateTime desc`
    const page = await graph<GraphPage<GMessage>>(accountId, `${path}&$top=${top}&$select=${SUMMARY_FIELDS}`)
    return {
      messages: page.value.map((m) => toSummary(accountId, m)),
      hasMore: !!page['@odata.nextLink'],
    }
  },

  async thread(accountId, threadId) {
    const [page, special] = await Promise.all([
      graph<GraphPage<GMessage>>(
        accountId,
        `/me/messages?$filter=conversationId eq '${threadId.replace(/'/g, "''")}'&$top=200&$select=${FULL_FIELDS}&${SNOOZE_EXPAND}`,
        { headers: HTML_BODY },
      ),
      specialFolderIds(accountId),
    ])
    return page.value
      .map((m): MailMessage => {
        const isHtml = m.body?.contentType?.toLowerCase() === 'html'
        return {
          ...toSummary(accountId, m),
          cc: addrs(m.ccRecipients),
          bcc: addrs(m.bccRecipients),
          replyTo: addrs(m.replyTo),
          bodyHtml: isHtml ? (m.body?.content ?? '') : `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(m.body?.content ?? '')}</pre>`,
          bodyIsHtml: isHtml,
          folderId: m.parentFolderId ?? '',
          folderKind: special.get(m.parentFolderId ?? ''),
        }
      })
      .sort((a, b) => a.date - b.date)
  },

  async setRead(accountId, ids, read) {
    await batch(accountId, ids.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: { isRead: read } })))
  },

  async setFlagged(accountId, ids, flagged) {
    await batch(
      accountId,
      ids.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } } })),
    )
  },

  async tags(accountId) {
    // The category list needs the mailbox-settings permission, which may not be granted: then the
    // categories used on recent messages stand in for it (without colours).
    const master = await masterCategories(accountId)
    if (master) return master.map((c): MailTag => ({ name: c.displayName, color: presetColor(c.color) }))
    const r = await graph<GraphPage<{ categories?: string[] }>>(accountId, '/me/messages?$top=250&$select=categories', { quiet: true })
    return [...new Set(r.value.flatMap((m) => m.categories ?? []))].map((name): MailTag => ({ name }))
  },

  async setTags(accountId, messages, add, remove) {
    // New tags become proper Outlook categories (with a colour) when the list can be edited;
    // otherwise Outlook shows them as categories that are "not in the master list".
    if (add.length) {
      const master = await masterCategories(accountId).catch(() => undefined)
      const known = new Set(master?.map((c) => c.displayName.toLowerCase()))
      if (master)
        for (const name of add.filter((n) => !known.has(n.toLowerCase())))
          await graph(accountId, '/me/outlook/masterCategories', {
            method: 'POST',
            body: { displayName: name, color: presetFor(name) },
            quiet: true,
            scopes: MAILBOX_SCOPES,
          }).catch(() => undefined)
    }
    const drop = new Set(remove.map((n) => n.toLowerCase()))
    const requests = messages.map((m) => {
      const kept = m.tags.filter((n) => !drop.has(n.toLowerCase()))
      const next = [...kept, ...add.filter((n) => !kept.some((k) => k.toLowerCase() === n.toLowerCase()))]
      return { method: 'PATCH', url: `/me/messages/${m.id}`, body: { categories: next } }
    })
    await batch(accountId, requests)
  },

  async move(accountId, ids, dest) {
    if (typeof dest === 'object' && !('folderId' in dest)) throw new ApiError('Cannot move messages there', 400)
    if (dest === 'snoozed' || dest === 'scheduled') throw new ApiError('Cannot move messages there', 400)
    const destinationId = typeof dest === 'string' ? (dest === 'starred' ? 'inbox' : wellKnown[dest]) : dest.folderId
    await batch(accountId, ids.map((id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId } })))
  },

  async deleteForever(accountId, ids) {
    await batch(accountId, ids.map((id) => ({ method: 'DELETE', url: `/me/messages/${id}` })))
  },

  async snooze(accountId, ids, until) {
    const destinationId = await snoozeFolderId(accountId, true)
    const value = new Date(until).toISOString()
    await batch(accountId, ids.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: { singleValueExtendedProperties: [{ id: SNOOZE_PROP, value }] } })))
    await batch(accountId, ids.map((id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId } })))
  },

  async unsnooze(accountId, ids) {
    await batch(
      accountId,
      ids.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: { isRead: false, singleValueExtendedProperties: [{ id: SNOOZE_PROP, value: '' }] } })),
    )
    await batch(accountId, ids.map((id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId: 'inbox' } })))
  },

  async folders(accountId) {
    type GFolder = { id: string; displayName: string; childFolderCount?: number; unreadItemCount?: number }
    const [special, hidden, snoozed] = await Promise.all([specialFolderIds(accountId), hiddenFolderIds(accountId), snoozeFolderId(accountId, false).catch(() => undefined)])
    const out: MailFolder[] = []
    // Walks the whole tree. Sub-folders of system folders (e.g. Inbox > Projects) are shown with
    // the parent's name as a prefix; the system folders themselves are not listed.
    const walk = async (path: string, depth: number, prefix: string) => {
      const page = await graph<GraphPage<GFolder>>(accountId, `${path}?$top=250&$select=id,displayName,childFolderCount,unreadItemCount`)
      for (const f of page.value) {
        const system = special.has(f.id) || hidden.has(f.id) || f.id === snoozed
        if (!system) out.push({ id: f.id, name: prefix + f.displayName, depth, unread: f.unreadItemCount ?? 0 })
        if (f.childFolderCount)
          await walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders`, system ? depth : depth + 1, system && !hidden.has(f.id) ? `${f.displayName} › ` : '')
      }
    }
    await walk('/me/mailFolders', 0, '')
    return out
  },

  async unreadCount(accountId, folder) {
    if (folder === 'starred') return 0
    if (folder === 'snoozed' || folder === 'scheduled') return 0
    const f = await graph<{ unreadItemCount?: number }>(accountId, `/me/mailFolders/${wellKnown[folder]}?$select=unreadItemCount`)
    return f.unreadItemCount ?? 0
  },

  async attachments(accountId, messageId) {
    const page = await graph<GraphPage<GAttachment>>(
      accountId,
      `/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
    )
    return page.value.map(toAttachment)
  },

  async downloadAttachment(accountId, messageId, attachmentId) {
    const res = await graph<Response>(accountId, `/me/messages/${messageId}/attachments/${attachmentId}/$value`, { raw: true })
    return res.blob()
  },

  async inlineImages(accountId, messageId) {
    const page = await graph<GraphPage<GAttachment>>(
      accountId,
      `/me/messages/${messageId}/attachments?$filter=isInline eq true`,
      { quiet: true },
    )
    const map = new Map<string, Blob>()
    for (const a of page.value) {
      if (!a.contentId || !a.contentBytes) continue
      const bin = atob(a.contentBytes)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      map.set(a.contentId.replace(/^<|>$/g, ''), new Blob([bytes], { type: a.contentType ?? 'application/octet-stream' }))
    }
    return map
  },

  async createDraft(accountId, content, replyTo) {
    if (!replyTo) {
      const m = await graph<GMessage>(accountId, '/me/messages', {
        method: 'POST',
        body: {
          subject: content.subject,
          body: { contentType: 'HTML', content: content.html },
          toRecipients: toRecipients(content.to),
          ccRecipients: toRecipients(content.cc),
          bccRecipients: toRecipients(content.bcc),
        },
      })
      return { id: m.id, quotedHtml: '', content }
    }
    const action = replyTo.kind === 'reply' ? 'createReply' : replyTo.kind === 'replyAll' ? 'createReplyAll' : 'createForward'
    const d = await graph<GMessage>(accountId, `/me/messages/${replyTo.messageId}/${action}`, {
      method: 'POST',
      body: {},
      headers: HTML_BODY,
    })
    const prefilled: DraftContent = {
      to: addrs(d.toRecipients),
      cc: addrs(d.ccRecipients),
      bcc: addrs(d.bccRecipients),
      subject: d.subject ?? '',
      html: content.html,
    }
    return { id: d.id, quotedHtml: d.body?.content ?? '', content: prefilled }
  },

  async updateDraft(accountId, draft: DraftRef, content) {
    const html = draft.quotedHtml ? insertIntoBody(draft.quotedHtml, content.html) : content.html
    await graph(accountId, `/me/messages/${draft.id}`, {
      method: 'PATCH',
      body: {
        subject: content.subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: toRecipients(content.to),
        ccRecipients: toRecipients(content.cc),
        bccRecipients: toRecipients(content.bcc),
      },
    })
  },

  async addAttachment(accountId, draftId, file, onProgress) {
    const SMALL = 3 * 1024 * 1024
    if (file.size < SMALL) {
      await graph(accountId, `/me/messages/${draftId}/attachments`, {
        method: 'POST',
        body: {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          contentBytes: await fileToBase64(file),
        },
      })
      onProgress?.(1)
    } else {
      const session = await graph<{ uploadUrl: string }>(accountId, `/me/messages/${draftId}/attachments/createUploadSession`, {
        method: 'POST',
        body: { AttachmentItem: { attachmentType: 'file', name: file.name, size: file.size, contentType: file.type || undefined } },
      })
      const CHUNK = 320 * 1024 * 12 // ~3.75 MB, a multiple of 320 KiB as Graph requires
      for (let start = 0; start < file.size; start += CHUNK) {
        const end = Math.min(start + CHUNK, file.size)
        let res: Response
        try {
          // The upload URL is pre-authenticated: no Authorization header.
          res = await fetch(session.uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` },
            body: file.slice(start, end),
          })
        } catch {
          throw new ApiError('Network error while uploading the attachment', 0)
        }
        if (!res.ok) throw new ApiError(`Attachment upload failed (${res.status})`, res.status)
        onProgress?.(end / file.size)
      }
    }
    return outlook.attachments(accountId, draftId)
  },

  async removeAttachment(accountId, draftId, attachmentId) {
    await graph(accountId, `/me/messages/${draftId}/attachments/${attachmentId}`, { method: 'DELETE' })
  },

  async sendDraft(accountId, draftId) {
    // Graph answers 202 Accepted once the message has been accepted for delivery.
    await graph(accountId, `/me/messages/${draftId}/send`, { method: 'POST' })
  },

  async deleteDraft(accountId, draftId) {
    await graph(accountId, `/me/messages/${draftId}`, { method: 'DELETE' })
  },

  sendsScheduledItself: true,

  async scheduleDraft(accountId, draftId, at) {
    // A message already waiting in the Outbox goes back to Drafts first, to take the new time.
    const m = await graph<{ id: string; isDraft?: boolean }>(accountId, `/me/messages/${draftId}?$select=id,isDraft`)
    const id = m.isDraft === false ? await outlook.unschedule(accountId, draftId) : draftId
    await graph(accountId, `/me/messages/${id}`, {
      method: 'PATCH',
      body: { singleValueExtendedProperties: [{ id: DEFERRED_PROP, value: new Date(at).toISOString() }] },
    })
    await graph(accountId, `/me/messages/${id}/send`, { method: 'POST' })
  },

  async unschedule(accountId, id) {
    const moved = await graph<{ id: string }>(accountId, `/me/messages/${id}/move`, { method: 'POST', body: { destinationId: 'drafts' } })
    return moved.id
  },

  async sendScheduled() {
    // Exchange sends it at the time by itself.
  },

  async loadDraft(accountId, draftId) {
    const [m, attachments] = await Promise.all([
      graph<GMessage>(accountId, `/me/messages/${draftId}?$select=${FULL_FIELDS}`, { headers: HTML_BODY }),
      outlook.attachments(accountId, draftId),
    ])
    return {
      content: {
        to: addrs(m.toRecipients),
        cc: addrs(m.ccRecipients),
        bcc: addrs(m.bccRecipients),
        subject: m.subject ?? '',
        html: m.body?.content ?? '',
      },
      attachments: attachments.filter((a) => !a.isInline),
    }
  },
}

export type { ReplyKind }
