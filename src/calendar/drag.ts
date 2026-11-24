import { addDays, DAY, startOfDay } from './dates'

/** Dragged times snap to a quarter of an hour; a resized event lasts at least that long. */
export const SNAP = 15 * 60_000

/** Where the pointer is: a day, and in the time grid the minutes from that day's midnight. */
export interface Spot {
  day: number
  minutes?: number
}

export type DragKind = 'move' | 'resize'

/** Events the user may move: the same ones the Edit button is shown for. */
export const canMove = (e: { canEdit: boolean; isOrganizer: boolean; myResponse: string; cancelled: boolean }) =>
  e.canEdit && (e.isOrganizer || e.myResponse === 'organizer') && !e.cancelled

/** The local clock time `minutes` after the day's midnight (right on daylight-saving days too). */
export function atMinutes(day: number, minutes: number) {
  const d = new Date(day)
  d.setHours(0, Math.round(minutes), 0, 0)
  return d.getTime()
}

/** Rounds to the nearest quarter of an hour (time zones are whole quarters away from UTC). */
export const snap = (t: number) => Math.round(t / SNAP) * SNAP

export const daysBetween = (a: number, b: number) => Math.round((startOfDay(b) - startOfDay(a)) / DAY)

/**
 * The event's new times while it is dragged from `from` to `to`.
 * In the time grid (spots with minutes) a move keeps where the event was grabbed and snaps to a
 * quarter of an hour, and a resize moves the end. Elsewhere (month view, all-day row) the event
 * moves by whole days and keeps its clock times.
 */
export function dragged(e: { start: number; end: number }, kind: DragKind, from: Spot, to: Spot): { start: number; end: number } {
  if (from.minutes !== undefined && to.minutes !== undefined) {
    const pointer = atMinutes(to.day, to.minutes)
    if (kind === 'resize') return { start: e.start, end: Math.max(snap(pointer), e.start + SNAP) }
    const grab = atMinutes(from.day, from.minutes) - e.start
    const start = snap(pointer - grab)
    return { start, end: start + (e.end - e.start) }
  }
  if (kind === 'resize') return { start: e.start, end: e.end }
  const n = daysBetween(from.day, to.day)
  return { start: addDays(e.start, n), end: addDays(e.end, n) }
}
