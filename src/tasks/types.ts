/** Provider-neutral task model. Google Tasks and Microsoft To Do adapters map to these types. */

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
}

export interface TaskProvider {
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
