import { useQuery } from '@tanstack/react-query'
import { RulesLink } from '../mail/RulesPage'
import { loadContacts } from '../contacts/contacts'
import { NotificationSettings } from '../notify/NotificationSettings'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { appInfo } from '../config'
import { href } from '../lib/router'
import { orgSetupUrl } from '../lib/setupLink'
import { timeAgo, useNow } from '../lib/time'
import {
  accountPalette,
  exportSettingsJson,
  isGuid,
  isTenantId,
  selectTenants,
  parseSettingsJson,
  pollIntervalOptions,
  useSettings,
  type AccountSettings,
  type Defaults,
  type Provider,
  accountLabel,
  accountLongLabel,
} from '../settings/store'
import { useStatus } from '../status/store'
import { AccountBadge, Button, Card, IconButton } from '../ui/components'
import { Dialog } from '../ui/overlay'
import { addGoogle, addMicrosoft, removeAccount } from '../auth/accounts'
import { googleConfigured, preloadGoogle } from '../auth/google'


function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label body-medium">{label}</span>
      {children}
    </label>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="settings__section">
      <h2 className="title-medium">{title}</h2>
      {hint && <p className="body-medium muted">{hint}</p>}
      <div className="settings__body">{children}</div>
    </Card>
  )
}

function ColorPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label={label}>
      {accountPalette.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          className={['swatch', value === c && 'is-selected'].filter(Boolean).join(' ')}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="swatch swatch--custom" />
    </div>
  )
}

