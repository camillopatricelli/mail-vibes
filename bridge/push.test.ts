import nodeCrypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript Worker without type declarations
import * as w from './worker.js'

const b64 = (s: string) => Buffer.from(s, 'base64url')

/** A small stand-in for Cloudflare D1 on Node's SQLite (only what the bridge uses). */
function fakeD1() {
  const db = new DatabaseSync(':memory:')
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => statement(sql, a),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => db.prepare(sql).run(...(args as never[])),
  })
  return { prepare: (sql: string) => statement(sql), batch: async (list: { run: () => Promise<unknown> }[]) => Promise.all(list.map((s) => s.run())) }
}

/** Decrypts a Web Push body with node:crypto (an implementation independent of the bridge's). */
function decryptPush(body: Uint8Array, uaPrivate: Buffer, auth: Buffer) {
  const msg = Buffer.from(body)
  const salt = msg.subarray(0, 16)
  const idlen = msg[20]
  const asPublic = msg.subarray(21, 21 + idlen)
  const ct = msg.subarray(21 + idlen)
  const ecdh = nodeCrypto.createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const hk = (s: Buffer, ikm: Buffer, info: Buffer, n: number) => Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, info, n))
  const ikm = hk(auth, ecdh.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32)
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  return plain.subarray(0, plain.length - 1).toString()
}

describe('push reminders', () => {
  it('encrypts exactly like the example in RFC 8291', async () => {
    const asPublic = b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')
    const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: asPublic.subarray(1, 33).toString('base64url'), y: asPublic.subarray(33).toString('base64url') }
    const keys = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    }
    const out = await w.encryptPush(
      'When I grow up, I want to be a watermelon',
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      { keys, salt: b64('DGv6ra1nlYgDCS1FRnbzlw') },
    )
    expect(Buffer.from(out).toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  it('signs the push identity so the public key verifies it', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const header = await w.vapidAuthorization('https://fcm.googleapis.com/fcm/send/x', { privateKey: pair.privateKey, publicKey: Buffer.from(raw).toString('base64url') }, 'https://app.example.com', 1_700_000_000_000)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!
    expect(JSON.parse(b64(m[2]).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://app.example.com' })
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, b64(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))
    expect(ok).toBe(true)
  })

  it('sends only to real push services', () => {
    for (const e of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
      expect(w.pushEndpointAllowed(e), e).toBe(true)
    for (const e of ['http://fcm.googleapis.com/x', 'https://evil.example.com/fcm.googleapis.com', 'https://fcm.googleapis.com.example.com/x', 'https://fcm.googleapis.com:8443/x', 'http://localhost:9000/p', 'nonsense'])
      expect(w.pushEndpointAllowed(e), e).toBe(false)
    expect(w.pushEndpointAllowed('http://localhost:9000/p', { DEV_PUSH_LOCAL: 'yes' })).toBe(true)
  })

  it('checks uploaded schedules', () => {
    const setup = 's'.repeat(24)
    const good = { setup, live: ['partAAAA'], parts: { partAAAA: [{ id: 'idAAAAAA', at: 1, blob: 'abc_-' }] } }
    expect(w.parseSchedule(good)).toEqual(good)
    expect(w.parseSchedule({ ...good, setup: 'short' })).toBe('Bad setup')
    expect(w.parseSchedule({ ...good, parts: { other123: [] } })).toBe('Bad parts')
    expect(w.parseSchedule({ ...good, parts: { partAAAA: [{ id: 'idAAAAAA', at: 1, blob: '<script>' }] } })).toBe('Bad reminder')
  })

  it('picks reminders due within the last hour, once', () => {
    const now = 10_000_000
    const items = [
      { id: 'a', at: now - 1000 },
      { id: 'b', at: now + 60_000 },
      { id: 'c', at: now - 2 * 3600_000 },
      { id: 'd', at: now - 5000 },
    ]
    expect(w.dueReminders([items, [items[0]]], new Set(['d']), now).map((x: { id: string }) => x.id)).toEqual(['a'])
  })

  it('stores devices and schedules, and sends what is due', async () => {
    const DB = fakeD1()
    const env = { ACCESS_KEY: 'a-long-enough-key-123', ALLOWED_ORIGINS: 'https://app.example.com', DB }
    const call = (path: string, body?: unknown) =>
      w.default.fetch(
        new Request(`https://bridge.example.com${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${env.ACCESS_KEY}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        env,
      )
    const key = (await (await call('/push/key')).json()).publicKey
    expect(b64(key)).toHaveLength(65)
    expect((await (await call('/push/key')).json()).publicKey).toBe(key) // made once, then kept

    const ua = nodeCrypto.createECDH('prime256v1')
    ua.generateKeys()
    const auth = nodeCrypto.randomBytes(16)
    const setup = 'setup-' + 'x'.repeat(20)
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1'
    expect((await call('/push/device', { setup, endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') })).status).toBe(200)
    expect((await call('/push/device', { setup, endpoint: 'https://evil.example.com/x', p256dh: 'AAAA', auth: 'AAAA' })).status).toBe(400)

    const now = Date.now()
    const schedule = (items: unknown[]) => call('/push/schedule', { setup, live: ['events01'], parts: { events01: items } })
    expect((await schedule([{ id: 'reminder1', at: now - 30_000, blob: 'secret-blob-1' }, { id: 'reminder2', at: now + 3600_000, blob: 'later' }])).status).toBe(200)

    const sent: { url: string; headers: Record<string, string>; body: Uint8Array }[] = []
    const send = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      sent.push({ url, ...init })
      return new Response(null, { status: 201 })
    }
    await w.sendDueReminders(env, now, send)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(endpoint)
    expect(sent[0].headers['Content-Encoding']).toBe('aes128gcm')
    expect(sent[0].headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${key}$`))
    expect(decryptPush(sent[0].body, ua.getPrivateKey(), auth)).toBe('secret-blob-1')

    await w.sendDueReminders(env, now + 60_000, send) // a minute later: nothing new
    expect(sent).toHaveLength(1)

    // Uploading again doesn't resend; a part no longer listed is dropped.
    await schedule([{ id: 'reminder1', at: now - 30_000, blob: 'secret-blob-1' }])
    await w.sendDueReminders(env, now + 120_000, send)
    expect(sent).toHaveLength(1)
    await call('/push/schedule', { setup, live: [], parts: {} })
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM push_parts').first()) as { n: number }).toEqual({ n: 0 })

    // A device the push service says is gone is forgotten.
    await schedule([{ id: 'reminder3', at: now + 170_000, blob: 'x' }])
    await w.sendDueReminders(env, now + 180_000, async () => new Response(null, { status: 410 }))
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM push_devices').first()) as { n: number }).toEqual({ n: 0 })
  })
})
