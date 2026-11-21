import { useQueries } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '../notify/notify'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { isMailCapable } from './api'
import { fetchList, listKey, mailActions, PAGE_SIZE } from './data'
import { mailHref } from './routes'
import type { ListResult, MailSummary } from './types'

/**
 * Brings snoozed mail back to the Inbox when its time comes, for every account (also hidden
 * ones). Runs while the app is open; anything that came due while it was closed comes back at
 * the first look. Shares its requests with the Snoozed list.
 */
export function useSnoozeWaker() {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts).filter((a) => isMailCapable(a.id))
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const notifyOn = useSettings((s) => s.notifyMail)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: listKey(a.id, 'snoozed', PAGE_SIZE),
      queryFn: () => fetchList(a.id, 'snoozed', PAGE_SIZE),
      refetchInterval: Math.max(pollSec, 120) * 1000,
      refetchIntervalInBackground: true,
    })),
  })
  const waking = useRef(new Set<string>())
  const [tick, setTick] = useState(0)
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')

  useEffect(() => {
    const now = Date.now()
    const due: MailSummary[] = []
    let next = Infinity
    for (const r of results)
      for (const m of (r.data as ListResult | undefined)?.messages ?? []) {
        if (m.snoozedUntil === undefined) continue
        const key = `${m.accountId}|${m.id}`
        if (m.snoozedUntil <= now) {
          if (!waking.current.has(key)) due.push(m)
        } else next = Math.min(next, m.snoozedUntil)
      }
    if (due.length) {
      due.forEach((m) => waking.current.add(`${m.accountId}|${m.id}`))
      const threads = new Map(due.map((m) => [`${m.accountId}|${m.threadId}`, m]))
      void mailActions.unsnooze(due, threads.size, true).then((ok) => {
        due.forEach((m) => waking.current.delete(`${m.accountId}|${m.id}`))
        if (!ok) return
        const list = [...threads.values()]
        const message = t('snooze.back', { count: list.length })
        if (notifyOn && !(document.visibilityState === 'visible' && document.hasFocus()))
          void notify(message, {
            body: list.slice(0, 4).map((m) => m.subject || t('mail.noSubject')).join('\n'),
            tag: 'snooze',
            hash: mailHref({ kind: 'well', folder: 'inbox' }, list.length === 1 ? { accountId: list[0].accountId, threadId: list[0].threadId } : undefined),
          })
        else useStatus.getState().toast({ tone: 'success', message })
      })
    }
    if (next === Infinity) return
    const h = setTimeout(() => setTick((x) => x + 1), Math.min(next - now + 1000, 2 ** 31 - 1))
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, tick])
}
