import type {
  ApartmentConsumptionResponse,
  BuildingConsumptionResponse,
  MeterUnit,
  ObjectKind,
  PeriodDTO,
  ResourceType,
} from '@/api/schema.js'
import { sumMeterValues } from './meterValue.js'
import { normalizeObjectKind } from './objectName.js'

export const MIN_CONSUMPTION_MONTHS = 1
export const MAX_CONSUMPTION_MONTHS = 24
export const DEFAULT_CONSUMPTION_MONTHS = 12

export interface ResourceChartStyle {
  barClass: string
  strokeClass: string
  dotClass: string
  badgeClass: string
  strokeHex: string
}

const RESOURCE_STYLES: Record<string, ResourceChartStyle> = {
  COLD_WATER: {
    barClass: 'fill-sky-600 dark:fill-sky-400',
    strokeClass: 'stroke-sky-600 dark:stroke-sky-400',
    dotClass: 'bg-sky-600 dark:bg-sky-400',
    badgeClass: 'bg-sky-500/15 text-sky-800 dark:text-sky-200 border-sky-500/30',
    strokeHex: '#0284c7',
  },
  HOT_WATER: {
    barClass: 'fill-rose-600 dark:fill-rose-400',
    strokeClass: 'stroke-rose-600 dark:stroke-rose-400',
    dotClass: 'bg-rose-600 dark:bg-rose-400',
    badgeClass: 'bg-rose-500/15 text-rose-800 dark:text-rose-200 border-rose-500/30',
    strokeHex: '#e11d48',
  },
  ELECTRICITY: {
    barClass: 'fill-amber-500 dark:fill-amber-400',
    strokeClass: 'stroke-amber-600 dark:stroke-amber-400',
    dotClass: 'bg-amber-500 dark:bg-amber-400',
    badgeClass: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30',
    strokeHex: '#d97706',
  },
  HEAT: {
    barClass: 'fill-violet-600 dark:fill-violet-400',
    strokeClass: 'stroke-violet-600 dark:stroke-violet-400',
    dotClass: 'bg-violet-600 dark:bg-violet-400',
    badgeClass: 'bg-violet-500/15 text-violet-800 dark:text-violet-200 border-violet-500/30',
    strokeHex: '#7c3aed',
  },
  GAS: {
    barClass: 'fill-emerald-600 dark:fill-emerald-400',
    strokeClass: 'stroke-emerald-600 dark:stroke-emerald-400',
    dotClass: 'bg-emerald-600 dark:bg-emerald-400',
    badgeClass: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border-emerald-500/30',
    strokeHex: '#059669',
  },
}

const FALLBACK_RESOURCE_STYLE: ResourceChartStyle = {
  barClass: 'fill-slate-600 dark:fill-slate-400',
  strokeClass: 'stroke-slate-600 dark:stroke-slate-400',
  dotClass: 'bg-slate-600 dark:bg-slate-400',
  badgeClass: 'bg-slate-500/15 text-slate-800 dark:text-slate-200 border-slate-500/30',
  strokeHex: '#475569',
}

/**
 * Returns deterministic chart color styling keyed strictly by `resource_type` (never by index).
 */
export function getResourceChartStyle(resourceType?: string | null): ResourceChartStyle {
  const key = String(resourceType || '').toUpperCase()
  if (key === 'HEATING') return RESOURCE_STYLES.HEAT
  return RESOURCE_STYLES[key] || FALLBACK_RESOURCE_STYLE
}

export type ParseConsumptionMonthsResult =
  | { ok: true; months: number }
  | { ok: false; status: number; errorCode: string; message: string }

/**
 * Validates and parses `months` query parameter (1..24, default 12).
 */
export function parseConsumptionMonths(
  rawMonths?: number | string | null,
): ParseConsumptionMonthsResult {
  if (rawMonths === null || rawMonths === undefined || String(rawMonths).trim() === '') {
    return { ok: true, months: DEFAULT_CONSUMPTION_MONTHS }
  }
  const str = String(rawMonths).trim()
  if (!/^[0-9]+$/.test(str)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'months must be an integer between 1 and 24.',
    }
  }
  const parsed = Number(str)
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_CONSUMPTION_MONTHS ||
    parsed > MAX_CONSUMPTION_MONTHS
  ) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'months must be between 1 and 24.',
    }
  }
  return { ok: true, months: parsed }
}

export interface ApartmentConsumptionMeterReadingInput {
  period_code: string
  consumption_delta: string
  source?: string | null
  previous_origin?: string | null
}

