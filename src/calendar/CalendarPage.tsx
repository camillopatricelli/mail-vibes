import { accountLabel, useSettings } from '../settings/store'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../lib/time'
import { navigate, useLocation } from '../lib/router'
import { AccountBadge, Button, Icon, IconButton, type IconName } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { calendarKey } from './api'
import { toggleCalendar, useCalendars, useEvents, type ShownEvent } from './data'
import {
  addDays,
  DAY,
  fromDateKey,
  layoutDay,
  onDay,
  sameDay,
  startOfDay,
  startOfMonth,
  stepDate,
  toDateKey,
  viewRange,
  views,
  weekStartOf,
  type View,
} from './dates'
import { EventDetails, EventEditor, type EditorTarget } from './EventDialogs'
import { dayLong, hourLabel, timeOf, viewTitle, weekdayShort } from './format'

const HOUR_PX = 48
const viewIcons: Record<View, IconName> = { day: 'view_day', week: 'view_week', month: 'calendar_view_month', agenda: 'view_agenda' }

const isPhone = () => window.matchMedia('(max-width: 839px)').matches

/** Long timed events (a day or more) are shown in the all-day row, as Google Calendar does. */
const inAllDayRow = (e: ShownEvent) => e.allDay || e.end - e.start >= DAY

function chipClass(e: ShownEvent) {
  return ['event-chip', e.myResponse === 'declined' && 'is-declined', e.myResponse === 'needsAction' && 'is-pending', e.cancelled && 'is-declined']
    .filter(Boolean)
    .join(' ')
}

const chipStyle = (e: ShownEvent) => ({ '--event-color': e.color, '--account-color': e.accountColor }) as React.CSSProperties

