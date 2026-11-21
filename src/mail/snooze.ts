/**
 * Snoozing. Neither Gmail nor Outlook lets other apps use their own snooze, so the app does it:
 * the conversation leaves the Inbox and waits in a "Snoozed" place in the mailbox (a Gmail label
 * per wake-up time, an Outlook folder with the time stored on the message), and the app brings it
 * back when the time comes. That only happens while the app is open somewhere; a message whose
 * time passed while it was closed comes back as soon as it is opened again.
 */

/** Name of the Gmail label (parent of the per-time labels) and of the Outlook folder. */
export const SNOOZE_NAME = 'Snoozed'

const pad = (n: number) => String(n).padStart(2, '0')

/** Local time as used in the Gmail label names, e.g. "2026-11-23 09.00". */
export function snoozeStamp(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
}

/** The time of a stamp (see snoozeStamp), or undefined if it isn't one. */
export function parseSnoozeStamp(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})[.:](\d{2})$/.exec(s.trim())
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isNaN(d.getTime()) ? undefined : d.getTime()
}

/** Gmail label names used for snoozing ("Snoozed" and "Snoozed/<stamp>"); hidden from the tags. */
export const isSnoozeLabel = (name: string) => name === SNOOZE_NAME || name.startsWith(`${SNOOZE_NAME}/`)

/** The wake-up time of a "Snoozed/<stamp>" label name. */
export const snoozeLabelTime = (name: string) => (name.startsWith(`${SNOOZE_NAME}/`) ? parseSnoozeStamp(name.slice(SNOOZE_NAME.length + 1)) : undefined)

export const snoozeLabelName = (until: number) => `${SNOOZE_NAME}/${snoozeStamp(until)}`

export type SnoozePreset = 'laterToday' | 'tomorrow' | 'weekend' | 'nextWeek'

function at(base: Date, days: number, hour: number) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0)
  return d.getTime()
}

/**
 * The quick choices: later today (18:00, before 17:00 only), tomorrow 9:00, this weekend
 * (Saturday 9:00, on weekdays only) and next week (Monday 9:00).
 */
export function snoozePresets(now = Date.now()): { id: SnoozePreset; until: number }[] {
  const d = new Date(now)
  const day = d.getDay() // 0 = Sunday
  const out: { id: SnoozePreset; until: number }[] = []
  if (d.getHours() < 17) out.push({ id: 'laterToday', until: at(d, 0, 18) })
  out.push({ id: 'tomorrow', until: at(d, 1, 9) })
  if (day >= 1 && day <= 5) out.push({ id: 'weekend', until: at(d, 6 - day, 9) })
  out.push({ id: 'nextWeek', until: at(d, ((8 - day) % 7) || 7, 9) })
  return out
}
