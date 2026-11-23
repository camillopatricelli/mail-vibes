/**
 * Mail Vibes bridge: a small, stateless WebSocket <-> TCP/TLS relay for IMAP, SMTP and ManageSieve.
 *
 * Browsers cannot open mail connections, so Mail Vibes opens a WebSocket to this Worker, and the
 * Worker opens the connection to the mail server and copies bytes both ways. It does not understand
 * IMAP or SMTP (the app speaks them), and it stores and logs nothing.
 *
 * What it refuses, so it can't be used as an open relay:
 * - requests without the access key (the ACCESS_KEY secret, set by whoever deploys it);
 * - web pages other than the ones listed in ALLOWED_ORIGINS;
 * - ports other than the mail ports below;
 * - private, loopback and link-local addresses;
 * - unencrypted connections: TLS from the start, or STARTTLS before more than a few bytes are sent.
 *
 * Settings (Cloudflare dashboard > Worker > Settings > Variables and secrets):
 *   ACCESS_KEY            secret, required: a long random string; enter the same in Mail Vibes
 *   ALLOWED_ORIGINS       comma-separated list of the addresses Mail Vibes is opened from
 *   GOOGLE_CLIENT_SECRET  secret, optional: the client secret of the Google OAuth client the app
 *                         uses. With it, Google sign-ins last until revoked instead of one hour
 *                         (see /google/token). Never put it in the app, a file or the repository.
 *   DB                    D1 database binding, optional: with it (and a cron trigger running every
 *                         minute) the bridge sends event and task reminders as push notifications,
 *                         so they arrive while Mail Vibes is closed. See docs/push-reminders.md.
 *
 * Honest limit: TLS to the mail server ends in this Worker, so your password and mail pass through
 * its memory unencrypted (never stored). Deploy your own bridge; don't use one run by someone else.
 *
 * Endpoints:
 *   GET /                                      "ok" (to check the address)
 *   GET /check                                 "ok <VERSION>" if the origin and the access key (Bearer) are right
 *   GET /connect?host=…&port=…&tls=on|starttls  WebSocket. Binary frames carry the connection's bytes.
 *        Text frames carry JSON control messages:
 *        bridge -> app: {"op":"open"} | {"op":"tls"} | {"op":"error","message":"…"}
 *        app -> bridge: {"op":"starttls"}, sent just before the STARTTLS command (see pump)
 *   GET /autoconfig?domain=…                   looks up published mail settings for a domain (JSON)
 *   POST /google/token                         adds GOOGLE_CLIENT_SECRET to a Google token request:
 *        {client_id, code, code_verifier, redirect_uri} (after sign-in) or {client_id, refresh_token}
 *        (renewal), and answers Google's JSON. Stores nothing: the long-lasting token is kept by
 *        the app on the device.
 *   GET /push/key                              the bridge's public push key (VAPID)
 *   POST /push/device                          {setup, endpoint, p256dh, auth}: a device to notify
 *   POST /push/device/remove                   {endpoint}
 *   POST /push/schedule                        {setup, live, parts}: the coming reminders, encrypted
 */
import { connect } from 'cloudflare:sockets'

/** Raised when the app needs a newer bridge (it tells the user to update). Only functions may be exported: Workers treat exports as entry points. */
const VERSION = 3

