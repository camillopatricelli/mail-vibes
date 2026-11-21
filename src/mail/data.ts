import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import i18n from '../i18n'
import { queryClient } from '../lib/queryClient'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { isMailCapable, providerFor } from './api'
import { rememberAddresses } from './addressBook'
import type { Address, FolderKind, ListResult, MailMessage, MailSummary } from './types'

export const PAGE_SIZE = 40

export interface ThreadSummary {
  key: string
  accountId: string
  threadId: string
  subject: string
  snippet: string
  date: number
  /** Senders, oldest first, unique */
  participants: Address[]
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  hasDraft: boolean
  /** Messages of this thread in the current list (actions apply to these) */
  messages: MailSummary[]
}

export const threadKey = (accountId: string, threadId: string) => `${accountId}|${threadId}`

export function groupThreads(messages: MailSummary[]): ThreadSummary[] {
  const map = new Map<string, MailSummary[]>()
  for (const m of messages) {
    const k = threadKey(m.accountId, m.threadId)
    const list = map.get(k)
    if (list) list.push(m)
    else map.set(k, [m])
  }
  const out: ThreadSummary[] = []
  for (const [key, ms] of map) {
    ms.sort((a, b) => a.date - b.date)
    const latest = ms[ms.length - 1]
    const seen = new Set<string>()
    const participants: Address[] = []
    for (const m of ms) {
      const id = m.from.email.toLowerCase()
      if (id && !seen.has(id)) {
        seen.add(id)
        participants.push(m.from)
      }
    }
    out.push({
      key,
      accountId: latest.accountId,
      threadId: latest.threadId,
      subject: latest.subject,
      snippet: latest.snippet,
      date: latest.date,
      participants,
      unread: ms.some((m) => !m.isRead),
      flagged: ms.some((m) => m.isFlagged),
      hasAttachments: ms.some((m) => m.hasAttachments),
      hasDraft: ms.some((m) => m.isDraft),
      messages: ms,
    })
  }
  return out.sort((a, b) => b.date - a.date)
}

export function mailAccounts(accounts: AccountSettings[]) {
  return accounts.filter((a) => a.visible && isMailCapable(a.id))
}

const listKey = (accountId: string, folder: FolderKind, count: number) => ['mail', 'list', accountId, folder, count] as const

/**
 * Merged, threaded list of one folder across all visible accounts.
 *
 * Accounts are paged independently, so only threads newer than the oldest message of every
 * account that still has more to load are shown — otherwise an account with older mail could
 * appear "complete" while another account's messages from the same period are not loaded yet.
 */
export function useMergedFolder(folder: FolderKind) {
  const accounts = mailAccounts(useSettings((s) => s.accounts))
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [countsFolder, setCountsFolder] = useState(folder)
  if (countsFolder !== folder) {
    setCountsFolder(folder)
    setCounts({})
  }

  const results = useQueries({
    queries: accounts.map((a) => {
      const count = counts[a.id] ?? PAGE_SIZE
      return {
        queryKey: listKey(a.id, folder, count),
        queryFn: async () => {
          const r = await providerFor(a.id).list(a.id, folder, count)
          rememberAddresses(r.messages.flatMap((m) => [m.from, ...m.to]))
          return r
        },
        refetchInterval: pollSec * 1000,
        refetchIntervalInBackground: true,
        placeholderData: keepPreviousData,
      }
    }),
  })

  const merged = useMemo(() => {
    const all: MailSummary[] = []
    let cutoff = 0
    let hasMore = false
    results.forEach((r) => {
      const data = r.data as ListResult | undefined
      if (!data) return
      all.push(...data.messages)
      if (data.hasMore && data.messages.length) {
        hasMore = true
        cutoff = Math.max(cutoff, Math.min(...data.messages.map((m) => m.date)))
      }
    })
    const threads = groupThreads(all).filter((t) => t.date >= cutoff)
    return { threads, hasMore }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')])

  const errors = results
    .map((r, i) => (r.error ? { account: accounts[i], error: r.error as Error, refetch: r.refetch } : null))
    .filter((x): x is NonNullable<typeof x> => !!x)

  return {
    accounts,
    threads: merged.threads,
    hasMore: merged.hasMore,
    isLoading: results.some((r) => r.isPending),
    isFetching: results.some((r) => r.isFetching),
    errors,
    loadMore: () =>
      setCounts((c) => {
        const next = { ...c }
        results.forEach((r, i) => {
          if ((r.data as ListResult | undefined)?.hasMore) next[accounts[i].id] = (c[accounts[i].id] ?? PAGE_SIZE) + PAGE_SIZE
        })
        return next
      }),
    refresh: () => results.forEach((r) => void r.refetch()),
  }
}

export function useUnreadCounts(folder: FolderKind) {
  const accounts = mailAccounts(useSettings((s) => s.accounts))
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['mail', 'unread', a.id, folder],
      queryFn: () => providerFor(a.id).unreadCount(a.id, folder),
      refetchInterval: pollSec * 1000,
      refetchIntervalInBackground: true,
    })),
  })
  return results.reduce((sum, r) => sum + ((r.data as number | undefined) ?? 0), 0)
}

