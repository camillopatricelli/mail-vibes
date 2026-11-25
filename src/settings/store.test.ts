import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import {
  defaultSettings,
  exportSettingsJson,
  isGuid,
  isTenantId,
  parseSettingsJson,
  selectTenants,
  type Settings,
} from './store'
import { decodeOrg, encodeOrg } from '../lib/setupLink'

const sample: Settings = {
  ...defaultSettings,
  language: 'it',
  theme: 'dark',
  pollIntervalSec: 120,
  accounts: [
    { id: 'microsoft:abc', provider: 'microsoft', email: 'a@x.com', displayName: 'A', color: '#1a73e8', tenantKey: 'org1', visible: true },
    { id: 'google:def', provider: 'google', email: 'b@gmail.com', displayName: 'B', color: '#d93025', visible: false },
  ],
  defaults: { sendAccountId: 'microsoft:abc', notesAccountId: 'google:def' },
}

describe('organisations', () => {
  it('appends user-added organisations and applies user-chosen names', () => {
    const tenants = selectTenants({
      tenantNames: { 'custom-2': 'Renamed' },
      customTenants: [
        { key: 'custom-1', name: 'Other', clientId: '00000000-0000-0000-0000-000000000001', tenantId: 'common' },
        { key: 'custom-2', name: 'Second', clientId: '00000000-0000-0000-0000-000000000003', tenantId: 'organizations' },
      ],
    })
    expect(tenants.at(-2)).toMatchObject({ key: 'custom-1', name: 'Other', builtIn: false })
    expect(tenants.at(-1)).toMatchObject({ key: 'custom-2', name: 'Renamed', builtIn: false })
  })

  it('round-trips setup links and rejects tampered ones', () => {
    const org = { name: 'Società Ünïcode', clientId: '00000000-0000-0000-0000-00000000000a', tenantId: 'common' }
    expect(decodeOrg(encodeOrg(org))).toEqual(org)
    expect(decodeOrg('garbage')).toBeNull()
    expect(decodeOrg(encodeOrg({ ...org, clientId: 'not-a-guid' }))).toBeNull()
  })

  it('validates IDs', () => {
    expect(isGuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true)
    expect(isGuid('nope')).toBe(false)
    expect(isTenantId('organizations')).toBe(true)
    expect(isTenantId('contoso.onmicrosoft.com')).toBe(true)
    expect(isTenantId('contoso')).toBe(false)
  })

  it('imports valid custom organisations and drops invalid ones', () => {
    const file = JSON.parse(
      exportSettingsJson({
        ...sample,
        tenantNames: { 'custom-a': 'Renamed' },
        customTenants: [
          { key: 'custom-a', name: 'Good', clientId: '00000000-0000-0000-0000-000000000002', tenantId: 'common' },
          { key: 'custom-b', name: 'Bad', clientId: 'x', tenantId: 'common' },
        ],
      }),
    )
    const parsed = parseSettingsJson(JSON.stringify(file))
    expect(parsed.customTenants.map((x) => x.key)).toEqual(['custom-a'])
    expect(parsed.tenantNames).toEqual({ 'custom-a': 'Renamed' })
  })
})

describe('settings export/import', () => {
  it('round-trips', () => {
    expect(parseSettingsJson(exportSettingsJson(sample))).toEqual(sample)
  })

  beforeAll(() => i18n.changeLanguage('en'))

  it('rejects other files', () => {
    expect(() => parseSettingsJson('not json')).toThrow('not valid JSON')
    expect(() => parseSettingsJson('{"format":"x"}')).toThrow('not a Mail Vibes settings file')
  })

  it('drops invalid values and dangling defaults without touching the shared defaults', () => {
    const file = JSON.parse(exportSettingsJson(sample))
    file.settings.theme = 'neon'
    file.settings.pollIntervalSec = 1
    file.settings.accounts[1].color = 'red'
    const parsed = parseSettingsJson(JSON.stringify(file))
    expect(parsed.theme).toBe('system')
    expect(parsed.pollIntervalSec).toBe(60)
    expect(parsed.accounts.map((a) => a.id)).toEqual(['microsoft:abc'])
    expect(parsed.defaults).toEqual({ sendAccountId: 'microsoft:abc' })
    expect(defaultSettings.defaults).toEqual({})
  })
})

