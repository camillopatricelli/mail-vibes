import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './theme/global.css'
import './ui/ui.css'
import './mail/mail.css'
import './calendar/calendar.css'
import './tasks/tasks.css'
import './weather/weather.css'

/**
 * The OAuth redirect URI is the app's root. When Microsoft sends the browser back here with an
 * authorization response (in a popup, or after a full-page redirect), hand it to MSAL's redirect
 * bridge instead of starting the app.
 */
function isAuthResponse() {
  const s = `${location.search}&${location.hash.replace(/^#/, '')}`
  return /[?&]state=/.test(s) && /[?&](code|error)=/.test(s)
}

/**
 * After a full-page sign-in, MSAL goes back to the page where it started. With hash routing that
 * address often differs from this one only after "#", which changes the hash without loading the
 * page, so the app never started (a blank page, then a time-out). Reload in that case.
 */
const navigationClient = {
  async navigateInternal(url: string) {
    const samePage = new URL(url, location.href).href.split('#')[0] === location.href.split('#')[0]
    location.replace(url)
    if (samePage) location.reload()
    return true
  },
  async navigateExternal(url: string) {
    location.assign(url)
    return true
  },
}

async function start() {
  if (isAuthResponse()) {
    const { broadcastResponseToMainFrame } = await import('@azure/msal-browser/redirect-bridge')
    try {
      await broadcastResponseToMainFrame(navigationClient)
    } catch (e) {
      // Say what happened and offer a way back, rather than leaving a page with no way out.
      document.body.textContent = `Sign-in could not be completed: ${(e as Error).message} `
      const back = document.createElement('a')
      back.href = import.meta.env.BASE_URL
      back.textContent = 'Back to Mail Vibes'
      document.body.append(back)
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

  const [{ registerServiceWorker, captureInstallPrompt }, { listenForNotificationClicks }] = await Promise.all([
    import('./notify/install'),
    import('./notify/notify'),
  ])
  captureInstallPrompt()
  listenForNotificationClicks()
  registerServiceWorker()

  // Completes a full-page (redirect) sign-in, used in installed iOS apps.
  void handleRedirects()
  void import('./auth/google').then((g) => {
    g.preloadGoogle()
    void g.finishGoogleRedirect()
  })
  void import('./notify/push').then((p) => p.startPush())
}

void start()
