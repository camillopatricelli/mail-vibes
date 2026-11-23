import { google } from '../providers/google'
import { parseRRule, toRRule } from '../lib/recurrence'
import { addDays, localDate, startOfDay, toDateKey } from './dates'
import { textToHtml } from './outlookCal'
import { findMeetingLink, type CalEvent, type CalendarInfo, type CalendarProvider, type EventDraft, type EventLink, type Response } from './types'
import i18n from '../i18n'

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
  reminders?: { useDefault?: boolean; overrides?: GReminder[] }
  attachments?: { fileUrl?: string; title?: string; fileId?: string; mimeType?: string; iconLink?: string }[]
}
interface GReminder {
  method?: string
  minutes?: number
}
const minutesOf = (rs: GReminder[] | undefined, method: string) =>
  (rs ?? []).filter((r) => r.method === method && typeof r.minutes === 'number').map((r) => r.minutes!).sort((a, b) => a - b)

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
    remindersDefault: e.reminders?.useDefault !== false,
    reminders: e.reminders?.useDefault === false ? minutesOf(e.reminders.overrides, 'popup') : [],
    emailReminders: e.reminders?.useDefault === false ? minutesOf(e.reminders.overrides, 'email') : [],
    links: (e.attachments ?? [])
      .filter((a) => a.fileUrl)
      .map((a): EventLink => ({ url: a.fileUrl!, title: a.title || a.fileUrl!, fileId: a.fileId, mimeType: a.mimeType, iconLink: a.iconLink })),
  }
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function gTime(t: number, allDay: boolean): GTime {
  return allDay ? { date: toDateKey(t) } : { dateTime: new Date(t).toISOString(), timeZone: timeZone() }
}

/** RRULE UNTIL value: a date for all-day events, otherwise a UTC date-time. */
function untilValue(t: number, allDay: boolean) {
  if (allDay) return toDateKey(t).replace(/-/g, '')
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** The recurrence lines for a new event or a series edit (undefined = leave as is). */
function recurrence(d: Partial<EventDraft>, existing: boolean): string[] | undefined {
  if (d.recurrence === undefined || d.start === undefined) return undefined
  // A series edited to "does not repeat" keeps only its first occurrence.
  if (d.recurrence === null) return existing ? ['RRULE:FREQ=DAILY;COUNT=1'] : undefined
  return [toRRule(d.recurrence, d.start, !!d.allDay)]
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
  if (d.links !== undefined)
    out.attachments = d.links.map((l) => ({ fileUrl: l.url, title: l.title, fileId: l.fileId, mimeType: l.mimeType, iconLink: l.iconLink }))
  if (d.reminders !== undefined)
    out.reminders = {
      useDefault: false,
      overrides: [...d.reminders.map((minutes) => ({ method: 'popup', minutes })), ...(d.emailReminders ?? []).map((minutes) => ({ method: 'email', minutes }))],
    }
  return out
}

const cal = (id: string) => `${API}/calendars/${encodeURIComponent(id)}`

export const googleCalendar: CalendarProvider = {
  supportsLinks: true,
  maxReminders: 5,
  maxReminderMinutes: 40320,

  async calendars(accountId) {
    type GCal = { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; primary?: boolean; defaultReminders?: GReminder[] }
    const r = await google<{ items?: GCal[] }>(accountId, `${API}/users/me/calendarList?maxResults=250`)
    return (r.items ?? []).map(
      (c): CalendarInfo => ({
        accountId,
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        color: c.backgroundColor,
        canEdit: c.accessRole === 'owner' || c.accessRole === 'writer',
        isDefault: !!c.primary,
        defaultReminders: minutesOf(c.defaultReminders, 'popup'),
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
    const e = await google<{ id: string }>(accountId, `${cal(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1&supportsAttachments=true`, {
      method: 'POST',
      body: body(draft),
    })
    return e.id
  },

  async update(accountId, calendarId, eventId, draft) {
    const url = `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`
    const out = body(draft, true)
    if (Array.isArray(out.recurrence) && draft.recurrence) {
      // Keep the skipped dates (EXDATE) and extra ones of the series.
      const cur = await google<{ recurrence?: string[] }>(accountId, `${url}?fields=recurrence`)
      out.recurrence = [...(out.recurrence as string[]), ...(cur.recurrence ?? []).filter((r) => !/^RRULE:/i.test(r))]
    }
    await google(accountId, `${url}?sendUpdates=all&conferenceDataVersion=1&supportsAttachments=true`, { method: 'PATCH', body: out })
  },

  async remove(accountId, calendarId, eventId) {
    await google(accountId, `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' })
  },

  async series(accountId, calendarId, seriesId) {
    const e = await google<GEvent & { recurrence?: string[] }>(
      accountId,
      `${cal(calendarId)}/events/${encodeURIComponent(seriesId)}?fields=start,end,recurrence`,
    )
    const start = parseTime(e.start)
    const { rule, exact } = parseRRule(e.recurrence, start)
    return { start, end: parseTime(e.end), allDay: !!e.start?.date, recurrence: rule?.count === 1 ? null : rule, exact }
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
    if (!space.meetingUri) throw new Error(i18n.t('errors.meetLink'))
    return space.meetingUri
  },
}
