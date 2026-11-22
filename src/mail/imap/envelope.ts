import { decodeWords } from 'postal-mime'
import type { Address } from '../types'
import { asList, asText, type ImapValue } from './parse'
import { pecHeaders, type PecHeaders } from './pec'

/** What the message lists need from FETCH, without downloading the message. */
export const SUMMARY_ITEMS = '(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES X-TRASPORTO X-RICEVUTA X-RIFERIMENTO-MESSAGE-ID)])'

export interface FetchedSummary {
  uid: number
  flags: string[]
  /** INTERNALDATE: when the message arrived in the mailbox */
  date: number
  size: number
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  messageId?: string
  inReplyTo?: string
  references: string[]
  hasAttachments: boolean
  /** PEC envelope or receipt headers, if any */
  pec?: PecHeaders
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Parses an IMAP INTERNALDATE ("17-Jul-1996 02:44:25 -0700"); 0 if unreadable. */
export function parseInternalDate(s: string): number {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/.exec(s)
  if (!m) return Date.parse(s) || 0
  const month = MONTHS.indexOf(m[2].toLowerCase())
  if (month < 0) return 0
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000
  return m[7] === '+' ? utc - offset : utc + offset
}

const decode = (v: ImapValue | undefined) => {
  const s = asText(v)
  try {
    return s.includes('=?') ? decodeWords(s) : s
  } catch {
    return s
  }
}

/** ENVELOPE address lists: ((name adl mailbox host) …); groups are marked by a NIL host. */
export function envelopeAddresses(v: ImapValue | undefined): Address[] {
  const out: Address[] = []
  for (const a of asList(v)) {
    const [name, , mailbox, host] = asList(a)
    if (host == null || mailbox == null) continue
    out.push({ name: decode(name).trim(), email: `${asText(mailbox)}@${asText(host)}` })
  }
  return out
}

/** Message-IDs in a header value ("<a@x> <b@y>"), in order. */
export const messageIds = (v: string | undefined) => (v ?? '').match(/<[^<>\s]+>/g) ?? []

/**
 * The thread a message belongs to: the first id of References, else In-Reply-To, else (PEC
 * receipts) the message the receipt is about, else its own id.
 */
export const threadRoot = (s: Pick<FetchedSummary, 'references' | 'inReplyTo' | 'messageId' | 'pec'>) =>
  s.references[0] ?? messageIds(s.inReplyTo)[0] ?? s.pec?.riferimento ?? s.messageId

/**
 * Whether a BODYSTRUCTURE has real attachments: a part with an attachment disposition, or a
 * named non-text part. (Inline images in multipart/related don't count.)
 */
export function hasAttachments(bs: ImapValue | undefined): boolean {
  const list = asList(bs)
  if (!list.length) return false
  if (Array.isArray(list[0])) {
    // multipart: (part part … "SUBTYPE" params disposition …)
    let i = 0
    const parts: ImapValue[] = []
    while (Array.isArray(list[i])) parts.push(list[i++])
    const subtype = asText(list[i]).toUpperCase()
    if (subtype === 'RELATED') return hasAttachments(parts[0])
    return parts.some(hasAttachments)
  }
  const type = asText(list[0]).toUpperCase()
  // Basic fields: type subtype params id description encoding size; then text/message extras,
  // then md5, disposition. Find the disposition list ("ATTACHMENT" (params)) anywhere after.
  for (const v of list.slice(7)) {
    if (Array.isArray(v) && asText(v[0]).toUpperCase() === 'ATTACHMENT') return true
  }
  const params = asList(list[2]).map((x) => asText(x).toUpperCase())
  const named = params.includes('NAME')
  if (type === 'MESSAGE') return true // a forwarded message, e.g. a PEC envelope's postacert.eml
  return named && type !== 'TEXT'
}

/** Builds a summary from the attributes of a FETCH response (see SUMMARY_ITEMS). */
export function parseSummary(attrs: Map<string, ImapValue>): FetchedSummary {
  const env = asList(attrs.get('ENVELOPE'))
  const refsKey = [...attrs.keys()].find((k) => k.startsWith('BODY[HEADER.FIELDS'))
  const refsHeader = refsKey ? asText(attrs.get(refsKey)).replace(/\r?\n[ \t]+/g, ' ') : ''
  const references = messageIds(/^references:(.*)$/im.exec(refsHeader)?.[1])
  const from = envelopeAddresses(env[2])
  return {
    uid: Number(asText(attrs.get('UID'))),
    flags: asList(attrs.get('FLAGS')).map(asText),
    date: parseInternalDate(asText(attrs.get('INTERNALDATE'))) || Date.parse(asText(env[0])) || 0,
    size: Number(asText(attrs.get('RFC822.SIZE'))) || 0,
    subject: decode(env[1]),
    from: from[0] ?? envelopeAddresses(env[3])[0] ?? { name: '', email: '' },
    to: envelopeAddresses(env[5]),
    cc: envelopeAddresses(env[6]),
    replyTo: envelopeAddresses(env[4]),
    inReplyTo: asText(env[8]) || undefined,
    messageId: messageIds(asText(env[9]))[0],
    references,
    pec: pecHeaders(refsHeader),
    hasAttachments: hasAttachments(attrs.get('BODYSTRUCTURE')),
  }
}

export const isSeen = (flags: string[]) => flags.some((f) => f.toLowerCase() === '\\seen')
export const isFlagged = (flags: string[]) => flags.some((f) => f.toLowerCase() === '\\flagged')
export const isDeleted = (flags: string[]) => flags.some((f) => f.toLowerCase() === '\\deleted')
export const isDraftFlag = (flags: string[]) => flags.some((f) => f.toLowerCase() === '\\draft')
