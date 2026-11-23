import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isIos, isStandalone } from '../shell/reminders'
import { useSettings } from '../settings/store'
import { Button } from '../ui/components'
import { install, useCanInstall } from './install'
import { notify, permission, requestPermission } from './notify'
import { disablePush, enablePush, pushSupported, usePushState } from './push'

/** Settings → Notifications and app installation. */
export function NotificationSettings({ Field }: { Field: (p: { label: string; children: React.ReactNode }) => React.ReactNode }) {
  const { t } = useTranslation()
  const s = useSettings()
  const [perm, setPerm] = useState(permission())
  const canInstall = useCanInstall()
  const iosBrowser = isIos() && !isStandalone()
  const push = usePushState()
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string>()

  const togglePush = (on: boolean) => {
    setPushBusy(true)
    setPushError(undefined)
    // Started straight from the click: the permission prompt needs it (iPhone, iPad).
    ;(on ? enablePush() : disablePush())
      .catch((e) => setPushError((e as Error).message))
      .finally(() => {
        setPushBusy(false)
        setPerm(permission())
      })
  }

  return (
    <>
      <p className="body-small muted">{push.on ? t('notify.withPush') : t('notify.onlyWhileOpen')}</p>
      <Field label={t('notify.permission')}>
        {perm === 'granted' ? (
          <span className="body-medium">{t('notify.granted')}</span>
        ) : perm === 'denied' ? (
          <span className="body-medium field-error">{t('notify.denied')}</span>
        ) : perm === 'unsupported' ? (
          <span className="body-medium muted">{iosBrowser ? t('notify.iosInstallFirst') : t('notify.unsupported')}</span>
        ) : (
          <Button variant="tonal" icon="notifications" onClick={() => void requestPermission().then(setPerm)}>
            {t('notify.turnOn')}
          </Button>
        )}
      </Field>
      <Field label={t('notify.mail')}>
        <input type="checkbox" checked={s.notifyMail} onChange={(e) => s.update({ notifyMail: e.target.checked })} aria-label={t('notify.mail')} />
      </Field>
      <Field label={t('notify.events')}>
        <input type="checkbox" checked={s.notifyEvents} onChange={(e) => s.update({ notifyEvents: e.target.checked })} aria-label={t('notify.events')} />
      </Field>
      <Field label={t('notify.atStart')}>
        <input
          type="checkbox"
          checked={s.notifyAtStart}
          disabled={!s.notifyEvents}
          onChange={(e) => s.update({ notifyAtStart: e.target.checked })}
          aria-label={t('notify.atStart')}
        />
      </Field>
      <Field label={t('push.title')}>
        {!s.bridge ? (
          <span className="body-small muted">{t('push.needsBridge')}</span>
        ) : !push.bridgeCan ? (
          <span className="body-small muted">{t('push.bridgeNotReady')}</span>
        ) : !pushSupported() ? (
          <span className="body-small muted">{iosBrowser ? t('notify.iosInstallFirst') : t('notify.unsupported')}</span>
        ) : (
          <span className="row-wrap">
            <input
              type="checkbox"
              checked={push.on}
              disabled={pushBusy || !s.notifyEvents}
              onChange={(e) => togglePush(e.target.checked)}
              aria-label={t('push.title')}
            />
            <span className="body-small muted">{push.on ? t('push.onHere') : t('push.offHere')}</span>
          </span>
        )}
        {pushError && (
          <p className="body-small field-error" role="alert">
            {pushError}
          </p>
        )}
      </Field>
      {perm === 'granted' && (
        <Field label={t('notify.test')}>
          <Button variant="text" icon="notifications" onClick={() => void notify(t('notify.testTitle'), { body: t('notify.testBody'), tag: 'test' })}>
            {t('notify.sendTest')}
          </Button>
        </Field>
      )}
      <Field label={t('notify.install')}>
        {isStandalone() ? (
          <span className="body-medium">{t('notify.installed')}</span>
        ) : canInstall ? (
          <Button variant="tonal" icon="download" onClick={() => void install()}>
            {t('notify.installButton')}
          </Button>
        ) : (
          <span className="body-small muted">{isIos() ? t('notify.installIos') : t('notify.installBrowser')}</span>
        )}
      </Field>
    </>
  )
}
