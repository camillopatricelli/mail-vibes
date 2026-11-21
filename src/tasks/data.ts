import { keepPreviousData, useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { addDays, DAY, startOfDay } from '../calendar/dates'
import i18n from '../i18n'
import { continued, nextOccurrence } from '../lib/recurrence'
import { queryClient } from '../lib/queryClient'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { googleTasks } from './googleTasks'
import { todo } from './todo'
import type { MailSource } from './mailLink'
import type { Task, TaskDraft, TaskList, TaskProvider } from './types'

export function tasksFor(accountId: string): TaskProvider {
  if (accountId.startsWith('microsoft:')) return todo
  if (accountId.startsWith('google:')) return googleTasks
  throw new Error('Unknown account type')
}

export const listKey = (accountId: string, listId: string) => `${accountId}|${listId}`
const itemsKey = (accountId: string, listId: string) => ['tasks', 'items', accountId, listId] as const

type ListWithState = TaskList & { hidden: boolean; accountColor: string }
export type ShownTask = Task & { accountColor: string; listName: string }
type AccountError = { account: AccountSettings; error: Error; refetch: () => unknown }

/** Task lists of the visible accounts (hidden lists included, flagged). */
export function useTaskLists() {
  const accounts = useSettings((s) => s.accounts).filter((a) => a.visible)
  const hidden = useSettings((s) => s.hiddenTaskLists)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['tasks', 'lists', a.id],
      queryFn: () => tasksFor(a.id).lists(a.id),
      staleTime: 10 * 60_000,
    })),
  })
  const lists = useMemo(() => {
    const out: ListWithState[] = []
    results.forEach((r, i) => {
      for (const l of (r.data as TaskList[] | undefined) ?? [])
        out.push({ ...l, hidden: hidden.includes(listKey(l.accountId, l.id)), accountColor: accounts[i].color })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), hidden, accounts.map((a) => a.id + a.color).join(',')])
  const errors: AccountError[] = []
  results.forEach((r, i) => {
    if (r.error) errors.push({ account: accounts[i], error: r.error as Error, refetch: r.refetch })
  })
  return { accounts, lists, errors, isLoading: results.some((r) => r.isLoading) }
}