const MAIL_PORTS = [993, 143, 465, 587, 4190]
/** Ports that start in plain text and must switch to TLS with STARTTLS */
const STARTTLS_PORTS = [143, 587, 4190]
/** Bytes the app may send before STARTTLS (EHLO / STARTTLS commands), so no password goes out unencrypted */
const PRE_TLS_LIMIT = 512
const PROTOCOL = 'mail-vibes'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''
    const cors = allowedOrigin(origin, env.ALLOWED_ORIGINS) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}

    if (url.pathname === '/') return new Response('ok', { headers: { ...cors, 'Content-Type': 'text/plain' } })
    if (!cors['Access-Control-Allow-Origin']) return text(403, 'Origin not allowed')
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' },
      })

    if (url.pathname === '/connect') return relay(request, env, url)
    if (url.pathname === '/check')
      return keyMatches(bearer(request), env.ACCESS_KEY)
        ? text(200, `ok ${VERSION}${env.GOOGLE_CLIENT_SECRET ? ' google' : ''}${env.DB ? ' push' : ''}`, cors)
        : text(401, 'Wrong access key', cors)
    if (url.pathname === '/google/token') {
      if (!keyMatches(bearer(request), env.ACCESS_KEY)) return text(401, 'Wrong access key', cors)
      return googleToken(request, env, cors)
    }
    if (url.pathname.startsWith('/push/')) {
      if (!keyMatches(bearer(request), env.ACCESS_KEY)) return text(401, 'Wrong access key', cors)
      return pushApi(request, env, url, cors)
    }
    if (url.pathname === '/autoconfig') {
      if (!keyMatches(bearer(request), env.ACCESS_KEY)) return text(401, 'Wrong access key', cors)
      const domain = (url.searchParams.get('domain') ?? '').toLowerCase()
      if (!isDomainName(domain)) return text(400, 'Bad domain', cors)
      return Response.json(await autoconfig(domain), { headers: cors })
    }
    return text(404, 'Not found', cors)
  },

  /** The cron trigger (every minute): reminders that are due go out as push notifications. */
  async scheduled(event, env, ctx) {
    if (env.DB) ctx.waitUntil(sendDueReminders(env))
  },
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** The body of Google's token request, or an error message. Exported for the tests. */
export function googleTokenForm(body, secret) {
  if (!body || typeof body !== 'object') return 'Bad request'
  const { client_id, code, code_verifier, redirect_uri, refresh_token } = body
  if (typeof client_id !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(client_id)) return 'Bad client_id'
  const form = new URLSearchParams({ client_id, client_secret: secret })
  if (typeof refresh_token === 'string' && refresh_token) {
    form.set('grant_type', 'refresh_token')
    form.set('refresh_token', refresh_token)
  } else if (typeof code === 'string' && code && typeof redirect_uri === 'string' && /^https?:\/\//.test(redirect_uri)) {
    form.set('grant_type', 'authorization_code')
    form.set('code', code)
    form.set('redirect_uri', redirect_uri)
    if (typeof code_verifier === 'string') form.set('code_verifier', code_verifier)
  } else return 'Bad request'
  return form
}

async function googleToken(request, env, cors, send = fetch) {
  if (request.method !== 'POST') return text(405, 'POST expected', cors)
  if (!env.GOOGLE_CLIENT_SECRET) return text(501, 'GOOGLE_CLIENT_SECRET is not set', cors)
  let body
  try {
    body = await request.json()
  } catch {
    return text(400, 'Bad request', cors)
  }
  const form = googleTokenForm(body, env.GOOGLE_CLIENT_SECRET)
  if (typeof form === 'string') return text(400, form, cors)
  const r = await send(GOOGLE_TOKEN_URL, { method: 'POST', body: form })
  return new Response(await r.text(), {
    status: r.status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

const text = (status, body, headers = {}) => new Response(body, { status, headers: { ...headers, 'Content-Type': 'text/plain' } })

// ---------- Checks (exported for the tests) ----------

export function allowedOrigin(origin, list) {
  if (!origin || !list) return false
  return list
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .includes(origin)
}

/** Constant-time comparison, so the key can't be guessed one character at a time. */
export function keyMatches(given, expected) {
  if (!expected || expected.length < 16 || typeof given !== 'string') return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]
  return diff === 0
}

const bearer = (request) => /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1]

/** The key travels as a WebSocket sub-protocol ("key.<base64url>"), as browsers can't set headers there. */
export function keyFromProtocols(header) {
  const p = (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith('key.'))
  if (!p) return undefined
  try {
    const b64 = p.slice(4).replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

export const isDomainName = (s) => s.length <= 253 && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(s)

export function isPrivateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

export function isPrivateIPv6(ip) {
  const x = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (!x.includes(':')) return false
  if (x === '::' || x === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)
  if (mapped) return isPrivateIPv4(mapped[1])
  return /^(f[c-d]|fe[89ab]|ff)/.test(x) // unique local, link-local, multicast
}

const isIpLiteral = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')

/** Validates the target. Answers an error message, or undefined if the connection may be opened. */
export async function checkTarget(host, port, tls, resolve = resolveDns) {
  if (!MAIL_PORTS.includes(port)) return 'Port not allowed'
  if (tls !== 'on' && tls !== 'starttls') return 'Encryption is required'
  if (tls === 'starttls' && !STARTTLS_PORTS.includes(port)) return 'STARTTLS is not used on this port'
  if (isIpLiteral(host)) return 'Use a host name, not an IP address'
  if (!isDomainName(host) || /\.(local|localhost|internal|lan|home|arpa)$/i.test(host)) return 'Host name not allowed'
  const ips = await resolve(host)
  if (!ips.length) return 'Host name not found'
  if (ips.some((ip) => isPrivateIPv4(ip) || isPrivateIPv6(ip))) return 'Private addresses are not allowed'
  return undefined
}

/** A and AAAA records over DNS-over-HTTPS. (Cloudflare's network can't reach private networks anyway.) */
async function resolveDns(host) {
  const out = []
  for (const type of ['A', 'AAAA']) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
    })
    if (!r.ok) continue
    const j = await r.json()
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data)
  }
  return out
}

