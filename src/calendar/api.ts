import { googleCalendar } from './googleCal'
import { outlookCalendar } from './outlookCal'
import type { CalendarProvider } from './types'

export function calendarFor(accountId: string): CalendarProvider {
  if (accountId.startsWith('microsoft:')) return outlookCalendar
  if (accountId.startsWith('google:')) return googleCalendar
  throw new Error('Unknown account type')
}

export const calendarKey = (accountId: string, calendarId: string) => `${accountId}|${calendarId}`
