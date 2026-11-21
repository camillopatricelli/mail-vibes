import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileSize } from '../lib/format'
import { useStatus } from '../status/store'
import { Button, Icon, IconButton, type IconName } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { providerFor } from './api'
import type { Attachment } from './types'

const isPdf = (a: Attachment) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name)
const isImage = (a: Attachment) => a.contentType.startsWith('image/') && !/svg/i.test(a.contentType)

function iconFor(a: Attachment): IconName {
  if (isPdf(a)) return 'picture_as_pdf'
  if (isImage(a)) return 'image'
  return 'description'
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Renders a PDF with pdf.js (loaded on demand, assets served from our own origin). */
function PdfView({ blob }: { blob: Blob }) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState(0)

  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | undefined
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        const base = `${import.meta.env.BASE_URL}pdfjs/`
        const task = pdfjs.getDocument({
          data: new Uint8Array(await blob.arrayBuffer()),
          enableXfa: false,
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
        })
        destroy = () => void task.destroy()
        const doc = await task.promise
        if (cancelled) return
        setPages(doc.numPages)
        const container = host.current!
        const width = Math.min(container.clientWidth - 16, 1000)
        for (let i = 1; i <= doc.numPages && !cancelled; i++) {
          const page = await doc.getPage(i)
          const unscaled = page.getViewport({ scale: 1 })
          const scale = width / unscaled.width
          const ratio = window.devicePixelRatio || 1
          const viewport = page.getViewport({ scale: scale * ratio })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = `${viewport.width / ratio}px`
          canvas.style.height = `${viewport.height / ratio}px`
          canvas.className = 'pdf-page'
          canvas.setAttribute('aria-label', t('mail.pdfPage', { page: i, total: doc.numPages }))
          container.appendChild(canvas)
          await page.render({ canvas, viewport }).promise
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
      destroy?.()
      if (host.current) host.current.innerHTML = ''
    }
  }, [blob, t])

  return (
    <div className="pdf-view" ref={host}>
      {!pages && !error && <Spinner label={t('mail.loading')} />}
      {error && (
        <p className="field-error" role="alert">
          {t('mail.previewFailed', { reason: error })}
        </p>
      )}
    </div>
  )
}

export function AttachmentList({ accountId, messageId, attachments }: { accountId: string; messageId: string; attachments: Attachment[] }) {
  const { t } = useTranslation()
  const toast = useStatus((s) => s.toast)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ att: Attachment; blob: Blob; url: string } | null>(null)

  const fetchBlob = async (a: Attachment) => {
    setBusy(a.id)
    try {
      return await providerFor(accountId).downloadAttachment(accountId, messageId, a.id)
    } catch (e) {
      toast({ tone: 'error', message: t('mail.downloadFailed', { name: a.name, reason: (e as Error).message }) })
      return null
    } finally {
      setBusy(null)
    }
  }

  const open = async (a: Attachment) => {
    const blob = await fetchBlob(a)
    if (!blob) return
    if (isPdf(a) || isImage(a)) {
      setPreview({ att: a, blob, url: URL.createObjectURL(blob) })
    } else {
      // Office files and everything else: download, and the OS opens them with the right app.
      saveBlob(blob, a.name)
    }
  }

  const visible = attachments.filter((a) => !a.isInline)
  if (!visible.length) return null
  return (
    <>
      <ul className="attachments" aria-label={t('mail.attachments')}>
        {visible.map((a) => (
          <li key={a.id} className="attachment">
            <button type="button" className="attachment__main" onClick={() => void open(a)} disabled={busy === a.id} title={a.name}>
              {busy === a.id ? <Spinner size={20} /> : <Icon name={iconFor(a)} />}
              <span className="attachment__name body-medium">{a.name}</span>
              <span className="attachment__size body-small muted">{fileSize(a.size)}</span>
            </button>
            <IconButton
              icon="download"
              label={`${t('mail.download')} ${a.name}`}
              disabled={busy === a.id}
              onClick={async () => {
                const blob = await fetchBlob(a)
                if (blob) saveBlob(blob, a.name)
              }}
            />
          </li>
        ))}
      </ul>
      <Dialog
        open={!!preview}
        fullscreen
        onClose={() => {
          if (preview) URL.revokeObjectURL(preview.url)
          setPreview(null)
        }}
        title={preview?.att.name}
        actions={
          preview && (
            <Button variant="tonal" icon="download" onClick={() => saveBlob(preview.blob, preview.att.name)}>
              {t('mail.download')}
            </Button>
          )
        }
      >
        {preview && (isPdf(preview.att) ? <PdfView blob={preview.blob} /> : <img className="image-preview" src={preview.url} alt={preview.att.name} />)}
      </Dialog>
    </>
  )
}