export interface ApartmentConsumptionMeterInput {
  meter_id?: string
  resource_type: string
  unit: string
  is_active?: boolean
  readings?: ApartmentConsumptionMeterReadingInput[]
}

/**
 * Aggregates `GET /api/v1/meters/apartments/{apartment_id}/consumption?months=12`
 * from apartment meter histories and billing periods.
 */
export function buildApartmentConsumptionResponse({
  apartmentId,
  apartmentNumber,
  apartmentKind,
  periods,
  meters,
  months = DEFAULT_CONSUMPTION_MONTHS,
}: {
  apartmentId: string
  apartmentNumber: string
  apartmentKind?: ObjectKind | null
  periods: Array<{ period_code: string; status?: string; due_date?: string }>
  meters: ApartmentConsumptionMeterInput[]
  months?: number
}): ApartmentConsumptionResponse {
  const safeCount = Math.min(
    MAX_CONSUMPTION_MONTHS,
    Math.max(MIN_CONSUMPTION_MONTHS, Number(months) || DEFAULT_CONSUMPTION_MONTHS),
  )

  const latestNewestFirst = [...(Array.isArray(periods) ? periods : [])]
    .sort((a, b) => String(b.period_code || '').localeCompare(String(a.period_code || '')))
    .slice(0, safeCount)

  const selectedPeriods: PeriodDTO[] = latestNewestFirst
    .reverse()
    .map((p) => JSON.parse(JSON.stringify(p)) as PeriodDTO)

  const selectedPeriodSet = new Set(selectedPeriods.map((p) => p.period_code))

  const groups = new Map<
    string,
    {
      resource_type: string
      unit: string
      readingsByPeriod: Map<string, ApartmentConsumptionMeterReadingInput[]>
    }
  >()

  for (const meter of Array.isArray(meters) ? meters : []) {
    const meterReadingsInWindow = (meter.readings || []).filter(
      (r) =>
        selectedPeriodSet.has(r.period_code) &&
        String(r?.previous_origin || '').toUpperCase() !== 'START',
    )
    const isActive = meter.is_active !== false
    if (!isActive && meterReadingsInWindow.length === 0) {
      continue
    }

    const resourceType = String(meter.resource_type || '')
    const unit = String(meter.unit || '')
    const key = `${resourceType}::${unit}`
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = {
        resource_type: resourceType,
        unit,
        readingsByPeriod: new Map(),
      }
      groups.set(key, bucket)
    }
    for (const r of meterReadingsInWindow) {
      let list = bucket.readingsByPeriod.get(r.period_code)
      if (!list) {
        list = []
        bucket.readingsByPeriod.set(r.period_code, list)
      }
      list.push(r)
    }
  }

  const resources = Array.from(groups.values())
    .sort((a, b) => {
      const typeCmp = a.resource_type.localeCompare(b.resource_type, 'en')
      if (typeCmp !== 0) return typeCmp
      return a.unit.localeCompare(b.unit, 'en')
    })
    .map((group) => ({
      resource_type: group.resource_type as ResourceType,
      unit: group.unit as MeterUnit,
      months: selectedPeriods.map((p) => {
        const periodReadings = group.readingsByPeriod.get(p.period_code) || []
        if (periodReadings.length === 0) {
          return {
            period_code: p.period_code,
            consumption: null,
            estimated: false,
          }
        }
        return {
          period_code: p.period_code,
          consumption: sumMeterValues(periodReadings.map((r) => r.consumption_delta)),
          estimated: periodReadings.some((r) => r.source === 'AUTO_ESTIMATED'),
        }
      }),
    }))

  return {
    apartment_id: apartmentId,
    apartment_number: apartmentNumber,
    apartment_kind: normalizeObjectKind(apartmentKind),
    periods: selectedPeriods,
    resources,
  }
}

/**
 * Divides `numerator / denominator` (`denominator > 0n`) and rounds half away from zero
 * (`ROUND_HALF_UP` matching Python/SQL DECIMAL), never emitting `-0n`.
 */
export function roundBigIntHalfUp(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator <= 0n) return null
  const isNegative = numerator < 0n
  const absNum = isNegative ? -numerator : numerator
  const quotient = absNum / denominator
  const remainder = absNum % denominator
  const rounded = 2n * remainder >= denominator ? quotient + 1n : quotient
  if (rounded === 0n) return 0n
  return isNegative ? -rounded : rounded
}

/**
 * Formats a scaled BigInt with a fixed number of fractional digits (`decimals`).
 * Never emits `"-0.000..."`.
 */
