import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { fileSize } from '../lib/format'
import { useSettings } from '../settings/store'
import { Button, Icon, IconButton } from '../ui/components'
import { Spinner } from '../ui/overlay'
import { isMailCapable } from './api'
import { formatAddress, isValidEmail, parseAddresses, suggestAddresses } from './addressBook'
import {
  attachFiles,
  changeAccount,
  closeKeep,
  discard,
  prepareReply,
  removeAttachment,
  saveNow,
  send,
  updateContent,
  useCompose,
  type Composer,
} from './compose'
import { SnoozeDialog } from './SnoozeDialog'
import type { Address } from './types'

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  placeholder,
  boxed,
}: {
  label: string
  value: Address[]
  onChange: (v: Address[]) => void
  autoFocus?: boolean
  placeholder?: string
  /** Drawn as an outlined box (forms) instead of a line (composer) */
  boxed?: boolean
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const suggestions = suggestAddresses(text, value)

  const commit = (raw = text) => {
    const parsed = parseAddresses(raw)
    if (parsed.length) onChange([...value, ...parsed])
    setText('')
  }
  const pick = (a: Address) => {
    onChange([...value, a])
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
    } else if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (suggestions.length && text && e.key !== ',' && e.key !== ';') {
        e.preventDefault()
        pick(suggestions[Math.min(active, suggestions.length - 1)])
      } else if (text.trim()) {
        e.preventDefault()
        commit()
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className={['recipient-field', boxed && 'recipient-field--boxed'].filter(Boolean).join(' ')}>
      {!boxed && <span className="recipient-field__label body-medium muted">{label}</span>}
      <div className="recipient-field__chips">
        {value.map((a, i) => (
          <span key={`${a.email}-${i}`} className={['recipient-chip', !isValidEmail(a.email) && 'is-invalid'].filter(Boolean).join(' ')} title={formatAddress(a)}>
            <span>{a.name || a.email}</span>
            <button type="button" aria-label={t('compose.removeRecipient', { who: a.email })} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Icon name="close" size={16} />
            </button>
          </span>
        ))}
        <input
          className="recipient-field__input"
          value={text}
          autoFocus={autoFocus}
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKey}
          onBlur={() => text.trim() && commit()}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault()
              commit(text + pasted)
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((a, i) => (
            <li key={a.email} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(a)} className={i === active ? 'is-active' : undefined}>
                <span className="body-medium">{a.name || a.email}</span>
                {a.name && <span className="body-small muted">{a.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Editor({ c }: { c: Composer }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const loaded = useRef('')
  // Load initial HTML once (and again if a draft finished loading).
  useEffect(() => {
    if (ref.current && loaded.current !== c.initialHtml) {
      ref.current.innerHTML = c.initialHtml
      loaded.current = c.initialHtml
    }
  }, [c.initialHtml])

  const cmd = (name: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(name, false, arg)
    updateContent(c.id, { html: ref.current?.innerHTML ?? '' })
  }
  const tools: { icon: Parameters<typeof Icon>[0]['name'] | null; label: string; run: () => void; text?: string }[] = [
    { icon: null, text: 'B', label: t('compose.bold'), run: () => cmd('bold') },
    { icon: null, text: 'I', label: t('compose.italic'), run: () => cmd('italic') },
    { icon: null, text: 'U', label: t('compose.underline'), run: () => cmd('underline') },
    { icon: null, text: '•', label: t('compose.bullets'), run: () => cmd('insertUnorderedList') },
    { icon: null, text: '1.', label: t('compose.numbers'), run: () => cmd('insertOrderedList') },
    {
      icon: 'link',
      label: t('compose.link'),
      run: () => {
        const url = prompt(t('compose.linkPrompt'), 'https://')
        if (url && /^(https?:|mailto:)/i.test(url)) cmd('createLink', url)
      },
    },
  ]
  return (
    <>
      <div
        ref={ref}
        className="editor"
        contentEditable={c.phase !== 'sending'}
        role="textbox"
        aria-multiline="true"
        aria-label={t('compose.body')}
        onInput={(e) => updateContent(c.id, { html: (e.target as HTMLDivElement).innerHTML })}
      />
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
    </>
  )
}

function SaveState({ c }: { c: Composer }) {
  const { t } = useTranslation()
  if (c.saveState === 'saving') return <span className="body-small muted">{t('compose.saving')}</span>
  if (c.saveState === 'saved' && c.draft) return <span className="body-small muted">{t('compose.saved')}</span>
  if (c.saveState === 'error')
    return (
      <span className="body-small save-error" role="alert">
        {t('compose.saveFailed', { reason: c.saveError })}{' '}
        <button type="button" className="link-btn" onClick={() => void saveNow(c.id).catch(() => undefined)}>
          {t('banner.retry')}
        </button>
      </span>
    )
  return null
}

function ComposerWindow({ c }: { c: Composer }) {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts).filter((a) => isMailCapable(a.id))
  const account = accounts.find((a) => a.id === c.accountId)
  const patch = useCompose((s) => s.patch)
  const [showCcBcc, setShowCcBcc] = useState(c.content.cc.length > 0 || c.content.bcc.length > 0)
  const fileInput = useRef<HTMLInputElement>(null)
  const [pickingTime, setPickingTime] = useState(false)
  const title =
    c.content.subject ||
    (c.mode === 'new' ? t('compose.newMessage') : c.mode === 'forward' ? t('mail.forward') : c.mode === 'draft' ? t('mail.draft') : t('mail.reply'))
  const busy = c.phase !== 'ready'

  return (
    <section className={['composer', c.minimized && 'is-minimized'].filter(Boolean).join(' ')} aria-label={title} style={{ borderTopColor: account?.color }}>
      <header className="composer__head" onClick={() => c.minimized && patch(c.id, { minimized: false })}>
        <span className="title-small composer__title">{title}</span>
        <IconButton
          icon={c.minimized ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}
          label={c.minimized ? t('compose.expand') : t('compose.minimize')}
          onClick={(e) => {
            e.stopPropagation()
            patch(c.id, { minimized: !c.minimized })
          }}
        />
        <IconButton
          icon="close"
          label={t('compose.saveClose')}
          disabled={c.phase === 'sending'}
          onClick={(e) => {
            e.stopPropagation()
            void closeKeep(c.id)
          }}
        />
      </header>
      {!c.minimized && (
        <div className="composer__body">
          {c.error && (
            <div className="banner banner--error composer__error" role="alert">
              <Icon name="error" />
              <div className="banner__text">
                <p className="body-medium">{c.error}</p>
              </div>
              {c.phase === 'ready' && c.mode !== 'new' && c.mode !== 'draft' && !c.draft ? (
                <Button variant="text" onClick={() => void prepareReply(c.id)}>
                  {t('banner.retry')}
                </Button>
              ) : null}
            </div>
          )}
          <div className="composer__from">
            <span className="body-medium muted">{t('compose.from')}</span>
            {c.mode === 'new' && accounts.length > 1 ? (
              <select
                className="select select--plain"
                value={c.accountId}
                disabled={busy}
                onChange={(e) => void changeAccount(c.id, e.target.value)}
                aria-label={t('compose.from')}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName && a.displayName !== a.email ? `${a.displayName} <${a.email}>` : a.email}
                  </option>
                ))}
              </select>
            ) : (
              <span className="body-medium">{account ? account.email : c.accountId}</span>
            )}
          </div>
          <RecipientField label={t('compose.to')} value={c.content.to} onChange={(to) => updateContent(c.id, { to })} autoFocus={c.mode === 'new' || c.mode === 'forward'} />
          {!showCcBcc && (
            <button type="button" className="link-btn cc-toggle body-small" onClick={() => setShowCcBcc(true)}>
              {t('compose.ccBcc')}
            </button>
          )}
          {showCcBcc && (
            <>
              <RecipientField label={t('compose.cc')} value={c.content.cc} onChange={(cc) => updateContent(c.id, { cc })} />
              <RecipientField label={t('compose.bcc')} value={c.content.bcc} onChange={(bcc) => updateContent(c.id, { bcc })} />
            </>
          )}
          <input
            className="composer__subject"
            placeholder={t('compose.subject')}
            aria-label={t('compose.subject')}
            value={c.content.subject}
            disabled={busy}
            onChange={(e) => updateContent(c.id, { subject: e.target.value })}
          />
          {c.phase === 'preparing' ? (
            <div className="composer__preparing">
              <Spinner label={t('mail.loading')} />
            </div>
          ) : (
            <Editor c={c} />
          )}
          {c.draft?.quotedHtml && <p className="body-small muted composer__quote-note">{t('compose.quoteIncluded')}</p>}
          {(c.attachments.length > 0 || c.uploads.length > 0) && (
            <ul className="composer__attachments">
              {c.attachments.map((a) => (
                <li key={a.id} className="composer-attachment">
                  <Icon name="attach_file" size={18} />
                  <span className="body-small">{a.name}</span>
                  <span className="body-small muted">{fileSize(a.size)}</span>
                  <IconButton icon="close" label={t('compose.removeAttachment', { name: a.name })} disabled={busy} onClick={() => void removeAttachment(c.id, a.id)} />
                </li>
              ))}
              {c.uploads.map((u) => (
                <li key={u.id} className="composer-attachment">
                  <Spinner size={18} />
                  <span className="body-small">{u.name}</span>
                  <progress max={1} value={u.progress} aria-label={u.name} />
                </li>
              ))}
            </ul>
          )}
          <footer className="composer__foot">
            <Button variant="filled" icon="send" disabled={busy} onClick={() => void send(c.id)}>
              {c.phase === 'sending' ? t('compose.sending') : t('compose.send')}
            </Button>
            <IconButton icon="schedule_send" label={t('compose.sendLater')} disabled={busy} onClick={() => setPickingTime(true)} />
            <SnoozeDialog
              mode="send"
              open={pickingTime}
              onClose={() => setPickingTime(false)}
              onPick={(at) => {
                setPickingTime(false)
                void send(c.id, at)
              }}
            />
            <IconButton icon="attach_file" label={t('compose.attach')} disabled={busy} onClick={() => fileInput.current?.click()} />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                void attachFiles(c.id, files)
              }}
            />
            <SaveState c={c} />
            <span className="spacer" />
            <IconButton
              icon="delete"
              label={t('compose.discard')}
              disabled={c.phase === 'sending'}
              onClick={() => {
                if (c.saveState === 'clean' && !c.draft) void discard(c.id, true)
                else if (confirm(t('compose.confirmDiscard'))) void discard(c.id)
              }}
            />
          </footer>
        </div>
      )}
    </section>
  )
}

export function ComposerStack() {
  const composers = useCompose((s) => s.composers)
  // Warn before closing the tab while something is unsaved or sending.
  useEffect(() => {
    const unsaved = composers.some((c) => c.phase === 'sending' || c.saveState === 'dirty' || c.saveState === 'saving' || c.saveState === 'error' || c.uploads.length)
    if (!unsaved) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [composers])
  if (!composers.length) return null
  return (
    <div className="composer-stack">
      {composers.map((c) => (
        <ComposerWindow key={c.id} c={c} />
      ))}
    </div>
  )
}
