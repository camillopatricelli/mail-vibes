import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { LanguagePref } from '../i18n'
import { microsoftTenants, type MicrosoftTenantConfig } from '../config'

/**
 * Settings are the ONLY app data persisted on the device (plus the auth libraries' token caches).
 * Never put message, event, task or contact content in here.
 */

export type Provider = 'google' | 'microsoft'
export type Section = 'today' | 'mail' | 'calendar' | 'tasks'
export type ThemePref = 'system' | 'light' | 'dark'
/** When opened mail is marked as read: never automatically, on open, or after a few seconds */
export type MarkReadPref = 'never' | 'open' | 'delay'

export interface AccountSettings {
  /** Stable id: `${provider}:${providerAccountId}` */
  id: string
  provider: Provider
  email: string
  displayName: string
  color: string
  /** Microsoft only: key of the organisation (built-in in src/config.ts, or user-added) */
  tenantKey?: string
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
  /** Timestamp the "notifications only while open" reminder was last dismissed */
  notifyReminderDismissedAt?: number
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
    notifyReminderDismissedAt: s.notifyReminderDismissedAt,
  }
}

// ---------- Export / import ----------

export function exportSettingsJson(s: Settings): string {
  return JSON.stringify(
    { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, exportedAt: new Date().toISOString(), settings: pickSettings(s) },
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
    throw new Error('invalid JSON')
  }
  const r = raw as { format?: unknown; version?: unknown; settings?: unknown }
  if (!r || r.format !== SETTINGS_FORMAT) throw new Error('wrong file format')
  if (r.version !== SETTINGS_VERSION) throw new Error(`unsupported version ${String(r.version)}`)
  const s = r.settings as Partial<Settings> | undefined
  if (!s || typeof s !== 'object') throw new Error('missing settings')

  const out: Settings = { ...defaultSettings, accounts: [], defaults: {}, imagesAllowedFrom: [], customTenants: [], tenantNames: {}, hiddenCalendars: [] }
  if (s.language === 'auto' || s.language === 'en' || s.language === 'it') out.language = s.language
  if (s.theme === 'system' || s.theme === 'light' || s.theme === 'dark') out.theme = s.theme
  if (isHex(s.seedColor)) out.seedColor = s.seedColor
  if (s.homePage && ['today', 'mail', 'calendar', 'tasks'].includes(s.homePage)) out.homePage = s.homePage
  if (typeof s.pollIntervalSec === 'number' && s.pollIntervalSec >= 15 && s.pollIntervalSec <= 3600)
    out.pollIntervalSec = Math.round(s.pollIntervalSec)

  if (s.markRead === 'never' || s.markRead === 'open' || s.markRead === 'delay') out.markRead = s.markRead

  if (Array.isArray(s.accounts)) {
    out.accounts = s.accounts
      .filter(
        (a): a is AccountSettings =>
          !!a &&
          isStr(a.id) &&
          (a.provider === 'google' || a.provider === 'microsoft') &&
          isStr(a.email) &&
          isHex(a.color),
      )
      .map((a) => ({
        id: a.id,
        provider: a.provider,
        email: a.email,
        displayName: isStr(a.displayName) ? a.displayName : a.email,
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
