/** Custom links shown under Notes in the navigation (Settings → Shortcuts). */
export interface Shortcut {
  id: string
  name: string
  url: string
}

/** More don't fit the navigation rail on smaller laptop screens. */
export const MAX_SHORTCUTS = 4
export const MAX_NAME = 24

/** A web address as typed ("intranet.example.com/x") → "https://intranet.example.com/x"; other schemes are refused. */
export function normalizeUrl(input: string): string | undefined {
  const s = input.trim()
  if (!s) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return undefined
    return u.href
  } catch {
    return undefined
  }
}

/** Shortcuts from storage or an imported file: only web addresses, named, at most MAX_SHORTCUTS. */
export function parseShortcuts(v: unknown): Shortcut[] {
  if (!Array.isArray(v)) return []
  const out: Shortcut[] = []
  for (const x of v as Partial<Shortcut>[]) {
    if (!x || typeof x.name !== 'string' || typeof x.url !== 'string') continue
    const url = normalizeUrl(x.url)
    const name = x.name.trim().slice(0, MAX_NAME)
    if (!url || !name) continue
    out.push({ id: typeof x.id === 'string' && x.id ? x.id : crypto.randomUUID(), name, url })
    if (out.length === MAX_SHORTCUTS) break
  }
  return out
}

/** The site's own icons, best first: the large one phones use, then the classic favicon. */
export function iconCandidates(url: string): string[] {
  const { origin } = new URL(url)
  return [`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`]
}

const TILE_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#007b83', '#3f51b5', '#e52592']

/** A steady colour for a name's letter tile (the same name always gets the same colour). */
export function tileColor(name: string) {
  let h = 0
  for (const c of name.toLowerCase()) h = (h * 31 + c.codePointAt(0)!) >>> 0
  return TILE_COLORS[h % TILE_COLORS.length]
}

/** The tile's letter: the name's first letter or digit. */
export const tileLetter = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
