import { describe, expect, it } from 'vitest'
import { isAppFolder, keywordToTag, parseTimeStamp, tagToKeyword, timedFolderTime, timedPath, timeStamp } from './keywords'

describe('IMAP tags as keywords', () => {
  it('uses Thunderbird’s keywords for its standard tags', () => {
    expect(tagToKeyword('Important')).toBe('$label1')
    expect(tagToKeyword(' to do ')).toBe('$label4')
    expect(keywordToTag('$Label2')).toBe('Work')
  })

  it('makes other names into atoms and reads them back', () => {
    expect(tagToKeyword('Clienti 2026')).toBe('Clienti_2026')
    expect(keywordToTag('Clienti_2026')).toBe('Clienti 2026')
    expect(keywordToTag(tagToKeyword('Città'))).toBe('Città')
    expect(tagToKeyword('a(b)')).toBe('a_b_')
  })

  it('ignores system flags and other programs’ markers', () => {
    for (const k of ['\\Seen', '$Forwarded', '$MDNSent', 'Junk', 'NonJunk']) expect(keywordToTag(k)).toBeUndefined()
  })
})

describe('Folders for snoozed and scheduled mail', () => {
  const at = new Date(2026, 10, 23, 9, 5).getTime()
  const dotted = { prefix: 'INBOX.', delimiter: '.' }
  const slashed = { prefix: '', delimiter: '/' }

  it('names folders after the local time and reads the time back', () => {
    expect(timeStamp(at)).toBe('2026-11-23 09h05')
    expect(parseTimeStamp('2026-11-23 09h05')).toBe(at)
    expect(parseTimeStamp('not a time')).toBeUndefined()
  })

  it('keeps them under the Mail Vibes folder, in the account’s namespace', () => {
    expect(timedPath(dotted, 'Snoozed', at)).toBe('INBOX.Mail Vibes.Snoozed.2026-11-23 09h05')
    expect(timedPath(slashed, 'Send later', at)).toBe('Mail Vibes/Send later/2026-11-23 09h05')
    expect(timedFolderTime('INBOX.Mail Vibes.Snoozed.2026-11-23 09h05', dotted, 'Snoozed')).toBe(at)
    expect(timedFolderTime('INBOX.Mail Vibes.Snoozed.2026-11-23 09h05', dotted, 'Send later')).toBeUndefined()
    expect(isAppFolder('INBOX.Mail Vibes', dotted)).toBe(true)
    expect(isAppFolder('INBOX.Mail Vibes.Snoozed', dotted)).toBe(true)
    expect(isAppFolder('INBOX.Mail Vibes 2', dotted)).toBe(false)
    expect(isAppFolder('INBOX.Lavoro', dotted)).toBe(false)
  })
})