// ---------- Relay ----------

async function relay(request, env, url) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text(426, 'WebSocket expected')
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  // Newer compatibility dates deliver binary messages as Blobs unless told otherwise.
  if ('binaryType' in server) server.binaryType = 'arraybuffer'
  const headers = { 'Sec-WebSocket-Protocol': PROTOCOL }
  const fail = (message) => {
    server.send(JSON.stringify({ op: 'error', message }))
    server.close(4000, message.slice(0, 120))
    return new Response(null, { status: 101, webSocket: client, headers })
  }
  // Errors are reported inside the WebSocket: browsers hide the HTTP status of a refused upgrade.
  if (!keyMatches(keyFromProtocols(request.headers.get('Sec-WebSocket-Protocol')), env.ACCESS_KEY)) return fail('Wrong access key')

  const host = (url.searchParams.get('host') ?? '').toLowerCase()
  const port = Number(url.searchParams.get('port'))
  const tls = url.searchParams.get('tls')
  const refused = await checkTarget(host, port, tls)
  if (refused) return fail(refused)

  let socket
  try {
    socket = connect({ hostname: host, port }, { secureTransport: tls, allowHalfOpen: false })
  } catch (e) {
    return fail(`Cannot connect: ${e.message}`)
  }
  pump(server, socket, tls === 'on')
  return new Response(null, { status: 101, webSocket: client, headers })
}

/**
 * Copies bytes both ways. STARTTLS: the app sends {"op":"starttls"} just before its STARTTLS
 * command. The bridge forwards the server's reply and, once the reply line is complete and
 * positive, stops reading (so no read is pending), switches the socket to TLS and answers
 * {"op":"tls"}. A refusal is forwarded as is and the connection stays as it was.
 */
function pump(ws, first, encrypted) {
  let socket = first
  let writer = socket.writable.getWriter()
  let preTlsBytes = 0
  let armed = false
  let closed = false
  const decoder = new TextDecoder()

  const close = (message) => {
    if (closed) return
    closed = true
    if (message) {
      try {
        ws.send(JSON.stringify({ op: 'error', message }))
      } catch {}
    }
    try {
      ws.close(message ? 4000 : 1000, (message ?? '').slice(0, 120))
    } catch {}
    socket.close().catch(() => {})
  }

  const readLoop = async () => {
    const reader = socket.readable.getReader()
    let reply = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return close()
        ws.send(value)
        if (!armed) continue
        reply += decoder.decode(value, { stream: true })
        if (!reply.endsWith('\n')) continue
        const last = reply.trimEnd().split('\n').pop().trim()
        reply = ''
        // Untagged IMAP lines and SMTP continuation lines may come first: wait for the final one.
        if (!isFinalReply(last)) continue
        armed = false
        if (!isStartTlsOk(last)) continue
        reader.releaseLock()
        writer.releaseLock()
        socket = socket.startTls()
        writer = socket.writable.getWriter()
        encrypted = true
        // The handshake runs once data flows; TLS errors show up as a failed read or write.
        ws.send(JSON.stringify({ op: 'tls' }))
        return readLoop()
      }
    } catch (e) {
      close(`Connection lost: ${e.message}`)
    }
  }

  socket.opened.then(
    () => {
      ws.send(JSON.stringify({ op: 'open' }))
      void readLoop()
    },
    (e) => close(`Cannot connect: ${e.message}`),
  )

  // Messages are handled strictly in order (reading a Blob takes a moment).
  let chain = Promise.resolve()
  ws.addEventListener('message', (event) => {
    chain = chain.then(() => onMessage(event))
  })

  const onMessage = async (event) => {
    if (closed) return
    if (typeof event.data === 'string') {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return close('Bad control message')
      }
      if (msg.op === 'starttls' && !encrypted) armed = true
      return
    }
    const bytes = new Uint8Array(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data)
    if (!encrypted) {
      preTlsBytes += bytes.length
      if (preTlsBytes > PRE_TLS_LIMIT) return close('Send STARTTLS before anything else')
    }
    try {
      await writer.write(bytes)
    } catch (e) {
      close(`Connection lost: ${e.message}`)
    }
  }
  ws.addEventListener('close', () => close())
  ws.addEventListener('error', () => close())
}

