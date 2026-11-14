import { formatMonthName, getNextPeriodCode } from './dates.js'

/**
 * Determine whether a meter is considered reported for its current submission cycle.
 * When `next_submission` is present, its `reading` determines whether the target period is reported;
 * otherwise fallback to `meter.reading`.
 * @param {any} meter
 * @returns {boolean}
 */
export function isMeterReportedForActivePeriod(meter) {
  if (!meter) return false
  if (meter.next_submission && typeof meter.next_submission === 'object') {
    return meter.next_submission.reading !== null
  }
  return meter.reading !== null
}

/**
 * Compute summary submission counts across one or more apartments using `next_submission` when present.
 * @param {Array<any>} apartments
 * @returns {{ reported: number, total: number, allSubmitted: boolean, pendingPeriodCode: string | null, activePeriodCode: string | null }}
 */
export function summarizeNextSubmissions(apartments = []) {
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
  let earliestPendingCode = null
  let latestNextCode = null

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
 * Resolve the form fields for a resident meter card (using `next_submission` when present).
 * @param {any} meter
 * @param {boolean} useNextSubmission
 * @returns {{
 *   submission: any | null,
 *   hasForm: boolean,
 *   periodCode: string | null,
 *   dueDate: string | null,
 *   isFinal: boolean,
 *   previousValue: string,
 *   averageDelta: string | null,
 *   reading: any | null
 * }}
 */
export function resolveResidentFormContext(meter, useNextSubmission = true) {
  if (!useNextSubmission) {
    return {
      submission: null,
      hasForm: true,
      periodCode: null,
      dueDate: null,
      isFinal: false,
      previousValue: meter?.previous_value || '0.000',
      averageDelta: meter?.average_delta ?? null,
      reading: meter?.reading || null,
    }
  }

  const sub = meter?.next_submission ?? null
  if (!sub) {
    return {
      submission: null,
      hasForm: false,
      periodCode: null,
      dueDate: null,
      isFinal: false,
      previousValue: meter?.previous_value || '0.000',
      averageDelta: meter?.average_delta ?? null,
      reading: meter?.reading || null,
    }
  }

  return {
    submission: sub,
    hasForm: true,
    periodCode: sub.period_code,
    dueDate: sub.due_date || null,
    isFinal: Boolean(sub.final),
    previousValue: sub.previous_value,
    averageDelta: sub.average_delta ?? null,
    reading: sub.reading || null,
  }
}

/**
 * Format the warning month parameters for a final late reading (`final: true`).
 * @param {string} periodCode
 * @param {string} lang
 * @returns {{ prevMonth: string, nextMonth: string }}
 */
export function getFinalWarningMonths(periodCode, lang = 'en') {
  const nextCode = getNextPeriodCode(periodCode)
  return {
    prevMonth: formatMonthName(periodCode, lang),
    nextMonth: formatMonthName(nextCode, lang),
  }
}
