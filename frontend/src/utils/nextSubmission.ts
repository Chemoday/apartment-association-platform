import { formatMonthName, getNextPeriodCode } from './dates.js'
import { normalizeMeterInput, toThreeDecimals } from './meterValue.js'

export interface NextSubmissionReadingLike {
  previous_origin?: string | null
  previous_value?: string | number | null
  value?: string | number | null
  [key: string]: unknown
}

export interface NextSubmissionEntryLike {
  period_code?: string | null
  due_date?: string | null
  is_final?: boolean | null
  needs_start?: boolean | null
  previous_value?: string | null
  average_delta?: string | null
  reading?: NextSubmissionReadingLike | null
  [key: string]: unknown
}

export interface NextSubmissionMeterLike {
  needs_start?: boolean | null
  previous_value?: string | null
  average_delta?: string | null
  reading?: NextSubmissionReadingLike | null
  next_submission?: NextSubmissionEntryLike | null
  [key: string]: unknown
}

export interface NextSubmissionApartmentLike {
  meters?: NextSubmissionMeterLike[] | null
}

/**
 * Determine whether a meter is considered reported for its current submission cycle.
 * When `next_submission` is present, its `reading` determines whether the target period is reported;
 * otherwise fallback to `meter.reading`.
 */
export function isMeterReportedForActivePeriod(
  meter: NextSubmissionMeterLike | null | undefined,
): boolean {
  if (!meter) return false
  if (meter.next_submission && typeof meter.next_submission === 'object') {
    return meter.next_submission.reading !== null
  }
  return meter.reading !== null
}

/**
 * Compute summary submission counts across one or more apartments using `next_submission` when present.
 */
export function summarizeNextSubmissions(apartments: NextSubmissionApartmentLike[] = []): {
  reported: number
  total: number
  allSubmitted: boolean
  pendingPeriodCode: string | null
  activePeriodCode: string | null
} {
  const meters = (apartments || []).flatMap((a) => a?.meters || [])
  const total = meters.length
  if (total === 0) {
    return {
      reported: 0,
      total: 0,
      allSubmitted: false,
      pendingPeriodCode: null,
      activePeriodCode: null,
    }
  }

  let reported = 0
  let earliestPendingCode: string | null = null
  let latestNextCode: string | null = null

  for (const m of meters) {
    if (isMeterReportedForActivePeriod(m)) {
      reported += 1
    }
    const sub = m.next_submission
    if (sub?.period_code) {
      if (!latestNextCode || sub.period_code > latestNextCode) {
        latestNextCode = sub.period_code
      }
      if (sub.reading === null) {
        if (!earliestPendingCode || sub.period_code < earliestPendingCode) {
          earliestPendingCode = sub.period_code
        }
      }
    }
  }

  return {
    reported,
    total,
    allSubmitted: reported === total,
    pendingPeriodCode: earliestPendingCode,
    activePeriodCode: earliestPendingCode || latestNextCode,
  }
}

/**
 * Derive initial state for the optional "reading on your last bill" input (#038).
 * Only prefills when `needsStart` is true AND the existing reading has `previous_origin === 'SUBMITTED'`.
 * Never prefills for `START` (whose `previous_value` is its own reading value) or when no reading exists.
 */
function resolveBillPreviousPrefill(
  needsStart: boolean,
  reading: NextSubmissionReadingLike | null | undefined,
): { initialBillPreviousValue: string; hasPrefilledBillPrevious: boolean } {
  if (
    needsStart &&
    reading?.previous_origin === 'SUBMITTED' &&
    reading?.previous_value !== null &&
    reading?.previous_value !== undefined &&
    String(reading.previous_value).trim() !== ''
  ) {
    return {
      initialBillPreviousValue: String(reading.previous_value),
      hasPrefilledBillPrevious: true,
    }
  }
  return {
    initialBillPreviousValue: '',
    hasPrefilledBillPrevious: false,
  }
}