export function formatFixedBigInt(scaled: bigint, decimals: number): string {
  const d = Math.max(0, Math.trunc(decimals))
  const isNegative = scaled < 0n
  const abs = isNegative ? -scaled : scaled
  if (d === 0) {
    return `${isNegative && abs > 0n ? '-' : ''}${abs.toString()}`
  }
  const factor = 10n ** BigInt(d)
  const intPart = abs / factor
  const fracPart = String(abs % factor).padStart(d, '0')
  return `${isNegative && abs > 0n ? '-' : ''}${intPart.toString()}.${fracPart}`
}

const EXACT_DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/

/**
 * Parses an arbitrary-length signed decimal string into scaled BigInt (`× 10^targetDecimals`),
 * rounding half away from zero only when fractional digits exceed `targetDecimals`.
 */
export function parseExactDecimalToScale(
  rawValue: string | number | null | undefined,
  targetDecimals: number = 3,
): bigint | null {
  if (rawValue === null || rawValue === undefined) return null
  const cleaned = String(rawValue).trim().replace(/\s+/g, '').replace(',', '.')
  if (!EXACT_DECIMAL_RE.test(cleaned)) return null
  const decimals = Math.max(0, Math.trunc(targetDecimals))
  const isNegative = cleaned.startsWith('-')
  const unsigned = isNegative ? cleaned.slice(1) : cleaned
  const [intPart, fracPart = ''] = unsigned.split('.')

  if (fracPart.length <= decimals) {
    const padded = fracPart.padEnd(decimals, '0')
    const scaled = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0')
    if (scaled === 0n) return 0n
    return isNegative ? -scaled : scaled
  }

  const head = fracPart.slice(0, decimals)
  const nextDigit = Number(fracPart[decimals])
  let scaled = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(head || '0')
  if (nextDigit >= 5) {
    scaled += 1n
  }
  if (scaled === 0n) return 0n
  return isNegative ? -scaled : scaled
}

export interface BuildingConsumptionApartmentInput {
  apartment_id: string
  area_m2?: string | number | null
  meters?: Array<
    ApartmentConsumptionMeterInput & {
      is_master?: boolean
      meter_type?: string
    }
  >
}

/**
 * Aggregates `GET /api/v1/meters/consumption?months=12` for staff (CHAIRMAN, BOARD, ACCOUNTANT).
 */
