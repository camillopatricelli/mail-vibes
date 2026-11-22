/** Provider-neutral mail model. Outlook (Graph) and Gmail adapters both map to these types. */

export type FolderKind = 'inbox' | 'starred' | 'snoozed' | 'sent' | 'drafts' | 'scheduled' | 'archive' | 'trash' | 'spam'
export const folderKinds: FolderKind[] = ['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'scheduled', 'archive', 'trash', 'spam']

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
  /** Tag names: Gmail user labels (full path) or Outlook categories */
  tags: string[]
  /** When a snoozed message comes back to the Inbox (see snooze.ts) */
  snoozedUntil?: number
  /** When a message waiting to be sent goes out (see snooze.ts) */
  scheduledAt?: number
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
/** `inbox`: search the Inbox only (for applying mail rules to messages already there). */
export type ListTarget = FolderKind | { folderId: string } | { tag: string } | { search: string; inbox?: boolean }

/** A tag as defined in one account (Gmail label or Outlook category). */
export interface MailTag {
  name: string
  /** CSS colour, if the provider has one for it */
  color?: string
}

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
  /** Moves messages to a well-known folder or a folder id; may answer the messages' new ids (Outlook) */
  move(accountId: string, ids: string[], dest: ListTarget): Promise<string[] | void>
  deleteForever(accountId: string, ids: string[]): Promise<void>
  /** Takes messages out of the Inbox until `until` (see snooze.ts); snoozing again replaces the time */
  snooze(accountId: string, ids: string[], until: number): Promise<void>
  /** Brings snoozed messages back to the Inbox, unread */
  unsnooze(accountId: string, ids: string[]): Promise<void>
  /** The user's own folders (well-known/system folders excluded), with unread counts */
  folders(accountId: string): Promise<MailFolder[]>
  /** The account's tags (Gmail user labels, Outlook categories) */
  tags(accountId: string): Promise<MailTag[]>
  /** Adds and removes tags by name (creating missing ones); `messages` carry their current tags */
  setTags(accountId: string, messages: { id: string; tags: string[] }[], add: string[], remove: string[]): Promise<void>
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
  /** Sends the draft at `at` instead of now (see snooze.ts); also changes the time of a scheduled message */
  scheduleDraft(accountId: string, draftId: string, at: number): Promise<void>
  /** Turns a scheduled message back into a draft; answers the id to open it with */
  unschedule(accountId: string, id: string): Promise<string>
  /** True if the server sends scheduled messages by itself; else the app sends them (sendScheduled) */
  readonly sendsScheduledItself: boolean
  /** Sends a scheduled message whose time has come (only for providers that don't do it themselves) */
  sendScheduled(accountId: string, id: string): Promise<void>
  deleteDraft(accountId: string, draftId: string): Promise<void>
  /** Loads an existing draft (from the Drafts folder) for editing */
  loadDraft(accountId: string, draftId: string): Promise<{ content: DraftContent; attachments: Attachment[] }>
}
