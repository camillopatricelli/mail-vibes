import i18n from '../i18n'
import { ApiError, graph, type GraphPage } from './graph'

/** A file attached to an event or a task. */
export interface ItemFile {
  id: string
  name: string
  size: number
  contentType: string
}

/** The files of one event or task (Microsoft 365). */
export interface FileStore {
  /** The largest file the provider takes, in bytes */
  readonly maxSize: number
  list(): Promise<ItemFile[]>
  add(file: File, onProgress?: (fraction: number) => void): Promise<void>
  remove(id: string): Promise<void>
  download(id: string): Promise<Blob>
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Graph takes files up to 3 MB in one request; larger ones go through an upload session. */
const SMALL = 3 * 1024 * 1024
/** ~3.75 MB: a multiple of 320 KiB as Graph requires, and under the 4 MB limit per request. */
const CHUNK = 320 * 1024 * 12

/** Sends a file to a pre-authenticated upload session URL, chunk by chunk. */
async function sendToSession(uploadUrl: string, file: Blob, onProgress?: (fraction: number) => void) {
  for (let start = 0; start < file.size; start += CHUNK) {
    const end = Math.min(start + CHUNK, file.size)
    let res: Response
    try {
      // The upload URL is pre-authenticated: no Authorization header.
      res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` },
        body: file.slice(start, end),
      })
    } catch {
      throw new ApiError(i18n.t('errors.uploadNetwork'), 0)
    }
    if (!res.ok) throw new ApiError(i18n.t('errors.uploadFailed', { status: res.status }), res.status)
    onProgress?.(end / file.size)
  }
}

/**
 * Adds a file to a Graph item's `attachments` collection (`base` ends with `/attachments`).
 * Messages and events use `fileAttachment`; To Do tasks use `taskFileAttachment` with a
 * differently shaped upload session.
 */
export async function uploadGraphFile(
  accountId: string,
  base: string,
  file: File,
  kind: 'outlook' | 'todo',
  onProgress?: (fraction: number) => void,
) {
  const contentType = file.type || 'application/octet-stream'
  if (file.size < SMALL) {
    await graph(accountId, base, {
      method: 'POST',
      body: {
        '@odata.type': kind === 'todo' ? '#microsoft.graph.taskFileAttachment' : '#microsoft.graph.fileAttachment',
        name: file.name,
        contentType,
        contentBytes: await fileToBase64(file),
      },
    })
    onProgress?.(1)
    return
  }
  const session = await graph<{ uploadUrl: string }>(accountId, `${base}/createUploadSession`, {
    method: 'POST',
    body:
      kind === 'todo'
        ? { attachmentInfo: { attachmentType: 'file', name: file.name, size: file.size, contentType } }
        : { AttachmentItem: { attachmentType: 'file', name: file.name, size: file.size, contentType: file.type || undefined } },
  })
  await sendToSession(session.uploadUrl, file, onProgress)
}

interface GFile {
  '@odata.type'?: string
  id: string
  name?: string
  size?: number
  contentType?: string
  isInline?: boolean
}

/** The files of a Graph event or To Do task, at `base` (ending with `/attachments`). */
export function graphFileStore(accountId: string, base: string, kind: 'outlook' | 'todo', maxSize: number): FileStore {
  return {
    maxSize,
    async list() {
      // Without $select, event attachments come with their whole content.
      const select = kind === 'todo' ? '' : '?$select=id,name,size,contentType,isInline'
      const out: ItemFile[] = []
      let next: string | undefined = base + select
      while (next) {
        const page: GraphPage<GFile> = await graph<GraphPage<GFile>>(accountId, next)
        for (const f of page.value) {
          // Outlook items and links attached to events aren't files we can open.
          if (f.isInline || (f['@odata.type'] && !/fileAttachment$/i.test(f['@odata.type']))) continue
          out.push({ id: f.id, name: f.name || 'file', size: f.size ?? 0, contentType: f.contentType || 'application/octet-stream' })
        }
        next = page['@odata.nextLink']
      }
      return out
    },
    add: (file, onProgress) => uploadGraphFile(accountId, base, file, kind, onProgress),
    async remove(id) {
      await graph(accountId, `${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    async download(id) {
      const res = await graph<Response>(accountId, `${base}/${encodeURIComponent(id)}/$value`, { raw: true })
      return res.blob()
    },
  }
}
