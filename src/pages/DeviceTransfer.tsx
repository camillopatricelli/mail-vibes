import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  collectTransfer,
  isGoogleSignIn,
  newCode,
  openTransfer,
  payloadFromLink,
  sealTransfer,
  storeTransferPasswords,
  transferSettings,
  TransferError,
  transferUrl,
  type Transfer,
} from '../lib/deviceTransfer'
import { replaceSetup } from '../auth/accounts'
import { navigate } from '../lib/router'
import { accountLongLabel, useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { Button, Card } from '../ui/components'
import { Dialog, Spinner } from '../ui/overlay'

// Phones and tablets offer a share sheet (AirDrop, mail, chats); computers copy the link instead.
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/** Settings → Copy to another device: a link (encrypted) and the code that opens it. */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [made, setMade] = useState<{ url: string; code: string; missing: string[] }>()
  const [error, setError] = useState<string>()
  const toast = useStatus((s) => s.toast)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const s = useSettings.getState()
        const { transfer, missing } = await collectTransfer(s)
        const code = newCode()
        const url = transferUrl(await sealTransfer(transfer, code))
        const labels = missing.map((id) => s.accounts.find((a) => a.id === id)).flatMap((a) => (a ? [accountLongLabel(a)] : []))
        if (live) setMade({ url, code, missing: labels })
      } catch (e) {
        if (live) setError((e as Error).message)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const share = async () => {
    if (!made) return
    try {
      if (canShare) await navigator.share({ title: 'Mail Vibes', url: made.url })
      else {
        await navigator.clipboard.writeText(made.url)
        toast({ tone: 'success', message: t('transfer.linkCopied') })
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast({ tone: 'error', message: t('setup.copyFailed') })
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('transfer.title')}
      actions={
        <Button variant="text" onClick={onClose}>
          {t('transfer.done')}
        </Button>
      }
    >
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : !made ? (
        <Spinner size={28} label={t('transfer.preparing')} />
      ) : (
        <div className="transfer">
          <ol className="body-medium transfer__steps">
            <li>{t('transfer.step1')}</li>
            <li>
              {t('transfer.step2')}
              <div className="transfer__code" aria-label={t('transfer.codeLabel')}>
                {made.code}
              </div>
            </li>
            <li>{t('transfer.step3')}</li>
          </ol>
          <div className="row-wrap">
            <Button variant="filled" icon="link" onClick={() => void share()}>
              {canShare ? t('transfer.share') : t('transfer.copyLink')}
            </Button>
          </div>
          {made.missing.length > 0 && <p className="body-small">{t('transfer.missing', { accounts: made.missing.join(', ') })}</p>}
          <p className="body-small muted">{t('transfer.security')}</p>
          <p className="body-small muted">{t('transfer.ios')}</p>
        </div>
      )}
    </Dialog>
  )
}

/** Settings → Set up from another device: paste the link (for apps on the iPhone/iPad Home Screen). */
export function PasteTransferLink() {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)
  const go = () => {
    const p = payloadFromLink(text)
    if (!p) return setBad(true)
    navigate('setup', 'device', p)
  }
  return (
    <form
      className="row-wrap"
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      <input
        className="text-field text-field--outlined transfer__paste"
        value={text}
        placeholder={t('transfer.pastePlaceholder')}
        aria-label={t('transfer.pasteLabel')}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value)
          setBad(false)
        }}
      />
      <Button variant="tonal" icon="open_in_new" type="submit" disabled={!text.trim()}>
        {t('transfer.open')}
      </Button>
      {bad && (
        <p className="body-small field-error" role="alert">
          {t('transfer.badLink')}
        </p>
      )}
    </form>
  )
}

/** #/setup/device/<payload>: type the code, check what comes, replace this device's setup. */
export function ReceiveTransfer({ payload }: { payload: string }) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [opened, setOpened] = useState<Transfer>()
  const current = useSettings((s) => s.accounts)
  const toast = useStatus((s) => s.toast)

  const open = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setOpened(await openTransfer(payload, code))
    } catch (e) {
      const kind = e instanceof TransferError ? e.kind : 'invalid'
      setError(t(`transfer.error.${kind}`))
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!opened) return
    setBusy(true)
    try {
      const settings = transferSettings(opened)
      await replaceSetup(settings)
      await storeTransferPasswords(opened, settings)
      toast({ tone: 'success', message: t('transfer.applied') })
      navigate('settings')
    } catch (e) {
      setError(t('transfer.applyFailed', { reason: (e as Error).message }))
      setBusy(false)
    }
  }

  const googleCount = opened?.passwords.filter(isGoogleSignIn).length ?? 0
  const imapCount = (opened?.passwords.length ?? 0) - googleCount

  let preview: ReturnType<typeof transferSettings> | undefined
  try {
    preview = opened && transferSettings(opened)
  } catch {
    preview = undefined
  }

  return (
    <div className="settings">
      <h1 className="headline-small page-title">{t('transfer.receiveTitle')}</h1>
      <Card className="settings__section">
        {!opened ? (
          <form
            className="transfer"
            onSubmit={(e) => {
              e.preventDefault()
              void open()
            }}
          >
            <p className="body-medium">{t('transfer.enterCode')}</p>
            <div className="row-wrap">
              <input
                className="text-field text-field--outlined transfer__code-input"
                value={code}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                aria-label={t('transfer.codeLabel')}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button variant="filled" type="submit" disabled={busy || code.replace(/[^a-z0-9]/gi, '').length < 8}>
                {t('transfer.unlock')}
              </Button>
              {busy && <Spinner size={20} />}
            </div>
          </form>
        ) : preview ? (
          <div className="transfer">
            <p className="body-medium">{t('transfer.willCopy')}</p>
            <ul className="body-medium">
              {preview.accounts.map((a) => (
                <li key={a.id}>{accountLongLabel(a)}</li>
              ))}
            </ul>
            <p className="body-small muted">
              {[
                preview.bridge && t('transfer.withBridge'),
                imapCount > 0 && t('transfer.withPasswords', { count: imapCount }),
                googleCount > 0 && t('transfer.withGoogle', { count: googleCount }),
              ]
                .filter(Boolean)
                .join(' ')}
            </p>
            <p className="body-small">{t('transfer.signInAfter')}</p>
            {current.length > 0 && <p className="body-small field-error">{t('transfer.replaces')}</p>}
            {(() => {
              const removed = current.filter((a) => !preview.accounts.some((x) => x.id === a.id))
              return removed.length > 0 && (
                <p className="body-small field-error">{t('transfer.willRemove', { accounts: removed.map(accountLongLabel).join(', ') })}</p>
              )
            })()}
            <div className="row-wrap">
              <Button variant="filled" icon="sync" disabled={busy} onClick={() => void apply()}>
                {t('transfer.apply')}
              </Button>
              <Button variant="text" onClick={() => navigate('settings')}>
                {t('settings.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="field-error">{t('transfer.error.invalid')}</p>
        )}
        {error && (
          <p className="body-medium field-error" role="alert">
            {error}
          </p>
        )}
      </Card>
    </div>
  )
}