export function buildBuildingConsumptionResponse({
  periods,
  apartments,
  months = DEFAULT_CONSUMPTION_MONTHS,
}: {
  periods: Array<{ period_code: string; status?: string; due_date?: string }>
  apartments: BuildingConsumptionApartmentInput[]
  months?: number
}): BuildingConsumptionResponse {
  const safeCount = Math.min(
    MAX_CONSUMPTION_MONTHS,
    Math.max(MIN_CONSUMPTION_MONTHS, Number(months) || DEFAULT_CONSUMPTION_MONTHS),
  )

  const latestNewestFirst = [...(Array.isArray(periods) ? periods : [])]
    .sort((a, b) => String(b.period_code || '').localeCompare(String(a.period_code || '')))
    .slice(0, safeCount)

  const selectedPeriods: PeriodDTO[] = latestNewestFirst
    .reverse()
    .map((p) => JSON.parse(JSON.stringify(p)) as PeriodDTO)

  const selectedPeriodSet = new Set(selectedPeriods.map((p) => p.period_code))

  const groups = new Map<
    string,
    {
      resource_type: string
      unit: string
      byPeriod: Map<
        string,
        {
          deltasScaled: bigint[]
          areaDeltasScaled: bigint[]
          countedAptIds: Set<string>
          countedAreaScaled: bigint
          estimatedCount: number
        }
      >
    }
  >()

  for (const apt of Array.isArray(apartments) ? apartments : []) {
    const aptId = String(apt?.apartment_id || '')
    if (!aptId) continue
    const rawArea = apt?.area_m2 != null ? String(apt.area_m2) : '0'
    const parsedAreaScaled = parseExactDecimalToScale(rawArea, 6)
    const aptAreaScaled = parsedAreaScaled !== null && parsedAreaScaled > 0n ? parsedAreaScaled : 0n

    for (const meter of Array.isArray(apt?.meters) ? apt.meters : []) {
      const meterTypeUpper = String(meter?.meter_type || '').toUpperCase()
      const resourceTypeUpper = String(meter?.resource_type || '').toUpperCase()
      if (
        meter?.is_master === true ||
        meterTypeUpper === 'MASTER' ||
        resourceTypeUpper === 'MASTER'
      ) {
        continue
      }

      const meterReadingsInWindow = (meter.readings || []).filter(
        (r) =>
          selectedPeriodSet.has(r.period_code) &&
          String(r?.previous_origin || '').toUpperCase() !== 'START',
      )
      const isActive = meter.is_active !== false
      if (!isActive && meterReadingsInWindow.length === 0) {
        continue
      }

      const resourceType = String(meter.resource_type || '')
      const unit = String(meter.unit || '')
      const key = `${resourceType}::${unit}`
      let group = groups.get(key)
      if (!group) {
        group = {
          resource_type: resourceType,
          unit,
          byPeriod: new Map(),
        }
        groups.set(key, group)
      }

      for (const r of meterReadingsInWindow) {
        const deltaScaled = parseExactDecimalToScale(r?.consumption_delta, 3)
        if (deltaScaled === null) continue
        let bucket = group.byPeriod.get(r.period_code)
        if (!bucket) {
          bucket = {
            deltasScaled: [],
            areaDeltasScaled: [],
            countedAptIds: new Set(),
            countedAreaScaled: 0n,
            estimatedCount: 0,
          }
          group.byPeriod.set(r.period_code, bucket)
        }
        bucket.deltasScaled.push(deltaScaled)
        if (aptAreaScaled > 0n) {
          bucket.areaDeltasScaled.push(deltaScaled)
        }
        if (String(r.source || '').toUpperCase() === 'AUTO_ESTIMATED') {
          bucket.estimatedCount += 1
        }
        if (!bucket.countedAptIds.has(aptId)) {
          bucket.countedAptIds.add(aptId)
          bucket.countedAreaScaled += aptAreaScaled
        }
      }
    }
  }

  const resources = Array.from(groups.values())
    .sort((a, b) => {
      const typeCmp = a.resource_type.localeCompare(b.resource_type, 'en')
      if (typeCmp !== 0) return typeCmp
      return a.unit.localeCompare(b.unit, 'en')
    })
    .map((group) => ({
      resource_type: group.resource_type as ResourceType,
      unit: group.unit as MeterUnit,
      months: selectedPeriods.map((p) => {
        const bucket = group.byPeriod.get(p.period_code)
        if (!bucket || bucket.deltasScaled.length === 0 || bucket.countedAptIds.size === 0) {
          return {
            period_code: p.period_code,
            total: null,
            apartments_counted: 0,
            average_per_apartment: null,
            average_per_m2: null,
            estimated_readings: 0,
          }
        }
        let totalScaled = 0n
        for (const d of bucket.deltasScaled) {
          totalScaled += d
        }
        let areaTotalScaled = 0n
        for (const d of bucket.areaDeltasScaled) {
          areaTotalScaled += d
        }
        const total = formatFixedBigInt(totalScaled, 3)
        const aptCount = bucket.countedAptIds.size
        const avgAptScaled = roundBigIntHalfUp(totalScaled, BigInt(aptCount))
        const avgM2Scaled =
          bucket.countedAreaScaled > 0n && bucket.areaDeltasScaled.length > 0
            ? roundBigIntHalfUp(areaTotalScaled * 10_000_000n, bucket.countedAreaScaled)
            : null

        return {
          period_code: p.period_code,
          total,
          apartments_counted: aptCount,
          average_per_apartment: avgAptScaled !== null ? formatFixedBigInt(avgAptScaled, 3) : null,
          average_per_m2: avgM2Scaled !== null ? formatFixedBigInt(avgM2Scaled, 4) : null,
          estimated_readings: bucket.estimatedCount,
        }
      }),
    }))

  return {
    periods: selectedPeriods,
    resources,
  }
}

/**
 * Formats a scaled BigInt (× 1000n) into a compact human-readable Y-axis tick label
 * without ever using `parseFloat`.
 */
export function formatShortChartTick(scaled: bigint): string {
  const isNeg = scaled < 0n
  const abs = isNeg ? -scaled : scaled
  const intPart = (abs / 1000n).toString()
  const fracRaw = String(abs % 1000n).padStart(3, '0')
  const trimmedFrac = fracRaw.replace(/0+$/, '')
  const body = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart
  return isNeg && abs > 0n ? `-${body}` : body
}

/**
 * Formats a period code ("2026-10") to a concise month tag for compact X-axis labels (e.g. "10/26" or localized).
 */
