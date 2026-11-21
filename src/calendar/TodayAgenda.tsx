import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { href } from '../lib/router'
import { useNow } from '../lib/time'
import { Spinner } from '../ui/overlay'
import { useEvents } from './data'
import { addDays, onDay, startOfDay, toDateKey } from './dates'
import { timeOf } from './format'

/** "Today's agenda" panel of the Today page. */
export function TodayAgenda() {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const from = startOfDay(now)
  const to = addDays(from, 1)
  const { events, errors, isLoading, accounts } = useEvents(from, to)
  // Finished events drop off; declined ones are not shown.
  const upcoming = useMemo(() => events.filter((e) => onDay(e, from) && e.end > now && e.myResponse !== 'declined' && !e.cancelled), [events, now, from])
  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (isLoading && !events.length) return <Spinner label={t('mail.loading')} />
  const shown = upcoming.slice(0, 8)
  return (
    <div className="today-mail">
      {errors.map(({ account, error }) => (
        <p key={account.id} className="body-small field-error" role="alert">
          {t('calendar.loadFailed', { account: account.email, reason: error.message })}
        </p>
      ))}
      {shown.length === 0 ? (
        <p className="body-medium muted">{t('calendar.nothingToday')}</p>
      ) : (
        <ul className="today-list">
          {shown.map((e) => (
            <li key={`${e.accountId}|${e.calendarId}|${e.id}`} style={{ borderLeftColor: e.accountColor }}>
              <a href={href('calendar', 'day', toDateKey(from))}>
                <span className="today-list__top">
                  <span className="body-small muted">
                    {e.allDay || e.end - e.start >= 86_400_000 ? t('calendar.allDay') : `${timeOf(e.start)} – ${timeOf(e.end)}`}
                  </span>
                  {e.myResponse === 'needsAction' && <span className="body-small today-agenda__pending">{t('calendar.response.needsAction')}</span>}
                </span>
                <span className="body-medium today-list__subject">{e.title || t('calendar.noTitle')}</span>
              </a>
              {e.meeting && e.start - now < 15 * 60_000 && (
                <a className="btn btn--tonal today-agenda__join" href={e.meeting.url} target="_blank" rel="noopener noreferrer">
                  {t(`calendar.join.${e.meeting.provider}`)}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      <a href={href('calendar', 'day', toDateKey(from))} className="btn btn--text">
        {upcoming.length > 8 ? t('calendar.moreToday', { count: upcoming.length - 8 }) : t('calendar.openCalendar')}
      </a>
    </div>
  )
}
