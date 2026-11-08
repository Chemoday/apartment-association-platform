const TALLINN_TZ = 'Europe/Tallinn'

function resolveIntlLocale(lang = 'en', enFallback = 'en-GB') {
  if (lang === 'et') return 'et-EE'
  if (lang === 'ru') return 'ru-RU'
  return enFallback
}

/**
 * Format an ISO UTC timestamp string in Europe/Tallinn timezone (e.g. "22 Oct 2026").
 * @param {string | null | undefined} isoString
 * @param {string} locale
 * @returns {string}
 */
export function formatDate(isoString, locale = 'en-GB') {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return String(isoString)
    return new Intl.DateTimeFormat(resolveIntlLocale(locale, 'en-GB'), {
      timeZone: TALLINN_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date)
  } catch {
    return String(isoString)
  }
}

/**
 * Format an ISO UTC timestamp string with date and time in Europe/Tallinn timezone.
 * @param {string | null | undefined} isoString
 * @param {string} locale
 * @returns {string}
 */
export function formatDateTime(isoString, locale = 'en-GB') {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return String(isoString)
    return new Intl.DateTimeFormat(resolveIntlLocale(locale, 'en-GB'), {
      timeZone: TALLINN_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return String(isoString)
  }
}

/**
 * Format period code ("2026-10") into readable label ("October 2026" / "Oktoober 2026").
 * @param {string | null | undefined} periodCode
 * @param {string} lang
 * @returns {string}
 */
export function formatPeriodLabel(periodCode, lang = 'en') {
  if (!periodCode || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodCode)) {
    return periodCode || '—'
  }
  const [year, month] = periodCode.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 15, 12, 0, 0))
  const formatted = new Intl.DateTimeFormat(resolveIntlLocale(lang, 'en-US'), {
    timeZone: TALLINN_TZ,
    month: 'long',
    year: 'numeric',
  }).format(date)
  return formatted.charAt(0).toUpperCase() + formatted.slice(1)
}

/**
 * Format an ISO timestamp as a short date without year (e.g. "25 Oct").
 * @param {string | null | undefined} isoString
 * @param {string} lang
 * @returns {string}
 */
export function formatShortDate(isoString, lang = 'en') {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return String(isoString)
    return new Intl.DateTimeFormat(resolveIntlLocale(lang, 'en-GB'), {
      timeZone: TALLINN_TZ,
      day: 'numeric',
      month: 'short',
    }).format(date)
  } catch {
    return String(isoString)
  }
}

/**
 * Format an ISO timestamp as relative time (e.g. "5 min ago", "yesterday").
 * @param {string | null | undefined} isoString
 * @param {string} lang
 * @returns {string}
 */
export function formatRelativeTime(isoString, lang = 'en') {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return String(isoString)
    const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000)
    const absSeconds = Math.abs(diffSeconds)
    const rtf = new Intl.RelativeTimeFormat(resolveIntlLocale(lang, 'en-GB'), {
      numeric: 'auto',
      style: 'short',
    })
    if (absSeconds < 45) {
      if (lang === 'et') return 'just nüüd'
      if (lang === 'ru') return 'только что'
      return 'just now'
    }
    if (absSeconds < 3600) {
      return rtf.format(Math.round(diffSeconds / 60), 'minute')
    }
    if (absSeconds < 86400) {
      return rtf.format(Math.round(diffSeconds / 3600), 'hour')
    }
    if (absSeconds < 86400 * 30) {
      return rtf.format(Math.round(diffSeconds / 86400), 'day')
    }
    return formatDate(isoString, lang)
  } catch {
    return String(isoString)
  }
}
