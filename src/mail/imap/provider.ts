import type { SpecialFolder } from '../../settings/store'
import type { Attachment, FolderKind, ListTarget, MailFolder, MailMessage, MailProvider, MailSummary } from '../types'
import { isDeleted, isDraftFlag, isFlagged, isSeen, parseSummary, SUMMARY_ITEMS, threadRoot, type FetchedSummary } from './envelope'
import { isInbox, type ListedFolder } from './folders'
import { folderId, folderPath, messageId, parseMessageId, parseThreadId, threadIdOf } from './ids'
import { parseMessage, type ParsedMessage } from './message'
import { asList, asText, fetchAttributes, type ImapResponse } from './parse'
import { NotYetError, session, type Ctx } from './session'

/**
 * Mail adapter for IMAP accounts (through the user's bridge, see bridge/worker.js).
 *
 * Threads are built by the app from References / In-Reply-To (IMAP has no conversations): a
 * thread is identified by its first Message-ID, and opening it searches the folders where its
 * messages were seen, plus Inbox, Sent and Archive.
 */

// ---------- Caches (memory only) ----------

/** Folders where each thread's messages were listed, to find them again when it's opened */
const threadFolders = new Map<string, Set<string>>()
/** Whole messages already downloaded and parsed (a few, for attachments and re-opening) */
const parsed = new Map<string, ParsedMessage>()
const PARSED_MAX = 30

function remember(key: string, p: ParsedMessage) {
  parsed.delete(key)
  parsed.set(key, p)
  while (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!)
}

const cacheKey = (accountId: string, id: string) => `${accountId}|${id}`

// ---------- Helpers ----------

type Special = Partial<Record<SpecialFolder, string>>

function kindOfPath(path: string, special: Special): Exclude<FolderKind, 'starred'> | undefined {
  if (isInbox(path)) return 'inbox'
  for (const [k, p] of Object.entries(special) as [SpecialFolder, string][]) if (p === path) return k
  return undefined
}

function toSummary(accountId: string, path: string, uidValidity: number, s: FetchedSummary): MailSummary {
  const id = messageId({ path, uidValidity, uid: s.uid })
  const threadId = threadIdOf(threadRoot(s), id)
  if (threadId.startsWith('m')) {
    const k = cacheKey(accountId, threadId)
    const set = threadFolders.get(k) ?? new Set<string>()
    set.add(path)
    threadFolders.set(k, set)
  }
  return {
    accountId,
    id,
    threadId,
    subject: s.subject,
    snippet: parsed.get(cacheKey(accountId, id))?.snippet ?? '',
    from: s.from,
    to: s.to,
    date: s.date,
    isRead: isSeen(s.flags),
    isFlagged: isFlagged(s.flags),
    hasAttachments: s.hasAttachments,
    isDraft: isDraftFlag(s.flags),
    tags: [],
  }
}

function summariesFrom(responses: ImapResponse[]) {
  return responses
    .filter((r) => r.type === 'FETCH')
    .map((r) => fetchAttributes(r))
    .filter((a) => a.has('ENVELOPE') && a.has('UID'))
    .map(parseSummary)
    .filter((s) => !isDeleted(s.flags))
}

/** The newest `count` messages of a folder (by sequence number: no search needed). */
async function listFolder(ctx: Ctx, accountId: string, path: string, count: number) {
  const box = await ctx.select(path)
  if (!box.exists) return { messages: [], hasMore: false }
  const from = Math.max(1, box.exists - count + 1)
  const r = await ctx.client.run([`FETCH ${from}:${box.exists} ${SUMMARY_ITEMS}`], 120_000)
  return { messages: summariesFrom(r.untagged).map((s) => toSummary(accountId, path, box.uidValidity, s)), hasMore: from > 1 }
}

/** UIDs found by a search in the open folder. */
async function search(ctx: Ctx, criteria: string): Promise<number[]> {
  const r = await ctx.client.run([`UID SEARCH ${criteria}`], 120_000)
  return r.untagged.filter((u) => u.type === 'SEARCH').flatMap((u) => u.values.map((v) => Number(asText(v)))).filter(Boolean)
}

async function fetchByUid(ctx: Ctx, accountId: string, path: string, uids: number[]) {
  if (!uids.length) return []
  const box = await ctx.select(path)
  const r = await ctx.client.run([`UID FETCH ${uids.join(',')} ${SUMMARY_ITEMS}`], 120_000)
  return summariesFrom(r.untagged).map((s) => toSummary(accountId, path, box.uidValidity, s))
}

