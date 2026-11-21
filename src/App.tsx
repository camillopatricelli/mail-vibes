import { useEffect } from 'react'
import { applyLanguage, resolveLanguage } from './i18n'
import { navigate, useLocation } from './lib/router'
import { PlaceholderPage, PrivacyPage, TodayPage } from './pages/SimplePages'
import { SettingsPage } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'
import { useSettings } from './settings/store'
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

  useEffect(() => {
    if (!route) navigate(homePage)
  }, [route, homePage])

  let page = null
  switch (route) {
    case 'today':
      page = <TodayPage />
      break
    case 'mail':
    case 'calendar':
    case 'tasks':
      page = <PlaceholderPage section={route} />
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