/** The last line of a reply: SMTP "250 …", IMAP tagged "A1 OK/NO/BAD …", ManageSieve "OK/NO/BYE …". */
export const isFinalReply = (line) => /^(\d{3}( |$)|[^*+\s]\S* (OK|NO|BAD)\b|(OK|NO|BYE)\b)/i.test(line)

/** A positive answer to STARTTLS: SMTP "220", IMAP "A1 OK", ManageSieve "OK". */
export const isStartTlsOk = (line) => /^(220( |$)|[^*+\s]\S* OK\b|OK\b)/i.test(line)

// ---------- Auto-detect ----------

/**
 * Published settings for a domain: Thunderbird's database, the provider's own autoconfig file,
 * and DNS SRV records (RFC 6186). Only these fixed addresses are fetched, so this can't be used as
 * a general proxy. The app shows the result for the user to confirm.
 */
export async function autoconfig(domain) {
  const sources = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ]
  for (const src of sources) {
    try {
      const r = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(4000), cf: { cacheTtl: 3600 } })
      if (!r.ok) continue
      const xml = (await r.text()).slice(0, 100_000)
      const servers = parseAutoconfigXml(xml)
      if (servers.length) return { source: new URL(src).hostname, servers }
    } catch {}
  }
  const servers = []
  for (const [service, protocol] of [['_imaps._tcp', 'imap'], ['_imap._tcp', 'imap'], ['_submissions._tcp', 'smtp'], ['_submission._tcp', 'smtp']]) {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${service}.${domain}&type=SRV`, {
        headers: { Accept: 'application/dns-json' },
      })
      const j = await r.json()
      for (const a of j.Answer ?? []) {
        const [, , port, target] = String(a.data).split(/\s+/)
        const host = target?.replace(/\.$/, '')
        if (!host || !isDomainName(host)) continue // "." means "no such service"
        const p = Number(port)
        servers.push({ protocol, host, port: p, security: p === 993 || p === 465 ? 'tls' : 'starttls', username: '%EMAILADDRESS%' })
      }
    } catch {}
  }
  return { source: servers.length ? 'dns' : undefined, servers }
}

/** Extracts the IMAP and SMTP servers from a Thunderbird autoconfig file (no XML library in Workers). */
export function parseAutoconfigXml(xml) {
  const out = []
  const re = /<(incomingServer|outgoingServer)\s+type="(imap|smtp)"\s*>([\s\S]*?)<\/\1>/g
  for (const m of xml.matchAll(re)) {
    const get = (tag) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(m[3])?.[1]
    const socket = (get('socketType') ?? '').toUpperCase()
    const host = get('hostname')
    const port = Number(get('port'))
    if (!host || !port || (socket !== 'SSL' && socket !== 'STARTTLS')) continue
    out.push({ protocol: m[2], host, port, security: socket === 'SSL' ? 'tls' : 'starttls', username: get('username') ?? '%EMAILADDRESS%' })
  }
  return out
}

// ---------- Push reminders (optional) ----------
//
// Needs a D1 database bound as DB and a cron trigger (every minute); see docs/push-reminders.md.
// The app sends the reminders of the coming days, each one encrypted on the user's devices with a
// key the bridge never sees ("blob"). The bridge keeps them with their times, and when one is due
// it sends it as a Web Push message (RFC 8030/8291/8292) to every device registered for the
// same setup. It can see when reminders are, not what they say.

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/]
const SETUP_RE = /^[A-Za-z0-9_-]{16,64}$/
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const B64_RE = /^[A-Za-z0-9_-]+$/
const MAX_PARTS = 60
const MAX_ITEMS = 400
const MAX_BLOB = 2400
/** A reminder that couldn't be sent within this time (bridge or device offline) is dropped. */
const SEND_WINDOW_MS = 3600_000

/** Only real push services: the bridge must not post to any address it is given. */
export function pushEndpointAllowed(endpoint, env = {}) {
  let u
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  // Local tests only: DEV_PUSH_LOCAL is set in the git-ignored .dev.vars, never in Cloudflare.
  if (env.DEV_PUSH_LOCAL === 'yes' && u.protocol === 'http:' && u.hostname === 'localhost') return true
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname))
}

const b64u = {
  enc(bytes) {
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
  },
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/**
 * Web Push message encryption (RFC 8291, aes128gcm) for a device's p256dh and auth keys.
 * `fixed` (tests only) supplies the sender's key pair and the salt.
 */
export async function encryptPush(plaintext, p256dh, auth, fixed = {}) {
  const te = new TextEncoder()
  const uaPublic = b64u.dec(p256dh)
  const asKeys = fixed.keys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256))
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const ikm = await hkdf(b64u.dec(auth), secret, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(plaintext), [2])))
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length
  return concat(header, asPublic, ct)
}

/** The bridge's own push identity (VAPID), made the first time and kept in the database. */
async function vapidKeys(db) {
  const read = async () => (await db.prepare('SELECT jwk FROM push_keys WHERE id = 1').first())?.jwk
  let raw = await read()
  if (!raw) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    await db.prepare('INSERT OR IGNORE INTO push_keys (id, jwk) VALUES (1, ?)').bind(JSON.stringify(jwk)).run()
    raw = await read()
  }
  const jwk = JSON.parse(raw)
  const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { privateKey, publicKey: b64u.enc(concat([4], b64u.dec(jwk.x), b64u.dec(jwk.y))) }
}

/** The Authorization header for a push service (RFC 8292). */
export async function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const te = new TextEncoder()
  const part = (o) => b64u.enc(te.encode(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, te.encode(unsigned)))
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${keys.publicKey}`
}

