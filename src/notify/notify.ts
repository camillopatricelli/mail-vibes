/**
 * Browser notifications. They only work while the app is open (in a tab, window or installed
 * app, possibly in the background): there is no server that could push them.
 *
 * Through the service worker where there is one (required on Android and in installed iOS apps,
 * and needed for clicks to reach a background window), else with the plain Notification API.
 */

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

export const permission = (): NotificationPermission | 'unsupported' => (notificationsSupported() ? Notification.permission : 'unsupported')

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

export interface NotifyOptions {
  body?: string
  /** Same tag = replaces the earlier notification instead of adding one */
  tag?: string
  /** App address to open on click, e.g. "#/mail/inbox" */
  hash?: string
  /** Online meeting link: adds a "Join" button where the platform supports it */
  joinUrl?: string
  joinLabel?: string
}

const icon = () => `${import.meta.env.BASE_URL}icon-192.png`
/** Android draws the status-bar badge from the image's shape only, so it needs a white-on-transparent one. */
const badge = () => `${import.meta.env.BASE_URL}badge-96.png`

export async function notify(title: string, o: NotifyOptions = {}) {
  if (permission() !== 'granted') return
  const data = { hash: o.hash ?? '', url: o.joinUrl }
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
  if (reg) {
    const options: NotificationOptions & { actions?: { action: string; title: string }[] } = { body: o.body, tag: o.tag, icon: icon(), badge: badge(), data }
    if (o.joinUrl) options.actions = [{ action: 'join', title: o.joinLabel ?? 'Join' }]
    await reg.showNotification(title, options)
    return
  }
  const n = new Notification(title, { body: o.body, tag: o.tag, icon: icon(), data })
  n.onclick = () => {
    window.focus()
    if (o.hash) location.hash = o.hash
    n.close()
  }
}

/** Clicks on notifications shown by the service worker arrive here as messages. */
export function listenForNotificationClicks() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; hash?: string }>) => {
    if (e.data?.type === 'navigate' && e.data.hash) location.hash = e.data.hash
  })
}

/** The unread count on the window title and, in installed apps, on the app icon. */
export function showUnreadCount(count: number, appName: string) {
  document.title = count > 0 ? `(${count}) ${appName}` : appName
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined)
  else void nav.clearAppBadge?.().catch(() => undefined)
}
