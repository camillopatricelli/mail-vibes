import type { MailProvider } from './types'
import { outlook } from './outlook'

/** Returns the mail adapter for an account id (`microsoft:…` or `google:…`). */
export function providerFor(accountId: string): MailProvider {
  if (accountId.startsWith('microsoft:')) return outlook
  throw new Error('Mail for this account type is not available yet')
}

export function isMailCapable(accountId: string) {
  return accountId.startsWith('microsoft:')
}
