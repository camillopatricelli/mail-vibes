import i18n from '../../i18n'
import { accountLabel, specialFolders, useSettings, type SpecialFolder } from '../../settings/store'
import { useStatus } from '../../status/store'
import { escapeHtml, sanitizeForEditor } from '../html'
import { buildMime, rfc5322Date } from '../mime'
import type { Address, Attachment, DraftContent, FolderKind, ListTarget, MailFolder, MailMessage, MailProvider, MailSummary, MailTag, PecDetails, ReplyKind } from '../types'
import { isDeleted, isDraftFlag, isFlagged, isSeen, parseInternalDate, parseSummary, SUMMARY_ITEMS, threadRoot, type FetchedSummary } from './envelope'
import { isInbox, type ListedFolder } from './folders'
import { folderId, folderPath, messageId, parseMessageId, parseThreadId, threadIdOf } from './ids'
import { parseMessage, type ParsedMessage } from './message'
import { originalSender, originalSubject, pecHeaders, pecView } from './pec'
import { MailServerError, type CommandResult, type Part } from './client'
import { asList, asText, encodeMailboxName, fetchAttributes, type ImapResponse } from './parse'
import { isAppFolder, keywordToTag, tagToKeyword, timedFolderTime, timedPath, type Namespace, type TimedKind } from './keywords'
import { formatKb, nearlyFull, storageUsage } from './quota'
import { copiedUids, ruleCriteria, searchCriteria, SearchRefusedError } from './search'
import { getPassword, smtpKey } from './passwords'
import { session, type Ctx, type Selected } from './session'
import { rewriteHeaders, SmtpClient } from './smtp'

/**
 * Mail adapter for IMAP accounts (through the user's bridge, see bridge/worker.js).
 *
 * Threads are built by the app from References / In-Reply-To (IMAP has no conversations): a
 * thread is identified by its first Message-ID, and opening it searches the folders where its
 * messages were seen, plus Inbox, Sent and Archive. PEC servers search headers very slowly
 * (half a minute on a big Inbox), so PEC threads hold only the messages already listed.
 */

// ---------- Caches (memory only) ----------

/** Folders where each thread's messages were listed, to find them again when it's opened */
const threadFolders = new Map<string, Set<string>>()
/** Messages listed for each thread (PEC accounts open threads from these, without searching) */
const threadMessages = new Map<string, Set<string>>()
/** When each PEC account's latest sent messages were last listed (see thread) */
const sentPrimed = new Map<string, number>()
/** Where moved messages came from (new id -> old folder), so "Undo" from Starred or a search puts them back */
const movedFrom = new Map<string, string>()
/** Whole messages already downloaded and parsed (a few, for attachments and re-opening) */
type Shown = ParsedMessage & { pec?: PecDetails }
const parsed = new Map<string, Shown>()
const PARSED_MAX = 30

