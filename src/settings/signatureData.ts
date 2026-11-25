/** Email signatures (Settings → Signatures), shared by all accounts. */
export interface Signature {
  id: string
  name: string
  /** Formatted text; images only from web addresses (see cleanSignatureHtml) */
  html: string
}

/** The signature an account adds by itself to new messages, and whether also to replies and forwards. */
export interface SignatureDefault {
  id: string
  replies: boolean
}

export const MAX_SIGNATURES = 20
export const MAX_SIGNATURE_NAME = 40
/** Plenty for formatted text with a few linked images. */
export const MAX_SIGNATURE_HTML = 20_000

/** Signatures from storage or an imported file: named, not too large, at most MAX_SIGNATURES. */
export function parseSignatures(v: unknown): Signature[] {
  if (!Array.isArray(v)) return []
  const out: Signature[] = []
  const ids = new Set<string>()
  for (const x of v as Partial<Signature>[]) {
    if (!x || typeof x.name !== 'string' || typeof x.html !== 'string') continue
    const name = x.name.trim().slice(0, MAX_SIGNATURE_NAME)
    if (!name || x.html.length > MAX_SIGNATURE_HTML) continue
    const id = typeof x.id === 'string' && x.id && !ids.has(x.id) ? x.id : crypto.randomUUID()
    ids.add(id)
    out.push({ id, name, html: x.html })
    if (out.length === MAX_SIGNATURES) break
  }
  return out
}

/** Default signatures per account id, keeping only known accounts and existing signatures. */
export function parseSignatureDefaults(v: unknown, accountIds: Set<string>, signatures: Signature[]): Record<string, SignatureDefault> {
  const out: Record<string, SignatureDefault> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const sigIds = new Set(signatures.map((s) => s.id))
  for (const [accountId, d] of Object.entries(v as Record<string, Partial<SignatureDefault> | undefined>)) {
    if (!accountIds.has(accountId) || !d || typeof d.id !== 'string' || !sigIds.has(d.id)) continue
    out[accountId] = { id: d.id, replies: d.replies === true }
  }
  return out
}
