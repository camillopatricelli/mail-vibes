import { getPassword, googleKey, isRemembered, setPassword, smtpKey } from '../mail/imap/passwords'
import { exportSettingsJson, parseSettingsJson, type Settings } from '../settings/store'

/**
 * "Copy to another device": the whole setup in one link,
 *   https://<host>/<base>/#/setup/device/<payload>
 * with the settings (including the IMAP bridge) and the IMAP passwords this device knows.
 *
 * The payload is encrypted with AES-GCM; the key comes from a random 8-character code shown only
 * on the old device (PBKDF2-SHA256, 600,000 rounds), so the link alone reveals nothing. It sits
 * after the "#", which browsers never send to the web server. It expires after a day.
 * Long-lasting Google sign-ins (made through the bridge) come along too. Other Google sign-ins
 * and Microsoft sign-ins can't be copied: the new device signs in once per account.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1
const ROUNDS = 600_000
const VERSION = 1
export const TRANSFER_TTL = 24 * 3600_000

export interface TransferPassword {
  key: string
  password: string
  remember: boolean
}

export interface Transfer {
  /** When the link was made */
  at: number
  /** The settings file's text (validated again on import) */
  settings: string
  /** Whether the bridge goes into exported settings files (a preference, kept as it was) */
  exportBridge: boolean
  passwords: TransferPassword[]
}

/** "K7QM-4XRT" */
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8))
  const c = [...r].map((b) => ALPHABET[b % ALPHABET.length]).join('')
  return `${c.slice(0, 4)}-${c.slice(4)}`
}

/** As typed: any case, with or without spaces and dashes. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

function b64url(bytes: Uint8Array) {
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer())
}

async function keyFrom(code: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Encrypts a transfer: version byte, salt (16), IV (12), then the compressed, encrypted JSON. */
export async function sealTransfer(t: Transfer, code: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(t)), new CompressionStream('deflate-raw'))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(code, salt), plain as BufferSource))
  const out = new Uint8Array(1 + 16 + 12 + sealed.length)
  out[0] = VERSION
  out.set(salt, 1)
  out.set(iv, 17)
  out.set(sealed, 29)
  return b64url(out)
}

export class TransferError extends Error {
  constructor(readonly kind: 'invalid' | 'code' | 'expired') {
    super(kind)
    this.name = 'TransferError'
  }
}

export async function openTransfer(payload: string, code: string, now = Date.now()): Promise<Transfer> {
  let bytes: Uint8Array
  try {
    bytes = unb64url(payload)
  } catch {
    throw new TransferError('invalid')
  }
  if (bytes.length < 30 || bytes[0] !== VERSION) throw new TransferError('invalid')
  let plain: Uint8Array
  try {
    const key = await keyFrom(code, bytes.subarray(1, 17))
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(17, 29) as BufferSource }, key, bytes.subarray(29) as BufferSource))
  } catch {
    throw new TransferError('code')
  }
  const t = JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream('deflate-raw')))) as Transfer
  if (typeof t.at !== 'number' || now - t.at > TRANSFER_TTL) throw new TransferError('expired')
  return t
}

/** The password keys of the settings' IMAP accounts (incoming, and outgoing when separate). */
export function passwordKeys(s: Pick<Settings, 'accounts'>) {
  return s.accounts.flatMap((a) => (!a.imap ? [] : a.imap.outgoing && !a.imap.outgoing.samePassword ? [a.id, smtpKey(a.id)] : [a.id]))
}

/** Keys of the long-lasting Google sign-ins the accounts may have */
export function googleSignInKeys(s: Pick<Settings, 'accounts'>) {
  return s.accounts.filter((a) => a.provider === 'google').map((a) => googleKey(a.id))
}

/** Whether a transferred secret is a Google sign-in (not an IMAP password) */
export const isGoogleSignIn = (p: TransferPassword) => p.key.endsWith('#google')

/** Everything this device can hand over, and the accounts whose password it doesn't know. */
export async function collectTransfer(s: Settings): Promise<{ transfer: Transfer; missing: string[] }> {
  const passwords: TransferPassword[] = []
  const missing = new Set<string>()
  for (const key of passwordKeys(s)) {
    const password = await getPassword(key)
    if (password === undefined) missing.add(key.replace(/#smtp$/, ''))
    else passwords.push({ key, password, remember: await isRemembered(key) })
  }
  for (const key of googleSignInKeys(s)) {
    const token = await getPassword(key)
    if (token !== undefined) passwords.push({ key, password: token, remember: true })
  }
  return {
    transfer: { at: Date.now(), settings: exportSettingsJson({ ...s, exportBridge: true }), exportBridge: s.exportBridge, passwords },
    missing: [...missing],
  }
}

/** The settings to apply on the new device (validated like an imported file). */
export function transferSettings(t: Transfer): Settings {
  return { ...parseSettingsJson(t.settings), exportBridge: t.exportBridge === true }
}

/** Stores the passwords of accounts that exist in the new settings. */
export async function storeTransferPasswords(t: Transfer, settings: Settings) {
  const keys = new Set([...passwordKeys(settings), ...googleSignInKeys(settings)])
  for (const p of t.passwords) if (keys.has(p.key) && typeof p.password === 'string') await setPassword(p.key, p.password, p.remember === true)
}

export const transferUrl = (payload: string) => `${location.origin}${import.meta.env.BASE_URL}#/setup/device/${payload}`

/** The payload from a pasted link (or the bare payload). */
export function payloadFromLink(text: string) {
  const m = /#\/setup\/device\/([A-Za-z0-9_-]+)/.exec(text.trim())
  if (m) return m[1]
  return /^[A-Za-z0-9_-]{40,}$/.test(text.trim()) ? text.trim() : undefined
}
