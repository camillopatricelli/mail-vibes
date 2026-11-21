/*
 * Mail Vibes service worker. It makes the app installable, lets it start without a network
 * connection, and handles clicks on notifications.
 *
 * Only the app's own files are cached (code, styles, fonts, icons). Requests to Google and
 * Microsoft are never touched, so no mail, events, tasks or contacts are stored on the device.
 */
const CACHE = 'mail-vibes-app'
const SCOPE = self.registration.scope

/** Files of older versions pile up after updates: keep the most recent ones only. */
async function prune(cache) {
  const keys = await cache.keys()
  for (const k of keys.slice(0, Math.max(0, keys.length - 150))) if (k.url !== SCOPE) await cache.delete(k)
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return

  if (req.mode === 'navigate') {
    // The page itself: always the latest version when online, the cached one when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(CACHE).then((c) => c.put(SCOPE, copy))
          }
          return res
        })
        .catch(() => caches.match(SCOPE).then((r) => r || Response.error())),
    )
    return
  }

  // Build files have content hashes in their names, so a cached copy is always correct.
  const path = new URL(req.url).pathname
  if (/\/assets\/|\.(svg|png|webmanifest|woff2?|mjs)$/.test(path)) {
    event.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) void c.put(req, res.clone()).then(() => prune(c))
              return res
            }),
        ),
      ),
    )
  }
})

self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  const data = n.data || {}
  n.close()
  if (event.action === 'join' && data.url) {
    event.waitUntil(self.clients.openWindow(data.url))
    return
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const win = windows.find((w) => w.url.startsWith(SCOPE))
      if (win) {
        win.postMessage({ type: 'navigate', hash: data.hash || '' })
        return win.focus()
      }
      return self.clients.openWindow(SCOPE + (data.hash || ''))
    }),
  )
})
