import { create } from 'zustand'

/**
 * Passwords of IMAP accounts. They are NEVER put in the settings, the export file or logs.
 *
 * - By default a password is kept in memory only, for this app session (like Google sign-ins):
 *   closing or reloading the tab forgets it.
 * - "Remember on this device" encrypts it with AES-GCM and keeps it in IndexedDB. The key is a
 *   WebCrypto key created as non-extractable: the browser stores it but never hands out its
 *   bytes, so copying the browser's files to another computer doesn't reveal the password.
 *   Honest limits: anyone (or any malware) using this browser profile can still use it, through
 *   the app; it protects against copying, not against access to the device.
 *
 * Keys are `<accountId>` for the incoming server and `<accountId>#smtp` for a separate outgoing one.
 * The same store keeps long-lasting Google sign-ins (refresh tokens) as `<accountId>#google`.
 */

const memory = new Map<string, string>()

const DB = 'mail-vibes-secrets'
const KEYS = 'keys'
const SECRETS = 'secrets'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore(KEYS)
      r.result.createObjectStore(SECRETS)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function deviceKey(): Promise<CryptoKey> {
  const existing = await tx<CryptoKey | undefined>(KEYS, 'readonly', (s) => s.get('main'))
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await tx(KEYS, 'readwrite', (s) => s.put(key, 'main'))
  return key
}

interface Sealed {
  iv: Uint8Array
  data: ArrayBuffer
}

async function remembered(key: string): Promise<string | undefined> {
  try {
    const sealed = await tx<Sealed | undefined>(SECRETS, 'readonly', (s) => s.get(key))
    if (!sealed) return undefined
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as Uint8Array<ArrayBuffer> }, await deviceKey(), sealed.data)
    return new TextDecoder().decode(plain)
  } catch {
    return undefined // storage blocked (private window) or key lost: ask again
  }
}

/** The password for `key`, from memory or (if remembered) from this device. */
export async function getPassword(key: string): Promise<string | undefined> {
  const m = memory.get(key)
  if (m !== undefined) return m
  const r = await remembered(key)
  if (r !== undefined) memory.set(key, r)
  return r
}

export async function isRemembered(key: string) {
  try {
    return !!(await tx<Sealed | undefined>(SECRETS, 'readonly', (s) => s.get(key)))
  } catch {
    return false
  }
}

/** Keeps a password for this session; with `remember`, also (encrypted) on this device. */
export async function setPassword(key: string, password: string, remember: boolean) {
  memory.set(key, password)
  if (!remember) {
    await forgetRemembered(key)
    return
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new TextEncoder().encode(password))
  await tx(SECRETS, 'readwrite', (s) => s.put({ iv, data } satisfies Sealed, key))
}

async function forgetRemembered(key: string) {
  try {
    await tx(SECRETS, 'readwrite', (s) => s.delete(key))
  } catch {
    /* nothing stored */
  }
}

/** Forgets a password everywhere (wrong password, account removed). */
export async function forgetPassword(key: string) {
  memory.delete(key)
  await forgetRemembered(key)
}

export const smtpKey = (accountId: string) => `${accountId}#smtp`
/** The reminders key shared by the user's devices (src/notify/push.ts) */
export const PUSH_SETUP_KEY = 'push#setup'

/** Keeps a non-extractable key for the service worker (it reads the "keys" store itself). */
export async function putDeviceKey(name: string, key: CryptoKey) {
  await tx(KEYS, 'readwrite', (s) => s.put(key, name))
}

/** A Google account's long-lasting sign-in (refresh token), made through the bridge */
export const googleKey = (accountId: string) => `${accountId}#google`

// ---------- "Sign in" prompt ----------

interface PromptState {
  /** The account whose password is being asked for */
  accountId?: string
  ask: (accountId: string) => void
  close: () => void
}

export const usePasswordPrompt = create<PromptState>()((set) => ({
  ask: (accountId) => set({ accountId }),
  close: () => set({ accountId: undefined }),
}))
