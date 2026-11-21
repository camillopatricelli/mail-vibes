import { describe, expect, it } from 'vitest'
import { isContact, isValidEmail, parseAddresses, rememberAddresses, setContacts, suggestAddresses } from './addressBook'

describe('parseAddresses', () => {
  it('parses names, quotes and separators', () => {
    expect(parseAddresses('"Rossi, Mario" <mario@example.com>; anna@example.org, Bob <bob@x.io>')).toEqual([
      { name: 'Rossi, Mario', email: 'mario@example.com' },
      { name: '', email: 'anna@example.org' },
      { name: 'Bob', email: 'bob@x.io' },
    ])
  })
  it('validates emails', () => {
    expect(isValidEmail('a.b+c@example.co.uk')).toBe(true)
    expect(isValidEmail('nope@')).toBe(false)
    expect(isValidEmail('two words@example.com')).toBe(false)
  })
})

describe('suggestAddresses', () => {
  it('puts contacts first, then addresses seen in mail', () => {
    rememberAddresses([{ name: 'Annette Seen', email: 'annette@seen.test' }])
    setContacts('google:1', [{ name: 'Ann Contact', email: 'ann@contacts.test' }])
    expect(suggestAddresses('ann', []).map((a) => a.email)).toEqual(['ann@contacts.test', 'annette@seen.test'])
    expect(isContact('ANN@contacts.test')).toBe(true)
    setContacts('google:1', [])
    expect(isContact('ann@contacts.test')).toBe(false)
  })
})
