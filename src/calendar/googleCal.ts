import { google } from '../providers/google'
import { addDays, localDate, startOfDay, toDateKey } from './dates'
import { textToHtml } from './outlookCal'
import { findMeetingLink, type CalEvent, type CalendarInfo, type CalendarProvider, type EventDraft, type Response, type SeriesInfo } from './types'

/** Google Calendar via the Calendar REST API (and the Meet REST API for stand-alone Meet links). */

const API = 'https://www.googleapis.com/calendar/v3'

interface GTime {
  date?: string
  dateTime?: string
  timeZone?: string
}
interface GAttendee {
  email?: string
  displayName?: string
  responseStatus?: string
  self?: boolean
  organizer?: boolean
  optional?: boolean
  resource?: boolean
}
interface GEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: GTime
  end?: GTime
  attendees?: GAttendee[]
  organizer?: { email?: string; displayName?: string; self?: boolean }
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; conferenceSolution?: { name?: string } }
  recurringEventId?: string
  htmlLink?: string
  eventType?: string
}

function response(r: string | undefined): Response {
  switch (r) {
    case 'accepted':
      return 'accepted'
    case 'tentative':
      return 'tentative'
    case 'declined':
      return 'declined'
    default:
      return 'needsAction'
  }
}

const parseTime = (t: GTime | undefined) => (!t ? 0 : t.date ? localDate(t.date) : Date.parse(t.dateTime ?? ''))

/** Google descriptions are plain text or simple HTML. */
const descriptionHtml = (d: string | undefined) => (!d ? '' : /<[a-z][\s\S]*>/i.test(d) ? d : textToHtml(d))

function toEvent(accountId: string, calendarId: string, e: GEvent): CalEvent {
  const attendees = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({ name: a.displayName ?? '', email: a.email!, response: response(a.responseStatus), optional: !!a.optional }))
  const me = e.attendees?.find((a) => a.self)
  const isOrganizer = !!e.organizer?.self
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? e.hangoutLink
  return {
    accountId,
    calendarId,
    id: e.id,
    title: e.summary ?? '',
    start: parseTime(e.start),
    end: parseTime(e.end),
    allDay: !!e.start?.date,
    location: e.location ?? '',
    descriptionHtml: descriptionHtml(e.description),
    organizer: e.organizer?.email ? { name: e.organizer.displayName ?? '', email: e.organizer.email } : undefined,
    isOrganizer,
    attendees,
    myResponse: isOrganizer || !me ? 'organizer' : response(me.responseStatus),
    meeting: video
      ? { url: video, provider: /meet\.google\.com/.test(video) ? 'meet' : (findMeetingLink(video)?.provider ?? 'other') }
      : findMeetingLink(e.location, e.description),
    seriesId: e.recurringEventId,
    cancelled: e.status === 'cancelled',
    webLink: e.htmlLink,
  }
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function gTime(t: number, allDay: boolean): GTime {
  return allDay ? { date: toDateKey(t) } : { dateTime: new Date(t).toISOString(), timeZone: timeZone() }
}

const FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' } as const

