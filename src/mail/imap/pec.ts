import type { Address, PecDetails } from '../types'
import { parseMessage, type ParsedAttachment, type ParsedMessage } from './message'

/**
 * PEC (Italian certified email). Every message arrives in an envelope from the provider:
 * - a certified message ("X-Trasporto: posta-certificata"): a short text, the original message as
 *   postacert.eml, the certification data as daticert.xml, and the provider's signature;
 * - a receipt ("X-Ricevuta: accettazione", "avvenuta-consegna", …) about a message the user sent,
 *   pointing to it with "X-Riferimento-Message-ID";
 * - a transport error ("X-Trasporto: errore").
 * The app shows the original message, with the certification data in a box.
 */

/** The PEC headers of a message, from the header block fetched with the list. */
export interface PecHeaders {
  trasporto?: string
  ricevuta?: string
  /** The Message-ID a receipt is about */
  riferimento?: string
}

export function pecHeaders(block: string): PecHeaders | undefined {
  const get = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(block)?.[1].trim() || undefined
  const h: PecHeaders = {
    trasporto: get('x-trasporto')?.toLowerCase(),
    ricevuta: get('x-ricevuta')?.toLowerCase(),
    riferimento: /<[^<>\s]+>/.exec(get('x-riferimento-message-id') ?? '')?.[0],
  }
  return h.trasporto || h.ricevuta ? h : undefined
}

export const pecKind = (h: PecHeaders): PecDetails['kind'] => (h.ricevuta ? 'receipt' : h.trasporto === 'errore' ? 'error' : 'message')

/**
 * How a certified message shows in a list: the original sender and subject instead of the
 * provider's ("Per conto di: x@y" <posta-certificata@…>, "POSTA CERTIFICATA: subject").
 */
export function originalSender(from: Address, replyTo: Address[]): Address {
  const m = /^per conto di:?\s*(.+)$/i.exec(from.name)
  const email = m ? m[1].trim().replace(/^<|>$/g, '') : undefined
  if (email && /@/.test(email)) return { name: '', email }
  return replyTo[0] ?? from
}

export const originalSubject = (subject: string) => subject.replace(/^\s*POSTA CERTIFICATA:\s*/i, '')

// ---------- daticert.xml ----------

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e] ?? all),
  )

/** The certification data (only what the app shows). */
export function parseDaticert(xml: string): Omit<PecDetails, 'kind' | 'envelopeAttachmentId'> {
  const text = (tag: string, within = xml) => {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(within)
    return m ? unescapeXml(m[1].replace(/<[^>]+>/g, '')).trim() || undefined : undefined
  }
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`<${tag}\\s[^>]*\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(xml)
    return m ? unescapeXml(m[1]) : undefined
  }
  const recipients = [...xml.matchAll(/<destinatari(?:\s+tipo\s*=\s*"([^"]*)")?[^>]*>([\s\S]*?)<\/destinatari>/gi)].map((m) => ({
    email: unescapeXml(m[2]).trim(),
    certified: (m[1] ?? 'certificato').toLowerCase() === 'certificato',
  }))
  const dataBlock = /<data(?:\s[^>]*)?>[\s\S]*?<\/data>/i.exec(xml)?.[0] ?? ''
  const day = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text('giorno', dataBlock) ?? '')
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text('ora', dataBlock) ?? '')
  const zone = /^([+-])(\d{2}):?(\d{2})$/.exec(attr('data', 'zona') ?? '')
  let date: number | undefined
  if (day && time) {
    const utc = Date.UTC(Number(day[3]), Number(day[2]) - 1, Number(day[1]), Number(time[1]), Number(time[2]), Number(time[3] ?? 0))
    const offset = zone ? (Number(zone[2]) * 60 + Number(zone[3])) * 60_000 * (zone[1] === '+' ? 1 : -1) : 0
    date = utc - offset
  }
  return {
    type: (attr('postacert', 'tipo') ?? 'posta-certificata').toLowerCase(),
    sender: text('mittente'),
    recipients,
    subject: text('oggetto'),
    provider: text('gestore-emittente'),
    date,
    id: text('identificativo'),
    msgid: text('msgid'),
    deliveredTo: text('consegna'),
    error: text('errore-esteso') ?? (attr('postacert', 'errore') && attr('postacert', 'errore') !== 'nessuno' ? attr('postacert', 'errore') : undefined),
  }
}

// ---------- The message as shown ----------

export interface PecView extends ParsedMessage {
  pec: PecDetails
}

const named = (a: ParsedAttachment, name: string) => a.meta.name.toLowerCase() === name

/**
 * A PEC message as the app shows it: for a certified message, the original's body, addresses and
 * attachments; for receipts, the receipt's text. Either way the certification data, and the
 * whole envelope as an .eml attachment (the legal record, to keep or forward as proof).
 */
export async function pecView(raw: Uint8Array, outer: ParsedMessage, h: PecHeaders): Promise<PecView> {
  const kind = pecKind(h)
  const daticert = outer.attachments.find((a) => named(a, 'daticert.xml'))
  const cert = daticert ? parseDaticert(await daticert.blob.text()) : { type: h.ricevuta ?? h.trasporto ?? 'posta-certificata', recipients: [] }
  const postacert = outer.attachments.find((a) => named(a, 'postacert.eml'))
  const proof: ParsedAttachment = {
    meta: {
      id: 'pec-envelope',
      name: `${(originalSubject(outer.subject) || 'PEC').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)} (PEC).eml`,
      contentType: 'message/rfc822',
      size: raw.length,
      isInline: false,
    },
    blob: new Blob([raw as BlobPart], { type: 'message/rfc822' }),
  }
  const pec: PecDetails = { kind, ...cert, envelopeAttachmentId: proof.meta.id }
  const isEnvelopePart = (a: ParsedAttachment) => named(a, 'daticert.xml') || named(a, 'smime.p7s')
  if (kind === 'message' && postacert) {
    const inner = await parseMessage(new Uint8Array(await postacert.blob.arrayBuffer()))
    return { ...inner, attachments: [...inner.attachments, proof], pec }
  }
  return { ...outer, attachments: [...outer.attachments.filter((a) => !isEnvelopePart(a)), proof], pec }
}
