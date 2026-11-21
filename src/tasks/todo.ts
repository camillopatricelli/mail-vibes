import { startOfDay, toDateKey } from '../calendar/dates'
import { ApiError, graph, type GraphPage } from '../providers/graph'
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
  status?: string
  completedDateTime?: GDateTime
  importance?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
}

const FIELDS = 'id,title,body,dueDateTime,status,completedDateTime,importance,createdDateTime,lastModifiedDateTime'

const utc = (dt: GDateTime | undefined) =>
  !dt ? undefined : Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(dt.dateTime) ? dt.dateTime : dt.dateTime + (dt.timeZone === 'UTC' ? 'Z' : ''))

function toTask(accountId: string, listId: string, t: GTask): Task {
  const due = utc(t.dueDateTime)
  const notes = t.body?.contentType === 'html' ? htmlToText(t.body.content ?? '') : (t.body?.content ?? '')
  return {
    accountId,
    listId,
    id: t.id,
    title: t.title ?? '',
    notes: notes.trim(),
    // To Do keeps a day, stored as midnight in some time zone and returned in UTC (e.g. 23:00 the
    // day before for Rome, 00:00 for UTC). Noon of that instant falls on the intended day anywhere
    // within ±11 hours of UTC.
    due: due === undefined ? undefined : startOfDay(due + 12 * 3_600_000),
    completed: t.status === 'completed',
    completedAt: utc(t.completedDateTime),
    important: t.importance === 'high',
    position: t.createdDateTime ?? '',
    updatedAt: Date.parse(t.lastModifiedDateTime ?? '') || 0,
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
  if (d.due !== undefined) out.dueDateTime = d.due === null ? null : { dateTime: `${toDateKey(d.due)}T00:00:00`, timeZone: timeZone() }
  return out
}

const tasksUrl = (listId: string) => `/me/todo/lists/${encodeURIComponent(listId)}/tasks`

async function all(accountId: string, listId: string, url: string): Promise<Task[]> {
  const out: Task[] = []
  let next: string | undefined = url
  while (next) {
    const page: GraphPage<GTask> = await graph<GraphPage<GTask>>(accountId, next)
    out.push(...page.value.map((t) => toTask(accountId, listId, t)))
    next = page['@odata.nextLink']
  }
  return out
}

export const todo: TaskProvider = {
  async lists(accountId) {
    type GList = { id: string; displayName?: string; wellknownListName?: string }
    const page = await graph<GraphPage<GList>>(accountId, '/me/todo/lists?$top=100')
    return page.value
      .filter((l) => l.wellknownListName !== 'flaggedEmails')
      .map((l): TaskList => ({ accountId, id: l.id, name: l.displayName || 'Tasks', isDefault: l.wellknownListName === 'defaultList' }))
  },

  async tasks(accountId, listId) {
    const since = new Date(Date.now() - COMPLETED_DAYS * 86_400_000).toISOString()
    const open = all(accountId, listId, `${tasksUrl(listId)}?$top=100&$select=${FIELDS}&$filter=status ne 'completed'`)
    // Recently completed tasks only (lists can hold years of completed tasks).
    const done = all(
      accountId,
      listId,
      `${tasksUrl(listId)}?$top=100&$select=${FIELDS}&$filter=status eq 'completed' and lastModifiedDateTime ge ${since}`,
    ).catch(async (e) => {
      // Some tenants reject the date filter: fall back to the most recent page.
      if (e instanceof ApiError && e.status === 400) {
        const page = await graph<GraphPage<GTask>>(accountId, `${tasksUrl(listId)}?$top=50&$select=${FIELDS}&$filter=status eq 'completed'`)
        return page.value.map((t) => toTask(accountId, listId, t))
      }
      throw e
    })
    return [...(await open), ...(await done)]
  },

  async create(accountId, listId, draft) {
    const t = await graph<GTask>(accountId, tasksUrl(listId), { method: 'POST', body: body({ title: draft.title, ...(draft.notes && { notes: draft.notes }), ...(draft.due !== null && { due: draft.due }) }) })
    return toTask(accountId, listId, t)
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
