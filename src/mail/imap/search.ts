import type { Part } from './client'
import { asText, type ImapResponse } from './parse'

/**
 * IMAP SEARCH criteria from what the user typed in the search box.
 *
 * Words are all required (AND). "Quoted phrases" stay together, and from:, to: and subject:
 * narrow a word to one field (Gmail's syntax, which users of the other accounts already type).
 * Plain words look in the whole message, except on PEC servers, which search slowly: there they
 * look only in the subject and the sender.
 */
export function searchCriteria(q: string, light: boolean): Part[] | undefined {
  const terms: { field?: string; text: string }[] = []
  for (const m of q.matchAll(/(?:(from|to|subject):)?(?:"([^"]*)"|(\S+))/gi)) {
    const text = (m[2] ?? m[3] ?? '').trim()
    if (text) terms.push({ field: m[1]?.toUpperCase(), text })
  }
  if (!terms.length) return undefined
  const parts: Part[] = []
  if (terms.some((t) => /[^\x20-\x7e]/.test(t.text))) parts.push('CHARSET UTF-8 ')
  terms.forEach((t, i) => {
    if (i) parts.push(' ')
    if (t.field) parts.push(`${t.field} `, { str: t.text })
    else if (light) parts.push('OR SUBJECT ', { str: t.text }, ' FROM ', { str: t.text })
    else parts.push('TEXT ', { str: t.text })
  })
  return parts
}

/** "3:5,9" -> [3, 4, 5, 9] */
export function expandUidSet(set: string): number[] {
  const out: number[] = []
  for (const piece of set.split(',')) {
    const [a, b] = piece.split(':').map(Number)
    if (!a) continue
    if (!b) out.push(a)
    else for (let u = Math.min(a, b); u <= Math.max(a, b) && out.length < 100_000; u++) out.push(u)
  }
  return out
}

/**
 * The new UIDs of copied or moved messages, from the server's "[COPYUID validity old new]"
 * (servers with UIDPLUS): old UID -> new UID, plus the destination's UIDVALIDITY.
 */
export function copiedUids(responses: ImapResponse[]): { uidValidity: number; map: Map<number, number> } | undefined {
  const code = responses.find((r) => r.code?.name === 'COPYUID')?.code
  if (!code || code.args.length < 3) return undefined
  const from = expandUidSet(asText(code.args[1]))
  const to = expandUidSet(asText(code.args[2]))
  if (from.length !== to.length) return undefined
  return { uidValidity: Number(asText(code.args[0])) || 0, map: new Map(from.map((u, i) => [u, to[i]])) }
}
