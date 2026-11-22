import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { reauthGoogle, preloadGoogle } from '../auth/google'
import { consentScopes, MAILBOX_SCOPES } from '../auth/msal'
import { queryClient } from '../lib/queryClient'
import { href, navigate } from '../lib/router'
import { accountLabel, useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { AccountBadge, Button, Card, Icon, IconButton } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'
import { hasRules } from './api'
import { mailAccounts, useFolders } from './data'
import {
  applyToExisting,
  deleteRule,
  findExisting,
  hasNoAction,
  isEmptySpec,
  listRules,
  providerRulesUrl,
  saveRule,
  type MailRule,
  type RuleMove,
  type RuleSpec,
} from './rules'
import type { MailFolder, MailSummary } from './types'

const rulesKey = (accountId: string) => ['mail', 'rules', accountId] as const

/** #/rules: each mail account's own rules (Gmail filters, Outlook rules). #/rules/new/<account>/<from> opens the form. */
export function RulesPage({ params }: { params: string[] }) {
  const { t } = useTranslation()
  const accounts = mailAccounts(useSettings((s) => s.accounts)).filter((a) => hasRules(a.id))
  // Loaded ahead of a click, so the Google permission popup is not blocked.
  useEffect(() => preloadGoogle(), [])
  const [editing, setEditing] = useState<{ accountId: string; rule?: MailRule; from?: string } | null>(null)
  useEffect(() => {
    if (params[0] === 'new' && params[1]) {
      setEditing({ accountId: params[1], from: params[2] })
      navigate('rules')
    }
  }, [params])
  return (
    <div className="settings rules">
      <h1 className="headline-small page-title">{t('rules.title')}</h1>
      <p className="body-medium muted">{t('rules.intro')}</p>
      {accounts.length === 0 && <p className="body-medium muted">{t('accounts.none')}</p>}
      {accounts.map((a) => (
        <AccountRules key={a.id} account={a} onEdit={(rule) => setEditing({ accountId: a.id, rule })} onAdd={() => setEditing({ accountId: a.id })} />
      ))}
      {editing && <RuleDialog key={editing.rule?.id ?? 'new'} {...editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function AccountRules({ account, onEdit, onAdd }: { account: AccountSettings; onEdit: (r: MailRule) => void; onAdd: () => void }) {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: rulesKey(account.id), queryFn: () => listRules(account.id), staleTime: 30_000 })
  const folders = useFolders(q.data?.rules.length ? account.id : undefined)
  const [busy, setBusy] = useState(false)
  const google = account.provider === 'google'
  const imap = account.provider === 'imap'

  const allow = async () => {
    setBusy(true)
    try {
      if (google) await reauthGoogle(account.id)
      else await consentScopes(account.id, MAILBOX_SCOPES)
      await queryClient.invalidateQueries({ queryKey: rulesKey(account.id) })
    } catch (e) {
      useStatus.getState().toast({ tone: 'error', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (r: MailRule) => {
    if (!confirm(t('rules.confirmDelete'))) return
    try {
      await deleteRule(r)
      await queryClient.invalidateQueries({ queryKey: rulesKey(account.id) })
    } catch (e) {
      useStatus.getState().toast({ tone: 'error', message: t('rules.deleteFailed', { reason: (e as Error).message }) })
    }
  }

  return (
    <Card className="settings__section">
      <h2 className="title-medium rules__account">
        <AccountBadge color={account.color} label={accountLabel(account)} size={20} />
        {accountLabel(account)}
        <span className="body-small muted">{account.email}</span>
      </h2>
      {imap && (
        <p className="body-small muted">
          {t('rules.imapNote')}
          {account.imap?.pec && ` ${t('rules.imapPecWords')}`}
        </p>
      )}
      {q.isPending ? (
        <Spinner size={24} label={t('mail.loading')} />
      ) : q.error ? (
        <p className="field-error" role="alert">
          {t('rules.loadFailed', { reason: (q.error as Error).message })}
        </p>
      ) : q.data.needsConsent ? (
        <div className="rules__consent">
          <p className="body-medium">{google ? t('rules.consentGoogle') : t('rules.consentOutlook')}</p>
          <Button variant="tonal" onClick={() => void allow()} disabled={busy}>
            {t('rules.allow')}
          </Button>
        </div>
      ) : (
        <>
          {q.data.rules.length === 0 ? (
            <p className="body-medium muted">{t('rules.none')}</p>
          ) : (
            <ul className="rules__list">
              {q.data.rules.map((r) => (
                <li key={r.id} className={['rule-row', !r.enabled && 'is-disabled'].filter(Boolean).join(' ')}>
                  <div className="rule-row__text">
                    {r.spec ? <RuleSummary spec={r.spec} folders={folders.data} /> : <span className="body-medium rule-row__raw">{r.label}</span>}
                    {!r.spec && (
                      <span className="body-small muted">
                        {google ? t('rules.readOnlyGoogle') : t('rules.readOnlyOutlook')}{' '}
                        <a href={providerRulesUrl(account.id)} target="_blank" rel="noopener noreferrer">
                          {google ? t('rules.openGmail') : t('rules.openOutlook')}
                        </a>
                      </span>
                    )}
                    {!r.enabled && <span className="body-small muted">{t('rules.disabled')}</span>}
                    {r.hasError && <span className="body-small field-error">{t('rules.hasError')}</span>}
                  </div>
                  {r.spec && <IconButton icon="edit" label={t('rules.edit')} onClick={() => onEdit(r)} />}
                  <IconButton icon="delete" label={t('rules.delete')} onClick={() => void remove(r)} />
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="tonal" icon="add" onClick={onAdd}>
              {t('rules.add')}
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** "From ann@example.com · containing "invoice" → mark as read, move to Clients". */
function RuleSummary({ spec, folders }: { spec: RuleSpec; folders?: MailFolder[] }) {
  const { t } = useTranslation()
  const when = [spec.from.trim() && t('rules.fromIs', { from: spec.from.trim() }), spec.words.trim() && t('rules.contains', { words: spec.words.trim() })].filter(Boolean)
  const m = spec.move
  const what = [
    spec.markRead && t('rules.doMarkRead'),
    m.kind === 'archive' && t('rules.doArchive'),
    m.kind === 'delete' && t('rules.doDelete'),
    m.kind === 'folder' && t('rules.doMove', { folder: folders?.find((f) => f.id === m.id)?.name ?? '…' }),
  ].filter(Boolean)
  return (
    <span className="body-medium">
      {spec.name && <strong className="rule-row__name">{spec.name}</strong>}
      {when.join(' · ')}
      <Icon name="chevron_right" size={16} className="rule-row__arrow" />
      {what.join(', ')}
    </span>
  )
}

type MoveChoice = 'none' | 'archive' | 'folder' | 'delete'

function RuleDialog({ accountId, rule, from, onClose }: { accountId: string; rule?: MailRule; from?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const account = useSettings((s) => s.accounts.find((a) => a.id === accountId))
  const outlook = accountId.startsWith('microsoft:')
  const start = rule?.spec
  const [spec, setSpec] = useState<RuleSpec>(start ?? { from: from ?? '', words: '', markRead: false, move: { kind: 'none' } })
  const [folderId, setFolderId] = useState(start?.move.kind === 'folder' ? start.move.id : '')
  const [alsoExisting, setAlsoExisting] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [matches, setMatches] = useState<MailSummary[] | null>(null)
  const folders = useFolders(accountId)
  const existingRules = queryClient.getQueryData<{ rules: MailRule[] }>(rulesKey(accountId))?.rules ?? []

  const move = (kind: MoveChoice): RuleMove => (kind === 'folder' ? { kind, id: folderId } : { kind })
  const final: RuleSpec = { ...spec, move: spec.move.kind === 'folder' ? { kind: 'folder', id: folderId } : spec.move }

  const save = async () => {
    if (isEmptySpec(final)) return setError(t('rules.needCondition'))
    if (hasNoAction(final)) return setError(t('rules.needAction'))
    if (final.move.kind === 'folder' && !folderId) return setError(t('rules.needFolder'))
    setError('')
    setBusy(true)
    try {
      const next = Math.max(0, ...existingRules.map((r) => r.sequence ?? 0)) + 1
      await saveRule(accountId, final, rule, next)
      await queryClient.invalidateQueries({ queryKey: rulesKey(accountId) })
      if (!alsoExisting) return onClose()
      setMatches(await findExisting(accountId, final))
    } catch (e) {
      setError(t('rules.saveFailed', { reason: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!matches) return
    setBusy(true)
    try {
      await applyToExisting(accountId, final, matches.map((m) => m.id))
      useStatus.getState().toast({ tone: 'success', message: t('rules.applied', { count: matches.length }) })
      onClose()
    } catch (e) {
      setError(t('rules.applyFailed', { reason: (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  if (matches)
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('rules.existingTitle')}
        actions={
          <>
            <Button variant="text" onClick={onClose}>
              {matches.length ? t('rules.skip') : t('rules.close')}
            </Button>
            {matches.length > 0 && (
              <Button onClick={() => void apply()} disabled={busy}>
                {t('rules.applyCount', { count: matches.length })}
              </Button>
            )}
          </>
        }
      >
        <p className="body-medium">{matches.length ? t('rules.existingFound', { count: matches.length }) : t('rules.existingNone')}</p>
        {matches.length > 0 && (
          <ul className="rules__matches body-small">
            {matches.slice(0, 20).map((m) => (
              <li key={m.id}>
                <strong>{m.from.name || m.from.email}</strong> — {m.subject || t('mail.noSubject')}
              </li>
            ))}
            {matches.length > 20 && <li className="muted">{t('rules.andMore', { count: matches.length - 20 })}</li>}
          </ul>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    )

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule ? t('rules.editTitle') : t('rules.newTitle')}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {t('rules.save')}
          </Button>
        </>
      }
    >
      <form
        className="rule-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <p className="body-small muted">{account?.email}</p>
        <fieldset>
          <legend className="title-small">{t('rules.when')}</legend>
          <label className="rule-form__field">
            <span className="body-medium">{t('rules.from')}</span>
            <input
              className="text-field text-field--outlined"
              value={spec.from}
              placeholder="name@example.com"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setSpec({ ...spec, from: e.target.value })}
            />
          </label>
          <label className="rule-form__field">
            <span className="body-medium">{t('rules.containsLabel')}</span>
            <input className="text-field text-field--outlined" value={spec.words} onChange={(e) => setSpec({ ...spec, words: e.target.value })} />
          </label>
          <p className="body-small muted">{t('rules.conditionsHint')}</p>
        </fieldset>
        <fieldset>
          <legend className="title-small">{t('rules.then')}</legend>
          <label className="checkbox">
            <input type="checkbox" checked={spec.markRead} onChange={(e) => setSpec({ ...spec, markRead: e.target.checked })} /> {t('rules.markRead')}
          </label>
          <div className="rule-form__moves" role="radiogroup" aria-label={t('rules.then')}>
            {(['none', 'archive', 'folder', 'delete'] as const).map((k) => (
              <label key={k} className="checkbox">
                <input type="radio" name="rule-move" checked={spec.move.kind === k} onChange={() => setSpec({ ...spec, move: move(k) })} /> {t(`rules.move.${k}`)}
              </label>
            ))}
          </div>
          {spec.move.kind === 'folder' &&
            (folders.isPending ? (
              <Spinner size={20} label={t('mail.loading')} />
            ) : (
              <select className="select" value={folderId} aria-label={t('rules.folder')} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">{t('rules.pickFolder')}</option>
                {(folders.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {'  '.repeat(f.depth)}
                    {f.name}
                  </option>
                ))}
              </select>
            ))}
          {spec.move.kind === 'delete' && <p className="body-small muted">{t('rules.deleteHint')}</p>}
        </fieldset>
        {outlook && (
          <label className="rule-form__field">
            <span className="body-medium">{t('rules.name')}</span>
            <input className="text-field text-field--outlined" value={spec.name ?? ''} placeholder={t('rules.namePlaceholder')} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
          </label>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={alsoExisting} onChange={(e) => setAlsoExisting(e.target.checked)} /> {t('rules.alsoExisting')}
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Link from Settings. */
export function RulesLink() {
  const { t } = useTranslation()
  return (
    <a className="btn btn--tonal btn--with-icon" href={href('rules')}>
      <Icon name="filter_list" size={18} />
      <span>{t('rules.manage')}</span>
    </a>
  )
}
