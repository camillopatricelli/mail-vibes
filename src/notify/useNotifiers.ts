import { useQueries } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useEvents } from '../calendar/data'
import { addDays, startOfDay, toDateKey } from '../calendar/dates'
import { eventWhen } from '../calendar/format'
import { appInfo } from '../config'
import { displayName } from '../lib/format'
import { href } from '../lib/router'
import { useNow } from '../lib/time'
import { fetchList, listKey, mailAccounts, PAGE_SIZE, useUnreadCounts } from '../mail/data'
import { mailHref } from '../mail/routes'
import type { ListResult, MailSummary } from '../mail/types'
import { useSettings, type AccountSettings } from '../settings/store'
import { useTasks } from '../tasks/data'
import { notify, showUnreadCount } from './notify'
import { uploadReminders, usePushState, type PushReminder } from './push'

const INBOX = { kind: 'well', folder: 'inbox' } as const
/** Messages older than this that show up in the inbox (moved back, restored) are not announced. */
const RECENT_MS = 24 * 3600_000

/**
 * New-mail notifications. Watches each account's inbox (sharing the inbox list's requests and
 * cache) and announces unread messages that were not there before, while the app is not focused.
 */
export function useMailNotifier() {
  const { t } = useTranslation()
  const accounts = mailAccounts(useSettings((s) => s.accounts))
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const enabled = useSettings((s) => s.notifyMail)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: listKey(a.id, 'inbox', PAGE_SIZE),
      queryFn: () => fetchList(a.id, 'inbox', PAGE_SIZE),
      refetchInterval: pollSec * 1000,
      refetchIntervalInBackground: true,
    })),
  })
  const seen = useRef(new Map<string, Set<string>>())
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')

  useEffect(() => {
    const fresh: { account: AccountSettings; m: MailSummary }[] = []
    results.forEach((r, i) => {
      const data = r.data as ListResult | undefined
      const account = accounts[i]
      if (!data || !account) return
      const known = seen.current.get(account.id)
      // The first load of an account only records what is already there.
      if (known)
        for (const m of data.messages)
          if (!known.has(m.id) && !m.isRead && !m.isDraft && m.date > Date.now() - RECENT_MS && m.from.email.toLowerCase() !== account.email.toLowerCase())
            fresh.push({ account, m })
      const ids = known ?? new Set<string>()
      for (const m of data.messages) ids.add(m.id)
      seen.current.set(account.id, ids)
    })
    if (!enabled || !fresh.length) return
    // In front of the user the list already shows it.
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    if (fresh.length === 1) {
      const { account, m } = fresh[0]
      void notify(displayName(m.from), {
        body: [m.subject || t('mail.noSubject'), m.snippet].filter(Boolean).join('\n'),
        tag: `mail|${account.id}|${m.threadId}`,
        hash: mailHref(INBOX, { accountId: account.id, threadId: m.threadId }),
      })
    } else {
      void notify(t('notify.newMail', { count: fresh.length }), {
        body: fresh
          .slice(0, 4)
          .map(({ m }) => `${displayName(m.from)}: ${m.subject || t('mail.noSubject')}`)
          .join('\n'),
        tag: 'mail|many',
        hash: mailHref(INBOX),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])
}

// ---------- Reminders ----------

const RANG_KEY = 'mail-vibes.reminders-shown'

/**
 * Reminders already shown, kept on the device (only ids and times, no content) so reloading
 * the app doesn't show them again. Entries expire after their event or reminder has passed.
 */
function rang(): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(RANG_KEY) ?? '{}') as Record<string, number>
    const now = Date.now()
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now))
  } catch {
    return {}
  }
}
function markRang(keys: string[], until: number) {
  const all = rang()
  for (const k of keys) all[k] = Math.max(all[k] ?? 0, until)
  try {
    localStorage.setItem(RANG_KEY, JSON.stringify(all))
  } catch {
    /* storage full or blocked: reminders may show again after a reload */
  }
}

/** Reminders are looked for this far ahead (Google allows up to 4 weeks before an event). */
const LOOKAHEAD_DAYS = 29
/** A task reminder missed for longer than this (app closed) is not shown any more. */
const TASK_GRACE_MS = 3 * 24 * 3600_000

type Shown = ReturnType<typeof useEvents>['events'][number]
type ShownTask = ReturnType<typeof useTasks>['tasks'][number]

/** Minutes before the start at which an event rings: its reminders, and its start if asked. */
function ringMinutes(e: Shown, atStart: boolean) {
  if (e.cancelled || e.myResponse === 'declined') return []
  const m = new Set(e.reminders)
  if (atStart && !e.allDay) m.add(0)
  return [...m]
}

function eventNotice(e: Shown, t: TFunction) {
  return {
    title: e.title || t('calendar.noTitle'),
    body: [eventWhen(e), e.location].filter(Boolean).join(' · '),
    tag: `event|${e.accountId}|${e.id}|${e.start}`,
    hash: href('calendar', 'day', toDateKey(e.start)),
    joinUrl: e.meeting?.url,
    joinLabel: e.meeting ? t(`calendar.join.${e.meeting.provider}`) : undefined,
  }
}

