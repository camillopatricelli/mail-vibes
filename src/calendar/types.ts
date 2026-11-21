import type { Address } from '../mail/types'

/** Provider-neutral calendar model. Outlook (Graph) and Google Calendar adapters map to these. */

export interface CalendarInfo {
  accountId: string
  id: string
  name: string
  /** Calendar colour as #rrggbb (falls back to the account colour) */
  color?: string
  canEdit: boolean
  isDefault: boolean
}

export type Response = 'accepted' | 'tentative' | 'declined' | 'needsAction' | 'organizer' | 'none'

export interface Attendee extends Address {
  response: Response
  optional: boolean
}

export type MeetingProvider = 'teams' | 'meet' | 'other'

export interface CalEvent {
  accountId: string
  calendarId: string
  id: string
  title: string
  /** ms since epoch. For all-day events: local midnight of the first day */
  start: number
  /** Exclusive end. For all-day events: local midnight after the last day */
  end: number
  allDay: boolean
  location: string
  /** Sanitised before display */
  descriptionHtml: string
  organizer?: Address
  isOrganizer: boolean
  attendees: Attendee[]
  myResponse: Response
  meeting?: { url: string; provider: MeetingProvider }
  /** Set for occurrences of a recurring series */
  seriesId?: string
  cancelled: boolean
  webLink?: string
}

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Online meeting for a new event: none, Teams from a Microsoft account, or Meet from a Google account. */
export type MeetingChoice = { kind: 'none' } | { kind: 'teams'; accountId: string } | { kind: 'meet'; accountId: string }

export interface EventDraft {
  title: string
  start: number
  end: number
  allDay: boolean
  location: string
  /** Plain text; only sent when changed, so rich invitation bodies are not overwritten */
  description?: string
  attendees: Address[]
  repeat: Repeat
  /** A meeting link created in another account, to add to the event */
  externalMeeting?: { url: string; provider: MeetingProvider }
  /** Ask the event's own provider to add Teams (Microsoft) or Meet (Google) */
  nativeMeeting?: boolean
}

export interface CalendarProvider {
  calendars(accountId: string): Promise<CalendarInfo[]>
  events(accountId: string, calendarId: string, from: number, to: number): Promise<CalEvent[]>
  create(accountId: string, calendarId: string, draft: EventDraft): Promise<void>
  /** Updates one event (for a recurring series: only this occurrence) */
  update(accountId: string, calendarId: string, eventId: string, draft: Partial<EventDraft>): Promise<void>
  remove(accountId: string, calendarId: string, eventId: string): Promise<void>
  respond(accountId: string, calendarId: string, event: CalEvent, response: 'accepted' | 'tentative' | 'declined'): Promise<void>
  /** Creates a stand-alone meeting link in this account (for an event in another account) */
  createMeetingLink(accountId: string, title: string, start: number, end: number): Promise<string>
}

const MEETING_PATTERNS: [MeetingProvider, RegExp][] = [
  ['teams', /https:\/\/teams\.(microsoft|live)\.com\/(l\/meetup-join|meet)\/[^\s"'<>)]+/i],
  ['meet', /https:\/\/meet\.google\.com\/[a-z0-9-]+/i],
  ['other', /https:\/\/[a-z0-9.-]*zoom\.us\/j\/[^\s"'<>)]+/i],
]

/** Finds a meeting link in free text (location or description). */
export function findMeetingLink(...texts: (string | undefined)[]): CalEvent['meeting'] {
  for (const text of texts) {
    if (!text) continue
    for (const [provider, re] of MEETING_PATTERNS) {
      const m = re.exec(text)
      if (m) return { url: m[0].replace(/&amp;/g, '&'), provider }
    }
  }
  return undefined
}
