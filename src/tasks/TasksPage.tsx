import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { addDays, fromDateKey, startOfDay, toDateKey, toTimeKey, withTime } from '../calendar/dates'
import { RecurrenceField } from '../calendar/FormFields'
import { dateLocale } from '../calendar/format'
import { describe, sameRule, type Recurrence } from '../lib/recurrence'
import { navigate, useLocation } from '../lib/router'
import { accountLabel, accountLongLabel, useSettings } from '../settings/store'
import { AccountBadge, Button, Icon, IconButton } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { notesWithoutMail } from './mailLink'
import { openMailLink } from './mailOpen'
import { defaultListKey, listKey, taskActions, toggleTaskList, useTaskLists, useTasks, type ShownTask } from './data'

type Group = 'date' | 'list'

/** "Today", "Tomorrow", "Mon 24 Nov" … */
/** Whole calendar days from a to b (both local midnights; rounding absorbs daylight-saving shifts). */
function daysBetween(a: number, b: number) {
  return Math.round((b - a) / 86_400_000)
}

export function dueLabel(due: number, t: (k: string) => string) {
  const today = startOfDay(Date.now())
  if (due === today) return t('tasks.today')
  if (due === addDays(today, 1)) return t('tasks.tomorrow')
  if (due === addDays(today, -1)) return t('tasks.yesterday')
  const sameYear = new Date(due).getFullYear() === new Date(today).getFullYear()
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(due)
}

/** "Today 18:00", "Mon 24 Nov 9:00" */
function reminderLabel(at: number, t: (k: string) => string) {
  return `${dueLabel(startOfDay(at), t)} ${toTimeKey(at)}`
}

export function TaskRow({ task, onOpen, showList }: { task: ShownTask; onOpen: (t: ShownTask) => void; showList?: boolean }) {
  const { t } = useTranslation()
  const account = useSettings((s) => s.accounts.find((a) => a.id === task.accountId))
  const today = startOfDay(Date.now())
  const overdue = !task.completed && task.due !== undefined && task.due < today
  // Multi-day task under way: "day 3 of 10".
  const span =
    task.start !== undefined && task.due !== undefined && !task.completed && task.start <= today && today <= task.due
      ? { day: daysBetween(task.start, today) + 1, total: daysBetween(task.start, task.due) + 1 }
      : null
  const notes = task.mail ? notesWithoutMail(task.notes) : task.notes
  return (
    <li className={['task-row', task.completed && 'is-completed', task.parentId && 'is-subtask'].filter(Boolean).join(' ')} style={{ borderLeftColor: task.accountColor }}>
      <button
        type="button"
        className="task-row__check"
        aria-label={task.completed ? t('tasks.markNotDone') : t('tasks.markDone')}
        title={task.completed ? t('tasks.markNotDone') : t('tasks.markDone')}
        onClick={() => void taskActions.setCompleted(task, !task.completed)}
      >
        <Icon name={task.completed ? 'check_circle' : 'radio_button_unchecked'} filled={task.completed} />
        {!task.completed && <Icon name="check" size={16} className="task-row__check-hover" />}
      </button>
      <button type="button" className="task-row__body" onClick={() => onOpen(task)}>
        <span className="task-row__title body-large">{task.title || t('tasks.noTitle')}</span>
        {notes && <span className="task-row__notes body-small muted">{notes}</span>}
        {(task.due !== undefined || task.reminder !== undefined || showList) && (
          <span className="task-row__meta">
            {task.due !== undefined && (
              <span className={['task-chip label-medium', overdue && 'is-overdue', span && 'is-ongoing'].filter(Boolean).join(' ')}>
                <Icon name={task.start !== undefined ? 'date_range' : 'event'} size={14} />
                {task.start !== undefined ? `${dueLabel(task.start, t)} – ${dueLabel(task.due, t)}` : dueLabel(task.due, t)}
                {span && <span className="task-chip__progress">{t('tasks.dayOf', { day: span.day, total: span.total })}</span>}
              </span>
            )}
            {task.reminder !== undefined && !task.completed && (
              <span className="task-chip label-medium" title={t('tasks.reminder')}>
                <Icon name="notifications" size={14} />
                {reminderLabel(task.reminder, t)}
              </span>
            )}
            {task.recurrence && (
              <span className="task-chip label-medium" title={describe(task.recurrence, task.due ?? Date.now(), t, dateLocale())}>
                <Icon name="repeat" size={14} />
              </span>
            )}
            {showList && (
              <span className="task-row__list body-small muted">
                {account && <AccountBadge color={account.color} label={accountLabel(account)} size={14} />}
                {task.listName}
              </span>
            )}
          </span>
        )}
      </button>
      {task.mail && (
        <IconButton
          icon="mail"
          className="task-row__mail"
          label={task.mail.subject ? t('tasks.openMailNamed', { subject: task.mail.subject }) : t('tasks.openMail')}
          onClick={() => task.mail && void openMailLink(task.mail, task.accountId)}
        />
      )}
      {task.important && <Icon name="star" filled size={18} className="task-row__star" label={t('tasks.important')} />}
    </li>
  )
}