function remember(key: string, p: Shown) {
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

/** Keywords seen on each account's messages (IMAP can't list them all), for the tag list */
const seenKeywords = new Map<string, Set<string>>()

function tagsOf(accountId: string, flags: string[]) {
  const tags: string[] = []
  for (const f of flags) {
    const tag = keywordToTag(f)
    if (!tag) continue
    tags.push(tag)
    const set = seenKeywords.get(accountId) ?? new Set<string>()
    set.add(f)
    seenKeywords.set(accountId, set)
  }
  return tags
}

function toSummary(accountId: string, path: string, uidValidity: number, s: FetchedSummary): MailSummary {
  const id = messageId({ path, uidValidity, uid: s.uid })
  const threadId = threadIdOf(threadRoot(s), id)
  if (threadId.startsWith('m')) {
    const k = cacheKey(accountId, threadId)
    const set = threadFolders.get(k) ?? new Set<string>()
    set.add(path)
    threadFolders.set(k, set)
    const ids = threadMessages.get(k) ?? new Set<string>()
    ids.add(id)
    threadMessages.set(k, ids)
  }
  // A certified message shows its original sender and subject, not the PEC provider's.
  const certified = s.pec && !s.pec.ricevuta && s.pec.trasporto !== 'errore'
  return {
    accountId,
    id,
    threadId,
    subject: certified ? originalSubject(s.subject) : s.subject,
    snippet: parsed.get(cacheKey(accountId, id))?.snippet ?? '',
    from: certified ? originalSender(s.from, s.replyTo) : s.from,
    to: s.to,
    date: s.date,
    isRead: isSeen(s.flags),
    isFlagged: isFlagged(s.flags),
    hasAttachments: s.hasAttachments,
    isDraft: isDraftFlag(s.flags),
    tags: tagsOf(accountId, s.flags),
    ...timedFields(accountId, path),
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

/**
 * Arrival dates of all messages of a folder (UID -> INTERNALDATE). The order messages were added
 * in isn't their date order (old mail moved or archived into a folder comes last), so lists pick
 * the newest by date. Built once per folder, then only new messages are fetched.
 */
interface DateIndex {
  uidValidity: number
  dates: Map<number, number>
  maxUid: number
}
const dateIndexes = new Map<string, DateIndex>()

function addDates(idx: DateIndex, responses: ImapResponse[]) {
  for (const r of responses) {
    if (r.type !== 'FETCH') continue
    const a = fetchAttributes(r)
    const uid = Number(asText(a.get('UID')))
    if (!uid) continue
    idx.dates.set(uid, parseInternalDate(asText(a.get('INTERNALDATE'))))
    idx.maxUid = Math.max(idx.maxUid, uid)
  }
}

async function datesOf(ctx: Ctx, accountId: string, path: string, box: { uidValidity: number; exists: number }) {
  const key = cacheKey(accountId, path)
  let idx = dateIndexes.get(key)
  if (idx && idx.uidValidity !== box.uidValidity) idx = undefined
  // Always look for new messages, even when the count hasn't changed: another program may have
  // replaced one (webmail re-saving a draft removes the old copy and adds a new one).
  if (idx && box.exists) addDates(idx, (await ctx.client.run([`UID FETCH ${idx.maxUid + 1}:* (UID INTERNALDATE)`], 120_000)).untagged)
  // Messages removed elsewhere (or several new ones in odd order): read all dates again.
  if (!idx || idx.dates.size !== box.exists) {
    idx = { uidValidity: box.uidValidity, dates: new Map(), maxUid: 0 }
    addDates(idx, (await ctx.client.run(['FETCH 1:* (UID INTERNALDATE)'], 180_000)).untagged)
  }
  dateIndexes.set(key, idx)
  return idx
}

/** After this app moved or deleted messages: they're no longer in the folder. */
function forgetDates(accountId: string, path: string, uids: number[]) {
  const idx = dateIndexes.get(cacheKey(accountId, path))
  for (const u of uids) idx?.dates.delete(u)
}

/** The newest `count` messages of a folder (only unread ones if asked), by arrival date. */
async function listFolder(ctx: Ctx, accountId: string, path: string, count: number, unread = false) {
  const box = await ctx.select(path, true)
  if (!box.exists) return { messages: [], hasMore: false }
  const idx = await datesOf(ctx, accountId, path, box)
  if (isInbox(path)) {
    await runRules(ctx, accountId, box, idx)
    await checkQuota(ctx, accountId)
    await ctx.select(path)
  }
  let pool = [...idx.dates]
  if (unread) {
    const unseen = new Set(await search(ctx, 'UNSEEN'))
    pool = pool.filter(([uid]) => unseen.has(uid))
  }
  const newest = pool.sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, count).map(([uid]) => uid)
  if (!newest.length) return { messages: [], hasMore: false }
  const r = await ctx.client.run([`UID FETCH ${newest.join(',')} ${SUMMARY_ITEMS}`], 120_000)
  const summaries = summariesFrom(r.untagged)
  if (!ctx.account.imap?.pec && summaries.some((s) => s.pec)) suggestPec(accountId)
  return { messages: summaries.map((s) => toSummary(accountId, path, box.uidValidity, s)), hasMore: pool.length > count }
}

/** PEC messages in an account not marked as PEC: offer to mark it (once per session). */
const pecSuggested = new Set<string>()
function suggestPec(accountId: string) {
  if (pecSuggested.has(accountId)) return
  pecSuggested.add(accountId)
  const account = useSettings.getState().accounts.find((a) => a.id === accountId)
  if (!account?.imap) return
  useStatus.getState().toast({
    tone: 'info',
    message: i18n.t('imap.pecDetected', { account: account.email }),
    action: {
      label: i18n.t('imap.pecTurnOn'),
      run: () => {
        const now = useSettings.getState().accounts.find((a) => a.id === accountId)
        if (now?.imap) useSettings.getState().updateAccount(accountId, { imap: { ...now.imap, pec: true } })
      },
    },
  })
}

/** UIDs found by a search in the open folder. */
async function search(ctx: Ctx, criteria: string | Part[]): Promise<number[]> {
  const r = await ctx.client.run(['UID SEARCH ', ...(typeof criteria === 'string' ? [criteria] : criteria)], 180_000)
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

/** A whole message as stored. BODY.PEEK: downloading a message doesn't mark it as read. */
async function loadRaw(ctx: Ctx, id: string): Promise<Uint8Array> {
  const ref = await selectFor(ctx, id)
  const r = await ctx.client.run([`UID FETCH ${ref.uid} (BODY.PEEK[])`], 300_000)
  const raw = r.untagged.filter((u) => u.type === 'FETCH').map(fetchAttributes).find((a) => a.has('BODY[]'))?.get('BODY[]')
  if (!(raw instanceof Uint8Array)) throw new Error('The message is no longer on the server.')
  return raw
}

async function loadParsed(ctx: Ctx, accountId: string, id: string): Promise<Shown> {
  const cached = parsed.get(cacheKey(accountId, id))
  if (cached) return cached
  const raw = await loadRaw(ctx, id)
  const outer = await parseMessage(raw)
  const h = pecHeaders(['x-trasporto', 'x-ricevuta', 'x-riferimento-message-id'].map((k) => `${k}: ${outer.headers.get(k) ?? ''}`).join('\n'))
  const p: Shown = h ? await pecView(raw, outer, h) : outer
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

/** Removes messages of the open folder for good (marked \Deleted, then expunged). */
async function expunge(ctx: Ctx, uidSet: string) {
  await ctx.client.run([`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`])
  // Without UIDPLUS, EXPUNGE also removes other messages marked deleted (the app hides those anyway).
  await ctx.client.run([ctx.client.has('UIDPLUS') ? `UID EXPUNGE ${uidSet}` : 'EXPUNGE'], 120_000)
}

/** Search the Inbox, Sent, Archive and the user's folders (not Trash, Junk, Drafts); newest first. */
async function searchMail(ctx: Ctx, accountId: string, target: { search: string; inbox?: boolean }, count: number, unread = false) {
  const criteria = searchCriteria(target.search, !!ctx.account.imap?.pec)
  if (!criteria) return { messages: [], hasMore: false }
  try {
    return await searchFolders(ctx, accountId, criteria, count, !!target.inbox, unread)
  } catch (e) {
    // The server answered "NO"/"BAD": it can't do this search (e.g. some characters or words).
    if (e instanceof MailServerError && e.kind === 'server') throw new SearchRefusedError(e.message)
    throw e
  }
}

async function searchFolders(ctx: Ctx, accountId: string, criteria: string | Part[], count: number, inboxOnly = false, unread = false) {
  // After the criteria: a CHARSET must stay first.
  if (unread) criteria = typeof criteria === 'string' ? `${criteria} UNSEEN` : [...criteria, ' UNSEEN']
  const { list, special } = await ctx.folders()
  const ns = namespaceOf(list)
  const skip = new Set([special.trash, special.spam, special.drafts])
  const paths = inboxOnly
    ? ['INBOX']
    : ['INBOX', ...list.filter((f) => f.selectable && !isInbox(f.path) && !skip.has(f.path) && !(ns && isAppFolder(f.path, ns))).map((f) => f.path)]
  const out: MailSummary[] = []
  let hasMore = false
  for (const path of paths) {
    await ctx.select(path)
    const uids = (await search(ctx, criteria)).sort((a, b) => a - b)
    if (uids.length > count) hasMore = true
    out.push(...(await fetchByUid(ctx, accountId, path, uids.slice(-count))))
  }
  out.sort((a, b) => b.date - a.date)
  return { messages: out.slice(0, count), hasMore: hasMore || out.length > count }
}

/** The folder a move goes to. A missing Archive folder is created (Archive must always work). */
async function destination(ctx: Ctx, dest: ListTarget, from: string): Promise<string> {
  if (typeof dest === 'object' && 'folderId' in dest) return folderPath(dest.folderId)
  if (dest === 'inbox') return 'INBOX'
  if (typeof dest === 'string' && (specialFolders as string[]).includes(dest)) {
    const kind = dest as SpecialFolder
    const { special } = await ctx.folders()
    if (special[kind]) return special[kind]!
    if (kind === 'archive') return createArchive(ctx)
    throw new Error(i18n.t('imap.noSpecialFolder', { folder: i18n.t(`imap.folder.${kind}`) }))
  }
  // Back from Starred or a search ("Undo"): where the message was before.
  return from
}

/** Where new folders go: servers that keep every folder under "INBOX." want new ones there too. */
function namespaceOf(list: ListedFolder[]): Namespace | undefined {
  const delimiter = list.find((f) => f.delimiter)?.delimiter
  if (!delimiter) return undefined
  const others = list.filter((f) => !isInbox(f.path))
  const prefix = others.length && others.every((f) => f.path.toUpperCase().startsWith(`INBOX${delimiter}`)) ? `INBOX${delimiter}` : ''
  return { prefix, delimiter }
}

async function createArchive(ctx: Ctx): Promise<string> {
  const { list } = await ctx.folders()
  const path = (namespaceOf(list)?.prefix ?? '') + encodeMailboxName(i18n.t('imap.folder.archive'))
  await ctx.client.run(['CREATE ', { str: path }])
  await ctx.client.run(['SUBSCRIBE ', { str: path }]).catch(() => undefined)
  ctx.forgetFolders()
  return (await ctx.folders()).special.archive ?? path
}

/** Moves messages of one folder; answers their new ids (from COPYUID when the server says). */
async function moveFrom(ctx: Ctx, accountId: string, path: string, ids: string[], to: string): Promise<string[]> {
  if (to === path) return ids
  const refs = []
  for (const id of ids) refs.push(await selectFor(ctx, id))
  const set = refs.map((r) => r.uid).join(',')
  let r: CommandResult
  if (ctx.client.has('MOVE')) r = await ctx.client.run([`UID MOVE ${set} `, { str: to }], 120_000)
  else {
    r = await ctx.client.run([`UID COPY ${set} `, { str: to }], 120_000)
    await expunge(ctx, set)
  }
  forgetDates(accountId, path, refs.map((x) => x.uid))
  const copied = copiedUids([...r.untagged, r.done])
  return refs.map((ref) => {
    const uid = copied?.map.get(ref.uid)
    const id = copied && uid ? messageId({ path: to, uidValidity: copied.uidValidity, uid }) : messageId(ref)
    movedFrom.set(id, path)
    return id
  })
}

// ---------- Rules (IMAP servers have none: the app runs them on new Inbox mail) ----------

/** The last Inbox message the rules have seen and when, as "UIDVALIDITY:UID:time" (no message content). */
const RULES_SEEN = 'mail-vibes.imap-rules-seen.'
const ruleErrors = new Set<string>()

async function runRules(ctx: Ctx, accountId: string, box: Selected, idx: DateIndex) {
  const key = RULES_SEEN + accountId
  let seen = ''
  try {
    seen = localStorage.getItem(key) ?? ''
  } catch {
    return
  }
  const [validity, last, lastRun] = seen.split(':').map(Number)
  const save = () => {
    try {
      localStorage.setItem(key, `${box.uidValidity}:${idx.maxUid}:${Date.now()}`)
    } catch {
      // Private mode: the rules run again on the same mail next time (harmless).
    }
  }
  const rules = ctx.account.imap?.rules ?? []
  // First run, or the Inbox was reset on the server: rules act on mail from now on.
  if (validity !== box.uidValidity || !last || !rules.length || idx.maxUid <= last) return save()
  const pec = !!ctx.account.imap?.pec
  // Mail moved back into the Inbox (unsnoozed, or by hand) is new to the Inbox but keeps its
  // arrival time: rules, like Gmail's and Outlook's, are for mail as it arrives.
  const since = (lastRun || 0) - 10 * 60_000
  const arrived = (u: number) => u > last && (idx.dates.get(u) ?? 0) >= since
  for (const rule of rules) {
    const criteria = ruleCriteria(rule, pec, last + 1)
    if (!criteria) continue
    try {
      await ctx.select('INBOX')
      // "UID n:*" always includes the newest message, even when it's older than n.
      const uids = (await search(ctx, criteria)).filter(arrived)
      if (!uids.length) continue
      if (rule.markRead) await ctx.client.run([`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Seen)`])
      if (rule.move.kind === 'none') continue
      const dest: ListTarget = rule.move.kind === 'folder' ? { folderId: rule.move.id } : rule.move.kind === 'delete' ? 'trash' : 'archive'
      const to = await destination(ctx, dest, 'INBOX')
      const ids = uids.map((uid) => messageId({ path: 'INBOX', uidValidity: box.uidValidity, uid }))
      await moveFrom(ctx, accountId, 'INBOX', ids, to)
    } catch (e) {
      // Once per rule and session: a broken rule (e.g. its folder was deleted) mustn't block the Inbox.
      if (ruleErrors.has(rule.id)) continue
      ruleErrors.add(rule.id)
      useStatus.getState().toast({ tone: 'error', message: i18n.t('imap.ruleFailed', { reason: (e as Error).message }) })
    }
  }
  save()
}

// ---------- Mailbox storage ----------

const quotaChecked = new Map<string, number>()

/** Warns (a banner until dismissed) when the mailbox is nearly full; checked every few hours. */
async function checkQuota(ctx: Ctx, accountId: string) {
  if (!ctx.client.has('QUOTA') || Date.now() - (quotaChecked.get(accountId) ?? 0) < 6 * 3600_000) return
  quotaChecked.set(accountId, Date.now())
  const r = await ctx.client.run(['GETQUOTAROOT INBOX']).catch(() => undefined)
  const u = r && storageUsage(r.untagged)
  const status = useStatus.getState()
  const id = `imap-quota-${accountId}`
  if (!u || !nearlyFull(u)) return status.dismissBanner(id)
  const a = ctx.account
  const text = () => ({
    title: i18n.t('imap.quotaTitle', { account: accountLabel(a), percent: Math.min(100, Math.floor((u.usedKb * 100) / u.limitKb)) }),
    body: i18n.t(a.imap?.pec ? 'imap.quotaPec' : 'imap.quota', { used: formatKb(u.usedKb), limit: formatKb(u.limitKb) }),
  })
  status.showBanner({ id, tone: 'warning', accountId, ...text(), text, dismissible: true })
}

// ---------- Snoozed and scheduled mail: folders named after the time ----------

/** The time folders seen, by account and path: their messages are snoozed or scheduled until then */
const timedAt = new Map<string, { kind: TimedKind; at: number }>()

function timedFields(accountId: string, path: string): Pick<MailSummary, 'snoozedUntil' | 'scheduledAt'> {
  const t = timedAt.get(cacheKey(accountId, path))
  if (!t) return {}
  return t.kind === 'Snoozed' ? { snoozedUntil: t.at } : { scheduledAt: t.at }
}

async function timedFolders(ctx: Ctx, kind: TimedKind) {
  const { list } = await ctx.folders(true)
  const ns = namespaceOf(list)
  if (!ns) return []
  return list.flatMap((f) => {
    const at = f.selectable ? timedFolderTime(f.path, ns, kind) : undefined
    if (at === undefined) return []
    timedAt.set(cacheKey(ctx.account.id, f.path), { kind, at })
    return [{ path: f.path, at }]
  })
}

async function timedFolder(ctx: Ctx, kind: TimedKind, at: number) {
  const { list } = await ctx.folders()
  const ns = namespaceOf(list)
  if (!ns) throw new Error(i18n.t('imap.noHierarchy'))
  const path = timedPath(ns, kind, at)
  if (!list.some((f) => f.path === path)) {
    await ctx.client.run(['CREATE ', { str: path }]).catch(async (e) => {
      // Created meanwhile (another device)? Then it's fine.
      ctx.forgetFolders()
      if (!(await ctx.folders()).list.some((f) => f.path === path)) throw e
    })
    ctx.forgetFolders()
  }
  return path
}

/** Removes the time folders that have become empty. */
async function dropEmptyTimed(ctx: Ctx, kind: TimedKind) {
  for (const f of await timedFolders(ctx, kind)) {
    const r = await ctx.client.run(['STATUS ', { str: f.path }, ' (MESSAGES)']).catch(() => undefined)
    const items = asList(r?.untagged.find((u) => u.type === 'STATUS')?.values[1])
    const i = items.findIndex((v) => asText(v).toUpperCase() === 'MESSAGES')
    if (i < 0 || Number(asText(items[i + 1])) !== 0) continue
    await ctx.select('INBOX') // a folder can't be deleted while it's open
    await ctx.client.run(['DELETE ', { str: f.path }]).catch(() => undefined)
  }
  ctx.forgetFolders()
}

async function listTimed(ctx: Ctx, accountId: string, kind: TimedKind, count: number) {
  const out: MailSummary[] = []
  for (const f of await timedFolders(ctx, kind)) {
    out.push(...(await listFolder(ctx, accountId, f.path, count)).messages)
  }
  out.sort((a, b) => b.date - a.date)
  return { messages: out.slice(0, count), hasMore: out.length > count }
}


// ---------- Writing mail ----------

interface DraftFile {
  meta: Attachment
  blob: Blob
  contentId?: string
}

/**
 * A message being written. The composer knows it by a handle that never changes; each save puts
 * a new copy in the Drafts folder (IMAP messages can't be edited) and removes the previous one.
 */
interface ImapDraft {
  content: DraftContent
  quotedHtml: string
  files: DraftFile[]
  /** Message-ID header, the same in every saved copy and in the sent message */
  messageId: string
  inReplyTo?: string
  references?: string
  /** The message replied to or forwarded, flagged as answered / forwarded once sent */
  source?: { id: string; kind: ReplyKind }
  /** The copy in the Drafts folder (unknown id: saved on a server without UIDPLUS) */
  saved?: { id?: string }
}
const drafts = new Map<string, ImapDraft>()
/** Whether each account's outgoing server puts a copy of sent mail in Sent by itself */
const serverSavesSent = new Map<string, boolean>()

function accountOf(accountId: string) {
  const a = useSettings.getState().accounts.find((x) => x.id === accountId)
  if (!a?.imap) throw new Error('Unknown IMAP account')
  return a
}

const ownAddress = (accountId: string): Address => {
  const a = accountOf(accountId)
  return { name: a.displayName && a.displayName !== a.email ? a.displayName : '', email: a.email }
}

function draftOf(accountId: string, handle: string) {
  const d = drafts.get(cacheKey(accountId, handle))
  if (!d) throw new Error('This draft is no longer open; open it again from Drafts.')
  return d
}

const newMessageId = (email: string) => `<${crypto.randomUUID()}@${email.split('@')[1] || 'mail-vibes'}>`
const prefixed = (subject: string, prefix: 'Re' | 'Fwd') =>
  (prefix === 'Re' ? /^\s*re\s*:/i : /^\s*(fwd?|i)\s*:/i).test(subject) ? subject : `${prefix}: ${subject}`
const who = (a: Address) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)
function dedupe(list: Address[], skip: string[]) {
  const seen = new Set(skip.map((e) => e.toLowerCase()))
  return list.filter((a) => {
    const e = a.email.toLowerCase()
    if (seen.has(e)) return false
    seen.add(e)
    return true
  })
}

async function draftBytes(accountId: string, d: ImapDraft, withBcc: boolean) {
  const blob = await buildMime({
    from: ownAddress(accountId),
    to: d.content.to,
    cc: d.content.cc,
    bcc: withBcc ? d.content.bcc : [],
    subject: d.content.subject,
    html: d.quotedHtml ? `${d.content.html}<br>${d.quotedHtml}` : d.content.html,
    inReplyTo: d.inReplyTo,
    references: d.references,
    attachments: d.files.map((f) => ({ name: f.meta.name, contentType: f.meta.contentType, blob: f.blob, contentId: f.contentId })),
    messageId: d.messageId,
    date: new Date(),
  })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Adds a message to a folder; answers its id if the server says (UIDPLUS). */
async function append(ctx: Ctx, path: string, raw: Uint8Array, flags: string) {
  const r = await ctx.client.run(['APPEND ', { str: path }, ` (${flags}) `, raw], 300_000)
  const code = [r.done, ...r.untagged].find((x) => x.code?.name === 'APPENDUID')?.code
  const uid = Number(asText(code?.args[1]))
  return code && uid ? messageId({ path, uidValidity: Number(asText(code.args[0])), uid }) : undefined
}

/** UIDs in the Drafts folder holding a draft's copies (servers without UIDPLUS) */
async function draftCopies(ctx: Ctx, path: string, d: ImapDraft) {
  await ctx.select(path)
  return search(ctx, ['HEADER Message-ID ', { str: d.messageId }])
}

async function removeMessages(ctx: Ctx, accountId: string, path: string, uids: number[]) {
  if (!uids.length) return
  await ctx.select(path)
  await expunge(ctx, uids.join(','))
  forgetDates(accountId, path, uids)
}

/** Removes the draft's saved copy, if any. */
async function removeSaved(ctx: Ctx, accountId: string, d: ImapDraft) {
  if (!d.saved) return
  if (d.saved.id) {
    const ref = parseMessageId(d.saved.id)
    const box = await ctx.select(ref.path)
    if (box.uidValidity === ref.uidValidity) await removeMessages(ctx, accountId, ref.path, [ref.uid])
  } else {
    const path = (await ctx.folders()).special.drafts
    if (path) await removeMessages(ctx, accountId, path, await draftCopies(ctx, path, d))
  }
  d.saved = undefined
}

/** Saves the draft in the Drafts folder (without a Drafts folder it stays in the window only). */
async function saveDraft(accountId: string, d: ImapDraft) {
  await session(accountId).run(async (ctx) => {
    const path = (await ctx.folders()).special.drafts
    if (!path) return
    // Without UIDPLUS the previous copies are found by Message-ID, before adding the new one.
    const old = d.saved && !d.saved.id ? await draftCopies(ctx, path, d) : undefined
    const id = await append(ctx, path, await draftBytes(accountId, d, true), '\\Draft \\Seen')
    if (old) await removeMessages(ctx, accountId, path, old)
    else await removeSaved(ctx, accountId, d)
    d.saved = { id }
  })
}

/** Sends through the account's outgoing server. */
async function smtpSend(accountId: string, recipients: string[], raw: Uint8Array) {
  const account = accountOf(accountId)
  const out = account.imap?.outgoing
  const bridge = useSettings.getState().bridge
  if (!out) throw new Error(i18n.t('imap.receiveOnly'))
  if (!bridge) throw new Error(i18n.t('imap.noBridge'))
  const password = await getPassword(out.samePassword ? accountId : smtpKey(accountId))
  if (!password) throw new Error(i18n.t('imap.smtpPasswordMissing'))
  let smtp: SmtpClient | undefined
  try {
    smtp = await SmtpClient.connect(bridge, out)
    await smtp.login(out.username, password)
    await smtp.send(account.email, recipients, raw)
  } catch (e) {
    throw new Error(i18n.t('imap.smtpFailed', { reason: (e as Error).message }))
  } finally {
    await smtp?.quit()
  }
}

/** After sending: a copy in Sent, unless the server puts one there itself (checked once). */
async function keepSentCopy(ctx: Ctx, accountId: string, id: string, raw: Uint8Array) {
  const path = (await ctx.folders()).special.sent
  if (!path) return
  if (!serverSavesSent.has(accountId)) {
    await new Promise((r) => setTimeout(r, 3000))
    await ctx.select(path, true)
    serverSavesSent.set(accountId, (await search(ctx, ['HEADER Message-ID ', { str: id }])).length > 0)
  }
  if (serverSavesSent.get(accountId)) return
  await append(ctx, path, raw, '\\Seen')
}

const composeMethods: Pick<MailProvider, 'createDraft' | 'updateDraft' | 'addAttachment' | 'removeAttachment' | 'sendDraft' | 'deleteDraft' | 'loadDraft'> = {
  async createDraft(accountId, content, replyTo) {
    const me = ownAddress(accountId)
    const d: ImapDraft = { content, quotedHtml: '', files: [], messageId: newMessageId(me.email) }
    if (replyTo) {
      const o = await session(accountId).run((ctx) => loadParsed(ctx, accountId, replyTo.messageId))
      const from = o.from ?? { name: '', email: '' }
      const origId = o.headers.get('message-id')
      const date = new Date(o.date || Date.now()).toLocaleString(i18n.language, { dateStyle: 'full', timeStyle: 'short' })
      const quoted = sanitizeForEditor(o.bodyHtml)
      d.source = { id: replyTo.messageId, kind: replyTo.kind }
      if (replyTo.kind === 'forward') {
        d.content = { ...content, subject: prefixed(o.subject, 'Fwd') }
        d.quotedHtml =
          `<div class="gmail_quote">${escapeHtml(i18n.t('compose.forwardHeader'))}<br>` +
          `${escapeHtml(i18n.t('compose.fieldFrom'))}: ${who(from)}<br>` +
          `${escapeHtml(i18n.t('compose.fieldDate'))}: ${escapeHtml(date)}<br>` +
          `${escapeHtml(i18n.t('compose.subject'))}: ${escapeHtml(o.subject)}<br>` +
          `${escapeHtml(i18n.t('compose.to'))}: ${o.to.map(who).join(', ')}<br><br>${quoted}</div>`
        d.files = o.attachments.map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId }))
      } else {
        const fromMe = from.email.toLowerCase() === me.email.toLowerCase()
        const primary = fromMe ? o.to : o.replyTo.length ? o.replyTo : [from]
        const to = replyTo.kind === 'replyAll' ? dedupe([...primary, ...o.to], [me.email]) : dedupe(primary, [])
        const cc = replyTo.kind === 'replyAll' ? dedupe(o.cc, [me.email, ...to.map((a) => a.email)]) : []
        d.content = { ...content, to, cc, bcc: [], subject: prefixed(o.subject, 'Re') }
        d.inReplyTo = origId
        d.references = [o.headers.get('references'), origId].filter(Boolean).join(' ') || undefined
        d.quotedHtml =
          `<div class="gmail_quote"><div>${escapeHtml(i18n.t('compose.quoteHeader', { date, name: from.name || from.email }))}</div>` +
          `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`
        // Inline images of the quoted message keep working in the reply.
        d.files = o.attachments.filter((a) => a.contentId && a.meta.isInline).map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId }))
      }
    }
    const handle = `draft-${crypto.randomUUID()}`
    drafts.set(cacheKey(accountId, handle), d)
    // Saved to Drafts once the user writes something (an untouched reply is simply closed).
    return { id: handle, quotedHtml: d.quotedHtml, content: d.content }
  },

  async updateDraft(accountId, draft, content) {
    const d = draftOf(accountId, draft.id)
    d.content = content
    await saveDraft(accountId, d)
  },

  async addAttachment(accountId, draftId, file, onProgress) {
    const d = draftOf(accountId, draftId)
    d.files.push({
      meta: { id: crypto.randomUUID(), name: file.name, contentType: file.type || 'application/octet-stream', size: file.size, isInline: false },
      blob: file,
    })
    await saveDraft(accountId, d)
    onProgress?.(1)
    return d.files.map((f) => f.meta)
  },

  async removeAttachment(accountId, draftId, attachmentId) {
    const d = draftOf(accountId, draftId)
    d.files = d.files.filter((f) => f.meta.id !== attachmentId)
    await saveDraft(accountId, d)
  },

  async sendDraft(accountId, draftId) {
    const d = draftOf(accountId, draftId)
    const recipients = [...d.content.to, ...d.content.cc, ...d.content.bcc].map((a) => a.email)
    await smtpSend(accountId, recipients, await draftBytes(accountId, d, false))
    drafts.delete(cacheKey(accountId, draftId))
    // Sent. The rest is tidying up: a failure there is reported but doesn't undo the sending.
    await session(accountId)
      .run(async (ctx) => {
        await removeSaved(ctx, accountId, d)
        await keepSentCopy(ctx, accountId, d.messageId, await draftBytes(accountId, d, true))
        if (d.source) {
          const ref = await selectFor(ctx, d.source.id)
          await ctx.client.run([`UID STORE ${ref.uid} +FLAGS.SILENT (${d.source.kind === 'forward' ? '$Forwarded' : '\\Answered'})`])
        }
      })
      .catch((e) => useStatus.getState().toast({ tone: 'error', message: i18n.t('imap.afterSendFailed', { reason: (e as Error).message }) }))
  },

  async deleteDraft(accountId, draftId) {
    const d = drafts.get(cacheKey(accountId, draftId))
    await session(accountId).run(async (ctx) => {
      if (d) await removeSaved(ctx, accountId, d)
      else {
        // A draft in the Drafts folder that isn't open
        const ref = await selectFor(ctx, draftId)
        await removeMessages(ctx, accountId, ref.path, [ref.uid])
      }
    })
    drafts.delete(cacheKey(accountId, draftId))
  },

  async loadDraft(accountId, id) {
    const p = await session(accountId).run((ctx) => loadParsed(ctx, accountId, id))
    const d: ImapDraft = {
      content: { to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, html: p.bodyHtml },
      quotedHtml: '',
      files: p.attachments.map((a) => ({ meta: a.meta, blob: a.blob, contentId: a.contentId })),
      messageId: p.headers.get('message-id') || newMessageId(accountOf(accountId).email),
      inReplyTo: p.headers.get('in-reply-to'),
      references: p.headers.get('references'),
      saved: { id },
    }
    drafts.set(cacheKey(accountId, id), d)
    return { content: d.content, attachments: d.files.map((f) => f.meta) }
  },
}

