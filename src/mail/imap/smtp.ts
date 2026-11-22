import { openConnection, type BridgeConfig } from './bridge'
import { MailServerError, type ServerConfig } from './client'

/** One SMTP reply: the code and its text lines (multi-line replies joined). */
export interface SmtpReply {
  code: number
  lines: string[]
}

/** Splits received text into complete replies ("250-a", "250-b", "250 c" is one reply). */
export class SmtpReader {
  private buf = ''
  private lines: string[] = []
  private decoder = new TextDecoder()

  push(chunk: Uint8Array): SmtpReply[] {
    this.buf += this.decoder.decode(chunk, { stream: true })
    const out: SmtpReply[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) continue
      this.lines.push(m[3])
      if (m[2] === ' ') {
        out.push({ code: Number(m[1]), lines: this.lines })
        this.lines = []
      }
    }
    return out
  }
}

const b64 = (s: string) => {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** A minimal SMTP client (RFC 5321) with implicit TLS or STARTTLS, and AUTH PLAIN / LOGIN. */
export class SmtpClient {
  extensions = new Set<string>()
  authMethods = new Set<string>()
  private reader = new SmtpReader()
  private waiters: ((r: SmtpReply) => void)[] = []
  private replies: SmtpReply[] = []
  private error?: Error

  private constructor(private conn: Awaited<ReturnType<typeof openConnection>>) {
    conn.onData = (b) => {
      for (const r of this.reader.push(b)) {
        const w = this.waiters.shift()
        if (w) w(r)
        else this.replies.push(r)
      }
    }
    conn.onClose = (e) => {
      this.error = e ?? new MailServerError('closed', 'closed')
      for (const w of this.waiters.splice(0)) w({ code: 0, lines: [this.error.message] })
    }
  }

  static async connect(bridge: BridgeConfig, server: Pick<ServerConfig, 'host' | 'port' | 'security'>) {
    const conn = await openConnection(bridge, server.host, server.port, server.security)
    const c = new SmtpClient(conn)
    try {
      c.expect(await c.reply(), 220)
      await c.ehlo()
      if (server.security === 'starttls') {
        if (!c.extensions.has('STARTTLS')) throw new MailServerError('server', 'STARTTLS not offered')
        const tls = conn.startTls() // announced before the command (see bridge/worker.js)
        tls.catch(() => {})
        c.expect(await c.command('STARTTLS'), 220)
        await tls
        await c.ehlo()
      }
      return c
    } catch (e) {
      conn.close()
      throw e
    }
  }

  private reply(timeoutMs = 30_000): Promise<SmtpReply> {
    const ready = this.replies.shift()
    if (ready) return Promise.resolve(ready)
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new MailServerError('timeout', 'SMTP')), timeoutMs)
      this.waiters.push((r) => {
        clearTimeout(timer)
        if (r.code === 0) reject(this.error)
        else resolve(r)
      })
    })
  }

  command(line: string) {
    this.conn.send(`${line}\r\n`)
    return this.reply()
  }

  private expect(r: SmtpReply, ...codes: number[]) {
    if (!codes.includes(r.code)) throw new MailServerError('server', `${r.code} ${r.lines.join(' ')}`)
    return r
  }

  private async ehlo() {
    // An address literal: the app has no host name of its own to announce.
    const r = this.expect(await this.command('EHLO [127.0.0.1]'), 250)
    this.extensions.clear()
    this.authMethods.clear()
    for (const l of r.lines.slice(1)) {
      const [name, ...args] = l.toUpperCase().split(/\s+/)
      this.extensions.add(name)
      if (name === 'AUTH') for (const a of args) this.authMethods.add(a)
    }
  }

  async login(username: string, password: string) {
    let r: SmtpReply
    if (this.authMethods.has('PLAIN') || !this.authMethods.has('LOGIN')) {
      r = await this.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`)
    } else {
      this.expect(await this.command('AUTH LOGIN'), 334)
      this.expect(await this.command(b64(username)), 334)
      r = await this.command(b64(password))
    }
    if (r.code !== 235) throw new MailServerError('auth', `${r.code} ${r.lines.join(' ')}`)
  }

  async quit() {
    try {
      await this.command('QUIT')
    } catch {
      /* closing anyway */
    }
    this.conn.close()
  }
}
