import { google as googleConfig } from '../config'
import i18n from '../i18n'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { AuthRequiredError } from './errors'

/**
 * Google sign-in with Google Identity Services (token model). There is no backend, so there is
 * no refresh token: each access token lasts about an hour and lives only in memory. Renewing it
 * needs a click (a popup that usually closes by itself), which the "Sign in" banner provides.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/meetings.space.created',
]

/** Scopes without which mail cannot work at all. */
const REQUIRED_SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

interface TokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
  error_description?: string
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string
        scope: string
        prompt?: string
        login_hint?: string
        include_granted_scopes?: boolean
        callback: (r: TokenResponse) => void
        error_callback?: (e: { type: string; message?: string }) => void
      }): TokenClient
      revoke(token: string, done?: () => void): void
    }
  }
}
declare global {
  interface Window {
    google?: Gis
  }
}

export class UserCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled')
    this.name = 'UserCancelledError'
  }
}

let gisPromise: Promise<Gis> | undefined
function loadGis(): Promise<Gis> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google)
  gisPromise ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => (window.google ? resolve(window.google) : reject(new Error('Google sign-in failed to load')))
    s.onerror = () => {
      gisPromise = undefined
      reject(new Error('Google sign-in could not be loaded: check your connection'))
    }
    document.head.appendChild(s)
  })
  return gisPromise
}

/** Preloads the library so the popup can open synchronously-ish within the user's click. */
export function preloadGoogle(always = false) {
  if (!googleConfig.clientId) return
  if (always || useSettings.getState().accounts.some((a) => a.provider === 'google')) void loadGis().catch(() => undefined)
}

export const googleConfigured = () => !!googleConfig.clientId

interface Token {
  value: string
  expiresAt: number
}
const tokens = new Map<string, Token>()

async function requestToken(opts: { prompt: string; loginHint?: string }): Promise<TokenResponse> {
  if (!googleConfig.clientId) throw new Error(i18n.t('accounts.googleNotConfigured'))
  const gis = await loadGis()
  return new Promise<TokenResponse>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: googleConfig.clientId,
      scope: GOOGLE_SCOPES.join(' '),
      prompt: opts.prompt,
      login_hint: opts.loginHint,
      include_granted_scopes: true,
      callback: (r) => {
        if (r.error || !r.access_token) reject(new Error(r.error_description || r.error || 'Google sign-in failed'))
        else resolve(r)
      },
      error_callback: (e) => {
        if (e.type === 'popup_closed') reject(new UserCancelledError())
        else if (e.type === 'popup_failed_to_open') reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'))
        else reject(new Error(e.message || e.type))
      },
    })
    client.requestAccessToken()
  })
}

interface UserInfo {
  sub: string
  email: string
  name?: string
}

async function userInfo(accessToken: string): Promise<UserInfo> {
  let res: Response
  try {
    res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch {
    throw new Error('Network error: check your connection')
  }
  if (!res.ok) throw new Error(`Could not read the Google profile (${res.status})`)
  return (await res.json()) as UserInfo
}

function missingScopes(r: TokenResponse) {
  const granted = new Set((r.scope ?? '').split(/\s+/))
  return REQUIRED_SCOPES.filter((s) => !granted.has(s))
}

function store(accountId: string, r: TokenResponse) {
  const seconds = Number(r.expires_in) || 3600
  tokens.set(accountId, { value: r.access_token!, expiresAt: Date.now() + seconds * 1000 })
}

/** Adds a Google account (account chooser + consent). Returns false if the user cancelled. */
export async function addGoogleAccount(): Promise<boolean> {
  let r: TokenResponse
  try {
    r = await requestToken({ prompt: 'select_account consent' })
  } catch (e) {
    if (e instanceof UserCancelledError) return false
    throw e
  }
  const missing = missingScopes(r)
  if (missing.length) throw new Error('Access to Gmail was not granted. Add the account again and tick every permission.')
  const info = await userInfo(r.access_token!)
  const id = `google:${info.sub}`
  store(id, r)
  const s = useSettings.getState()
  s.upsertAccount({
    id,
    provider: 'google',
    email: info.email,
    displayName: s.accounts.find((a) => a.id === id)?.displayName || info.name || info.email,
  })
  const after = useSettings.getState()
  if (!after.defaults.sendAccountId) after.setDefaults({ sendAccountId: id })
  if (!after.defaults.notesAccountId) after.setDefaults({ notesAccountId: id })
  useStatus.getState().clearError(id)
  return true
}

/** Renews the token of one account (from the "Sign in" banner). Must run inside a click. */
export async function reauthGoogle(accountId: string): Promise<boolean> {
  const account = useSettings.getState().accounts.find((a) => a.id === accountId)
  if (!account) throw new Error('Unknown account')
  let r: TokenResponse
  try {
    // An empty prompt lets Google skip the chooser and consent when nothing changed.
    r = await requestToken({ prompt: '', loginHint: account.email })
  } catch (e) {
    if (e instanceof UserCancelledError) return false
    throw e
  }
  const info = await userInfo(r.access_token!)
  if (`google:${info.sub}` !== accountId) throw new Error(`You signed in as ${info.email}, not ${account.email}.`)
  if (missingScopes(r).length) throw new Error('Access to Gmail was not granted.')
  store(accountId, r)
  useStatus.getState().clearError(accountId)
  return true
}

/** The current access token, or AuthRequiredError if there is none or it is about to expire. */
export function getGoogleToken(accountId: string): string {
  const t = tokens.get(accountId)
  if (!t || t.expiresAt - 60_000 < Date.now()) {
    tokens.delete(accountId)
    throw new AuthRequiredError(i18n.t('accounts.googleSignIn'))
  }
  return t.value
}

export function hasGoogleToken(accountId: string) {
  const t = tokens.get(accountId)
  return !!t && t.expiresAt - 60_000 > Date.now()
}

export function markGoogleTokenInvalid(accountId: string) {
  tokens.delete(accountId)
}

/** Forgets the token and revokes the app's access for this account. */
export async function forgetGoogleAccount(accountId: string) {
  const t = tokens.get(accountId)
  tokens.delete(accountId)
  if (t && window.google) window.google.accounts.oauth2.revoke(t.value)
}
