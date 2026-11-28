export interface PhoneCountry {
  code: string
  dialCode: string
  flag: string
  name: string
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { code: 'EE', dialCode: '+372', flag: '🇪🇪', name: 'Estonia' },
  { code: 'LV', dialCode: '+371', flag: '🇱🇻', name: 'Latvia' },
  { code: 'LT', dialCode: '+370', flag: '🇱🇹', name: 'Lithuania' },
  { code: 'FI', dialCode: '+358', flag: '🇫🇮', name: 'Finland' },
  { code: 'SE', dialCode: '+46', flag: '🇸🇪', name: 'Sweden' },
  { code: 'DE', dialCode: '+49', flag: '🇩🇪', name: 'Germany' },
  { code: 'PL', dialCode: '+48', flag: '🇵🇱', name: 'Poland' },
  { code: 'UA', dialCode: '+380', flag: '🇺🇦', name: 'Ukraine' },
  { code: 'RU', dialCode: '+7', flag: '🇷🇺', name: 'Russia' },
  { code: 'GB', dialCode: '+44', flag: '🇬🇧', name: 'United Kingdom' },
  { code: 'US', dialCode: '+1', flag: '🇺🇸', name: 'United States' },
]

export function getSortedPhoneCountries(defaultCountryCode?: string | null): PhoneCountry[] {
  const code = String(defaultCountryCode || 'EE').trim().toUpperCase()
  const primary = PHONE_COUNTRIES.find((c) => c.code === code)
  if (!primary) return [...PHONE_COUNTRIES]
  return [primary, ...PHONE_COUNTRIES.filter((c) => c.code !== primary.code)]
}

/**
 * Compose a phone number with country calling code for API submission (#055 / #060).
 * - Empty input returns null.
 * - Input already starting with '+' is preserved as typed.
 * - Otherwise prepends the chosen country's calling code.
 */
export function composePhoneNumber(countryCode: string, nationalInput: string): string | null {
  const trimmed = String(nationalInput || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('+')) return trimmed
  const country =
    PHONE_COUNTRIES.find((c) => c.code === countryCode.toUpperCase()) ?? PHONE_COUNTRIES[0]
  return `${country.dialCode} ${trimmed}`
}

/**
 * Validate and normalize an incoming phone number to E.164 for mock backend routes (#055 / #060).
 */
export function normalizePhoneToE164(raw: string | null | undefined): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed || trimmed.length > 32 || !trimmed.startsWith('+')) return null
  const stripped = trimmed.replace(/[\s\-()]/g, '')
  if (!/^\+[1-9]\d{6,14}$/.test(stripped)) return null
  return stripped
}

/**
 * Format an E.164 phone number for readable display without altering its digits.
 */
export function formatPhoneDisplay(e164: string | null | undefined): string {
  const raw = String(e164 || '').trim()
  if (!raw) return ''
  const matched = PHONE_COUNTRIES.find((c) => raw.startsWith(c.dialCode))
  if (!matched) return raw
  const rest = raw.slice(matched.dialCode.length)
  if (!rest) return raw
  const grouped = rest.replace(/(\d{4})(?=\d)/g, '$1 ')
  return `${matched.dialCode} ${grouped}`
}
