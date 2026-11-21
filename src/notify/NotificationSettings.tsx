import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isIos, isStandalone } from '../shell/reminders'
import { useSettings } from '../settings/store'
import { Button } from '../ui/components'
import { install, useCanInstall } from './install'
import { notify, permission, requestPermission } from './notify'

/** Settings → Notifications and app installation. */
export function NotificationSettings({ Field }: { Field: (p: { label: string; children: React.ReactNode }) => React.ReactNode }) {
  const { t } = useTranslation()
  const s = useSettings()
  const [perm, setPerm] = useState(permission())
  const canInstall = useCanInstall()
  const iosBrowser = isIos() && !isStandalone()

  return (
    <>
      <p className="body-small muted">{t('notify.onlyWhileOpen')}</p>
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
