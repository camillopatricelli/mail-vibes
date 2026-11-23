import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileSize } from '../lib/format'
import { queryClient } from '../lib/queryClient'
import { FileChips } from '../mail/Attachments'
import type { FileStore, ItemFile } from '../providers/graphFiles'
import { Button, Icon, IconButton } from '../ui/components'
import { Spinner } from '../ui/overlay'
import type { EventLink } from './types'

/** Files of events and tasks (Microsoft 365), and links to Drive files (Google). */

const filesKey = (accountId: string, itemId: string) => ['files', accountId, itemId]

/** The files of an existing event or task, loaded only when it has some. */
function useItemFiles(store: FileStore | undefined, accountId: string, itemId: string | undefined, hasFiles: boolean) {
  return useQuery({
    queryKey: filesKey(accountId, itemId ?? ''),
    enabled: !!store && !!itemId && hasFiles,
    staleTime: 60_000,
    queryFn: () => store!.list(),
  })
}

/** Read-only files of an event or task, to open or download. */
export function FilesView({ store, accountId, itemId }: { store: FileStore; accountId: string; itemId: string }) {
  const { t } = useTranslation()
  const files = useItemFiles(store, accountId, itemId, true)
  if (files.isLoading) return <Spinner size={20} label={t('files.loading')} />
  if (files.error) return <p className="field-error body-small">{t('files.loadFailed', { reason: (files.error as Error).message })}</p>
  return <FileChips className="attachments--plain" files={files.data ?? []} download={(f) => store.download(f.id)} />
}

export interface StagedFiles {
  /** Files already on the item, minus those to remove */
  kept: ItemFile[]
  pending: File[]
  loading: boolean
  error?: string
  changed: boolean
  add: (files: File[]) => void
  remove: (id: string) => void
  unqueue: (index: number) => void
  /** Uploads the new files and deletes the removed ones (after the item is saved) */
  apply: (store: FileStore, accountId: string, itemId: string, onProgress?: (text: string) => void) => Promise<void>
}

/** Files added and removed in a form, applied on Save. */
export function useStagedFiles(store: FileStore | undefined, accountId: string, itemId: string | undefined, hasFiles: boolean): StagedFiles {
  const { t } = useTranslation()
  const files = useItemFiles(store, accountId, itemId, hasFiles)
  const [removed, setRemoved] = useState<string[]>([])
  const [pending, setPending] = useState<File[]>([])
  const kept = (files.data ?? []).filter((f) => !removed.includes(f.id))
  return {
    kept,
    pending,
    loading: files.isLoading,
    error: files.error ? t('files.loadFailed', { reason: (files.error as Error).message }) : undefined,
    changed: removed.length > 0 || pending.length > 0,
    add: (more) => setPending((p) => [...p, ...more]),
    remove: (id) => setRemoved((r) => [...r, id]),
    unqueue: (index) => setPending((p) => p.filter((_, i) => i !== index)),
    async apply(target, account, id, onProgress) {
      for (const fid of removed) await target.remove(fid)
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i]
        const label = pending.length > 1 ? `${i + 1}/${pending.length} · ${f.name}` : f.name
        onProgress?.(t('files.uploading', { name: label, percent: 0 }))
        try {
          await target.add(f, (x) => onProgress?.(t('files.uploading', { name: label, percent: Math.round(x * 100) })))
        } catch (e) {
          throw new Error(t('files.uploadFailed', { name: f.name, reason: (e as Error).message }))
        }
      }
      setRemoved([])
      setPending([])
      await queryClient.invalidateQueries({ queryKey: filesKey(account, id) })
    },
  }
}