/** Every task of every visible list, merged. */
export function useTasks() {
  const { accounts, lists, errors: listErrors, isLoading: listsLoading } = useTaskLists()
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const shown = lists.filter((l) => !l.hidden)
  const results = useQueries({
    queries: shown.map((l) => ({
      queryKey: itemsKey(l.accountId, l.id),
      queryFn: () => tasksFor(l.accountId).tasks(l.accountId, l.id),
      refetchInterval: pollSec * 1000,
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
    })),
  })
  const tasks = useMemo(() => {
    const out: ShownTask[] = []
    results.forEach((r, i) => {
      const l = shown[i]
      for (const t of (r.data as Task[] | undefined) ?? []) out.push({ ...t, accountColor: l.accountColor, listName: l.name })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), shown.map((l) => listKey(l.accountId, l.id) + l.accountColor).join(',')])

  const errors = [...listErrors]
  results.forEach((r, i) => {
    const account = accounts.find((a) => a.id === shown[i].accountId)
    if (r.error && account && !errors.some((e) => e.account.id === account.id)) errors.push({ account, error: r.error as Error, refetch: r.refetch })
  })
  return {
    accounts,
    lists,
    tasks,
    errors,
    isLoading: listsLoading || (results.some((r) => r.isLoading) && !tasks.length),
    isFetching: results.some((r) => r.isFetching),
    refetch: () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  }
}

/** Applies a change to the cached list right away (the next refresh confirms it). */
function patch(t: Task, change: ((list: Task[]) => Task[]) | Partial<Task>) {
  queryClient.setQueryData<Task[]>(itemsKey(t.accountId, t.listId), (list) => {
    if (!list) return list
    return typeof change === 'function' ? change(list) : list.map((x) => (x.id === t.id ? { ...x, ...change } : x))
  })
}

const refresh = (t: { accountId: string; listId: string }) => queryClient.invalidateQueries({ queryKey: itemsKey(t.accountId, t.listId) })
const toast = useStatus.getState().toast

export const taskActions = {
  async setCompleted(t: Task, completed: boolean, undoable = true) {
    patch(t, { completed, completedAt: completed ? Date.now() : undefined })
    try {
      const provider = tasksFor(t.accountId)
      await provider.setCompleted(t.accountId, t.listId, t.id, completed)
      // Google Tasks doesn't repeat tasks for apps: the app adds the next one.
      const next = completed && t.recurrence && !provider.repeatsItself ? await repeatNext(t) : undefined
      if (completed && undoable)
        toast({
          tone: 'success',
          message: next?.due !== undefined ? i18n.t('tasks.completedNext', { date: new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' }).format(next.due) }) : i18n.t('tasks.completedToast'),
          action: {
            label: i18n.t('tasks.undo'),
            run: () => {
              void taskActions.setCompleted(t, false, false)
              if (next) void taskActions.remove(next, true)
            },
          },
        })
    } catch (e) {
      patch(t, { completed: !completed })
      toast({ tone: 'error', message: i18n.t('tasks.actionFailed', { reason: (e as Error).message }) })
    } finally {
      void refresh(t)
    }
  },

  /** Resolves once the provider confirmed; throws on failure (the caller shows the error). */
  async create(accountId: string, listId: string, draft: TaskDraft, mail?: MailSource) {
    const created = await tasksFor(accountId).create(accountId, listId, draft, mail)
    patch(created, (list) => [created, ...list])
    void refresh(created)
    return created
  },

  async update(t: Task, draft: Partial<TaskDraft>) {
    await tasksFor(t.accountId).update(t.accountId, t.listId, t.id, draft)
    const change: Partial<Task> = {}
    if (draft.title !== undefined) change.title = draft.title
    if (draft.notes !== undefined) change.notes = draft.notes
    if (draft.due !== undefined) change.due = draft.due ?? undefined
    if (draft.start !== undefined) change.start = draft.start ?? undefined
    if (draft.reminder !== undefined) change.reminder = draft.reminder ?? undefined
    if (draft.recurrence !== undefined) change.recurrence = draft.recurrence ?? undefined
    patch(t, change)
    toast({ tone: 'success', message: i18n.t('tasks.saved') })
    void refresh(t)
  },

  async remove(t: Task, quiet = false) {
    await tasksFor(t.accountId).remove(t.accountId, t.listId, t.id)
    patch(t, (list) => list.filter((x) => x.id !== t.id && x.parentId !== t.id))
    if (!quiet) toast({ tone: 'success', message: i18n.t('tasks.deleted') })
    void refresh(t)
  },
}

/** Adds the next task of a repeating one (dates moved to the next occurrence). */
async function repeatNext(t: Task): Promise<Task | undefined> {
  if (!t.recurrence) return undefined
  const anchor = t.due ?? startOfDay(Date.now())
  const due = nextOccurrence(t.recurrence, anchor)
  if (due === undefined) return undefined
  const shift = Math.round((due - anchor) / DAY)
  try {
    return await taskActions.create(t.accountId, t.listId, {
      title: t.title,
      notes: t.notes,
      due,
      start: t.start !== undefined ? addDays(t.start, shift) : null,
      reminder: t.reminder !== undefined ? addDays(t.reminder, shift) : null,
      recurrence: continued(t.recurrence),
    })
  } catch (e) {
    toast({ tone: 'error', message: i18n.t('tasks.repeatFailed', { reason: (e as Error).message }) })
    return undefined
  }
}

export function toggleTaskList(accountId: string, listId: string) {
  const s = useSettings.getState()
  const k = listKey(accountId, listId)
  s.update({ hiddenTaskLists: s.hiddenTaskLists.includes(k) ? s.hiddenTaskLists.filter((x) => x !== k) : [...s.hiddenTaskLists, k] })
}

/** Where new tasks go: the default list of the default task account (or of the first account). */
export function defaultListKey(all: TaskList[], taskAccountId?: string) {
  const lists = all.filter((x) => !x.readOnly)
  const l = lists.find((x) => x.accountId === taskAccountId && x.isDefault) ?? lists.find((x) => x.isDefault) ?? lists[0]
  return l ? listKey(l.accountId, l.id) : ''
}