/** Who runs this bridge, for push services (they require a contact): the app's address. */
const pushSubject = (env) =>
  (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith('https://')) ?? 'https://github.com/camillopatricelli/mail-vibes'

let tablesReady = false
async function ensureTables(db) {
  if (tablesReady) return
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY, jwk TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, setup TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, updated INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_parts (setup TEXT NOT NULL, part TEXT NOT NULL, items TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (setup, part))'),
    db.prepare('CREATE TABLE IF NOT EXISTS push_sent (setup TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (setup, id))'),
  ])
  tablesReady = true
}

/** Checks a schedule upload. Answers an error message, or the cleaned-up schedule. Exported for the tests. */
export function parseSchedule(body) {
  if (!body || typeof body !== 'object' || typeof body.setup !== 'string' || !SETUP_RE.test(body.setup)) return 'Bad setup'
  const live = body.live
  if (!Array.isArray(live) || live.length > MAX_PARTS || !live.every((p) => typeof p === 'string' && ID_RE.test(p))) return 'Bad parts'
  const parts = {}
  for (const [part, items] of Object.entries(body.parts ?? {})) {
    if (!live.includes(part)) return 'Bad parts'
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return 'Too many reminders'
    for (const it of items)
      if (!it || typeof it.id !== 'string' || !ID_RE.test(it.id) || !Number.isFinite(it.at) || typeof it.blob !== 'string' || it.blob.length > MAX_BLOB || !B64_RE.test(it.blob))
        return 'Bad reminder'
    parts[part] = items.map((it) => ({ id: it.id, at: Math.round(it.at), blob: it.blob }))
  }
  return { setup: body.setup, live, parts }
}

