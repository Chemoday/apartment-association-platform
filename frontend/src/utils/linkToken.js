let pending = ''

/**
 * Stash the magic-link token extracted from location.hash in memory before stripping the URL hash.
 * Accepts both raw fragment (`#<token>`) and key-value fragment (`#token=<token>`).
 * @param {string} rawHashContent
 */
export function stashLinkToken(rawHashContent) {
  const str = String(rawHashContent || '').trim()
  pending = str.startsWith('token=') ? str.slice('token='.length) : str
}

/**
 * Returns the stashed magic-link token once; subsequent calls or page reloads return ''.
 * @returns {string}
 */
export function takeLinkToken() {
  const token = pending
  pending = ''
  return token
}
