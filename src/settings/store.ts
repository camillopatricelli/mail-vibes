import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { LanguagePref } from '../i18n'
import { microsoftTenants, type MicrosoftTenantConfig } from '../config'
import i18n from '../i18n'

/**
 * Settings are the ONLY app data persisted on the device (plus the auth libraries' token caches).
 * Never put message, event, task or contact content in here.
 */

export type Provider = 'google' | 'microsoft' | 'imap'

export type MailSecurity = 'tls' | 'starttls'

/** An IMAP or SMTP server, as entered by the user (never the password). */
export interface MailServerSettings {
  host: string
  port: number
  security: MailSecurity
  username: string
}

/** Special folders an IMAP account can have, chosen by the server (SPECIAL-USE), by name, or by hand */
export type SpecialFolder = 'sent' | 'drafts' | 'trash' | 'spam' | 'archive'
export const specialFolders: SpecialFolder[] = ['sent', 'drafts', 'trash', 'spam', 'archive']

/** Settings of an IMAP account (mail only; no calendar, tasks or contacts). */
export interface ImapSettings {
  incoming: MailServerSettings
  /** Absent: the account can't send (receive-only, e.g. a PEC mailbox read in the app) */
  outgoing?: MailServerSettings & { samePassword: boolean }
  /** Italian certified email: original message shown from the envelope, receipts grouped */
  pec: boolean
  /** Special folders chosen by hand (mailbox path), overriding detection */
  folders?: Partial<Record<SpecialFolder, string>>
  /** Mail rules, run by the app on new Inbox mail (IMAP servers have no rules of their own) */
  rules?: ImapRule[]
}

export type ImapRuleMove = { kind: 'none' } | { kind: 'archive' } | { kind: 'folder'; id: string } | { kind: 'delete' }

/** Same fields as the rule editor's RuleSpec: sender (or part of it), words, actions. */
export interface ImapRule {
  id: string
  from: string
  words: string
  markRead: boolean
  move: ImapRuleMove
}
export type Section = 'today' | 'mail' | 'calendar' | 'tasks'
export type ThemePref = 'system' | 'light' | 'dark'
/** When opened mail is marked as read: never automatically, on open, or after a few seconds */
export type MarkReadPref = 'never' | 'open' | 'delay'
export type WeekStartPref = 'monday' | 'sunday' | 'auto'

export interface AccountSettings {
  /** Stable id: `${provider}:${providerAccountId}` */
  id: string
  provider: Provider
  email: string
  /** The account holder's name (Gmail sends mail with it) */
  displayName: string
  /** Short name shown in the app (account chips, badges, menus); falls back to displayName */
  label?: string
  color: string
  /** Microsoft only: key of the organisation (built-in in src/config.ts, or user-added) */
  tenantKey?: string
  /** IMAP only: server settings */
  imap?: ImapSettings
  /** Shown in merged views (filter chips) */
  visible: boolean
}

export interface Defaults {
  sendAccountId?: string
  taskAccountId?: string
  meetingAccountId?: string
  /** Account whose main calendar receives new events */
  calendarAccountId?: string
  notesAccountId?: string
  contactsAccountId?: string
}

export interface Settings {
  language: LanguagePref
  theme: ThemePref
  seedColor: string
  homePage: Section
  pollIntervalSec: number
  markRead: MarkReadPref
  accounts: AccountSettings[]
  defaults: Defaults
  /** Senders whose remote images are always shown */
  imagesAllowedFrom: string[]
  /** Microsoft 365 organisations added by the user (in addition to the built-in ones) */
  customTenants: MicrosoftTenantConfig[]
  /** User-chosen display names for organisations, by key (overrides the built-in name) */
  tenantNames: Record<string, string>
  /** Calendars hidden from the merged calendar, as "accountId|calendarId" */
  hiddenCalendars: string[]
  /** Task lists hidden from the merged task view, as "accountId|listId" */
  hiddenTaskLists: string[]
  /** Timestamp the "notifications only while open" reminder was last dismissed */
  notifyReminderDismissedAt?: number
  /** Notify about new mail in the inbox (while the app is open) */
  notifyMail: boolean
  /** Show the reminders of events and tasks (while the app is open) */
  notifyEvents: boolean
  /** First day of the week in the calendar */
  weekStart: WeekStartPref
  /** The user's own Google Maps key, for place suggestions in event locations */
  mapsApiKey?: string
  /** The user's own IMAP bridge (docs/imap-bridge.md), needed only for IMAP accounts */
  bridge?: { url: string; key: string }
  /** Include the bridge address and access key in the settings export file */
  exportBridge: boolean
}

/** Calendar, tasks and contacts exist only for Google and Microsoft 365 accounts (not IMAP). */
export const hasPim = (accountId: string) => accountId.startsWith('google:') || accountId.startsWith('microsoft:')

