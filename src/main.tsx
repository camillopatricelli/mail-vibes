import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './theme/global.css'
import './ui/ui.css'
import './i18n'
import { applyTheme } from './theme/theme'
import { useSettings } from './settings/store'
import { App } from './App'

// Apply the theme before first paint to avoid a flash of unstyled colours.
const { seedColor, theme } = useSettings.getState()
applyTheme(seedColor, theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
