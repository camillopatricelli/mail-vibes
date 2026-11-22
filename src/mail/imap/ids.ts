/**
 * Ids of IMAP folders, messages and threads, as used in the app's addresses (URL-safe).
 *
 *   folder:  base64url of the mailbox path
 *   message: <folder>.<UIDVALIDITY>.<UID>   (a UID is only valid with its folder's UIDVALIDITY)
 *   thread:  m<base64url of the thread's first Message-ID>, or u<message id> if it has none
 */

function b64url(s: string) {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export const folderId = (path: string) => b64url(path)
export const folderPath = (id: string) => unb64url(id)

export interface MessageRef {
  path: string
  uidValidity: number
  uid: number
}

export const messageId = (r: MessageRef) => `${folderId(r.path)}.${r.uidValidity}.${r.uid}`

export function parseMessageId(id: string): MessageRef {
  const m = /^([A-Za-z0-9_-]*)\.(\d+)\.(\d+)$/.exec(id)
  if (!m) throw new Error(`Bad message id: ${id}`)
  return { path: unb64url(m[1]), uidValidity: Number(m[2]), uid: Number(m[3]) }
}

export const threadIdOf = (root: string | undefined, message: string) => (root ? `m${b64url(root)}` : `u${message}`)

export function parseThreadId(id: string): { root: string } | { message: string } {
  if (id.startsWith('m')) return { root: unb64url(id.slice(1)) }
  if (id.startsWith('u')) return { message: id.slice(1) }
  throw new Error(`Bad thread id: ${id}`)
}
