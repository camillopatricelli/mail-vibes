import type { Address } from './types'

/**
 * In-memory list of addresses seen in loaded mail, used for recipient suggestions until the
 * contacts source arrives (phase 5). Never persisted.
 */
const book = new Map<string, Address>()

export function rememberAddresses(list: Address[]) {
  for (const a of list) {
    if (!a.email) continue
    const k = a.email.toLowerCase()
    const prev = book.get(k)
    if (!prev || (!prev.name && a.name)) book.set(k, { name: a.name, email: a.email })
  }
}

export function suggestAddresses(query: string, exclude: Address[], limit = 8): Address[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const ex = new Set(exclude.map((a) => a.email.toLowerCase()))
  const out: Address[] = []
  for (const a of book.values()) {
    if (ex.has(a.email.toLowerCase())) continue
    if (a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) out.push(a)
    if (out.length >= limit) break
  }
  return out
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/

export function isValidEmail(s: string) {
  return EMAIL.test(s.trim())
}

/** Parses "Name <a@b.c>, d@e.f; ..." into addresses. Invalid entries keep their text as email. */
export function parseAddresses(input: string): Address[] {
  const out: Address[] = []
  // Split on commas/semicolons that are not inside quotes or angle brackets.
  let cur = ''
  let quote = false
  let angle = false
  const push = () => {
    const s = cur.trim()
    cur = ''
    if (!s) return
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s)
    if (m) out.push({ name: m[1].trim(), email: m[2].trim() })
    else out.push({ name: '', email: s.replace(/^mailto:/i, '') })
  }
  for (const ch of input) {
    if (ch === '"') quote = !quote
    if (ch === '<') angle = true
    if (ch === '>') angle = false
    if ((ch === ',' || ch === ';' || ch === '\n') && !quote && !angle) push()
    else cur += ch
  }
  push()
  return out
}

export function formatAddress(a: Address) {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email
}
