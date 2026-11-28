const STRICT_E164_RE = /^\+[1-9]\d{6,14}$/
const SAFE_HASH_SELECTOR_RE = /^#[A-Za-z][\w-]*$/

/**
 * Validate an external URL (e.g., association custom privacy_notice_url) fail-closed.
 * Allows ONLY `http:` and `https:` schemes and rejects all other URL schemes.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Validate an E.164 phone number before rendering a `tel:` hyperlink (fail-closed).
 */
export function safeTelHref(raw: string | null | undefined): string | null {
  const trimmed = String(raw || '').trim()
  if (!STRICT_E164_RE.test(trimmed)) return null
  return `tel:${trimmed}`
}

/**
 * Validate a URL hash before passing it as a CSS selector to Vue Router `scrollBehavior`.
 */
export function isSafeHashSelector(hash: string | null | undefined): boolean {
  return Boolean(hash && SAFE_HASH_SELECTOR_RE.test(hash))
}
