import { describe, expect, it } from 'vitest'
import { dotStuff, SmtpReader } from './smtp'

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

describe('SMTP message data', () => {
  const text = (b: Uint8Array) => new TextDecoder().decode(b)
  it('doubles dots at line starts and ends with CRLF . CRLF', () => {
    expect(text(dotStuff(new TextEncoder().encode('.hidden\r\nok.\r\n..two\r\n')))).toBe('..hidden\r\nok.\r\n...two\r\n.\r\n')
    expect(text(dotStuff(new TextEncoder().encode('no newline')))).toBe('no newline\r\n.\r\n')
  })
})
