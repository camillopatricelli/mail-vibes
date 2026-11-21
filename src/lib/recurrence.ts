import type { TFunction } from 'i18next'
import { addDays, addMonths, DAY, startOfDay, toDateKey } from '../calendar/dates'

/**
 * Repeat rules for events and tasks, one model for all providers: Google Calendar (RRULE),
 * Microsoft Graph (patternedRecurrence, for Outlook events and To Do tasks) and the line Mail
 * Vibes keeps in Google task notes (RRULE text).
 */

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface Recurrence {
  freq: Freq
  /** Every `interval` days, weeks, months or years */
  interval: number
  /** Weekly: the weekdays (0 = Sunday). Monthly/yearly with `nth`: the weekday (first item). Default: the start's weekday */
  days?: number[]
  /** Monthly/yearly: on the nth weekday of the month (1–4, -1 = last) instead of the same date */
  nth?: number
  /** Last day of the series (local midnight) */
  until?: number
  /** Number of occurrences */
  count?: number
}

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const GRAPH_INDEX: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' }

/** Which weekday of its month a date is: 1–4, or 5 (only in months with five of them). */
export function nthOfMonth(t: number) {
  return Math.ceil(new Date(t).getDate() / 7)
}
/** Whether a date is the last of its weekday in its month. */
export const isLastOfMonth = (t: number) => new Date(addDays(t, 7)).getMonth() !== new Date(t).getMonth()

const daysOf = (r: Recurrence, start: number) => (r.days?.length ? [...r.days].sort((a, b) => a - b) : [new Date(start).getDay()])

/** Rules are the same when they repeat on the same days (defaults spelled out or not). */
export function sameRule(a: Recurrence | null | undefined, b: Recurrence | null | undefined, start: number) {
  if (!a || !b) return !a && !b
  const key = (r: Recurrence) =>
    [r.freq, r.interval, r.freq === 'weekly' || r.nth ? daysOf(r, start).join(',') : '', r.nth ?? '', r.until ?? '', r.count ?? ''].join('|')
  return key(a) === key(b)
}

// ---------- RRULE (Google Calendar, Google task notes) ----------

