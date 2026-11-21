import { isGuid, isTenantId } from '../settings/store'

/**
 * Setup links let an admin share an organisation's app registration with colleagues:
 *   https://<host>/<base>/#/setup/org/<payload>
 * The payload is base64url-encoded JSON { n: name, c: clientId, t: tenantId }.
 * It contains only public identifiers (no secrets); opening it asks the user to confirm.
 */
export interface OrgPayload {
  name: string
  clientId: string
  tenantId: string
}

function toBase64Url(s: string) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodeOrg(o: OrgPayload): string {
  return toBase64Url(JSON.stringify({ n: o.name, c: o.clientId, t: o.tenantId }))
}

/** Returns null if the payload is malformed or the identifiers are invalid. */
export function decodeOrg(payload: string): OrgPayload | null {
  try {
    const r = JSON.parse(fromBase64Url(payload)) as { n?: unknown; c?: unknown; t?: unknown }
    const name = typeof r.n === 'string' ? r.n.trim().slice(0, 100) : ''
    if (!name || !isGuid(r.c) || !isTenantId(r.t)) return null
    return { name, clientId: r.c.trim().toLowerCase(), tenantId: r.t.trim().toLowerCase() }
  } catch {
    return null
  }
}

export function orgSetupUrl(o: OrgPayload): string {
  return `${location.origin}${import.meta.env.BASE_URL}#/setup/org/${encodeOrg(o)}`
}
