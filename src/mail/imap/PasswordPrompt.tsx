import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { queryClient } from '../../lib/queryClient'
import { accountLongLabel, useSettings } from '../../settings/store'
import { reauthHandlers } from '../../shell/Banners'
import { useStatus } from '../../status/store'
import { Button } from '../../ui/components'
import { Dialog, Spinner } from '../../ui/overlay'
import { connectionErrorText } from './BridgeSettings'
import { verifyLogin } from './connectionTest'
import { setPassword, usePasswordPrompt } from './passwords'
import { closeSession } from './session'

// The account banners' "Sign in" button for IMAP accounts asks for the password.
reauthHandlers.imap = (accountId) => usePasswordPrompt.getState().ask(accountId)

/** Asks for an IMAP account's password (once per app session, unless remembered). */
export function PasswordPrompt() {
  const accountId = usePasswordPrompt((s) => s.accountId)
  return accountId ? <PromptDialog key={accountId} accountId={accountId} /> : null
}

function PromptDialog({ accountId }: { accountId: string }) {
  const { t } = useTranslation()
  const account = useSettings((s) => s.accounts.find((a) => a.id === accountId))
  const bridge = useSettings((s) => s.bridge)
  const close = usePasswordPrompt((s) => s.close)
  const [password, setPw] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!account?.imap) return null

  const signIn = async () => {
    if (!bridge) {
      setError(t('imap.noBridge'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await verifyLogin(bridge, account.imap!.incoming, password)
      await setPassword(accountId, password, remember)
      closeSession(accountId)
      useStatus.getState().clearError(accountId)
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes(accountId) })
      close()
    } catch (e) {
      setError(connectionErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title={t('imap.signInTitle')}
      actions={
        <>
          <Button variant="text" onClick={close}>
            {t('settings.cancel')}
          </Button>
          <Button icon="lock" disabled={!password || busy} onClick={() => void signIn()}>
            {t('banner.signIn')}
          </Button>
        </>
      }
    >
      <form
        className="imap-test"
        onSubmit={(e) => {
          e.preventDefault()
          if (password && !busy) void signIn()
        }}
      >
        <p className="body-medium">{accountLongLabel(account)}</p>
        <label className="imap-server__pw">
          <span className="body-small">{t('imap.password')}</span>
          <input className="text-field text-field--outlined" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="row-wrap">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span className="body-medium">{t('imap.remember')}</span>
        </label>
        <p className="body-small muted">{remember ? t('imap.rememberWarning') : t('imap.sessionOnly')}</p>
        {busy && <Spinner size={20} />}
        {error && (
          <p className="body-small field-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
