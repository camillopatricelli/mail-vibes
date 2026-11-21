import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettings } from '../settings/store'
import { Button } from '../ui/components'
import { providerFor } from './api'
import { sanitizeEmail } from './html'
import type { MailMessage } from './types'

/**
 * Shows an email body in a sandboxed iframe: no scripts, no forms, no top navigation; links
 * open in a new tab. `allow-same-origin` (without `allow-scripts`) only lets us size the frame.
 */
export function MessageBody({ message }: { message: MailMessage }) {
  const { t } = useTranslation()
  const sender = message.from.email.toLowerCase()
  const allowedFrom = useSettings((s) => s.imagesAllowedFrom)
  const update = useSettings((s) => s.update)
  const [showImagesOnce, setShowImagesOnce] = useState(false)
  const [showQuoted, setShowQuoted] = useState(false)
  const allowRemote = showImagesOnce || allowedFrom.includes(sender)
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)

  const needsInline = /\bsrc\s*=\s*["']?cid:/i.test(message.bodyHtml)
  const inline = useQuery({
    queryKey: ['mail', 'inline', message.accountId, message.id],
    enabled: needsInline,
    staleTime: Infinity,
    queryFn: () => providerFor(message.accountId).inlineImages(message.accountId, message.id),
  })
  const inlineUrls = useMemo(() => {
    const m = new Map<string, string>()
    inline.data?.forEach((blob, cid) => m.set(cid, URL.createObjectURL(blob)))
    return m
  }, [inline.data])
  useEffect(() => () => inlineUrls.forEach((u) => URL.revokeObjectURL(u)), [inlineUrls])

  const result = useMemo(
    () => sanitizeEmail(message.bodyHtml, { allowRemoteImages: allowRemote, inlineImages: inlineUrls }),
    [message.bodyHtml, allowRemote, inlineUrls],
  )

  // Size the frame to its content, and keep it in sync with images loading or quotes toggling.
  useEffect(() => {
    const f = frame.current
    if (!f) return
    let ro: ResizeObserver | undefined
    const measure = () => {
      const doc = f.contentDocument
      if (!doc?.documentElement) return
      setHeight(Math.max(40, doc.documentElement.scrollHeight))
    }
    const onLoad = () => {
      const doc = f.contentDocument
      if (!doc) return
      const q = doc.querySelector<HTMLElement>('.mv-quoted')
      if (q) q.hidden = !showQuoted
      measure()
      ro = new ResizeObserver(measure)
      ro.observe(doc.documentElement)
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure))
    }
    f.addEventListener('load', onLoad)
    return () => {
      f.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [result.srcdoc, showQuoted])

  useEffect(() => {
    const q = frame.current?.contentDocument?.querySelector<HTMLElement>('.mv-quoted')
    if (q) q.hidden = !showQuoted
  }, [showQuoted])

  return (
    <div className="message-body">
      {result.blockedImages > 0 && !allowRemote && (
        <div className="images-blocked body-small">
          <span>{t('mail.imagesBlocked')}</span>
          <Button variant="text" onClick={() => setShowImagesOnce(true)}>
            {t('mail.showImages')}
          </Button>
          {sender && (
            <Button variant="text" onClick={() => update({ imagesAllowedFrom: [...allowedFrom, sender] })}>
              {t('mail.alwaysShowImagesFrom', { sender })}
            </Button>
          )}
        </div>
      )}
      <iframe
        ref={frame}
        title={message.subject || t('mail.noSubject')}
        className="message-frame"
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={result.srcdoc}
        style={{ height }}
      />
      {result.hasQuoted && (
        <button
          type="button"
          className="quoted-toggle"
          aria-expanded={showQuoted}
          title={showQuoted ? t('mail.hideQuoted') : t('mail.showQuoted')}
          aria-label={showQuoted ? t('mail.hideQuoted') : t('mail.showQuoted')}
          onClick={() => setShowQuoted((s) => !s)}
        >
          •••
        </button>
      )}
    </div>
  )
}
