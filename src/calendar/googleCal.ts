import { google } from '../providers/google'
import { localDate, toDateKey } from './dates'
import { textToHtml } from './outlookCal'
import { findMeetingLink, type CalEvent, type CalendarInfo, type CalendarProvider, type EventDraft, type Response } from './types'

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

const RRULE: Record<Exclude<EventDraft['repeat'], 'none'>, string> = {
  daily: 'RRULE:FREQ=DAILY',
  weekly: 'RRULE:FREQ=WEEKLY',
  monthly: 'RRULE:FREQ=MONTHLY',
  yearly: 'RRULE:FREQ=YEARLY',
}

function body(d: Partial<EventDraft>) {
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
  if (d.repeat && d.repeat !== 'none') out.recurrence = [RRULE[d.repeat]]
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

  async create(accountId, calendarId, draft) {
    await google(accountId, `${cal(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`, { method: 'POST', body: body(draft) })
  },

  async update(accountId, calendarId, eventId, draft) {
    await google(accountId, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all&conferenceDataVersion=1`, {
      method: 'PATCH',
      body: body({ ...draft, repeat: undefined }),
    })
  },

  async remove(accountId, calendarId, eventId) {
    await google(accountId, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' })
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