/** The files part of an event or task form. */
export function FilesField({ staged, store }: { staged: StagedFiles; store: FileStore }) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [tooBig, setTooBig] = useState('')
  return (
    <div className="event-form__row item-files">
      <Icon name="attach_file" />
      <div className="event-form__grow item-files__body">
        {staged.loading && <Spinner size={20} label={t('files.loading')} />}
        {staged.error && <p className="field-error body-small">{staged.error}</p>}
        <FileChips className="attachments--plain" files={staged.kept} download={(f) => store.download(f.id)} onRemove={(f) => staged.remove(f.id)} />
        {staged.pending.length > 0 && (
          <ul className="attachments attachments--plain" aria-label={t('files.toAdd')}>
            {staged.pending.map((f, i) => (
              <li key={`${f.name}-${i}`} className="attachment attachment--pending">
                <span className="attachment__main">
                  <Icon name="upload" />
                  <span className="attachment__name body-medium">{f.name}</span>
                  <span className="attachment__size body-small muted">{fileSize(f.size)}</span>
                </span>
                <IconButton icon="close" label={t('files.remove', { name: f.name })} onClick={() => staged.unqueue(i)} />
              </li>
            ))}
          </ul>
        )}
        <div className="row-wrap">
          <Button variant="text" icon="attach_file" onClick={() => input.current?.click()}>
            {t('files.add')}
          </Button>
          {staged.pending.length > 0 && <span className="body-small muted">{t('files.onSave')}</span>}
        </div>
        {tooBig && (
          <p className="field-error body-small" role="alert">
            {tooBig}
          </p>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const all = [...(e.target.files ?? [])]
            e.target.value = ''
            const big = all.filter((f) => f.size > store.maxSize)
            setTooBig(big.length ? t('files.tooBig', { name: big.map((f) => f.name).join(', '), max: fileSize(store.maxSize) }) : '')
            staged.add(all.filter((f) => f.size <= store.maxSize))
          }}
        />
      </div>
    </div>
  )
}

const isWebUrl = (s: string) => /^https:\/\/\S+$/i.test(s.trim())

/** Links to files (Google Drive), shown read-only. */
export function LinksView({ links }: { links: EventLink[] }) {
  const { t } = useTranslation()
  if (!links.length) return null
  return (
    <ul className="item-links" aria-label={t('files.links')}>
      {links.map((l) => (
        <li key={l.url}>
          <a href={l.url} target="_blank" rel="noopener noreferrer" className="item-links__link body-medium">
            {l.iconLink ? <img src={l.iconLink} alt="" width={16} height={16} referrerPolicy="no-referrer" /> : <Icon name="link" size={18} />}
            <span>{l.title || l.url}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

/** Adds a link to a file that is already online (a Google Drive file, usually). */
export function AddLink({ onAdd, label }: { onAdd: (link: EventLink) => void; label?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  if (!open)
    return (
      <Button variant="text" icon="link" onClick={() => setOpen(true)}>
        {label ?? t('files.addLink')}
      </Button>
    )
  const add = () => {
    if (!isWebUrl(url)) return setError(t('files.badLink'))
    onAdd({ url: url.trim(), title: title.trim() || url.trim() })
    setUrl('')
    setTitle('')
    setError('')
    setOpen(false)
  }
  return (
    <div className="item-links__add">
      <input
        className="text-field text-field--outlined"
        type="url"
        value={url}
        autoFocus
        placeholder={t('files.linkUrl')}
        aria-label={t('files.linkUrl')}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
      />
      <input
        className="text-field text-field--outlined"
        value={title}
        placeholder={t('files.linkName')}
        aria-label={t('files.linkName')}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
      />
      <div className="row-wrap">
        <Button variant="tonal" onClick={add} disabled={!url.trim()}>
          {t('files.addLinkButton')}
        </Button>
        <Button variant="text" onClick={() => setOpen(false)}>
          {t('calendar.cancel')}
        </Button>
      </div>
      <p className="body-small muted">{t('files.driveHint')}</p>
      {error && (
        <p className="field-error body-small" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The links part of a Google event form. */
export function LinksField({ value, onChange }: { value: EventLink[]; onChange: (links: EventLink[]) => void }) {
  const { t } = useTranslation()
  return (
    <div className="event-form__row item-files">
      <Icon name="attach_file" />
      <div className="event-form__grow item-files__body">
        {value.length > 0 && (
          <ul className="item-links" aria-label={t('files.links')}>
            {value.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="item-links__link body-medium">
                  <Icon name="link" size={18} />
                  <span>{l.title || l.url}</span>
                </a>
                <IconButton icon="close" label={t('files.remove', { name: l.title || l.url })} onClick={() => onChange(value.filter((x) => x !== l))} />
              </li>
            ))}
          </ul>
        )}
        <AddLink onAdd={(l) => onChange(value.some((x) => x.url === l.url) ? value : [...value, l])} />
      </div>
    </div>
  )
}

/** Web links found in a text (task notes), for a clickable list. */
export function linksIn(text: string): EventLink[] {
  const out: EventLink[] = []
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/https:\/\/[^\s<>"]+/g)) {
      const url = m[0].replace(/[).,;]+$/, '')
      if (out.some((l) => l.url === url)) continue
      // "Name: https://…" on its own line names the link.
      const before = line.slice(0, m.index).trim().replace(/[:\-–]\s*$/, '').trim()
      out.push({ url, title: before && before.length <= 120 ? before : url })
    }
  }
  return out
}
