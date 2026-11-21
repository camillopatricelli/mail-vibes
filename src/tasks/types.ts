/** Provider-neutral task model. Google Tasks and Microsoft To Do adapters map to these types. */

import type { Recurrence } from '../lib/recurrence'
import type { MailLink, MailSource } from './mailLink'

export interface TaskList {
  accountId: string
  id: string
  name: string
  isDefault: boolean
  /** Lists the API cannot add tasks to (To Do "Flagged email") */
  readOnly?: boolean
}

export interface Task {
  accountId: string
  listId: string
  id: string
  title: string
  notes: string
  /** Local midnight of the due date (tasks have dates, not times) */
  due?: number
  /** Local midnight of the start date, when it differs from the due date */
  start?: number
  /** When to remind (date and time) */
  reminder?: number
  /** Repeat rule, anchored at the due date */
  recurrence?: Recurrence
  completed: boolean
  completedAt?: number
  /** Microsoft To Do "important" flag */
  important: boolean
  /** Google Tasks sub-task: the parent task id */
  parentId?: string
  /** Sort key within the list (Google position, or creation time) */
  position: string
  updatedAt: number
  webLink?: string
  /** The email the task was created from */
  mail?: MailLink
}

export interface TaskDraft {
  title: string
  notes: string
  /** Local midnight; null clears the date */
  due: number | null
  /** Local midnight; null = same as the due date */
  start?: number | null
  /** null = no reminder */
  reminder?: number | null
  /** null = does not repeat */
  recurrence?: Recurrence | null
}

export interface TaskProvider {
  /** Whether ticking a repeating task makes the provider create the next one (To Do); otherwise the app does */
  readonly repeatsItself: boolean
  lists(accountId: string): Promise<TaskList[]>
  /** Open tasks plus recently completed ones */
  tasks(accountId: string, listId: string): Promise<Task[]>
  create(accountId: string, listId: string, draft: TaskDraft, mail?: MailSource): Promise<Task>
  update(accountId: string, listId: string, taskId: string, draft: Partial<TaskDraft>): Promise<void>
  setCompleted(accountId: string, listId: string, taskId: string, completed: boolean): Promise<void>
  remove(accountId: string, listId: string, taskId: string): Promise<void>
}

/** Completed tasks older than this are not loaded. */
export const COMPLETED_DAYS = 30
