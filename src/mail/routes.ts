import { href } from '../lib/router'
import { folderKinds, type FolderKind, type ListTarget } from './types'

/**
 * Mail routes:
 *   #/mail/<folderKind>[/t/<accountId>/<threadId>]            well-known folder, all accounts
 *   #/mail/f/<accountId>/<folderId>[/t/<accountId>/<threadId>]  one account's own folder
 *   #/mail/tag/<name>[/t/<accountId>/<threadId>]               a tag, all accounts
 *   #/mail/search/<text>[/t/<accountId>/<threadId>]            search results, all accounts
 */
export type MailView = { kind: 'well'; folder: FolderKind } | { kind: 'custom'; accountId: string; folderId: string } | { kind: 'tag'; name: string } | { kind: 'search'; q: string }
export interface ThreadRef {
  accountId: string
  threadId: string
}

export function parseMailParams(params: string[]): { view: MailView; thread?: ThreadRef } {
  let view: MailView = { kind: 'well', folder: 'inbox' }
  let rest = params
  if (params[0] === 'f' && params[1] && params[2]) {
    view = { kind: 'custom', accountId: params[1], folderId: params[2] }
    rest = params.slice(3)
  } else if (params[0] === 'search' && params[1]) {
    view = { kind: 'search', q: params[1] }
    rest = params.slice(2)
  } else if (params[0] === 'tag' && params[1]) {
    view = { kind: 'tag', name: params[1] }
    rest = params.slice(2)
  } else if ((folderKinds as string[]).includes(params[0])) {
    view = { kind: 'well', folder: params[0] as FolderKind }
    rest = params.slice(1)
  }
  const thread = rest[0] === 't' && rest[1] && rest[2] ? { accountId: rest[1], threadId: rest[2] } : undefined
  return { view, thread }
}

export function mailHref(view: MailView, thread?: ThreadRef) {
  const base = view.kind === 'well' ? [view.folder] : view.kind === 'tag' ? ['tag', view.name] : view.kind === 'search' ? ['search', view.q] : ['f', view.accountId, view.folderId]
  return href('mail', ...base, ...(thread ? ['t', thread.accountId, thread.threadId] : []))
}

export function goMail(view: MailView, thread?: ThreadRef) {
  location.hash = mailHref(view, thread)
}

export const viewTarget = (v: MailView): ListTarget => (v.kind === 'well' ? v.folder : v.kind === 'tag' ? { tag: v.name } : v.kind === 'search' ? { search: v.q } : { folderId: v.folderId })

/** The folder kind used to decide which actions to offer ('custom' for the user's own folders). */
export type UiFolder = FolderKind | 'custom' | 'tag' | 'search'
export const uiFolder = (v: MailView): UiFolder => (v.kind === 'well' ? v.folder : v.kind)

/** Views mixing messages from several folders (archiving keeps them in the list). */
export const isMixed = (f: UiFolder) => f === 'tag' || f === 'search'

export const sameView = (a: MailView, b: MailView) => mailHref(a) === mailHref(b)