export function useThread(accountId: string | undefined, threadId: string | undefined) {
  return useQuery({
    queryKey: ['mail', 'thread', accountId, threadId],
    enabled: !!accountId && !!threadId,
    queryFn: async () => {
      const ms = await providerFor(accountId!).thread(accountId!, threadId!)
      rememberAddresses(ms.flatMap((m) => [m.from, ...m.to, ...m.cc]))
      return ms
    },
  })
}

export function useFolders(accountId: string | undefined) {
  return useQuery({
    queryKey: ['mail', 'folders', accountId],
    enabled: !!accountId,
    staleTime: 5 * 60_000,
    queryFn: () => providerFor(accountId!).folders(accountId!),
  })
}

// ---------- Actions ----------

type Patch = Partial<Pick<MailSummary, 'isRead' | 'isFlagged'>>

/** Applies a change to the cached lists and threads immediately (optimistic update). */
function patchCaches(accountId: string, ids: Set<string>, patch: Patch | 'remove') {
  queryClient.setQueriesData<ListResult>({ queryKey: ['mail', 'list', accountId] }, (old) =>
    old
      ? {
          ...old,
          messages:
            patch === 'remove'
              ? old.messages.filter((m) => !ids.has(m.id))
              : old.messages.map((m) => (ids.has(m.id) ? { ...m, ...patch } : m)),
        }
      : old,
  )
  if (patch !== 'remove')
    queryClient.setQueriesData<MailMessage[]>({ queryKey: ['mail', 'thread', accountId] }, (old) =>
      old?.map((m) => (ids.has(m.id) ? { ...m, ...patch } : m)),
    )
}

function syncAfter(accountId: string) {
  void queryClient.invalidateQueries({ queryKey: ['mail', 'list', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'thread', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'unread', accountId] })
}

function groupByAccount(items: { accountId: string; id: string }[]) {
  const m = new Map<string, string[]>()
  for (const it of items) m.set(it.accountId, [...(m.get(it.accountId) ?? []), it.id])
  return m
}

/**
 * Runs an action per account with an optimistic cache update. On failure the caches are
 * re-synced from the server and an error is shown; nothing is reported as done unless the
 * API confirmed it.
 */
async function run(
  items: { accountId: string; id: string }[],
  patch: Patch | 'remove',
  call: (accountId: string, ids: string[]) => Promise<void>,
  successMessage?: string,
) {
  const t = i18n.t.bind(i18n)
  const groups = groupByAccount(items)
  let failed = 0
  await Promise.all(
    [...groups].map(async ([accountId, ids]) => {
      patchCaches(accountId, new Set(ids), patch)
      try {
        await call(accountId, ids)
      } catch (e) {
        failed++
        useStatus.getState().toast({ tone: 'error', message: t('mail.actionFailed', { reason: (e as Error).message }) })
      } finally {
        syncAfter(accountId)
      }
    }),
  )
  if (!failed && successMessage) useStatus.getState().toast({ tone: 'success', message: successMessage })
  return failed === 0
}

type Item = { accountId: string; id: string }

export const mailActions = {
  setRead: (items: Item[], read: boolean) =>
    run(items, { isRead: read }, (a, ids) => providerFor(a).setRead(a, ids, read)),
  setFlagged: (items: Item[], flagged: boolean) =>
    run(items, { isFlagged: flagged }, (a, ids) => providerFor(a).setFlagged(a, ids, flagged)),
  archive: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, 'archive'), i18n.t('mail.archived', { count })),
  trash: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, 'trash'), i18n.t('mail.trashed', { count })),
  moveToInbox: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, 'inbox'), i18n.t('mail.movedToInbox', { count })),
  moveToFolder: (items: Item[], folderId: string, folderName: string) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, { folderId }), i18n.t('mail.moved', { folder: folderName })),
  deleteForever: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).deleteForever(a, ids), i18n.t('mail.deletedForever', { count })),
}

/** After sending or saving, make lists and threads reflect the server. */
export function refreshAccountMail(accountId: string) {
  syncAfter(accountId)
}