/**
 * Resolve the form fields for a resident meter card (using `next_submission` when present).
 */
export function resolveResidentFormContext(
  meter: NextSubmissionMeterLike | null | undefined,
  useNextSubmission: boolean = true,
): {
  submission: NextSubmissionEntryLike | null
  hasForm: boolean
  periodCode: string | null
  dueDate: string | null
  isFinal: boolean
  needsStart: boolean
  previousValue: string | null
  averageDelta: string | null
  reading: NextSubmissionReadingLike | null
  initialBillPreviousValue: string
  hasPrefilledBillPrevious: boolean
} {
  if (!useNextSubmission) {
    const needsStart = Boolean(meter?.needs_start)
    const reading = meter?.reading || null
    return {
      submission: null,
      hasForm: true,
      periodCode: null,
      dueDate: null,
      isFinal: false,
      needsStart,
      previousValue: meter?.previous_value ?? null,
      averageDelta: meter?.average_delta ?? null,
      reading,
      ...resolveBillPreviousPrefill(needsStart, reading),
    }
  }

  const sub = meter?.next_submission ?? null
  if (!sub) {
    const needsStart = Boolean(meter?.needs_start)
    const reading = meter?.reading || null
    return {
      submission: null,
      hasForm: false,
      periodCode: null,
      dueDate: null,
      isFinal: false,
      needsStart,
      previousValue: meter?.previous_value ?? null,
      averageDelta: meter?.average_delta ?? null,
      reading,
      ...resolveBillPreviousPrefill(needsStart, reading),
    }
  }

  const needsStart = Boolean(sub.needs_start)
  const reading = sub.reading || null
  return {
    submission: sub,
    hasForm: true,
    periodCode: sub.period_code ?? null,
    dueDate: sub.due_date || null,
    isFinal: Boolean(sub.final),
    needsStart,
    previousValue: sub.previous_value ?? null,
    averageDelta: sub.average_delta ?? null,
    reading,
    ...resolveBillPreviousPrefill(needsStart, reading),
  }
}

/**
 * Determine whether and what `previous_value` to include in `POST /api/v1/meters/readings` (#038).
 */
export function resolveStartPreviousValueSubmission({
  needsStart,
  rawInput,
  initialValue = '',
  hasPrefilled = false,
  touched = false,
}: {
  needsStart: boolean
  rawInput: string | null | undefined
  initialValue?: string | null
  hasPrefilled?: boolean
  touched?: boolean
}): { ok: boolean; include: boolean; value?: string | null; errorCode?: string } {
  if (!needsStart) {
    return { ok: true, include: false }
  }

  const trimmed = rawInput === null || rawInput === undefined ? '' : String(rawInput).trim()
  const initialTrimmed =
    initialValue === null || initialValue === undefined ? '' : String(initialValue).trim()

  if (!touched && trimmed === initialTrimmed) {
    return { ok: true, include: false }
  }

  if (trimmed === '') {
    if (hasPrefilled) {
      return { ok: true, include: true, value: null }
    }
    return { ok: true, include: false }
  }

  const normalized = normalizeMeterInput(trimmed)
  if (normalized === null) {
    return { ok: false, include: false, errorCode: 'invalid_number' }
  }

  if (hasPrefilled && initialTrimmed !== '') {
    const normalizedCanonical = toThreeDecimals(normalized)
    const initialCanonical = toThreeDecimals(initialTrimmed)
    if (normalizedCanonical !== null && normalizedCanonical === initialCanonical) {
      return { ok: true, include: false }
    }
  }

  return { ok: true, include: true, value: normalized }
}

/**
 * Format the warning month parameters for a final late reading (`final: true`).
 */
export function getFinalWarningMonths(
  periodCode?: string | null,
  lang: string = 'en',
): { prevMonth: string; nextMonth: string } {
  const nextCode = getNextPeriodCode(periodCode)
  return {
    prevMonth: formatMonthName(periodCode, lang),
    nextMonth: formatMonthName(nextCode, lang),
  }
}
