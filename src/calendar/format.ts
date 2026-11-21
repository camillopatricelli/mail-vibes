import i18n from '../i18n'
import { addDays, sameDay, type View } from './dates'

/** The app language, with the browser's regional formats when they match (en-GB: 24-hour clock). */
export function dateLocale() {
  const lang = i18n.language || 'en'
  const browser = typeof navigator !== 'undefined' ? navigator.languages?.find((l) => l.split('-')[0] === lang) : undefined
  return browser ?? lang
}

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(dateLocale(), o)

export const timeOf = (t: number) => fmt({ hour: 'numeric', minute: '2-digit' }).format(t)
export const hourLabel = (t: number) => fmt({ hour: 'numeric' }).format(t)
export const weekdayShort = (t: number) => fmt({ weekday: 'short' }).format(t)
export const dayLong = (t: number) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(t)

/** Toolbar title of a view. */
export function viewTitle(view: View, from: number, to: number, date: number) {
  switch (view) {
    case 'day':
      return fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date)
    case 'month':
      return fmt({ month: 'long', year: 'numeric' }).format(date)
    default:
      return fmt({ day: 'numeric', month: 'short', year: 'numeric' }).formatRange(from, addDays(to, -1))
  }
}

/** "Sat 21 Nov, 09:00 – 10:00", "All day", or a range across days. */
export function eventWhen(e: { start: number; end: number; allDay: boolean }) {
  if (e.allDay) {
    const last = addDays(e.end, -1)
    const d = fmt({ weekday: 'short', day: 'numeric', month: 'short' })
    return sameDay(e.start, last) ? `${d.format(e.start)} · ${i18n.t('calendar.allDay')}` : d.formatRange(e.start, last)
  }
  const full = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  return sameDay(e.start, e.end) ? `${full.format(e.start)} – ${timeOf(e.end)}` : full.formatRange(e.start, e.end)
}
