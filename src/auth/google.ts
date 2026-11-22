import { google as googleConfig } from '../config'
import i18n from '../i18n'
import { queryClient } from '../lib/queryClient'
import { bridgeBase, bridgeFeatures } from '../mail/imap/bridge'
import { forgetPassword, getPassword, googleKey, isRemembered, setPassword } from '../mail/imap/passwords'
import { NetworkError } from '../providers/graph'
import { useSettings } from '../settings/store'
import { isIos, isStandalone } from '../shell/reminders'
import { useStatus } from '../status/store'
import { AuthRequiredError } from './errors'

/**
 * Google sign-in. Access tokens last about an hour and live only in memory. Two ways to get them:
 *
 * - Without a server (default): Google Identity Services, token model. There is no refresh token,
 *   so renewing needs a click (a popup that usually closes by itself), from the "Sign in" banner.
 * - Through the user's bridge, when it holds the OAuth client's secret (GOOGLE_CLIENT_SECRET, see
 *   bridge/worker.js): an authorization-code sign-in (with PKCE) whose code the bridge exchanges
 *   for a refresh token. The refresh token is kept on this device, encrypted like remembered IMAP
 *   passwords, and the app renews access tokens through the bridge by itself, without clicks,
 *   until the user revokes access or changes the password. The bridge stores nothing.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  // Gmail filters (mail rules). Not required: without it only the rules page asks for it.
  'https://www.googleapis.com/auth/gmail.settings.basic',
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
  refresh_token?: string
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
    s.onload = () => (window.google ? resolve(window.google) : reject(new Error(i18n.t('errors.googleLoad'))))
    s.onerror = () => {
      gisPromise = undefined
      reject(new Error(i18n.t('errors.googleLoad')))
    }
    document.head.appendChild(s)
  })
  return gisPromise
}

/**
 * Preloads the library (so the popup can open within the user's click) and checks whether the
 * bridge can make sign-ins last (this too must be known before the click).
 */
export function preloadGoogle(always = false) {
  if (!googleConfig.clientId) return
  if (always || useSettings.getState().accounts.some((a) => a.provider === 'google')) {
    void loadGis().catch(() => undefined)
    void checkLongSignIns()
  }
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
        if (r.error || !r.access_token) reject(new Error(r.error_description || r.error || i18n.t('errors.googleSignIn')))
        else resolve(r)
      },
      error_callback: (e) => {
        if (e.type === 'popup_closed') reject(new UserCancelledError())
        else if (e.type === 'popup_failed_to_open') reject(new Error(i18n.t('errors.popupBlocked')))
        else reject(new Error(e.message || e.type))
      },
    })
    client.requestAccessToken()
  })
}

// ---------- Long-lasting sign-ins through the bridge ----------

/** The bridge can exchange codes (checked by preloadGoogle; must be known before a click) */
let bridgeCanSignIn = false
/** Accounts with a long-lasting sign-in on this device */
const longLived = new Set<string>()

const CALLBACK = 'google-signin.html'
/** Written by this page before leaving for Google: what to do with the answer */
const PENDING = 'mail-vibes.google-signin.pending'
/** Written by google-signin.html (public/google-signin.js) with Google's answer */
const RESULT = 'mail-vibes.google-signin.result'

const callbackUrl = () => location.origin + import.meta.env.BASE_URL + CALLBACK

interface Pending {
  state: string
  verifier: string
  intent: 'add' | 'reauth'
  accountId?: string
  hash: string
  at: number
}
interface CodeResult {
  state: string
  code?: string
  error?: string
}

function b64url(bytes: Uint8Array) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const randomText = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

const usesBridge = () => bridgeCanSignIn && !!useSettings.getState().bridge

/** Checks whether the bridge can make sign-ins last, and which accounts already have one here. */
async function checkLongSignIns() {
  const b = useSettings.getState().bridge
  try {
    bridgeCanSignIn = !!b && (await bridgeFeatures(b)).google
  } catch {
    bridgeCanSignIn = false
  }
  for (const a of useSettings.getState().accounts)
    if (a.provider === 'google' && (await isRemembered(googleKey(a.id)))) longLived.add(a.id)
}

