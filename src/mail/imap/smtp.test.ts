import { describe, expect, it } from 'vitest'
import { SmtpReader } from './smtp'

describe('SMTP replies', () => {
  it('joins multi-line replies and waits for the last line', () => {
    const r = new SmtpReader()
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(r.push(enc('220 smtp.example.com ESMTP\r\n250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n'))).toEqual([
      { code: 220, lines: ['smtp.example.com ESMTP'] },
    ])
    expect(r.push(enc('250 STARTTLS\r'))).toEqual([])
    expect(r.push(enc('\n'))).toEqual([{ code: 250, lines: ['smtp.example.com', 'AUTH PLAIN LOGIN', 'STARTTLS'] }])
  })
})
