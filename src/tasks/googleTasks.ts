import { localDate, toDateKey } from '../calendar/dates'
import { google } from '../providers/google'
import { findMailUrl, mailNoteLine, parseMailUrl } from './mailLink'
import { readMeta, writeMeta } from './taskMeta'
import { COMPLETED_DAYS, type Task, type TaskDraft, type TaskList, type TaskProvider } from './types'

/** Google Tasks via the Tasks REST API. */

const API = 'https://tasks.googleapis.com/tasks/v1'

interface GTask {
  id: string
  title?: string
  notes?: string
  due?: string
  status?: string
  completed?: string
  parent?: string
  position?: string
  updated?: string
  webViewLink?: string
  deleted?: boolean
  hidden?: boolean
  /** Read-only; set for tasks created from Gmail */
  links?: { type?: string; description?: string; link?: string }[]
}

function toTask(accountId: string, listId: string, t: GTask): Task {
  const email = t.links?.find((l) => l.type === 'email' && l.link)
  const fromLink = email?.link ? parseMailUrl(email.link) : undefined
  // Google stores only the date part of "due" (as midnight UTC).
  const due = t.due ? localDate(t.due.slice(0, 10)) : undefined
  const { notes, meta } = readMeta(t.notes ?? '', due)
  return {
    accountId,
    listId,
    id: t.id,
    title: t.title ?? '',
    notes,
    due,
    start: meta.start !== undefined && meta.start !== due ? meta.start : undefined,
    reminder: meta.reminder,
    recurrence: meta.recurrence,
    completed: t.status === 'completed',
    completedAt: t.completed ? Date.parse(t.completed) : undefined,
    important: false,
    parentId: t.parent,
    position: t.position ?? '',
    updatedAt: Date.parse(t.updated ?? '') || 0,
    webLink: t.webViewLink,
    mail: email?.link ? { ...(fromLink ?? { provider: 'google', ids: [], url: email.link }), subject: email.description } : findMailUrl(notes),
  }
}

const dueValue = (due: number | null) => (due === null ? null : `${toDateKey(due)}T00:00:00.000Z`)

function body(d: Partial<TaskDraft>) {
  const out: Record<string, unknown> = {}
  if (d.title !== undefined) out.title = d.title
  if (d.notes !== undefined) out.notes = d.notes
  if (d.due !== undefined) out.due = dueValue(d.due)
  return out
}

const listUrl = (listId: string) => `${API}/lists/${encodeURIComponent(listId)}/tasks`

const hasMeta = (d: Partial<TaskDraft>) => d.start !== undefined || d.reminder !== undefined || d.recurrence !== undefined
const orUndef = <T,>(v: T | null | undefined) => v ?? undefined

export const googleTasks: TaskProvider = {
  repeatsItself: false,

  async lists(accountId) {
    const r = await google<{ items?: { id: string; title?: string }[] }>(accountId, `${API}/users/@me/lists?maxResults=100`)
    // The first list is the account's default ("My Tasks").
    return (r.items ?? []).map((l, i): TaskList => ({ accountId, id: l.id, name: l.title || 'Tasks', isDefault: i === 0 }))
  },

  async tasks(accountId, listId) {
    // Two requests: "completedMin" filters out every task without a completion date, so it
    // cannot be combined with the open tasks.
    const page = async (params: Record<string, string>) => {
      const out: Task[] = []
      let pageToken: string | undefined
      do {
        const q = new URLSearchParams({ maxResults: '100', ...params })
        if (pageToken) q.set('pageToken', pageToken)
        const r = await google<{ items?: GTask[]; nextPageToken?: string }>(accountId, `${listUrl(listId)}?${q}`)
        for (const t of r.items ?? []) if (!t.deleted && (t.title || t.notes)) out.push(toTask(accountId, listId, t))
        pageToken = r.nextPageToken
      } while (pageToken)
      return out
    }
    const [open, done] = await Promise.all([
      page({ showCompleted: 'false' }),
      page({
        showCompleted: 'true',
        showHidden: 'true',
        completedMin: new Date(Date.now() - COMPLETED_DAYS * 86_400_000).toISOString(),
      }),
    ])
    return [...open, ...done.filter((t) => t.completed)]
  },

  async create(accountId, listId, draft, mail) {
    // Links cannot be written through the API, so the email's address goes into the notes.
    const plain = mail ? [draft.notes.trim(), mailNoteLine(mail.subject, mail.url)].filter(Boolean).join('\n\n') : draft.notes
    const notes = writeMeta(plain, { start: orUndef(draft.start), reminder: orUndef(draft.reminder), recurrence: orUndef(draft.recurrence) }, orUndef(draft.due))
    const t = await google<GTask>(accountId, listUrl(listId), { method: 'POST', body: body({ title: draft.title, ...(notes && { notes }), ...(draft.due !== null && { due: draft.due }) }) })
    return toTask(accountId, listId, t)
  },

  async update(accountId, listId, taskId, draft) {
    const url = `${listUrl(listId)}/${encodeURIComponent(taskId)}`
    const out = body(draft)
    if (hasMeta(draft) || draft.notes !== undefined) {
      // The notes line holds the other fields too, so start from what the task has now.
      const cur = await google<GTask>(accountId, `${url}?fields=notes,due`)
      const curDue = cur.due ? localDate(cur.due.slice(0, 10)) : undefined
      const { notes, meta } = readMeta(cur.notes ?? '', curDue)
      const due = draft.due !== undefined ? orUndef(draft.due) : curDue
      out.notes = writeMeta(
        draft.notes ?? notes,
        {
          start: draft.start !== undefined ? orUndef(draft.start) : meta.start,
          reminder: draft.reminder !== undefined ? orUndef(draft.reminder) : meta.reminder,
          recurrence: draft.recurrence !== undefined ? orUndef(draft.recurrence) : meta.recurrence,
        },
        due,
      )
    }
    await google(accountId, url, { method: 'PATCH', body: out })
  },

  async setCompleted(accountId, listId, taskId, completed) {
    await google(accountId, `${listUrl(listId)}/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: completed ? { status: 'completed' } : { status: 'needsAction', completed: null },
    })
  },

  async remove(accountId, listId, taskId) {
    await google(accountId, `${listUrl(listId)}/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
  },
}
