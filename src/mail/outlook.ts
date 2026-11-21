import { graph, ApiError, type GraphPage } from '../providers/graph'
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
  ReplyKind,
} from './types'
import { escapeHtml, insertIntoBody } from './html'

/** Outlook mail via Microsoft Graph. */

interface GRecipient {
  emailAddress?: { name?: string; address?: string }
}
interface GMessage {
  id: string
  conversationId: string
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

const wellKnown: Record<Exclude<FolderKind, 'starred'>, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  archive: 'archive',
  trash: 'deleteditems',
  spam: 'junkemail',
}

const SUMMARY_FIELDS =
  'id,conversationId,subject,bodyPreview,from,sender,toRecipients,receivedDateTime,sentDateTime,isRead,isDraft,flag,hasAttachments'
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
  }
}

// Well-known folder ids per account, as folderId -> kind (to know where each thread message is).
const folderIdCache = new Map<string, Promise<Map<string, Exclude<FolderKind, 'starred'>>>>()
function specialFolderIds(accountId: string) {
  let p = folderIdCache.get(accountId)
  if (!p) {
    p = (async () => {
      const out = new Map<string, Exclude<FolderKind, 'starred'>>()
      await Promise.all(
        (Object.entries(wellKnown) as [Exclude<FolderKind, 'starred'>, string][]).map(async ([kind, wk]) => {
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
    const path =
      target === 'starred'
        ? `/me/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'&$orderby=receivedDateTime desc`
        : `/me/mailFolders/${typeof target === 'string' ? wellKnown[target] : encodeURIComponent(target.folderId)}/messages?$orderby=receivedDateTime desc`
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
        `/me/messages?$filter=conversationId eq '${threadId.replace(/'/g, "''")}'&$top=200&$select=${FULL_FIELDS}`,
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

  async move(accountId, ids, dest) {
    const destinationId = typeof dest === 'string' ? (dest === 'starred' ? 'inbox' : wellKnown[dest]) : dest.folderId
    await batch(accountId, ids.map((id) => ({ method: 'POST', url: `/me/messages/${id}/move`, body: { destinationId } })))
  },

  async deleteForever(accountId, ids) {
    await batch(accountId, ids.map((id) => ({ method: 'DELETE', url: `/me/messages/${id}` })))
  },

  async folders(accountId) {
    type GFolder = { id: string; displayName: string; childFolderCount?: number; unreadItemCount?: number }
    const [special, hidden] = await Promise.all([specialFolderIds(accountId), hiddenFolderIds(accountId)])
    const out: MailFolder[] = []
    // Walks the whole tree. Sub-folders of system folders (e.g. Inbox > Projects) are shown with
    // the parent's name as a prefix; the system folders themselves are not listed.
    const walk = async (path: string, depth: number, prefix: string) => {
      const page = await graph<GraphPage<GFolder>>(accountId, `${path}?$top=250&$select=id,displayName,childFolderCount,unreadItemCount`)
      for (const f of page.value) {
        const system = special.has(f.id) || hidden.has(f.id)
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
