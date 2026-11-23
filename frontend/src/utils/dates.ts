const TALLINN_TZ = 'Europe/Tallinn'

function resolveIntlLocale(lang: string = 'en', enFallback: string = 'en-GB'): string {
  if (lang === 'et') return 'et-EE'
  if (lang === 'ru') return 'ru-RU'
  return enFallback
}

/**
 * Format an ISO UTC timestamp string in Europe/Tallinn timezone (e.g. "22 Oct 2026").
 */
export function formatDate(isoString?: string | null, locale: string = 'en-GB'): string {
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
 * Format a pure calendar date string ("YYYY-MM-DD") without timezone shift.
 * Returns `'-'` for null/undefined/blank values.
 */
export function formatCalendarDate(dateStr?: string | null, locale: string = 'en-GB'): string {
  if (typeof dateStr !== 'string') return '-'
  const trimmed = dateStr.trim()
  if (!trimmed) return '-'
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (match) {
    const y = Number(match[1])
    const m = Number(match[2])
    const d = Number(match[3])
    const utcDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    if (
      utcDate.getUTCFullYear() === y &&
      utcDate.getUTCMonth() === m - 1 &&
      utcDate.getUTCDate() === d
    ) {
      return new Intl.DateTimeFormat(resolveIntlLocale(locale, 'en-GB'), {
        timeZone: 'UTC',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(utcDate)
    }
  }
  return formatDate(trimmed, locale)
}

/**
 * Format an ISO UTC timestamp string with date and time in Europe/Tallinn timezone.
 */
export function formatDateTime(isoString?: string | null, locale: string = 'en-GB'): string {
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
 */
export function formatPeriodLabel(periodCode?: string | null, lang: string = 'en'): string {
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
 * Compute the next YYYY-MM period code after the given periodCode.
 */
export function getNextPeriodCode(periodCode?: string | null): string {
  if (!periodCode || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodCode)) {
    return ''
  }
  const [year, month] = periodCode.split('-').map(Number)
  if (month === 12) {
    return `${year + 1}-01`
  }
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

/**
 * Format period code ("2026-10") into a standalone localized month name ("October" / "oktoober" / "октябрь").
 */
export function formatMonthName(
  periodCode?: string | null,
  lang: string = 'en',
  { capitalize = lang === 'en' }: { capitalize?: boolean } = {},
): string {
  if (!periodCode || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodCode)) {
    return periodCode || '—'
  }
  const [year, month] = periodCode.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 15, 12, 0, 0))
  const raw = new Intl.DateTimeFormat(resolveIntlLocale(lang, 'en-US'), {
    timeZone: TALLINN_TZ,
    month: 'long',
  }).format(date)
  return capitalize ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw.toLowerCase()
}

/**
 * Format an ISO timestamp as a short date without year (e.g. "25 Oct").
 */
export function formatShortDate(isoString?: string | null, lang: string = 'en'): string {
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
 */
export function formatRelativeTime(isoString?: string | null, lang: string = 'en'): string {
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