/** How an account is named in the app: its short name, else the holder's name, else the address. */
export const accountLabel = (a: Pick<AccountSettings, 'label' | 'displayName' | 'email'>) => a.label || a.displayName || a.email

/** The account name followed by its address, e.g. "Work (me@example.com)". */
export function accountLongLabel(a: Pick<AccountSettings, 'label' | 'displayName' | 'email'>) {
  const name = accountLabel(a)
  return name === a.email ? a.email : `${name} (${a.email})`
}

export const SETTINGS_FORMAT = 'mail-vibes-settings'
export const SETTINGS_VERSION = 1

export const accountPalette = [
  '#1a73e8', // blue
  '#d93025', // red
  '#188038', // green
  '#e37400', // orange
  '#9334e6', // purple
  '#007b83', // teal
  '#c5221f', // dark red
  '#b06000', // amber
  '#3f51b5', // indigo
  '#e52592', // pink
]

export const pollIntervalOptions = [30, 60, 120, 300, 600]

export const defaultSettings: Settings = {
  language: 'auto',
  theme: 'system',
  seedColor: '#3b5ba9',
  homePage: 'today',
  pollIntervalSec: 60,
  markRead: 'never',
  accounts: [],
  defaults: {},
  imagesAllowedFrom: [],
  customTenants: [],
  tenantNames: {},
  hiddenCalendars: [],
  hiddenTaskLists: [],
  notifyMail: true,
  notifyEvents: true,
  weekStart: 'monday',
  exportBridge: false,
}

interface SettingsActions {
  update: (patch: Partial<Settings>) => void
  setDefaults: (patch: Partial<Defaults>) => void
  upsertAccount: (account: Omit<AccountSettings, 'color' | 'visible'> & Partial<AccountSettings>) => void
  updateAccount: (id: string, patch: Partial<AccountSettings>) => void
  removeAccount: (id: string) => void
  addTenant: (t: Omit<MicrosoftTenantConfig, 'key'>) => void
  renameTenant: (key: string, name: string) => void
  removeTenant: (key: string) => void
  replaceAll: (settings: Settings) => void
  reset: () => void
}

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      update: (patch) => set(patch),
      setDefaults: (patch) => set({ defaults: { ...get().defaults, ...patch } }),
      upsertAccount: (account) => {
        const accounts = get().accounts
        const existing = accounts.find((a) => a.id === account.id)
        if (existing) {
          set({ accounts: accounts.map((a) => (a.id === account.id ? { ...a, ...account } : a)) })
          return
        }
        const used = new Set(accounts.map((a) => a.color))
        const color = account.color ?? accountPalette.find((c) => !used.has(c)) ?? accountPalette[accounts.length % accountPalette.length]
        set({ accounts: [...accounts, { visible: true, ...account, color }] })
      },
      updateAccount: (id, patch) =>
        set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      removeAccount: (id) => {
        const defaults = { ...get().defaults }
        for (const k of Object.keys(defaults) as (keyof Defaults)[]) if (defaults[k] === id) delete defaults[k]
        set({
          accounts: get().accounts.filter((a) => a.id !== id),
          defaults,
          hiddenCalendars: get().hiddenCalendars.filter((k) => !k.startsWith(`${id}|`)),
          hiddenTaskLists: get().hiddenTaskLists.filter((k) => !k.startsWith(`${id}|`)),
        })
      },
      addTenant: (t) =>
        set({ customTenants: [...get().customTenants, { ...t, key: `custom-${crypto.randomUUID()}` }] }),
      renameTenant: (key, name) => {
        const tenantNames = { ...get().tenantNames }
        const builtIn = microsoftTenants.find((x) => x.key === key)
        if (!name.trim() || name.trim() === builtIn?.name) delete tenantNames[key]
        else tenantNames[key] = name.trim()
        set({ tenantNames })
      },
      removeTenant: (key) => {
        const tenantNames = { ...get().tenantNames }
        delete tenantNames[key]
        set({ customTenants: get().customTenants.filter((x) => x.key !== key), tenantNames })
      },
      replaceAll: (settings) => set(settings),
      reset: () => set(defaultSettings),
    }),
    {
      name: 'mail-vibes.settings',
      version: SETTINGS_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => pickSettings(s),
    },
  ),
)

