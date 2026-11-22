import { describe, expect, it } from 'vitest'
import { parseResponse } from './parse'
import { copiedUids, expandUidSet, ruleCriteria, searchCriteria } from './search'

const flat = (parts: ReturnType<typeof searchCriteria>) => parts?.map((p) => (typeof p === 'string' ? p : 'str' in p ? `<${p.str}>` : '?')).join('')

describe('IMAP search', () => {
  it('builds criteria from words, phrases and field prefixes', () => {
    expect(flat(searchCriteria('preventivo', false))).toBe('TEXT <preventivo>')
    expect(flat(searchCriteria('from:anna "fattura 12"', false))).toBe('FROM <anna> TEXT <fattura 12>')
    expect(flat(searchCriteria('Subject:"Re: offerta"', false))).toBe('SUBJECT <Re: offerta>')
    expect(searchCriteria('   ', false)).toBeUndefined()
  })

  it('searches only subject and sender on PEC servers, and says when words are UTF-8', () => {
    expect(flat(searchCriteria('perché', true))).toBe('CHARSET UTF-8 OR SUBJECT <perché> FROM <perché>')
  })

  it('builds rule criteria for new mail, subject-only on PEC servers', () => {
    expect(flat(ruleCriteria({ from: 'news@example.com', words: '' }, false, 41))).toBe('UID 41:* FROM <news@example.com>')
    expect(flat(ruleCriteria({ from: '', words: 'fattura' }, false, 7))).toBe('UID 7:* TEXT <fattura>')
    expect(flat(ruleCriteria({ from: 'x', words: 'perché' }, true, 7))).toBe('CHARSET UTF-8 UID 7:* FROM <x> SUBJECT <perché>')
    expect(ruleCriteria({ from: ' ', words: '' }, false, 1)).toBeUndefined()
  })

  it('reads COPYUID to give moved messages their new ids', () => {
    expect(expandUidSet('3:5,9,12:11')).toEqual([3, 4, 5, 9, 11, 12])
    const r = parseResponse(new TextEncoder().encode('* OK [COPYUID 1700 4,7:8 101:103] Moved\r\n'))
    expect(copiedUids([r])).toEqual({ uidValidity: 1700, map: new Map([[4, 101], [7, 102], [8, 103]]) })
    expect(copiedUids([parseResponse(new TextEncoder().encode('a1 OK Done\r\n'))])).toBeUndefined()
  })
})
