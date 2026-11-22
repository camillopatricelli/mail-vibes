import { AuthRequiredError } from '../../auth/errors'
import i18n from '../../i18n'
import { useSettings, type AccountSettings, type SpecialFolder } from '../../settings/store'
import { useStatus } from '../../status/store'
import { BridgeError } from './bridge'
import { ImapClient, MailServerError } from './client'
import { detectSpecial, parseList, type ListedFolder } from './folders'
import { asList, asText } from './parse'
import { forgetPassword, getPassword } from './passwords'

export interface Selected {
  path: string
  uidValidity: number
  exists: number
  /** Keywords (tags) can be stored: PERMANENTFLAGS contains \* */
  keywords: boolean
  /** Flags and keywords in use in the folder (the FLAGS response) */
  flags: string[]
}

/** What an operation gets: the logged-in client, with helpers that remember the open folder. */
export interface Ctx {
  client: ImapClient
  account: AccountSettings
  /** Opens a folder (SELECT); reuses it if already open, unless `fresh` (new message count) */
  select(path: string, fresh?: boolean): Promise<Selected>
  /** The account's folders and special folders (cached for a minute) */
  folders(refresh?: boolean): Promise<{ list: ListedFolder[]; special: Partial<Record<SpecialFolder, string>> }>
  /** After creating a folder */
  forgetFolders(): void
}

/** Thrown for features that IMAP accounts get in a later version. */
export class NotYetError extends Error {
  constructor() {
    super(i18n.t('imap.notYet'))
    this.name = 'NotYetError'
  }
}

class Session {
  private client?: ImapClient
  private connecting?: Promise<ImapClient>
  private selected?: Selected
  private folderCache?: { at: number; list: ListedFolder[]; special: Partial<Record<SpecialFolder, string>> }
  private lock: Promise<unknown> = Promise.resolve()

  constructor(readonly accountId: string) {}

  private account(): AccountSettings {
    const a = useSettings.getState().accounts.find((x) => x.id === this.accountId)
    if (!a?.imap) throw new Error('Unknown IMAP account')
    return a
  }

  private async connect(): Promise<ImapClient> {
    if (this.client) return this.client
    this.connecting ??= (async () => {
      const a = this.account()
      const bridge = useSettings.getState().bridge
      if (!bridge?.url || !bridge.key) throw new Error(i18n.t('imap.noBridge'))
      const password = await getPassword(this.accountId)
      if (password === undefined) throw new AuthRequiredError(i18n.t('imap.passwordNeeded'))
      const c = await ImapClient.connect(bridge, a.imap!.incoming)
      try {
        await c.login(a.imap!.incoming.username, password)
      } catch (e) {
        c.close()
        throw e
      }
      c.onClose = () => {
        if (this.client === c) this.drop()
      }
      this.client = c
      return c
    })().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private drop() {
    this.client?.close()
    this.client = undefined
    this.selected = undefined
  }

  close() {
    this.drop()
    this.folderCache = undefined
  }

  private ctx(client: ImapClient): Ctx {
    return {
      client,
      account: this.account(),
      select: async (path, fresh = false) => {
        if (!fresh && this.selected?.path === path) return this.selected
        const r = await client.run(['SELECT ', { str: path }])
        const perm = r.untagged.find((u) => u.code?.name === 'PERMANENTFLAGS')
        this.selected = {
          path,
          uidValidity: Number(asText(r.untagged.find((u) => u.code?.name === 'UIDVALIDITY')?.code?.args[0])) || 0,
          exists: r.untagged.filter((u) => u.type === 'EXISTS').pop()?.num ?? 0,
          keywords: !!perm && asList(perm.code!.args[0]).some((v) => asText(v) === '\\*'),
          flags: asList(r.untagged.find((u) => u.type === 'FLAGS')?.values[0]).map(asText),
        }
        return this.selected
      },
      folders: async (refresh = false) => {
        if (!refresh && this.folderCache && Date.now() - this.folderCache.at < 60_000) return this.folderCache
        const r = await client.run(['LIST "" "*"'])
        const list = parseList(r.untagged)
        this.folderCache = { at: Date.now(), list, special: detectSpecial(list, this.account().imap?.folders) }
        return this.folderCache
      },
      forgetFolders: () => {
        this.folderCache = undefined
      },
    }
  }

  /**
   * Runs an operation with the connection to itself (operations of one account never mix: each
   * may open a different folder). Reconnects once if the server or the bridge closed an idle
   * connection, and reports the account's state like the Google and Microsoft accounts do.
   */
  run<T>(op: (ctx: Ctx) => Promise<T>, quiet = false): Promise<T> {
    const go = async (): Promise<T> => {
      const status = useStatus.getState()
      for (let attempt = 0; ; attempt++) {
        try {
          const client = await this.connect()
          const out = await op(this.ctx(client))
          if (!quiet) status.reportSuccess(this.accountId)
          return out
        } catch (e) {
          const lost = (e instanceof MailServerError && (e.kind === 'closed' || e.kind === 'timeout')) || (e instanceof BridgeError && e.kind === 'closed')
          if (lost) this.drop()
          if (lost && attempt === 0) continue
          throw this.report(e, quiet)
        }
      }
    }
    const next = this.lock.then(go, go)
    this.lock = next.catch(() => undefined)
    return next
  }

  /** Turns a failure into the error shown to the user, and updates the account's banner. */
  private report(e: unknown, quiet: boolean): Error {
    const status = useStatus.getState()
    let err = e as Error
    if (e instanceof MailServerError && e.kind === 'auth') {
      // A wrong or changed password: forget it, so the next attempt asks again.
      void forgetPassword(this.accountId)
      this.drop()
      err = new AuthRequiredError(i18n.t('imap.passwordRejected', { reason: e.message }))
    } else if (e instanceof BridgeError) {
      err = new Error(e.kind === 'key' ? i18n.t('imap.errKey') : e.kind === 'refused' ? i18n.t('imap.errRefused', { reason: e.message }) : i18n.t('imap.errBridgeUnreachable'))
      if (!quiet) status.reportError(this.accountId, e.kind === 'key' || e.kind === 'refused' ? 'api' : 'network', err.message)
      return err
    } else if (e instanceof MailServerError && e.kind !== 'server') {
      this.drop()
      err = new Error(e.kind === 'timeout' ? i18n.t('imap.errTimeout') : i18n.t('imap.errClosed'))
      if (!quiet) status.reportError(this.accountId, 'network', err.message)
      return err
    }
    if (!quiet && err instanceof AuthRequiredError) status.reportError(this.accountId, 'auth', err.message)
    else if (!quiet && !(e instanceof MailServerError) && !(e instanceof NotYetError)) status.reportError(this.accountId, 'api', err.message)
    return err
  }
}

const sessions = new Map<string, Session>()

export function session(accountId: string) {
  let s = sessions.get(accountId)
  if (!s) sessions.set(accountId, (s = new Session(accountId)))
  return s
}

/** Closes an account's connection (after removing it or changing its settings). */
export function closeSession(accountId: string) {
  sessions.get(accountId)?.close()
  sessions.delete(accountId)
}
