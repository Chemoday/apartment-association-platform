import { toScaledBigInt } from './meterValue.js'

/**
 * Format scaled BigInt (×1000) to canonical 3-decimal string without float math.
 */
function formatScaled3(val: bigint | null): string | null {
  if (val === null) return null
  const neg = val < 0n
  const abs = neg ? -val : val
  return `${neg ? '-' : ''}${(abs / 1000n).toString()}.${String(abs % 1000n).padStart(3, '0')}`
}

export interface MatrixBalanceEntryLike {
  resource_type: string
  unit?: string
  master_total: string | null
  apartments_sum: string
  unallocated_loss: string | null
  starting_meters?: number
}

export interface WaterBalanceSummary {
  unit: string
  unitCode: string
  allMastersRead: boolean
  master_total: string | null
  apartments_sum: string | null
  unallocated_loss: string | null
  lossPercentage: string | null
  isNegativeLoss: boolean
  waterStartingMeters: number
  totalStartingMeters: number
}

/**
 * Summarize combined water (COLD_WATER + HOT_WATER, or first balance fallback) for MasterMeterKpi (#039).
 */
export function summarizeWaterBalance(
  balances: MatrixBalanceEntryLike[] | null | undefined = [],
): WaterBalanceSummary | null {
  const list = Array.isArray(balances) ? balances : []
  const totalStartingMeters = list.reduce(
    (acc, b) => acc + Math.max(0, Number(b?.starting_meters) || 0),
    0,
  )

  const cold = list.find((b) => b.resource_type === 'COLD_WATER')
  const hot = list.find((b) => b.resource_type === 'HOT_WATER')
  const waterBalances = [cold, hot].filter((b): b is MatrixBalanceEntryLike => Boolean(b))
  const sourceBalances = waterBalances.length > 0 ? waterBalances : list.slice(0, 1)

  if (sourceBalances.length === 0) {
    return null
  }

  const allMastersRead = sourceBalances.every(
    (b) =>
      b.master_total !== null &&
      b.master_total !== undefined &&
      toScaledBigInt(b.master_total) !== null &&
      b.unallocated_loss !== null &&
      b.unallocated_loss !== undefined &&
      toScaledBigInt(b.unallocated_loss) !== null,
  )

  let masterSum = 0n
  let aptSum = 0n
  let waterStartingMeters = 0

  for (const b of sourceBalances) {
    if (allMastersRead) {
      masterSum += toScaledBigInt(b.master_total) || 0n
    }
    aptSum += toScaledBigInt(b.apartments_sum) || 0n
    waterStartingMeters += Math.max(0, Number(b?.starting_meters) || 0)
  }

  const loss = allMastersRead ? masterSum - aptSum : null

  let lossPercentage: string | null = null
  if (allMastersRead && masterSum > 0n && loss !== null) {
    const basisPoints = (loss * 10000n) / masterSum
    const isNegBp = basisPoints < 0n
    const absBp = isNegBp ? -basisPoints : basisPoints
    const whole = absBp / 100n
    const rem = absBp % 100n
    lossPercentage = `${isNegBp && absBp > 0n ? '-' : ''}${whole.toString()}.${String(rem).padStart(2, '0')}%`
  } else if (allMastersRead && loss !== null) {
    lossPercentage = loss === 0n ? '0.00%' : null
  }

  const unitCode = waterBalances.length > 0 ? 'm3' : sourceBalances[0].unit || 'm3'
  const unit = unitCode === 'm3' ? 'm³' : unitCode

  return {
    unit,
    unitCode,
    allMastersRead,
    master_total: allMastersRead ? formatScaled3(masterSum) : null,
    apartments_sum: formatScaled3(aptSum),
    unallocated_loss: formatScaled3(loss),
    lossPercentage,
    isNegativeLoss: loss !== null && loss < 0n,
    waterStartingMeters,
    totalStartingMeters,
  }
}

/**
 * Inspect a group of meters for `START` and `SUBMITTED` previous_origin flags (#039).
 */