/** RRULE UNTIL value: a date for all-day items, otherwise the end of the last day as UTC date-time. */
function untilValue(lastDay: number, allDay: boolean) {
  if (allDay) return toDateKey(lastDay).replace(/-/g, '')
  return new Date(addDays(lastDay, 1) - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function toRRule(r: Recurrence, start: number, allDay = true) {
  const parts = [`FREQ=${r.freq.toUpperCase()}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.freq === 'weekly') parts.push(`BYDAY=${daysOf(r, start).map((d) => CODES[d]).join(',')}`)
  if ((r.freq === 'monthly' || r.freq === 'yearly') && r.nth) parts.push(`BYDAY=${r.nth}${CODES[daysOf(r, start)[0]]}`)
  if (r.freq === 'yearly' && r.nth) parts.push(`BYMONTH=${new Date(start).getMonth() + 1}`)
  if (r.count) parts.push(`COUNT=${r.count}`)
  else if (r.until !== undefined) parts.push(`UNTIL=${untilValue(r.until, allDay)}`)
  return `RRULE:${parts.join(';')}`
}

function parseUntil(v: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v)
  if (!m) return undefined
  if (!m[4]) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  const t = m[8] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7]) : new Date(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7]).getTime()
  return startOfDay(t)
}

/**
 * Reads recurrence lines. `exact` is false when the rule has parts the editor can't show (they are
 * then kept as they are unless the rule is changed).
 */
export function parseRRule(lines: string[] | string | undefined, start: number): { rule: Recurrence | null; exact: boolean } {
  const all = typeof lines === 'string' ? [lines] : (lines ?? [])
  const rules = all.filter((l) => /^RRULE:/i.test(l))
  if (!rules.length) return { rule: null, exact: !all.some((l) => /^RDATE/i.test(l)) }
  let exact = rules.length === 1 && !all.some((l) => /^RDATE/i.test(l))
  const p = Object.fromEntries(
    rules[0]
      .slice(6)
      .split(';')
      .filter(Boolean)
      .map((x) => {
        const i = x.indexOf('=')
        return [x.slice(0, i).toUpperCase(), x.slice(i + 1)]
      }),
  )
  const freq = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' } as const)[p.FREQ as string]
  if (!freq) return { rule: null, exact: false }
  const r: Recurrence = { freq, interval: Math.max(1, Number(p.INTERVAL) || 1) }
  const s = new Date(start)
  for (const k of Object.keys(p)) if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'COUNT', 'UNTIL', 'WKST'].includes(k)) exact = false
  if (p.BYDAY) {
    const items = (p.BYDAY as string).split(',').map((x) => /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.toUpperCase()))
    if (items.some((m) => !m)) exact = false
    const valid = items.filter((m): m is RegExpExecArray => !!m)
    const nth = valid[0]?.[1] ? Number(valid[0][1]) : p.BYSETPOS ? Number(p.BYSETPOS) : undefined
    if (freq === 'weekly') {
      r.days = valid.map((m) => CODES.indexOf(m[2]))
      if (valid.some((m) => m[1])) exact = false
    } else if ((freq === 'monthly' || freq === 'yearly') && valid.length === 1 && nth && (nth === -1 || (nth >= 1 && nth <= 4))) {
      r.nth = nth
      r.days = [CODES.indexOf(valid[0][2])]
    } else if (freq === 'daily' && valid.length === 5 && !valid.some((m) => m[1]) && valid.every((m) => !['SA', 'SU'].includes(m[2]))) {
      // "Every weekday" written as a daily rule.
      r.freq = 'weekly'
      r.days = [1, 2, 3, 4, 5]
    } else exact = false
  } else if (p.BYSETPOS) exact = false
  if (p.BYMONTHDAY && Number(p.BYMONTHDAY) !== s.getDate()) exact = false
  if (p.BYMONTH && Number(p.BYMONTH) !== s.getMonth() + 1) exact = false
  if (p.COUNT) r.count = Math.max(1, Number(p.COUNT) || 1)
  if (p.UNTIL) r.until = parseUntil(p.UNTIL as string)
  return { rule: r, exact }
}

// ---------- Microsoft Graph patternedRecurrence (Outlook events, To Do tasks) ----------

export interface GraphRecurrence {
  pattern: { type: string; interval?: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number; index?: string; firstDayOfWeek?: string }
  range: { type: string; startDate?: string; endDate?: string; numberOfOccurrences?: number; recurrenceTimeZone?: string }
}

export function toGraph(r: Recurrence, start: number, firstDayOfWeek: 0 | 1 = 1, timeZone?: string): GraphRecurrence {
  const s = new Date(start)
  const days = daysOf(r, start).map((d) => GRAPH_DAYS[d])
  const interval = r.interval
  const pattern: GraphRecurrence['pattern'] =
    r.freq === 'daily'
      ? { type: 'daily', interval }
      : r.freq === 'weekly'
        ? { type: 'weekly', interval, daysOfWeek: days, firstDayOfWeek: GRAPH_DAYS[firstDayOfWeek] }
        : r.freq === 'monthly'
          ? r.nth
            ? { type: 'relativeMonthly', interval, daysOfWeek: [days[0]], index: GRAPH_INDEX[r.nth] }
            : { type: 'absoluteMonthly', interval, dayOfMonth: s.getDate() }
          : r.nth
            ? { type: 'relativeYearly', interval, daysOfWeek: [days[0]], index: GRAPH_INDEX[r.nth], month: s.getMonth() + 1 }
            : { type: 'absoluteYearly', interval, dayOfMonth: s.getDate(), month: s.getMonth() + 1 }
  const startDate = toDateKey(start)
  const tz = timeZone ? { recurrenceTimeZone: timeZone } : {}
  const range: GraphRecurrence['range'] = r.count
    ? { type: 'numbered', startDate, numberOfOccurrences: r.count, ...tz }
    : r.until !== undefined
      ? { type: 'endDate', startDate, endDate: toDateKey(r.until), ...tz }
      : { type: 'noEnd', startDate, ...tz }
  return { pattern, range }
}

export function fromGraph(g: GraphRecurrence | null | undefined, start: number): { rule: Recurrence | null; exact: boolean } {
  const p = g?.pattern
  if (!p?.type) return { rule: null, exact: true }
  const interval = Math.max(1, p.interval || 1)
  const days = (p.daysOfWeek ?? []).map((d) => GRAPH_DAYS.indexOf(d.toLowerCase())).filter((d) => d >= 0)
  const nth = Object.entries(GRAPH_INDEX).find(([, v]) => v === p.index)?.[0]
  const s = new Date(start)
  let exact = true
  let rule: Recurrence
  switch (p.type) {
    case 'daily':
      rule = { freq: 'daily', interval }
      break
    case 'weekly':
      rule = { freq: 'weekly', interval, days: days.length ? days : undefined }
      break
    case 'absoluteMonthly':
      rule = { freq: 'monthly', interval }
      if (p.dayOfMonth && p.dayOfMonth !== s.getDate()) exact = false
      break
    case 'relativeMonthly':
      rule = { freq: 'monthly', interval, nth: nth ? Number(nth) : 1, days: days.slice(0, 1) }
      if (days.length !== 1) exact = false
      break
    case 'absoluteYearly':
      rule = { freq: 'yearly', interval }
      if ((p.dayOfMonth && p.dayOfMonth !== s.getDate()) || (p.month && p.month !== s.getMonth() + 1)) exact = false
      break
    case 'relativeYearly':
      rule = { freq: 'yearly', interval, nth: nth ? Number(nth) : 1, days: days.slice(0, 1) }
      if (days.length !== 1 || (p.month && p.month !== s.getMonth() + 1)) exact = false
      break
    default:
      return { rule: null, exact: false }
  }
  const range = g?.range
  if (range?.type === 'endDate' && range.endDate) rule.until = startOfDay(new Date(+range.endDate.slice(0, 4), +range.endDate.slice(5, 7) - 1, +range.endDate.slice(8, 10)).getTime())
  if (range?.type === 'numbered' && range.numberOfOccurrences) rule.count = range.numberOfOccurrences
  return { rule, exact }
}

// ---------- Occurrences (for Google tasks, which Mail Vibes repeats itself) ----------

const daysBetween = (a: number, b: number) => Math.round((startOfDay(b) - startOfDay(a)) / DAY)
const monthsBetween = (a: Date, b: Date) => (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()

/** Whether the rule (anchored at `start`) falls on `day` (local midnight), ignoring its end. */
export function fallsOn(r: Recurrence, start: number, day: number) {
  const s = new Date(start)
  const d = new Date(day)
  const diff = daysBetween(start, day)
  if (diff < 0) return false
  const weekdayMatch = () => {
    const want = daysOf(r, start)[0]
    if (d.getDay() !== want) return false
    return r.nth === -1 ? isLastOfMonth(day) : nthOfMonth(day) === r.nth
  }
  switch (r.freq) {
    case 'daily':
      return diff % r.interval === 0
    case 'weekly': {
      if (!daysOf(r, start).includes(d.getDay())) return false
      // Weeks counted from Monday of the start's week.
      const monday = (t: number) => addDays(startOfDay(t), -((new Date(t).getDay() + 6) % 7))
      return Math.round(daysBetween(monday(start), monday(day)) / 7) % r.interval === 0
    }
    case 'monthly':
      if (monthsBetween(s, d) % r.interval !== 0) return false
      return r.nth ? weekdayMatch() : d.getDate() === s.getDate()
    case 'yearly':
      if ((d.getFullYear() - s.getFullYear()) % r.interval !== 0 || d.getMonth() !== s.getMonth()) return false
      return r.nth ? weekdayMatch() : d.getDate() === s.getDate()
  }
}

/**
 * The next date after `after` on which the rule falls (local midnight), or undefined when the
 * series has ended. `count` is the number of occurrences left, counting the one at `start`.
 */
export function nextOccurrence(r: Recurrence, start: number, after = start): number | undefined {
  if (r.count !== undefined && r.count <= 1) return undefined
  // Up to ten years ahead: enough for any rule the editor makes.
  const limit = addMonths(startOfDay(after), 12 * 10 * Math.max(1, r.freq === 'yearly' ? r.interval : 1))
  for (let d = addDays(startOfDay(after), 1); d <= limit; d = addDays(d, 1)) {
    if (r.until !== undefined && d > r.until) return undefined
    if (fallsOn(r, start, d)) return d
  }
  return undefined
}

/** The rule for the series that continues from the next occurrence (one fewer left, if counted). */
export const continued = (r: Recurrence): Recurrence => (r.count ? { ...r, count: r.count - 1 } : r)

// ---------- Text ----------

type T = TFunction

const weekdayIn = (locale: string) => (d: number) => new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2026, 10, 15 + d))

/** The "on …" part of a rule: "on Monday and Thursday", "on day 21", "on the second Tuesday". */
export function describeOn(r: Recurrence, start: number, t: T, locale: string) {
  const weekday = weekdayIn(locale)
  const days = daysOf(r, start)
  if (r.freq === 'weekly') return t('recurrence.onDays', { days: new Intl.ListFormat(locale, { type: 'conjunction' }).format(days.map(weekday)) })
  if (r.freq === 'monthly')
    return r.nth ? t('recurrence.onNth', { nth: t(`recurrence.nth.${r.nth}`), day: weekday(days[0]) }) : t('recurrence.onDay', { day: new Date(start).getDate() })
  if (r.freq === 'yearly') {
    const month = new Intl.DateTimeFormat(locale, { month: 'long' }).format(start)
    return r.nth
      ? t('recurrence.onNthOf', { nth: t(`recurrence.nth.${r.nth}`), day: weekday(days[0]), month })
      : t('recurrence.onDate', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(start) })
  }
  return ''
}

/** "Every 2 weeks on Monday and Thursday, until 5 Jan 2027" */
export function describe(r: Recurrence, start: number, t: T, locale: string) {
  const days = daysOf(r, start)
  let text: string
  if (r.freq === 'weekly' && r.interval === 1 && days.join() === '1,2,3,4,5') text = t('recurrence.weekdays')
  else text = [t(`recurrence.${r.freq}`, { count: r.interval }), describeOn(r, start, t, locale)].filter(Boolean).join(' ')
  if (r.count) text += ', ' + t('recurrence.times', { count: r.count })
  else if (r.until !== undefined) text += ', ' + t('recurrence.until', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(r.until) })
  return text
}
