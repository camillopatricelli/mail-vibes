import { describe, expect, it } from 'vitest'
import {
  asText,
  capabilitiesOf,
  decodeMailboxName,
  encodeMailboxName,
  encodeString,
  fetchAttributes,
  parseResponse,
  ResponseSplitter,
} from './parse'

const enc = (s: string) => new TextEncoder().encode(s)
const parse = (s: string) => parseResponse(enc(s))

describe('IMAP response splitting', () => {
  it('splits lines and keeps literals whole, across chunks', () => {
    const sp = new ResponseSplitter()
    const body = 'Subject: hi\r\n\r\nline {3}\r\n'
    const stream = `* 1 EXISTS\r\n* 1 FETCH (UID 7 BODY[] {${body.length}}\r\n${body} FLAGS (\\Seen))\r\nA1 OK done\r\n`
    const out: string[] = []
    for (let i = 0; i < stream.length; i += 5) for (const r of sp.push(enc(stream.slice(i, i + 5)))) out.push(new TextDecoder().decode(r))
    expect(out).toHaveLength(3)
    expect(out[1]).toContain('line {3}')
    expect(out[2]).toBe('A1 OK done\r\n')
  })

  it('waits for a literal that has not fully arrived', () => {
    const sp = new ResponseSplitter()
    expect(sp.push(enc('* 1 FETCH (BODY[] {10}\r\n12345'))).toHaveLength(0)
    expect(sp.push(enc('67890)\r\n'))).toHaveLength(1)
  })
})

describe('IMAP response parsing', () => {
  it('parses status responses with codes', () => {
    expect(parse('* OK [UIDVALIDITY 3857529045] UIDs valid\r\n')).toEqual({
      tag: '*',
      type: 'OK',
      code: { name: 'UIDVALIDITY', args: ['3857529045'] },
      text: 'UIDs valid',
      values: [],
    })
    const perm = parse('* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited\r\n')
    expect(perm.code).toEqual({ name: 'PERMANENTFLAGS', args: [['\\Deleted', '\\Seen', '\\*']] })
    const ro = parse('A2 OK [READ-ONLY] EXAMINE completed\r\n')
    expect(ro).toMatchObject({ tag: 'A2', type: 'OK', code: { name: 'READ-ONLY', args: [] }, text: 'EXAMINE completed' })
    expect(parse('A3 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n')).toMatchObject({ type: 'NO', code: { name: 'AUTHENTICATIONFAILED' } })
    expect(parse('+ Ready for literal\r\n')).toMatchObject({ tag: '+', type: 'CONTINUE', text: 'Ready for literal' })
  })

  it('reads capabilities from the greeting and from CAPABILITY', () => {
    expect(capabilitiesOf(parse('* OK [CAPABILITY IMAP4rev1 SASL-IR IDLE AUTH=PLAIN] Dovecot ready.\r\n'))).toEqual([
      'IMAP4REV1',
      'SASL-IR',
      'IDLE',
      'AUTH=PLAIN',
    ])
    expect(capabilitiesOf(parse('* CAPABILITY IMAP4rev1 MOVE SPECIAL-USE\r\n'))).toEqual(['IMAP4REV1', 'MOVE', 'SPECIAL-USE'])
  })

  it('parses numbered data responses', () => {
    expect(parse('* 172 EXISTS\r\n')).toMatchObject({ type: 'EXISTS', num: 172 })
    expect(parse('* 3 EXPUNGE\r\n')).toMatchObject({ type: 'EXPUNGE', num: 3 })
  })

  it('parses LIST with quoted names, NIL delimiters and flags', () => {
    expect(parse('* LIST (\\HasNoChildren \\Sent) "/" "Posta inviata"\r\n').values).toEqual([['\\HasNoChildren', '\\Sent'], '/', 'Posta inviata'])
    expect(parse('* LIST (\\Noselect) NIL ""\r\n').values).toEqual([['\\Noselect'], null, ''])
    expect(parse('* LIST () "." "Say \\"hi\\""\r\n').values[2]).toBe('Say "hi"')
  })

  it('parses FETCH with section atoms, literals and envelopes', () => {
    const header = 'From: Anna <a@example.com>\r\n\r\n'
    const r = parse(
      `* 12 FETCH (UID 4827 FLAGS (\\Seen $Label1) RFC822.SIZE 4410 BODY[HEADER.FIELDS (FROM)] {${header.length}}\r\n${header} ` +
        'ENVELOPE ("Mon, 7 Feb 1994 21:52:25 -0800" "=?UTF-8?B?Q2lhbw==?=" (("Anna" NIL "a" "example.com")) NIL NIL NIL NIL NIL NIL "<id@example.com>"))\r\n',
    )
    expect(r).toMatchObject({ type: 'FETCH', num: 12 })
    const a = fetchAttributes(r)
    expect(asText(a.get('UID'))).toBe('4827')
    expect(a.get('FLAGS')).toEqual(['\\Seen', '$Label1'])
    const lit = a.get('BODY[HEADER.FIELDS (FROM)]')
    expect(lit).toBeInstanceOf(Uint8Array)
    expect(asText(lit)).toBe(header)
    const env = a.get('ENVELOPE') as unknown[]
    expect(env[2]).toEqual([['Anna', null, 'a', 'example.com']])
    expect(env[9]).toBe('<id@example.com>')
  })

  it('keeps binary literals as bytes', () => {
    const bytes = new Uint8Array([0x2a, 0x20, 0x31, 0x20, 0x46, 0x45, 0x54, 0x43, 0x48, 0x20, 0x28, 0x42, 0x4f, 0x44, 0x59, 0x5b, 0x5d, 0x20, 0x7b, 0x33, 0x7d, 0x0d, 0x0a, 0xff, 0x00, 0xfe, 0x29, 0x0d, 0x0a])
    const v = fetchAttributes(parseResponse(bytes)).get('BODY[]')
    expect(Array.from(v as Uint8Array)).toEqual([0xff, 0x00, 0xfe])
  })
})

describe('IMAP command arguments', () => {
  it('uses atoms, quoted strings or literals as needed', () => {
    expect(encodeString('INBOX')).toBe('INBOX')
    expect(encodeString('user@example.com')).toBe('user@example.com')
    expect(encodeString('pass word"\\')).toBe('"pass word\\"\\\\"')
    expect(encodeString('')).toBe('""')
    expect(encodeString('NIL')).toBe('"NIL"')
    expect(encodeString('100%')).toBe('"100%"')
    expect(encodeString('report*')).toBe('"report*"')
    expect(encodeString('pässwörd')).toBeInstanceOf(Uint8Array)
  })

  it('round-trips modified UTF-7 mailbox names', () => {
    expect(decodeMailboxName('&AMk-l&AOk-ments envoy&AOk-s')).toBe('Éléments envoyés')
    expect(decodeMailboxName('Tom &- Jerry')).toBe('Tom & Jerry')
    for (const n of ['Posta indesiderata', 'Éléments envoyés', 'Tom & Jerry', '日本語', 'Ünïcødé/Sub']) expect(decodeMailboxName(encodeMailboxName(n))).toBe(n)
    expect(encodeMailboxName('Tom & Jerry')).toBe('Tom &- Jerry')
  })
})
