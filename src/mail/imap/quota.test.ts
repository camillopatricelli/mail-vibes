import { describe, expect, it } from 'vitest'
import { parseResponse } from './parse'
import { formatKb, nearlyFull, storageUsage } from './quota'

const enc = (s: string) => new TextEncoder().encode(s)

describe('Mailbox storage', () => {
  it('reads STORAGE from GETQUOTAROOT, ignoring other resources', () => {
    const responses = ['* QUOTAROOT INBOX ""', '* QUOTA "" (MESSAGE 10 1000 STORAGE 950000 1048576)'].map((l) => parseResponse(enc(l)))
    const u = storageUsage(responses)
    expect(u).toEqual({ usedKb: 950000, limitKb: 1048576 })
    expect(nearlyFull(u!)).toBe(true)
    expect(formatKb(u!.limitKb)).toBe('1 GB')
    expect(formatKb(512_000)).toBe('500 MB')
  })

  it('answers nothing without a storage limit', () => {
    expect(storageUsage([parseResponse(enc('* QUOTA "" (MESSAGE 10 1000)'))])).toBeUndefined()
    expect(nearlyFull({ usedKb: 100, limitKb: 1000 })).toBe(false)
  })
})
