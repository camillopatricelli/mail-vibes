import { useSyncExternalStore } from 'react'

/**
 * Tiny hash router (#/mail, #/settings ...). Hash routing works on GitHub Pages without
 * server rewrites, and never collides with the OAuth redirect parameters.
 */
export type Route = 'today' | 'mail' | 'calendar' | 'tasks' | 'search' | 'settings' | 'privacy' | 'setup'
const routes: Route[] = ['today', 'mail', 'calendar', 'tasks', 'search', 'settings', 'privacy', 'setup']

export interface Location {
  route: Route | null
  /** Path segments after the route, e.g. #/mail/thread/abc -> ['thread', 'abc'] */
  params: string[]
}

const inBrowser = typeof window !== 'undefined'

function parse(): Location {
  if (!inBrowser) return { route: null, params: [] }
  const [first, ...rest] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const route = routes.includes(first as Route) ? (first as Route) : null
  return { route, params: rest.map(decodeURIComponent) }
}

let current = parse()
const listeners = new Set<() => void>()
if (inBrowser)
  window.addEventListener('hashchange', () => {
    current = parse()
    listeners.forEach((l) => l())
  })

export function useLocation(): Location {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

export function href(route: Route, ...params: string[]) {
  return `#/${[route, ...params.map(encodeURIComponent)].join('/')}`
}

export function navigate(route: Route, ...params: string[]) {
  location.hash = href(route, ...params)
}