describe('IMAP bridge in the export file', () => {
  const bridge = { url: 'https://bridge.example.workers.dev', key: 'k'.repeat(32) }
  it('leaves the bridge out unless the user opted in', () => {
    expect(JSON.parse(exportSettingsJson({ ...sample, bridge })).settings.bridge).toBeUndefined()
    const file = exportSettingsJson({ ...sample, bridge, exportBridge: true })
    expect(JSON.parse(file).settings.bridge).toEqual(bridge)
    expect(parseSettingsJson(file).bridge).toEqual(bridge)
  })
  it('rejects bridge addresses that are not https', () => {
    const file = exportSettingsJson({ ...sample, bridge: { ...bridge, url: 'http://bridge.example.com' }, exportBridge: true })
    expect(parseSettingsJson(file).bridge).toBeUndefined()
  })
})

describe('IMAP accounts in the export file', () => {
  const imap = {
    id: 'imap:1',
    provider: 'imap' as const,
    email: 'me@example.com',
    displayName: 'Me',
    color: '#188038',
    visible: true,
    imap: {
      incoming: { host: 'imap.example.com', port: 993, security: 'tls' as const, username: 'user-id' },
      outgoing: { host: 'smtp.example.com', port: 465, security: 'tls' as const, username: 'user-id', samePassword: true },
      pec: true,
      folders: { sent: 'INBOX.Posta inviata' },
      rules: [{ id: 'r1', from: 'news@example.com', words: '', markRead: true, move: { kind: 'folder' as const, id: 'Zm9v' } }],
    },
  }
  it('round-trips server settings', () => {
    const back = parseSettingsJson(exportSettingsJson({ ...sample, accounts: [imap] }))
    expect(back.accounts[0]).toEqual(imap)
  })
  it('never contains a password, and drops accounts with broken settings', () => {
    const withPw = { ...imap, imap: { ...imap.imap, password: 'secret' } } as unknown as typeof imap
    const file = exportSettingsJson({ ...sample, accounts: [withPw] })
    expect(file).not.toContain('secret')
    expect(parseSettingsJson(file).accounts[0].imap).not.toHaveProperty('password')
    const broken = { ...imap, imap: { ...imap.imap, incoming: { ...imap.imap.incoming, host: 'not a host' } } }
    expect(parseSettingsJson(exportSettingsJson({ ...sample, accounts: [broken] })).accounts).toEqual([])
  })
  it('keeps only valid rules', () => {
    const rules = [
      ...imap.imap.rules,
      { id: 'r2', from: '', words: '', markRead: true, move: { kind: 'none' } },
      { id: 'r3', from: 'x', words: '', markRead: false, move: { kind: 'none' } },
      { id: 'r4', from: 'x', words: '', markRead: false, move: { kind: 'teleport' } },
    ]
    const odd = { ...imap, imap: { ...imap.imap, rules } } as unknown as typeof imap
    expect(parseSettingsJson(exportSettingsJson({ ...sample, accounts: [odd] })).accounts[0].imap?.rules).toEqual(imap.imap.rules)
  })
})

describe('signatures', () => {
  it('round-trip through export and import, with account defaults', () => {
    const s: Settings = {
      ...sample,
      signatures: [{ id: 's1', name: 'Work', html: '<b>A</b>' }],
      signatureDefaults: { 'microsoft:abc': { id: 's1', replies: true } },
    }
    const back = parseSettingsJson(exportSettingsJson(s))
    expect(back.signatures).toEqual(s.signatures)
    expect(back.signatureDefaults).toEqual(s.signatureDefaults)
  })

  it('drop defaults for unknown accounts or deleted signatures, and unnamed or huge signatures', () => {
    const s = {
      ...sample,
      signatures: [
        { id: 's1', name: ' Work ', html: 'x' },
        { id: 's2', name: '  ', html: 'y' },
        { id: 's3', name: 'Huge', html: 'z'.repeat(30_000) },
      ],
      signatureDefaults: { 'microsoft:abc': { id: 's2', replies: false }, 'google:def': { id: 's1' }, 'imap:gone@x.com': { id: 's1', replies: true } },
    } as unknown as Settings
    const back = parseSettingsJson(exportSettingsJson(s))
    expect(back.signatures).toEqual([{ id: 's1', name: 'Work', html: 'x' }])
    expect(back.signatureDefaults).toEqual({ 'google:def': { id: 's1', replies: false } })
  })
})
