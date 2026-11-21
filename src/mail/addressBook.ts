import { useSyncExternalStore } from 'react'
import type { Address } from './types'

/** A contact: an address, plus where to open it in Google Contacts or Outlook. */
export interface Contact extends Address {
  url?: string
}

/**
 * Recipient suggestions: the contacts of every account first, then addresses seen in loaded
 * mail. In memory only, never persisted.
 */
const book = new Map<string, Address>()
const contactsByAccount = new Map<string, Contact[]>()
let contacts = new Map<string, Contact>()
let preferredAccount: string | undefined

// Components showing names re-render when the contacts change (see useContactsVersion).
let version = 0
const listeners = new Set<() => void>()

/** Replaces one account's contacts. `preferred` (the default contacts account) wins on duplicates. */
export function setContacts(accountId: string, list: Contact[], preferred?: string) {
  contactsByAccount.set(accountId, list)
  if (preferred !== undefined) preferredAccount = preferred
  const next = new Map<string, Contact>()
  const order = [...contactsByAccount.keys()].sort((a, b) => Number(b === preferredAccount) - Number(a === preferredAccount))
  for (const id of order)
    for (const a of contactsByAccount.get(id) ?? []) {
      const k = a.email.toLowerCase()
      const prev = next.get(k)
      if (!prev) next.set(k, { name: a.name, email: a.email, url: a.url })
      else if (!prev.name && a.name) next.set(k, { ...prev, name: a.name })
    }
  contacts = next
  version++
  listeners.forEach((l) => l())
}

export const isContact = (email: string) => contacts.has(email.toLowerCase())
export const contactOf = (email: string): Contact | undefined => contacts.get(email.toLowerCase())
/** The name saved in the user's contacts for this address, if any. */
export const contactName = (email: string) => contacts.get(email.toLowerCase())?.name || undefined

/** Subscribes a component to contact changes (names shown in the app follow the contacts). */
export function useContactsVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
  )
}

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
  const matches = (a: Address) => a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
  // Names or addresses that start with the text come before other matches.
  const starts = (a: Address) => a.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || a.email.toLowerCase().startsWith(q)
  for (const source of [contacts, book]) {
    const found = [...source.values()].filter((a) => !ex.has(a.email.toLowerCase()) && matches(a) && !out.some((o) => o.email.toLowerCase() === a.email.toLowerCase()))
    found.sort((a, b) => Number(starts(b)) - Number(starts(a)))
    out.push(...found)
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
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
