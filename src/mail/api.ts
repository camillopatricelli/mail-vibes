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

/** Whether mail can be written from this account (IMAP sending comes in a later version). */
export function canSend(accountId: string) {
  return accountId.startsWith('microsoft:') || accountId.startsWith('google:')
}

/** Server-side mail rules (Gmail filters, Outlook rules); IMAP rules come in a later version. */
export const hasRules = (accountId: string) => accountId.startsWith('microsoft:') || accountId.startsWith('google:')

/** Gmail cannot delete permanently with the permissions the app requests. */
export function canDeleteForever(accountId: string) {
  return accountId.startsWith('microsoft:')
}
