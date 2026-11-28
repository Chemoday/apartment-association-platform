let pending = ''
let pendingJoinCode = ''

/**
 * Stash the magic-link token extracted from location.hash in memory before stripping the URL hash.
 * Accepts both raw fragment (`#<token>`) and key-value fragment (`#token=<token>`).
 */
export function stashLinkToken(rawHashContent?: string | null): void {
  const str = String(rawHashContent || '').trim()
  pending = str.startsWith('token=') ? str.slice('token='.length) : str
}

/**
 * Returns the stashed magic-link token once; subsequent calls or page reloads return ''.
 */
export function takeLinkToken(): string {
  const token = pending
  pending = ''
  return token
}

/**
 * Stash a paper join code extracted from `/join#code=...` in volatile memory before stripping hash (#060, P1-3).
 */
export function stashJoinCode(rawHashContent?: string | null): void {
  const str = String(rawHashContent || '').trim()
  if (!str) return
  const params = new URLSearchParams(str.startsWith('#') ? str.slice(1) : str)
  const code = params.get('code')?.trim() || ''
  if (code) pendingJoinCode = code
}

/**
 * Returns the stashed paper join code once; subsequent calls return ''.
 */
export function takeJoinCode(): string {
  const code = pendingJoinCode
  pendingJoinCode = ''
  return code
}
