import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './theme/global.css'
import './ui/ui.css'
import './mail/mail.css'

/**
 * The OAuth redirect URI is the app's root. When Microsoft sends the browser back here with an
 * authorization response (in a popup, or after a full-page redirect), hand it to MSAL's redirect
 * bridge instead of starting the app.
 */
function isAuthResponse() {
  const s = `${location.search}&${location.hash.replace(/^#/, '')}`
  return /[?&]state=/.test(s) && /[?&](code|error)=/.test(s)
}

async function start() {
  if (isAuthResponse()) {
    const { broadcastResponseToMainFrame } = await import('@azure/msal-browser/redirect-bridge')
    try {
      await broadcastResponseToMainFrame()
    } catch (e) {
      document.body.textContent = `Sign-in could not be completed: ${(e as Error).message}`
    }
    return
  }

  const [{ StrictMode }, { createRoot }, { QueryClientProvider }, { queryClient }, , { applyTheme }, { useSettings }, { App }, { handleRedirects }] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('./lib/queryClient'),
      import('./i18n'),
      import('./theme/theme'),
      import('./settings/store'),
      import('./App'),
      import('./auth/msal'),
    ])

  // Apply the theme before first paint to avoid a flash of unstyled colours.
  const { seedColor, theme } = useSettings.getState()
  applyTheme(seedColor, theme)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )

  // Completes a full-page (redirect) sign-in, used in installed iOS apps.
  void handleRedirects()
  void import('./auth/google').then((g) => g.preloadGoogle())
}

void start()
