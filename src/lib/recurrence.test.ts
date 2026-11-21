import { describe as group, expect, it } from 'vitest'
import { fromDateKey, toDateKey } from '../calendar/dates'
import { readMeta, writeMeta } from '../tasks/taskMeta'
import { describe, fromGraph, nextOccurrence, parseRRule, sameRule, toGraph, toRRule, type Recurrence } from './recurrence'

const d = (s: string) => fromDateKey(s)!
// Saturday 21 Nov 2026 (third Saturday, not the last).
const sat = d('2026-11-21')
const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ''}`) as never

group('RRULE', () => {
  it('round-trips the rules the editor makes', () => {
    const rules: Recurrence[] = [
      { freq: 'daily', interval: 1 },
      { freq: 'daily', interval: 3, count: 5 },
      { freq: 'weekly', interval: 2, days: [1, 4] },
      { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], until: d('2027-01-05') },
      { freq: 'monthly', interval: 1 },
      { freq: 'monthly', interval: 1, nth: 3, days: [6] },
      { freq: 'monthly', interval: 2, nth: -1, days: [5] },
      { freq: 'yearly', interval: 1 },
      { freq: 'yearly', interval: 1, nth: 3, days: [6] },
    ]
    for (const r of rules) {
      const line = toRRule(r, sat, true)
      const back = parseRRule([line], sat)
      expect(back.exact, line).toBe(true)
      expect(sameRule(back.rule, r, sat), line).toBe(true)
    }
  })

  it('writes UNTIL as a date for all-day items and as UTC end of day otherwise', () => {
    expect(toRRule({ freq: 'daily', interval: 1, until: d('2027-01-05') }, sat, true)).toBe('RRULE:FREQ=DAILY;UNTIL=20270105')
    expect(toRRule({ freq: 'daily', interval: 1, until: d('2027-01-05') }, sat, false)).toMatch(/^RRULE:FREQ=DAILY;UNTIL=2027010[56]T\d{6}Z$/)
  })

  it('reads Google and Outlook-made variants', () => {
    expect(parseRRule(['RRULE:FREQ=MONTHLY;BYDAY=SA;BYSETPOS=3'], sat).rule).toMatchObject({ freq: 'monthly', nth: 3, days: [6] })
    expect(parseRRule(['RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'], sat).rule).toMatchObject({ freq: 'weekly', days: [1, 2, 3, 4, 5] })
    expect(parseRRule(['EXDATE;VALUE=DATE:20261128', 'RRULE:FREQ=WEEKLY;BYDAY=SA'], sat).exact).toBe(true)
  })

  it('flags rules it cannot show', () => {
    expect(parseRRule(['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15'], sat).exact).toBe(false)
    expect(parseRRule(['RRULE:FREQ=HOURLY'], sat)).toEqual({ rule: null, exact: false })
    expect(parseRRule(['RRULE:FREQ=WEEKLY;BYDAY=SA;BYHOUR=9'], sat).exact).toBe(false)
  })
})

group('Graph', () => {
  it('round-trips through patternedRecurrence', () => {
    const rules: Recurrence[] = [
      { freq: 'weekly', interval: 2, days: [1, 4], count: 10 },
      { freq: 'monthly', interval: 1, nth: -1, days: [6] },
      { freq: 'yearly', interval: 1, until: d('2030-11-21') },
    ]
    for (const r of rules) {
      const g = toGraph(r, sat)
      expect(g.range.startDate).toBe('2026-11-21')
      const back = fromGraph(g, sat)
      expect(back.exact).toBe(true)
      expect(sameRule(back.rule, r, sat)).toBe(true)
    }
  })
})

group('nextOccurrence', () => {
  const next = (r: Recurrence, from: string) => {
    const n = nextOccurrence(r, d(from))
    return n === undefined ? undefined : toDateKey(n)
  }
  it('steps by the rule', () => {
    expect(next({ freq: 'daily', interval: 2 }, '2026-11-21')).toBe('2026-11-23')
    expect(next({ freq: 'weekly', interval: 1, days: [1, 4] }, '2026-11-23')).toBe('2026-11-26')
    expect(next({ freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] }, '2026-11-27')).toBe('2026-11-30')
    expect(next({ freq: 'monthly', interval: 1 }, '2026-01-31')).toBe('2026-03-31')
    expect(next({ freq: 'monthly', interval: 1, nth: 3, days: [6] }, '2026-11-21')).toBe('2026-12-19')
    expect(next({ freq: 'monthly', interval: 1, nth: -1, days: [5] }, '2026-11-27')).toBe('2026-12-25')
    expect(next({ freq: 'yearly', interval: 1 }, '2026-11-21')).toBe('2027-11-21')
  })
  it('stops at the end of the series', () => {
    expect(next({ freq: 'daily', interval: 1, count: 1 }, '2026-11-21')).toBeUndefined()
    expect(next({ freq: 'weekly', interval: 1, until: d('2026-11-25') }, '2026-11-21')).toBeUndefined()
  })
})

group('describe', () => {
  it('builds the text from parts', () => {
    expect(describe({ freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] }, sat, t, 'en')).toBe('recurrence.weekdays')
    expect(describe({ freq: 'monthly', interval: 2, count: 3 }, sat, t, 'en')).toBe('recurrence.monthly{"count":2} recurrence.onDay{"day":21}, recurrence.times{"count":3}')
  })
})

group('Google task notes line', () => {
  it('writes and reads start, reminder and repeat, keeping the notes', () => {
    const due = d('2026-11-28')
    const meta = { start: d('2026-11-25'), reminder: new Date(2026, 10, 24, 18, 0).getTime(), recurrence: { freq: 'weekly', interval: 1, days: [6] } as Recurrence }
    const notes = writeMeta('Buy milk\n\nEmail: Hello — https://mail.google.com/x', meta, due)
    expect(notes).toBe('Buy milk\n\nEmail: Hello — https://mail.google.com/x\n\nMail Vibes: start 2026-11-25 · reminder 2026-11-24 18:00 · repeat FREQ=WEEKLY;BYDAY=SA')
    const back = readMeta(notes, due)
    expect(back.notes).toBe('Buy milk\n\nEmail: Hello — https://mail.google.com/x')
    expect(back.meta.start).toBe(meta.start)
    expect(back.meta.reminder).toBe(meta.reminder)
    expect(sameRule(back.meta.recurrence, meta.recurrence, due)).toBe(true)
    // Rewriting replaces the line; an empty one goes away.
    expect(writeMeta(notes, {}, due)).toBe('Buy milk\n\nEmail: Hello — https://mail.google.com/x')
    expect(writeMeta('', { start: d('2026-11-25') }, due)).toBe('Mail Vibes: start 2026-11-25')
  })
})