/** Asks Google for tokens through the bridge, which adds the client secret. */
async function bridgeToken(body: Record<string, string>): Promise<TokenResponse> {
  const b = useSettings.getState().bridge
  const base = b && bridgeBase(b)
  if (!b || !base) throw new AuthRequiredError(i18n.t('accounts.googleSignIn'))
  let res: Response
  try {
    res = await fetch(`${base}/google/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: googleConfig.clientId, ...body }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new NetworkError()
  }
  let j: TokenResponse = {}
  try {
    j = (await res.json()) as TokenResponse
  } catch {
    /* not JSON: the bridge's own error text */
  }
  // invalid_grant: access was revoked, the password changed, or the sign-in expired (Testing mode).
  if (j.error === 'invalid_grant') throw new AuthRequiredError(i18n.t('accounts.googleSignInEnded'))
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || i18n.t('errors.googleSignIn'))
  return j
}

/**
 * Google's sign-in for a long-lasting sign-in. Must start inside a click: the popup is opened
 * before anything is awaited. In installed iOS apps (and when popups are blocked) the whole page
 * goes to Google instead, and finishGoogleRedirect completes the sign-in on return.
 */
function codeSignIn(intent: 'add' | 'reauth', loginHint?: string, accountId?: string): Promise<TokenResponse | undefined> {
  const popup = isIos() && isStandalone() ? null : window.open('', 'mail-vibes-google', 'popup,width=500,height=650')
  const state = `${popup ? 'p' : 'r'}.${randomText(16)}`
  const verifier = randomText(48)
  return (async () => {
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const q = new URLSearchParams({
      client_id: googleConfig.clientId,
      redirect_uri: callbackUrl(),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      // Google hands out a refresh token only when the consent screen is shown.
      prompt: intent === 'add' ? 'select_account consent' : 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    if (loginHint) q.set('login_hint', loginHint)
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${q}`
    localStorage.removeItem(RESULT)
    localStorage.setItem(PENDING, JSON.stringify({ state, verifier, intent, accountId, hash: location.hash, at: Date.now() } satisfies Pending))
    if (!popup) {
      location.assign(url)
      return new Promise<never>(() => undefined) // the page leaves
    }
    popup.location.href = url
    const result = await waitForResult(state)
    localStorage.removeItem(PENDING)
    if (!result) return undefined
    if (!result.code) {
      if (result.error === 'access_denied') return undefined
      throw new Error(result.error || i18n.t('errors.googleSignIn'))
    }
    return bridgeToken({ code: result.code, code_verifier: verifier, redirect_uri: callbackUrl() })
  })()
}

/**
 * Waits for google-signin.html to leave Google's answer. Whether the popup was closed can't be
 * trusted (Google's pages cut the link to the window that opened them), so this simply gives up
 * after a few minutes.
 */
function waitForResult(state: string): Promise<CodeResult | undefined> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const r = readResult(state)
      if (r || Date.now() - started > 5 * 60_000) {
        clearInterval(timer)
        resolve(r)
      }
    }, 400)
  })
}

function readResult(state: string): CodeResult | undefined {
  try {
    const r = JSON.parse(localStorage.getItem(RESULT) ?? 'null') as CodeResult | null
    if (r?.state !== state) return undefined
    localStorage.removeItem(RESULT)
    return r
  } catch {
    return undefined
  }
}

/** Completes a sign-in that went to Google as a full page (installed iOS apps). Call at start-up. */
export async function finishGoogleRedirect() {
  let pending: Pending | null
  try {
    pending = JSON.parse(localStorage.getItem(PENDING) ?? 'null') as Pending | null
  } catch {
    pending = null
  }
  if (!pending?.state?.startsWith('r.')) return
  const result = readResult(pending.state)
  localStorage.removeItem(PENDING)
  if (!result?.code || Date.now() - pending.at > 15 * 60_000) return
  if (pending.hash && !location.hash) location.hash = pending.hash
  try {
    const r = await bridgeToken({ code: result.code, code_verifier: pending.verifier, redirect_uri: callbackUrl() })
    if (pending.intent === 'add') await finishAdd(r)
    else if (pending.accountId) await finishReauth(pending.accountId, r)
    void queryClient.invalidateQueries()
  } catch (e) {
    useStatus.getState().toast({ tone: 'error', message: i18n.t('accounts.signInFailed', { reason: (e as Error).message }) })
  }
}

/** Keeps the long-lasting sign-in, if Google gave one. */
async function keepRefreshToken(accountId: string, r: TokenResponse) {
  if (!r.refresh_token) return
  await setPassword(googleKey(accountId), r.refresh_token, true)
  longLived.add(accountId)
}