export function formatCompactPeriodTick(periodCode?: string | null): string {
  if (!periodCode || !/^[0-9]{4}-[0-9]{2}$/.test(periodCode)) return String(periodCode || '')
  return `${periodCode.slice(5, 7)}/${periodCode.slice(2, 4)}`
}

/**
 * Projects a BigInt value inside [domainMin, domainMax] to an SVG Y coordinate using exact BigInt ratio math.
 */
function projectScaledY(
  val: bigint,
  domainMin: bigint,
  domainSpan: bigint,
  plotTop: number,
  plotHeight: number,
): number {
  if (domainSpan <= 0n) return plotTop + plotHeight
  const clamped =
    val < domainMin ? domainMin : val > domainMin + domainSpan ? domainMin + domainSpan : val
  const ratioBasisPoints = Number(((clamped - domainMin) * 10000n) / domainSpan) / 10000
  return plotTop + plotHeight - ratioBasisPoints * plotHeight
}

/**
 * Chooses X-axis period tick indices so adjacent labels never collide physically on 16-24 month windows.
 */
export function computeVisibleXLabelIndices(
  bars: Array<{ index: number; centerX: number; isOpen?: boolean }>,
  slotWidth: number,
  minGapPx: number = 34,
): Set<number> {
  const list = Array.isArray(bars) ? bars : []
  const n = list.length
  if (n === 0) return new Set()
  if (slotWidth >= minGapPx) {
    return new Set(list.map((b) => b.index))
  }

  const chosen: Array<{ index: number; centerX: number; isOpen?: boolean }> = []
  const tryAdd = (bar?: { index: number; centerX: number; isOpen?: boolean }) => {
    if (!bar) return false
    if (chosen.some((other) => Math.abs(other.centerX - bar.centerX) < minGapPx)) {
      return false
    }
    chosen.push(bar)
    return true
  }

  const openBar = list.find((b) => b.isOpen)
  if (openBar) tryAdd(openBar)
  tryAdd(list[0])
  tryAdd(list[n - 1])

  const step = Math.max(2, Math.ceil(minGapPx / Math.max(1, slotWidth)))
  for (let i = 0; i < n; i += step) {
    tryAdd(list[i])
  }

  return new Set(chosen.map((b) => b.index))
}

export interface ConsumptionChartMonthEntry {
  period_code: string
  consumption?: string | null
  total?: string | null
  estimated?: boolean
  estimated_readings?: number
  apartments_counted?: number | null
}

/**
 * Computes responsive SVG bar chart geometry for a consumption series using BigInt arithmetic.
 */
