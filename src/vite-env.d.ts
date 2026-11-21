/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** JSON list of built-in Microsoft 365 organisations (see src/config.ts) */
  readonly VITE_MS_TENANTS?: string
  /** Google OAuth client ID (web application) */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
