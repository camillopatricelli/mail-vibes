import { QueryClient } from '@tanstack/react-query'
import { AuthRequiredError } from '../auth/msal'
import { ApiError } from '../providers/graph'

/**
 * In-memory cache for everything fetched from Google/Microsoft. It is never persisted:
 * closing the app discards all mail, events and tasks.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      // The Graph client already retries throttling/5xx; retry other failures once, but never
      // retry sign-in or client errors (they won't fix themselves).
      retry: (count, error) => {
        if (error instanceof AuthRequiredError) return false
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
        return count < 1
      },
    },
    mutations: { retry: false },
  },
})
