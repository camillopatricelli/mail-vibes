import { describe, expect, it } from 'vitest'
import { decodeBase64Url, decodeText, encodeWord, formatMimeAddress, parseAddressHeader, rfc5322Date } from './mime'

describe('mime helpers', () => {
  it('leaves ASCII alone and encodes other text as UTF-8 words', () => {
    expect(encodeWord('Hello')).toBe('Hello')
    const enc = encodeWord('Perché è così — ünïcødé '.repeat(4))
    for (const word of enc.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
      expect(word.length).toBeLessThanOrEqual(75)
    }
    const decoded = enc
      .split('\r\n ')
      .map((w) => decodeText(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))))
      .join('')
    expect(decoded).toBe('Perché è così — ünïcødé '.repeat(4))
  })

  it('formats and parses addresses', () => {
    expect(formatMimeAddress({ name: 'Rossi, Mario', email: 'm@x.it' })).toBe('"Rossi, Mario" <m@x.it>')
    expect(formatMimeAddress({ name: '', email: 'm@x.it' })).toBe('m@x.it')
    expect(parseAddressHeader('"Rossi, Mario" <m@x.it>, Anna <a@y.com>, plain@z.org')).toEqual([
      { name: 'Rossi, Mario', email: 'm@x.it' },
      { name: 'Anna', email: 'a@y.com' },
      { name: '', email: 'plain@z.org' },
    ])
  })

  it('decodes base64url data', () => {
    const b64url = btoa('ciao è').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeText(decodeBase64Url(b64url), 'latin1')).toBe('ciao è')
  })
})

describe('message dates', () => {
  it('formats RFC 5322 dates with the local time zone', () => {
    const s = rfc5322Date(new Date(2026, 10, 22, 9, 5, 7))
    expect(s).toMatch(/^Sun, 22 Nov 2026 09:05:07 [+-]\d{4}$/)
  })
})
