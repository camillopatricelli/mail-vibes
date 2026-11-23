import { useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasGoogleToken, reauthGoogle } from '../auth/google'
import { consentOnlineMeetings, hasOnlineMeetingConsent } from '../auth/msal'
import { RecipientField } from '../mail/Composer'
import { htmlToPlain } from '../mail/mime'
import { isValidEmail } from '../mail/addressBook'
import { accountLabel, accountLongLabel, useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { AccountBadge, Button, Icon, type IconName } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { describe, sameRule, type Recurrence } from '../lib/recurrence'
import { calendarFor, calendarKey } from './api'
import { calendarActions, useCalendars, type ShownEvent } from './data'
import { addDays, fromDateKey, startOfDay, toDateKey, toTimeKey, withTime } from './dates'
import { dateLocale, eventWhen } from './format'
import { leadText, LocationField, RecurrenceField, RemindersField } from './FormFields'
import { mapsUrl } from './places'
import { FilesField, FilesView, LinksField, LinksView, useStagedFiles } from './ItemFiles'
import type { Address } from '../mail/types'
import type { CalEvent, EventDraft, EventLink, MeetingChoice, Response, SeriesInfo } from './types'


function sanitizeDescription(html: string) {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'img', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'video', 'audio'],
    FORBID_ATTR: ['style', 'class', 'id'],
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  return doc.body.innerHTML
}

const responseIcon: Record<Response, IconName> = {
  accepted: 'check_circle',
  tentative: 'help',
  declined: 'close',
  needsAction: 'radio_button_unchecked',
  organizer: 'person_add',
  none: 'radio_button_unchecked',
}

