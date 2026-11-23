import { create } from 'zustand'
import i18n from '../i18n'
import { bridgeBase, bridgeFeatures } from '../mail/imap/bridge'
import { getPassword, putDeviceKey, PUSH_SETUP_KEY, setPassword } from '../mail/imap/passwords'
import { useSettings } from '../settings/store'

/**
 * Reminders that arrive while Mail Vibes is closed, sent by the user's bridge as push
 * notifications (bridge/worker.js, docs/push-reminders.md).
 *
 * - A "setup" (an id and a 256-bit key) is shared by the user's devices: made on the first one,
 *   carried by Copy to another device, kept encrypted like remembered passwords.
 * - Any device with the setup uploads the coming reminders, each encrypted with the setup key, so
 *   the bridge sees only times and unreadable text. The service worker (public/sw.js) decrypts
 *   them with a copy of the key it can use but never read out (a non-extractable CryptoKey).
 * - Each device that wants them registers its push subscription with the bridge.
 */

interface PushSetup {
  id: string
  /** The AES-GCM key, base64url */
  key: string
}

/** This device receives reminders by push */
const ON_KEY = 'mail-vibes.push-on'
/** The bridge's last answer: can it send reminders? */
const CAN_KEY = 'mail-vibes.bridge-push'
/** What was last uploaded (fingerprints only), to upload only changes */
const UPLOADED_KEY = 'mail-vibes.push-uploaded'
/** Upload at least this often even without changes (keeps the bridge from forgetting the setup) */
const HEARTBEAT_MS = 6 * 3600_000

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

interface PushState {
  /** The bridge has a database for reminders */
  bridgeCan: boolean
  /** This device knows the setup (so it can upload reminders) */
  hasSetup: boolean
  /** This device receives reminders by push */
  on: boolean
}

function storedCan() {
  try {
    const v = JSON.parse(localStorage.getItem(CAN_KEY) ?? 'null') as { url?: string; push?: boolean } | null
    return v?.url === useSettings.getState().bridge?.url && v?.push === true
  } catch {
    return false
  }
}

export const usePushState = create<PushState>()(() => ({
  bridgeCan: storedCan(),
  hasSetup: false,
  on: typeof localStorage !== 'undefined' && localStorage.getItem(ON_KEY) === '1',
}))

// ---------- helpers ----------

function b64(bytes: Uint8Array) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64(s: string) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0))
}
async function digest(text: string, bytes = 16) {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, bytes))
}