export function collectMeterStartOrigins(
  meters: Array<{ reading?: { previous_origin?: string | null } | null }> | null | undefined = [],
): {
  hasStart: boolean
  hasSubmitted: boolean
  startCount: number
  submittedCount: number
} {
  let startCount = 0
  let submittedCount = 0
  for (const m of Array.isArray(meters) ? meters : []) {
    const origin = m?.reading?.previous_origin
    if (origin === 'START') startCount += 1
    else if (origin === 'SUBMITTED') submittedCount += 1
  }
  return {
    hasStart: startCount > 0,
    hasSubmitted: submittedCount > 0,
    startCount,
    submittedCount,
  }
}

export interface SkippedMeterDescriptor {
  meter_id: string
  apartment_number: string | null
  apartment_kind?: 'APARTMENT' | 'PARKING' | 'GARAGE' | null
  resource_type: string | null
  location_label: string | null
}

/**
 * Resolve `skipped_without_start` meter IDs from `POST /meters/periods/{code}/estimate-missing`
 * into apartment-number + resource descriptors using matrix apartments (#039).
 * Never exposes resident names (privacy invariant).
 */
export function resolveSkippedMetersWithoutStart(
  skippedIds: string[] | null | undefined,
  apartments: Array<{
    apartment_number: string
    apartment_kind?: string
    meters?: Array<{ meter_id: string; resource_type?: string | null; location_label?: string | null }>
  }> | null | undefined = [],
): SkippedMeterDescriptor[] {
  if (!Array.isArray(skippedIds) || skippedIds.length === 0) return []

  const lookup = new Map<string, SkippedMeterDescriptor>()
  for (const apt of Array.isArray(apartments) ? apartments : []) {
    for (const m of apt?.meters || []) {
      if (m?.meter_id) {
        const entry: SkippedMeterDescriptor = {
          meter_id: m.meter_id,
          apartment_number: apt.apartment_number ?? null,
          resource_type: m.resource_type ?? null,
          location_label: m.location_label ?? null,
        }
        if (apt.apartment_kind !== undefined) {
          entry.apartment_kind = apt.apartment_kind as SkippedMeterDescriptor['apartment_kind']
        }
        lookup.set(m.meter_id, entry)
      }
    }
  }

  const seen = new Set<string>()
  const resolved: SkippedMeterDescriptor[] = []
  for (const rawId of skippedIds) {
    const id = String(rawId || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const found = lookup.get(id)
    if (found) {
      resolved.push(found)
    } else {
      resolved.push({
        meter_id: id,
        apartment_number: null,
        resource_type: null,
        location_label: null,
      })
    }
  }

  return resolved.sort((a, b) => {
    if (a.apartment_number !== null && b.apartment_number !== null) {
      const aptCmp = a.apartment_number.localeCompare(b.apartment_number, 'en', { numeric: true })
      if (aptCmp !== 0) return aptCmp
    } else if (a.apartment_number !== null) {
      return -1
    } else if (b.apartment_number !== null) {
      return 1
    }
    const resCmp = String(a.resource_type || '').localeCompare(String(b.resource_type || ''), 'en')
    if (resCmp !== 0) return resCmp
    return a.meter_id.localeCompare(b.meter_id, 'en')
  })
}

/**
 * Format localized incomplete-balance notice for `starting_meters > 0` (#039).
 * Uses Russian 3-form Slavic pluralization (`one` / `few` / `many`) when locale is `ru`.
 */
export function formatIncompleteBalanceMessage(
  count: number,
  t: (key: string, params?: Record<string, unknown>) => string,
  locale: string = 'en',
): string {
  const n = Math.max(0, Math.trunc(Number(count) || 0))
  if (n <= 0) return ''
  const lang = String(locale || 'en').toLowerCase()
  if (lang.startsWith('ru')) {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) {
      return t('accounting.balanceIncompleteOne', { count: n })
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return t('accounting.balanceIncompleteFew', { count: n })
    }
    return t('accounting.balanceIncompleteMany', { count: n })
  }
  if (n === 1) {
    return t('accounting.balanceIncompleteOne', { count: n })
  }
  return t('accounting.balanceIncompleteMany', { count: n })
}