/** Read-only details of an event, with RSVP, join, edit and delete. */
export function EventDetails({ event, onClose, onEdit }: { event: ShownEvent; onClose: () => void; onEdit: () => void }) {
  const { t } = useTranslation()
  const account = useSettings((s) => s.accounts.find((a) => a.id === event.accountId))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [response, setResponse] = useState(event.myResponse)
  const description = useMemo(() => sanitizeDescription(event.descriptionHtml), [event.descriptionHtml])
  const isInvite = !event.isOrganizer && event.myResponse !== 'organizer'
  const canEdit = event.canEdit && (event.isOrganizer || event.myResponse === 'organizer')

  const run = async (key: string, f: () => Promise<void>, close = false) => {
    setBusy(key)
    setError('')
    try {
      await f()
      if (close) onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const respond = (r: 'accepted' | 'tentative' | 'declined') =>
    run(r, async () => {
      await calendarActions.respond(event, r)
      setResponse(r)
    })

  const [askScope, setAskScope] = useState(false)
  const remove = () => {
    if (event.seriesId) return setAskScope(true)
    const msg = event.attendees.length && event.isOrganizer ? t('calendar.confirmDeleteMeeting') : t('calendar.confirmDelete')
    if (confirm(msg)) void run('delete', () => calendarActions.remove(event), true)
  }

  if (askScope)
    return (
      <SeriesScopeDialog
        title={t('calendar.deleteRecurring')}
        options={['one', 'following', 'all']}
        confirmLabel={t('calendar.delete')}
        note={event.attendees.length && event.isOrganizer ? t('calendar.guestsNotified') : undefined}
        onCancel={() => setAskScope(false)}
        onConfirm={(scope) => calendarActions.remove(event, scope).then(onClose)}
      />
    )

  const locationIsUrl = /^https?:\/\/\S+$/.test(event.location.trim())
  const series = useQuery({
    queryKey: ['cal', 'series', event.accountId, event.seriesId],
    enabled: !!event.seriesId,
    staleTime: 5 * 60_000,
    queryFn: () => calendarFor(event.accountId).series(event.accountId, event.calendarId, event.seriesId!),
  })
  const rule = series.data?.recurrence
  const filesOf = calendarFor(event.accountId).files

  return (
    <Dialog
      open
      onClose={onClose}
      title={event.title || t('calendar.noTitle')}
      className="event-dialog"
      actions={
        <>
      {event.webLink && (
        <a className="btn btn--text" href={event.webLink} target="_blank" rel="noopener noreferrer">
          {t(event.accountId.startsWith('google:') ? 'calendar.openGoogle' : 'calendar.openOutlook')}
        </a>
      )}
      <span className="spacer" />
      {event.canEdit && (
        <Button variant="text" icon="delete" disabled={!!busy} onClick={remove}>
          {t('calendar.delete')}
        </Button>
      )}
      {canEdit && (
        <Button variant="tonal" icon="edit" disabled={!!busy} onClick={onEdit}>
          {t('calendar.edit')}
        </Button>
      )}
        </>
      }
    >
      <div className="event-details">
        <p className="event-details__row">
          <Icon name="schedule" />
          <span>
            {eventWhen(event)}
            {event.seriesId && (
              <span className="body-small muted event-details__note">
                <Icon name="repeat" size={16} /> {rule ? describe(rule, series.data!.start, t, dateLocale()) : t('calendar.recurring')}
              </span>
            )}
          </span>
        </p>
        <p className="event-details__row">
          <span className="event-details__swatch" style={{ background: event.color }} />
          <span className="body-medium">
            {event.calendarName}
            {account && (
              <span className="event-details__account">
                <AccountBadge color={account.color} label={accountLabel(account)} size={16} /> {account.email}
              </span>
            )}
          </span>
        </p>
        {event.cancelled && <p className="field-error">{t('calendar.cancelled')}</p>}
        {event.meeting && (
          <p className="event-details__row">
            <Icon name="video_call" />
            <a className="btn btn--filled" href={event.meeting.url} target="_blank" rel="noopener noreferrer">
              {t(`calendar.join.${event.meeting.provider}`)}
            </a>
          </p>
        )}
        {event.location && (
          <p className="event-details__row">
            <Icon name="location_on" />
            {locationIsUrl ? (
              <a href={event.location.trim()} target="_blank" rel="noopener noreferrer" className="event-details__wrap">
                {event.location}
              </a>
            ) : (
              <a href={mapsUrl(event.location)} target="_blank" rel="noopener noreferrer" className="event-details__wrap" title={t('calendar.openMap')}>
                {event.location}
              </a>
            )}
          </p>
        )}
        {event.reminders.length > 0 && (
          <p className="event-details__row">
            <Icon name="notifications" />
            <span className="body-medium">{[...event.reminders].sort((a, b) => a - b).map((m) => leadText(m, t)).join(', ')}</span>
          </p>
        )}
        {(event.attendees.length > 0 || event.organizer) && (
          <div className="event-details__row">
            <Icon name="group" />
            <ul className="event-attendees">
              {event.organizer && (
                <li>
                  <span>{event.organizer.name || event.organizer.email}</span>
                  <span className="body-small muted">{t('calendar.organizer')}</span>
                </li>
              )}
              {event.attendees
                .filter((a) => a.email.toLowerCase() !== event.organizer?.email.toLowerCase())
                .map((a) => (
                  <li key={a.email} title={a.email}>
                    <Icon name={responseIcon[a.response]} size={18} className={`rsvp rsvp--${a.response}`} label={t(`calendar.response.${a.response}`)} />
                    <span>{a.name || a.email}</span>
                    {a.optional && <span className="body-small muted">{t('calendar.optional')}</span>}
                  </li>
                ))}
            </ul>
          </div>
        )}
        {description && (
          <div className="event-details__row">
            <Icon name="subject" />
            <div className="event-description body-medium" dangerouslySetInnerHTML={{ __html: description }} />
          </div>
        )}
        {event.hasFiles && filesOf && (
          <div className="event-details__row">
            <Icon name="attach_file" />
            <FilesView store={filesOf(event.accountId, event.calendarId, event.id)} accountId={event.accountId} itemId={event.id} />
          </div>
        )}
        {!!event.links?.length && (
          <div className="event-details__row">
            <Icon name="attach_file" />
            <LinksView links={event.links} />
          </div>
        )}
        {isInvite && !event.cancelled && (
          <div className="event-rsvp">
            <span className="body-medium">{t('calendar.going')}</span>
            {(['accepted', 'tentative', 'declined'] as const).map((r) => (
              <Button
                key={r}
                variant={response === r ? 'filled' : 'outlined'}
                disabled={!!busy}
                onClick={() => void respond(r)}
                icon={busy === r ? undefined : response === r ? 'check' : undefined}
              >
                {busy === r ? <Spinner size={16} /> : t(`calendar.rsvp.${r}`)}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}

type Scope = 'one' | 'following' | 'all'

/** Asks which occurrences of a recurring event an action applies to. */
function SeriesScopeDialog({
  title,
  options,
  confirmLabel,
  note,
  onCancel,
  onConfirm,
}: {
  title: string
  options: Scope[]
  confirmLabel: string
  note?: string
  onCancel: () => void
  onConfirm: (scope: Scope) => Promise<void>
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<Scope>('one')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async () => {
    setBusy(true)
    setError('')
    try {
      await onConfirm(scope)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      className="event-dialog"
      actions={
        <>
          <Button variant="text" onClick={onCancel} disabled={busy}>
            {t('calendar.cancel')}
          </Button>
          <Button onClick={() => void go()} disabled={busy}>
            {busy ? <Spinner size={16} /> : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="scope-options" role="radiogroup">
        {options.map((o) => (
          <label key={o} className="checkbox">
            <input type="radio" name="scope" checked={scope === o} onChange={() => setScope(o)} /> {t(`calendar.scope.${o}`)}
          </label>
        ))}
      </div>
      {note && <p className="body-small muted">{note}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

export type EditorTarget = { mode: 'create'; start: number; end: number; allDay: boolean } | { mode: 'edit'; event: ShownEvent }

function meetingValue(c: MeetingChoice) {
  return c.kind === 'none' ? 'none' : `${c.kind}:${c.accountId}`
}
function parseMeeting(v: string): MeetingChoice {
  const i = v.indexOf(':')
  const kind = v.slice(0, i)
  return kind === 'teams' || kind === 'meet' ? { kind, accountId: v.slice(i + 1) } : { kind: 'none' }
}

/** Create or edit an event. */
export function EventEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts)
  const defaults = useSettings((s) => s.defaults)
  const { calendars } = useCalendars()
  const editable = calendars.filter((c) => c.canEdit)
  const existing = target.mode === 'edit' ? target.event : undefined

  const initialCalendar = useMemo(() => {
    if (existing) return calendarKey(existing.accountId, existing.calendarId)
    const preferred =
      editable.find((c) => c.accountId === defaults.calendarAccountId && c.isDefault) ??
      editable.find((c) => c.isDefault && !c.hidden) ??
      editable[0]
    return preferred ? calendarKey(preferred.accountId, preferred.id) : ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable.length])

  const [calKey, setCalKey] = useState(initialCalendar)
  useEffect(() => {
    if (!calKey && initialCalendar) setCalKey(initialCalendar)
  }, [calKey, initialCalendar])
  const [title, setTitle] = useState(existing?.title ?? '')
  const [allDay, setAllDay] = useState(existing?.allDay ?? (target.mode === 'create' && target.allDay))
  const startTs = existing?.start ?? (target.mode === 'create' ? target.start : Date.now())
  const endTs = existing?.end ?? (target.mode === 'create' ? target.end : Date.now())
  const [startDate, setStartDate] = useState(toDateKey(startTs))
  const [startTime, setStartTime] = useState(toTimeKey(startTs))
  // All-day ends are exclusive in the providers but shown inclusive here.
  const [endDate, setEndDate] = useState(toDateKey(existing?.allDay || (target.mode === 'create' && target.allDay) ? addDays(endTs, -1) : endTs))
  const [endTime, setEndTime] = useState(toTimeKey(endTs))
  const [rule, setRule] = useState<Recurrence | null>(null)

  // Recurring events: edit this occurrence or the whole series.
  const [scope, setScope] = useState<'one' | 'all'>('one')
  const seriesMode = scope === 'all' && !!existing?.seriesId
  const series = useQuery({
    queryKey: ['cal', 'series', existing?.accountId, existing?.seriesId],
    enabled: seriesMode,
    queryFn: () => calendarFor(existing!.accountId).series(existing!.accountId, existing!.calendarId, existing!.seriesId!),
  })
  const seriesInfo: SeriesInfo | undefined = seriesMode ? series.data : undefined
  useEffect(() => {
    if (seriesInfo) setRule(seriesInfo.recurrence)
  }, [seriesInfo])
  // A single event can become a series; an occurrence edit leaves the rule alone.
  const showRepeat = !existing || seriesMode || !existing.seriesId
  const initialRule = seriesInfo ? seriesInfo.recurrence : null
  const [location, setLocation] = useState(existing?.location ?? '')
  const [attendees, setAttendees] = useState<Address[]>(existing?.attendees.map((a) => ({ name: a.name, email: a.email })) ?? [])
  const initialDescription = useMemo(() => (existing ? htmlToPlain(existing.descriptionHtml) : ''), [existing])
  const [description, setDescription] = useState(initialDescription)

  const calAccountId = calKey.split('|')[0]
  const calendar = calendars.find((c) => calendarKey(c.accountId, c.id) === calKey)
  const provider = calAccountId ? calendarFor(calAccountId) : undefined
  // New events start with the calendar's own default reminders (Outlook: 15 minutes).
  const defaultReminders = (calendar?.defaultReminders ?? (calAccountId.startsWith('microsoft:') ? [15] : [])).slice(0, provider?.maxReminders ?? 5)
  const [reminders, setReminders] = useState<number[] | null>(existing ? existing.reminders : null)
  const shownReminders = reminders ?? defaultReminders
  const defaultMeeting = (): MeetingChoice => {
    const a = accounts.find((x) => x.id === defaults.meetingAccountId)
    if (!a) return { kind: 'none' }
    return { kind: a.provider === 'microsoft' ? 'teams' : 'meet', accountId: a.id }
  }
  const [meeting, setMeeting] = useState<MeetingChoice>(existing ? { kind: 'none' } : defaultMeeting())
  const canAddMeeting = !existing?.meeting

  // Whether the chosen meeting can be created right now, or needs a click first.
  const external = meeting.kind !== 'none' && meeting.accountId !== calAccountId
  const [meetingReady, setMeetingReady] = useState<'checking' | 'ok' | 'needsConsent' | 'needsSignIn'>('ok')
  useEffect(() => {
    let cancelled = false
    if (meeting.kind === 'none' || !external) {
      setMeetingReady('ok')
      return
    }
    if (meeting.kind === 'meet') {
      setMeetingReady(hasGoogleToken(meeting.accountId) ? 'ok' : 'needsSignIn')
      return
    }
    setMeetingReady('checking')
    void hasOnlineMeetingConsent(meeting.accountId).then((ok) => !cancelled && setMeetingReady(ok ? 'ok' : 'needsConsent'))
    return () => {
      cancelled = true
    }
  }, [external, meeting])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Microsoft: files, uploaded on Save (to the series when editing it all). Google: links to Drive files.
  const filesId = existing ? (seriesMode && existing.seriesId ? existing.seriesId : existing.id) : undefined
  const calendarIdOf = (key: string) => key.slice(key.indexOf('|') + 1)
  const fileStore = provider?.files?.(calAccountId, calendarIdOf(calKey), filesId ?? '')
  const staged = useStagedFiles(fileStore, calAccountId, filesId, !!existing?.hasFiles || seriesMode)
  const [links, setLinks] = useState<EventLink[]>(existing?.links ?? [])
  const linksChanged = links.map((l) => l.url).join('\n') !== (existing?.links ?? []).map((l) => l.url).join('\n')
  const [progress, setProgress] = useState('')

  const start = allDay ? fromDateKey(startDate)! : withTime(fromDateKey(startDate) ?? Date.now(), startTime)
  const end = allDay ? addDays(fromDateKey(endDate) ?? start, 1) : withTime(fromDateKey(endDate) ?? Date.now(), endTime)

  const allowMeeting = async () => {
    setError('')
    try {
      if (meeting.kind === 'teams') {
        const ok = await consentOnlineMeetings(meeting.accountId)
        if (ok) setMeetingReady('ok')
      } else if (meeting.kind === 'meet') {
        const ok = await reauthGoogle(meeting.accountId)
        if (ok) setMeetingReady('ok')
      }
    } catch (e) {
      const msg = (e as Error).message
      setError(/AADSTS(90094|65001|90008)|admin/i.test(msg) ? t('calendar.teamsAdminNeeded') : msg)
    }
  }

  const save = async () => {
    setError('')
    if (!calKey) return setError(t('calendar.noCalendar'))
    if (!(end > start) && !(allDay && end >= start)) return setError(t('calendar.endBeforeStart'))
    const bad = attendees.find((a) => !isValidEmail(a.email))
    if (bad) return setError(t('calendar.invalidGuest', { address: bad.email }))
    if (seriesMode && !seriesInfo) return setError(t('calendar.seriesLoading'))
    const firstDay = seriesInfo ? startOfDay(seriesInfo.start) : startOfDay(start)
    if (rule?.until !== undefined && rule.until < firstDay) return setError(t('calendar.untilBeforeStart'))
    if (provider && shownReminders.some((m) => m > provider.maxReminderMinutes))
      return setError(t('reminders.tooEarly', { lead: leadText(provider.maxReminderMinutes, t) }))
    setSaving(true)
    try {
      const [accountId, calendarId] = [calKey.slice(0, calKey.indexOf('|')), calKey.slice(calKey.indexOf('|') + 1)]
      const draft: EventDraft = { title, start, end, allDay, location, attendees, recurrence: rule }
      if (reminders !== null) draft.reminders = reminders
      if (description !== initialDescription || !existing) draft.description = description
      if (provider?.supportsLinks && linksChanged) draft.links = links
      if (canAddMeeting && meeting.kind !== 'none') {
        if (!external) draft.nativeMeeting = true
        else {
          const url = await calendarFor(meeting.accountId).createMeetingLink(meeting.accountId, title || t('calendar.noTitle'), start, end)
          draft.externalMeeting = { url, provider: meeting.kind }
          if (draft.description === undefined) draft.description = description
        }
      }
      if (existing) {
        const changes: Partial<EventDraft> = {}
        if (title !== existing.title) changes.title = title
        if (seriesInfo) {
          // The series keeps its first date; times, length and repeat change for every occurrence.
          const masterStart = allDay ? startOfDay(seriesInfo.start) : withTime(startOfDay(seriesInfo.start), startTime)
          Object.assign(changes, { start: masterStart, end: masterStart + (end - start), allDay })
          if (!sameRule(rule, initialRule, masterStart)) changes.recurrence = rule
        } else {
          if (start !== existing.start || end !== existing.end || allDay !== existing.allDay || rule) Object.assign(changes, { start, end, allDay })
          if (rule) changes.recurrence = rule
        }
        if (reminders !== null && [...reminders].sort().join() !== [...existing.reminders].sort().join()) {
          changes.reminders = reminders
          changes.emailReminders = existing.emailReminders
        }
        if (location !== existing.location || draft.externalMeeting) changes.location = location
        const before = existing.attendees.map((a) => a.email.toLowerCase()).sort().join(',')
        if (attendees.map((a) => a.email.toLowerCase()).sort().join(',') !== before) changes.attendees = attendees
        if (draft.description !== undefined) changes.description = draft.description
        if (draft.nativeMeeting) changes.nativeMeeting = true
        if (draft.externalMeeting) changes.externalMeeting = draft.externalMeeting
        if (draft.links) changes.links = draft.links
        const anything = Object.keys(changes).length > 0
        if (anything) await calendarActions.update(existing as CalEvent, changes, seriesMode)
        if (fileStore && staged.changed) {
          await staged.apply(fileStore, accountId, filesId!, setProgress)
          calendarActions.filesSaved(accountId, !anything)
        }
      } else {
        const id = await calendarActions.create(accountId, calendarId, draft)
        const store = calendarFor(accountId).files?.(accountId, calendarId, id)
        if (store && staged.pending.length) {
          try {
            await staged.apply(store, accountId, id, setProgress)
          } catch (e) {
            // The event exists: say what is missing instead of offering to save it again.
            calendarActions.filesSaved(accountId, false)
            onClose()
            useStatus.getState().toast({ tone: 'error', message: (e as Error).message })
            return
          }
          calendarActions.filesSaved(accountId, false)
        }
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
      setProgress('')
    }
  }

  const byAccount = accounts
    .map((a) => ({ a, cals: editable.filter((c) => c.accountId === a.id) }))
    .filter((x) => x.cals.length)

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? t('calendar.editEvent') : t('calendar.newEvent')}
      className="event-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose} disabled={saving}>
            {t('calendar.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={saving || meetingReady === 'checking'} icon={saving ? undefined : 'check'}>
            {saving ? <Spinner size={16} /> : t('calendar.save')}
          </Button>
        </>
      }
    >
      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <input
          className="event-form__title"
          placeholder={t('calendar.titlePlaceholder')}
          aria-label={t('calendar.title')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        {existing?.seriesId && (
          <div className="scope-options scope-options--inline" role="radiogroup" aria-label={t('calendar.recurring')}>
            {(['one', 'all'] as const).map((o) => (
              <label key={o} className="checkbox">
                <input type="radio" name="edit-scope" checked={scope === o} onChange={() => setScope(o)} /> {t(`calendar.scope.${o}`)}
              </label>
            ))}
            <p className="body-small muted">
              {seriesMode ? t('calendar.seriesHint') : t('calendar.occurrenceOnly')}
            </p>
            {seriesMode && series.isLoading && <Spinner size={16} />}
            {seriesMode && series.error && <p className="field-error">{(series.error as Error).message}</p>}
          </div>
        )}

        <label className="event-form__row">
          <Icon name="calendar_month" />
          <select className="select" value={calKey} disabled={!!existing} onChange={(e) => setCalKey(e.target.value)} aria-label={t('calendar.calendar')}>
            {byAccount.map(({ a, cals }) => (
              <optgroup key={a.id} label={accountLongLabel(a)}>
                {cals.map((c) => (
                  <option key={c.id} value={calendarKey(c.accountId, c.id)}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="event-form__row event-form__when">
          <Icon name="schedule" />
          <div className="event-form__times">
            <span className="event-form__pair">
              <input type="date" className="select" value={startDate} disabled={seriesMode} aria-label={t('calendar.startDate')} onChange={(e) => {
                const prev = fromDateKey(startDate)
                const next = fromDateKey(e.target.value)
                setStartDate(e.target.value)
                // Keep the duration when the start date moves.
                if (prev !== undefined && next !== undefined) setEndDate(toDateKey(addDays(fromDateKey(endDate) ?? next, Math.round((next - prev) / 86_400_000))))
              }} />
              {!allDay && <input type="time" className="select" value={startTime} aria-label={t('calendar.startTime')} onChange={(e) => {
                const dur = end - start
                setStartTime(e.target.value)
                const ns = withTime(fromDateKey(startDate) ?? Date.now(), e.target.value)
                setEndDate(toDateKey(ns + dur))
                setEndTime(toTimeKey(ns + dur))
              }} />}
            </span>
            <span aria-hidden>–</span>
            <span className="event-form__pair">
              <input type="date" className="select" value={endDate} disabled={seriesMode} aria-label={t('calendar.endDate')} onChange={(e) => setEndDate(e.target.value)} />
              {!allDay && <input type="time" className="select" value={endTime} aria-label={t('calendar.endTime')} onChange={(e) => setEndTime(e.target.value)} />}
            </span>
            <label className="checkbox">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> {t('calendar.allDay')}
            </label>
          </div>
        </div>

        {showRepeat && (
          <div className="event-form__row event-form__when">
            <Icon name="repeat" />
            <RecurrenceField
              value={rule}
              onChange={setRule}
              start={seriesInfo ? seriesInfo.start : start}
              exact={!seriesInfo || seriesInfo.exact || !sameRule(rule, initialRule, seriesInfo.start) ? true : false}
              disabled={seriesMode && !seriesInfo}
            />
          </div>
        )}

        <div className="event-form__row event-form__when">
          <Icon name="notifications" />
          <RemindersField
            value={shownReminders}
            onChange={setReminders}
            start={start}
            max={provider?.maxReminders ?? 1}
            maxMinutes={provider?.maxReminderMinutes ?? 40320}
          />
        </div>

        <label className="event-form__row">
          <Icon name="video_call" />
          {canAddMeeting ? (
            <select className="select" value={meetingValue(meeting)} onChange={(e) => setMeeting(parseMeeting(e.target.value))} aria-label={t('calendar.meeting')}>
              <option value="none">{t('calendar.noMeeting')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={`${a.provider === 'microsoft' ? 'teams' : 'meet'}:${a.id}`}>
                  {t(a.provider === 'microsoft' ? 'calendar.teamsFrom' : 'calendar.meetFrom', { account: accountLongLabel(a) })}
                </option>
              ))}
            </select>
          ) : (
            <span className="body-medium">{t(`calendar.join.${existing!.meeting!.provider}`)}</span>
          )}
        </label>
        {canAddMeeting && meetingReady !== 'ok' && meetingReady !== 'checking' && (
          <div className="event-form__notice body-small">
            <span>{meetingReady === 'needsConsent' ? t('calendar.teamsNeedsConsent') : t('calendar.meetNeedsSignIn')}</span>
            <Button variant="tonal" onClick={() => void allowMeeting()}>
              {meetingReady === 'needsConsent' ? t('calendar.allowTeams') : t('banner.signIn')}
            </Button>
          </div>
        )}

        <div className="event-form__row">
          <Icon name="location_on" />
          <LocationField value={location} onChange={setLocation} />
        </div>

        <div className="event-form__row">
          <Icon name="group" />
          <div className="event-form__grow">
            <RecipientField label={t('calendar.guests')} placeholder={t('calendar.addGuests')} boxed value={attendees} onChange={setAttendees} />
          </div>
        </div>

        <label className="event-form__row">
          <Icon name="subject" />
          <textarea className="event-form__description event-form__grow" rows={4} placeholder={t('calendar.description')} aria-label={t('calendar.description')} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        {fileStore && <FilesField staged={staged} store={fileStore} />}
        {provider?.supportsLinks && <LinksField value={links} onChange={setLinks} />}
        {progress && (
          <p className="body-small muted" role="status">
            {progress}
          </p>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
