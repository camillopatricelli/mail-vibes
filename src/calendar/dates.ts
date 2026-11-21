/** Local-time date helpers for the calendar views (no library: the needs are small). */

export const DAY = 86_400_000

export function startOfDay(t: number) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Adds calendar days (DST-safe: keeps the local time of day). */
export function addDays(t: number, n: number) {
  const d = new Date(t)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

export function addMonths(t: number, n: number) {
  const d = new Date(t)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return d.getTime()
}

/** 0 = Sunday, 1 = Monday. Monday everywhere except a few regions (US, Canada, Japan...). */
export function weekStartDay(locale = navigator.language): 0 | 1 {
  const region = /-([A-Z]{2})\b/.exec(locale)?.[1]
  return region && ['US', 'CA', 'JP', 'BR', 'MX', 'IL', 'PH', 'KR', 'TW', 'AU', 'IN', 'ZA'].includes(region) ? 0 : 1
}

/** The first day of the week for a "monday" / "sunday" / "auto" (by region) preference. */
export const weekStartOf = (pref: 'monday' | 'sunday' | 'auto'): 0 | 1 => (pref === 'auto' ? weekStartDay() : pref === 'sunday' ? 0 : 1)

export function startOfWeek(t: number, weekStart: 0 | 1 = weekStartDay()) {
  const d = new Date(startOfDay(t))
  const diff = (d.getDay() - weekStart + 7) % 7
  return addDays(d.getTime(), -diff)
}

export function startOfMonth(t: number) {
  const d = new Date(startOfDay(t))
  d.setDate(1)
  return d.getTime()
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b)

/** "2026-11-21" in local time (used in routes and date inputs). */
export function toDateKey(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fromDateKey(s: string | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '')
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

/** "14:30" in local time (for time inputs). */
export function toTimeKey(t: number) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function withTime(day: number, time: string) {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(day)
  d.setHours(h || 0, m || 0, 0, 0)
  return d.getTime()
}

/** Local midnight of a "YYYY-MM-DD" date (for all-day events from the providers). */
export function localDate(ymd: string) {
  return fromDateKey(ymd.slice(0, 10)) ?? Date.parse(ymd)
}

export type View = 'day' | 'week' | 'month' | 'agenda'
export const views: View[] = ['day', 'week', 'month', 'agenda']
export const AGENDA_DAYS = 30

/** The time range a view shows around a date: [from, to). */
export function viewRange(view: View, date: number, weekStart: 0 | 1 = weekStartDay()): [number, number] {
  switch (view) {
    case 'day':
      return [startOfDay(date), addDays(startOfDay(date), 1)]
    case 'week': {
      const s = startOfWeek(date, weekStart)
      return [s, addDays(s, 7)]
    }
    case 'month': {
      const s = startOfWeek(startOfMonth(date), weekStart)
      return [s, addDays(s, 42)]
    }
    case 'agenda':
      return [startOfDay(date), addDays(startOfDay(date), AGENDA_DAYS)]
  }
}

export function stepDate(view: View, date: number, dir: 1 | -1) {
  switch (view) {
    case 'day':
      return addDays(date, dir)
    case 'week':
      return addDays(date, 7 * dir)
    case 'month':
      return addMonths(date, dir)
    case 'agenda':
      return addDays(date, AGENDA_DAYS * dir)
  }
}

export interface Placed<T> {
  item: T
  /** Column index and column count within its group of overlapping items */
  col: number
  cols: number
}

/**
 * Lays out timed items of one day side by side where they overlap (like Google Calendar's
 * columns). Items must have start/end; the result keeps the input order of each cluster.
 */
export function layoutDay<T extends { start: number; end: number }>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Placed<T>[] = []
  let cluster: Placed<T>[] = []
  let columnsEnd: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    for (const p of cluster) p.cols = columnsEnd.length
    out.push(...cluster)
    cluster = []
    columnsEnd = []
  }
  for (const item of sorted) {
    // Very short events still take some room, so they are laid out as at least 20 minutes.
    const end = Math.max(item.end, item.start + 20 * 60_000)
    if (item.start >= clusterEnd) {
      flush()
      clusterEnd = -Infinity
    }
    let col = columnsEnd.findIndex((e) => e <= item.start)
    if (col < 0) {
      col = columnsEnd.length
      columnsEnd.push(end)
    } else columnsEnd[col] = end
    cluster.push({ item, col, cols: 0 })
    clusterEnd = Math.max(clusterEnd, end)
  }
  flush()
  return out
}

/** Whether an event touches the local day starting at `day`. */
export function onDay(e: { start: number; end: number; allDay?: boolean }, day: number) {
  const next = addDays(day, 1)
  return e.start < next && (e.end > day || (e.end === e.start && e.start >= day))
}
