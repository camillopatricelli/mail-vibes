import { startOfDay, toDateKey, toTimeKey } from '../calendar/dates'
import { fromGraph, toGraph, type GraphRecurrence } from '../lib/recurrence'
import { ApiError, graph, type GraphPage } from '../providers/graph'
import { findMailUrl, linkOf, mailNoteLine, parseMailUrl, type MailLink } from './mailLink'
import { COMPLETED_DAYS, type Task, type TaskDraft, type TaskList, type TaskProvider } from './types'

/** Microsoft To Do via Microsoft Graph. */

interface GDateTime {
  dateTime: string
  timeZone: string
}
interface GTask {
  id: string
  title?: string
  body?: { content?: string; contentType?: string }
  dueDateTime?: GDateTime
  startDateTime?: GDateTime
  reminderDateTime?: GDateTime
  isReminderOn?: boolean
  recurrence?: GraphRecurrence | null
  status?: string
  completedDateTime?: GDateTime
  importance?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  linkedResources?: { webUrl?: string; applicationName?: string; displayName?: string; externalId?: string }[]
}

const utc = (dt: GDateTime | undefined) =>
  !dt ? undefined : Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(dt.dateTime) ? dt.dateTime : dt.dateTime + (dt.timeZone === 'UTC' ? 'Z' : ''))

/** The email behind a flagged-email task or a task linked to a message. */
function mailOf(t: GTask, notes: string): MailLink | undefined {
  for (const r of t.linkedResources ?? []) {
    const parsed = r.webUrl ? parseMailUrl(r.webUrl) : undefined
    if (!parsed && !/outlook|mail/i.test(r.applicationName ?? '')) continue
    const provider = parsed?.provider ?? 'microsoft'
    const ids = [...new Set([...(provider === 'microsoft' && r.externalId ? [r.externalId] : []), ...(parsed?.ids ?? [])])]
    return { provider, ids, url: r.webUrl, subject: r.displayName, email: parsed?.email }
  }
  return findMailUrl(notes)
}

/** To Do keeps a day, stored as midnight in some time zone and returned in UTC (e.g. 23:00 the
 * day before for Rome, 00:00 for UTC). Noon of that instant falls on the intended day anywhere
 * within ±11 hours of UTC. */
const dayOf = (dt: GDateTime | undefined) => {
  const t = utc(dt)
  return t === undefined ? undefined : startOfDay(t + 12 * 3_600_000)
}

function toTask(accountId: string, listId: string, t: GTask): Task {
  const due = dayOf(t.dueDateTime)
  const start = dayOf(t.startDateTime)
  const notes = t.body?.contentType === 'html' ? htmlToText(t.body.content ?? '') : (t.body?.content ?? '')
  return {
    accountId,
    listId,
    id: t.id,
    title: t.title ?? '',
    notes: notes.trim(),
    due,
    start: start !== undefined && start !== due ? start : undefined,
    reminder: t.isReminderOn ? utc(t.reminderDateTime) : undefined,
    recurrence: fromGraph(t.recurrence, due ?? Date.now()).rule ?? undefined,
    completed: t.status === 'completed',
    completedAt: utc(t.completedDateTime),
    important: t.importance === 'high',
    position: t.createdDateTime ?? '',
    updatedAt: Date.parse(t.lastModifiedDateTime ?? '') || 0,
    mail: mailOf(t, notes),
  }
}

function htmlToText(html: string) {
  return new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html').body.textContent ?? ''
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function body(d: Partial<TaskDraft>) {
  const out: Record<string, unknown> = {}
  if (d.title !== undefined) out.title = d.title
  if (d.notes !== undefined) out.body = { content: d.notes, contentType: 'text' }
  const day = (v: number) => ({ dateTime: `${toDateKey(v)}T00:00:00`, timeZone: timeZone() })
  if (d.due !== undefined) out.dueDateTime = d.due === null ? null : day(d.due)
  if (d.start !== undefined) out.startDateTime = d.start === null ? null : day(d.start)
  if (d.reminder !== undefined) {
    out.isReminderOn = d.reminder !== null
    if (d.reminder !== null) out.reminderDateTime = { dateTime: `${toDateKey(d.reminder)}T${toTimeKey(d.reminder)}:00`, timeZone: timeZone() }
  }
  if (d.recurrence !== undefined) {
    const anchor = d.due ?? d.start ?? startOfDay(Date.now())
    out.recurrence = d.recurrence === null ? null : toGraph(d.recurrence, anchor, 1)
  }
  return out
}

const tasksUrl = (listId: string) => `/me/todo/lists/${encodeURIComponent(listId)}/tasks`

async function all(accountId: string, listId: string, url: string, maxPages = 50): Promise<Task[]> {
  const out: Task[] = []
  let next: string | undefined = url
  for (let i = 0; next && i < maxPages; i++) {
    const page: GraphPage<GTask> = await graph<GraphPage<GTask>>(accountId, next)
    out.push(...page.value.map((t) => toTask(accountId, listId, t)))
    next = page['@odata.nextLink']
  }
  return out
}

/**
 * Tries each request in turn, moving on when Graph rejects the query options (400). Support for
 * $expand and $filter on To Do varies between tenants, so the last option is always a
 * plain request, filtered here instead.
 */
const accepted = new Map<string, number>()
async function firstAccepted<T>(key: string, attempts: (() => Promise<T>)[]): Promise<T> {
  let first: unknown
  // Start from the option that worked last time, so rejected ones are not retried on every refresh.
  for (let i = accepted.get(key) ?? 0; i < attempts.length; i++) {
    try {
      const r = await attempts[i]()
      accepted.set(key, i)
      return r
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 400)) throw e
      first ??= e
    }
  }
  throw first
}