function CalendarList() {
  const { t } = useTranslation()
  const { accounts, calendars, errors } = useCalendars()
  return (
    <div className="cal-list">
      {accounts.map((a) => {
        const cals = calendars.filter((c) => c.accountId === a.id)
        const err = errors.find((e) => e.account.id === a.id)
        return (
          <section key={a.id}>
            <h3 className="title-small cal-list__account">
              <AccountBadge color={a.color} label={accountLabel(a)} size={18} />
              <span>{accountLabel(a)}</span>
            </h3>
            {err && (
              <p className="body-small field-error" role="alert">
                {err.error.message}
              </p>
            )}
            <ul>
              {cals.map((c) => (
                <li key={c.id}>
                  <label className="cal-list__item">
                    <input
                      type="checkbox"
                      checked={!c.hidden}
                      onChange={() => toggleCalendar(c.accountId, c.id)}
                      style={{ accentColor: c.color ?? a.color }}
                    />
                    <span className="body-medium">{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {!accounts.length && <p className="body-medium muted">{t('accounts.addFirst')}</p>}
    </div>
  )
}

function EventChip({ e, onOpen, showTime = true }: { e: ShownEvent; onOpen: (e: ShownEvent) => void; showTime?: boolean }) {
  const { t } = useTranslation()
  return (
    <button type="button" className={chipClass(e)} style={chipStyle(e)} onClick={(ev) => (ev.stopPropagation(), onOpen(e))} title={e.title}>
      {showTime && !inAllDayRow(e) && <span className="event-chip__time">{timeOf(e.start)}</span>}
      <span className="event-chip__title">{e.title || t('calendar.noTitle')}</span>
    </button>
  )
}

function TimeGrid({
  days,
  events,
  onOpen,
  onCreate,
}: {
  days: number[]
  events: ShownEvent[]
  onOpen: (e: ShownEvent) => void
  onCreate: (t: EditorTarget) => void
}) {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Start scrolled to the working day (or an hour before now, if today is shown).
    const showsToday = days.some((d) => sameDay(d, Date.now()))
    const hour = showsToday ? Math.max(0, new Date().getHours() - 1) : 7
    scroller.current?.scrollTo({ top: hour * HOUR_PX })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], days.length])

  const allDay = events.filter(inAllDayRow)
  const timed = events.filter((e) => !inAllDayRow(e))
  const hours = Array.from({ length: 24 }, (_, h) => h)

  return (
    <div className="time-grid" style={{ '--days': days.length } as React.CSSProperties}>
      <div className="time-grid__head">
        <div className="time-grid__gutter" />
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className={['time-grid__day-head', sameDay(d, now) && 'is-today'].filter(Boolean).join(' ')}
            onClick={() => navigate('calendar', 'day', toDateKey(d))}
          >
            <span className="label-medium">{weekdayShort(d)}</span>
            <span className="time-grid__date">{new Date(d).getDate()}</span>
          </button>
        ))}
      </div>
      <div className="time-grid__allday">
        <div className="time-grid__gutter label-small muted">{allDay.length ? t('calendar.allDayShort') : ''}</div>
        {days.map((d) => (
          <div key={d} className="time-grid__allday-cell" onDoubleClick={() => onCreate({ mode: 'create', start: d, end: addDays(d, 1), allDay: true })}>
            {allDay.filter((e) => onDay(e, d)).map((e) => (
              <EventChip key={`${e.accountId}|${e.calendarId}|${e.id}`} e={e} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
      <div className="time-grid__body" ref={scroller}>
        <div className="time-grid__hours">
          {hours.map((h) => (
            <div key={h} className="time-grid__hour label-small muted">
              {h > 0 && hourLabel(new Date(2000, 0, 1, h).getTime())}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const next = addDays(d, 1)
          // Clip each event to this day (events can cross midnight).
          const segments = timed
            .filter((e) => e.start < next && e.end > d)
            .map((e) => ({ e, start: Math.max(e.start, d), end: Math.min(e.end, next) }))
          const placed = layoutDay(segments)
          const isToday = sameDay(d, now)
          return (
            <div
              key={d}
              className="time-grid__col"
              onClick={(ev) => {
                const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                const minutes = Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2) * 30
                const start = d + minutes * 60_000
                onCreate({ mode: 'create', start, end: start + 3_600_000, allDay: false })
              }}
            >
              {hours.map((h) => (
                <div key={h} className="time-grid__slot" />
              ))}
              {placed.map(({ item, col, cols }) => {
                const top = ((item.start - d) / 3_600_000) * HOUR_PX
                const height = Math.max(((item.end - item.start) / 3_600_000) * HOUR_PX, 18)
                const e = item.e
                return (
                  <button
                    key={`${e.accountId}|${e.calendarId}|${e.id}`}
                    type="button"
                    className={`${chipClass(e)} event-block`}
                    style={{ ...chipStyle(e), top, height, left: `${(col / cols) * 100}%`, width: `calc(${100 / cols}% - 2px)` }}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onOpen(e)
                    }}
                    title={`${e.title} · ${timeOf(e.start)} – ${timeOf(e.end)}`}
                  >
                    <span className="event-chip__title">{e.title || t('calendar.noTitle')}</span>
                    {height > 30 && (
                      <span className="event-block__time">
                        {timeOf(e.start)} – {timeOf(e.end)}
                      </span>
                    )}
                  </button>
                )
              })}
              {isToday && <div className="time-grid__now" style={{ top: ((now - d) / 3_600_000) * HOUR_PX }} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MonthGrid({
  from,
  month,
  events,
  onOpen,
  onCreate,
}: {
  from: number
  month: number
  events: ShownEvent[]
  onOpen: (e: ShownEvent) => void
  onCreate: (t: EditorTarget) => void
}) {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i))
  const max = 3
  return (
    <div className="month-grid">
      {days.slice(0, 7).map((d) => (
        <div key={`h${d}`} className="month-grid__weekday label-medium muted">
          {weekdayShort(d)}
        </div>
      ))}
      {days.map((d) => {
        const list = events.filter((e) => onDay(e, d))
        const other = new Date(d).getMonth() !== new Date(month).getMonth()
        return (
          <div
            key={d}
            className={['month-grid__cell', other && 'is-other'].filter(Boolean).join(' ')}
            onClick={() => onCreate({ mode: 'create', start: d + 9 * 3_600_000, end: d + 10 * 3_600_000, allDay: false })}
          >
            <button
              type="button"
              className={['month-grid__date', sameDay(d, now) && 'is-today'].filter(Boolean).join(' ')}
              onClick={(ev) => (ev.stopPropagation(), navigate('calendar', 'day', toDateKey(d)))}
            >
              {new Date(d).getDate()}
            </button>
            {list.slice(0, max).map((e) => (
              <EventChip key={`${e.accountId}|${e.calendarId}|${e.id}`} e={e} onOpen={onOpen} />
            ))}
            {list.length > max && (
              <button type="button" className="month-grid__more label-small" onClick={(ev) => (ev.stopPropagation(), navigate('calendar', 'day', toDateKey(d)))}>
                {t('calendar.more', { count: list.length - max })}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Agenda({ from, to, events, onOpen }: { from: number; to: number; events: ShownEvent[]; onOpen: (e: ShownEvent) => void }) {
  const { t } = useTranslation()
  const days: number[] = []
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d)
  const groups = days.map((d) => ({ d, list: events.filter((e) => onDay(e, d)) })).filter((g) => g.list.length)
  if (!groups.length) return <p className="body-medium muted agenda__empty">{t('calendar.nothingPlanned')}</p>
  return (
    <div className="agenda">
      {groups.map(({ d, list }) => (
        <section key={d} className="agenda__day">
          <h2 className={['title-small agenda__date', sameDay(d, Date.now()) && 'is-today'].filter(Boolean).join(' ')}>{dayLong(d)}</h2>
          <ul>
            {list.map((e) => (
              <li key={`${e.accountId}|${e.calendarId}|${e.id}`}>
                <button type="button" className={`agenda__item ${chipClass(e)}`} style={chipStyle(e)} onClick={() => onOpen(e)}>
                  <span className="agenda__time body-small">
                    {inAllDayRow(e) ? t('calendar.allDay') : `${timeOf(Math.max(e.start, d))} – ${timeOf(Math.min(e.end, addDays(d, 1)))}`}
                  </span>
                  <span className="agenda__dot" />
                  <span className="agenda__text">
                    <span className="body-medium">{e.title || t('calendar.noTitle')}</span>
                    {e.location && <span className="body-small muted">{e.location}</span>}
                  </span>
                  {e.meeting && <Icon name="video_call" size={18} className="muted" />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function CalendarPage() {
  const { t } = useTranslation()
  const { params } = useLocation()
  const view: View = views.includes(params[0] as View) ? (params[0] as View) : isPhone() ? 'agenda' : 'week'
  const date = fromDateKey(params[1]) ?? startOfDay(Date.now())
  const weekStart = weekStartOf(useSettings((s) => s.weekStart))
  const [from, to] = viewRange(view, date, weekStart)
  const { events, errors, isLoading, isFetching, refetch, accounts } = useEvents(from, to)
  const [open, setOpen] = useState<ShownEvent | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [showCalendars, setShowCalendars] = useState(false)
  const canCreate = accounts.length > 0

  const go = (v: View, d: number) => navigate('calendar', v, toDateKey(d))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable], dialog')) return
      if (e.key === 't') go(view, Date.now())
      else if (e.key === 'j' || e.key === 'n') go(view, stepDate(view, date, 1))
      else if (e.key === 'k' || e.key === 'p') go(view, stepDate(view, date, -1))
      else if (e.key === 'd' || e.key === 'w' || e.key === 'm' || e.key === 'a')
        go(({ d: 'day', w: 'week', m: 'month', a: 'agenda' } as const)[e.key], date)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const days = useMemo(() => {
    const n = view === 'day' ? 1 : 7
    return Array.from({ length: n }, (_, i) => addDays(from, i))
  }, [view, from])

  const create = (target: EditorTarget) => canCreate && setEditor(target)
  const newEvent = () => {
    const base = sameDay(date, Date.now()) ? Date.now() : date + 9 * 3_600_000
    const start = Math.ceil(base / 1_800_000) * 1_800_000
    create({ mode: 'create', start, end: start + 3_600_000, allDay: false })
  }

  return (
    <div className="calendar">
      <aside className="calendar__side">
        <button type="button" className="fab" onClick={newEvent} disabled={!canCreate}>
          <Icon name="add" />
          <span className="label-large">{t('calendar.create')}</span>
        </button>
        <CalendarList />
      </aside>
      <div className="calendar__main">
        <div className="calendar__toolbar">
          <Button variant="outlined" onClick={() => go(view, Date.now())}>
            {t('calendar.today')}
          </Button>
          <IconButton icon="chevron_left" label={t('calendar.previous')} onClick={() => go(view, stepDate(view, date, -1))} />
          <IconButton icon="chevron_right" label={t('calendar.next')} onClick={() => go(view, stepDate(view, date, 1))} />
          <h1 className="title-large calendar__title">{viewTitle(view, from, to, view === 'month' ? startOfMonth(date) : date)}</h1>
          {isFetching && <Spinner size={18} label={t('mail.loading')} />}
          <span className="spacer" />
          <IconButton icon="refresh" label={t('mail.refresh')} onClick={refetch} />
          <IconButton icon="filter_list" label={t('calendar.calendars')} className="calendar__calendars-btn" onClick={() => setShowCalendars(true)} />
          <div className="segmented" role="tablist" aria-label={t('calendar.view')}>
            {views.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={v === view}
                className={v === view ? 'is-selected' : undefined}
                onClick={() => go(v, date)}
                title={t(`calendar.views.${v}`)}
              >
                <Icon name={viewIcons[v]} size={18} />
                <span className="segmented__label">{t(`calendar.views.${v}`)}</span>
              </button>
            ))}
          </div>
        </div>
        {errors.map(({ account, error, refetch: retry }) => (
          <div key={account.id} className="banner banner--error" role="alert">
            <Icon name="error" />
            <div className="banner__text">
              <p className="body-medium">{t('calendar.loadFailed', { account: account.email, reason: error.message })}</p>
            </div>
            <Button variant="text" onClick={() => void retry()}>
              {t('banner.retry')}
            </Button>
          </div>
        ))}
        {isLoading ? (
          <Spinner label={t('mail.loading')} />
        ) : view === 'month' ? (
          <MonthGrid from={from} month={startOfMonth(date)} events={events} onOpen={setOpen} onCreate={create} />
        ) : view === 'agenda' ? (
          <Agenda from={from} to={to} events={events} onOpen={setOpen} />
        ) : (
          <TimeGrid days={days} events={events} onOpen={setOpen} onCreate={create} />
        )}
      </div>
      {canCreate && (
        <button type="button" className="fab fab--floating" onClick={newEvent} aria-label={t('calendar.create')}>
          <Icon name="add" />
        </button>
      )}
      {open && (
        <EventDetails
          event={open}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setEditor({ mode: 'edit', event: open })
            setOpen(null)
          }}
        />
      )}
      {editor && <EventEditor target={editor} onClose={() => setEditor(null)} />}
      <Dialog open={showCalendars} onClose={() => setShowCalendars(false)} title={t('calendar.calendars')}>
        <CalendarList />
      </Dialog>
    </div>
  )
}

export { calendarKey }
