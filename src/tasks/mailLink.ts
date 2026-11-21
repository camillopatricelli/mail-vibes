import type { Provider } from '../settings/store'

/**
 * The email a task was created from. Recognised from:
 * - Google Tasks "links" (tasks created from Gmail), read-only in the API
 * - Microsoft To Do "linkedResources" (flagged emails, tasks created from Outlook or this app)
 * - a Gmail or Outlook web address in the task notes (how this app links Google tasks)
 */
export interface MailLink {
  provider: Provider
  /** Candidate message or thread ids, most likely first (may be empty: web address only) */
  ids: string[]
  url?: string
  subject?: string
  /** Mailbox address, if the link names one */
  email?: string
}

const URL_RE = /https?:\/\/[^\s<>"']+/g

/** Outlook on the web uses EWS ids; Graph uses the same bytes in URL-safe base64. */
const restId = (ewsId: string) => ewsId.replace(/\//g, '-').replace(/\+/g, '_')

export function parseMailUrl(raw: string): MailLink | undefined {
  let u: URL
  try {
    u = new URL(raw.replace(/[).,;]+$/, ''))
  } catch {
    return undefined
  }
  if (u.hostname === 'mail.google.com' && u.pathname.startsWith('/mail')) {
    if (!u.hash.includes('/')) return undefined
    const last = u.hash.split('/').pop() ?? ''
    const user = decodeURIComponent(/\/mail\/u\/([^/]+)/.exec(u.pathname)?.[1] ?? '')
    // Only the legacy hexadecimal ids are API ids; newer opaque ones open on the web only.
    const ids = /^[0-9a-f]{12,20}$/i.test(last) ? [last.toLowerCase()] : []
    return { provider: 'google', ids, url: u.href, email: user.includes('@') ? user : undefined }
  }
  if (/^outlook\.(office365|office|live)\.com$/.test(u.hostname)) {
    const itemId = u.searchParams.get('ItemID') ?? u.searchParams.get('itemid')
    const pathId = /\/(?:id|read)\/([^/?#]+)/.exec(u.pathname)?.[1]
    const id = itemId ?? (pathId ? decodeURIComponent(pathId) : undefined)
    if (!id) return undefined
    return { provider: 'microsoft', ids: [...new Set([restId(id), id])], url: u.href }
  }
  return undefined
}

/** The first mail link in some text (task notes). */
export function findMailUrl(text: string | undefined): MailLink | undefined {
  for (const m of text?.match(URL_RE) ?? []) {
    const l = parseMailUrl(m)
    if (l) return l
  }
  return undefined
}

/** Notes without the lines that only carry a mail link (shown as a chip instead). */
export function notesWithoutMail(notes: string) {
  return notes
    .split('\n')
    .filter((line) => !(line.match(URL_RE) ?? []).some((m) => parseMailUrl(m)))
    .join('\n')
    .trim()
}

/** The link of a newly created task (until the next refresh reads it back). */
export const linkOf = (m: MailSource): MailLink => ({ provider: m.provider, ids: [m.id], url: m.url, subject: m.subject })

/** The line appended to the notes of a task whose provider cannot store a link. */
export const mailNoteLine = (subject: string, url: string) => `✉ ${subject ? subject + ' ' : ''}${url}`

/** What a provider needs to link a new task to an email. */
export interface MailSource {
  provider: Provider
  /** Gmail thread id or Outlook message id */
  id: string
  subject: string
  url: string
}