// ---------- Sending later ----------

/**
 * A scheduled message waits in a folder named after its send time (see keywords.ts), with its
 * Bcc line; the app sends it when the time comes (see useSnoozeWaker).
 */
const scheduleMethods: Pick<MailProvider, 'scheduleDraft' | 'unschedule' | 'sendScheduled'> = {
  async scheduleDraft(accountId, draftId, at) {
    const d = drafts.get(cacheKey(accountId, draftId))
    await session(accountId).run(async (ctx) => {
      const to = await timedFolder(ctx, 'Send later', at)
      if (d) {
        // An open draft: its message goes to the time folder, its Drafts copy away.
        await append(ctx, to, await draftBytes(accountId, d, true), '\\Draft \\Seen')
        await removeSaved(ctx, accountId, d)
      } else await moveFrom(ctx, accountId, parseMessageId(draftId).path, [draftId], to) // a new time
      await dropEmptyTimed(ctx, 'Send later')
    })
    drafts.delete(cacheKey(accountId, draftId))
  },

  /** Back to Drafts; answers the draft's id there. */
  async unschedule(accountId, id) {
    return session(accountId).run(async (ctx) => {
      const path = (await ctx.folders()).special.drafts
      if (!path) throw new Error(i18n.t('imap.noSpecialFolder', { folder: i18n.t('imap.folder.drafts') }))
      const [moved] = await moveFrom(ctx, accountId, parseMessageId(id).path, [id], path)
      await dropEmptyTimed(ctx, 'Send later')
      return moved
    })
  },

  async sendScheduled(accountId, id) {
    const raw = await session(accountId).run((ctx) => loadRaw(ctx, id))
    const p = await parseMessage(raw)
    const date = rfc5322Date(new Date())
    const recipients = [...p.to, ...p.cc, ...p.bcc].map((a) => a.email)
    if (!recipients.length) throw new Error(i18n.t('compose.needRecipient'))
    await smtpSend(accountId, recipients, rewriteHeaders(raw, date, true))
    await session(accountId).run(async (ctx) => {
      await keepSentCopy(ctx, accountId, p.headers.get('message-id') ?? '', rewriteHeaders(raw, date, false))
      const ref = await selectFor(ctx, id)
      await removeMessages(ctx, accountId, ref.path, [ref.uid])
      await dropEmptyTimed(ctx, 'Send later')
    })
  },
}

