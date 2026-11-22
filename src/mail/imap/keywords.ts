import { decodeMailboxName, encodeMailboxName } from './parse'

/**
 * IMAP has no labels. Tags are keywords on the messages (as Thunderbird does: its standard tags
 * are $label1…$label5), and snoozed or scheduled mail waits in folders named after the time,
 * under a "Mail Vibes" folder (like the app's Gmail labels).
 */

// ---------- Tags as keywords ----------

const STANDARD: Record<string, string> = { $label1: 'Important', $label2: 'Work', $label3: 'Personal', $label4: 'To Do', $label5: 'Later' }
const HIDDEN = new Set(['junk', 'nonjunk', 'notjunk', 'forwarded', 'mdnsent'])

/** The tag a keyword stands for; undefined for system flags and other programs' markers. */
export function keywordToTag(keyword: string): string | undefined {
  if (keyword.startsWith('\\')) return undefined
  const standard = STANDARD[keyword.toLowerCase()]
  if (standard) return standard
  if (keyword.startsWith('$') || HIDDEN.has(keyword.toLowerCase())) return undefined
  try {
    return decodeMailboxName(keyword.replace(/_/g, ' '))
  } catch {
    return keyword
  }
}

/** The keyword for a tag: Thunderbird's for its standard tags, else the name made into an atom. */
export function tagToKeyword(name: string): string {
  const standard = Object.entries(STANDARD).find(([, n]) => n.toLowerCase() === name.trim().toLowerCase())
  if (standard) return standard[0]
  // Atoms can't hold spaces or ( ) { % * " \ ]; non-ASCII is written as in mailbox names.
  return encodeMailboxName(name.trim()).replace(/[\s(){%*"\\\]]/g, '_')
}

// ---------- Snoozed and scheduled mail ----------

export const APP_FOLDER = 'Mail Vibes'
export type TimedKind = 'Snoozed' | 'Send later'

/** Where the account's folders live: "INBOX." on servers that keep everything under the Inbox. */
export interface Namespace {
  prefix: string
  delimiter: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local time as a folder name: "2026-11-23 09h00" (no dots or colons, which servers may reserve). */
export function timeStamp(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`
}

export function parseTimeStamp(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})$/.exec(s.trim())
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isNaN(d.getTime()) ? undefined : d.getTime()
}

const appRoot = (ns: Namespace) => `${ns.prefix}${encodeMailboxName(APP_FOLDER)}`

/** e.g. "INBOX.Mail Vibes.Snoozed.2026-11-23 09h00" */
export const timedPath = (ns: Namespace, kind: TimedKind, at: number) =>
  [appRoot(ns), encodeMailboxName(kind), encodeMailboxName(timeStamp(at))].join(ns.delimiter)

/** The time of a folder made by timedPath for this kind, else undefined. */
export function timedFolderTime(path: string, ns: Namespace, kind: TimedKind) {
  const start = `${appRoot(ns)}${ns.delimiter}${encodeMailboxName(kind)}${ns.delimiter}`
  return path.startsWith(start) ? parseTimeStamp(decodeMailboxName(path.slice(start.length))) : undefined
}

/** The app's own folders ("Mail Vibes" and everything in it): hidden from folder lists and searches. */
export const isAppFolder = (path: string, ns: Namespace) => path === appRoot(ns) || path.startsWith(`${appRoot(ns)}${ns.delimiter}`)
