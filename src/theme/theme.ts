import {
  argbFromHex,
  hexFromArgb,
  Hct,
  MaterialDynamicColors,
  SchemeTonalSpot,
} from '@material/material-color-utilities'
import type { ThemePref } from '../settings/store'

/** Generates the Material 3 colour roles from a seed colour and writes them as CSS variables. */
export function buildColorVars(seedHex: string, dark: boolean): Record<string, string> {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seedHex)), dark, 0)
  const out: Record<string, string> = {}
  for (const color of new MaterialDynamicColors().allColors) {
    const name = color.name.replace(/_/g, '-')
    out[`--md-sys-color-${name}`] = hexFromArgb(color.getArgb(scheme))
  }
  return out
}

const styleId = 'md-theme-vars'

export function applyTheme(seedHex: string, pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const vars = buildColorVars(seedHex, dark)
  const css = `:root{color-scheme:${dark ? 'dark' : 'light'};${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`
  // A <style> element created from script is allowed by CSP ('self' + 'unsafe-inline' for styles).
  let el = document.getElementById(styleId) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = styleId
    document.head.appendChild(el)
  }
  el.textContent = css
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--md-sys-color-surface'] ?? '#ffffff')
}
