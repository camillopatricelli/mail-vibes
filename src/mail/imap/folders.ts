import type { SpecialFolder } from '../../settings/store'
import { asList, asText, decodeMailboxName, type ImapResponse } from './parse'

export interface ListedFolder {
  /** The mailbox path as the server knows it (modified UTF-7) */
  path: string
  /** The last part of the name, readable */
  name: string
  delimiter: string | null
  flags: string[]
  /** Nesting level for display (folders under INBOX on "INBOX." servers count from 0) */
  depth: number
  selectable: boolean
}

/** Parses LIST responses. */
export function parseList(responses: ImapResponse[]): ListedFolder[] {
  const raw = responses
    .filter((r) => r.type === 'LIST')
    .map((r) => ({
      flags: asList(r.values[0]).map((f) => asText(f)),
      delimiter: r.values[1] == null ? null : asText(r.values[1]),
      path: asText(r.values[2]),
    }))
  // Some servers keep every folder under "INBOX." (or "INBOX/"); don't indent them all.
  const delim = raw.find((f) => f.delimiter)?.delimiter ?? null
  const others = raw.filter((f) => f.path.toUpperCase() !== 'INBOX')
  const underInbox = !!delim && others.length > 0 && others.every((f) => f.path.toUpperCase().startsWith(`INBOX${delim}`))
  return raw.map((f) => {
    const segments = f.delimiter ? f.path.split(f.delimiter) : [f.path]
    const flagsLower = f.flags.map((x) => x.toLowerCase())
    return {
      path: f.path,
      name: decodeMailboxName(segments[segments.length - 1] || f.path),
      delimiter: f.delimiter,
      flags: f.flags,
      depth: Math.max(0, segments.length - 1 - (underInbox && f.path.toUpperCase() !== 'INBOX' ? 1 : 0)),
      selectable: !flagsLower.includes('\\noselect') && !flagsLower.includes('\\nonexistent'),
    }
  })
}

const SPECIAL_USE: Record<string, SpecialFolder> = {
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'spam',
  '\\archive': 'archive',
}

/** Common names, for servers that don't mark special folders (lower case, readable). */
const NAMES: Record<SpecialFolder, string[]> = {
  sent: ['sent', 'sent items', 'sent messages', 'sent mail', 'posta inviata', 'inviata', 'inviati', 'elementi inviati', 'gesendet', 'gesendete elemente', 'envoyés', 'éléments envoyés', 'enviados'],
  drafts: ['drafts', 'draft', 'bozze', 'entwürfe', 'brouillons', 'borradores'],
  trash: ['trash', 'deleted', 'deleted items', 'deleted messages', 'cestino', 'posta eliminata', 'elementi eliminati', 'papierkorb', 'gelöschte elemente', 'corbeille', 'papelera'],
  spam: ['junk', 'junk e-mail', 'junk email', 'spam', 'posta indesiderata', 'indesiderata', 'posta indesiderata', 'courrier indésirable'],
  archive: ['archive', 'archives', 'archivio', 'archiv'],
}

/**
 * Finds the special folders: chosen by hand first, then marked by the server (SPECIAL-USE),
 * then by common names. Answers mailbox paths.
 */
export function detectSpecial(folders: ListedFolder[], chosen: Partial<Record<SpecialFolder, string>> = {}): Partial<Record<SpecialFolder, string>> {
  const out: Partial<Record<SpecialFolder, string>> = {}
  const exists = new Set(folders.filter((f) => f.selectable).map((f) => f.path))
  for (const [k, path] of Object.entries(chosen) as [SpecialFolder, string][]) if (exists.has(path)) out[k] = path
  for (const f of folders) {
    if (!f.selectable) continue
    for (const flag of f.flags) {
      const kind = SPECIAL_USE[flag.toLowerCase()]
      if (kind && !out[kind]) out[kind] = f.path
    }
  }
  for (const kind of Object.keys(NAMES) as SpecialFolder[]) {
    if (out[kind]) continue
    // Prefer top-level (or directly under INBOX) folders over deeper ones with the same name.
    const match = folders
      .filter((f) => f.selectable && NAMES[kind].includes(f.name.toLowerCase()))
      .sort((a, b) => a.depth - b.depth)[0]
    if (match) out[kind] = match.path
  }
  return out
}

export const isInbox = (path: string) => path.toUpperCase() === 'INBOX'

/** A readable full name: decoded, without a leading "INBOX." on servers that keep everything there, parts joined by " / ". */
export function folderLabel(path: string, delimiter: string | null): string {
  if (isInbox(path) || !delimiter) return decodeMailboxName(path)
  let parts = path.split(delimiter)
  if (parts.length > 1 && isInbox(parts[0])) parts = parts.slice(1)
  return parts.map(decodeMailboxName).join(' / ')
}