/** A message's folder must still have the same UIDVALIDITY, or its UIDs mean other messages. */
async function selectFor(ctx: Ctx, id: string) {
  const ref = parseMessageId(id)
  const box = await ctx.select(ref.path)
  if (box.uidValidity !== ref.uidValidity) throw new Error('The folder was reset on the server; reload the list.')
  return ref
}

async function loadParsed(ctx: Ctx, accountId: string, id: string): Promise<ParsedMessage> {
  const cached = parsed.get(cacheKey(accountId, id))
  if (cached) return cached
  const ref = await selectFor(ctx, id)
  // BODY.PEEK: downloading a message doesn't mark it as read.
  const r = await ctx.client.run([`UID FETCH ${ref.uid} (BODY.PEEK[])`], 300_000)
  const raw = r.untagged.filter((u) => u.type === 'FETCH').map(fetchAttributes).find((a) => a.has('BODY[]'))?.get('BODY[]')
  if (!(raw instanceof Uint8Array)) throw new Error('The message is no longer on the server.')
  const p = await parseMessage(raw)
  remember(cacheKey(accountId, id), p)
  return p
}

function groupByFolder(ids: string[]) {
  const m = new Map<string, string[]>()
  for (const id of ids) {
    const path = parseMessageId(id).path
    m.set(path, [...(m.get(path) ?? []), id])
  }
  return m
}

async function storeFlags(accountId: string, ids: string[], op: '+' | '-', flag: string) {
  await session(accountId).run(async (ctx) => {
    for (const [, group] of groupByFolder(ids)) {
      const uids = []
      for (const id of group) uids.push((await selectFor(ctx, id)).uid)
      await ctx.client.run([`UID STORE ${uids.join(',')} ${op}FLAGS.SILENT (${flag})`])
    }
  })
}

const notYet = async (): Promise<never> => {
  throw new NotYetError()
}

// ---------- The adapter ----------

