/**
 * App registrations.
 *
 * The public app ships with NO built-in Microsoft 365 organisations: users add their own in
 * Settings (or by opening a setup link / importing a settings file shared by their admin).
 *
 * Self-hosters and local development can provide built-in organisations at build time through
 * the VITE_MS_TENANTS environment variable (e.g. in a git-ignored `.env.local`), as JSON:
 *   VITE_MS_TENANTS=[{"key":"org1","name":"My organisation","clientId":"<guid>","tenantId":"<guid>"}]
 * Use tenantId "common" / "organizations" / "consumers" for multitenant or personal-account apps.
 */
export interface MicrosoftTenantConfig {
  /** Stable key stored with each signed-in account. Never change it once users rely on it. */
  key: string
  name: string
  clientId: string
  tenantId: string
}

export interface GoogleConfig {
  /** OAuth client ID of type "Web application". Provided via VITE_GOOGLE_CLIENT_ID. */
  clientId: string
}

function parseTenants(raw: string | undefined): MicrosoftTenantConfig[] {
  if (!raw) return []
  try {
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) throw new Error('not an array')
    return list.filter(
      (t): t is MicrosoftTenantConfig =>
        !!t && typeof t.key === 'string' && typeof t.name === 'string' && typeof t.clientId === 'string' && typeof t.tenantId === 'string',
    )
  } catch (e) {
    console.error('VITE_MS_TENANTS is not valid JSON:', e)
    return []
  }
}

export const microsoftTenants: MicrosoftTenantConfig[] = parseTenants(import.meta.env.VITE_MS_TENANTS)

export const google: GoogleConfig = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
}

export const appInfo = {
  name: 'Mail Vibes',
  repoUrl: 'https://github.com/camillopatricelli/mail-vibes',
}