export function pickSettings(s: Settings): Settings {
  return {
    language: s.language,
    theme: s.theme,
    seedColor: s.seedColor,
    homePage: s.homePage,
    pollIntervalSec: s.pollIntervalSec,
    markRead: s.markRead,
    accounts: s.accounts,
    defaults: s.defaults,
    imagesAllowedFrom: s.imagesAllowedFrom,
    customTenants: s.customTenants,
    tenantNames: s.tenantNames,
    hiddenCalendars: s.hiddenCalendars ?? [],
    hiddenTaskLists: s.hiddenTaskLists ?? [],
    notifyReminderDismissedAt: s.notifyReminderDismissedAt,
    notifyMail: s.notifyMail ?? true,
    notifyEvents: s.notifyEvents ?? true,
    weekStart: s.weekStart ?? 'monday',
    mapsApiKey: s.mapsApiKey || undefined,
    bridge: s.bridge?.url ? { url: s.bridge.url, key: s.bridge.key ?? '' } : undefined,
    exportBridge: s.exportBridge ?? false,
  }
}

// ---------- Export / import ----------

/** Never includes passwords; the bridge only if the user opted in. */
export function exportSettingsJson(s: Settings): string {
  const settings = pickSettings(s)
  if (!settings.exportBridge) delete settings.bridge
  // Only the known server fields leave the device: never anything password-like.
  settings.accounts = settings.accounts.map((a) => (a.imap ? { ...a, imap: parseImapSettings(a.imap) } : a))
  return JSON.stringify(
    { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, exportedAt: new Date().toISOString(), settings },
    null,
    2,
  )
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isHex = (v: unknown): v is string => isStr(v) && /^#[0-9a-f]{6}$/i.test(v)

/** Parses and validates an exported settings file. Throws an Error with a short reason. */
export function parseSettingsJson(text: string): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(i18n.t('errors.importJson'))
  }
  const r = raw as { format?: unknown; version?: unknown; settings?: unknown }
  if (!r || r.format !== SETTINGS_FORMAT) throw new Error(i18n.t('errors.importFormat'))
  if (r.version !== SETTINGS_VERSION) throw new Error(i18n.t('errors.importVersion', { version: String(r.version) }))
  const s = r.settings as Partial<Settings> | undefined
  if (!s || typeof s !== 'object') throw new Error(i18n.t('errors.importFormat'))

  const out: Settings = { ...defaultSettings, accounts: [], defaults: {}, imagesAllowedFrom: [], customTenants: [], tenantNames: {}, hiddenCalendars: [], hiddenTaskLists: [] }
  if (s.language === 'auto' || s.language === 'en' || s.language === 'it') out.language = s.language
  if (s.theme === 'system' || s.theme === 'light' || s.theme === 'dark') out.theme = s.theme
  if (isHex(s.seedColor)) out.seedColor = s.seedColor
  if (s.homePage && ['today', 'mail', 'calendar', 'tasks'].includes(s.homePage)) out.homePage = s.homePage
  if (typeof s.pollIntervalSec === 'number' && s.pollIntervalSec >= 15 && s.pollIntervalSec <= 3600)
    out.pollIntervalSec = Math.round(s.pollIntervalSec)

  if (s.markRead === 'never' || s.markRead === 'open' || s.markRead === 'delay') out.markRead = s.markRead
  if (typeof s.notifyMail === 'boolean') out.notifyMail = s.notifyMail
  if (typeof s.notifyEvents === 'boolean') out.notifyEvents = s.notifyEvents
  if (s.weekStart === 'monday' || s.weekStart === 'sunday' || s.weekStart === 'auto') out.weekStart = s.weekStart
  if (isStr(s.mapsApiKey) && /^[\w-]{20,60}$/.test(s.mapsApiKey.trim())) out.mapsApiKey = s.mapsApiKey.trim()
  if (s.bridge && isStr(s.bridge.url) && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s.bridge.url) && isStr(s.bridge.key)) {
    out.bridge = { url: s.bridge.url, key: s.bridge.key }
    out.exportBridge = true
  }

  if (Array.isArray(s.accounts)) {
    out.accounts = s.accounts
      .filter(
        (a): a is AccountSettings =>
          !!a &&
          isStr(a.id) &&
          (a.provider === 'google' || a.provider === 'microsoft' || (a.provider === 'imap' && !!parseImapSettings(a.imap))) &&
          isStr(a.email) &&
          isHex(a.color),
      )
      .map((a) => ({
        ...(a.provider === 'imap' ? { imap: parseImapSettings(a.imap) } : {}),
        id: a.id,
        provider: a.provider,
        email: a.email,
        displayName: isStr(a.displayName) ? a.displayName : a.email,
        label: isStr(a.label) && a.label.trim() ? a.label.trim() : undefined,
        color: a.color,
        tenantKey: isStr(a.tenantKey) ? a.tenantKey : undefined,
        visible: a.visible !== false,
      }))
  }
  const ids = new Set(out.accounts.map((a) => a.id))
  if (s.defaults && typeof s.defaults === 'object') {
    for (const k of ['sendAccountId', 'taskAccountId', 'meetingAccountId', 'calendarAccountId', 'notesAccountId', 'contactsAccountId'] as const) {
      const v = s.defaults[k]
      if (isStr(v) && ids.has(v)) out.defaults[k] = v
    }
  }
  if (Array.isArray(s.hiddenCalendars)) out.hiddenCalendars = s.hiddenCalendars.filter((k) => isStr(k) && ids.has(k.split('|')[0]))
  if (Array.isArray(s.hiddenTaskLists)) out.hiddenTaskLists = s.hiddenTaskLists.filter((k) => isStr(k) && ids.has(k.split('|')[0]))
  if (Array.isArray(s.imagesAllowedFrom)) out.imagesAllowedFrom = s.imagesAllowedFrom.filter(isStr)
  if (Array.isArray(s.customTenants)) {
    out.customTenants = s.customTenants
      .filter((x) => !!x && isStr(x.key) && x.key.startsWith('custom-') && isStr(x.name) && isGuid(x.clientId) && isTenantId(x.tenantId))
      .map((x) => ({ key: x.key, name: x.name.trim(), clientId: x.clientId, tenantId: x.tenantId }))
  }
  if (s.tenantNames && typeof s.tenantNames === 'object') {
    for (const [k, v] of Object.entries(s.tenantNames)) if (isStr(v) && v.trim()) out.tenantNames[k] = v.trim()
  }
  return out
}