function taskNotice(task: ShownTask, t: TFunction) {
  return {
    title: task.title || t('tasks.noTitle'),
    body: [task.due !== undefined ? t('tasks.dueOn', { date: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(task.due) }) : '', task.listName].filter(Boolean).join(' · '),
    tag: `task|${task.accountId}|${task.id}|${task.reminder}`,
    hash: href('tasks'),
  }
}

/**
 * Event reminders at the times set on each event (or its calendar's defaults), including days
 * before, and at the start if asked. While the app is open; one missed while closed shows when
 * the app opens, until the event starts.
 */
export function useEventNotifier() {
  const { t } = useTranslation()
  const enabled = useSettings((s) => s.notifyEvents)
  const atStart = useSettings((s) => s.notifyAtStart)
  const now = useNow(30_000)
  const from = startOfDay(now)
  const { events } = useEvents(from, addDays(from, LOOKAHEAD_DAYS), { minRefreshSec: 600 })

  useEffect(() => {
    if (!enabled) return
    const shown = rang()
    for (const e of events) {
      const until = e.allDay ? e.end : e.start + 5 * 60_000
      if (now >= until) continue
      const due = ringMinutes(e, atStart).filter((m) => e.start - m * 60_000 <= now)
      if (!due.length) continue
      // A meeting in two of your calendars is announced once. Of several due reminders only the
      // latest rings (the others were either shown already or missed while the app was closed).
      const key = (m: number) => `event|${e.title}|${e.start}|${m}`
      const latest = key(Math.min(...due))
      const keys = due.map(key)
      if (shown[latest]) continue
      markRang(keys, until)
      keys.forEach((k) => (shown[k] = until))
      const n = eventNotice(e, t)
      void notify(n.title, n)
    }
  }, [now, events, enabled, atStart, t])
}

/** Task reminders (To Do's own, or the ones Mail Vibes keeps for Google tasks), while the app is open. */
export function useTaskNotifier() {
  const { t } = useTranslation()
  const enabled = useSettings((s) => s.notifyEvents)
  const now = useNow(30_000)
  const { tasks } = useTasks()

  useEffect(() => {
    if (!enabled) return
    const shown = rang()
    for (const task of tasks) {
      if (task.completed || task.reminder === undefined || task.reminder > now || task.reminder < now - TASK_GRACE_MS) continue
      const key = `task|${task.accountId}|${task.id}|${task.reminder}`
      if (shown[key]) continue
      markRang([key], task.reminder + TASK_GRACE_MS + 60_000)
      shown[key] = 1
      const n = taskNotice(task, t)
      void notify(n.title, n)
    }
  }, [now, tasks, enabled, t])
}

/** Reminders for the bridge are looked for this far ahead (it keeps them until they're due). */
const PUSH_AHEAD_MS = 7 * 24 * 3600_000

/**
 * Hands the coming reminders to the bridge, which sends them as push notifications while the app
 * is closed (src/notify/push.ts). Any device with the reminders setup does it, so the one that is
 * open keeps the others' reminders up to date. Only changes are uploaded.
 */
export function usePushSchedule() {
  const { t } = useTranslation()
  const enabled = useSettings((s) => s.notifyEvents)
  const atStart = useSettings((s) => s.notifyAtStart)
  const accounts = useSettings((s) => s.accounts)
  const ready = usePushState((s) => s.bridgeCan && s.hasSetup)
  const now = useNow(60_000)
  const from = startOfDay(now)
  const ev = useEvents(from, addDays(from, LOOKAHEAD_DAYS), { minRefreshSec: 600 })
  const tk = useTasks()

  useEffect(() => {
    if (!ready || ev.isLoading || tk.isLoading) return
    const parts: Record<string, PushReminder[]> = {}
    const live: string[] = []
    for (const a of accounts) {
      live.push(`events|${a.id}`, `tasks|${a.id}`)
      // An account that failed to load keeps what the bridge already has.
      if (!ev.errors.some((e) => e.account.id === a.id)) parts[`events|${a.id}`] = []
      if (!tk.errors.some((e) => e.account.id === a.id)) parts[`tasks|${a.id}`] = []
    }
    if (enabled) {
      const seen = new Set<string>()
      for (const e of ev.events)
        for (const m of ringMinutes(e, atStart)) {
          const at = e.start - m * 60_000
          const once = `${e.title}|${e.start}|${m}`
          if (at < now - 60_000 || at > now + PUSH_AHEAD_MS || seen.has(once)) continue
          seen.add(once)
          parts[`events|${e.accountId}`]?.push({ at, ...eventNotice(e, t) })
        }
      for (const task of tk.tasks)
        if (!task.completed && task.reminder !== undefined && task.reminder >= now - 60_000 && task.reminder <= now + PUSH_AHEAD_MS)
          parts[`tasks|${task.accountId}`]?.push({ at: task.reminder, ...taskNotice(task, t) })
    }
    void uploadReminders(parts, live)
  }, [ready, now, ev.events, ev.errors, ev.isLoading, tk.tasks, tk.errors, tk.isLoading, accounts, enabled, atStart, t])
}

/** Inbox unread count on the window title and the installed app's icon. */
export function useUnreadBadge() {
  const count = useUnreadCounts('inbox')
  useEffect(() => showUnreadCount(count, appInfo.name), [count])
}
