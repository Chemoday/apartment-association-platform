import { fromScaledBigInt, toScaledBigInt } from './meterValue.js'

/**
 * Parse a signed decimal string into scaled BigInt (×1000) without JS float math.
 * Correctly handles negative values such as "-1.500" (-1500n) and "-0.500" (-500n).
 */
export function toBigInt3(val: string | number | null | undefined): bigint {
  return toScaledBigInt(val ?? '0') ?? 0n
}

/**
 * Format scaled BigInt (×1000) back to a canonical 3-decimal string.
 */
export function fromBigInt3(scaled: bigint): string {
  return fromScaledBigInt(scaled)
}

/**
 * Exact BigInt decimal addition.
 */
export function addDecimal(a: string | number | null | undefined, b: string | number | null | undefined): string {
  return fromBigInt3(toBigInt3(a) + toBigInt3(b))
}

/**
 * Exact BigInt decimal subtraction.
 */
export function subDecimal(a: string | number | null | undefined, b: string | number | null | undefined): string {
  return fromBigInt3(toBigInt3(a) - toBigInt3(b))
}

/**
 * Allowed one-step billing period status transitions per docs/API.md §3.
 */
export const ALLOWED_PERIOD_TRANSITIONS: Record<string, string[]> = {
  OPEN_FOR_RESIDENTS: ['REVIEW_BY_BOARD'],
  REVIEW_BY_BOARD: ['OPEN_FOR_RESIDENTS', 'LOCKED'],
  LOCKED: ['REVIEW_BY_BOARD'],
}

const VALID_PERIOD_STATUSES = new Set(Object.keys(ALLOWED_PERIOD_TRANSITIONS))

export type PeriodStatusTransitionResult =
  | { ok: true; nextStatus: string }
  | { ok: false; status: 422; errorCode: 'VALIDATION_ERROR'; message: string }
  | {
      ok: false
      status: 409
      errorCode: 'INVALID_PERIOD_TRANSITION'
      message: string
      payload: { current_status: string; requested_status: string; allowed_statuses: string[] }
    }

/**
 * Validate a PATCH /meters/periods/{code}/status transition.
 */
export function validatePeriodStatusTransition(
  currentStatus: string,
  requestedStatus: unknown,
): PeriodStatusTransitionResult {
  if (typeof requestedStatus !== 'string' || !VALID_PERIOD_STATUSES.has(requestedStatus)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid period status.',
    }
  }
  const allowed = ALLOWED_PERIOD_TRANSITIONS[currentStatus] || []
  if (!allowed.includes(requestedStatus)) {
    return {
      ok: false,
      status: 409,
      errorCode: 'INVALID_PERIOD_TRANSITION',
      message: `Cannot transition period from ${currentStatus} to ${requestedStatus}.`,
      payload: {
        current_status: currentStatus,
        requested_status: requestedStatus,
        allowed_statuses: allowed,
      },
    }
  }
  return { ok: true, nextStatus: requestedStatus }
}

/**
 * Default absolute anomaly threshold (scaled ×1000) per docs/API.md §2.
 * Honors `MWh` unit scaling (divided by 1000 vs `kWh`).
 */
export function defaultMeterThresholdScaled(
  resourceType?: string | null,
  unit?: string | null,
): bigint {
  const type = String(resourceType || '').toUpperCase()
  const isMWh = unit === 'MWh'
  switch (type) {
    case 'HOT_WATER':
      return 15000n
    case 'COLD_WATER':
      return 25000n
    case 'GAS':
      return 50000n
    case 'ELECTRICITY':
      return isMWh ? 1000n : 1000000n
    case 'HEAT':
      return isMWh ? 2000n : 2000000n
    default:
      return 10000n
  }
}

/**
 * Escape a CSV cell with formula-injection protection per docs/API.md §3.
 * Prefixes text cells starting with `= + - @` (including after leading whitespace/newlines
 * and in NFKC full-width forms) or leading tab/CR/LF with `'`.
 */