async function bridgeCall(path: string, body?: unknown): Promise<Response> {
  const b = useSettings.getState().bridge
  const base = b && bridgeBase(b)
  if (!b || !base) throw new Error(i18n.t('push.noBridge'))
  let r: Response
  try {
    r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${b.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new Error(i18n.t('errors.network'))
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r
}

// ---------- the setup ----------

let setupCache: { setup: PushSetup; encrypt: CryptoKey } | undefined

async function loadSetup(): Promise<{ setup: PushSetup; encrypt: CryptoKey } | undefined> {
  const raw = await getPassword(PUSH_SETUP_KEY)
  if (!raw) return undefined
  if (setupCache && JSON.stringify(setupCache.setup) === raw) return setupCache
  let setup: PushSetup
  try {
    setup = JSON.parse(raw) as PushSetup
    if (typeof setup.id !== 'string' || typeof setup.key !== 'string') return undefined
  } catch {
    return undefined
  }
  const bytes = unb64(setup.key)
  const encrypt = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt'])
  // The service worker's copy: it can decrypt, but the key's bytes can't be read back.
  await putDeviceKey('push', await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']))
  setupCache = { setup, encrypt }
  usePushState.setState({ hasSetup: true })
  return setupCache
}

async function ensureSetup() {
  const existing = await loadSetup()
  if (existing) return existing
  const setup: PushSetup = { id: b64(crypto.getRandomValues(new Uint8Array(18))), key: b64(crypto.getRandomValues(new Uint8Array(32))) }
  await setPassword(PUSH_SETUP_KEY, JSON.stringify(setup), true)
  return (await loadSetup())!
}

// ---------- this device ----------

/** Asks the bridge whether it can send reminders (remembered, for starts without network). */
export async function checkPushBridge() {
  const b = useSettings.getState().bridge
  if (!b) return usePushState.setState({ bridgeCan: false })
  try {
    const { push } = await bridgeFeatures(b)
    localStorage.setItem(CAN_KEY, JSON.stringify({ url: b.url, push }))
    usePushState.setState({ bridgeCan: push })
  } catch {
    /* unreachable for now: keep the last answer */
  }
}

async function registerDevice(setup: PushSetup) {
  const reg = await navigator.serviceWorker.ready
  const { publicKey } = (await (await bridgeCall('/push/key')).json()) as { publicKey: string }
  let sub = await reg.pushManager.getSubscription()
  const current = sub?.options.applicationServerKey
  if (sub && (!current || b64(new Uint8Array(current)) !== publicKey)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(publicKey) })
  const keys = sub.toJSON().keys ?? {}
  await bridgeCall('/push/device', { setup: setup.id, endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth })
}

/** Settings → "Remind me even when the app is closed". Must start inside a click (permission prompt). */
export async function enablePush() {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(i18n.t('notify.denied'))
  const { setup } = await ensureSetup()
  await registerDevice(setup)
  localStorage.setItem(ON_KEY, '1')
  localStorage.removeItem(UPLOADED_KEY) // upload everything now
  usePushState.setState({ on: true })
}

export async function disablePush() {
  localStorage.removeItem(ON_KEY)
  usePushState.setState({ on: false })
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
  if (!sub) return
  await bridgeCall('/push/device/remove', { endpoint: sub.endpoint }).catch(() => undefined)
  await sub.unsubscribe()
}

/**
 * At start-up (and after Copy to another device): loads the setup and, on a device that receives
 * reminders, renews its registration (the setup may have changed, or the browser renewed the
 * subscription).
 */
export async function startPush() {
  if (!pushSupported() || !useSettings.getState().bridge) return
  await checkPushBridge()
  const loaded = await loadSetup().catch(() => undefined)
  if (loaded && usePushState.getState().on && Notification.permission === 'granted')
    await registerDevice(loaded.setup).catch(() => undefined)
}

// ---------- the reminders ----------

/** One reminder as shown by the service worker. */
export interface PushReminder {
  at: number
  /** Same tag as the app's own notification, so the two replace each other */
  tag: string
  title: string
  body?: string
  /** App address to open on click */
  hash?: string
  joinUrl?: string
  joinLabel?: string
}

async function seal(key: CryptoKey, r: PushReminder) {
  const plain = JSON.stringify({ t: r.title.slice(0, 140), b: r.body?.slice(0, 240), g: r.tag, h: r.hash, j: r.joinUrl, jl: r.joinLabel })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return b64(out)
}

let uploading = false

/**
 * Uploads the coming reminders, by part (a part is one account's events or tasks). Parts missing
 * from `parts` (their account failed to load) keep what the bridge has; parts not in `live` are
 * dropped there. Only changes go out.
 */
export async function uploadReminders(parts: Record<string, PushReminder[]>, live: string[]) {
  if (uploading || !usePushState.getState().bridgeCan) return
  uploading = true
  try {
    const loaded = await loadSetup()
    if (!loaded) return
    const { setup, encrypt } = loaded
    const partId = (name: string) => digest(`${setup.id}|part|${name}`)
    let last: { at?: number; live?: string; parts?: Record<string, string> } = {}
    try {
      last = JSON.parse(localStorage.getItem(UPLOADED_KEY) ?? '{}') as typeof last
    } catch {
      /* start afresh */
    }
    const liveIds = await Promise.all(live.map(partId))
    const liveFp = liveIds.slice().sort().join(',')
    const fps: Record<string, string> = { ...(last.parts ?? {}) }
    const changed: Record<string, PushReminder[]> = {}
    for (const [name, items] of Object.entries(parts)) {
      const id = await partId(name)
      const fp = await digest(JSON.stringify(items.slice().sort((a, b) => a.at - b.at || a.tag.localeCompare(b.tag))))
      if (fps[id] !== fp) changed[id] = items
      fps[id] = fp
    }
    const stale = !last.at || Date.now() - last.at > HEARTBEAT_MS
    if (!Object.keys(changed).length && last.live === liveFp && !stale) return
    const body: Record<string, { id: string; at: number; blob: string }[]> = {}
    for (const [id, items] of Object.entries(changed))
      body[id] = await Promise.all(items.map(async (r) => ({ id: await digest(`${setup.id}|${r.tag}|${r.at}`), at: r.at, blob: await seal(encrypt, r) })))
    await bridgeCall('/push/schedule', { setup: setup.id, live: liveIds, parts: body })
    for (const id of Object.keys(fps)) if (!liveIds.includes(id)) delete fps[id]
    localStorage.setItem(UPLOADED_KEY, JSON.stringify({ at: Date.now(), live: liveFp, parts: fps }))
  } catch {
    /* the bridge is unreachable: the next change or the next minute tries again */
  } finally {
    uploading = false
  }
}