/** Text input that commits on blur / Enter, so typing doesn't write settings on every keystroke. */
function InlineText({
  value,
  onCommit,
  label,
  className,
  placeholder,
}: {
  value: string
  onCommit: (v: string) => void
  label: string
  className?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setDraft(value)
  }
  return (
    <input
      className={['text-field', className].filter(Boolean).join(' ')}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      title={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

function AccountRow({ a }: { a: AccountSettings }) {
  const { t } = useTranslation()
  const updateAccount = useSettings((s) => s.updateAccount)
  const tenantName = useSettings((s) => selectTenants(s).find((x) => x.key === a.tenantKey)?.name)
  const st = useStatus((s) => s.accounts[a.id])
  const now = useNow()
  const state = st?.error
    ? st.error.kind === 'auth'
      ? t('accounts.needsSignIn')
      : `${t('accounts.error')}: ${st.error.message}`
    : st?.lastSuccessAt
      ? t('accounts.lastUpdated', { ago: timeAgo(st.lastSuccessAt, now) })
      : t('accounts.neverUpdated')
  return (
    <div className="account-row" style={{ borderLeftColor: a.color }}>
      <AccountBadge color={a.color} label={accountLabel(a)} size={32} />
      <div className="account-row__text">
        <InlineText
          className="title-small"
          value={a.label ?? ''}
          placeholder={a.displayName || a.email}
          label={`${t('settings.accountLabel')} — ${a.email}`}
          onCommit={(label) => updateAccount(a.id, { label: label.trim() || undefined })}
        />
        {a.provider === 'google' && (
          <label className="body-small muted account-row__sender">
            {t('settings.senderName')}
            <InlineText
              className="body-small"
              value={a.displayName}
              label={`${t('settings.senderName')} — ${a.email}`}
              onCommit={(displayName) => updateAccount(a.id, { displayName: displayName.trim() || a.email })}
            />
          </label>
        )}
        <p className="body-small muted">
          {a.email} · {a.provider === 'google' ? t('accounts.google') : tenantName ?? t('accounts.microsoft')} · {state}
        </p>
        <ColorPicker
          value={a.color}
          label={t('settings.accountColor', { account: a.email })}
          onChange={(color) => updateAccount(a.id, { color })}
        />
      </div>
      <IconButton icon="delete" label={`${t('settings.removeAccount')} ${a.email}`} onClick={() => {
          if (confirm(t('settings.removeConfirm', { account: a.email }))) void removeAccount(a.id)
        }}
      />
    </div>
  )
}

function TenantsSection() {
  const { t } = useTranslation()
  const customTenants = useSettings((s) => s.customTenants)
  const tenantNames = useSettings((s) => s.tenantNames)
  const tenants = selectTenants({ customTenants, tenantNames })
  const accounts = useSettings((s) => s.accounts)
  const renameTenant = useSettings((s) => s.renameTenant)
  const removeTenant = useSettings((s) => s.removeTenant)
  const addTenant = useSettings((s) => s.addTenant)
  const toast = useStatus((s) => s.toast)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', clientId: '', tenantId: '' })
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const name = form.name.trim()
    const clientId = form.clientId.trim().toLowerCase()
    const tenantId = form.tenantId.trim().toLowerCase()
    if (!name) return setError(t('settings.invalidName'))
    if (!isGuid(clientId)) return setError(t('settings.invalidClientId'))
    if (!isTenantId(tenantId)) return setError(t('settings.invalidTenantId'))
    if (tenants.some((x) => x.clientId.toLowerCase() === clientId && x.tenantId.toLowerCase() === tenantId))
      return setError(t('settings.duplicateTenant'))
    addTenant({ name, clientId, tenantId })
    setForm({ name: '', clientId: '', tenantId: '' })
    setError(null)
    setAdding(false)
  }

  return (
    <Section title={t('settings.tenants')} hint={t('settings.tenantsHint')}>
      {tenants.map((x) => {
        const inUse = accounts.some((a) => a.tenantKey === x.key)
        return (
          <div key={x.key} className="tenant-row">
            <div className="tenant-row__text">
              <InlineText className="title-small" value={x.name} label={t('settings.tenantName')} onCommit={(v) => renameTenant(x.key, v)} />
              <p className="body-small muted">
                {x.builtIn && <>{t('settings.builtIn')} · </>}
                {t('settings.clientId')}: <code>{x.clientId}</code> · {t('settings.tenantId')}: <code>{x.tenantId}</code>
              </p>
            </div>
            <IconButton
              icon="link"
              label={t('setup.copyLink')}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(orgSetupUrl(x))
                  toast({ tone: 'success', message: t('setup.linkCopied') })
                } catch {
                  toast({ tone: 'error', message: t('setup.copyFailed') })
                }
              }}
            />
            {!x.builtIn && (
              <IconButton
                icon="delete"
                label={inUse ? t('settings.tenantInUse') : `${t('settings.removeTenant')} ${x.name}`}
                disabled={inUse}
                onClick={() => removeTenant(x.key)}
              />
            )}
          </div>
        )
      })}
      {adding ? (
        <div className="tenant-form">
          <Field label={t('settings.tenantName')}>
            <input className="text-field text-field--outlined" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t('settings.clientId')}>
            <input className="text-field text-field--outlined" value={form.clientId} spellCheck={false} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
          </Field>
          <Field label={t('settings.tenantId')}>
            <input
              className="text-field text-field--outlined"
              value={form.tenantId}
              spellCheck={false}
              title={t('settings.tenantIdHint')}
              placeholder={t('settings.tenantIdHint')}
              onChange={(e) => setForm({ ...form, tenantId: e.target.value })}
            />
          </Field>
          {error && (
            <p className="body-small field-error" role="alert">
              {error}
            </p>
          )}
          <div className="row-wrap">
            <Button variant="filled" onClick={submit}>
              {t('settings.save')}
            </Button>
            <Button
              variant="text"
              onClick={() => {
                setAdding(false)
                setError(null)
              }}
            >
              {t('settings.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row-wrap">
          <Button variant="outlined" icon="add" onClick={() => setAdding(true)}>
            {t('settings.addTenant')}
          </Button>
        </div>
      )}
    </Section>
  )
}

