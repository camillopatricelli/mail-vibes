import { useQueries } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEvents } from '../calendar/data'
import { addDays, startOfDay, toDateKey } from '../calendar/dates'
import { timeOf } from '../calendar/format'
import { appInfo } from '../config'
import { displayName } from '../lib/format'
import { href } from '../lib/router'
import { useNow } from '../lib/time'
import { fetchList, listKey, mailAccounts, PAGE_SIZE, useUnreadCounts } from '../mail/data'
import { mailHref } from '../mail/routes'
import type { ListResult, MailSummary } from '../mail/types'
import { useSettings, type AccountSettings } from '../settings/store'
import { notify, showUnreadCount } from './notify'

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

/** Event reminders, a set number of minutes before the start (timed events only). */
export function useEventNotifier() {
  const { t } = useTranslation()
  const enabled = useSettings((s) => s.notifyEvents)
  const lead = useSettings((s) => s.notifyEventMinutes) * 60_000
  const now = useNow(30_000)
  const from = startOfDay(now)
  // Same range as the Today agenda, so the requests are shared.
  const { events } = useEvents(from, addDays(from, 1))
  const done = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled) return
    for (const e of events) {
      if (e.allDay || e.cancelled || e.myResponse === 'declined') continue
      if (now < e.start - lead || now >= e.start + 5 * 60_000) continue
      // A meeting in two of your calendars is announced once.
      const key = `${e.title}|${e.start}`
      if (done.current.has(key)) continue
      done.current.add(key)
      void notify(e.title || t('calendar.noTitle'), {
        body: [`${timeOf(e.start)} – ${timeOf(e.end)}`, e.location].filter(Boolean).join(' · '),
        tag: `event|${e.accountId}|${e.id}|${e.start}`,
        hash: href('calendar', 'day', toDateKey(e.start)),
        joinUrl: e.meeting?.url,
        joinLabel: e.meeting ? t(`calendar.join.${e.meeting.provider}`) : undefined,
      })
    }
  }, [now, events, enabled, lead, t])
}

/** Inbox unread count on the window title and the installed app's icon. */
export function useUnreadBadge() {
  const count = useUnreadCounts('inbox')
  useEffect(() => showUnreadCount(count, appInfo.name), [count])
}
