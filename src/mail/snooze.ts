/**
 * Snoozing and sending later.
 *
 * Neither Gmail nor Outlook lets other apps use its own snooze, so the app does it: the
 * conversation leaves the Inbox and waits in the mailbox (Gmail: a label per wake-up time;
 * Outlook: a "Snoozed" folder, with the time stored on the message), and the app brings it back
 * when the time comes.
 *
 * Sending later: Outlook does it on the server (the message waits in the Outbox). Gmail doesn't
 * let apps use its own scheduled send, so the message stays a draft with a label per send time,
 * and the app sends it when the time comes.
 *
 * What the app does itself only happens while it is open somewhere; anything that came due while
 * it was closed happens as soon as it is opened again.
 */

/** Gmail labels of the app are kept under this one (hidden from the tags). */
export const APP_LABEL = 'Mail Vibes'
export type TimedLabel = 'Snoozed' | 'Send later'
/** Name of the Outlook folder of snoozed mail. */
export const SNOOZE_FOLDER = 'Snoozed'

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

/** The app's own Gmail labels ("Mail Vibes" and everything under it). */
export const isAppLabel = (name: string) => name === APP_LABEL || name.startsWith(`${APP_LABEL}/`)

/** e.g. "Mail Vibes/Snoozed/2026-11-23 09.00" */
export const timedLabelName = (kind: TimedLabel, at: number) => `${APP_LABEL}/${kind}/${snoozeStamp(at)}`

/** The time of a label made by timedLabelName for this kind, else undefined. */
export function timedLabelTime(name: string, kind: TimedLabel) {
  const prefix = `${APP_LABEL}/${kind}/`
  return name.startsWith(prefix) ? parseSnoozeStamp(name.slice(prefix.length)) : undefined
}

export type SnoozePreset = 'laterToday' | 'tomorrow' | 'weekend' | 'nextWeek'

function at(base: Date, days: number, hour: number) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0).getTime()
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
