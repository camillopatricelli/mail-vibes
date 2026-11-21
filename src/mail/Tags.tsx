import { useMemo, useState } from 'react'
import { consentScopes, MAILBOX_SCOPES } from '../auth/msal'
import { queryClient } from '../lib/queryClient'
import { useStatus } from '../status/store'
import { outlookNeedsCategoryConsent } from './outlook'
import { useTranslation } from 'react-i18next'
import { Button, Icon } from '../ui/components'
import { Dialog } from '../ui/overlay'
import { mailActions, uniqueTags, useAllTags, type MergedTag } from './data'
import type { MailSummary } from './types'

const FALLBACK = ['#1a73e8', '#188038', '#e37400', '#a142f4', '#d93025', '#12b5cb', '#e52592', '#5f6368']

/** A tag's colour: the provider's, else a stable colour derived from the name. */
export function tagColor(name: string, tags: MergedTag[]) {
  const own = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.color
  if (own) return own
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0
  return FALLBACK[Math.abs(h) % FALLBACK.length]
}

export function TagChip({ name, tags, onRemove }: { name: string; tags: MergedTag[]; onRemove?: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="tag-chip label-small" style={{ ['--tag' as string]: tagColor(name, tags) }} title={name}>
      <span className="tag-chip__name">{name}</span>
      {onRemove && (
        <button type="button" className="tag-chip__remove" onClick={onRemove} aria-label={t('tags.remove', { tag: name })} title={t('tags.remove', { tag: name })}>
          <Icon name="close" size={14} />
        </button>
      )}
    </span>
  )
}

/** Offers the mailbox-settings permission for Outlook accounts that can't read their category list. */
function CategoryConsent({ accountIds }: { accountIds: string[] }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const pending = accountIds.filter(outlookNeedsCategoryConsent)
  if (!pending.length) return null
  const ask = async () => {
    setBusy(true)
    try {
      for (const id of pending) await consentScopes(id, MAILBOX_SCOPES)
      await queryClient.invalidateQueries({ queryKey: ['mail', 'tags'] })
    } catch (e) {
      useStatus.getState().toast({ tone: 'error', message: t('tags.consentFailed', { reason: (e as Error).message }) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className="body-small muted tag-dialog__consent">
      {t('tags.outlookConsentHint')}{' '}
      <Button variant="text" onClick={() => void ask()} disabled={busy}>
        {t('tags.outlookConsent')}
      </Button>
    </p>
  )
}

type Choice = Map<string, boolean>

/** Picks the tags of some messages: ticked tags are added, unticked ones removed. */
export function TagDialog({ messages, onClose }: { messages: MailSummary[]; onClose: () => void }) {
  const { t } = useTranslation()
  const all = useAllTags()
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState<Choice>(new Map())
  const [created, setCreated] = useState<string[]>([])

  const initial = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of messages) for (const n of uniqueTags(m.tags)) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) ?? 0) + 1)
    return (name: string) => {
      const c = counts.get(name.toLowerCase()) ?? 0
      return c === 0 ? 'none' : c === messages.length ? 'all' : 'some'
    }
  }, [messages])

  const names = uniqueTags([...created, ...all.map((x) => x.name), ...messages.flatMap((m) => m.tags)])
  const q = query.trim().toLowerCase()
  const shown = names.filter((n) => n.toLowerCase().includes(q))
  const canCreate = !!q && !names.some((n) => n.toLowerCase() === q)
  const isChecked = (n: string) => choice.get(n.toLowerCase()) ?? initial(n) === 'all'
  const set = (n: string, v: boolean) => setChoice((c) => new Map(c).set(n.toLowerCase(), v))

  const create = () => {
    const name = query.trim().replace(/\s+/g, ' ')
    if (!name) return
    setCreated((c) => [name, ...c])
    set(name, true)
    setQuery('')
  }

  const apply = () => {
    const add = names.filter((n) => choice.get(n.toLowerCase()) === true && initial(n) !== 'all')
    const remove = names.filter((n) => choice.get(n.toLowerCase()) === false && initial(n) !== 'none')
    onClose()
    if (add.length || remove.length) void mailActions.setTags(messages, add, remove)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tags.title')}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('calendar.cancel')}
          </Button>
          <Button onClick={apply} icon="check">
            {t('tags.apply')}
          </Button>
        </>
      }
    >
      <div className="tag-dialog">
        <input
          className="select tag-dialog__search"
          placeholder={t('tags.searchOrCreate')}
          aria-label={t('tags.searchOrCreate')}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (canCreate) create()
            else if (shown.length === 1) set(shown[0], !isChecked(shown[0]))
          }}
        />
        <ul className="tag-dialog__list">
          {canCreate && (
            <li>
              <button type="button" className="tag-dialog__create body-medium" onClick={create}>
                <Icon name="add" size={20} />
                {t('tags.create', { tag: query.trim() })}
              </button>
            </li>
          )}
          {shown.map((n) => (
            <li key={n.toLowerCase()}>
              <label className="tag-dialog__item body-medium">
                <input
                  type="checkbox"
                  checked={isChecked(n)}
                  ref={(el) => {
                    if (el) el.indeterminate = !choice.has(n.toLowerCase()) && initial(n) === 'some'
                  }}
                  onChange={(e) => set(n, e.target.checked)}
                />
                <span className="tag-dialog__dot" style={{ background: tagColor(n, all) }} />
                <span className="tag-dialog__name">{n}</span>
              </label>
            </li>
          ))}
          {!shown.length && !canCreate && <li className="body-medium muted tag-dialog__empty">{t('tags.none')}</li>}
        </ul>
        {messages.some((m) => m.accountId.startsWith('google:')) && <p className="body-small muted">{t('tags.gmailHint')}</p>}
        <CategoryConsent accountIds={[...new Set(messages.map((m) => m.accountId))]} />
      </div>
    </Dialog>
  )
}