export const imap: MailProvider = {
  async list(accountId, target: ListTarget, count) {
    return session(accountId).run(async (ctx) => {
      if (typeof target === 'string') {
        if (target === 'inbox') return listFolder(ctx, accountId, 'INBOX', count)
        if (target === 'snoozed' || target === 'scheduled') return { messages: [], hasMore: false }
        const { special } = await ctx.folders()
        if (target === 'starred') {
          // Flagged messages of the Inbox and the Archive, newest first.
          const out: MailSummary[] = []
          for (const path of ['INBOX', special.archive].filter((p): p is string => !!p)) {
            await ctx.select(path)
            const uids = (await search(ctx, 'FLAGGED')).slice(-count)
            out.push(...(await fetchByUid(ctx, accountId, path, uids)))
          }
          return { messages: out, hasMore: false }
        }
        const path = special[target as SpecialFolder]
        return path ? listFolder(ctx, accountId, path, count) : { messages: [], hasMore: false }
      }
      if ('folderId' in target) return listFolder(ctx, accountId, folderPath(target.folderId), count)
      // Search and tags come in a later version.
      return { messages: [], hasMore: false }
    })
  },

  async thread(accountId, threadId) {
    return session(accountId).run(async (ctx) => {
      const { special, list } = await ctx.folders()
      const t = parseThreadId(threadId)
      let summaries: MailSummary[] = []
      if ('message' in t) {
        const ref = parseMessageId(t.message)
        summaries = await fetchByUid(ctx, accountId, ref.path, [ref.uid])
      } else {
        const seen = threadFolders.get(cacheKey(accountId, threadId))
        const where = new Set<string>([...(seen ?? []), 'INBOX', special.sent, special.archive].filter((p): p is string => !!p))
        // Opened from an address without a list (e.g. a link): look in every folder.
        if (!seen) for (const f of list) if (f.selectable && f.path !== special.trash && f.path !== special.spam) where.add(f.path)
        const id = t.root.replace(/["\\]/g, '')
        for (const path of where) {
          await ctx.select(path)
          const uids = await search(ctx, `OR HEADER Message-ID "${id}" HEADER References "${id}"`)
          summaries.push(...(await fetchByUid(ctx, accountId, path, uids)))
        }
      }
      // The same message can sit in two folders (e.g. a copy): keep one.
      const unique = new Map<string, MailSummary>()
      for (const s of summaries.sort((a, b) => a.date - b.date)) unique.set(`${s.from.email}|${s.date}|${s.subject}`, s)
      const out: MailMessage[] = []
      for (const s of unique.values()) {
        const p = await loadParsed(ctx, accountId, s.id)
        const path = parseMessageId(s.id).path
        out.push({
          ...s,
          threadId,
          snippet: p.snippet,
          hasAttachments: p.attachments.some((a) => !a.meta.isInline),
          cc: p.cc,
          bcc: p.bcc,
          replyTo: p.replyTo,
          bodyHtml: p.bodyHtml,
          bodyIsHtml: p.bodyIsHtml,
          folderId: folderId(path),
          folderKind: kindOfPath(path, special),
        })
      }
      return out
    })
  },

  setRead: (accountId, ids, read) => storeFlags(accountId, ids, read ? '+' : '-', '\\Seen'),
  setFlagged: (accountId, ids, flagged) => storeFlags(accountId, ids, flagged ? '+' : '-', '\\Flagged'),

  move: notYet,
  deleteForever: notYet,
  snooze: notYet,
  unsnooze: notYet,

  async folders(accountId) {
    return session(accountId).run(async (ctx) => {
      const { list, special } = await ctx.folders(true)
      const specialPaths = new Set(Object.values(special))
      const own = list.filter((f) => !isInbox(f.path) && !specialPaths.has(f.path))
      const out: MailFolder[] = []
      for (const f of own) {
        out.push({ id: folderId(f.path), name: f.name, depth: f.depth, unread: f.selectable ? await unseen(ctx, f) : 0 })
      }
      return out
    })
  },

  tags: async () => [],
  setTags: notYet,

  async unreadCount(accountId, folder) {
    return session(accountId).run(async (ctx) => {
      if (folder === 'inbox') return unseen(ctx, { path: 'INBOX' })
      const path = (await ctx.folders()).special[folder as SpecialFolder]
      return path ? unseen(ctx, { path }) : 0
    }, true)
  },

  async attachments(accountId, id): Promise<Attachment[]> {
    return session(accountId).run(async (ctx) => (await loadParsed(ctx, accountId, id)).attachments.map((a) => a.meta))
  },

  async downloadAttachment(accountId, id, attachmentId) {
    return session(accountId).run(async (ctx) => {
      const a = (await loadParsed(ctx, accountId, id)).attachments.find((x) => x.meta.id === attachmentId)
      if (!a) throw new Error('Attachment not found')
      return a.blob
    })
  },

  async inlineImages(accountId, id) {
    return session(accountId).run(async (ctx) => {
      const map = new Map<string, Blob>()
      for (const a of (await loadParsed(ctx, accountId, id)).attachments) if (a.contentId && a.meta.contentType.startsWith('image/')) map.set(a.contentId, a.blob)
      return map
    })
  },

  // Writing mail comes in a later version (the app doesn't offer it for IMAP accounts yet).
  createDraft: notYet,
  updateDraft: notYet,
  addAttachment: notYet,
  removeAttachment: notYet,
  sendDraft: notYet,
  scheduleDraft: notYet,
  unschedule: notYet,
  sendsScheduledItself: false,
  sendScheduled: notYet,
  deleteDraft: notYet,
  loadDraft: notYet,
}

/** Unread messages of a folder (STATUS doesn't change the open folder). */
async function unseen(ctx: Ctx, f: Pick<ListedFolder, 'path'>) {
  try {
    const r = await ctx.client.run(['STATUS ', { str: f.path }, ' (UNSEEN)'])
    const st = r.untagged.find((u) => u.type === 'STATUS')
    const items = asList(st?.values[1])
    for (let i = 0; i + 1 < items.length; i += 2) if (asText(items[i]).toUpperCase() === 'UNSEEN') return Number(asText(items[i + 1])) || 0
    return 0
  } catch {
    return 0 // some servers refuse STATUS on special mailboxes
  }
}

/** All folders of an account (for choosing special folders by hand in its settings). */
export function listFolders(accountId: string) {
  return session(accountId).run(async (ctx) => {
    const { list, special } = await ctx.folders(true)
    return { list: list.filter((f) => f.selectable), special }
  })
}
