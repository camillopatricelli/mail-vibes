import { ONLINE_MEETING_SCOPES } from '../auth/msal'
import { graph, type GraphPage } from '../providers/graph'
import { localDate, toDateKey, toTimeKey } from './dates'
import { findMeetingLink, type CalEvent, type CalendarInfo, type CalendarProvider, type EventDraft, type Response } from './types'

/** Outlook calendars via Microsoft Graph. */

interface GDateTime {
  dateTime: string
  timeZone: string
}
interface GEmail {
  emailAddress?: { name?: string; address?: string }
}
interface GEvent {
  id: string
  subject?: string
  start?: GDateTime
  end?: GDateTime
  isAllDay?: boolean
  location?: { displayName?: string }
  body?: { contentType?: string; content?: string }
  organizer?: GEmail
  isOrganizer?: boolean
  attendees?: (GEmail & { type?: string; status?: { response?: string } })[]
  responseStatus?: { response?: string }
  onlineMeeting?: { joinUrl?: string }
  isOnlineMeeting?: boolean
  seriesMasterId?: string
  isCancelled?: boolean
  webLink?: string
}

const FIELDS =
  'id,subject,start,end,isAllDay,location,body,organizer,isOrganizer,attendees,responseStatus,onlineMeeting,isOnlineMeeting,seriesMasterId,isCancelled,webLink'
const PREFER = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="html"' }

// Outlook's named calendar colours (used when a calendar has no explicit hex colour).
const NAMED: Record<string, string> = {
  lightBlue: '#4a8fe7',
  lightGreen: '#4caf50',
  lightOrange: '#f29d38',
  lightGray: '#8a8a8a',
  lightYellow: '#e3b505',
  lightTeal: '#1fa5a0',
  lightPink: '#e66cb0',
  lightBrown: '#a1745a',
  lightRed: '#e0524a',
  maxColor: '#4a8fe7',
}

function response(r: string | undefined, isOrganizer: boolean, hasAttendees: boolean): Response {
  switch (r) {
    case 'organizer':
      return 'organizer'
    case 'accepted':
      return 'accepted'
    case 'tentativelyAccepted':
      return 'tentative'
    case 'declined':
      return 'declined'
    case 'notResponded':
      return 'needsAction'
    default:
      return isOrganizer || !hasAttendees ? 'organizer' : 'needsAction'
  }
}

const parseTime = (dt: GDateTime | undefined, allDay: boolean) =>
  !dt ? 0 : allDay ? localDate(dt.dateTime) : Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(dt.dateTime) ? dt.dateTime : dt.dateTime + 'Z')

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function toEvent(accountId: string, calendarId: string, e: GEvent): CalEvent {
  const allDay = !!e.isAllDay
  const isOrganizer = !!e.isOrganizer
  const attendees = (e.attendees ?? [])
    .filter((a) => a.emailAddress?.address)
    .map((a) => ({
      name: a.emailAddress?.name ?? '',
      email: a.emailAddress!.address!,
      response: response(a.status?.response, false, true),
      optional: a.type === 'optional',
    }))
  const joinUrl = e.onlineMeeting?.joinUrl
  return {
    accountId,
    calendarId,
    id: e.id,
    title: e.subject ?? '',
    start: parseTime(e.start, allDay),
    end: parseTime(e.end, allDay),
    allDay,
    location: e.location?.displayName ?? '',
    descriptionHtml: e.body?.content ?? '',
    organizer: e.organizer?.emailAddress?.address
      ? { name: e.organizer.emailAddress.name ?? '', email: e.organizer.emailAddress.address }
      : undefined,
    isOrganizer,
    attendees,
    myResponse: response(e.responseStatus?.response, isOrganizer, attendees.length > 0),
    meeting: joinUrl ? { url: joinUrl, provider: 'teams' } : findMeetingLink(e.location?.displayName, e.body?.content),
    seriesId: e.seriesMasterId ?? undefined,
    cancelled: !!e.isCancelled,
    webLink: e.webLink,
  }
}

