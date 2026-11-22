import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript Worker without type declarations
import * as w from './worker.js'

const pub = async () => ['93.184.215.14']

describe('bridge checks', () => {
  it('allows only listed origins', () => {
    const list = 'https://app.example.com, http://localhost:5173/'
    expect(w.allowedOrigin('https://app.example.com', list)).toBe(true)
    expect(w.allowedOrigin('http://localhost:5173', list)).toBe(true)
    expect(w.allowedOrigin('https://evil.example.com', list)).toBe(false)
    expect(w.allowedOrigin('', list)).toBe(false)
    expect(w.allowedOrigin('https://app.example.com', undefined)).toBe(false)
  })

  it('compares keys and refuses short or missing ones', () => {
    expect(w.keyMatches('a-long-enough-key-123', 'a-long-enough-key-123')).toBe(true)
    expect(w.keyMatches('a-long-enough-key-124', 'a-long-enough-key-123')).toBe(false)
    expect(w.keyMatches('a-long-enough-key-1234', 'a-long-enough-key-123')).toBe(false)
    expect(w.keyMatches('short', 'short')).toBe(false)
    expect(w.keyMatches(undefined, 'a-long-enough-key-123')).toBe(false)
    expect(w.keyMatches('x', undefined)).toBe(false)
  })

  it('reads the key from the WebSocket protocols', () => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('my key è'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(w.keyFromProtocols(`mail-vibes, key.${b64}`)).toBe('my key è')
    expect(w.keyFromProtocols('mail-vibes')).toBeUndefined()
  })

  it('recognises private addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1'])
      expect(w.isPrivateIPv4(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '93.184.215.14']) expect(w.isPrivateIPv4(ip), ip).toBe(false)
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(w.isPrivateIPv6(ip), ip).toBe(true)
    expect(w.isPrivateIPv6('2606:4700::1111')).toBe(false)
  })

  it('checks the target', async () => {
    expect(await w.checkTarget('imap.example.com', 993, 'on', pub)).toBeUndefined()
    expect(await w.checkTarget('smtp.example.com', 587, 'starttls', pub)).toBeUndefined()
    expect(await w.checkTarget('imap.example.com', 25, 'on', pub)).toMatch(/Port/)
    expect(await w.checkTarget('imap.example.com', 143, 'off', pub)).toMatch(/Encryption/)
    expect(await w.checkTarget('imap.example.com', 993, 'starttls', pub)).toMatch(/STARTTLS/)
    expect(await w.checkTarget('10.0.0.1', 993, 'on', pub)).toMatch(/IP/)
    expect(await w.checkTarget('router.local', 993, 'on', pub)).toMatch(/not allowed/)
    expect(await w.checkTarget('localhost', 993, 'on', pub)).toMatch(/not allowed/)
    expect(await w.checkTarget('inside.example.com', 993, 'on', async () => ['192.168.0.5'])).toMatch(/Private/)
    expect(await w.checkTarget('missing.example.com', 993, 'on', async () => [])).toMatch(/not found/)
  })

  it('parses Thunderbird autoconfig files', () => {
    const xml = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.com">
      <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType>
        <username>%EMAILADDRESS%</username></incomingServer>
      <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType>
        <username>%EMAILLOCALPART%</username></outgoingServer>
      <outgoingServer type="smtp"><hostname>plain.example.com</hostname><port>25</port><socketType>plain</socketType></outgoingServer>
    </emailProvider></clientConfig>`
    expect(w.parseAutoconfigXml(xml)).toEqual([
      { protocol: 'imap', host: 'imap.example.com', port: 993, security: 'tls', username: '%EMAILADDRESS%' },
      { protocol: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls', username: '%EMAILLOCALPART%' },
    ])
  })

  it('recognises the final, positive answer to STARTTLS', () => {
    for (const l of ['A2 OK Begin TLS negotiation now', '220 2.0.0 Ready to start TLS', 'OK "Begin TLS negotiation now."']) {
      expect(w.isFinalReply(l), l).toBe(true)
      expect(w.isStartTlsOk(l), l).toBe(true)
    }
    for (const l of ['* OK still here', '220-wait', '+ go ahead']) expect(w.isFinalReply(l), l).toBe(false)
    for (const l of ['A2 NO not now', '454 TLS not available', 'NO "nope"']) {
      expect(w.isFinalReply(l), l).toBe(true)
      expect(w.isStartTlsOk(l), l).toBe(false)
    }
  })
})