/** RRULE UNTIL value: a date for all-day events, otherwise a UTC date-time. */
function untilValue(t: number, allDay: boolean) {
  if (allDay) return toDateKey(t).replace(/-/g, '')
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** The recurrence lines for a new event or a series edit (undefined = leave as is). */
function recurrence(d: Partial<EventDraft>, existing: boolean): string[] | undefined {
  if (!d.repeat || d.repeat === 'custom') return undefined
  // A series edited to "does not repeat" keeps only its first occurrence.
  if (d.repeat === 'none') return existing ? ['RRULE:FREQ=DAILY;COUNT=1'] : undefined
  // The series ends at the end of its last day (local time).
  const until = d.repeatUntil !== undefined ? `;UNTIL=${untilValue(d.allDay ? d.repeatUntil : addDays(d.repeatUntil, 1) - 1000, !!d.allDay)}` : ''
  return [`RRULE:FREQ=${FREQ[d.repeat]}${until}`]
}

function body(d: Partial<EventDraft>, existing = false) {
  const out: Record<string, unknown> = {}
  if (d.title !== undefined) out.summary = d.title
  if (d.start !== undefined && d.end !== undefined && d.allDay !== undefined) {
    out.start = gTime(d.start, d.allDay)
    out.end = gTime(d.end, d.allDay)
  }
  if (d.location !== undefined || d.externalMeeting) {
    const loc = d.location ?? ''
    out.location = d.externalMeeting ? (loc ? `${loc} · ${d.externalMeeting.url}` : d.externalMeeting.url) : loc
  }
  if (d.description !== undefined) out.description = d.description + (d.externalMeeting ? `\n\n${d.externalMeeting.url}` : '')
  if (d.attendees !== undefined) out.attendees = d.attendees.map((a) => ({ email: a.email, displayName: a.name || undefined }))
  if (d.nativeMeeting)
    out.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  const rec = recurrence(d, existing)
  if (rec) out.recurrence = rec
  return out
}

const cal = (id: string) => `${API}/calendars/${encodeURIComponent(id)}`

export const googleCalendar: CalendarProvider = {
  async calendars(accountId) {
    type GCal = { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; primary?: boolean }
    const r = await google<{ items?: GCal[] }>(accountId, `${API}/users/me/calendarList?maxResults=250`)
    return (r.items ?? []).map(
      (c): CalendarInfo => ({
        accountId,
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        color: c.backgroundColor,
        canEdit: c.accessRole === 'owner' || c.accessRole === 'writer',
        isDefault: !!c.primary,
      }),
    )
  },

  async events(accountId, calendarId, from, to) {
    const out: CalEvent[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        maxResults: '2500',
      })
      if (pageToken) q.set('pageToken', pageToken)
      const r = await google<{ items?: GEvent[]; nextPageToken?: string }>(accountId, `${cal(calendarId)}/events?${q}`)
      for (const e of r.items ?? []) {
        // Working-location entries are status markers, not events.
        if (e.status === 'cancelled' || e.eventType === 'workingLocation') continue
        out.push(toEvent(accountId, calendarId, e))
      }
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  },

  async search(accountId, calendarId, text, from, to) {
    const q = new URLSearchParams({
      q: text,
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      maxResults: '50',
    })
    const r = await google<{ items?: GEvent[] }>(accountId, `${cal(calendarId)}/events?${q}`)
    return (r.items ?? []).filter((e) => e.status !== 'cancelled' && e.eventType !== 'workingLocation').map((e) => toEvent(accountId, calendarId, e))
  },

  async create(accountId, calendarId, draft) {
    await google(accountId, `${cal(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`, { method: 'POST', body: body(draft) })
  },

  async update(accountId, calendarId, eventId, draft) {
    await google(accountId, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all&conferenceDataVersion=1`, {
      method: 'PATCH',
      body: body(draft, true),
    })
  },

  async remove(accountId, calendarId, eventId) {
    await google(accountId, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' })
  },

  async series(accountId, calendarId, seriesId) {
    const e = await google<GEvent & { recurrence?: string[] }>(
      accountId,
      `${cal(calendarId)}/events/${encodeURIComponent(seriesId)}?fields=start,end,recurrence`,
    )
    const rule = (e.recurrence ?? []).find((r) => r.startsWith('RRULE:')) ?? ''
    const parts = Object.fromEntries(rule.slice(6).split(';').map((p) => p.split('=') as [string, string]))
    const simple = (!parts.INTERVAL || parts.INTERVAL === '1') && !parts.BYSETPOS && (!parts.BYDAY || !parts.BYDAY.includes(',')) && (e.recurrence ?? []).length === 1
    const byFreq: Record<string, SeriesInfo['repeat']> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }
    let repeat: SeriesInfo['repeat'] = simple ? (byFreq[parts.FREQ] ?? 'custom') : 'custom'
    if (parts.COUNT === '1') repeat = 'none'
    // A plain monthly rule on a weekday ("every 2nd Tuesday") is not the "same date" rule the editor offers.
    if (repeat === 'monthly' && parts.BYDAY) repeat = 'custom'
    let until: number | undefined
    if (parts.UNTIL) {
      const m = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts.UNTIL)
      if (m) until = startOfDay(m[4] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7]) : new Date(+m[1], +m[2] - 1, +m[3]).getTime())
    }
    return { start: parseTime(e.start), end: parseTime(e.end), allDay: !!e.start?.date, repeat, until }
  },

  async endSeriesBefore(accountId, calendarId, seriesId, occurrenceStart) {
    const url = `${cal(calendarId)}/events/${encodeURIComponent(seriesId)}`
    const e = await google<GEvent & { recurrence?: string[] }>(accountId, `${url}?fields=start,recurrence`)
    const allDay = !!e.start?.date
    if (parseTime(e.start) >= occurrenceStart || !e.recurrence) return googleCalendar.remove(accountId, calendarId, seriesId)
    const until = untilValue(allDay ? addDays(startOfDay(occurrenceStart), -1) : occurrenceStart - 1000, allDay)
    const recurrence = e.recurrence.map((r) =>
      r.startsWith('RRULE:') ? `${r.replace(/;(UNTIL|COUNT)=[^;]*/g, '')};UNTIL=${until}` : r,
    )
    await google(accountId, `${url}?sendUpdates=all`, { method: 'PATCH', body: { recurrence } })
  },

  async respond(accountId, calendarId, event, r) {
    // Attendees are replaced as a whole, so start from the current list.
    const url = `${cal(calendarId)}/events/${encodeURIComponent(event.id)}`
    const current = await google<GEvent>(accountId, `${url}?fields=attendees`)
    const attendees = (current.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: r } : a))
    await google(accountId, `${url}?sendUpdates=all`, { method: 'PATCH', body: { attendees } })
  },

  async createMeetingLink(accountId) {
    const space = await google<{ meetingUri?: string }>(accountId, 'https://meet.googleapis.com/v2/spaces', { method: 'POST', body: {} })
    if (!space.meetingUri) throw new Error('Google Meet did not return a meeting link')
    return space.meetingUri
  },
}
