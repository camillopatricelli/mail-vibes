import { useSettings } from '../settings/store'
import type { MailProvider } from './types'
import { gmail } from './gmail'
import { imap } from './imap/provider'
import { outlook } from './outlook'

/** Returns the mail adapter for an account id (`microsoft:…`, `google:…` or `imap:…`). */
export function providerFor(accountId: string): MailProvider {
  if (accountId.startsWith('microsoft:')) return outlook
  if (accountId.startsWith('google:')) return gmail
  if (accountId.startsWith('imap:')) return imap
  throw new Error('Unknown account type')
}

export function isMailCapable(accountId: string) {
  return accountId.startsWith('microsoft:') || accountId.startsWith('google:') || accountId.startsWith('imap:')
}

export const isImap = (accountId: string) => accountId.startsWith('imap:')

/** Whether mail can be written from this account (IMAP: only with an outgoing server; PEC mailboxes are usually read-only here). */
export function canSend(accountId: string) {
  if (isImap(accountId)) return !!useSettings.getState().accounts.find((a) => a.id === accountId)?.imap?.outgoing
  return accountId.startsWith('microsoft:') || accountId.startsWith('google:')
}

/** Mail rules: Gmail filters and Outlook rules on the server; IMAP rules are run by the app (see rules.ts). */
export const hasRules = (accountId: string) => accountId.startsWith('microsoft:') || accountId.startsWith('google:') || isImap(accountId)

/** Gmail cannot delete permanently with the permissions the app requests. */
export function canDeleteForever(accountId: string) {
  return accountId.startsWith('microsoft:') || isImap(accountId)
}
