import { describe, expect, it } from 'vitest'
import { isAppLabel, parseSnoozeStamp, snoozePresets, snoozeStamp, timedLabelName, timedLabelTime } from './snooze'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('snooze stamps', () => {
  it('round-trips a local time', () => {
    const t = local(2026, 11, 23, 9, 0)
    expect(snoozeStamp(t)).toBe('2026-11-23 09.00')
    expect(parseSnoozeStamp('2026-11-23 09.00')).toBe(t)
    expect(parseSnoozeStamp('2026-11-23 09:00')).toBe(t)
    expect(parseSnoozeStamp('not a time')).toBeUndefined()
  })

  it('names and reads labels', () => {
    const t = local(2026, 1, 2, 18, 30)
    expect(timedLabelName('Snoozed', t)).toBe('Mail Vibes/Snoozed/2026-01-02 18.30')
    expect(timedLabelTime('Mail Vibes/Snoozed/2026-01-02 18.30', 'Snoozed')).toBe(t)
    expect(timedLabelTime('Mail Vibes/Send later/2026-01-02 18.30', 'Snoozed')).toBeUndefined()
    expect(timedLabelTime('Mail Vibes/Send later/2026-01-02 18.30', 'Send later')).toBe(t)
    expect(timedLabelTime('Clients/2026-01-02 18.30', 'Snoozed')).toBeUndefined()
    expect(isAppLabel('Mail Vibes')).toBe(true)
    expect(isAppLabel('Mail Vibes/Snoozed')).toBe(true)
    expect(isAppLabel('Mail Vibesish')).toBe(false)
  })
})

describe('snooze presets', () => {
  it('on a Tuesday morning offers all four', () => {
    // 2026-11-24 is a Tuesday
    const p = snoozePresets(local(2026, 11, 24, 10))
    expect(p).toEqual([
      { id: 'laterToday', until: local(2026, 11, 24, 18) },
      { id: 'tomorrow', until: local(2026, 11, 25, 9) },
      { id: 'weekend', until: local(2026, 11, 28, 9) },
      { id: 'nextWeek', until: local(2026, 11, 30, 9) },
    ])
  })

  it('drops "later today" in the evening and "this weekend" on weekends', () => {
    // 2026-11-28 is a Saturday
    const p = snoozePresets(local(2026, 11, 28, 20))
    expect(p.map((x) => x.id)).toEqual(['tomorrow', 'nextWeek'])
    expect(p[1].until).toBe(local(2026, 11, 30, 9))
  })

  it('on a Sunday, next week is the next day', () => {
    const p = snoozePresets(local(2026, 11, 29, 8))
    expect(p.find((x) => x.id === 'nextWeek')!.until).toBe(local(2026, 11, 30, 9))
  })

  it('on a Monday, next week is a week later', () => {
    const p = snoozePresets(local(2026, 11, 30, 8))
    expect(p.find((x) => x.id === 'nextWeek')!.until).toBe(local(2026, 12, 7, 9))
  })
})
