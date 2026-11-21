import { describe, expect, it } from 'vitest'
import { findMailUrl, mailNoteLine, notesWithoutMail, parseMailUrl } from './mailLink'

describe('parseMailUrl', () => {
  it('reads Gmail links with a hexadecimal id', () => {
    expect(parseMailUrl('https://mail.google.com/mail/#all/18c2f0a1b2c3d4e5')).toMatchObject({ provider: 'google', ids: ['18c2f0a1b2c3d4e5'] })
    expect(parseMailUrl('https://mail.google.com/mail/u/me%40example.com/#inbox/18C2F0A1B2C3D4E5')).toMatchObject({
      ids: ['18c2f0a1b2c3d4e5'],
      email: 'me@example.com',
    })
  })

  it('keeps opaque Gmail ids as web-only links', () => {
    expect(parseMailUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKmGhRzZq')).toMatchObject({ provider: 'google', ids: [], email: undefined })
    expect(parseMailUrl('https://mail.google.com/mail/u/0/')).toBeUndefined()
  })

  it('reads Outlook links and converts web ids to Graph ids', () => {
    const l = parseMailUrl('https://outlook.office365.com/owa/?ItemID=AAMkAD%2Fx%2By%3D&exvsurl=1&viewmodel=ReadMessageItem')
    expect(l).toMatchObject({ provider: 'microsoft', ids: ['AAMkAD-x_y=', 'AAMkAD/x+y='] })
    expect(parseMailUrl('https://outlook.office.com/mail/deeplink/read/AAMk-abc')?.ids).toEqual(['AAMk-abc'])
    expect(parseMailUrl('https://outlook.office.com/calendar/view/month')).toBeUndefined()
  })

  it('ignores other addresses', () => {
    expect(parseMailUrl('https://example.com/#all/18c2f0a1b2c3d4e5')).toBeUndefined()
    expect(parseMailUrl('not a url')).toBeUndefined()
  })
})

describe('notes', () => {
  const notes = `Call back\n\n${mailNoteLine('Invoice', 'https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5')}`
  it('finds the link and hides its line', () => {
    expect(findMailUrl(notes)?.ids).toEqual(['18c2f0a1b2c3d4e5'])
    expect(notesWithoutMail(notes)).toBe('Call back')
    expect(findMailUrl('see https://example.com')).toBeUndefined()
  })
})
