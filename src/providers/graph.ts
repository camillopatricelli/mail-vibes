import { AuthRequiredError, getGraphToken } from '../auth/msal'
import { useStatus } from '../status/store'

/**
 * Microsoft Graph client. Every call reports its outcome to the status store, so per-account
 * "last updated" and error banners are always accurate. Errors are re-thrown, never swallowed.
 */

const BASE = 'https://graph.microsoft.com/v1.0'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network error: check your connection') {
    super(message)
    this.name = 'NetworkError'
  }
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  /** Return the raw Response (for binary downloads) */
  raw?: boolean
  /** Don't update the account's status (e.g. for best-effort background lookups) */
  quiet?: boolean
  signal?: AbortSignal
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function graph<T = unknown>(accountId: string, path: string, req: GraphRequest = {}): Promise<T> {
  const status = useStatus.getState()
  const url = path.startsWith('https://') ? path : BASE + path
  try {
    let forceRefresh = false
    for (let attempt = 0; ; attempt++) {
      const token = await getGraphToken(accountId, forceRefresh)
      let res: Response
      try {
        res = await fetch(url, {
          method: req.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(req.body !== undefined && !(req.body instanceof Blob) && !(req.body instanceof ArrayBuffer)
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...req.headers,
          },
          body:
            req.body === undefined
              ? undefined
              : req.body instanceof Blob || req.body instanceof ArrayBuffer
                ? (req.body as BodyInit)
                : JSON.stringify(req.body),
          signal: req.signal,
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        throw new NetworkError()
      }

      if (res.status === 401 && attempt === 0) {
        forceRefresh = true
        continue
      }
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt
        await sleep(Math.min(retryAfter, 30) * 1000)
        continue
      }
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`
        let code: string | undefined
        try {
          const j = (await res.json()) as { error?: { code?: string; message?: string } }
          if (j.error?.message) message = j.error.message
          code = j.error?.code
        } catch {
          /* non-JSON error body */
        }
        if (res.status === 401) throw new AuthRequiredError(message)
        throw new ApiError(message, res.status, code)
      }
      if (!req.quiet) status.reportSuccess(accountId)
      if (req.raw) return res as T
      if (res.status === 202 || res.status === 204) return undefined as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
  } catch (e) {
    if (!req.quiet && (e as Error).name !== 'AbortError') {
      if (e instanceof AuthRequiredError) status.reportError(accountId, 'auth', e.message)
      else if (e instanceof NetworkError) status.reportError(accountId, 'network', e.message)
      else if (e instanceof ApiError && e.status >= 500) status.reportError(accountId, 'api', e.message)
      // 4xx errors on a single item (e.g. "not found") are surfaced by the caller, not as an
      // account-wide banner, because the account itself is still working.
    }
    throw e
  }
}

export interface GraphPage<T> {
  value: T[]
  '@odata.nextLink'?: string
}
