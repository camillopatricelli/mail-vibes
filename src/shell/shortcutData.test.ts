import { describe, expect, it } from 'vitest'
import { iconCandidates, normalizeUrl, parseShortcuts, tileColor, tileLetter } from './shortcutData'

describe('shortcuts', () => {
  it('turns typed addresses into web links and refuses anything else', () => {
    expect(normalizeUrl('intranet.example.com/home')).toBe('https://intranet.example.com/home')
    expect(normalizeUrl(' http://portal.example.it ')).toBe('http://portal.example.it/')
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeUrl('file:///C:/x')).toBeUndefined()
    expect(normalizeUrl('not a site')).toBeUndefined()
    expect(normalizeUrl('')).toBeUndefined()
  })

  it('keeps only valid, named shortcuts, at most four', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `Site ${i}`, url: `site${i}.example.com` }))
    expect(parseShortcuts(many)).toHaveLength(4)
    expect(parseShortcuts([{ id: 'a', name: '  ', url: 'x.example.com' }, { id: 'b', name: 'Bad', url: 'javascript:x' }, { id: 'c', name: 'Ok', url: 'ok.example.com' }])).toEqual([
      { id: 'c', name: 'Ok', url: 'https://ok.example.com/' },
    ])
    expect(parseShortcuts('nope')).toEqual([])
  })

  it('looks for the site icon at the site itself', () => {
    expect(iconCandidates('https://portal.example.it/a/b?c=1')).toEqual(['https://portal.example.it/apple-touch-icon.png', 'https://portal.example.it/favicon.ico'])
  })

  it('gives each name a steady colour and letter', () => {
    expect(tileColor('Intranet')).toBe(tileColor('intranet'))
    expect(tileLetter('  é-commerce')).toBe('É')
    expect(tileLetter('3CX')).toBe('3')
  })
})
