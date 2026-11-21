import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettings } from '../settings/store'
import { useStatus, type Banner } from '../status/store'
import { Button, Icon, IconButton } from '../ui/components'
import { dismissNotifyReminder, NOTIFY_REMINDER_ID } from './reminders'

/** Hooks for re-authentication, registered by the auth layer (phase 1+). */
export const reauthHandlers: Record<string, (accountId: string) => void> = {}

function BannerView({ b, onDismiss }: { b: Banner; onDismiss?: () => void }) {
  const { t } = useTranslation()
  const icon = b.tone === 'error' ? 'error' : b.tone === 'warning' ? 'warning' : 'info'
  const { title, body } = b.text ? b.text() : b
  return (
    <div className={`banner banner--${b.tone}`} role={b.tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div className="banner__text">
        <p className="title-small">{title}</p>
        {body && <p className="body-medium">{body}</p>}
      </div>
      <div className="banner__actions">
        {b.action && (
          <Button variant="text" onClick={b.action.run}>
            {b.action.label}
          </Button>
        )}
        {b.dismissible && onDismiss && <IconButton icon="close" label={t('banner.dismiss')} onClick={onDismiss} />}
      </div>
    </div>
  )
}

/**
 * App-wide banners: explicit banners plus one per account in error.
 * Account errors are not dismissible: they disappear only when the account works again.
 */
export function Banners() {
  const { t } = useTranslation()
  const banners = useStatus((s) => s.banners)
  const dismiss = useStatus((s) => s.dismissBanner)
  const status = useStatus((s) => s.accounts)
  const accounts = useSettings((s) => s.accounts)

  const accountBanners: Banner[] = accounts.flatMap((a) => {
    const err = status[a.id]?.error
    if (!err) return []
    const name = a.displayName ? `${a.displayName} (${a.email})` : a.email
    const reauth = reauthHandlers[a.provider]
    return [
      {
        id: `account-${a.id}`,
        tone: err.kind === 'auth' ? 'warning' : 'error',
        title: err.kind === 'auth' ? `${t('accounts.needsSignIn')}: ${name}` : `${t('accounts.error')}: ${name}`,
        body: err.message,
        accountId: a.id,
        dismissible: false,
        action:
          err.kind === 'auth' && reauth
            ? { label: t('banner.signIn'), run: () => reauth(a.id) }
            : undefined,
      } satisfies Banner,
    ]
  })

  const all = [...accountBanners, ...banners]
  if (!all.length) return null
  return (
    <div className="banners">
      {all.map((b) => (
        <BannerView
          key={b.id}
          b={b}
          onDismiss={b.id === NOTIFY_REMINDER_ID ? dismissNotifyReminder : () => dismiss(b.id)}
        />
      ))}
    </div>
  )
}

function ToastView({ id, message, tone, action }: { id: string; message: string; tone: string; action?: { label: string; run: () => void } }) {
  const { t } = useTranslation()
  const dismiss = useStatus((s) => s.dismissToast)
  useEffect(() => {
    // Errors stay until dismissed; info and success disappear after a while.
    if (tone === 'error') return
    const h = setTimeout(() => dismiss(id), 6000)
    return () => clearTimeout(h)
  }, [id, tone, dismiss])
  return (
    <div className={`snackbar snackbar--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="body-medium">{message}</span>
      {action && (
        <Button variant="text" onClick={() => { action.run(); dismiss(id) }}>
          {action.label}
        </Button>
      )}
      <IconButton icon="close" label={t('banner.dismiss')} onClick={() => dismiss(id)} />
    </div>
  )
}

export function Toasts() {
  const toasts = useStatus((s) => s.toasts)
  return (
    <div className="snackbars" aria-live="polite">
      {toasts.map((x) => (
        <ToastView key={x.id} {...x} />
      ))}
    </div>
  )
}
