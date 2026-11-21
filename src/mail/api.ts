import type { MailProvider } from './types'
import { gmail } from './gmail'
import { outlook } from './outlook'

/** Returns the mail adapter for an account id (`microsoft:…` or `google:…`). */
export function providerFor(accountId: string): MailProvider {
  if (accountId.startsWith('microsoft:')) return outlook
  if (accountId.startsWith('google:')) return gmail
  throw new Error('Unknown account type')
}

export function isMailCapable(accountId: string) {
  return accountId.startsWith('microsoft:') || accountId.startsWith('google:')
}

/** Gmail cannot delete permanently with the permissions the app requests. */
export function canDeleteForever(accountId: string) {
  return accountId.startsWith('microsoft:')
}
