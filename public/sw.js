/*
 * Mail Vibes service worker. It makes the app installable, lets it start without a network
 * connection, handles clicks on notifications, and shows reminders pushed by the bridge.
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

  // Other pages (the Google sign-in return page) come straight from the network, uncached.
  if (req.mode === 'navigate' && /\.html$/.test(new URL(req.url).pathname) && !/\/index\.html$/.test(new URL(req.url).pathname)) return

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

// ---------- Reminders sent by the bridge (src/notify/push.ts) ----------
// The bridge forwards reminders it can't read; they are decrypted here with the key the app
// keeps for this purpose (a key the browser can use but never hands out).

function openSecrets() {
  return new Promise((resolve, reject) => {
    // Same database and version as src/mail/imap/passwords.ts (created the same way if missing).
    const r = indexedDB.open('mail-vibes-secrets', 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('keys')
      r.result.createObjectStore('secrets')
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function reminderKey() {
  const db = await openSecrets()
  try {
    return await new Promise((resolve, reject) => {
      const q = db.transaction('keys').objectStore('keys').get('push')
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
  } finally {
    db.close()
  }
}

async function openReminder(blob) {
  const b64 = blob.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
  const key = await reminderKey()
  if (!key) throw new Error('no key')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(plain))
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let n
      try {
        n = await openReminder(event.data ? event.data.text() : '')
      } catch {
        n = { t: 'Mail Vibes', b: '' } // a notification must be shown; this one can't be read here
      }
      const options = { body: n.b || '', tag: n.g, icon: SCOPE + 'icon-192.png', badge: SCOPE + 'badge-96.png', data: { hash: n.h || '', url: n.j } }
      if (n.j) options.actions = [{ action: 'join', title: n.jl || 'Join' }]
      await self.registration.showNotification(n.t || 'Mail Vibes', options)
    })(),
  )
})
