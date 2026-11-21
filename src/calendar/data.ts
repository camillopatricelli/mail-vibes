import { keepPreviousData, useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import i18n from '../i18n'
import { queryClient } from '../lib/queryClient'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { calendarFor, calendarKey } from './api'
import type { CalEvent, CalendarInfo, EventDraft } from './types'

export const calendarAccounts = (accounts: AccountSettings[]) => accounts.filter((a) => a.visible)

/** All calendars of the visible accounts (hidden calendars included, flagged). */
export function useCalendars() {
  const accounts = calendarAccounts(useSettings((s) => s.accounts))
  const hidden = useSettings((s) => s.hiddenCalendars)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['cal', 'calendars', a.id],
      queryFn: () => calendarFor(a.id).calendars(a.id),
      staleTime: 10 * 60_000,
    })),
  })
  const calendars = useMemo(() => {
    const out: (CalendarInfo & { hidden: boolean; accountColor: string })[] = []
    results.forEach((r, i) => {
      for (const c of (r.data as CalendarInfo[] | undefined) ?? [])
        out.push({ ...c, hidden: hidden.includes(calendarKey(c.accountId, c.id)), accountColor: accounts[i].color })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), hidden, accounts.map((a) => a.id + a.color).join(',')])
  const errors = results
    .map((r, i) => (r.error ? { account: accounts[i], error: r.error as Error, refetch: r.refetch } : null))
    .filter((x): x is NonNullable<typeof x> => !!x)
  return { accounts, calendars, errors, isLoading: results.some((r) => r.isLoading) }
}

export type ShownEvent = CalEvent & { color: string; accountColor: string; calendarName: string; canEdit: boolean }

/** Events of every visible calendar between `from` and `to`, merged and sorted. */
export function useEvents(from: number, to: number) {
  const { accounts, calendars, errors: calErrors, isLoading: calLoading } = useCalendars()
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const shown = calendars.filter((c) => !c.hidden)
  const results = useQueries({
    queries: shown.map((c) => ({
      queryKey: ['cal', 'events', c.accountId, c.id, from, to],
      queryFn: () => calendarFor(c.accountId).events(c.accountId, c.id, from, to),
      refetchInterval: pollSec * 1000,
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
    })),
  })
  const events = useMemo(() => {
    const out: ShownEvent[] = []
    results.forEach((r, i) => {
      const c = shown[i]
      for (const e of (r.data as CalEvent[] | undefined) ?? [])
        out.push({ ...e, color: c.color ?? c.accountColor, accountColor: c.accountColor, calendarName: c.name, canEdit: c.canEdit })
    })
    return out.sort((a, b) => a.start - b.start || b.end - a.end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), shown.map((c) => calendarKey(c.accountId, c.id) + c.color).join(',')])

  // One error per account is enough (a failing account usually fails for every calendar).
  const errors: { account: AccountSettings; error: Error; refetch: () => unknown }[] = [...calErrors]
  results.forEach((r, i) => {
    const account = accounts.find((a) => a.id === shown[i].accountId)
    if (r.error && account && !errors.some((e) => e.account.id === account.id))
      errors.push({ account, error: r.error as Error, refetch: r.refetch })
  })

  return {
    accounts,
    calendars,
    events,
    errors,
    isLoading: calLoading || (results.some((r) => r.isLoading) && !events.length),
    isFetching: results.some((r) => r.isFetching),
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ['cal'] })
    },
  }
}

const refreshAccount = (accountId: string) => queryClient.invalidateQueries({ queryKey: ['cal', 'events', accountId] })

const toast = (message: string, tone: 'success' | 'error' = 'success') => useStatus.getState().toast({ tone, message })

/** Calendar actions. They resolve only once the provider confirmed, and re-throw errors. */
export const calendarActions = {
  async create(accountId: string, calendarId: string, draft: EventDraft) {
    await calendarFor(accountId).create(accountId, calendarId, draft)
    toast(i18n.t('calendar.created'))
    void refreshAccount(accountId)
  },
  async update(e: CalEvent, draft: Partial<EventDraft>) {
    await calendarFor(e.accountId).update(e.accountId, e.calendarId, e.id, draft)
    toast(i18n.t('calendar.saved'))
    void refreshAccount(e.accountId)
  },
  async remove(e: CalEvent) {
    await calendarFor(e.accountId).remove(e.accountId, e.calendarId, e.id)
    toast(i18n.t('calendar.deleted'))
    void refreshAccount(e.accountId)
  },
  async respond(e: CalEvent, r: 'accepted' | 'tentative' | 'declined') {
    await calendarFor(e.accountId).respond(e.accountId, e.calendarId, e, r)
    toast(i18n.t(`calendar.responded.${r}`))
    void refreshAccount(e.accountId)
  },
}

export function toggleCalendar(accountId: string, calendarId: string) {
  const s = useSettings.getState()
  const k = calendarKey(accountId, calendarId)
  s.update({ hiddenCalendars: s.hiddenCalendars.includes(k) ? s.hiddenCalendars.filter((x) => x !== k) : [...s.hiddenCalendars, k] })
}
