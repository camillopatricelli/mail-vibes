import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fromDateKey } from '../calendar/dates'
import type { MailSummary } from '../mail/types'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { Button, Icon, IconButton } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { defaultListKey, listKey, taskActions, useTaskLists } from './data'
import { mailSource } from './mailOpen'
import { ListSelect, ReminderField, reminderTimestamp } from './TasksPage'

/** "Add to Tasks" from an email: the task keeps a link back to the message. */
export function MailTaskDialog({ message, onClose }: { message: MailSummary; onClose: () => void }) {
  const { t } = useTranslation()
  const { lists, isLoading } = useTaskLists()
  const defaultAccount = useSettings((s) => s.defaults.taskAccountId)
  const [title, setTitle] = useState(message.subject)
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState('')
  const [reminder, setReminder] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A list of the account that received the email, else the usual default.
  const own = lists.find((l) => l.accountId === message.accountId && l.isDefault && !l.readOnly)
  const key = target || (own ? listKey(own.accountId, own.id) : defaultListKey(lists, defaultAccount))

  const save = async () => {
    if (!title.trim() || !key || busy) return
    const i = key.indexOf('|')
    setBusy(true)
    setError('')
    try {
      const source = await mailSource(message)
      await taskActions.create(key.slice(0, i), key.slice(i + 1), { title: title.trim(), notes, due: fromDateKey(due) ?? null, reminder: reminderTimestamp(reminder) ?? null }, source)
      useStatus.getState().toast({ tone: 'success', message: t('tasks.addedFromMail') })
      onClose()
    } catch (e) {
      setError(t('tasks.addFailed', { reason: (e as Error).message }))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tasks.addFromMail')}
      className="event-dialog"
      actions={
        <>
          <span className="spacer" />
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('calendar.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy || !title.trim() || !key} icon={busy ? undefined : 'add_task'}>
            {busy ? <Spinner size={16} /> : t('tasks.add')}
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
          <textarea className="event-form__description event-form__grow" rows={3} placeholder={t('tasks.notes')} aria-label={t('tasks.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="event-form__row">
          <Icon name="event" />
          <input type="date" className="select" value={due} onChange={(e) => setDue(e.target.value)} aria-label={t('tasks.due')} />
          {due && <IconButton icon="close" label={t('tasks.clearDue')} onClick={() => setDue('')} />}
        </label>
        <div className="event-form__row">
          <Icon name="notifications" />
          <ReminderField value={reminder} onChange={setReminder} due={fromDateKey(due)} />
        </div>
        <div className="event-form__row">
          <Icon name="task_alt" />
          {isLoading && !lists.length ? <Spinner size={20} /> : key ? <ListSelect value={key} onChange={setTarget} /> : <span className="body-medium muted">{t('tasks.noLists')}</span>}
        </div>
        <p className="event-form__row body-small muted">
          <Icon name="mail" />
          <span>{t('tasks.linkHint')}</span>
        </p>
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
