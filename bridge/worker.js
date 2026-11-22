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
 */
import { connect } from 'cloudflare:sockets'

/** Raised when the app needs a newer bridge (it tells the user to update). Only functions may be exported: Workers treat exports as entry points. */
const VERSION = 2

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
        ? text(200, `ok ${VERSION}${env.GOOGLE_CLIENT_SECRET ? ' google' : ''}`, cors)
        : text(401, 'Wrong access key', cors)
    if (url.pathname === '/google/token') {
      if (!keyMatches(bearer(request), env.ACCESS_KEY)) return text(401, 'Wrong access key', cors)
      return googleToken(request, env, cors)
    }
    if (url.pathname === '/autoconfig') {
      if (!keyMatches(bearer(request), env.ACCESS_KEY)) return text(401, 'Wrong access key', cors)
      const domain = (url.searchParams.get('domain') ?? '').toLowerCase()
      if (!isDomainName(domain)) return text(400, 'Bad domain', cors)
      return Response.json(await autoconfig(domain), { headers: cors })
    }
    return text(404, 'Not found', cors)
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
