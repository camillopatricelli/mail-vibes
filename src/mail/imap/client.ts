import { BridgeError, openConnection, type BridgeConfig, type Connection, type Security } from './bridge'
import { capabilitiesOf, encodeString, parseResponse, ResponseSplitter, type ImapResponse } from './parse'

/** Where an IMAP or SMTP server is, as entered by the user. */
export interface ServerConfig {
  host: string
  port: number
  security: Security
  username: string
}

export type MailServerErrorKind = 'auth' | 'server' | 'timeout' | 'closed'

/** The server answered NO / BAD, refused the login, or went away. */
export class MailServerError extends Error {
  constructor(
    readonly kind: MailServerErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'MailServerError'
  }
}

export interface CommandResult {
  /** Untagged responses received while the command ran */
  untagged: ImapResponse[]
  /** The tagged completion (OK) */
  done: ImapResponse
}

/** A part of a command: text as is, or a string to send as an IMAP string (atom, quoted or literal). */
export type Part = string | { str: string } | Uint8Array

interface Pending {
  tag: string
  untagged: ImapResponse[]
  resolve: (r: CommandResult) => void
  reject: (e: Error) => void
  /** Literals waiting for the server's "+" */
  literals: Uint8Array[]
  timer: ReturnType<typeof setTimeout>
}

/**
 * A minimal IMAP client: one connection, commands run one at a time (queued).
 * Higher-level operations (folders, messages) build on `run`.
 */
export class ImapClient {
  capabilities = new Set<string>()
  /** Untagged responses that arrive outside a command (EXISTS, EXPUNGE during IDLE, …) */
  onUntagged?: (r: ImapResponse) => void
  /** Called once if the connection ends unexpectedly */
  onClose?: (e: Error) => void

  private splitter = new ResponseSplitter()
  private pending?: Pending
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0
  private greeting?: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void }
  /** Resolves with the server's first response */
  private hello: Promise<ImapResponse>
  private closed = false
  private encoder = new TextEncoder()

  private constructor(private conn: Connection) {
    this.hello = new Promise<ImapResponse>((resolve, reject) => {
      this.greeting = { resolve, reject }
    })
    this.hello.catch(() => {})
    conn.onData = (b) => {
      for (const raw of this.splitter.push(b)) this.handle(parseResponse(raw))
    }
    conn.onClose = (e) => this.fail(e ?? new MailServerError('closed', 'closed'))
  }

  /** Connects (TLS or STARTTLS) and reads the greeting and capabilities; doesn't log in. */
  static async connect(bridge: BridgeConfig, server: Pick<ServerConfig, 'host' | 'port' | 'security'>): Promise<ImapClient> {
    const conn = await openConnection(bridge, server.host, server.port, server.security)
    const c = new ImapClient(conn)
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const hello = await Promise.race([
        c.hello,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MailServerError('timeout', 'greeting')), 20_000)
        }),
      ]).finally(() => clearTimeout(timer))
      if (hello.type === 'BYE') throw new MailServerError('server', hello.text ?? 'BYE')
      c.setCapabilities(capabilitiesOf(hello))
      if (server.security === 'starttls') {
        // The bridge must hear about it before the command (see bridge/worker.js).
        const tls = conn.startTls()
        tls.catch(() => {})
        await c.run(['STARTTLS'])
        await tls
        c.capabilities.clear()
      }
      if (!c.capabilities.size) await c.refreshCapabilities()
      return c
    } catch (e) {
      c.close()
      throw e
    }
  }

  async refreshCapabilities() {
    const r = await this.run(['CAPABILITY'])
    for (const u of r.untagged) this.setCapabilities(capabilitiesOf(u))
  }

  has(cap: string) {
    return this.capabilities.has(cap.toUpperCase())
  }

  async login(username: string, password: string) {
    try {
      const r = await this.run(['LOGIN ', { str: username }, ' ', { str: password }], 30_000)
      this.capabilities.clear()
      this.setCapabilities(capabilitiesOf(r.done))
      if (!this.capabilities.size) await this.refreshCapabilities()
    } catch (e) {
      if (e instanceof MailServerError && e.kind === 'server') throw new MailServerError('auth', e.message)
      throw e
    }
  }

  async logout() {
    try {
      await this.run(['LOGOUT'], 5_000)
    } catch {
      /* the server may close first */
    }
    this.close()
  }

  close() {
    this.closed = true
    this.conn.close()
  }

  /** Runs a command (queued after the previous ones); rejects on NO / BAD. */
  run(parts: Part[], timeoutMs = 60_000): Promise<CommandResult> {
    const next = this.queue.then(() => this.send(parts, timeoutMs))
    this.queue = next.catch(() => {})
    return next
  }

  private send(parts: Part[], timeoutMs: number): Promise<CommandResult> {
    if (this.closed) return Promise.reject(new MailServerError('closed', 'closed'))
    const tag = `A${++this.seq}`
    // Text up to each literal goes in one chunk; the literal is sent after the server's "+".
    const chunks: (string | Uint8Array)[] = [`${tag} `]
    for (const p of parts) {
      const v = typeof p === 'string' ? p : p instanceof Uint8Array ? p : encodeString(p.str)
      if (typeof v === 'string') chunks[chunks.length - 1] += v
      else {
        chunks[chunks.length - 1] += `{${v.length}}\r\n`
        chunks.push(v, '')
      }
    }
    chunks[chunks.length - 1] += '\r\n'
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new MailServerError('timeout', parts[0]?.toString() ?? ''))
      }, timeoutMs)
      this.pending = { tag, untagged: [], resolve, reject, literals: [], timer }
      // chunks: text, literal, text, literal, …, text
      this.conn.send(chunks[0] as string)
      for (let i = 1; i < chunks.length; i += 2) {
        const lit = chunks[i] as Uint8Array
        const after = this.encoder.encode(chunks[i + 1] as string)
        const joined = new Uint8Array(lit.length + after.length)
        joined.set(lit)
        joined.set(after, lit.length)
        this.pending.literals.push(joined)
      }
    })
  }

  private handle(r: ImapResponse) {
    if (this.greeting) {
      const g = this.greeting
      this.greeting = undefined
      g.resolve(r)
      return
    }
    const p = this.pending
    if (r.tag === '+') {
      const lit = p?.literals.shift()
      if (lit) this.conn.send(lit)
      return
    }
    if (r.tag === '*') {
      if (r.type === 'CAPABILITY') this.setCapabilities(capabilitiesOf(r))
      if (p) p.untagged.push(r)
      else this.onUntagged?.(r)
      if (r.type === 'BYE' && !p) this.fail(new MailServerError('closed', r.text ?? 'BYE'))
      return
    }
    if (p && r.tag === p.tag) {
      clearTimeout(p.timer)
      this.pending = undefined
      if (r.type === 'OK') p.resolve({ untagged: p.untagged, done: r })
      else p.reject(new MailServerError('server', r.text || r.type))
    }
  }

  private setCapabilities(caps: string[] | undefined) {
    for (const c of caps ?? []) this.capabilities.add(c)
  }

  private fail(e: Error) {
    if (this.closed && !this.pending && !this.greeting) return
    const wasOpen = !this.closed
    this.closed = true
    this.greeting?.reject(e)
    this.greeting = undefined
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(e)
      this.pending = undefined
    }
    this.conn.close()
    if (wasOpen) this.onClose?.(e)
  }
}

export const isBridgeError = (e: unknown): e is BridgeError => e instanceof BridgeError
