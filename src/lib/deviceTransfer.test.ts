import { describe, expect, it } from 'vitest'
import { newCode, normalizeCode, openTransfer, passwordKeys, payloadFromLink, sealTransfer, TRANSFER_TTL, type Transfer } from './deviceTransfer'

const sample: Transfer = {
  at: Date.now(),
  settings: '{"format":"mail-vibes-settings"}',
  exportBridge: false,
  passwords: [{ key: 'imap:me@example.com', password: 'p4ss w0rd è', remember: true }],
}

describe('Copy to another device', () => {
  it('makes readable codes and accepts them typed loosely', () => {
    const c = newCode()
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(normalizeCode(' k7qm 4xrt ')).toBe('K7QM4XRT')
  })

  it('opens with the right code only, and not after a day', async () => {
    const code = 'K7QM-4XRT'
    const payload = await sealTransfer(sample, code)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(payload).not.toContain('p4ss')
    expect(await openTransfer(payload, 'k7qm4xrt')).toEqual(sample)
    await expect(openTransfer(payload, 'K7QM-4XRU')).rejects.toMatchObject({ kind: 'code' })
    await expect(openTransfer(payload, code, sample.at + TRANSFER_TTL + 1)).rejects.toMatchObject({ kind: 'expired' })
    await expect(openTransfer('nonsense', code)).rejects.toMatchObject({ kind: 'invalid' })
  }, 20_000)

  it('finds the payload in a pasted link', () => {
    const p = 'A'.repeat(60)
    expect(payloadFromLink(`https://example.com/mail-vibes/#/setup/device/${p}`)).toBe(p)
    expect(payloadFromLink(` ${p} `)).toBe(p)
    expect(payloadFromLink('hello')).toBeUndefined()
  })

  it('lists the passwords an account needs', () => {
    const server = { host: 'imap.example.com', port: 993, security: 'tls' as const, username: 'me' }
    const base = { provider: 'imap' as const, email: 'me@example.com', displayName: 'Me', color: '#188038', visible: true }
    expect(
      passwordKeys({
        accounts: [
          { ...base, id: 'imap:a', imap: { incoming: server, pec: false } },
          { ...base, id: 'imap:b', imap: { incoming: server, outgoing: { ...server, samePassword: false }, pec: false } },
          { ...base, id: 'google:1', provider: 'google' },
        ],
      }),
    ).toEqual(['imap:a', 'imap:b', 'imap:b#smtp'])
  })
})
