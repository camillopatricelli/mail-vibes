import { useEffect, useState } from 'react'
import i18n from '../i18n'

/** Re-renders the caller every `ms` so relative times ("2 minutes ago") stay fresh. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export function timeAgo(ts: number, now = Date.now()): string {
  const t = i18n.t.bind(i18n)
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return t('time.justNow')
  const m = Math.round(s / 60)
  if (m < 60) return t('time.minutesAgo', { count: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('time.hoursAgo', { count: h })
  return t('time.daysAgo', { count: Math.round(h / 24) })
}
