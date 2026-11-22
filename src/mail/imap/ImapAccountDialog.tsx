import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { queryClient } from '../../lib/queryClient'
import { specialFolders, useSettings, type ImapSettings, type SpecialFolder } from '../../settings/store'
import { useStatus } from '../../status/store'
import { Button } from '../../ui/components'
import { Dialog, Spinner } from '../../ui/overlay'
import { autodetect } from './bridge'
import { connectionErrorText } from './BridgeSettings'
import { testSmtp, verifyLogin } from './connectionTest'
import { folderLabel } from './folders'
import { getPassword, isRemembered, setPassword, smtpKey } from './passwords'
import { listFolders } from './provider'
import { emptyServer, filled, ServerFields, toForm, toServer, type ServerForm } from './ServerFields'
import { closeSession } from './session'

/** Settings → Add IMAP account / edit one: guided form with auto-detect and a login check. */
export function ImapAccountDialog({ accountId, onClose }: { accountId?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const bridge = useSettings((s) => s.bridge)
  const existing = useSettings((s) => s.accounts.find((a) => a.id === accountId))
  const cfg = existing?.imap

  const [email, setEmail] = useState(existing?.email ?? '')
  const [name, setName] = useState(existing?.displayName ?? '')
  const [incoming, setIncoming] = useState<ServerForm>(cfg ? toForm(cfg.incoming) : emptyServer(993, 'tls'))
  const [sends, setSends] = useState(!!cfg?.outgoing)
  const [outgoing, setOutgoing] = useState<ServerForm>(cfg?.outgoing ? toForm(cfg.outgoing) : emptyServer(465, 'tls'))
  const [samePassword, setSamePassword] = useState(cfg?.outgoing?.samePassword ?? true)
  const [pec, setPec] = useState(cfg?.pec ?? false)
  const [password, setPw] = useState('')
  const [smtpPassword, setSmtpPw] = useState('')
  const [remember, setRemember] = useState(false)
  const [folders, setFolders] = useState<Partial<Record<SpecialFolder, string>>>(cfg?.folders ?? {})
  const [detectMsg, setDetectMsg] = useState<string>()
  const [busy, setBusy] = useState<'detect' | 'save'>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (accountId) void isRemembered(accountId).then(setRemember)
  }, [accountId])

  // Existing account: its folders, to choose the special ones by hand.
  const folderList = useQuery({
    queryKey: ['mail', 'imap-folders', accountId],
    enabled: !!accountId,
    queryFn: () => listFolders(accountId!),
    retry: false,
  })

  const labelOf = (path: string) => {
    const f = folderList.data?.list.find((x) => x.path === path)
    return folderLabel(path, f?.delimiter ?? null)
  }

  const detect = async () => {
    if (!bridge) return
    setBusy('detect')
    setDetectMsg(undefined)
    try {
      const r = await autodetect(bridge, email)
      const inc = r.servers.find((s) => s.protocol === 'imap')
      const out = r.servers.find((s) => s.protocol === 'smtp')
      if (inc) setIncoming({ host: inc.host, port: String(inc.port), security: inc.security, username: inc.username })
      if (out) {
        setSends(true)
        setOutgoing({ host: out.host, port: String(out.port), security: out.security, username: out.username })
      }
      setDetectMsg(inc ? t('imap.detected', { source: r.source }) : t('imap.notDetected'))
    } catch (e) {
      setDetectMsg(connectionErrorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const ready = validEmail && filled(incoming) && (!!password || !!accountId) && (!sends || (filled(outgoing) && (samePassword || !!smtpPassword || !!accountId)))

  const save = async () => {
    if (!bridge) return
    setBusy('save')
    setError(undefined)
    // The id is the address: the same on every device, so links to conversations work everywhere.
    const id = accountId ?? `imap:${email.trim().toLowerCase()}`
    try {
      if (!accountId && useSettings.getState().accounts.some((a) => a.id === id)) throw new Error(t('imap.alreadyAdded'))
      const pw = password || (accountId ? await getPassword(accountId) : undefined)
      if (!pw) throw new Error(t('imap.passwordNeeded'))
      await verifyLogin(bridge, toServer(incoming), pw)
      const outPw = samePassword ? pw : smtpPassword || (accountId ? await getPassword(smtpKey(accountId)) : undefined)
      if (sends) {
        if (!outPw) throw new Error(t('imap.passwordNeeded'))
        await testSmtp(bridge, toServer(outgoing), outPw)
      }
      const settings: ImapSettings = {
        incoming: toServer(incoming),
        pec,
        ...(sends && { outgoing: { ...toServer(outgoing), samePassword } }),
        ...(Object.keys(folders).length && { folders }),
      }
      useSettings.getState().upsertAccount({ id, provider: 'imap', email: email.trim(), displayName: name.trim() || email.trim(), imap: settings })
      await setPassword(id, pw, remember)
      if (sends && !samePassword && outPw) await setPassword(smtpKey(id), outPw, remember)
      closeSession(id)
      useStatus.getState().clearError(id)
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(id) })
      useStatus.getState().toast({ tone: 'success', message: accountId ? t('imap.saved') : t('imap.added', { account: email.trim() }) })
      onClose()
    } catch (e) {
      setError(connectionErrorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={accountId ? t('imap.editAccount') : t('imap.addAccount')}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button icon="check" disabled={!ready || !!busy} onClick={() => void save()}>
            {accountId ? t('settings.save') : t('imap.add')}
          </Button>
        </>
      }
    >
      <form className="imap-test" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <label className="imap-server__pw">
          <span className="body-small">{t('imap.email')}</span>
          <input className="text-field text-field--outlined" type="email" value={email} spellCheck={false} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="imap-server__pw">
          <span className="body-small">{t('settings.senderName')}</span>
          <input className="text-field text-field--outlined" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row-wrap">
          <Button variant="tonal" icon="search" disabled={!validEmail || !!busy} onClick={() => void detect()}>
            {t('imap.detect')}
          </Button>
          {busy === 'detect' && <Spinner size={20} />}
        </div>
        {detectMsg && <p className="body-small">{detectMsg}</p>}

        <h3 className="title-small">{t('imap.incoming')}</h3>
        <ServerFields value={incoming} onChange={setIncoming} prefix="imap" />
        <p className="body-small muted">{t('imap.usernameHint')}</p>
        <label className="imap-server__pw">
          <span className="body-small">{accountId ? t('imap.newPassword') : t('imap.password')}</span>
          <input className="text-field text-field--outlined" type="password" autoComplete="off" value={password} onChange={(e) => setPw(e.target.value)} />
        </label>
        <p className="body-small muted">{t('imap.appPasswordHint')}</p>
        <label className="row-wrap">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="body-medium">{t('imap.remember')}</span>
        </label>
        <p className="body-small muted">{remember ? t('imap.rememberWarning') : t('imap.sessionOnly')}</p>

        <label className="row-wrap">
          <input type="checkbox" checked={pec} onChange={(e) => setPec(e.target.checked)} />
          <span className="body-medium">{t('imap.pec')}</span>
        </label>
        {pec && <p className="body-small muted">{t('imap.pecHint')}</p>}

        <label className="row-wrap">
          <input type="checkbox" checked={sends} onChange={(e) => setSends(e.target.checked)} />
          <span className="body-medium">{t('imap.canSend')}</span>
        </label>
        {sends ? (
          <>
            <h3 className="title-small">{t('imap.outgoing')}</h3>
            <ServerFields value={outgoing} onChange={setOutgoing} prefix="smtp" />
            <label className="row-wrap">
              <input type="checkbox" checked={samePassword} onChange={(e) => setSamePassword(e.target.checked)} />
              <span className="body-medium">{t('imap.samePassword')}</span>
            </label>
            {!samePassword && (
              <label className="imap-server__pw">
                <span className="body-small">{t('imap.password')}</span>
                <input className="text-field text-field--outlined" type="password" autoComplete="off" value={smtpPassword} onChange={(e) => setSmtpPw(e.target.value)} />
              </label>
            )}
          </>
        ) : (
          <p className="body-small muted">{t('imap.receiveOnly')}</p>
        )}

        {accountId && (
          <>
            <h3 className="title-small">{t('imap.specialFolders')}</h3>
            {folderList.isPending && <Spinner size={20} />}
            {folderList.error && <p className="body-small field-error">{(folderList.error as Error).message}</p>}
            {folderList.data &&
              specialFolders.map((k) => (
                <label key={k} className="field">
                  <span className="field__label body-medium">{t(`imap.folder.${k}`)}</span>
                  <select
                    className="select"
                    value={folders[k] ?? ''}
                    onChange={(e) => {
                      const next = { ...folders }
                      if (e.target.value) next[k] = e.target.value
                      else delete next[k]
                      setFolders(next)
                    }}
                  >
                    <option value="">
                      {folderList.data.special[k] ? t('imap.folderAuto', { name: labelOf(folderList.data.special[k]!) }) : t('imap.folderNone')}
                    </option>
                    {folderList.data.list.map((f) => (
                      <option key={f.path} value={f.path}>
                        {folderLabel(f.path, f.delimiter)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
          </>
        )}

        {busy === 'save' && (
          <p className="row-wrap body-small">
            <Spinner size={18} /> {t('imap.checkingLogin')}
          </p>
        )}
        {error && (
          <p className="body-small field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
