import { describe, expect, it } from 'vitest'
import { parseSummary, threadRoot } from './envelope'
import { parseMessage } from './message'
import { fetchAttributes, parseResponse } from './parse'
import { originalSender, originalSubject, parseDaticert, pecHeaders, pecView } from './pec'

const enc = (s: string) => new TextEncoder().encode(s.replace(/\r?\n/g, '\r\n'))

const daticert = `<?xml version="1.0" encoding="UTF-8"?>
<postacert tipo="posta-certificata" errore="nessuno">
  <intestazione>
    <mittente>sender@pec.example.com</mittente>
    <destinatari tipo="certificato">me@pec.example.org</destinatari>
    <destinatari tipo="esterno">other@example.net</destinatari>
    <risposte>sender@pec.example.com</risposte>
    <oggetto>Invio fattura &amp; documenti</oggetto>
  </intestazione>
  <dati>
    <gestore-emittente>Example PEC Provider</gestore-emittente>
    <data zona="+0100">
      <giorno>20/11/2026</giorno>
      <ora>16:58:28</ora>
    </data>
    <identificativo>ABC123.posta-certificata@pec.example.com</identificativo>
    <msgid>&lt;orig-1@example.com&gt;</msgid>
  </dati>
</postacert>`

const envelope = `Return-Path: <posta-certificata@pec.example.com>
From: "Per conto di: sender@pec.example.com" <posta-certificata@pec.example.com>
Reply-To: sender@pec.example.com
To: me@pec.example.org
Subject: POSTA CERTIFICATA: Invio fattura
Message-ID: <opec.123@pec.example.com>
X-Trasporto: posta-certificata
X-Riferimento-Message-ID: <orig-1@example.com>
MIME-Version: 1.0
Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="s"

--s
Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: text/plain; charset=utf-8

Messaggio di posta certificata.
--m
Content-Type: application/xml; name="daticert.xml"
Content-Disposition: inline; filename="daticert.xml"

${daticert}
--m
Content-Type: message/rfc822; name="postacert.eml"
Content-Disposition: inline; filename="postacert.eml"

From: Sender <sender@pec.example.com>
To: me@pec.example.org
Subject: Invio fattura
Message-ID: <orig-1@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="o"

--o
Content-Type: text/html; charset=utf-8

<p>In allegato la fattura.</p>
--o
Content-Type: application/pdf; name="fattura.pdf"
Content-Disposition: attachment; filename="fattura.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--o--
--m--
--s
Content-Type: application/pkcs7-signature; name="smime.p7s"
Content-Disposition: attachment; filename="smime.p7s"
Content-Transfer-Encoding: base64

AAAA
--s--
`

describe('PEC', () => {
  it('reads the certification data', () => {
    const d = parseDaticert(daticert)
    expect(d).toMatchObject({
      type: 'posta-certificata',
      sender: 'sender@pec.example.com',
      recipients: [
        { email: 'me@pec.example.org', certified: true },
        { email: 'other@example.net', certified: false },
      ],
      subject: 'Invio fattura & documenti',
      provider: 'Example PEC Provider',
      date: Date.UTC(2026, 10, 20, 15, 58, 28),
      id: 'ABC123.posta-certificata@pec.example.com',
      msgid: '<orig-1@example.com>',
    })
    expect(d.error).toBeUndefined()
    expect(parseDaticert('<postacert tipo="errore-consegna" errore="no-dest"><dati><errore-esteso>5.1.1 - Utente non esistente</errore-esteso></dati></postacert>')).toMatchObject({
      type: 'errore-consegna',
      error: '5.1.1 - Utente non esistente',
    })
  })

  it('shows certified messages by their original sender and subject, and groups receipts with their message', () => {
    expect(originalSender({ name: 'Per conto di: sender@pec.example.com', email: 'posta-certificata@pec.example.com' }, [])).toEqual({ name: '', email: 'sender@pec.example.com' })
    expect(originalSender({ name: 'Anna', email: 'anna@example.com' }, [])).toEqual({ name: 'Anna', email: 'anna@example.com' })
    expect(originalSubject('POSTA CERTIFICATA: Invio fattura')).toBe('Invio fattura')

    const head = 'X-Ricevuta: avvenuta-consegna\r\nX-Riferimento-Message-ID: <mine@example.com>\r\n\r\n'
    const s = parseSummary(
      fetchAttributes(
        parseResponse(
          new TextEncoder().encode(
            '* 1 FETCH (UID 9 FLAGS () INTERNALDATE "20-Nov-2026 17:00:00 +0100" RFC822.SIZE 100 ' +
              'ENVELOPE (NIL "CONSEGNA: Offerta" (("posta-certificata" NIL "posta-certificata" "pec.example.com")) NIL NIL NIL NIL NIL NIL "<r1@pec.example.com>") ' +
              `BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1 NIL NIL NIL) BODY[HEADER.FIELDS (REFERENCES X-TRASPORTO X-RICEVUTA X-RIFERIMENTO-MESSAGE-ID)] {${head.length}}\r\n${head})\r\n`,
          ),
        ),
      ),
    )
    expect(s.pec).toEqual({ ricevuta: 'avvenuta-consegna', riferimento: '<mine@example.com>', trasporto: undefined })
    expect(threadRoot(s)).toBe('<mine@example.com>')
    expect(pecHeaders('References: <a@x>\r\n')).toBeUndefined()
    // Empty headers don't take the next line's value
    expect(pecHeaders('x-trasporto: posta-certificata\nx-ricevuta: \nx-riferimento-message-id: ')).toEqual({ trasporto: 'posta-certificata', ricevuta: undefined, riferimento: undefined })
  })

  it('opens the original message inside the envelope, with the envelope as proof', async () => {
    const raw = enc(envelope)
    const outer = await parseMessage(raw)
    const v = await pecView(raw, outer, pecHeaders(`X-Trasporto: ${outer.headers.get('x-trasporto')}`)!)
    expect(v.subject).toBe('Invio fattura')
    expect(v.from).toEqual({ name: 'Sender', email: 'sender@pec.example.com' })
    expect(v.bodyHtml).toContain('In allegato la fattura.')
    expect(v.attachments.map((a) => a.meta.name)).toEqual(['fattura.pdf', 'Invio fattura (PEC).eml'])
    expect(v.pec).toMatchObject({ kind: 'message', type: 'posta-certificata', envelopeAttachmentId: 'pec-envelope' })
    expect(v.attachments[1].blob.size).toBe(raw.length)
  })
})
