import { AuthRequiredError } from '../auth/errors'
import i18n from '../i18n'
import { getGoogleToken, markGoogleTokenInvalid } from '../auth/google'
import { useStatus } from '../status/store'
import { ApiError, NetworkError, type GraphRequest } from './graph'

/**
 * Google REST client (Gmail, Calendar, Tasks, People). Like the Graph client, every call reports
 * its outcome to the account's status, and errors are always re-thrown.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Gmail rejects "too many concurrent requests for user", so calls per account are throttled.
const MAX_PARALLEL = 3
const slots = new Map<string, { active: number; queue: (() => void)[] }>()

async function acquire(accountId: string) {
  let s = slots.get(accountId)
  if (!s) slots.set(accountId, (s = { active: 0, queue: [] }))
  if (s.active >= MAX_PARALLEL) await new Promise<void>((r) => s.queue.push(r))
  s.active++
  return () => {
    s.active--
    s.queue.shift()?.()
  }
}

const isRateLimit = (status: number, text: string) =>
  status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|concurrent/i.test(text))

export async function google<T = unknown>(accountId: string, url: string, req: GraphRequest = {}): Promise<T> {
  const release = await acquire(accountId)
  try {
    return await request<T>(accountId, url, req)
  } finally {
    release()
  }
}

async function request<T>(accountId: string, url: string, req: GraphRequest): Promise<T> {
  const status = useStatus.getState()
  try {
    for (let attempt = 0; ; attempt++) {
      const token = getGoogleToken(accountId)
      let res: Response
      try {
        const isJson = req.body !== undefined && !(req.body instanceof Blob) && typeof req.body !== 'string'
        res = await fetch(url, {
          method: req.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(isJson ? { 'Content-Type': 'application/json' } : {}),
            ...req.headers,
          },
          body: req.body === undefined ? undefined : isJson ? JSON.stringify(req.body) : (req.body as BodyInit),
          signal: req.signal,
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        throw new NetworkError()
      }
      if (res.status === 401) {
        markGoogleTokenInvalid(accountId)
        throw new AuthRequiredError(i18n.t('accounts.googleSignIn'))
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('Retry-After')) || 2 ** attempt
        await sleep(Math.min(retryAfter, 30) * 1000)
        continue
      }
      // Gmail also reports rate limits as 403 (rateLimitExceeded/userRateLimitExceeded).
      if (res.status === 403 && attempt < 4 && isRateLimit(403, await res.clone().text())) {
        await sleep(2 ** attempt * 1000)
        continue
      }
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`
        let code: string | undefined
        try {
          const j = (await res.json()) as { error?: { message?: string; status?: string } }
          if (j.error?.message) message = j.error.message
          code = j.error?.status
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(message, res.status, code)
      }
      if (!req.quiet) status.reportSuccess(accountId)
      if (req.raw) return res as T
      if (res.status === 204) return undefined as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
  } catch (e) {
    if (!req.quiet && (e as Error).name !== 'AbortError') {
      if (e instanceof AuthRequiredError) status.reportError(accountId, 'auth', e.message)
      else if (e instanceof NetworkError) status.reportError(accountId, 'network', e.message)
      else if (e instanceof ApiError && e.status >= 500) status.reportError(accountId, 'api', e.message)
    }
    throw e
  }
}

export interface BatchPart<T> {
  status: number
  body: T | { error?: { message?: string } }
}

/**
 * Google batch request (multipart/mixed). Calls are sent in small batches, one batch at a time,
 * because Gmail counts every call in a batch towards its per-user concurrency limit. Calls that
 * were rate-limited are retried with backoff. `path` is relative to the API root, e.g.
 * "/gmail/v1/users/me/messages/abc?format=metadata".
 */
export async function googleBatch<T>(
  accountId: string,
  endpoint: string,
  calls: { method?: string; path: string; body?: unknown }[],
  chunkSize = 10,
): Promise<BatchPart<T>[]> {
  const out: BatchPart<T>[] = new Array(calls.length)
  let pending = calls.map((_, i) => i)
  for (let attempt = 0; pending.length; attempt++) {
    const retry: number[] = []
    for (let i = 0; i < pending.length; i += chunkSize) {
      const idx = pending.slice(i, i + chunkSize)
      const parts = await sendBatch<T>(accountId, endpoint, idx.map((k) => calls[k]))
      parts.forEach((p, j) => {
        if (attempt < 4 && (isRateLimit(p.status, JSON.stringify(p.body)) || p.status >= 500)) retry.push(idx[j])
        else out[idx[j]] = p
      })
    }
    pending = retry
    if (pending.length) await sleep(2 ** attempt * 1000)
  }
  return out
}

async function sendBatch<T>(accountId: string, endpoint: string, chunk: { method?: string; path: string; body?: unknown }[]) {
  const boundary = `batch_${Math.random().toString(36).slice(2)}`
  const body =
    chunk
      .map((c, j) => {
        const payload = c.body === undefined ? '' : JSON.stringify(c.body)
        return (
          `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${j}>\r\n\r\n` +
          `${c.method ?? 'GET'} ${c.path}\r\n` +
          (payload ? `Content-Type: application/json\r\n\r\n${payload}\r\n` : '\r\n')
        )
      })
      .join('') + `--${boundary}--`
  const res = await google<Response>(accountId, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    body,
    raw: true,
  })
  const text = await res.text()
  const m = /boundary=("?)([^";]+)\1/i.exec(res.headers.get('Content-Type') ?? '')
  if (!m) throw new ApiError('Malformed batch response', 500)
  const parts = new Map<number, BatchPart<T>>()
  for (const raw of text.split(`--${m[2]}`)) {
    const id = /Content-ID:\s*<response-item(\d+)>/i.exec(raw)
    const statusLine = /HTTP\/[\d.]+\s+(\d{3})/.exec(raw)
    if (!id || !statusLine) continue
    const jsonStart = raw.indexOf('{')
    let parsed: unknown = {}
    if (jsonStart >= 0) {
      try {
        parsed = JSON.parse(raw.slice(jsonStart, raw.lastIndexOf('}') + 1))
      } catch {
        parsed = {}
      }
    }
    parts.set(Number(id[1]), { status: Number(statusLine[1]), body: parsed as T })
  }
  return chunk.map((_, j) => parts.get(j) ?? { status: 500, body: { error: { message: 'Missing batch response' } } })
}

/** Throws if any part of a batch failed (with a short summary). */
export function assertBatchOk(parts: BatchPart<unknown>[]) {
  const failed = parts.filter((p) => p.status >= 400)
  if (!failed.length) return
  const first = (failed[0].body as { error?: { message?: string } }).error?.message ?? `HTTP ${failed[0].status}`
  throw new ApiError(failed.length === parts.length ? first : `${failed.length} of ${parts.length} failed: ${first}`, failed[0].status)
}
