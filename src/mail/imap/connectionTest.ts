import { openConnection, type BridgeConfig } from './bridge'
import { ImapClient, type ServerConfig } from './client'
import { asList, asText, fetchAttributes } from './parse'
import { SmtpClient } from './smtp'

/** Features the app relies on, reported by the connection test. */
export const IMAP_FEATURES = ['IDLE', 'MOVE', 'UIDPLUS', 'SPECIAL-USE', 'CONDSTORE', 'QUOTA', 'ESEARCH', 'LITERAL+', 'UTF8=ACCEPT'] as const

export interface ImapTestReport {
  capabilities: string[]
  /** Messages in the Inbox */
  inboxCount: number
  /** Largest of the latest messages, downloaded to check the bridge copes with big messages */
  download?: { bytes: number; ms: number }
  /** Whether custom keywords (tags) can be stored: PERMANENTFLAGS contains \* */
  keywords?: boolean
}

/**
 * Logs in and reads (never changes) the Inbox: EXAMINE opens it read-only, and BODY.PEEK fetches
 * a message without marking it as read. Safe on PEC mailboxes.
 */
export async function testImap(bridge: BridgeConfig, server: ServerConfig, password: string, download = true): Promise<ImapTestReport> {
  const c = await ImapClient.connect(bridge, server)
  try {
    await c.login(server.username, password)
    const ex = await c.run(['EXAMINE INBOX'])
    const exists = ex.untagged.find((r) => r.type === 'EXISTS')?.num ?? 0
    // PERMANENTFLAGS on EXAMINE is often empty (read-only); SELECT would tell, but changes \Recent.
    const perm = ex.untagged.find((r) => r.code?.name === 'PERMANENTFLAGS')
    const report: ImapTestReport = {
      capabilities: [...c.capabilities].sort(),
      inboxCount: exists,
      keywords: perm ? asList(perm.code!.args[0]).some((v) => asText(v) === '\\*') : undefined,
    }
    if (download && exists > 0) {
      const from = Math.max(1, exists - 19)
      const sizes = await c.run([`FETCH ${from}:${exists} (UID RFC822.SIZE)`])
      let best = { uid: '', size: -1 }
      for (const r of sizes.untagged) {
        if (r.type !== 'FETCH') continue
        const a = fetchAttributes(r)
        const size = Number(asText(a.get('RFC822.SIZE')))
        if (size > best.size) best = { uid: asText(a.get('UID')), size }
      }
      if (best.uid) {
        const t0 = performance.now()
        const body = await c.run([`UID FETCH ${best.uid} (BODY.PEEK[])`], 300_000)
        const ms = Math.round(performance.now() - t0)
        const got = body.untagged.find((r) => r.type === 'FETCH')
        const bytes = got ? fetchAttributes(got).get('BODY[]') : undefined
        report.download = { bytes: bytes instanceof Uint8Array ? bytes.length : 0, ms }
      }
    }
    return report
  } finally {
    await c.logout()
  }
}

export interface SmtpTestReport {
  extensions: string[]
  authMethods: string[]
}

/** Logs in to the outgoing server and leaves without sending anything. */
export async function testSmtp(bridge: BridgeConfig, server: ServerConfig, password: string): Promise<SmtpTestReport> {
  const c = await SmtpClient.connect(bridge, server)
  try {
    await c.login(server.username, password)
    return { extensions: [...c.extensions].sort(), authMethods: [...c.authMethods].sort() }
  } finally {
    await c.quit()
  }
}

/** Whether the host answers ManageSieve (port 4190): server-side mail rules. */
export async function hasManageSieve(bridge: BridgeConfig, host: string): Promise<boolean> {
  try {
    const conn = await openConnection(bridge, host, 4190, 'starttls', 8_000)
    return await new Promise<boolean>((resolve) => {
      let text = ''
      const timer = setTimeout(() => done(false), 8_000)
      const done = (ok: boolean) => {
        clearTimeout(timer)
        conn.close()
        resolve(ok)
      }
      conn.onData = (b) => {
        text += new TextDecoder().decode(b)
        if (/^OK/m.test(text)) done(/"SIEVE"/i.test(text) || /"IMPLEMENTATION"/i.test(text))
      }
      conn.onClose = () => done(false)
    })
  } catch {
    return false
  }
}
