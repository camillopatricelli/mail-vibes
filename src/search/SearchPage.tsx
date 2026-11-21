import { useQueries } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { calendarFor, calendarKey } from '../calendar/api'
import { useCalendars, type ShownEvent } from '../calendar/data'
import { EventDetails, EventEditor, type EditorTarget } from '../calendar/EventDialogs'
import { eventWhen } from '../calendar/format'
import type { CalEvent } from '../calendar/types'
import { displayName, listDate } from '../lib/format'
import { useLocation } from '../lib/router'
import { useMergedFolder } from '../mail/data'
import { mailHref, type MailView } from '../mail/routes'
import { useSettings } from '../settings/store'
import { useTasks, type ShownTask } from '../tasks/data'
import { TaskDialog, TaskRow } from '../tasks/TasksPage'
import { Card, Icon, type IconName } from '../ui/components'
import { Spinner } from '../ui/overlay'

const YEAR = 365 * 86_400_000

/** Every word of the query appears somewhere in the text (case-insensitive). */
export function matchesAll(query: string, ...texts: (string | undefined)[]) {
  const hay = texts.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

function Panel({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <Card className="today__panel">
      <header className="today__panel-head">
        <Icon name={icon} />
        <h2 className="title-medium">{title}</h2>
      </header>
      {children}
    </Card>
  )
}

function MailResults({ q }: { q: string }) {
  const { t } = useTranslation()
  const view: MailView = { kind: 'search', q }
  const { threads, errors, isLoading, hasMore, accounts } = useMergedFolder({ search: q })
  const colors = useSettings((s) => s.accounts)
  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (isLoading && !threads.length) return <Spinner label={t('mail.loading')} />
  const shown = threads.slice(0, 10)
  return (
    <>
      {errors.map(({ account, error }) => (
        <p key={account.id} className="body-small field-error" role="alert">
          {t('mail.loadFailed', { account: account.email, reason: error.message })}
        </p>
      ))}
      {!shown.length ? (
        <p className="body-medium muted">{t('search.noMail')}</p>
      ) : (
        <ul className="today-list">
          {shown.map((th) => (
            <li key={th.key} style={{ borderLeftColor: colors.find((a) => a.id === th.accountId)?.color }}>
              <a href={mailHref(view, { accountId: th.accountId, threadId: th.threadId })}>
                <span className="today-list__top">
                  <span className={th.unread ? 'body-medium today-list__from is-unread' : 'body-medium today-list__from'}>{th.participants.map(displayName).join(', ')}</span>
                  <span className="body-small muted">{listDate(th.date)}</span>
                </span>
                <span className="body-medium today-list__subject">{th.subject || t('mail.noSubject')}</span>
                <span className="body-small muted today-list__snippet">{th.snippet}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {(threads.length > shown.length || hasMore) && (
        <a href={mailHref(view)} className="btn btn--text">
          {t('search.allMail')}
        </a>
      )}
    </>
  )
}

function EventResults({ q }: { q: string }) {
  const { t } = useTranslation()
  const { calendars, accounts } = useCalendars()
  const shown = calendars.filter((c) => !c.hidden)
  const [now] = useState(() => Date.now())
  const results = useQueries({
    queries: shown.map((c) => ({
      queryKey: ['cal', 'search', c.accountId, c.id, q],
      queryFn: () => calendarFor(c.accountId).search(c.accountId, c.id, q, now - YEAR, now + YEAR),
      staleTime: 60_000,
    })),
  })
  const [open, setOpen] = useState<ShownEvent | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const events = useMemo(() => {
    const out: ShownEvent[] = []
    results.forEach((r, i) => {
      const c = shown[i]
      for (const e of (r.data as CalEvent[] | undefined) ?? [])
        out.push({ ...e, color: c.color ?? c.accountColor, accountColor: c.accountColor, calendarName: c.name, canEdit: c.canEdit })
    })
    // Upcoming events first (soonest first), then past ones (most recent first).
    const upcoming = out.filter((e) => e.end >= now).sort((a, b) => a.start - b.start)
    const past = out.filter((e) => e.end < now).sort((a, b) => b.start - a.start)
    return [...upcoming, ...past]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), shown.map((c) => calendarKey(c.accountId, c.id)).join(',')])
  const failed = results.map((r, i) => (r.error ? { cal: shown[i], error: r.error as Error } : null)).filter((x) => !!x)
  const loading = results.some((r) => r.isPending)

  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (loading && !events.length) return <Spinner label={t('mail.loading')} />
  return (
    <>
      {failed.slice(0, 3).map(({ cal, error }) => (
        <p key={calendarKey(cal.accountId, cal.id)} className="body-small field-error" role="alert">
          {t('search.calendarFailed', { calendar: cal.name, reason: error.message })}
        </p>
      ))}
      {!events.length ? (
        <p className="body-medium muted">{t('search.noEvents')}</p>
      ) : (
        <ul className="today-list">
          {events.slice(0, 20).map((e) => (
            <li key={`${e.accountId}|${e.calendarId}|${e.id}`} style={{ borderLeftColor: e.accountColor }} className={e.end < now ? 'is-past' : undefined}>
              <button type="button" className="today-list__button" onClick={() => setOpen(e)}>
                <span className="body-small muted">{eventWhen(e)}</span>
                <span className="body-medium today-list__subject">{e.title || t('calendar.noTitle')}</span>
                {e.location && <span className="body-small muted today-list__snippet">{e.location}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="body-small muted">{t('search.eventsRange')}</p>
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
    </>
  )
}

function TaskResults({ q }: { q: string }) {
  const { t } = useTranslation()
  const { tasks, isLoading, accounts } = useTasks()
  const [open, setOpen] = useState<ShownTask | null>(null)
  const found = useMemo(
    () => tasks.filter((x) => matchesAll(q, x.title, x.notes, x.mail?.subject)).sort((a, b) => Number(a.completed) - Number(b.completed) || (a.due ?? Infinity) - (b.due ?? Infinity)),
    [tasks, q],
  )
  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (isLoading && !tasks.length) return <Spinner label={t('mail.loading')} />
  return (
    <>
      {!found.length ? (
        <p className="body-medium muted">{t('search.noTasks')}</p>
      ) : (
        <ul className="task-list">
          {found.slice(0, 30).map((x) => (
            <TaskRow key={`${x.accountId}|${x.listId}|${x.id}`} task={x} onOpen={setOpen} showList />
          ))}
        </ul>
      )}
      {open && <TaskDialog task={open} onClose={() => setOpen(null)} />}
    </>
  )
}

export function SearchPage() {
  const { t } = useTranslation()
  const q = useLocation().params[0]?.trim() ?? ''
  if (!q) return <p className="body-large muted">{t('search.prompt')}</p>
  return (
    <div className="today">
      <h1 className="headline-small page-title">{t('search.resultsFor', { q })}</h1>
      <div className="today__panels">
        <Panel icon="mail" title={t('nav.mail')}>
          <MailResults q={q} />
        </Panel>
        <Panel icon="event" title={t('nav.calendar')}>
          <EventResults q={q} />
        </Panel>
        <Panel icon="task_alt" title={t('nav.tasks')}>
          <TaskResults q={q} />
        </Panel>
      </div>
    </div>
  )
}
