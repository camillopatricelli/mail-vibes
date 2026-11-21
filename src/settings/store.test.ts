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
