import type { Address } from './types'

/** Small RFC 5322 / MIME helpers for Gmail (which reads and writes raw messages). */

export interface MimeAttachment {
  name: string
  contentType: string
  blob: Blob
  /** Set for inline images referenced as cid: in the HTML body */
  contentId?: string
}

export interface MimeMessage {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  attachments: MimeAttachment[]
}

const ASCII = /^[\x20-\x7e]*$/

function bytesToBase64(bytes: Uint8Array) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n')

/** RFC 2047 encoded words, split so that no word exceeds the length limit or splits a character. */
export function encodeWord(text: string) {
  if (ASCII.test(text)) return text
  const enc = new TextEncoder()
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    if (enc.encode(chunk + ch).length > 42) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(enc.encode(w))}?=`).join('\r\n ')
}

export function formatMimeAddress(a: Address) {
  if (!a.name || a.name === a.email) return a.email
  const name = ASCII.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : encodeWord(a.name)
  return `${name} <${a.email}>`
}

const list = (as: Address[]) => as.map(formatMimeAddress).join(', ')

function quotedParam(value: string) {
  return ASCII.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : `"${encodeWord(value).replace(/\r\n /g, ' ')}"`
}

/** Plain-text alternative of an HTML body, keeping paragraph and line breaks. */
export function htmlToPlain(html: string) {
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '$&\n'),
    'text/html',
  )
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

const boundary = () => `mv_${crypto.randomUUID().replace(/-/g, '')}`

/** Builds the raw message (CRLF line endings, 7-bit safe). */
export async function buildMime(m: MimeMessage): Promise<Blob> {
  const enc = new TextEncoder()
  const headers = [
    `From: ${formatMimeAddress(m.from)}`,
    m.to.length ? `To: ${list(m.to)}` : '',
    m.cc.length ? `Cc: ${list(m.cc)}` : '',
    m.bcc.length ? `Bcc: ${list(m.bcc)}` : '',
    `Subject: ${encodeWord(m.subject)}`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : '',
    m.references ? `References: ${m.references}` : '',
    'MIME-Version: 1.0',
  ].filter(Boolean)

  const textPart = (type: string, body: string) =>
    `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(bytesToBase64(enc.encode(body)))}`

  const altB = boundary()
  const alternative =
    `Content-Type: multipart/alternative; boundary="${altB}"\r\n\r\n` +
    `--${altB}\r\n${textPart('text/plain', htmlToPlain(m.html))}` +
    `--${altB}\r\n${textPart('text/html', m.html)}` +
    `--${altB}--\r\n`

  const filePart = async (a: MimeAttachment) =>
    `Content-Type: ${a.contentType || 'application/octet-stream'}; name=${quotedParam(a.name)}\r\n` +
    `Content-Disposition: ${a.contentId ? 'inline' : 'attachment'}; filename=${quotedParam(a.name)}\r\n` +
    (a.contentId ? `Content-ID: <${a.contentId}>\r\n` : '') +
    `Content-Transfer-Encoding: base64\r\n\r\n${wrap76(await blobToBase64(a.blob))}`

  const inline = m.attachments.filter((a) => a.contentId)
  const files = m.attachments.filter((a) => !a.contentId)

  let body = alternative
  if (inline.length) {
    const relB = boundary()
    const parts = await Promise.all(inline.map(filePart))
    body =
      `Content-Type: multipart/related; boundary="${relB}"\r\n\r\n--${relB}\r\n${alternative}` +
      parts.map((p) => `--${relB}\r\n${p}`).join('') +
      `--${relB}--\r\n`
  }
  if (files.length) {
    const mixB = boundary()
    const parts = await Promise.all(files.map(filePart))
    body =
      `Content-Type: multipart/mixed; boundary="${mixB}"\r\n\r\n--${mixB}\r\n${body}` +
      parts.map((p) => `--${mixB}\r\n${p}`).join('') +
      `--${mixB}--\r\n`
  }
  return new Blob([headers.join('\r\n') + '\r\n' + body], { type: 'message/rfc822' })
}

/** Decodes Gmail's base64url part data using the part's charset. */
export function decodeBase64Url(data: string): Uint8Array {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function decodeText(bytes: Uint8Array, charset?: string) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Parses an address header value ("A <a@x>, "B, C" <b@x>, c@x"). */
export function parseAddressHeader(value: string | undefined): Address[] {
  if (!value) return []
  const out: Address[] = []
  let cur = ''
  let quote = false
  let angle = false
  const push = () => {
    const s = cur.trim()
    cur = ''
    if (!s) return
    const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(s)
    if (m) out.push({ name: m[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'), email: m[2].trim() })
    else if (s.includes('@')) out.push({ name: '', email: s })
  }
  for (const ch of value) {
    if (ch === '"') quote = !quote
    else if (ch === '<' && !quote) angle = true
    else if (ch === '>' && !quote) angle = false
    if (ch === ',' && !quote && !angle) push()
    else cur += ch
  }
  push()
  return out
}