/** The reminders to send now: due within the last hour and not sent yet. Exported for the tests. */
export function dueReminders(partItems, sent, now) {
  const out = new Map()
  for (const items of partItems) for (const it of items) if (it.at <= now && it.at > now - SEND_WINDOW_MS && !sent.has(it.id)) out.set(it.id, it)
  return [...out.values()].sort((a, b) => a.at - b.at)
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** /push/key, /push/device, /push/device/remove, /push/schedule */
async function pushApi(request, env, url, cors) {
  if (!env.DB) return text(501, 'The bridge has no database (DB) for reminders', cors)
  const db = env.DB
  await ensureTables(db)
  const now = Date.now()
  if (url.pathname === '/push/key') return Response.json({ publicKey: (await vapidKeys(db)).publicKey }, { headers: cors })
  if (request.method !== 'POST') return text(405, 'POST expected', cors)
  const body = await readJson(request)

  if (url.pathname === '/push/device') {
    const { setup, endpoint, p256dh, auth } = body ?? {}
    if (typeof setup !== 'string' || !SETUP_RE.test(setup)) return text(400, 'Bad setup', cors)
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !pushEndpointAllowed(endpoint, env)) return text(400, 'Not a push service', cors)
    if (typeof p256dh !== 'string' || !B64_RE.test(p256dh) || p256dh.length > 100 || typeof auth !== 'string' || !B64_RE.test(auth) || auth.length > 40)
      return text(400, 'Bad keys', cors)
    await db
      .prepare(
        'INSERT INTO push_devices (endpoint, setup, p256dh, auth, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET setup = excluded.setup, p256dh = excluded.p256dh, auth = excluded.auth, updated = excluded.updated',
      )
      .bind(endpoint, setup, p256dh, auth, now)
      .run()
    return text(200, 'ok', cors)
  }
  if (url.pathname === '/push/device/remove') {
    if (typeof body?.endpoint !== 'string') return text(400, 'Bad request', cors)
    await db.prepare('DELETE FROM push_devices WHERE endpoint = ?').bind(body.endpoint).run()
    return text(200, 'ok', cors)
  }
  if (url.pathname === '/push/schedule') {
    const s = parseSchedule(body)
    if (typeof s === 'string') return text(400, s, cors)
    const statements = [
      db.prepare(`DELETE FROM push_parts WHERE setup = ? AND part NOT IN (SELECT value FROM json_each(?))`).bind(s.setup, JSON.stringify(s.live)),
      ...Object.entries(s.parts).map(([part, items]) =>
        db
          .prepare('INSERT INTO push_parts (setup, part, items, updated) VALUES (?, ?, ?, ?) ON CONFLICT (setup, part) DO UPDATE SET items = excluded.items, updated = excluded.updated')
          .bind(s.setup, part, JSON.stringify(items), now),
      ),
      // Parts that didn't change are still current: keep them from being cleaned up as abandoned.
      db.prepare(`UPDATE push_parts SET updated = ? WHERE setup = ?`).bind(now, s.setup),
    ]
    await db.batch(statements)
    return text(200, 'ok', cors)
  }
  return text(404, 'Not found', cors)
}

/** Every minute (cron trigger): sends the reminders that are due. */
export async function sendDueReminders(env, now = Date.now(), send = fetch) {
  const db = env.DB
  await ensureTables(db)
  const { results: rows } = await db.prepare('SELECT setup, items FROM push_parts').all()
  const bySetup = new Map()
  for (const r of rows) {
    let items
    try {
      items = JSON.parse(r.items)
    } catch {
      continue
    }
    if (!bySetup.has(r.setup)) bySetup.set(r.setup, [])
    bySetup.get(r.setup).push(items)
  }
  let keys
  const auths = new Map()
  for (const [setup, partItems] of bySetup) {
    const { results: sentRows } = await db.prepare('SELECT id FROM push_sent WHERE setup = ? AND at > ?').bind(setup, now - 2 * SEND_WINDOW_MS).all()
    const due = dueReminders(partItems, new Set(sentRows.map((r) => r.id)), now)
    if (!due.length) continue
    const { results: devices } = await db.prepare('SELECT endpoint, p256dh, auth FROM push_devices WHERE setup = ?').bind(setup).all()
    // Marked as sent first: a reminder is better missed than repeated every minute if sending fails.
    await db.batch(due.map((it) => db.prepare('INSERT OR IGNORE INTO push_sent (setup, id, at) VALUES (?, ?, ?)').bind(setup, it.id, it.at)))
    keys ??= await vapidKeys(db)
    for (const it of due)
      for (const d of devices) {
        try {
          const aud = new URL(d.endpoint).origin
          if (!auths.has(aud)) auths.set(aud, await vapidAuthorization(d.endpoint, keys, pushSubject(env), now))
          const ttl = Math.max(60, Math.round((SEND_WINDOW_MS - (now - it.at)) / 1000))
          const r = await send(d.endpoint, {
            method: 'POST',
            headers: { Authorization: auths.get(aud), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'high' },
            body: await encryptPush(it.blob, d.p256dh, d.auth),
          })
          // Gone: the device unsubscribed, or the app was removed.
          if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM push_devices WHERE endpoint = ?').bind(d.endpoint).run()
        } catch {
          /* one device failing doesn't stop the others */
        }
      }
  }
  await db.batch([
    db.prepare('DELETE FROM push_sent WHERE at < ?').bind(now - 2 * 24 * 3600_000),
    // Nobody has opened Mail Vibes with this setup for a month: forget its reminders and devices.
    db.prepare('DELETE FROM push_parts WHERE updated < ?').bind(now - 30 * 24 * 3600_000),
    db.prepare('DELETE FROM push_devices WHERE updated < ?').bind(now - 90 * 24 * 3600_000),
  ])
}
