import { describe, expect, it } from 'vitest'
import { canMove, dragged } from './drag'

const day = (d: number) => new Date(2026, 10, d).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()

describe('dragging events', () => {
  const e = { start: at(24, 10), end: at(24, 11) }

  it('moves within the time grid, keeping where it was grabbed, in quarters of an hour', () => {
    // Grabbed 20 minutes into the event, dropped with the pointer at 14:33 on another day: starts 14:13 → 14:15.
    expect(dragged(e, 'move', { day: day(24), minutes: 10 * 60 + 20 }, { day: day(26), minutes: 14 * 60 + 33 })).toEqual({ start: at(26, 14, 15), end: at(26, 15, 15) })
    // 14:27 → starts 14:07 → 14:00.
    expect(dragged(e, 'move', { day: day(24), minutes: 10 * 60 + 20 }, { day: day(24), minutes: 14 * 60 + 27 }).start).toBe(at(24, 14))
  })

  it('resizes from the bottom, never shorter than a quarter of an hour', () => {
    expect(dragged(e, 'resize', { day: day(24), minutes: 11 * 60 }, { day: day(24), minutes: 12 * 60 + 40 })).toEqual({ start: e.start, end: at(24, 12, 45) })
    expect(dragged(e, 'resize', { day: day(24), minutes: 11 * 60 }, { day: day(24), minutes: 9 * 60 })).toEqual({ start: e.start, end: at(24, 10, 15) })
  })

  it('moves by whole days in the month view, keeping the clock times', () => {
    expect(dragged(e, 'move', { day: day(24) }, { day: day(27) })).toEqual({ start: at(27, 10), end: at(27, 11) })
    const allDay = { start: day(24), end: day(26) }
    expect(dragged(allDay, 'move', { day: day(25) }, { day: day(23) })).toEqual({ start: day(22), end: day(24) })
  })

  it('lets only the organiser move an event in a calendar they can edit', () => {
    const base = { canEdit: true, isOrganizer: true, myResponse: 'organizer', cancelled: false }
    expect(canMove(base)).toBe(true)
    expect(canMove({ ...base, isOrganizer: false, myResponse: 'accepted' })).toBe(false)
    expect(canMove({ ...base, canEdit: false })).toBe(false)
    expect(canMove({ ...base, cancelled: true })).toBe(false)
  })
})
