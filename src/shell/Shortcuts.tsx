import { useState } from 'react'
import { useSettings } from '../settings/store'
import { iconCandidates, tileColor, tileLetter, type Shortcut } from './shortcutData'

/** Which of a site's icons loaded (or that none did), so other copies don't try again. */
const iconChoice = new Map<string, number>()

/** The site's own icon, or the name's first letter on a coloured tile when it has none. */
export function ShortcutIcon({ s, size = 24 }: { s: Shortcut; size?: number }) {
  const candidates = iconCandidates(s.url)
  const [i, setI] = useState(() => iconChoice.get(s.url) ?? 0)
  const style = { width: size, height: size }
  if (i >= candidates.length)
    return (
      <span className="shortcut-tile" style={{ ...style, background: tileColor(s.name), fontSize: size * 0.55 }} aria-hidden>
        {tileLetter(s.name)}
      </span>
    )
  return (
    <img
      className="shortcut-icon"
      style={style}
      src={candidates[i]}
      alt=""
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        // A 1×1 placeholder isn't an icon.
        if (e.currentTarget.naturalWidth < 8) return next()
        iconChoice.set(s.url, i)
      }}
      onError={() => next()}
    />
  )
  function next() {
    iconChoice.set(s.url, i + 1)
    setI(i + 1)
  }
}

export const openShortcut = (s: Shortcut) => window.open(s.url, '_blank', 'noopener,noreferrer')

/** The shortcuts as navigation-rail items, under Notes. */
export function RailShortcuts() {
  const shortcuts = useSettings((s) => s.shortcuts)
  return shortcuts.map((s) => (
    <a key={s.id} className="rail__item rail__shortcut" href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.name} — ${new URL(s.url).host}`}>
      <span className="rail__indicator">
        <ShortcutIcon s={s} />
      </span>
      <span className="label-medium rail__shortcut-name">{s.name}</span>
    </a>
  ))
}
