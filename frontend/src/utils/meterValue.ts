const METER_VALUE = /^[0-9]{1,9}(\.[0-9]{1,3})?$/
const SIGNED_METER_VALUE = /^-?[0-9]{1,12}(\.[0-9]{1,3})?$/

/**
 * Normalize user input into a valid decimal string for the backend.
 * Replaces comma with dot, strips whitespace, and checks pattern ^[0-9]{1,9}(\.[0-9]{1,3})?$.
 * Never converts to JS Number.
 */
export function normalizeMeterInput(text: string | number | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const value = String(text).trim().replace(/\s+/g, '').replace(',', '.')
  return METER_VALUE.test(value) ? value : null
}

/**
 * Convert a decimal string (up to 3 decimal places) to scaled BigInt (× 1000).
 */
export function toScaledBigInt(decimalStr: string | number | null | undefined): bigint | null {
  if (decimalStr === null || decimalStr === undefined) return null
  const cleaned = String(decimalStr).trim().replace(/\s+/g, '').replace(',', '.')
  if (!SIGNED_METER_VALUE.test(cleaned)) return null
  const isNegative = cleaned.startsWith('-')
  const unsigned = isNegative ? cleaned.slice(1) : cleaned
  const [intPart, fracPart = ''] = unsigned.split('.')
  const paddedFrac = (fracPart + '000').slice(0, 3)
  const scaled = BigInt(intPart) * 1000n + BigInt(paddedFrac)
  return isNegative ? -scaled : scaled
}

/**
 * Format scaled BigInt (× 1000) back into a 3-decimal string ("1254.100").
 */
export function fromScaledBigInt(scaled: bigint | null | undefined): string {
  if (scaled === null || scaled === undefined) return '0.000'
  const isNegative = scaled < 0n
  const abs = isNegative ? -scaled : scaled
  const intPart = abs / 1000n
  const fracPart = String(abs % 1000n).padStart(3, '0')
  return `${isNegative ? '-' : ''}${intPart.toString()}.${fracPart}`
}

/**
 * Format a valid decimal string to canonical 3-decimal representation ("128.5" -> "128.500").
 */
export function toThreeDecimals(text: string | number | null | undefined): string | null {
  const scaled = toScaledBigInt(text)
  if (scaled === null) return null
  return fromScaledBigInt(scaled)
}

/**
 * Subtract previous decimal string from current decimal string using scaled BigInt.
 * Returns null if either value is invalid.
 */
export function subtractMeterValues(
  currentStr: string | number | null | undefined,
  previousStr: string | number | null | undefined,
): string | null {
  const curr = toScaledBigInt(currentStr)
  const prev = toScaledBigInt(previousStr)
  if (curr === null || prev === null) return null
  return fromScaledBigInt(curr - prev)
}

/**
 * Sum an array of decimal strings using scaled BigInt.
 */
export function sumMeterValues(values: Array<string | number | null | undefined>): string {
  let total = 0n
  for (const val of values) {
    const scaled = toScaledBigInt(val)
    if (scaled !== null) {
      total += scaled
    }
  }
  return fromScaledBigInt(total)
}

/**
 * Compare two decimal strings using scaled BigInt.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b, or null if invalid.
 */
export function compareMeterValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): -1 | 0 | 1 | null {
  const sa = toScaledBigInt(a)
  const sb = toScaledBigInt(b)
  if (sa === null || sb === null) return null
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

/**
 * Format consumption delta with explicit sign ("+2.100").
 */
export function formatSignedDelta(deltaStr: string | number | null | undefined): string {
  const scaled = toScaledBigInt(deltaStr)
  if (scaled === null) return '0.000'
  const formatted = fromScaledBigInt(scaled)
  return scaled > 0n ? `+${formatted}` : formatted
}

/**
 * Step a meter reading string by multiples of 0.1 (100 milli-units) using scaled BigInt.
 * If currentInput is empty or not a valid meter input, uses fallbackValue as the base reading
 * and applies the step (+0.1 or -0.1) to it. Clamps at 0.000 minimum.
 */
export function stepMeterValue(
  currentInput: string | number | null | undefined,
  fallbackValue: string | number | null | undefined,
  stepTenths: number = 1,
): string {
  const normalizedCurrent = normalizeMeterInput(currentInput)
  const baseStr =
    normalizedCurrent !== null ? normalizedCurrent : normalizeMeterInput(fallbackValue)
  const baseScaled = toScaledBigInt(baseStr) ?? 0n
  const deltaScaled = BigInt(Math.trunc(stepTenths)) * 100n
  const nextScaled = baseScaled + deltaScaled
  return fromScaledBigInt(nextScaled < 0n ? 0n : nextScaled)
}