export const todo: TaskProvider = {
  repeatsItself: true,

  async lists(accountId) {
    type GList = { id: string; displayName?: string; wellknownListName?: string }
    const lists: GList[] = []
    let next: string | undefined = '/me/todo/lists'
    while (next) {
      const page: GraphPage<GList> = await graph<GraphPage<GList>>(accountId, next)
      lists.push(...page.value)
      next = page['@odata.nextLink']
    }
    return lists.map(
      (l): TaskList => ({
        accountId,
        id: l.id,
        name: l.displayName || 'Tasks',
        isDefault: l.wellknownListName === 'defaultList',
        // Filled by Outlook when an email is flagged; tasks cannot be added there.
        readOnly: l.wellknownListName === 'flaggedEmails',
      }),
    )
  },

  async tasks(accountId, listId) {
    const base = tasksUrl(listId)
    const since = Date.now() - COMPLETED_DAYS * 86_400_000
    const recent = (t: Task) => !t.completed || (t.completedAt ?? t.updatedAt) >= since
    const x = '$expand=linkedResources'
    const open = firstAccepted(`${accountId}|open`, [
      () => all(accountId, listId, `${base}?$filter=status ne 'completed'&${x}`),
      () => all(accountId, listId, `${base}?$filter=status ne 'completed'`),
      () => all(accountId, listId, `${base}?${x}`).then((ts) => ts.filter((t) => !t.completed)),
      () => all(accountId, listId, base).then((ts) => ts.filter((t) => !t.completed)),
    ])
    // Recently completed tasks only (lists can hold years of completed tasks).
    const done = firstAccepted(`${accountId}|done`, [
      () => all(accountId, listId, `${base}?$filter=status eq 'completed'&${x}`, 5),
      () => all(accountId, listId, `${base}?$filter=status eq 'completed'`, 5),
      () => all(accountId, listId, `${base}?${x}`, 20).then((ts) => ts.filter((t) => t.completed)),
      () => all(accountId, listId, base, 20).then((ts) => ts.filter((t) => t.completed)),
    ]).then((ts) => ts.filter(recent))
    return [...(await open), ...(await done)]
  },

  async create(accountId, listId, draft, mail) {
    const make = (notes: string, extra: Record<string, unknown> = {}) =>
      graph<GTask>(accountId, tasksUrl(listId), {
        method: 'POST',
        body: { ...body({ ...draft, notes, due: draft.due ?? undefined, start: draft.start ?? undefined, reminder: draft.reminder ?? undefined, recurrence: draft.recurrence ?? undefined }), ...extra },
      })
    if (!mail) return toTask(accountId, listId, await make(draft.notes))
    let t: GTask
    try {
      t = await make(draft.notes, {
        linkedResources: [{ webUrl: mail.url, applicationName: 'Mail Vibes', displayName: mail.subject || mail.url, externalId: mail.id }],
      })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 400)) throw e
      // Linked resources refused: keep the link in the notes instead.
      t = await make([draft.notes.trim(), mailNoteLine(mail.subject, mail.url)].filter(Boolean).join('\n\n'))
    }
    const task = toTask(accountId, listId, t)
    return { ...task, mail: task.mail ?? linkOf(mail) }
  },

  async update(accountId, listId, taskId, draft) {
    await graph(accountId, `${tasksUrl(listId)}/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: body(draft) })
  },

  async setCompleted(accountId, listId, taskId, completed) {
    await graph(accountId, `${tasksUrl(listId)}/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: { status: completed ? 'completed' : 'notStarted' },
    })
  },

  async remove(accountId, listId, taskId) {
    await graph(accountId, `${tasksUrl(listId)}/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
  },
}
