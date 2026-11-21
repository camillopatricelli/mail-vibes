import { create } from 'zustand'

/**
 * In-memory only. Tracks the health of every account so the UI can always show
 * "last updated X ago" and surface every failure. Errors are never swallowed:
 * any failed request must call `reportError`.
 */

export type AccountErrorKind = 'auth' | 'network' | 'api'

export interface AccountStatus {
  lastSuccessAt?: number
  error?: { kind: AccountErrorKind; message: string; at: number }
  busy: boolean
}

export interface Banner {
  id: string
  tone: 'error' | 'warning' | 'info'
  title: string
  body?: string
  /** Computes title/body at render time (follows language changes). */
  text?: () => { title: string; body?: string }
  accountId?: string
  action?: { label: string; run: () => void }
  dismissible: boolean
}

export interface Toast {
  id: string
  message: string
  tone: 'info' | 'success' | 'error'
  action?: { label: string; run: () => void }
}

interface StatusState {
  accounts: Record<string, AccountStatus>
  banners: Banner[]
  toasts: Toast[]
  markBusy: (accountId: string, busy: boolean) => void
  reportSuccess: (accountId: string) => void
  reportError: (accountId: string, kind: AccountErrorKind, message: string) => void
  clearError: (accountId: string) => void
  showBanner: (b: Banner) => void
  dismissBanner: (id: string) => void
  toast: (t: Omit<Toast, 'id'> & { id?: string }) => string
  dismissToast: (id: string) => void
}

let seq = 0
const nextId = () => `t${++seq}`

export const useStatus = create<StatusState>()((set, get) => ({
  accounts: {},
  banners: [],
  toasts: [],
  markBusy: (id, busy) => set({ accounts: { ...get().accounts, [id]: { ...get().accounts[id], busy } } }),
  reportSuccess: (id) =>
    set({ accounts: { ...get().accounts, [id]: { ...get().accounts[id], busy: false, lastSuccessAt: Date.now(), error: undefined } } }),
  reportError: (id, kind, message) =>
    set({
      accounts: {
        ...get().accounts,
        [id]: { ...get().accounts[id], busy: false, error: { kind, message, at: Date.now() } },
      },
    }),
  clearError: (id) => set({ accounts: { ...get().accounts, [id]: { ...get().accounts[id], busy: false, error: undefined } } }),
  showBanner: (b) => set({ banners: [...get().banners.filter((x) => x.id !== b.id), b] }),
  dismissBanner: (id) => set({ banners: get().banners.filter((b) => b.id !== id) }),
  toast: (t) => {
    const id = t.id ?? nextId()
    set({ toasts: [...get().toasts.filter((x) => x.id !== id), { ...t, id }] })
    return id
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