const renewing = new Map<string, Promise<string>>()

/** A new access token from the long-lasting sign-in (no click needed). */
function renew(accountId: string, refreshToken: string): Promise<string> {
  let p = renewing.get(accountId)
  if (!p) {
    p = (async () => {
      try {
        const r = await bridgeToken({ refresh_token: refreshToken })
        store(accountId, r)
        return r.access_token!
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          longLived.delete(accountId)
          await forgetPassword(googleKey(accountId))
        }
        throw e
      }
    })().finally(() => renewing.delete(accountId))
    renewing.set(accountId, p)
  }
  return p
}

// ---------- Accounts ----------

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
    throw new Error(i18n.t('errors.network'))
  }
  if (!res.ok) throw new Error(i18n.t('errors.googleProfile', { status: res.status }))
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
  let r: TokenResponse | undefined
  try {
    r = usesBridge() ? await codeSignIn('add') : await requestToken({ prompt: 'select_account consent' })
  } catch (e) {
    if (e instanceof UserCancelledError) return false
    throw e
  }
  if (!r) return false
  await finishAdd(r)
  return true
}

async function finishAdd(r: TokenResponse) {
  if (missingScopes(r).length) throw new Error(i18n.t('errors.gmailNotGranted'))
  const info = await userInfo(r.access_token!)
  const id = `google:${info.sub}`
  store(id, r)
  await keepRefreshToken(id, r)
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
}

/** Renews the sign-in of one account (from the "Sign in" banner). Must run inside a click. */
export async function reauthGoogle(accountId: string): Promise<boolean> {
  const account = useSettings.getState().accounts.find((a) => a.id === accountId)
  if (!account) throw new Error('Unknown account')
  let r: TokenResponse | undefined
  try {
    // Token model: an empty prompt lets Google skip the chooser and consent when nothing changed.
    r = usesBridge() ? await codeSignIn('reauth', account.email, accountId) : await requestToken({ prompt: '', loginHint: account.email })
  } catch (e) {
    if (e instanceof UserCancelledError) return false
    throw e
  }
  if (!r) return false
  await finishReauth(accountId, r)
  return true
}

async function finishReauth(accountId: string, r: TokenResponse) {
  const account = useSettings.getState().accounts.find((a) => a.id === accountId)
  const info = await userInfo(r.access_token!)
  if (`google:${info.sub}` !== accountId)
    throw new Error(i18n.t('errors.wrongAccount', { email: info.email, expected: account?.email ?? accountId }))
  if (missingScopes(r).length) throw new Error(i18n.t('errors.gmailNotGranted'))
  store(accountId, r)
  await keepRefreshToken(accountId, r)
  useStatus.getState().clearError(accountId)
}

// ---------- Tokens ----------

/**
 * The current access token. When it has expired, a long-lasting sign-in renews it (through the
 * bridge, no click); otherwise AuthRequiredError, which shows the "Sign in" banner.
 */
export async function getGoogleToken(accountId: string): Promise<string> {
  const t = tokens.get(accountId)
  if (t && t.expiresAt - 60_000 > Date.now()) return t.value
  tokens.delete(accountId)
  const refreshToken = await getPassword(googleKey(accountId))
  if (refreshToken) {
    longLived.add(accountId)
    return renew(accountId, refreshToken)
  }
  throw new AuthRequiredError(i18n.t('accounts.googleSignIn'))
}

/** Whether calls can be made without asking the user to sign in. */
export function hasGoogleToken(accountId: string) {
  const t = tokens.get(accountId)
  return (!!t && t.expiresAt - 60_000 > Date.now()) || longLived.has(accountId)
}

/** Whether this device keeps a long-lasting sign-in for the account. */
export const hasLongSignIn = (accountId: string) => longLived.has(accountId)

/** Drops the access token (Google refused it); a long-lasting sign-in gets a new one. */
export function markGoogleTokenInvalid(accountId: string) {
  tokens.delete(accountId)
}

/**
 * Forgets this device's sign-in. Access is not revoked at Google: that would also sign out the
 * user's other devices (revoke it from the Google Account to cut them all off).
 */
export async function forgetGoogleAccount(accountId: string) {
  tokens.delete(accountId)
  longLived.delete(accountId)
  await forgetPassword(googleKey(accountId))
}
