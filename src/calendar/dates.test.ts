import { describe, expect, it } from 'vitest'
import { addMonths, fromDateKey, layoutDay, onDay, startOfWeek, toDateKey, viewRange } from './dates'

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min).getTime()

describe('calendar dates', () => {
  it('starts weeks on Monday or Sunday', () => {
    const sat = d(2026, 11, 21)
    expect(toDateKey(startOfWeek(sat, 1))).toBe('2026-11-16')
    expect(toDateKey(startOfWeek(sat, 0))).toBe('2026-11-15')
  })

  it('clamps month steps to the last day', () => {
    expect(toDateKey(addMonths(d(2026, 1, 31), 1))).toBe('2026-02-28')
  })

  it('round-trips date keys and builds a 6-week month grid', () => {
    expect(toDateKey(fromDateKey('2026-03-29')!)).toBe('2026-03-29')
    const [from, to] = viewRange('month', d(2026, 11, 21), 1)
    expect(toDateKey(from)).toBe('2026-10-26')
    expect(toDateKey(to)).toBe('2026-12-07')
  })

  it('places overlapping events in columns', () => {
    const a = { start: d(2026, 1, 1, 9), end: d(2026, 1, 1, 10) }
    const b = { start: d(2026, 1, 1, 9, 30), end: d(2026, 1, 1, 11) }
    const c = { start: d(2026, 1, 1, 10), end: d(2026, 1, 1, 10, 30) }
    const e = { start: d(2026, 1, 1, 12), end: d(2026, 1, 1, 13) }
    const placed = layoutDay([a, b, c, e])
    const of = (x: object) => placed.find((p) => p.item === x)!
    expect([of(a).col, of(b).col, of(c).col]).toEqual([0, 1, 0])
    expect(of(a).cols).toBe(2)
    expect(of(e)).toMatchObject({ col: 0, cols: 1 })
  })

  it('treats ends as exclusive', () => {
    const allDay = { start: d(2026, 1, 1), end: d(2026, 1, 2) }
    expect(onDay(allDay, d(2026, 1, 1))).toBe(true)
    expect(onDay(allDay, d(2026, 1, 2))).toBe(false)
  })
})