export function computeConsumptionChartGeometry(
  months: ConsumptionChartMonthEntry[] | null | undefined,
  periods: Array<{ period_code: string; status?: string; due_date?: string }> | null | undefined,
  layout: {
    plotLeft?: number
    plotRight?: number
    plotTop?: number
    plotBottom?: number
    unitLabel?: string
  } = {},
) {
  const minPlotLeft = layout.plotLeft ?? 46
  const plotRight = layout.plotRight ?? 548
  const plotTop = layout.plotTop ?? 18
  const plotBottom = layout.plotBottom ?? 172
  const plotHeight = Math.max(40, plotBottom - plotTop)

  const monthByCode = new Map(
    (Array.isArray(months) ? months : []).map((m) => [m.period_code, m]),
  )
  const orderedPeriods =
    Array.isArray(periods) && periods.length > 0
      ? periods
      : Array.isArray(months)
        ? months.map((m) => ({ period_code: m.period_code, status: 'LOCKED' }))
        : []

  const parsedSlots = orderedPeriods.map((p, idx) => {
    const entry = monthByCode.get(p.period_code) ?? null
    const rawStr =
      entry && entry.consumption !== undefined
        ? entry.consumption
        : entry && entry.total !== undefined
          ? entry.total
          : null
    const scaled =
      rawStr !== null && rawStr !== undefined ? parseExactDecimalToScale(rawStr, 3) : null
    const isEstimated = Boolean(
      entry?.estimated !== undefined
        ? entry.estimated
        : Number(entry?.estimated_readings || 0) > 0,
    )
    return {
      index: idx,
      periodCode: p.period_code,
      periodStatus: p.status || 'LOCKED',
      isOpen: p.status === 'OPEN_FOR_RESIDENTS',
      valueStr: scaled !== null ? String(rawStr) : null,
      scaled,
      isGap: scaled === null,
      isNegative: scaled !== null && scaled < 0n,
      estimated: scaled !== null && isEstimated,
      apartmentsCounted:
        entry && entry.apartments_counted !== undefined && entry.apartments_counted !== null
          ? Number(entry.apartments_counted)
          : null,
      estimatedReadings:
        entry && entry.estimated_readings !== undefined && entry.estimated_readings !== null
          ? Number(entry.estimated_readings)
          : 0,
    }
  })

  const nonNullScaled = parsedSlots
    .map((s) => s.scaled)
    .filter((v): v is bigint => v !== null)
  let rawMin = 0n
  let rawMax = 0n
  for (const val of nonNullScaled) {
    if (val < rawMin) rawMin = val
    if (val > rawMax) rawMax = val
  }

  let domainMin = rawMin
  let domainMax = rawMax
  if (domainMin === 0n && domainMax === 0n) {
    domainMax = 1000n
  } else {
    const rawSpan = domainMax - domainMin
    const headroom = rawSpan / 10n > 100n ? rawSpan / 10n : 100n
    if (domainMax > 0n) domainMax += headroom
    if (domainMin < 0n) domainMin -= headroom
  }

  const domainSpan = domainMax - domainMin
  const baselineY = projectScaledY(0n, domainMin, domainSpan, plotTop, plotHeight)

  const tickValues: bigint[] = [domainMax]
  if (domainMin < 0n && domainMax > 0n) {
    tickValues.push(0n)
  } else if (domainMin >= 0n) {
    tickValues.push(domainMax / 2n)
  }
  tickValues.push(domainMin)

  const seenTicks = new Set<string>()
  const ticks = tickValues
    .filter((v) => {
      const k = v.toString()
      if (seenTicks.has(k)) return false
      seenTicks.add(k)
      return true
    })
    .map((v) => ({
      value: v.toString(),
      label: formatShortChartTick(v),
      y: projectScaledY(v, domainMin, domainSpan, plotTop, plotHeight),
      isZero: v === 0n,
    }))

  const maxTickChars = Math.max(
    4,
    ...ticks.map((t) => String(t.label || '').length),
    String(layout.unitLabel || '').length,
  )
  const plotLeft = Math.min(
    Math.max(minPlotLeft, Math.ceil(maxTickChars * 6.5) + 12),
    Math.max(minPlotLeft, plotRight - 60),
  )
  const plotWidth = Math.max(40, plotRight - plotLeft)

  const count = Math.max(1, parsedSlots.length)
  const slotWidth = plotWidth / count
  const barWidth = Math.max(6, Math.min(34, slotWidth * 0.62))

  const bars = parsedSlots.map((slot, i) => {
    const hitX = plotLeft + i * slotWidth
    const x = hitX + (slotWidth - barWidth) / 2
    const centerX = hitX + slotWidth / 2

    if (slot.scaled === null) {
      return {
        ...slot,
        x,
        centerX,
        width: barWidth,
        y: Math.max(plotTop, baselineY - 8),
        height: 8,
        hitX,
        hitWidth: slotWidth,
      }
    }

    const valY = projectScaledY(slot.scaled, domainMin, domainSpan, plotTop, plotHeight)
    let y: number
    let height: number

    if (slot.scaled < 0n) {
      y = baselineY
      height = Math.max(3, valY - baselineY)
      if (y + height > plotBottom) {
        height = Math.max(2, plotBottom - y)
      }
    } else if (slot.scaled === 0n) {
      height = 3
      y = Math.max(plotTop, baselineY - height)
    } else {
      height = Math.max(3, baselineY - valY)
      y = Math.max(plotTop, baselineY - height)
    }

    return {
      ...slot,
      x,
      centerX,
      width: barWidth,
      y,
      height,
      hitX,
      hitWidth: slotWidth,
    }
  })

  const visibleXLabelIndices = computeVisibleXLabelIndices(bars, slotWidth)
  const visibleOpenTextIndices = new Set<number>()
  const chosenOpenBars: typeof bars = []
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const b = bars[i]
    if (!b.isOpen) continue
    if (chosenOpenBars.some((other) => Math.abs(other.centerX - b.centerX) < 64)) {
      continue
    }
    chosenOpenBars.push(b)
    visibleOpenTextIndices.add(b.index)
  }

  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    slotWidth,
    baselineY,
    hasAnyData: nonNullScaled.length > 0,
    hasNegative: rawMin < 0n,
    ticks,
    bars: bars.map((b) => ({
      ...b,
      showXLabel: visibleXLabelIndices.has(b.index),
      showOpenText: visibleOpenTextIndices.has(b.index),
    })),
  }
}
