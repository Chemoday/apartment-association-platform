let pending = ''

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
