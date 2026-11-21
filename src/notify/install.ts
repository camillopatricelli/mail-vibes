import { useSyncExternalStore } from 'react'

/**
 * Installing the app. Chrome and Edge offer an install prompt that the app can show from a
 * button; Safari (iOS, macOS) installs through the Share menu instead.
 */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPrompt | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPrompt
    changed()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    changed()
  })
}

export function useCanInstall() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => !!deferred,
  )
}

export async function install() {
  const p = deferred
  if (!p) return
  await p.prompt()
  await p.userChoice
  deferred = null
  changed()
}

/** Service worker: production builds only (in development it would serve stale files). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => undefined)
}