function dateTime(t: number, allDay: boolean): GDateTime {
  return { dateTime: `${toDateKey(t)}T${allDay ? '00:00' : toTimeKey(t)}:00`, timeZone: timeZone() }
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function recurrence(d: EventDraft) {
  if (d.repeat === 'none') return undefined
  const s = new Date(d.start)
  const pattern =
    d.repeat === 'daily'
      ? { type: 'daily', interval: 1 }
      : d.repeat === 'weekly'
        ? { type: 'weekly', interval: 1, daysOfWeek: [DAYS[s.getDay()]], firstDayOfWeek: 'monday' }
        : d.repeat === 'monthly'
          ? { type: 'absoluteMonthly', interval: 1, dayOfMonth: s.getDate() }
          : { type: 'absoluteYearly', interval: 1, dayOfMonth: s.getDate(), month: s.getMonth() + 1 }
  return { pattern, range: { type: 'noEnd', startDate: toDateKey(d.start) } }
}

function textToHtml(text: string) {
  const esc = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return esc.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>')
}

function body(d: Partial<EventDraft>) {
  const out: Record<string, unknown> = {}
  if (d.title !== undefined) out.subject = d.title
  if (d.start !== undefined && d.end !== undefined && d.allDay !== undefined) {
    out.start = dateTime(d.start, d.allDay)
    out.end = dateTime(d.end, d.allDay)
    out.isAllDay = d.allDay
  }
  if (d.location !== undefined || d.externalMeeting) {
    const loc = d.location ?? ''
    out.location = { displayName: d.externalMeeting ? (loc ? `${loc} · ${d.externalMeeting.url}` : d.externalMeeting.url) : loc }
  }
  if (d.description !== undefined) {
    const link = d.externalMeeting ? `\n\n${d.externalMeeting.url}` : ''
    out.body = { contentType: 'html', content: textToHtml(d.description + link) }
  }
  if (d.attendees !== undefined)
    out.attendees = d.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name || undefined }, type: 'required' }))
  if (d.nativeMeeting) {
    out.isOnlineMeeting = true
    out.onlineMeetingProvider = 'teamsForBusiness'
  }
  if (d.repeat && d.start !== undefined) {
    const r = recurrence(d as EventDraft)
    if (r) out.recurrence = r
  }
  return out
}

export const outlookCalendar: CalendarProvider = {
  async calendars(accountId) {
    type GCal = { id: string; name: string; hexColor?: string; color?: string; canEdit?: boolean; isDefaultCalendar?: boolean }
    const page = await graph<GraphPage<GCal>>(
      accountId,
      '/me/calendars?$top=100&$select=id,name,hexColor,color,canEdit,isDefaultCalendar',
    )
    return page.value.map(
      (c): CalendarInfo => ({
        accountId,
        id: c.id,
        name: c.name,
        color: c.hexColor || (c.color && NAMED[c.color]) || undefined,
        canEdit: c.canEdit !== false,
        isDefault: !!c.isDefaultCalendar,
      }),
    )
  },

  async events(accountId, calendarId, from, to) {
    const out: CalEvent[] = []
    let url: string | undefined =
      `/me/calendars/${encodeURIComponent(calendarId)}/calendarView?startDateTime=${new Date(from).toISOString()}` +
      `&endDateTime=${new Date(to).toISOString()}&$top=250&$select=${FIELDS}`
    while (url) {
      const page: GraphPage<GEvent> = await graph<GraphPage<GEvent>>(accountId, url, { headers: PREFER })
      out.push(...page.value.map((e) => toEvent(accountId, calendarId, e)))
      url = page['@odata.nextLink']
    }
    return out
  },

  async create(accountId, calendarId, draft) {
    await graph(accountId, `/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: body(draft) })
  },

  async update(accountId, _calendarId, eventId, draft) {
    await graph(accountId, `/me/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: body({ ...draft, repeat: undefined }) })
  },

  async remove(accountId, _calendarId, eventId) {
    // For meetings you organise, Outlook sends the cancellation to the attendees.
    await graph(accountId, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
  },

  async respond(accountId, _calendarId, event, r) {
    const action = r === 'accepted' ? 'accept' : r === 'tentative' ? 'tentativelyAccept' : 'decline'
    await graph(accountId, `/me/events/${encodeURIComponent(event.id)}/${action}`, { method: 'POST', body: { sendResponse: true } })
  },

  async createMeetingLink(accountId, title, start, end) {
    const m = await graph<{ joinWebUrl?: string; joinUrl?: string }>(accountId, '/me/onlineMeetings', {
      method: 'POST',
      scopes: ONLINE_MEETING_SCOPES,
      // A missing optional permission must not flag the whole account as signed out.
      quiet: true,
      body: { subject: title, startDateTime: new Date(start).toISOString(), endDateTime: new Date(end).toISOString() },
    })
    const url = m.joinWebUrl ?? m.joinUrl
    if (!url) throw new Error('Teams did not return a meeting link')
    return url
  },
}

export { textToHtml }
