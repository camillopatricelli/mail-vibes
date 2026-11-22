/**
 * The browser side of the optional IMAP bridge (bridge/worker.js, docs/imap-bridge.md): a byte
 * stream to a mail server, carried over a WebSocket to the user's own Cloudflare Worker.
 */

/** Largest piece sent in one WebSocket message (the bridge's limit is 1 MiB) */
const CHUNK = 256 * 1024

export interface BridgeConfig {
  /** https:// or wss:// address of the Worker */
  url: string
  key: string
}

export type Security = 'tls' | 'starttls'

export type BridgeErrorKind = 'unreachable' | 'key' | 'refused' | 'closed' | 'timeout'

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** Origins of custom-domain bridges allowed by the build's CSP (VITE_BRIDGE_ORIGINS). */
const extraOrigins = (import.meta.env.VITE_BRIDGE_ORIGINS ?? '').split(',').filter(Boolean)

/**
 * The bridge's base address as https://host (no path), or an error key if it isn't usable here.
 * Production builds can reach *.workers.dev and the build's VITE_BRIDGE_ORIGINS only (CSP).
 */
export function normalizeBridgeUrl(raw: string): { url: string } | { error: 'invalid' | 'notAllowed' } {
  let u: URL
  try {
    u = new URL(raw.trim().includes('://') ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    return { error: 'invalid' }
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  if (u.protocol === 'ws:') u.protocol = 'http:'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'invalid' }
  const origin = u.origin
  if (local) return import.meta.env.DEV ? { url: origin } : { error: 'notAllowed' }
  if (u.hostname.endsWith('.workers.dev') || extraOrigins.includes(origin.replace(/^https:/, 'wss:'))) return { url: origin }
  return { error: 'notAllowed' }
}

function b64url(s: string) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The bridge version this app needs (VERSION in bridge/worker.js). */
export const BRIDGE_VERSION = 1

/** Checks the bridge address, the page's origin and the access key; answers the bridge's version. */
export async function checkBridge(cfg: BridgeConfig): Promise<number> {
  const n = normalizeBridgeUrl(cfg.url)
  if ('error' in n) throw new BridgeError('unreachable', n.error)
  let r: Response
  try {
    r = await fetch(`${n.url}/check`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(10_000) })
  } catch {
    // A refused origin answers without CORS headers, which also lands here.
    throw new BridgeError('unreachable', 'unreachable')
  }
  if (r.status === 401) throw new BridgeError('key', 'key')
  if (!r.ok) throw new BridgeError('refused', await r.text())
  return Number(/^ok (\d+)/.exec(await r.text())?.[1] ?? 0)
}

export interface Connection {
  /** Called with each chunk received from the server */
  onData: (bytes: Uint8Array) => void
  /** Called once when the connection ends; `error` unless it was closed on purpose */
  onClose: (error?: BridgeError) => void
  send(data: Uint8Array | string): void
  /**
   * Call just BEFORE sending the STARTTLS command: the bridge switches to TLS as soon as the
   * server accepts it, and this resolves then (it never resolves if the server refuses).
   */
  startTls(): Promise<void>
  close(): void
}

/** Opens a connection to host:port through the bridge; resolves once the server is reached. */
export function openConnection(cfg: BridgeConfig, host: string, port: number, security: Security, timeoutMs = 20_000): Promise<Connection> {
  const n = normalizeBridgeUrl(cfg.url)
  if ('error' in n) return Promise.reject(new BridgeError('unreachable', n.error))
  const wsUrl = `${n.url.replace(/^http/, 'ws')}/connect?host=${encodeURIComponent(host)}&port=${port}&tls=${security === 'tls' ? 'on' : 'starttls'}`

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ['mail-vibes', `key.${b64url(cfg.key)}`])
    ws.binaryType = 'arraybuffer'
    let opened = false
    let ended = false
    let lastError: BridgeError | undefined
    let tlsWaiter: { resolve: () => void; reject: (e: Error) => void } | undefined
    const timer = setTimeout(() => fail(new BridgeError('timeout', 'timeout')), timeoutMs)
    const encoder = new TextEncoder()

    // Data that arrives before the caller sets onData is kept and handed over then.
    let early: Uint8Array[] | undefined = []
    let dataHandler: (b: Uint8Array) => void = (b) => early?.push(b)
    const conn: Connection = {
      get onData() {
        return dataHandler
      },
      set onData(h) {
        dataHandler = h
        const pending = early ?? []
        early = undefined
        for (const b of pending) h(b)
      },
      onClose: () => {},
      send: (data) => {
        if (ws.readyState !== WebSocket.OPEN) return
        const bytes = typeof data === 'string' ? encoder.encode(data) : (data as Uint8Array<ArrayBuffer>)
        // Cloudflare limits WebSocket messages to 1 MiB: big messages (attachments) go in pieces.
        for (let i = 0; i < bytes.length || i === 0; i += CHUNK) ws.send(bytes.subarray(i, i + CHUNK))
      },
      startTls: () =>
        new Promise<void>((res, rej) => {
          tlsWaiter = { resolve: res, reject: rej }
          ws.send(JSON.stringify({ op: 'starttls' }))
        }),
      close: () => {
        ended = true
        ws.close(1000)
      },
    }

    function fail(e: BridgeError) {
      clearTimeout(timer)
      lastError ??= e
      if (!opened) reject(lastError)
      tlsWaiter?.reject(lastError)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        conn.onData(new Uint8Array(ev.data as ArrayBuffer))
        return
      }
      const msg = JSON.parse(ev.data) as { op: string; message?: string }
      if (msg.op === 'open') {
        opened = true
        clearTimeout(timer)
        resolve(conn)
      } else if (msg.op === 'tls') {
        tlsWaiter?.resolve()
        tlsWaiter = undefined
      } else if (msg.op === 'error') {
        const m = msg.message ?? ''
        lastError = new BridgeError(/access key/i.test(m) ? 'key' : opened ? 'closed' : 'refused', m)
      }
    }
    ws.onclose = () => {
      clearTimeout(timer)
      const err = ended ? undefined : (lastError ?? new BridgeError(opened ? 'closed' : 'unreachable', opened ? 'closed' : 'unreachable'))
      if (!opened) reject(err)
      else {
        if (err) tlsWaiter?.reject(err)
        conn.onClose(err)
      }
    }
  })
}

export interface DetectedServer {
  protocol: 'imap' | 'smtp'
  host: string
  port: number
  security: Security
  /** May contain %EMAILADDRESS% / %EMAILLOCALPART% (Thunderbird's placeholders) */
  username: string
}

/**
 * Published settings for an email address's domain, looked up by the bridge (Thunderbird's
 * database, the provider's autoconfig file, DNS SRV records). Always shown for the user to check.
 */
export async function autodetect(cfg: BridgeConfig, email: string): Promise<{ source?: string; servers: DetectedServer[] }> {
  const n = normalizeBridgeUrl(cfg.url)
  if ('error' in n) throw new BridgeError('unreachable', n.error)
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return { servers: [] }
  let r: Response
  try {
    r = await fetch(`${n.url}/autoconfig?domain=${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new BridgeError('unreachable', 'unreachable')
  }
  if (r.status === 401) throw new BridgeError('key', 'key')
  if (!r.ok) throw new BridgeError('refused', await r.text())
  const j = (await r.json()) as { source?: string; servers?: DetectedServer[] }
  const local = email.split('@')[0]
  const servers = (j.servers ?? []).map((s) => ({
    ...s,
    username: s.username.replace(/%EMAILADDRESS%/g, email.trim()).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain),
  }))
  return { source: j.source, servers }
}
