import { describe, expect, it } from 'vitest'
import { mailHref, parseMailParams, type MailView } from './routes'

const params = (hash: string) => hash.replace(/^#\/mail\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)

describe('mail routes', () => {
  it('round-trips well-known and own folders, with and without a thread', () => {
    const views: MailView[] = [
      { kind: 'well', folder: 'sent' },
      { kind: 'custom', accountId: 'microsoft:abc.def-1', folderId: 'AAMkAD/x+y==' },
      { kind: 'tag', name: 'Clients/Acme & Co' },
    ]
    for (const view of views) {
      expect(parseMailParams(params(mailHref(view)))).toEqual({ view, thread: undefined })
      const thread = { accountId: 'microsoft:abc.def-1', threadId: 'AAQk/ab+c=' }
      expect(parseMailParams(params(mailHref(view, thread)))).toEqual({ view, thread })
    }
  })

  it('falls back to the inbox', () => {
    expect(parseMailParams([]).view).toEqual({ kind: 'well', folder: 'inbox' })
    expect(parseMailParams(['nonsense']).view).toEqual({ kind: 'well', folder: 'inbox' })
  })
})
