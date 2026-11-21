import { describe, expect, it } from 'vitest'
import { isValidEmail, parseAddresses } from './addressBook'

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
