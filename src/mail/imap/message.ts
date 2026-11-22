import PostalMime, { type Address as PmAddress } from 'postal-mime'
import { escapeHtml } from '../html'
import type { Address, Attachment } from '../types'

export interface ParsedAttachment {
  meta: Attachment
  blob: Blob
  /** Content-ID without brackets, for cid: images */
  contentId?: string
}

export interface ParsedMessage {
  subject: string
  from?: Address
  to: Address[]
  /** The Date header (0 if missing) */
  date: number
  bodyHtml: string
  bodyIsHtml: boolean
  /** Plain text start, for previews */
  snippet: string
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  attachments: ParsedAttachment[]
  /** All headers, lower-case names (first value wins), e.g. for PEC detection */
  headers: Map<string, string>
}

function addresses(list: PmAddress[] | PmAddress | undefined): Address[] {
  const out: Address[] = []
  for (const a of Array.isArray(list) ? list : list ? [list] : []) {
    if (a.group) out.push(...addresses(a.group))
    else if (a.address) out.push({ name: a.name ?? '', email: a.address })
  }
  return out
}

const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200)

/** Parses a whole message (RFC 5322 bytes). Forwarded messages (message/rfc822) stay attachments. */
export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw, { forceRfc822Attachments: true })
  const headers = new Map<string, string>()
  for (const h of email.headers) if (!headers.has(h.key)) headers.set(h.key, h.value)
  const text = email.text ?? ''
  const attachments = email.attachments.map((a, i): ParsedAttachment => {
    const contentId = a.contentId?.replace(/^<|>$/g, '').trim() || undefined
    const type = (a.mimeType || 'application/octet-stream').split(';')[0].trim()
    const content = a.content as ArrayBuffer | Uint8Array | string
    const blob = new Blob([typeof content === 'string' ? content : (content as BlobPart)], { type })
    const isInline = !!contentId && type.startsWith('image/') && (a.disposition !== 'attachment' || !!a.related)
    return {
      meta: {
        id: String(i),
        name: a.filename || (type === 'message/rfc822' ? 'message.eml' : 'attachment'),
        contentType: type,
        size: blob.size,
        isInline,
      },
      blob,
      contentId,
    }
  })
  return {
    subject: email.subject ?? '',
    from: addresses(email.from)[0],
    to: addresses(email.to),
    date: (email.date && Date.parse(email.date)) || 0,
    bodyHtml: email.html ?? `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(text)}</pre>`,
    bodyIsHtml: !!email.html,
    snippet: snippetOf(text || (email.html ?? '').replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    replyTo: addresses(email.replyTo),
    attachments,
    headers,
  }
}
