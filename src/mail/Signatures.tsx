import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { accountLongLabel, useSettings } from '../settings/store'
import { MAX_SIGNATURE_HTML, MAX_SIGNATURE_NAME, MAX_SIGNATURES, type Signature } from '../settings/signatureData'
import { useStatus } from '../status/store'
import { Button, IconButton } from '../ui/components'
import { canSend, isMailCapable } from './api'
import { cleanSignatureHtml } from './html'

type FieldComponent = ComponentType<{ label: string; children: ReactNode }>

/** Formatted text editor for one signature; saves when it loses focus. */
function SignatureEditor({ sig, onSave }: { sig: Signature; onSave: (html: string) => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sig.html
    // Only when another signature is opened: typing must not reset the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig.id])

  const save = () => {
    const raw = ref.current?.innerHTML ?? ''
    const html = cleanSignatureHtml(raw)
    if ((raw.match(/<img/gi) ?? []).length > (html.match(/<img/gi) ?? []).length) {
      useStatus.getState().toast({ tone: 'info', message: t('signatures.pastedImage') })
      if (ref.current) ref.current.innerHTML = html
    }
    if (html.length > MAX_SIGNATURE_HTML) return useStatus.getState().toast({ tone: 'error', message: t('signatures.tooLong') })
    if (html !== sig.html) onSave(html)
  }
  const cmd = (name: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(name, false, arg)
  }
  const ask = (question: string) => {
    const url = prompt(question, 'https://')?.trim()
    return url && /^https?:\/\/\S+$/i.test(url) ? url : undefined
  }
  const tools: { text?: string; icon?: 'link' | 'image'; label: string; run: () => void }[] = [
    { text: 'B', label: t('compose.bold'), run: () => cmd('bold') },
    { text: 'I', label: t('compose.italic'), run: () => cmd('italic') },
    { text: 'U', label: t('compose.underline'), run: () => cmd('underline') },
    {
      icon: 'link',
      label: t('compose.link'),
      run: () => {
        const url = prompt(t('compose.linkPrompt'), 'https://')?.trim()
        if (url && /^(https?:|mailto:)/i.test(url)) cmd('createLink', url)
      },
    },
    {
      icon: 'image',
      label: t('signatures.image'),
      run: () => {
        const url = ask(t('signatures.imagePrompt'))
        if (url) cmd('insertImage', url)
      },
    },
  ]
  return (
    <div className="signature-editor" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && save()}>
      <div ref={ref} className="editor signature-editor__text" contentEditable role="textbox" aria-multiline="true" aria-label={t('signatures.text', { name: sig.name })} />
      <div className="editor-toolbar" role="toolbar" aria-label={t('compose.formatting')}>
        {tools.map((tool) =>
          tool.icon ? (
            <IconButton key={tool.label} icon={tool.icon} label={tool.label} onMouseDown={(e) => e.preventDefault()} onClick={tool.run} />
          ) : (
            <button key={tool.label} type="button" className="icon-btn format-btn" title={tool.label} onMouseDown={(e) => e.preventDefault()} onClick={tool.run}>
              <span aria-hidden>{tool.text}</span>
              <span className="visually-hidden">{tool.label}</span>
            </button>
          ),
        )}
      </div>
    </div>
  )
}

/** Settings → Signatures: the signatures, and which one each account adds by itself. */
export function SignatureSettings({ Field }: { Field: FieldComponent }) {
  const { t } = useTranslation()
  const signatures = useSettings((s) => s.signatures)
  const defaults = useSettings((s) => s.signatureDefaults)
  const accounts = useSettings((s) => s.accounts).filter((a) => isMailCapable(a.id) && canSend(a.id))
  const update = useSettings((s) => s.update)
  const removeSignature = useSettings((s) => s.removeSignature)
  const [open, setOpen] = useState<string | null>(null)

  const change = (id: string, patch: Partial<Signature>) => update({ signatures: useSettings.getState().signatures.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const add = () => {
    const sig: Signature = { id: crypto.randomUUID(), name: t('signatures.newName', { n: signatures.length + 1 }), html: '' }
    update({ signatures: [...signatures, sig] })
    setOpen(sig.id)
  }
  const setDefault = (accountId: string, id: string, replies: boolean) => {
    const next = { ...defaults }
    if (id) next[accountId] = { id, replies }
    else delete next[accountId]
    update({ signatureDefaults: next })
  }

  return (
    <>
      {signatures.map((s) => (
        <div key={s.id} className="signature-row">
          <div className="signature-row__head">
            <input
              className="text-field title-small signature-row__name"
              defaultValue={s.name}
              maxLength={MAX_SIGNATURE_NAME}
              aria-label={t('signatures.name')}
              onBlur={(e) => {
                const name = e.target.value.trim()
                if (name && name !== s.name) change(s.id, { name })
                else e.target.value = s.name
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <IconButton
              icon={open === s.id ? 'keyboard_arrow_up' : 'edit'}
              label={open === s.id ? t('signatures.close') : t('signatures.edit', { name: s.name })}
              onClick={() => setOpen(open === s.id ? null : s.id)}
            />
            <IconButton
              icon="delete"
              label={t('signatures.remove', { name: s.name })}
              onClick={() => {
                if (confirm(t('signatures.confirmRemove', { name: s.name }))) removeSignature(s.id)
              }}
            />
          </div>
          {open === s.id && <SignatureEditor sig={s} onSave={(html) => change(s.id, { html })} />}
        </div>
      ))}
      {signatures.length < MAX_SIGNATURES && (
        <div>
          <Button variant="tonal" icon="add" onClick={add}>
            {t('signatures.add')}
          </Button>
        </div>
      )}
      {signatures.length > 0 &&
        accounts.map((a) => {
          const d = defaults[a.id]
          return (
            <Field key={a.id} label={t('signatures.defaultFor', { account: accountLongLabel(a) })}>
              <div className="row-wrap">
                <select className="select" value={d?.id ?? ''} onChange={(e) => setDefault(a.id, e.target.value, d?.replies ?? false)}>
                  <option value="">{t('signatures.noDefault')}</option>
                  {signatures.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {d && (
                  <label className="body-medium signature-replies">
                    <input type="checkbox" checked={d.replies} onChange={(e) => setDefault(a.id, d.id, e.target.checked)} />
                    {t('signatures.onReplies')}
                  </label>
                )}
              </div>
            </Field>
          )
        })}
    </>
  )
}
