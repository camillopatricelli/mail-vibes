import i18n from '../i18n'
import { queryClient } from '../lib/queryClient'
import { useSettings } from '../settings/store'
import { reauthHandlers } from '../shell/Banners'
import { useStatus } from '../status/store'
import { addMicrosoftAccount, forgetMicrosoftAccount, reauthMicrosoft } from './msal'

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

export async function addMicrosoft(tenantKey: string) {
  try {
    const ok = await addMicrosoftAccount(tenantKey)
    if (ok) void queryClient.invalidateQueries()
  } catch (e) {
    useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) })
  }
}

export async function removeAccount(accountId: string) {
  if (accountId.startsWith('microsoft:')) await forgetMicrosoftAccount(accountId)
  useSettings.getState().removeAccount(accountId)
  useStatus.getState().clearError(accountId)
  queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(accountId) })
}
