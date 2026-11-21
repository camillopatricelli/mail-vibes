import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { startOfDay } from '../calendar/dates'
import { href } from '../lib/router'
import { Spinner } from '../ui/overlay'
import { useTasks, type ShownTask } from './data'
import { TaskDialog, TaskRow } from './TasksPage'

/** "Tasks due or overdue" panel of the Today page. */
export function TodayTasks() {
  const { t } = useTranslation()
  const { tasks, errors, isLoading, accounts } = useTasks()
  const [open, setOpen] = useState<ShownTask | null>(null)
  const today = startOfDay(Date.now())
  const due = tasks
    .filter((x) => !x.completed && x.due !== undefined && x.due <= today)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0) || a.title.localeCompare(b.title))
  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (isLoading && !tasks.length) return <Spinner label={t('mail.loading')} />
  return (
    <div className="today-mail">
      {errors.map(({ account, error }) => (
        <p key={account.id} className="body-small field-error" role="alert">
          {t('tasks.loadFailed', { account: account.email, reason: error.message })}
        </p>
      ))}
      {due.length === 0 ? (
        <p className="body-medium muted">{t('tasks.nothingDue')}</p>
      ) : (
        <ul className="task-list task-list--compact">
          {due.slice(0, 8).map((x) => (
            <TaskRow key={`${x.accountId}|${x.listId}|${x.id}`} task={x} onOpen={setOpen} />
          ))}
        </ul>
      )}
      <a href={href('tasks')} className="btn btn--text">
        {due.length > 8 ? t('tasks.moreDue', { count: due.length - 8 }) : t('tasks.openTasks')}
      </a>
      {open && <TaskDialog task={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
