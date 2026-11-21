import {
  BrowserAuthError,
  createStandardPublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
  type IPublicClientApplication,
} from '@azure/msal-browser'
import { selectTenants, useSettings, type Tenant } from '../settings/store'
import { useStatus } from '../status/store'
import { isIos, isStandalone } from '../shell/reminders'

/**
 * Microsoft sign-in. One MSAL client per organisation (each is a separate Entra app registration).
 * Tokens are cached by MSAL in localStorage (the only non-settings data the app persists).
 */

/** All delegated permissions, requested once at sign-in so later features don't need new consent. */
export const GRAPH_SCOPES = [
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Contacts.ReadWrite',
]

export class AuthRequiredError extends Error {
  constructor(message = 'Sign-in required') {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

/** The registered redirect URI: the app's root (no trailing slash at the domain root). */
export function redirectUri() {
  const base = import.meta.env.BASE_URL
  return base === '/' ? location.origin : location.origin + base
}

const clients = new Map<string, Promise<IPublicClientApplication>>()

function clientKey(t: Tenant) {
  return `${t.clientId}|${t.tenantId}`
}

function getClient(t: Tenant): Promise<IPublicClientApplication> {
  const key = clientKey(t)
  let p = clients.get(key)
  if (!p) {
    p = (async () => {
      const pca = await createStandardPublicClientApplication({
        auth: {
          clientId: t.clientId,
          authority: `https://login.microsoftonline.com/${t.tenantId}`,
          redirectUri: redirectUri(),
          postLogoutRedirectUri: redirectUri(),
        },
        cache: { cacheLocation: 'localStorage' },
      })
      return pca
    })()
    clients.set(key, p)
    p.catch(() => clients.delete(key))
  }
  return p
}

function tenantFor(key: string | undefined): Tenant | undefined {
  return selectTenants(useSettings.getState()).find((t) => t.key === key)
}

/** Popups are unreliable in installed iOS apps; use full-page redirects there. */
const preferRedirect = () => isIos() && isStandalone()

function accountIdFor(a: AccountInfo) {
  return `microsoft:${a.homeAccountId}`
}

function saveAccount(t: Tenant, a: AccountInfo) {
  useSettings.getState().upsertAccount({
    id: accountIdFor(a),
    provider: 'microsoft',
    email: a.username,
    displayName: useSettings.getState().accounts.find((x) => x.id === accountIdFor(a))?.displayName || a.name || a.username,
    tenantKey: t.key,
  })
  const s = useSettings.getState()
  if (!s.defaults.sendAccountId) s.setDefaults({ sendAccountId: accountIdFor(a) })
  useStatus.getState().clearError(accountIdFor(a))
}

/** Processes a completed redirect sign-in (iOS installed app) for every organisation. */
export async function handleRedirects() {
  for (const t of selectTenants(useSettings.getState())) {
    try {
      const pca = await getClient(t)
      const result = await pca.handleRedirectPromise()
      if (result?.account) saveAccount(t, result.account)
    } catch (e) {
      useStatus.getState().toast({ tone: 'error', message: `${t.name}: ${(e as Error).message}` })
    }
  }
}

function isPopupProblem(e: unknown) {
  return (
    e instanceof BrowserAuthError &&
    ['popup_window_error', 'empty_window_error', 'block_iframe_reload', 'monitor_window_timeout'].includes(e.errorCode)
  )
}

function isUserCancel(e: unknown) {
  return e instanceof BrowserAuthError && e.errorCode === 'user_cancelled'
}

/** Adds a Microsoft 365 account from the given organisation. Returns false if the user cancelled. */
export async function addMicrosoftAccount(tenantKey: string): Promise<boolean> {
  const t = tenantFor(tenantKey)
  if (!t) throw new Error('Unknown organisation')
  const pca = await getClient(t)
  const request = { scopes: GRAPH_SCOPES, prompt: 'select_account' as const }
  if (preferRedirect()) {
    await pca.loginRedirect(request)
    return true
  }
  try {
    const result = await pca.loginPopup(request)
    saveAccount(t, result.account)
    return true
  } catch (e) {
    if (isUserCancel(e)) return false
    if (isPopupProblem(e)) {
      await pca.loginRedirect(request)
      return true
    }
    throw e
  }
}

async function findMsalAccount(accountId: string): Promise<{ pca: IPublicClientApplication; account: AccountInfo; tenant: Tenant }> {
  const settings = useSettings.getState().accounts.find((a) => a.id === accountId)
  if (!settings) throw new Error('Unknown account')
  const tenant = tenantFor(settings.tenantKey)
  if (!tenant) throw new AuthRequiredError('The organisation for this account was removed')
  const pca = await getClient(tenant)
  const homeAccountId = accountId.replace(/^microsoft:/, '')
  const account = pca.getAccount({ homeAccountId })
  if (!account) throw new AuthRequiredError()
  return { pca, account, tenant }
}

/**
 * Returns an access token for Microsoft Graph. Never prompts: if interaction is needed it throws
 * AuthRequiredError, which the caller reports so the UI shows a "Sign in" banner for the account.
 */
export async function getGraphToken(accountId: string, forceRefresh = false): Promise<string> {
  const { pca, account } = await findMsalAccount(accountId)
  try {
    const r = await pca.acquireTokenSilent({ account, scopes: GRAPH_SCOPES, forceRefresh })
    return r.accessToken
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) throw new AuthRequiredError()
    if (e instanceof BrowserAuthError && /timed_out|monitor_window_timeout|no_token_request_cache_error/.test(e.errorCode))
      throw new AuthRequiredError()
    throw e
  }
}

/** Interactive re-authentication for one account (from the "Sign in" banner). */
export async function reauthMicrosoft(accountId: string) {
  const settings = useSettings.getState().accounts.find((a) => a.id === accountId)
  const tenant = tenantFor(settings?.tenantKey)
  if (!settings || !tenant) throw new Error('Unknown account or organisation')
  const pca = await getClient(tenant)
  // No forced prompt: if the Microsoft session is still alive the popup closes by itself.
  const request = { scopes: GRAPH_SCOPES, loginHint: settings.email }
  if (preferRedirect()) return pca.acquireTokenRedirect(request)
  try {
    const r = await pca.acquireTokenPopup(request)
    saveAccount(tenant, r.account)
  } catch (e) {
    if (isUserCancel(e)) return
    if (isPopupProblem(e)) return pca.acquireTokenRedirect(request)
    throw e
  }
}

/** Removes the account from this device (clears its cached tokens). Does not sign out of Microsoft. */
export async function forgetMicrosoftAccount(accountId: string) {
  try {
    const { pca, account } = await findMsalAccount(accountId)
    await pca.clearCache({ account })
  } catch {
    // Already gone from the cache; nothing to clear.
  }
}
