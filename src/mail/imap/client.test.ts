import { describe, expect, it, vi } from 'vitest'
import type { Connection } from './bridge'

/** A scripted IMAP server: answers each command line the client sends. */
function fakeServer(script: (line: string, send: (s: string) => void, conn: { tls: boolean }) => void, greeting = '* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n') {
  const state = { tls: false, sent: [] as string[] }
  const conn: Connection = {
    onData: () => {},
    onClose: () => {},
    send: (d) => {
      const text = typeof d === 'string' ? d : new TextDecoder().decode(d)
      state.sent.push(text)
      for (const line of text.split('\r\n').filter(Boolean)) script(line, (s) => queueMicrotask(() => conn.onData(new TextEncoder().encode(s))), state)
    },
    startTls: async () => {
      state.tls = true
    },
    close: () => {},
  }
  setTimeout(() => conn.onData(new TextEncoder().encode(greeting)))
  return { conn, state }
}

let server: ReturnType<typeof fakeServer>
vi.mock('./bridge', async (orig) => ({
  ...(await orig<typeof import('./bridge')>()),
  openConnection: async () => server.conn,
}))

const { ImapClient, MailServerError } = await import('./client')
const bridge = { url: 'https://b.example.workers.dev', key: 'k' }

describe('IMAP client', () => {
  it('switches to TLS, logs in with a literal password and runs commands', async () => {
    server = fakeServer((line, send, st) => {
      const [tag, cmd] = line.split(' ')
      if (cmd === 'STARTTLS') send(`${tag} OK Begin TLS\r\n`)
      else if (cmd === 'CAPABILITY') send(`* CAPABILITY IMAP4rev1 ${st.tls ? 'AUTH=PLAIN IDLE' : 'STARTTLS'}\r\n${tag} OK\r\n`)
      else if (cmd === 'LOGIN') {
        if (!st.tls) send(`${tag} NO cleartext\r\n`)
        else if (line.endsWith('}')) send('+ go ahead\r\n')
        else send(`${tag} OK [CAPABILITY IMAP4rev1 IDLE MOVE] Logged in\r\n`)
      } else if (/^p/.test(line)) send('A3 OK [CAPABILITY IMAP4rev1 IDLE MOVE] Logged in\r\n')
      else if (cmd === 'EXAMINE') send(`* 5 EXISTS\r\n* OK [UIDVALIDITY 9] ok\r\n${tag} OK [READ-ONLY] done\r\n`)
    })
    const c = await ImapClient.connect(bridge, { host: 'imap.example.com', port: 143, security: 'starttls' })
    expect(server.state.tls).toBe(true)
    expect(c.has('IDLE')).toBe(true)
    await c.login('user', 'pässwörd')
    expect(server.state.sent.some((s) => s.startsWith('A3 LOGIN user {'))).toBe(true)
    expect(c.has('MOVE')).toBe(true)
    const r = await c.run(['EXAMINE INBOX'])
    expect(r.untagged.find((u) => u.type === 'EXISTS')?.num).toBe(5)
    expect(r.done.code?.name).toBe('READ-ONLY')
  })

  it('reports a refused login as an authentication error', async () => {
    server = fakeServer(
      (line, send) => {
        const [tag, cmd] = line.split(' ')
        if (cmd === 'LOGIN') send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
      },
      '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n',
    )
    const c = await ImapClient.connect(bridge, { host: 'imap.example.com', port: 993, security: 'tls' })
    const err = await c.login('user', 'wrong').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailServerError)
    expect((err as InstanceType<typeof MailServerError>).kind).toBe('auth')
  })

  it('queues commands and delivers unsolicited responses', async () => {
    const order: string[] = []
    server = fakeServer(
      (line, send) => {
        const [tag, cmd] = line.split(' ')
        order.push(cmd)
        send(`${tag} OK ${cmd}\r\n`)
      },
      '* OK [CAPABILITY IMAP4rev1] ready\r\n',
    )
    const c = await ImapClient.connect(bridge, { host: 'imap.example.com', port: 993, security: 'tls' })
    const seen: number[] = []
    c.onUntagged = (r) => r.num !== undefined && seen.push(r.num)
    const [a, b] = await Promise.all([c.run(['NOOP']), c.run(['CHECK'])])
    expect(order).toEqual(['NOOP', 'CHECK'])
    expect([a.done.text, b.done.text]).toEqual(['NOOP', 'CHECK'])
    server.conn.onData(new TextEncoder().encode('* 9 EXISTS\r\n'))
    expect(seen).toEqual([9])
  })
})
