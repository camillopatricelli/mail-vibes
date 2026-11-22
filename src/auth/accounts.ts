import i18n from '../i18n'
import { queryClient } from '../lib/queryClient'
import { useSettings, type Settings } from '../settings/store'
import { reauthHandlers } from '../shell/Banners'
import { useStatus } from '../status/store'
import { addGoogleAccount, forgetGoogleAccount, reauthGoogle } from './google'
import { addMicrosoftAccount, forgetMicrosoftAccount, reauthMicrosoft } from './msal'
import { forgetPassword, smtpKey } from '../mail/imap/passwords'
import { closeSession } from '../mail/imap/session'

/** Account lifecycle used by the UI (add / re-authenticate / remove), across providers. */

reauthHandlers.microsoft = (accountId) => {
  reauthMicrosoft(accountId)
    .then(() => {
      useStatus.getState().clearError(accountId)
      void queryClient.invalidateQueries()
    })
    .catch((e) =>
      useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) }),
    )
}

reauthHandlers.google = (accountId) => {
  reauthGoogle(accountId)
    .then((ok) => {
      if (ok) void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(accountId) })
    })
    .catch((e) =>
      useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) }),
    )
}

export async function addGoogle() {
  try {
    const ok = await addGoogleAccount()
    if (ok) void queryClient.invalidateQueries()
  } catch (e) {
    useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) })
  }
}

export async function addMicrosoft(tenantKey: string) {
  try {
    const ok = await addMicrosoftAccount(tenantKey)
    if (ok) void queryClient.invalidateQueries()
  } catch (e) {
    useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) })
  }
}

/**
 * Replaces the whole setup (an imported file, or a copy from another device). Accounts that are
 * not in the new setup are removed as if by hand: their sign-ins and saved passwords go too.
 */
export async function replaceSetup(settings: Settings) {
  const keep = new Set(settings.accounts.map((a) => a.id))
  for (const a of useSettings.getState().accounts) if (!keep.has(a.id)) await removeAccount(a.id)
  useSettings.getState().replaceAll(settings)
}

export async function removeAccount(accountId: string) {
  if (accountId.startsWith('microsoft:')) await forgetMicrosoftAccount(accountId)
  if (accountId.startsWith('google:')) await forgetGoogleAccount(accountId)
  if (accountId.startsWith('imap:')) {
    closeSession(accountId)
    await forgetPassword(accountId)
    await forgetPassword(smtpKey(accountId))
  }
  useSettings.getState().removeAccount(accountId)
  useStatus.getState().clearError(accountId)
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(accountId) })
}