// ---------- IMAP accounts ----------

const isHost = (v: unknown): v is string => isStr(v) && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)

function parseServer(v: unknown): MailServerSettings | undefined {
  const s = v as Partial<MailServerSettings> | undefined
  if (!s || !isHost(s.host) || typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return undefined
  if (s.security !== 'tls' && s.security !== 'starttls') return undefined
  if (!isStr(s.username) || !s.username.trim()) return undefined
  return { host: s.host.toLowerCase(), port: s.port, security: s.security, username: s.username.trim() }
}

/** Validates the IMAP settings of an imported account (passwords are never in the file). */
export function parseImapSettings(v: unknown): ImapSettings | undefined {
  const s = v as Partial<ImapSettings> | undefined
  const incoming = parseServer(s?.incoming)
  if (!s || !incoming) return undefined
  const out: ImapSettings = { incoming, pec: s.pec === true }
  const outgoing = parseServer(s.outgoing)
  if (outgoing) out.outgoing = { ...outgoing, samePassword: s.outgoing?.samePassword !== false }
  if (s.folders && typeof s.folders === 'object') {
    const folders: Partial<Record<SpecialFolder, string>> = {}
    for (const k of specialFolders) {
      const f = (s.folders as Record<string, unknown>)[k]
      if (isStr(f) && f) folders[k] = f
    }
    if (Object.keys(folders).length) out.folders = folders
  }
  if (Array.isArray(s.rules)) {
    const rules = s.rules.map(parseImapRule).filter((r): r is ImapRule => !!r)
    if (rules.length) out.rules = rules
  }
  return out
}

function parseImapRule(v: unknown): ImapRule | undefined {
  const r = v as Partial<ImapRule> | undefined
  if (!r || !isStr(r.id) || !isStr(r.from) || !isStr(r.words) || (!r.from.trim() && !r.words.trim())) return undefined
  const m = r.move as Partial<{ kind: string; id: unknown }> | undefined
  let move: ImapRuleMove
  if (m?.kind === 'none' || m?.kind === 'archive' || m?.kind === 'delete') move = { kind: m.kind }
  else if (m?.kind === 'folder' && isStr(m.id) && m.id) move = { kind: 'folder', id: m.id }
  else return undefined
  const markRead = r.markRead === true
  if (!markRead && move.kind === 'none') return undefined
  return { id: r.id, from: r.from, words: r.words, markRead, move }
}

// ---------- Microsoft 365 organisations ----------

export const isGuid = (v: unknown): v is string =>
  isStr(v) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())

/** A directory (tenant) ID, a verified domain, or one of Entra's multi-tenant endpoints. */
export function isTenantId(v: unknown): v is string {
  if (!isStr(v)) return false
  const x = v.trim()
  return isGuid(x) || ['common', 'organizations', 'consumers'].includes(x) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x)
}

export interface Tenant extends MicrosoftTenantConfig {
  builtIn: boolean
}

/** Built-in organisations (src/config.ts) plus user-added ones, with user-chosen names applied. */
export function selectTenants(s: Pick<Settings, 'customTenants' | 'tenantNames'>): Tenant[] {
  return [
    ...microsoftTenants.map((t) => ({ ...t, builtIn: true })),
    ...s.customTenants.map((t) => ({ ...t, builtIn: false })),
  ].map((t) => ({ ...t, name: s.tenantNames[t.key] ?? t.name }))
}
