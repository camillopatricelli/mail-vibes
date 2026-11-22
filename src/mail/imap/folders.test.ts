import { describe, expect, it } from 'vitest'
import { detectSpecial, parseList } from './folders'
import { parseResponse } from './parse'

const list = (lines: string[]) => parseList(lines.map((l) => parseResponse(new TextEncoder().encode(`${l}\r\n`))))

describe('IMAP folders', () => {
  it('uses SPECIAL-USE flags when the server has them', () => {
    const folders = list([
      '* LIST (\\HasNoChildren) "/" INBOX',
      '* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"',
      '* LIST (\\HasNoChildren \\Trash) "/" "Deleted Items"',
      '* LIST (\\HasNoChildren \\Junk) "/" Junk',
      '* LIST (\\HasNoChildren \\Drafts) "/" Drafts',
      '* LIST (\\HasChildren) "/" Clienti',
      '* LIST (\\HasNoChildren) "/" "Clienti/Rossi"',
      '* LIST (\\Noselect \\HasChildren) "/" Old',
    ])
    expect(detectSpecial(folders)).toEqual({ sent: 'Sent Items', trash: 'Deleted Items', spam: 'Junk', drafts: 'Drafts' })
    expect(folders.find((f) => f.path === 'Clienti/Rossi')).toMatchObject({ name: 'Rossi', depth: 1, selectable: true })
    expect(folders.find((f) => f.path === 'Old')?.selectable).toBe(false)
  })

  it('guesses special folders by name, and folders under "INBOX." are not indented', () => {
    const folders = list([
      '* LIST (\\HasChildren) "." INBOX',
      '* LIST (\\HasNoChildren) "." "INBOX.Posta inviata"',
      '* LIST (\\HasNoChildren) "." INBOX.Cestino',
      '* LIST (\\HasNoChildren) "." "INBOX.Posta indesiderata"',
      '* LIST (\\HasNoChildren) "." INBOX.Bozze',
      '* LIST (\\HasNoChildren) "." INBOX.Archivio',
      '* LIST (\\HasNoChildren) "." INBOX.Fornitori',
      '* LIST (\\HasNoChildren) "." INBOX.Fornitori.Sent',
      '* LIST (\\HasNoChildren) "." "INBOX.&AMk-l&AOk-ments envoy&AOk-s"',
    ])
    expect(detectSpecial(folders)).toEqual({
      sent: 'INBOX.Posta inviata',
      trash: 'INBOX.Cestino',
      spam: 'INBOX.Posta indesiderata',
      drafts: 'INBOX.Bozze',
      archive: 'INBOX.Archivio',
    })
    expect(folders.find((f) => f.path === 'INBOX.Fornitori')?.depth).toBe(0)
    expect(folders.find((f) => f.path === 'INBOX.Fornitori.Sent')?.depth).toBe(1)
    expect(folders.at(-1)?.name).toBe('Éléments envoyés')
  })

  it('lets folders chosen by hand win, if they still exist', () => {
    const folders = list(['* LIST () "/" INBOX', '* LIST (\\Sent) "/" Sent', '* LIST () "/" "My sent"'])
    expect(detectSpecial(folders, { sent: 'My sent' }).sent).toBe('My sent')
    expect(detectSpecial(folders, { sent: 'Gone' }).sent).toBe('Sent')
  })
})

describe('folder labels', () => {
  it('drops the INBOX prefix and decodes each part', async () => {
    const { folderLabel } = await import('./folders')
    expect(folderLabel('INBOX', '.')).toBe('INBOX')
    expect(folderLabel('INBOX.Posta inviata', '.')).toBe('Posta inviata')
    expect(folderLabel('INBOX.Fornitori.&AMk-t&AOk-', '.')).toBe('Fornitori / Été')
    expect(folderLabel('Clienti/Rossi', '/')).toBe('Clienti / Rossi')
  })
})
