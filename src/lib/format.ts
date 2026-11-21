import i18n from '../i18n'
import { contactName } from '../mail/addressBook'
import type { Address } from '../mail/types'

const locale = () => (i18n.language === 'it' ? 'it-IT' : 'en-GB')

/** Gmail-style list date: time today, "21 Nov" this year, full date otherwise. */
export function listDate(ts: number, now = Date.now()) {
  const d = new Date(ts)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'numeric', year: 'numeric' })
}

export function fullDate(ts: number) {
  return new Date(ts).toLocaleString(locale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** The name to show for an address: from the user's contacts, else from the message, else the address. */
export function displayName(a: Address) {
  return contactName(a.email) || a.name || a.email.split('@')[0] || a.email
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
