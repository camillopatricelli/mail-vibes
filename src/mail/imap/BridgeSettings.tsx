import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { appInfo } from '../../config'
import i18n from '../../i18n'
import { useSettings } from '../../settings/store'
import { Button } from '../../ui/components'
import { Dialog, Spinner } from '../../ui/overlay'
import { BRIDGE_VERSION, BridgeError, checkBridge, normalizeBridgeUrl, type BridgeConfig, type Security } from './bridge'
import { MailServerError, type ServerConfig } from './client'
import { hasManageSieve, IMAP_FEATURES, testImap, testSmtp, type ImapTestReport, type SmtpTestReport } from './connectionTest'

type FieldComp = (p: { label: string; children: ReactNode }) => ReactNode

/** A readable reason for a bridge or mail server error. */
export function connectionErrorText(e: unknown) {
  const t = i18n.t.bind(i18n)
  if (e instanceof BridgeError) {
    if (e.kind === 'key') return t('imap.errKey')
    if (e.kind === 'timeout') return t('imap.errTimeout')
    if (e.kind === 'refused') return t('imap.errRefused', { reason: e.message })
    if (e.message === 'notAllowed') return t('imap.bridgeNotAllowed')
    if (e.message === 'invalid') return t('imap.bridgeInvalid')
    return t('imap.errBridgeUnreachable')
  }
  if (e instanceof MailServerError) {
    if (e.kind === 'auth') return t('imap.errAuth', { reason: e.message })
    if (e.kind === 'timeout') return t('imap.errTimeout')
    if (e.kind === 'closed') return t('imap.errClosed')
    return t('imap.errServer', { reason: e.message })
  }
  return (e as Error).message
}

/** Settings → IMAP bridge: address, access key, check, and a mail server test. */
export function BridgeSettings({ Field }: { Field: FieldComp }) {
  const { t } = useTranslation()
  const bridge = useSettings((s) => s.bridge)
  const exportBridge = useSettings((s) => s.exportBridge)
  const update = useSettings((s) => s.update)
  const [url, setUrl] = useState(bridge?.url ?? '')
  const [key, setKey] = useState(bridge?.key ?? '')
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'busy'; text: string }>()
  const [testing, setTesting] = useState(false)

  const norm = url.trim() ? normalizeBridgeUrl(url) : undefined
  const urlError = norm && 'error' in norm ? (norm.error === 'notAllowed' ? t('imap.bridgeNotAllowed') : t('imap.bridgeInvalid')) : undefined

  const save = () => {
    if (!url.trim()) {
      update({ bridge: undefined })
      return
    }
    if (norm && 'url' in norm) {
      update({ bridge: { url: norm.url, key: key.trim() } })
      setUrl(norm.url)
    }
  }

  const check = async () => {
    save()
    const b = useSettings.getState().bridge
    if (!b) return
    setStatus({ tone: 'busy', text: t('imap.checking') })
    try {
      const version = await checkBridge(b)
      setStatus(version >= BRIDGE_VERSION ? { tone: 'ok', text: t('imap.bridgeOk') } : { tone: 'error', text: t('imap.bridgeOld') })
    } catch (e) {
      setStatus({ tone: 'error', text: connectionErrorText(e) })
    }
  }

  return (
    <>
      <Field label={t('imap.bridgeUrl')}>
        <input
          className="text-field text-field--outlined settings-key"
          value={url}
          placeholder="https://mail-vibes-bridge.<name>.workers.dev"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!urlError}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={save}
        />
      </Field>
      {urlError && <p className="body-small field-error">{urlError}</p>}
      <Field label={t('imap.bridgeKey')}>
        <input
          className="text-field text-field--outlined settings-key"
          type="password"
          value={key}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onBlur={save}
        />
      </Field>
      <Field label={t('imap.exportBridge')}>
        <input type="checkbox" checked={exportBridge} onChange={(e) => update({ exportBridge: e.target.checked })} aria-label={t('imap.exportBridge')} />
      </Field>
      <div className="row-wrap">
        <Button variant="tonal" icon="sync" disabled={!url.trim() || !!urlError || !key.trim()} onClick={() => void check()}>
          {t('imap.checkBridge')}
        </Button>
        <Button variant="outlined" icon="mail" disabled={!bridge?.url || !bridge.key} onClick={() => setTesting(true)}>
          {t('imap.testServer')}
        </Button>
        {status?.tone === 'busy' && <Spinner size={20} label={status.text} />}
      </div>
      {status && status.tone !== 'busy' && (
        <p className={`body-small ${status.tone === 'error' ? 'field-error' : ''}`} role="status">
          {status.text}
        </p>
      )}
      <p className="body-small muted">
        {t('imap.bridgeHint')}{' '}
        <a href={`${appInfo.repoUrl}/blob/main/docs/imap-bridge.md`} target="_blank" rel="noopener noreferrer">
          {t('imap.bridgeHowTo')}
        </a>
      </p>
      {testing && bridge && <ServerTestDialog bridge={bridge} onClose={() => setTesting(false)} />}
    </>
  )
}

interface ServerForm {
  host: string
  port: string
  security: Security
  username: string
}

const emptyServer = (port: number, security: Security): ServerForm => ({ host: '', port: String(port), security, username: '' })

