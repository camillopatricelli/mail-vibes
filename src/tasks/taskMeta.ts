import { fromDateKey, toDateKey, toTimeKey, withTime } from '../calendar/dates'
import { parseRRule, toRRule, type Recurrence } from '../lib/recurrence'

/**
 * Google Tasks has no start date, reminder or repeat rule that apps can use, so Mail Vibes keeps
 * them in a line at the end of the notes, e.g.
 *   Mail Vibes: start 2026-11-25 · reminder 2026-11-24 18:00 · repeat FREQ=WEEKLY;BYDAY=MO
 * The line is hidden in the app and rewritten when the task is saved.
 */

export interface TaskMeta {
  start?: number
  reminder?: number
  recurrence?: Recurrence
}

const PREFIX = 'Mail Vibes:'
const LINE = /(?:^|\n)[ \t]*Mail Vibes:([^\n]*)\s*$/

/** The notes without the line, and what the line holds (the repeat rule is anchored at `due`). */
export function readMeta(notes: string, due: number | undefined): { notes: string; meta: TaskMeta } {
  const m = LINE.exec(notes)
  if (!m) return { notes, meta: {} }
  const meta: TaskMeta = {}
  for (const part of m[1].split('·').map((x) => x.trim())) {
    let x: RegExpExecArray | null
    if ((x = /^start (\d{4}-\d{2}-\d{2})$/.exec(part))) meta.start = fromDateKey(x[1])
    else if ((x = /^reminder (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(part))) {
      const day = fromDateKey(x[1])
      if (day !== undefined) meta.reminder = withTime(day, x[2])
    } else if ((x = /^repeat (\S+)$/.exec(part))) {
      const rule = parseRRule(`RRULE:${x[1]}`, due ?? meta.start ?? Date.now()).rule
      if (rule) meta.recurrence = rule
    }
  }
  return { notes: notes.slice(0, m.index).replace(/\s+$/, ''), meta }
}

/** The notes with the line for `meta` added at the end (or without any line when it's empty). */
export function writeMeta(notes: string, meta: TaskMeta, due: number | undefined) {
  const clean = readMeta(notes, due).notes.replace(/\s+$/, '')
  const parts: string[] = []
  if (meta.start !== undefined) parts.push(`start ${toDateKey(meta.start)}`)
  if (meta.reminder !== undefined) parts.push(`reminder ${toDateKey(meta.reminder)} ${toTimeKey(meta.reminder)}`)
  if (meta.recurrence) parts.push(`repeat ${toRRule(meta.recurrence, due ?? meta.start ?? Date.now()).slice(6)}`)
  if (!parts.length) return clean
  return [clean, `${PREFIX} ${parts.join(' · ')}`].filter(Boolean).join('\n\n')
}