function AddMicrosoftButton() {
  const { t } = useTranslation()
  const customTenants = useSettings((s) => s.customTenants)
  const tenantNames = useSettings((s) => s.tenantNames)
  const tenants = selectTenants({ customTenants, tenantNames })
  const [choosing, setChoosing] = useState(false)
  const start = (key: string) => {
    setChoosing(false)
    void addMicrosoft(key)
  }
  return (
    <>
      <Button
        variant="tonal"
        icon="add"
        onClick={() => {
          if (tenants.length === 1) start(tenants[0].key)
          else setChoosing(true)
        }}
      >
        {t('settings.addMicrosoft')}
      </Button>
      <Dialog open={choosing} onClose={() => setChoosing(false)} title={t('settings.chooseTenant')}>
        {tenants.length === 0 ? (
          <p className="body-medium">{t('settings.noTenants')}</p>
        ) : (
          <ul className="folder-list">
            {tenants.map((x) => (
              <li key={x.key}>
                <button type="button" onClick={() => start(x.key)}>
                  <span className="body-large">{x.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  )
}

function DefaultSelect({
  label,
  field,
  provider,
}: {
  label: string
  field: keyof Defaults
  provider?: Provider
}) {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts).filter((a) => !provider || a.provider === provider)
  const value = useSettings((s) => s.defaults[field])
  const setDefaults = useSettings((s) => s.setDefaults)
  return (
    <Field label={label}>
      <select className="select" value={value ?? ''} onChange={(e) => setDefaults({ [field]: e.target.value || undefined })}>
        <option value="">{t('settings.noneSet')}</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {accountLongLabel(a)}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** How the contacts of the default contacts account loaded (shown under the setting). */
function ContactsStatus() {
  const { t } = useTranslation()
  const id = useSettings((s) => s.defaults.contactsAccountId ?? s.accounts[0]?.id)
  const q = useQuery({ queryKey: ['contacts', id], enabled: !!id, queryFn: () => loadContacts(id!), staleTime: 30 * 60_000, retry: 1 })
  if (!id) return null
  return (
    <p className={q.error ? 'body-small field-error' : 'body-small muted'}>
      {q.error
        ? t('contacts.loadFailed', { reason: (q.error as Error).message })
        : q.data
          ? `${t('contacts.loaded', { count: q.data.length })}. ${t('contacts.hint')}`
          : t('contacts.hint')}
    </p>
  )
}

/** The user's own Google Maps key (place suggestions in event locations). */
function MapsKeyField() {
  const { t } = useTranslation()
  const key = useSettings((s) => s.mapsApiKey)
  const update = useSettings((s) => s.update)
  const [text, setText] = useState(key ?? '')
  const valid = !text.trim() || /^[\w-]{20,60}$/.test(text.trim())
  return (
    <>
      <Field label={t('settings.mapsKey')}>
        <span className="row-wrap">
          <input
            className="text-field text-field--outlined settings-key"
            value={text}
            placeholder={t('settings.mapsKeyPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!valid}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => valid && update({ mapsApiKey: text.trim() || undefined })}
          />
          {key && (
            <Button
              variant="text"
              onClick={() => {
                setText('')
                update({ mapsApiKey: undefined })
              }}
            >
              {t('settings.mapsKeyRemove')}
            </Button>
          )}
        </span>
      </Field>
      {!valid && <p className="body-small field-error">{t('settings.mapsKeyInvalid')}</p>}
      <p className="body-small muted">
        {t('settings.mapsKeyHint')}{' '}
        <a href={`${appInfo.repoUrl}/blob/main/docs/google-maps-key.md`} target="_blank" rel="noopener noreferrer">
          {t('settings.mapsKeyHowTo')}
        </a>
      </p>
    </>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const s = useSettings()
  const toast = useStatus((x) => x.toast)
  const fileInput = useRef<HTMLInputElement>(null)
  // Loaded ahead of the click so the Google sign-in popup is not blocked.
  useEffect(() => preloadGoogle(true), [])

  const doExport = () => {
    const blob = new Blob([exportSettingsJson(s)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mail-vibes-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const doImport = async (file: File) => {
    try {
      const parsed = parseSettingsJson(await file.text())
      s.replaceAll(parsed)
      toast({ tone: 'success', message: t('settings.importOk') })
    } catch (e) {
      toast({ tone: 'error', message: t('settings.importFailed', { reason: (e as Error).message }) })
    }
  }

  return (
    <div className="settings">
      <h1 className="headline-small page-title">{t('settings.title')}</h1>

      <Section title={t('settings.accounts')} hint={t('settings.accountsHint')}>
        {s.accounts.length === 0 && <p className="body-medium muted">{t('accounts.none')}</p>}
        {s.accounts.map((a) => (
          <AccountRow key={a.id} a={a} />
        ))}
        <div className="row-wrap">
          <AddMicrosoftButton />
          <Button
            variant="tonal"
            icon="add"
            disabled={!googleConfigured()}
            title={googleConfigured() ? undefined : t('accounts.googleNotConfigured')}
            onClick={() => void addGoogle()}
          >
            {t('settings.addGoogle')}
          </Button>
        </div>
      </Section>

      <TenantsSection />

      <Section title={t('settings.defaults')}>
        <DefaultSelect label={t('settings.defaultSend')} field="sendAccountId" />
        <DefaultSelect label={t('settings.defaultTask')} field="taskAccountId" />
        <DefaultSelect label={t('settings.defaultCalendar')} field="calendarAccountId" />
        <DefaultSelect label={t('settings.defaultMeeting')} field="meetingAccountId" />
        <DefaultSelect label={t('settings.defaultContacts')} field="contactsAccountId" />
        <ContactsStatus />
        <DefaultSelect label={t('settings.defaultNotes')} field="notesAccountId" provider="google" />
      </Section>

      <Section title={t('settings.calendar')}>
        <Field label={t('settings.weekStart')}>
          <select className="select" value={s.weekStart} onChange={(e) => s.update({ weekStart: e.target.value as typeof s.weekStart })}>
            <option value="monday">{t('settings.weekStartMonday')}</option>
            <option value="sunday">{t('settings.weekStartSunday')}</option>
            <option value="auto">{t('settings.weekStartAuto')}</option>
          </select>
        </Field>
        <MapsKeyField />
      </Section>

      <Section title={t('rules.title')} hint={t('rules.settingsHint')}>
        <div>
          <RulesLink />
        </div>
      </Section>

      <Section title={t('notify.section')}>
        <NotificationSettings Field={Field} />
      </Section>

      <Section title={t('settings.general')}>
        <Field label={t('settings.language')}>
          <select className="select" value={s.language} onChange={(e) => s.update({ language: e.target.value as typeof s.language })}>
            <option value="auto">{t('settings.languageAuto')}</option>
            <option value="en">English</option>
            <option value="it">Italiano</option>
          </select>
        </Field>
        <Field label={t('settings.theme')}>
          <select className="select" value={s.theme} onChange={(e) => s.update({ theme: e.target.value as typeof s.theme })}>
            <option value="system">{t('settings.themeSystem')}</option>
            <option value="light">{t('settings.themeLight')}</option>
            <option value="dark">{t('settings.themeDark')}</option>
          </select>
        </Field>
        <Field label={t('settings.accentColor')}>
          <ColorPicker value={s.seedColor} label={t('settings.accentColor')} onChange={(seedColor) => s.update({ seedColor })} />
        </Field>
        <Field label={t('settings.homePage')}>
          <select className="select" value={s.homePage} onChange={(e) => s.update({ homePage: e.target.value as typeof s.homePage })}>
            {(['today', 'mail', 'calendar', 'tasks'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`nav.${p}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.markRead')}>
          <select className="select" value={s.markRead} onChange={(e) => s.update({ markRead: e.target.value as typeof s.markRead })}>
            <option value="never">{t('settings.markReadNever')}</option>
            <option value="open">{t('settings.markReadOpen')}</option>
            <option value="delay">{t('settings.markReadDelay')}</option>
          </select>
        </Field>
        <Field label={t('settings.pollInterval')}>
          <select className="select" value={s.pollIntervalSec} onChange={(e) => s.update({ pollIntervalSec: Number(e.target.value) })}>
            {pollIntervalOptions.map((sec) => (
              <option key={sec} value={sec}>
                {sec < 60 ? t('settings.seconds', { count: sec }) : t('settings.minutes', { count: sec / 60 })}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title={t('settings.backup')} hint={t('settings.backupHint')}>
        <div className="row-wrap">
          <Button variant="outlined" icon="download" onClick={doExport}>
            {t('settings.export')}
          </Button>
          <Button variant="outlined" icon="upload" onClick={() => fileInput.current?.click()}>
            {t('settings.import')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void doImport(f)
            }}
          />
          <Button
            variant="text"
            icon="refresh"
            onClick={() => {
              if (confirm(t('settings.resetConfirm'))) s.reset()
            }}
          >
            {t('settings.reset')}
          </Button>
        </div>
        <a className="body-medium" href={`${appInfo.repoUrl}/blob/main/docs/other-devices.md`} target="_blank" rel="noopener noreferrer">
          {t('settings.otherDevices')}
        </a>
      </Section>

      <Section title={t('settings.about')}>
        <p className="body-medium">{t('settings.aboutBody')}</p>
        <div className="row-wrap">
          <a className="btn btn--text btn--with-icon" href={href('privacy')}>
            {t('nav.privacy')}
          </a>
          <a className="btn btn--text btn--with-icon" href={appInfo.repoUrl} target="_blank" rel="noopener noreferrer">
            {t('settings.sourceCode')}
          </a>
        </div>
      </Section>
    </div>
  )
}
