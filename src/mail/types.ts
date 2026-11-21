/** Provider-neutral mail model. Outlook (Graph) and Gmail adapters both map to these types. */

export type FolderKind = 'inbox' | 'starred' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam'
export const folderKinds: FolderKind[] = ['inbox', 'starred', 'sent', 'drafts', 'archive', 'trash', 'spam']

export interface Address {
  name: string
  email: string
}

/** A message as shown in a list (no body). */
export interface MailSummary {
  accountId: string
  id: string
  threadId: string
  subject: string
  snippet: string
  from: Address
  to: Address[]
  date: number
  isRead: boolean
  isFlagged: boolean
  hasAttachments: boolean
  isDraft: boolean
}

export interface Attachment {
  id: string
  name: string
  contentType: string
  size: number
  isInline: boolean
}

export interface MailMessage extends MailSummary {
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  bodyHtml: string
  /** False if the body is plain text (bodyHtml then holds escaped text) */
  bodyIsHtml: boolean
  folderId: string
  /** Which well-known folder the message is in, if any */
  folderKind?: Exclude<FolderKind, 'starred'>
}

export interface MailFolder {
  id: string
  name: string
  /** Depth for indentation in pickers */
  depth: number
  unread: number
}

/** What a list shows: a well-known folder merged across accounts, or one account's own folder. */
export type ListTarget = FolderKind | { folderId: string }

export interface ListResult {
  messages: MailSummary[]
  hasMore: boolean
}

export type ReplyKind = 'reply' | 'replyAll' | 'forward'

export interface DraftContent {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  /** HTML written by the user (without the quoted original) */
  html: string
}

export interface DraftRef {
  id: string
  /** Quoted original appended after the user's text (replies/forwards); '' for new mail */
  quotedHtml: string
}

export interface MailProvider {
  list(accountId: string, target: ListTarget, count: number): Promise<ListResult>
  thread(accountId: string, threadId: string): Promise<MailMessage[]>
  setRead(accountId: string, ids: string[], read: boolean): Promise<void>
  setFlagged(accountId: string, ids: string[], flagged: boolean): Promise<void>
  /** Moves messages to a well-known folder or a folder id */
  move(accountId: string, ids: string[], dest: ListTarget): Promise<void>
  deleteForever(accountId: string, ids: string[]): Promise<void>
  /** The user's own folders (well-known/system folders excluded), with unread counts */
  folders(accountId: string): Promise<MailFolder[]>
  /** Server-side unread count of the folder (inbox: unread messages) */
  unreadCount(accountId: string, folder: FolderKind): Promise<number>
  attachments(accountId: string, messageId: string): Promise<Attachment[]>
  downloadAttachment(accountId: string, messageId: string, attachmentId: string): Promise<Blob>
  /** Inline images referenced as cid: in the body, as contentId -> Blob */
  inlineImages(accountId: string, messageId: string): Promise<Map<string, Blob>>

  createDraft(accountId: string, content: DraftContent, replyTo?: { messageId: string; kind: ReplyKind }): Promise<DraftRef & { content: DraftContent }>
  updateDraft(accountId: string, draft: DraftRef, content: DraftContent): Promise<void>
  addAttachment(accountId: string, draftId: string, file: File, onProgress?: (fraction: number) => void): Promise<Attachment[]>
  removeAttachment(accountId: string, draftId: string, attachmentId: string): Promise<void>
  sendDraft(accountId: string, draftId: string): Promise<void>
  deleteDraft(accountId: string, draftId: string): Promise<void>
  /** Loads an existing draft (from the Drafts folder) for editing */
  loadDraft(accountId: string, draftId: string): Promise<{ content: DraftContent; attachments: Attachment[] }>
}