export function escapeCsvCell(raw: unknown, { numeric = false }: { numeric?: boolean } = {}): string {
  if (raw === null || raw === undefined) return ''
  let text = String(raw)
  if (!numeric && text.length > 0) {
    const normalized = text.normalize('NFKC')
    const startsWithControl = /^[\t\r\n]/.test(normalized)
    const startsWithFormula = /^[\s]*[=+\-@]/.test(normalized)
    if (startsWithControl || startsWithFormula) {
      text = `'${text}`
    }
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * Build the 16-column period CSV per docs/API.md §3 (`GET /meters/periods/{code}/export-csv`, E14 #068).
 * Includes both object rows (with `apartment_kind`) and `MASTER` building meter rows (empty `apartment_kind`),
 * without resident names.
 */
export interface CsvReadingLike {
  previous_value?: string | number | null
  value?: string | number | null
  consumption_delta?: string | number | null
  source?: string | null
  is_anomaly_confirmed?: boolean | null
  recorded_at?: string | null
  previous_origin?: string | null
}

export interface CsvMeterRowLike {
  meter_id?: string | null
  resource_type?: string | null
  serial_number?: string | null
  location_label?: string | null
  unit?: string | null
  previous_value?: string | number | null
  reading?: CsvReadingLike | null
}

export interface CsvApartmentRowLike {
  entrance?: number | string | null
  apartment_number?: string | null
  apartment_kind?: string | null
  meters?: CsvMeterRowLike[] | null
}

export function buildPeriodCsv(
  periodCode: string,
  apartments: CsvApartmentRowLike[] = [],
  masterMeters: CsvMeterRowLike[] = [],
): string {
  const lines = [
    'period_code,entrance,apartment_number,meter_id,resource_type,serial_number,location_label,unit,previous_value,value,consumption_delta,source,is_anomaly_confirmed,recorded_at,previous_origin,apartment_kind',
  ]

  for (const apt of apartments) {
    const kind = apt.apartment_kind || 'APARTMENT'
    for (const m of apt.meters || []) {
      const r = m.reading || null
      lines.push(
        [
          escapeCsvCell(periodCode),
          escapeCsvCell(apt.entrance ?? '', { numeric: true }),
          escapeCsvCell(apt.apartment_number ?? ''),
          escapeCsvCell(m.meter_id ?? ''),
          escapeCsvCell(m.resource_type ?? ''),
          escapeCsvCell(m.serial_number ?? ''),
          escapeCsvCell(m.location_label ?? ''),
          escapeCsvCell(m.unit ?? ''),
          escapeCsvCell(r?.previous_value ?? m.previous_value ?? '', { numeric: true }),
          escapeCsvCell(r?.value ?? '', { numeric: true }),
          escapeCsvCell(r?.consumption_delta ?? '', { numeric: true }),
          escapeCsvCell(r?.source ?? 'MISSING'),
          escapeCsvCell(r ? String(Boolean(r.is_anomaly_confirmed)) : 'false'),
          escapeCsvCell(r?.recorded_at ?? ''),
          escapeCsvCell(r?.previous_origin ?? ''),
          escapeCsvCell(kind),
        ].join(','),
      )
    }
  }

  for (const mm of masterMeters) {
    const r = mm.reading || null
    lines.push(
      [
        escapeCsvCell(periodCode),
        '',
        'MASTER',
        escapeCsvCell(mm.meter_id ?? ''),
        escapeCsvCell(mm.resource_type ?? ''),
        escapeCsvCell(mm.serial_number ?? ''),
        escapeCsvCell(mm.location_label ?? ''),
        escapeCsvCell(mm.unit ?? ''),
        escapeCsvCell(r?.previous_value ?? mm.previous_value ?? '', { numeric: true }),
        escapeCsvCell(r?.value ?? '', { numeric: true }),
        escapeCsvCell(r?.consumption_delta ?? '', { numeric: true }),
        escapeCsvCell(r?.source ?? 'MISSING'),
        escapeCsvCell(r ? String(Boolean(r.is_anomaly_confirmed)) : 'false'),
        escapeCsvCell(r?.recorded_at ?? ''),
        escapeCsvCell(r?.previous_origin ?? ''),
        '',
      ].join(','),
    )
  }

  return lines.join('\n')
}