function ListPanel() {
  const { t } = useTranslation()
  const { accounts, lists, errors } = useTaskLists()
  return (
    <div className="cal-list">
      {accounts.map((a) => {
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
              {lists
                .filter((l) => l.accountId === a.id)
                .map((l) => (
                  <li key={l.id}>
                    <label className="cal-list__item">
                      <input type="checkbox" checked={!l.hidden} onChange={() => toggleTaskList(l.accountId, l.id)} style={{ accentColor: a.color }} />
                      <span className="body-medium">{l.name}</span>
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

/** Picker of the lists new tasks can go to, grouped by account. */
export function ListSelect({ value, onChange, className = 'select' }: { value: string; onChange: (key: string) => void; className?: string }) {
  const { t } = useTranslation()
  const { lists } = useTaskLists()
  const accounts = useSettings((s) => s.accounts)
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('tasks.list')}>
      {accounts.map((a) => {
        const own = lists.filter((l) => l.accountId === a.id && !l.readOnly)
        if (!own.length) return null
        return (
          <optgroup key={a.id} label={accountLongLabel(a)}>
            {own.map((l) => (
              <option key={l.id} value={listKey(l.accountId, l.id)}>
                {l.name}
              </option>
            ))}
          </optgroup>
        )
      })}
    </select>
  )
}

function QuickAdd() {
  const { t } = useTranslation()
  const { lists } = useTaskLists()
  const defaultAccount = useSettings((s) => s.defaults.taskAccountId)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const key = target || defaultListKey(lists, defaultAccount)

  const add = async () => {
    if (!title.trim() || !key || busy) return
    const i = key.indexOf('|')
    setBusy(true)
    setError('')
    try {
      await taskActions.create(key.slice(0, i), key.slice(i + 1), { title: title.trim(), notes: '', due: fromDateKey(due) ?? null })
      setTitle('')
      setDue('')
    } catch (e) {
      setError(t('tasks.addFailed', { reason: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  if (!lists.some((l) => !l.readOnly)) return null
  return (
    <div className="quick-add">
      <div className="quick-add__row">
        {busy ? <Spinner size={20} /> : <Icon name="add" className="quick-add__icon" />}
        <input
          className="quick-add__input body-large"
          placeholder={t('tasks.addPlaceholder')}
          aria-label={t('tasks.addPlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          disabled={busy}
        />
        <input type="date" className="select quick-add__date" value={due} onChange={(e) => setDue(e.target.value)} aria-label={t('tasks.due')} />
        <ListSelect className="select quick-add__list" value={key} onChange={setTarget} />
        <Button variant="tonal" onClick={() => void add()} disabled={!title.trim() || busy}>
          {t('tasks.add')}
        </Button>
      </div>
      {error && (
        <p className="field-error body-small" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function TaskDialog({ task, onClose }: { task: ShownTask; onClose: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [due, setDue] = useState(task.due !== undefined ? toDateKey(task.due) : '')
  const [start, setStart] = useState(task.start !== undefined ? toDateKey(task.start) : '')
  const [reminder, setReminder] = useState(task.reminder !== undefined ? `${toDateKey(task.reminder)}T${toTimeKey(task.reminder)}` : '')
  const [rule, setRule] = useState<Recurrence | null>(task.recurrence ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const account = useSettings((s) => s.accounts.find((a) => a.id === task.accountId))

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await f()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const startTs = fromDateKey(start)
  // Only a start date: the task is due that day too. Repeating tasks need a due date to repeat from.
  const dueTs = fromDateKey(due) ?? startTs ?? (rule ? startOfDay(Date.now()) : undefined)
  const reminderTs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(reminder) ? withTime(fromDateKey(reminder.slice(0, 10))!, reminder.slice(11)) : undefined
  const save = () => {
    if (startTs !== undefined && dueTs !== undefined && startTs > dueTs) return setError(t('tasks.startAfterDue'))
    return run(async () => {
      const change: Parameters<typeof taskActions.update>[1] = {}
      if (title !== task.title) change.title = title
      if (notes !== task.notes) change.notes = notes
      const newDue = dueTs ?? null
      if (newDue !== (task.due ?? null)) change.due = newDue
      // A start on the due date is no separate start.
      const newStart = startTs !== undefined && startTs !== dueTs ? startTs : null
      if (newStart !== (task.start ?? null)) change.start = newStart
      if ((reminderTs ?? null) !== (task.reminder ?? null)) change.reminder = reminderTs ?? null
      if (!sameRule(rule, task.recurrence, dueTs ?? Date.now())) {
        change.recurrence = rule
        // To Do anchors the rule at the due date, so it goes along.
        change.due ??= newDue
      }
      if (Object.keys(change).length) await taskActions.update(task, change)
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tasks.editTask')}
      className="event-dialog"
      actions={
        <>
          <Button variant="text" icon="delete" disabled={busy} onClick={() => confirm(t('tasks.confirmDelete')) && void run(() => taskActions.remove(task))}>
            {t('tasks.delete')}
          </Button>
          <span className="spacer" />
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('calendar.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !title.trim()} icon={busy ? undefined : 'check'}>
            {busy ? <Spinner size={16} /> : t('calendar.save')}
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
        <input className="event-form__title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('tasks.title')} placeholder={t('tasks.title')} autoFocus />
        <label className="event-form__row">
          <Icon name="subject" />
          <textarea className="event-form__description event-form__grow" rows={4} placeholder={t('tasks.notes')} aria-label={t('tasks.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="event-form__row task-dates">
          <Icon name="event" />
          <label className="task-dates__field">
            <span className="body-small muted">{t('tasks.start')}</span>
            <input type="date" className="select" value={start} max={due || undefined} onChange={(e) => setStart(e.target.value)} aria-label={t('tasks.start')} />
          </label>
          <label className="task-dates__field">
            <span className="body-small muted">{t('tasks.due')}</span>
            <input type="date" className="select" value={due} min={start || undefined} placeholder={start} onChange={(e) => setDue(e.target.value)} aria-label={t('tasks.due')} />
          </label>
          {(due || start) && (
            <IconButton
              icon="close"
              label={t('tasks.clearDue')}
              onClick={() => {
                setDue('')
                setStart('')
              }}
            />
          )}
        </div>
        {start && !due && <p className="body-small muted task-dates__hint">{t('tasks.dueSameAsStart')}</p>}
        <div className="event-form__row">
          <Icon name="notifications" />
          {reminder ? (
            <>
              <input type="datetime-local" className="select" value={reminder} onChange={(e) => setReminder(e.target.value)} aria-label={t('tasks.reminder')} />
              <IconButton icon="close" label={t('tasks.noReminder')} onClick={() => setReminder('')} />
            </>
          ) : (
            <Button
              variant="text"
              icon="add"
              onClick={() => {
                // Default: 9:00 on the due date (or tomorrow, if that's past).
                let at = withTime(dueTs ?? addDays(startOfDay(Date.now()), 1), '09:00')
                if (at < Date.now()) at = withTime(addDays(startOfDay(Date.now()), 1), '09:00')
                setReminder(`${toDateKey(at)}T${toTimeKey(at)}`)
              }}
            >
              {t('tasks.addReminder')}
            </Button>
          )}
        </div>
        <div className="event-form__row event-form__when">
          <Icon name="repeat" />
          <RecurrenceField value={rule} onChange={setRule} start={dueTs ?? startOfDay(Date.now())} />
        </div>
        {rule && task.accountId.startsWith('google:') && <p className="body-small muted task-dates__hint">{t('tasks.repeatGoogleNote')}</p>}
        <p className="event-form__row body-medium">
          <Icon name="task_alt" />
          <span>
            {task.listName}
            {account && <span className="body-small muted"> · {account.email}</span>}
          </span>
        </p>
        {task.mail && (
          <div className="event-form__row body-medium">
            <Icon name="mail" />
            <span className="event-form__grow">{task.mail.subject || t('tasks.linkedMail')}</span>
            <Button
              variant="tonal"
              icon="mail"
              onClick={() => {
                if (!task.mail) return
                onClose()
                void openMailLink(task.mail, task.accountId)
              }}
            >
              {t('tasks.openMail')}
            </Button>
            {task.mail.url && (
              <a className="icon-btn icon-btn--standard" href={task.mail.url} target="_blank" rel="noopener noreferrer" aria-label={t('tasks.openOnWeb')} title={t('tasks.openOnWeb')}>
                <Icon name="open_in_new" />
              </a>
            )}
          </div>
        )}
        {task.webLink && (
          <a className="btn btn--text" href={task.webLink} target="_blank" rel="noopener noreferrer">
            {t('tasks.openGoogle')}
          </a>
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

const byDue = (a: ShownTask, b: ShownTask) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.title.localeCompare(b.title)

/** Orders a list like Google Tasks: by position, with sub-tasks under their parent. */
function listOrder(tasks: ShownTask[]) {
  const top = tasks.filter((t) => !t.parentId || !tasks.some((p) => p.id === t.parentId)).sort((a, b) => a.position.localeCompare(b.position))
  return top.flatMap((p) => [p, ...tasks.filter((c) => c.parentId === p.id).sort((a, b) => a.position.localeCompare(b.position))])
}

export function TasksPage() {
  const { t } = useTranslation()
  const { params } = useLocation()
  const group: Group = params[0] === 'list' ? 'list' : 'date'
  const { tasks, lists, errors, isLoading, isFetching, refetch, accounts } = useTasks()
  const [open, setOpen] = useState<ShownTask | null>(null)
  const [showLists, setShowLists] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)

  const openTasks = tasks.filter((x) => !x.completed)
  const completed = useMemo(() => tasks.filter((x) => x.completed).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)), [tasks])

  const sections = useMemo(() => {
    if (group === 'list') {
      return lists
        .filter((l) => !l.hidden)
        .map((l) => ({ key: listKey(l.accountId, l.id), title: l.name, accountId: l.accountId, items: listOrder(openTasks.filter((x) => x.accountId === l.accountId && x.listId === l.id)) }))
    }
    const today = startOfDay(Date.now())
    const buckets: { key: string; title: string; test: (d?: number) => boolean }[] = [
      { key: 'overdue', title: t('tasks.overdue'), test: (d) => d !== undefined && d < today },
      { key: 'today', title: t('tasks.today'), test: (d) => d === today },
      { key: 'tomorrow', title: t('tasks.tomorrow'), test: (d) => d === addDays(today, 1) },
      { key: 'week', title: t('tasks.next7'), test: (d) => d !== undefined && d > addDays(today, 1) && d < addDays(today, 8) },
      { key: 'later', title: t('tasks.later'), test: (d) => d !== undefined && d >= addDays(today, 8) },
      { key: 'none', title: t('tasks.noDate'), test: (d) => d === undefined },
    ]
    return buckets.map((b) => ({ key: b.key, title: b.title, accountId: undefined as string | undefined, items: openTasks.filter((x) => b.test(x.due)).sort(byDue) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, tasks, lists, t])

  const accountsById = useSettings((s) => s.accounts)

  return (
    <div className="calendar tasks">
      <aside className="calendar__side">
        <h2 className="title-small tasks__side-title">{t('tasks.lists')}</h2>
        <ListPanel />
      </aside>
      <div className="calendar__main tasks__main">
        <div className="calendar__toolbar">
          <h1 className="title-large calendar__title">{t('nav.tasks')}</h1>
          {isFetching && <Spinner size={18} label={t('mail.loading')} />}
          <span className="spacer" />
          <IconButton icon="refresh" label={t('mail.refresh')} onClick={refetch} />
          <IconButton icon="filter_list" label={t('tasks.lists')} className="calendar__calendars-btn" onClick={() => setShowLists(true)} />
          <div className="segmented" role="tablist" aria-label={t('tasks.groupBy')}>
            {(['date', 'list'] as Group[]).map((g) => (
              <button key={g} type="button" role="tab" aria-selected={g === group} className={g === group ? 'is-selected' : undefined} onClick={() => navigate('tasks', g)}>
                <Icon name={g === 'date' ? 'event' : 'view_agenda'} size={18} />
                <span className="segmented__label">{t(`tasks.by.${g}`)}</span>
              </button>
            ))}
          </div>
        </div>
        {errors.map(({ account, error, refetch: retry }) => (
          <div key={account.id} className="banner banner--error" role="alert">
            <Icon name="error" />
            <div className="banner__text">
              <p className="body-medium">{t('tasks.loadFailed', { account: account.email, reason: error.message })}</p>
            </div>
            <Button variant="text" onClick={() => void retry()}>
              {t('banner.retry')}
            </Button>
          </div>
        ))}
        {!accounts.length ? (
          <p className="body-medium muted">{t('accounts.addFirst')}</p>
        ) : (
          <>
            <QuickAdd />
            {isLoading ? (
              <Spinner label={t('mail.loading')} />
            ) : (
              <div className={group === 'list' ? 'task-board' : 'task-sections'}>
                {sections.map((s) => {
                  if (group === 'date' && !s.items.length) return null
                  const a = s.accountId ? accountsById.find((x) => x.id === s.accountId) : undefined
                  return (
                    <section key={s.key} className={['task-section', s.key === 'overdue' && 'is-overdue'].filter(Boolean).join(' ')}>
                      <h2 className="title-small task-section__head">
                        {a && <AccountBadge color={a.color} label={accountLabel(a)} size={18} />}
                        <span>{s.title}</span>
                        <span className="muted">{s.items.length}</span>
                      </h2>
                      {s.items.length ? (
                        <ul className="task-list">
                          {s.items.map((x) => (
                            <TaskRow key={`${x.accountId}|${x.listId}|${x.id}`} task={x} onOpen={setOpen} showList={group === 'date'} />
                          ))}
                        </ul>
                      ) : (
                        <p className="body-medium muted task-section__empty">{t('tasks.allDone')}</p>
                      )}
                    </section>
                  )
                })}
                {group === 'date' && !openTasks.length && <p className="body-medium muted task-section__empty">{t('tasks.allDone')}</p>}
              </div>
            )}
            {completed.length > 0 && (
              <section className="task-section task-section--completed">
                <button type="button" className="task-section__toggle title-small" onClick={() => setShowCompleted((v) => !v)} aria-expanded={showCompleted}>
                  <Icon name={showCompleted ? 'keyboard_arrow_up' : 'keyboard_arrow_down'} />
                  {t('tasks.completed', { count: completed.length })}
                </button>
                {showCompleted && (
                  <ul className="task-list">
                    {completed.map((x) => (
                      <TaskRow key={`${x.accountId}|${x.listId}|${x.id}`} task={x} onOpen={setOpen} showList />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {open && <TaskDialog task={open} onClose={() => setOpen(null)} />}
      <Dialog open={showLists} onClose={() => setShowLists(false)} title={t('tasks.lists')}>
        <ListPanel />
      </Dialog>
    </div>
  )
}
