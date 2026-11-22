import { describe, expect, it } from 'vitest'
import { hasAttachments, parseInternalDate, parseSummary, threadRoot } from './envelope'
import { folderId, folderPath, messageId, parseMessageId, parseThreadId, threadIdOf } from './ids'
import { fetchAttributes, parseResponse, type ImapValue } from './parse'

const enc = (s: string) => new TextEncoder().encode(s)
const fetchOf = (s: string) => fetchAttributes(parseResponse(enc(s)))
const bs = (s: string) => fetchOf(`* 1 FETCH (BODYSTRUCTURE ${s})\r\n`).get('BODYSTRUCTURE') as ImapValue

describe('IMAP message summaries', () => {
  it('parses INTERNALDATE with its time zone', () => {
    expect(parseInternalDate('17-Jul-1996 02:44:25 -0700')).toBe(Date.UTC(1996, 6, 17, 9, 44, 25))
    expect(parseInternalDate(' 1-Feb-2026 10:00:00 +0100')).toBe(Date.UTC(2026, 1, 1, 9, 0, 0))
    expect(parseInternalDate('nonsense')).toBe(0)
  })

  it('reads envelope, flags, references and encoded words', () => {
    const refs = 'References: <root@example.com>\r\n <mid@example.com>\r\n\r\n'
    const s = parseSummary(
      fetchOf(
        '* 3 FETCH (UID 42 FLAGS (\\Seen \\Flagged) INTERNALDATE "22-Nov-2026 10:15:00 +0100" RFC822.SIZE 2048 ' +
          'ENVELOPE ("Sun, 22 Nov 2026 10:14:58 +0100" "=?UTF-8?B?UHJldmVudGl2bw==?= =?UTF-8?Q?_=C3=A8_pronto?=" ' +
          '(("=?ISO-8859-1?Q?Rossi=2C_Mario?=" NIL "mario" "example.com")) NIL NIL ' +
          '((NIL NIL "anna" "example.org")(NIL NIL "team" NIL)(NIL NIL "bob" "example.org")(NIL NIL NIL NIL)) NIL NIL ' +
          '"<mid@example.com>" "<new@example.com>") ' +
          `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1 NIL NIL NIL) BODY[HEADER.FIELDS (REFERENCES)] {${refs.length}}\r\n${refs})\r\n`,
      ),
    )
    expect(s).toMatchObject({
      uid: 42,
      flags: ['\\Seen', '\\Flagged'],
      date: Date.UTC(2026, 10, 22, 9, 15, 0),
      size: 2048,
      subject: 'Preventivo è pronto',
      from: { name: 'Rossi, Mario', email: 'mario@example.com' },
      to: [
        { name: '', email: 'anna@example.org' },
        { name: '', email: 'bob@example.org' },
      ],
      messageId: '<new@example.com>',
      inReplyTo: '<mid@example.com>',
      references: ['<root@example.com>', '<mid@example.com>'],
      hasAttachments: false,
    })
    expect(threadRoot(s)).toBe('<root@example.com>')
    expect(threadRoot({ references: [], inReplyTo: '<p@x>', messageId: '<m@x>' })).toBe('<p@x>')
    expect(threadRoot({ references: [], messageId: '<m@x>' })).toBe('<m@x>')
  })

  it('tells real attachments from inline images', () => {
    expect(hasAttachments(bs('("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1 NIL NIL NIL)'))).toBe(false)
    const mixed =
      '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 300 10 NIL NIL NIL)' +
      '("APPLICATION" "PDF" ("NAME" "offer.pdf") NIL NIL "BASE64" 5000 NIL ("ATTACHMENT" ("FILENAME" "offer.pdf")) NIL) "MIXED" ("BOUNDARY" "b") NIL NIL)'
    expect(hasAttachments(bs(mixed))).toBe(true)
    const related =
      '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "a") NIL NIL)' +
      '("IMAGE" "PNG" ("NAME" "logo.png") "<logo@x>" NIL "BASE64" 900 NIL ("INLINE" ("FILENAME" "logo.png")) NIL) "RELATED" ("BOUNDARY" "r") NIL NIL)'
    expect(hasAttachments(bs(related))).toBe(false)
    // A PEC envelope: text, the original message, and the certification data
    const pec =
      '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "a") NIL NIL)' +
      '("APPLICATION" "XML" ("NAME" "daticert.xml") NIL NIL "BASE64" 900 NIL ("INLINE" ("FILENAME" "daticert.xml")) NIL)' +
      '("MESSAGE" "RFC822" ("NAME" "postacert.eml") NIL NIL "7BIT" 5000 NIL NIL 100 NIL ("INLINE" ("FILENAME" "postacert.eml")) NIL) "MIXED" ("BOUNDARY" "m") NIL NIL)'
    expect(hasAttachments(bs(pec))).toBe(true)
  })
})

describe('IMAP ids', () => {
  it('round-trips folder, message and thread ids, URL-safe', () => {
    const path = 'INBOX.Clienti/2026 &AOg-'
    expect(folderPath(folderId(path))).toBe(path)
    const id = messageId({ path, uidValidity: 1700000000, uid: 77 })
    expect(id).toMatch(/^[A-Za-z0-9_.-]+$/)
    expect(parseMessageId(id)).toEqual({ path, uidValidity: 1700000000, uid: 77 })
    const th = threadIdOf('<a+b/c@example.com>', id)
    expect(th).toMatch(/^m[A-Za-z0-9_-]+$/)
    expect(parseThreadId(th)).toEqual({ root: '<a+b/c@example.com>' })
    expect(parseThreadId(threadIdOf(undefined, id))).toEqual({ message: id })
  })
})
