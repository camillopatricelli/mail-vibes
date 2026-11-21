import { useEffect } from 'react'
import './auth/accounts'
import { applyLanguage, resolveLanguage } from './i18n'
import { MailPage } from './mail/MailPage'
import { CalendarPage } from './calendar/CalendarPage'
import { TasksPage } from './tasks/TasksPage'
import { SearchPage } from './search/SearchPage'
import { navigate, useLocation } from './lib/router'
import { PrivacyPage, TodayPage } from './pages/SimplePages'
import { SettingsPage } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'
import { useSettings } from './settings/store'
import { useContactsVersion } from './mail/addressBook'
import { AppShell } from './shell/AppShell'
import { applyTheme } from './theme/theme'

function useThemeAndLanguage() {
  const seed = useSettings((s) => s.seedColor)
  const theme = useSettings((s) => s.theme)
  const language = useSettings((s) => s.language)

  useEffect(() => {
    applyTheme(seed, theme)
    if (theme !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(seed, theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [seed, theme])

  useEffect(() => {
    applyLanguage(resolveLanguage(language))
    if (language !== 'auto') return
    const onChange = () => applyLanguage(resolveLanguage('auto'))
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [language])
}

export function App() {
  useThemeAndLanguage()
  const { route, params } = useLocation()
  const homePage = useSettings((s) => s.homePage)
  // Names shown everywhere come from the contacts: re-render when they change.
  useContactsVersion()

  useEffect(() => {
    if (!route) navigate(homePage)
  }, [route, homePage])

  let page = null
  switch (route) {
    case 'today':
      page = <TodayPage />
      break
    case 'mail':
      page = <MailPage />
      break
    case 'calendar':
      page = <CalendarPage />
      break
    case 'tasks':
      page = <TasksPage />
      break
    case 'search':
      page = <SearchPage />
      break
    case 'settings':
      page = <SettingsPage />
      break
    case 'privacy':
      page = <PrivacyPage />
      break
    case 'setup':
      page = <SetupPage params={params} />
      break
  }
  return <AppShell>{page}</AppShell>
}
