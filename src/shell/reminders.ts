import { useEffect } from 'react'
import i18n from '../i18n'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'

const REMIND_EVERY_MS = 7 * 24 * 3600_000 // weekly
const LONG_ABSENCE_MS = 4 * 3600_000 // app regains focus after 4+ hours
const BANNER_ID = 'notify-reminder'

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true

function show() {
  const ios = isIos() && !isStandalone()
  const text = () => {
    const t = i18n.t.bind(i18n)
    return {
      title: t('banner.notifyReminderTitle'),
      body: t('banner.notifyReminderBody') + (ios ? ' ' + t('banner.notifyReminderIos') : ''),
    }
  }
  useStatus.getState().showBanner({ id: BANNER_ID, tone: 'info', ...text(), text, dismissible: true })
}

/** Dismissing the reminder records the time, so it comes back after a week. */
export function dismissNotifyReminder() {
  useSettings.getState().update({ notifyReminderDismissedAt: Date.now() })
  useStatus.getState().dismissBanner(BANNER_ID)
}
export const NOTIFY_REMINDER_ID = BANNER_ID

/**
 * Shows the "notifications only while the app is open" reminder:
 * on first run, then weekly, and whenever the app regains focus after a long absence.
 */
export function useNotifyReminder() {
  useEffect(() => {
    const last = useSettings.getState().notifyReminderDismissedAt
    if (!last || Date.now() - last > REMIND_EVERY_MS) show()

    let hiddenAt: number | null = document.hidden ? Date.now() : null
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
      } else if (hiddenAt && Date.now() - hiddenAt > LONG_ABSENCE_MS) {
        hiddenAt = null
        show()
      } else {
        hiddenAt = null
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
}
