import { describe, expect, it } from 'vitest'
import { parseMessage } from './message'

const raw = (s: string) => new TextEncoder().encode(s.replace(/\n/g, '\r\n'))

describe('whole IMAP messages', () => {
  it('reads the HTML body, addresses, attachments and inline images', async () => {
    const p = await parseMessage(
      raw(`From: Anna <anna@example.com>
To: me@example.com
Cc: "Rossi, Mario" <mario@example.com>
Reply-To: office@example.com
Subject: Offer
Message-ID: <offer@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: multipart/related; boundary="r"

--r
Content-Type: text/html; charset=utf-8

<p>Hello <img src="cid:logo@x"></p>
--r
Content-Type: image/png; name="logo.png"
Content-ID: <logo@x>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--r--
--m
Content-Type: application/pdf; name="offer.pdf"
Content-Disposition: attachment; filename="offer.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--m--
`),
    )
    expect(p.bodyIsHtml).toBe(true)
    expect(p.bodyHtml).toContain('Hello')
    expect(p.cc).toEqual([{ name: 'Rossi, Mario', email: 'mario@example.com' }])
    expect(p.replyTo).toEqual([{ name: '', email: 'office@example.com' }])
    expect(p.attachments.map((a) => [a.meta.name, a.meta.contentType, a.meta.isInline, a.contentId])).toEqual([
      ['logo.png', 'image/png', true, 'logo@x'],
      ['offer.pdf', 'application/pdf', false, undefined],
    ])
    expect(p.headers.get('message-id')).toBe('<offer@example.com>')
  })

  it('escapes plain-text bodies and keeps forwarded messages as attachments', async () => {
    const p = await parseMessage(
      raw(`From: a@example.com
Subject: POSTA CERTIFICATA: Test
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b"

--b
Content-Type: text/plain; charset=utf-8

Messaggio <certificato>
--b
Content-Type: message/rfc822; name="postacert.eml"
Content-Disposition: inline; filename="postacert.eml"

From: b@example.com
Subject: Original

Body
--b--
`),
    )
    expect(p.bodyIsHtml).toBe(false)
    expect(p.bodyHtml).toContain('Messaggio &lt;certificato&gt;')
    expect(p.snippet).toBe('Messaggio <certificato>')
    expect(p.attachments.map((a) => [a.meta.name, a.meta.contentType])).toEqual([['postacert.eml', 'message/rfc822']])
  })
})
