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

  /**
   * Sends a message: the envelope sender and recipients, then the raw message (CRLF line ends).
   * Lines starting with a dot are doubled, as SMTP requires.
   */
  async send(from: string, recipients: string[], message: Uint8Array) {
    const utf8 = [from, ...recipients].some((a) => /[^ -~]/.test(a)) && this.extensions.has('SMTPUTF8') ? ' SMTPUTF8' : ''
    this.expect(await this.command(`MAIL FROM:<${from}>${utf8}`), 250)
    for (const r of recipients) this.expect(await this.command(`RCPT TO:<${r}>`), 250, 251)
    this.expect(await this.command('DATA'), 354)
    this.conn.send(dotStuff(message))
    this.expect(await this.reply(300_000), 250)
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

/** The DATA section: "." at a line start doubled, ending with CRLF . CRLF */
export function dotStuff(message: Uint8Array): Uint8Array {
  let dots = 0
  for (let i = 0; i < message.length; i++) if (message[i] === 0x2e && (i === 0 || message[i - 1] === 0x0a)) dots++
  const endsWithNewline = message.length > 0 && message[message.length - 1] === 0x0a
  const out = new Uint8Array(message.length + dots + (endsWithNewline ? 0 : 2) + 3)
  let o = 0
  for (let i = 0; i < message.length; i++) {
    if (message[i] === 0x2e && (i === 0 || message[i - 1] === 0x0a)) out[o++] = 0x2e
    out[o++] = message[i]
  }
  if (!endsWithNewline) {
    out[o++] = 0x0d
    out[o++] = 0x0a
  }
  out.set([0x2e, 0x0d, 0x0a], o)
  return out
}
