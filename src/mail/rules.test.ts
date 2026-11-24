import { describe, expect, it } from 'vitest'
import { gmailPhrase, gmailToSpec, matchesWords, outlookToSpec, specToGmail, specToOutlook, type RuleSpec } from './rules'

const spec = (s: Partial<RuleSpec>): RuleSpec => ({ from: '', words: '', markRead: false, move: { kind: 'none' }, ...s })

describe('Gmail filters', () => {
  it('turns "mark as read and move" into a label, out of the Inbox, not unread', () => {
    const f = specToGmail(spec({ from: 'sender@somewhere.com', words: 'a few words', markRead: true, move: { kind: 'folder', id: 'Label_7' } }))
    expect(f).toEqual({
      criteria: { from: 'sender@somewhere.com', query: '"a few words"' },
      action: { addLabelIds: ['Label_7'], removeLabelIds: ['UNREAD', 'INBOX'] },
    })
    expect(gmailToSpec(f)).toEqual(spec({ from: 'sender@somewhere.com', words: 'a few words', markRead: true, move: { kind: 'folder', id: 'Label_7' } }))
  })

  it('turns "delete" into the Bin label', () => {
    const f = specToGmail(spec({ from: 'sender@somewhere.com', words: 'a few words', move: { kind: 'delete' } }))
    expect(f.action).toEqual({ addLabelIds: ['TRASH'] })
    expect(gmailToSpec(f)?.move).toEqual({ kind: 'delete' })
  })

  it('round-trips archive and single words', () => {
    const s = spec({ words: 'invoice', move: { kind: 'archive' } })
    expect(specToGmail(s).criteria).toEqual({ query: 'invoice' })
    expect(gmailToSpec(specToGmail(s))).toEqual(s)
  })

  it('leaves filters with other options read-only', () => {
    expect(gmailToSpec({ criteria: { from: 'a@b.c', hasAttachment: true }, action: { removeLabelIds: ['UNREAD'] } })).toBeUndefined()
    expect(gmailToSpec({ criteria: { from: 'a@b.c' }, action: { forward: 'x@y.z' } })).toBeUndefined()
    expect(gmailToSpec({ criteria: { query: 'from:a subject:b' }, action: { removeLabelIds: ['UNREAD'] } })).toBeUndefined()
    expect(gmailToSpec({ criteria: { query: 'two words' }, action: { removeLabelIds: ['UNREAD'] } })).toBeUndefined()
    // Labelling without leaving the Inbox is tagging, not moving.
    expect(gmailToSpec({ criteria: { from: 'a@b.c' }, action: { addLabelIds: ['Label_1'] } })).toBeUndefined()
    expect(gmailToSpec({ criteria: { from: 'a@b.c' }, action: { addLabelIds: ['STARRED'], removeLabelIds: ['INBOX'] } })).toBeUndefined()
  })

  it('quotes phrases only', () => {
    expect(gmailPhrase(' hello ')).toBe('hello')
    expect(gmailPhrase('a "few" words')).toBe('"a few words"')
    expect(gmailPhrase('job:')).toBe('"job:"')
  })

  it('puts "but not" in the negated query, and reads it back', () => {
    const s = spec({ words: 'backup', except: 'job failed', move: { kind: 'archive' } })
    expect(specToGmail(s).criteria).toEqual({ query: 'backup', negatedQuery: '"job failed"' })
    expect(gmailToSpec(specToGmail(s))).toEqual(s)
  })
})

describe('Outlook rules', () => {
  it('uses the exact address when there is one, otherwise "sender contains"', () => {
    const full = specToOutlook(spec({ from: 'sender@somewhere.com', words: 'a few words', markRead: true, move: { kind: 'folder', id: 'F1' } }), 'ARCH')
    expect(full).toEqual({
      conditions: { fromAddresses: [{ emailAddress: { address: 'sender@somewhere.com' } }], bodyOrSubjectContains: ['a few words'] },
      actions: { markAsRead: true, moveToFolder: 'F1' },
    })
    expect(specToOutlook(spec({ from: 'somewhere.com', move: { kind: 'delete' } }), 'ARCH')).toEqual({
      conditions: { senderContains: ['somewhere.com'] },
      actions: { delete: true },
    })
  })

  it('puts "but not" in the exceptions, and reads it back', () => {
    const s = spec({ from: 'a@b.c', words: 'backup', except: 'failed', move: { kind: 'delete' } })
    const o = specToOutlook(s, 'ARCH')
    expect(o.exceptions).toEqual({ bodyOrSubjectContains: ['failed'] })
    expect(outlookToSpec({ displayName: 'X', ...o })).toEqual({ ...s, name: 'X' })
    expect(outlookToSpec({ conditions: { senderContains: ['x'] }, actions: { markAsRead: true }, exceptions: { bodyOrSubjectContains: ['a', 'b'] } })).toBeUndefined()
  })

  it('matches the words as typed, ignoring case and spacing', () => {
    expect(matchesWords('Backup report: Job:  SUCCESSFUL', 'job: successful')).toBe(true)
    expect(matchesWords('Job completed. Successful', 'job: successful')).toBe(false)
    expect(matchesWords('Backup failed', 'backup', 'failed')).toBe(false)
    expect(matchesWords('Backup done', 'backup', 'failed')).toBe(true)
    expect(matchesWords('anything', '', 'failed')).toBe(true)
  })

  it('leaves unused fields out', () => {
    expect(specToOutlook(spec({ words: 'x', move: { kind: 'archive' } }), 'ARCH')).toEqual({
      conditions: { bodyOrSubjectContains: ['x'] },
      actions: { moveToFolder: 'ARCH' },
    })
  })

  it('reads rules back, with Graph nulls and the Archive folder', () => {
    const r = {
      displayName: 'Mine',
      conditions: { fromAddresses: [{ emailAddress: { address: 'a@b.c', name: 'A' } }], bodyOrSubjectContains: ['hi'], subjectContains: null, isAutomaticReply: false },
      actions: { markAsRead: true, moveToFolder: 'ARCH', delete: false, forwardTo: null, stopProcessingRules: true },
      exceptions: null,
    }
    expect(outlookToSpec(r, 'ARCH')).toEqual({ from: 'a@b.c', words: 'hi', markRead: true, move: { kind: 'archive' }, name: 'Mine' })
  })

  it('leaves rules with other options read-only', () => {
    expect(outlookToSpec({ conditions: { subjectContains: ['x'] }, actions: { markAsRead: true } })).toBeUndefined()
    expect(outlookToSpec({ conditions: { senderContains: ['x'] }, actions: { forwardTo: [{ emailAddress: { address: 'y@z.w' } }] } })).toBeUndefined()
    expect(outlookToSpec({ conditions: { senderContains: ['x'] }, actions: { markAsRead: true }, exceptions: { senderContains: ['y'] } })).toBeUndefined()
    expect(outlookToSpec({ isReadOnly: true, conditions: { senderContains: ['x'] }, actions: { markAsRead: true } })).toBeUndefined()
  })
})