/** The messages of a conversation, in whichever folders it spans (no bodies), oldest first. */
async function threadSummaries(ctx: Ctx, accountId: string, threadId: string) {
  const { special, list } = await ctx.folders()
  const t = parseThreadId(threadId)
  let summaries: MailSummary[] = []
  if ('message' in t) {
    const ref = parseMessageId(t.message)
    summaries = await fetchByUid(ctx, accountId, ref.path, [ref.uid])
  } else if (ctx.account.imap?.pec && threadMessages.get(cacheKey(accountId, threadId))?.size) {
    // Receipts belong with the message they're about, usually among the latest in Sent: list
    // those (a quick fetch, unlike a header search) so they join the conversation.
    if (special.sent && Date.now() - (sentPrimed.get(accountId) ?? 0) > 120_000) {
      await listFolder(ctx, accountId, special.sent, 100)
      sentPrimed.set(accountId, Date.now())
    }
    for (const [path, ids] of groupByFolder([...threadMessages.get(cacheKey(accountId, threadId))!])) {
      const box = await ctx.select(path)
      const uids = ids.map(parseMessageId).filter((r) => r.uidValidity === box.uidValidity).map((r) => r.uid)
      summaries.push(...(await fetchByUid(ctx, accountId, path, uids)))
    }
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
  return [...unique.values()]
}

// ---------- The adapter ----------

export const imap: MailProvider = {
  async list(accountId, target: ListTarget, count, options) {
    const unread = !!options?.unread
    return session(accountId).run(async (ctx) => {
      if (typeof target === 'string') {
        if (target === 'inbox') return listFolder(ctx, accountId, 'INBOX', count, unread)
        if (target === 'snoozed') return listTimed(ctx, accountId, 'Snoozed', count)
        if (target === 'scheduled') return listTimed(ctx, accountId, 'Send later', count)
        const { special } = await ctx.folders()
        if (target === 'starred') {
          // Flagged messages of the Inbox and the Archive, newest first.
          const out: MailSummary[] = []
          for (const path of ['INBOX', special.archive].filter((p): p is string => !!p)) {
            await ctx.select(path)
            const uids = (await search(ctx, unread ? 'FLAGGED UNSEEN' : 'FLAGGED')).slice(-count)
            out.push(...(await fetchByUid(ctx, accountId, path, uids)))
          }
          return { messages: out, hasMore: false }
        }
        const path = special[target as SpecialFolder]
        return path ? listFolder(ctx, accountId, path, count, unread) : { messages: [], hasMore: false }
      }
      if ('folderId' in target) return listFolder(ctx, accountId, folderPath(target.folderId), count, unread)
      if ('search' in target) return searchMail(ctx, accountId, target, count, unread)
      return searchFolders(ctx, accountId, ['KEYWORD ', { str: tagToKeyword(target.tag) }], count, false, unread)
    })
  },

  async thread(accountId, threadId) {
    return session(accountId).run(async (ctx) => {
      const { special } = await ctx.folders()
      const out: MailMessage[] = []
      for (const s of await threadSummaries(ctx, accountId, threadId)) {
        const p = await loadParsed(ctx, accountId, s.id)
        const path = parseMessageId(s.id).path
        out.push({
          ...s,
          ...(p.pec && { from: p.from ?? s.from, to: p.to, subject: p.subject || s.subject, pec: p.pec }),
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

  async threadMembers(accountId, threadId) {
    return session(accountId).run(async (ctx) => {
      const { special } = await ctx.folders()
      return (await threadSummaries(ctx, accountId, threadId)).map((s) => ({ ...s, folderKind: kindOfPath(parseMessageId(s.id).path, special) }))
    })
  },

  setRead: (accountId, ids, read) => storeFlags(accountId, ids, read ? '+' : '-', '\\Seen'),
  setFlagged: (accountId, ids, flagged) => storeFlags(accountId, ids, flagged ? '+' : '-', '\\Flagged'),

  /** Answers the messages' new ids (a moved message gets a new UID in its new folder). */
  async move(accountId, ids, dest) {
    return session(accountId).run(async (ctx) => {
      const newIds: string[] = []
      for (const [path, group] of groupByFolder(ids)) {
        const to = await destination(ctx, dest, movedFrom.get(group[0]) ?? 'INBOX')
        newIds.push(...(await moveFrom(ctx, accountId, path, group, to)))
      }
      return newIds
    })
  },

  async deleteForever(accountId, ids) {
    await session(accountId).run(async (ctx) => {
      for (const [path, group] of groupByFolder(ids)) {
        const uids = []
        for (const id of group) uids.push((await selectFor(ctx, id)).uid)
        await expunge(ctx, uids.join(','))
        forgetDates(accountId, path, uids)
      }
    })
  },
  async snooze(accountId, ids, until) {
    await session(accountId).run(async (ctx) => {
      const to = await timedFolder(ctx, 'Snoozed', until)
      for (const [path, group] of groupByFolder(ids)) await moveFrom(ctx, accountId, path, group, to)
      await dropEmptyTimed(ctx, 'Snoozed')
    })
  },

  /** Back to the Inbox, unread. */
  async unsnooze(accountId, ids) {
    await session(accountId).run(async (ctx) => {
      const back: string[] = []
      for (const [path, group] of groupByFolder(ids)) back.push(...(await moveFrom(ctx, accountId, path, group, 'INBOX')))
      const uids = back.map(parseMessageId).filter((r) => isInbox(r.path)).map((r) => r.uid)
      if (uids.length) {
        await ctx.select('INBOX')
        await ctx.client.run([`UID STORE ${uids.join(',')} -FLAGS.SILENT (\\Seen)`])
      }
      await dropEmptyTimed(ctx, 'Snoozed')
    })
  },

  async folders(accountId) {
    return session(accountId).run(async (ctx) => {
      const { list, special } = await ctx.folders(true)
      const specialPaths = new Set(Object.values(special))
      const ns = namespaceOf(list)
      const own = list.filter((f) => !isInbox(f.path) && !specialPaths.has(f.path) && !(ns && isAppFolder(f.path, ns)))
      const out: MailFolder[] = []
      for (const f of own) {
        out.push({ id: folderId(f.path), name: f.name, depth: f.depth, unread: f.selectable ? await unseen(ctx, f) : 0 })
      }
      return out
    })
  },

  async createFolder(accountId, name, parentId) {
    return session(accountId).run(async (ctx) => {
      const { list } = await ctx.folders(true)
      const ns = namespaceOf(list)
      if (parentId && !ns) throw new Error(i18n.t('imap.noHierarchy'))
      if (ns && name.includes(ns.delimiter)) throw new Error(i18n.t('mail.newFolderBadChar', { char: ns.delimiter }))
      const path = (parentId ? folderPath(parentId) + ns!.delimiter : (ns?.prefix ?? '')) + encodeMailboxName(name)
      if (list.some((f) => f.path === path)) throw new Error(i18n.t('mail.newFolderExists'))
      await ctx.client.run(['CREATE ', { str: path }])
      await ctx.client.run(['SUBSCRIBE ', { str: path }]).catch(() => undefined)
      ctx.forgetFolders()
      return folderId(path)
    })
  },

  async tags(accountId) {
    return session(accountId).run(async (ctx) => {
      const box = await ctx.select('INBOX', true)
      const names = new Map<string, MailTag>()
      for (const k of [...box.flags, ...(seenKeywords.get(accountId) ?? [])]) {
        const name = keywordToTag(k)
        if (name) names.set(name.toLowerCase(), { name })
      }
      return [...names.values()]
    }, true)
  },

  async setTags(accountId, messages, add, remove) {
    await session(accountId).run(async (ctx) => {
      for (const [, group] of groupByFolder(messages.map((m) => m.id))) {
        const uids = []
        for (const id of group) uids.push((await selectFor(ctx, id)).uid)
        const box = await ctx.select(parseMessageId(group[0]).path)
        if (!box.keywords) throw new Error(i18n.t('imap.noTags'))
        const set = uids.join(',')
        if (add.length) await ctx.client.run([`UID STORE ${set} +FLAGS.SILENT (${add.map(tagToKeyword).join(' ')})`])
        if (remove.length) await ctx.client.run([`UID STORE ${set} -FLAGS.SILENT (${remove.map(tagToKeyword).join(' ')})`])
      }
    })
  },

  async unreadCount(accountId, folder) {
    return session(accountId).run(async (ctx) => {
      if (folder === 'inbox') return unseen(ctx, { path: 'INBOX' })
      const path = (await ctx.folders()).special[folder as SpecialFolder]
      return path ? unseen(ctx, { path }) : 0
    }, true)
  },

  async attachments(accountId, id): Promise<Attachment[]> {
    const d = drafts.get(cacheKey(accountId, id))
    if (d) return d.files.map((f) => f.meta)
    return session(accountId).run(async (ctx) => (await loadParsed(ctx, accountId, id)).attachments.map((a) => a.meta))
  },

  async downloadAttachment(accountId, id, attachmentId) {
    const file = drafts.get(cacheKey(accountId, id))?.files.find((f) => f.meta.id === attachmentId)
    if (file) return file.blob
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

  ...composeMethods,
  ...scheduleMethods,
  // IMAP servers can't send later: the app sends scheduled messages when their time comes.
  sendsScheduledItself: false,
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