function ServerFields({ value, onChange, prefix }: { value: ServerForm; onChange: (v: ServerForm) => void; prefix: string }) {
  const { t } = useTranslation()
  const set = (p: Partial<ServerForm>) => onChange({ ...value, ...p })
  return (
    <div className="imap-server">
      <label className="imap-server__host">
        <span className="body-small">{t('imap.host')}</span>
        <input className="text-field text-field--outlined" value={value.host} spellCheck={false} autoComplete="off" name={`${prefix}-host`} onChange={(e) => set({ host: e.target.value.trim() })} />
      </label>
      <label>
        <span className="body-small">{t('imap.port')}</span>
        <input className="text-field text-field--outlined imap-server__port" inputMode="numeric" value={value.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
      </label>
      <label>
        <span className="body-small">{t('imap.security')}</span>
        <select className="select" value={value.security} onChange={(e) => set({ security: e.target.value as Security })}>
          <option value="tls">{t('imap.securityTls')}</option>
          <option value="starttls">STARTTLS</option>
        </select>
      </label>
      <label className="imap-server__user">
        <span className="body-small">{t('imap.username')}</span>
        <input className="text-field text-field--outlined" value={value.username} spellCheck={false} autoComplete="off" name={`${prefix}-user`} onChange={(e) => set({ username: e.target.value.trim() })} />
      </label>
    </div>
  )
}

const toServer = (f: ServerForm): ServerConfig => ({ host: f.host, port: Number(f.port), security: f.security, username: f.username })
const filled = (f: ServerForm) => !!f.host && !!f.port && !!f.username

type Line = { tone: 'ok' | 'error' | 'info'; text: string }

/**
 * Phase 1 check of a mail server through the bridge: logs in, reads the Inbox (read-only),
 * downloads its largest recent message, and optionally logs in to SMTP. Nothing is saved.
 */
function ServerTestDialog({ bridge, onClose }: { bridge: BridgeConfig; onClose: () => void }) {
  const { t } = useTranslation()
  const [imap, setImap] = useState(emptyServer(993, 'tls'))
  const [smtp, setSmtp] = useState(emptyServer(465, 'tls'))
  const [withSmtp, setWithSmtp] = useState(false)
  const [password, setPassword] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)

  const add = (l: Line) => setLines((ls) => [...ls, l])

  const run = async () => {
    setBusy(true)
    setLines([])
    try {
      add({ tone: 'info', text: t('imap.testingImap') })
      let r: ImapTestReport | undefined
      try {
        r = await testImap(bridge, toServer(imap), password)
      } catch (e) {
        add({ tone: 'error', text: connectionErrorText(e) })
      }
      if (r) {
        const caps = r.capabilities
        add({ tone: 'ok', text: t('imap.imapOk', { count: r.inboxCount }) })
        const missing = IMAP_FEATURES.filter((f) => !caps.includes(f))
        add({ tone: 'info', text: t('imap.features', { list: IMAP_FEATURES.filter((f) => caps.includes(f)).join(', ') || '—' }) })
        if (missing.length) add({ tone: 'info', text: t('imap.missing', { list: missing.join(', ') }) })
        if (r.download)
          add({
            tone: r.download.bytes ? 'ok' : 'error',
            text: t('imap.download', { size: (r.download.bytes / 1024 / 1024).toFixed(2), seconds: (r.download.ms / 1000).toFixed(1) }),
          })
        const sieve = await hasManageSieve(bridge, imap.host)
        add({ tone: 'info', text: sieve ? t('imap.sieveYes') : t('imap.sieveNo') })
      }

      if (withSmtp) {
        add({ tone: 'info', text: t('imap.testingSmtp') })
        try {
          const s: SmtpTestReport = await testSmtp(bridge, toServer(smtp), smtpPassword || password)
          add({ tone: 'ok', text: t('imap.smtpOk', { list: s.authMethods.join(', ') || '—' }) })
        } catch (e) {
          add({ tone: 'error', text: connectionErrorText(e) })
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const ready = filled(imap) && !!password && (!withSmtp || filled(smtp))

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('imap.testServer')}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button icon="sync" disabled={!ready || busy} onClick={() => void run()}>
            {t('imap.runTest')}
          </Button>
        </>
      }
    >
      <form className="imap-test" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <p className="body-small muted">{t('imap.testHint')}</p>
        <h3 className="title-small">{t('imap.incoming')}</h3>
        <ServerFields value={imap} onChange={setImap} prefix="imap" />
        <label className="imap-server__pw">
          <span className="body-small">{t('imap.password')}</span>
          <input className="text-field text-field--outlined" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="row-wrap">
          <input type="checkbox" checked={withSmtp} onChange={(e) => setWithSmtp(e.target.checked)} />
          <span className="body-medium">{t('imap.alsoSmtp')}</span>
        </label>
        {withSmtp && (
          <>
            <h3 className="title-small">{t('imap.outgoing')}</h3>
            <ServerFields value={smtp} onChange={setSmtp} prefix="smtp" />
            <label className="imap-server__pw">
              <span className="body-small">{t('imap.smtpPassword')}</span>
              <input className="text-field text-field--outlined" type="password" autoComplete="off" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
            </label>
          </>
        )}
        {(lines.length > 0 || busy) && (
          <ul className="imap-test__log" aria-live="polite">
            {lines.map((l, i) => (
              <li key={i} className={`body-small ${l.tone === 'error' ? 'field-error' : l.tone === 'ok' ? 'imap-test__ok' : ''}`}>
                {l.text}
              </li>
            ))}
            {busy && (
              <li>
                <Spinner size={18} />
              </li>
            )}
          </ul>
        )}
      </form>
    </Dialog>
  )
}
