import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import i18n from '../i18n'
import { shortDateTime } from '../lib/format'
import { queryClient } from '../lib/queryClient'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { isMailCapable, providerFor } from './api'
import { rememberAddresses } from './addressBook'
import type { Address, FolderKind, ListResult, ListTarget, MailMessage, MailSummary, MailTag } from './types'

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
  /** Tags of any message in the thread */
  tags: string[]
  /** Earliest wake-up time of its snoozed messages */
  snoozedUntil?: number
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
      tags: uniqueTags(ms.flatMap((m) => m.tags)),
      snoozedUntil: ms.some((m) => m.snoozedUntil) ? Math.min(...ms.flatMap((m) => m.snoozedUntil ?? [])) : undefined,
      messages: ms,
    })
  }
  return out.sort((a, b) => b.date - a.date)
}

/** Removes duplicates, ignoring case (the first spelling wins). */
export function uniqueTags(names: string[]) {
  const seen = new Set<string>()
  return names.filter((n) => {
    const k = n.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function mailAccounts(accounts: AccountSettings[]) {
  return accounts.filter((a) => a.visible && isMailCapable(a.id))
}

const targetKey = (t: ListTarget) =>
  typeof t === 'string' ? t : 'tag' in t ? `tag:${t.tag.toLowerCase()}` : 'search' in t ? `search:${t.search}` : `folder:${t.folderId}`
export const listKey = (accountId: string, target: ListTarget, count: number) => ['mail', 'list', accountId, targetKey(target), count] as const

/** Loads one page of a folder (and remembers its addresses for suggestions). */
export async function fetchList(accountId: string, target: ListTarget, count: number) {
  const r = await providerFor(accountId).list(accountId, target, count)
  rememberAddresses(r.messages.flatMap((m) => [m.from, ...m.to]))
  return r
}

/**
 * Merged, threaded list of one folder across all visible accounts.
 *
 * Accounts are paged independently, so only threads newer than the oldest message of every
 * account that still has more to load are shown — otherwise an account with older mail could
 * appear "complete" while another account's messages from the same period are not loaded yet.
 */
export function useMergedFolder(folder: ListTarget, onlyAccountId?: string) {
  const allAccounts = useSettings((s) => s.accounts)
  // A user folder belongs to one account and is shown even if that account is filtered out.
  const accounts = onlyAccountId ? allAccounts.filter((a) => a.id === onlyAccountId && isMailCapable(a.id)) : mailAccounts(allAccounts)
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const key = targetKey(folder)
  const [countsFolder, setCountsFolder] = useState(key)
  if (countsFolder !== key) {
    setCountsFolder(key)
    setCounts({})
  }

  const results = useQueries({
    queries: accounts.map((a) => {
      const count = counts[a.id] ?? PAGE_SIZE
      return {
        queryKey: listKey(a.id, folder, count),
        queryFn: () => fetchList(a.id, folder, count),
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
  const pollSec = useSettings((s) => s.pollIntervalSec)
  return useQuery({
    queryKey: ['mail', 'folders', accountId],
    enabled: !!accountId,
    staleTime: 30_000,
    refetchInterval: pollSec * 1000,
    refetchIntervalInBackground: true,
    queryFn: () => providerFor(accountId!).folders(accountId!),
  })
}

/** Own folders of every mail account (for the navigation and the mobile folder picker). */
export function useAllFolders() {
  const accounts = useSettings((s) => s.accounts).filter((a) => isMailCapable(a.id))
  const pollSec = useSettings((s) => s.pollIntervalSec)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['mail', 'folders', a.id],
      queryFn: () => providerFor(a.id).folders(a.id),
      staleTime: 30_000,
      refetchInterval: pollSec * 1000,
      refetchIntervalInBackground: true,
    })),
  })
  return accounts.map((account, i) => ({
    account,
    folders: results[i]?.data,
    error: results[i]?.error as Error | null,
    isPending: results[i]?.isPending ?? true,
  }))
}

export interface MergedTag {
  name: string
  color?: string
  /** Accounts that have this tag */
  accountIds: string[]
}

/** Tags of every mail account, merged by name (case-insensitive), sorted by name. */
export function useAllTags() {
  const accounts = useSettings((s) => s.accounts).filter((a) => isMailCapable(a.id))
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: ['mail', 'tags', a.id],
      queryFn: () => providerFor(a.id).tags(a.id),
      staleTime: 5 * 60_000,
    })),
  })
  return useMemo(() => {
    const map = new Map<string, MergedTag>()
    results.forEach((r, i) => {
      for (const tag of (r.data as MailTag[] | undefined) ?? []) {
        const k = tag.name.toLowerCase()
        const m = map.get(k)
        if (m) {
          m.color ??= tag.color
          m.accountIds.push(accounts[i].id)
        } else map.set(k, { name: tag.name, color: tag.color, accountIds: [accounts[i].id] })
      }
    })
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')])
}

// ---------- Actions ----------

type Patch = Partial<Pick<MailSummary, 'isRead' | 'isFlagged' | 'tags' | 'scheduledAt'>> | ((m: MailSummary) => Partial<MailSummary>)

/** Applies a change to the cached lists and threads immediately (optimistic update). */
function patchCaches(accountId: string, ids: Set<string>, patch: Patch | 'remove') {
  queryClient.setQueriesData<ListResult>({ queryKey: ['mail', 'list', accountId] }, (old) =>
    old
      ? {
          ...old,
          messages:
            patch === 'remove'
              ? old.messages.filter((m) => !ids.has(m.id))
              : old.messages.map((m) => (ids.has(m.id) ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
        }
      : old,
  )
  if (patch !== 'remove')
    queryClient.setQueriesData<MailMessage[]>({ queryKey: ['mail', 'thread', accountId] }, (old) =>
      old?.map((m) => (ids.has(m.id) ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
    )
}

function syncAfter(accountId: string) {
  void queryClient.invalidateQueries({ queryKey: ['mail', 'list', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'thread', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'unread', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'folders', accountId] })
  void queryClient.invalidateQueries({ queryKey: ['mail', 'tags', accountId] })
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
  call: (accountId: string, ids: string[]) => Promise<unknown>,
  successMessage?: string,
  quiet = false,
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
        if (!quiet) useStatus.getState().toast({ tone: 'error', message: t('mail.actionFailed', { reason: (e as Error).message }) })
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
  /** `keep`: the messages stay in the current list (e.g. a tag view) */
  archive: (items: Item[], count = items.length, keep = false) =>
    run(items, keep ? {} : 'remove', (a, ids) => providerFor(a).move(a, ids, 'archive'), i18n.t('mail.archived', { count })),
  trash: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, 'trash'), i18n.t('mail.trashed', { count })),
  moveToInbox: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, 'inbox'), i18n.t('mail.movedToInbox', { count })),
  moveTo: (items: Item[], dest: ListTarget, folderName: string) =>
    run(items, 'remove', (a, ids) => providerFor(a).move(a, ids, dest), i18n.t('mail.moved', { folder: folderName })),
  /** Adds and removes tags (by name) on these messages. */
  setTags: (messages: MailSummary[], add: string[], remove: string[]) => {
    const drop = new Set(remove.map((n) => n.toLowerCase()))
    const next = (m: MailSummary) => uniqueTags([...m.tags.filter((n) => !drop.has(n.toLowerCase())), ...add])
    const byId = new Map(messages.map((m) => [`${m.accountId}|${m.id}`, m]))
    return run(
      messages,
      (m) => ({ tags: next(byId.get(`${m.accountId}|${m.id}`) ?? m) }),
      (a, ids) => providerFor(a).setTags(a, ids.map((id) => byId.get(`${a}|${id}`)!).map((m) => ({ id: m.id, tags: m.tags })), add, remove),
    )
  },
  /** Out of the Inbox until `until` (see snooze.ts). */
  snooze: (items: Item[], until: number, count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).snooze(a, ids, until), i18n.t('mail.snoozed', { count, time: shortDateTime(until) })),
  /** Back to the Inbox now, unread. `quiet`: no messages (the automatic wake-up reports itself). */
  unsnooze: (items: Item[], count = items.length, quiet = false) =>
    run(items, 'remove', (a, ids) => providerFor(a).unsnooze(a, ids), quiet ? undefined : i18n.t('mail.unsnoozed', { count }), quiet),
  /** Scheduled messages back to Drafts. */
  unschedule: (items: Item[], count = items.length) =>
    run(items, 'remove', async (a, ids) => {
      for (const id of ids) await providerFor(a).unschedule(a, id)
    }, i18n.t('mail.unscheduled', { count })),
  /** A new send time for scheduled messages. */
  reschedule: (items: Item[], at: number) =>
    run(items, { scheduledAt: at }, async (a, ids) => {
      for (const id of ids) await providerFor(a).scheduleDraft(a, id, at)
    }, i18n.t('compose.scheduled', { time: shortDateTime(at) })),
  /**
   * Delete or archive with an "Undo" button (swiping on phones). Undo moves the messages back to
   * `from`, the list they were swiped in; Outlook gives moved messages new ids, so those are kept.
   */
  async moveWithUndo(items: Item[], dest: 'trash' | 'archive', from: ListTarget, count = items.length) {
    const t = i18n.t.bind(i18n)
    const moved = new Map<string, string[]>()
    let failed = false
    await Promise.all(
      [...groupByAccount(items)].map(async ([accountId, ids]) => {
        patchCaches(accountId, new Set(ids), 'remove')
        try {
          moved.set(accountId, (await providerFor(accountId).move(accountId, ids, dest)) || ids)
        } catch (e) {
          failed = true
          useStatus.getState().toast({ tone: 'error', message: t('mail.actionFailed', { reason: (e as Error).message }) })
        } finally {
          syncAfter(accountId)
        }
      }),
    )
    if (failed) return false
    const undo = async () => {
      for (const [accountId, ids] of moved) {
        try {
          await providerFor(accountId).move(accountId, ids, from)
        } catch (e) {
          useStatus.getState().toast({ tone: 'error', message: t('mail.actionFailed', { reason: (e as Error).message }) })
        } finally {
          syncAfter(accountId)
        }
      }
    }
    useStatus.getState().toast({
      tone: 'success',
      message: dest === 'trash' ? t('mail.trashed', { count }) : t('mail.archived', { count }),
      action: { label: t('mail.undo'), run: () => void undo() },
    })
    return true
  },
  deleteForever: (items: Item[], count = items.length) =>
    run(items, 'remove', (a, ids) => providerFor(a).deleteForever(a, ids), i18n.t('mail.deletedForever', { count })),
}

/** After sending or saving, make lists and threads reflect the server. */
export function refreshAccountMail(accountId: string) {
  syncAfter(accountId)
}
