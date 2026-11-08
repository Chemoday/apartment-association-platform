import { createI18n } from 'vue-i18n'
import en from './en.js'
import et from './et.js'
import ru from './ru.js'

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'EN' },
  { code: 'et', label: 'ET' },
  { code: 'ru', label: 'RU' },
]

const LANG_KEY = 'hoa_ui_lang'

export function readStoredLocale() {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) {
      return saved
    }
  } catch {
    /* ignore */
  }
  return 'en'
}

const MESSAGES = {
  en,
  et,
  ru,
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: readStoredLocale(),
  fallbackLocale: 'en',
  messages: MESSAGES,
})

/**
 * Synchronize vue-i18n locale, localStorage, and document.documentElement.lang.
 * @param {string} newLocale
 * @returns {string}
 */
export function setI18nLocale(newLocale) {
  const code =
    newLocale && typeof newLocale === 'object' && typeof newLocale.code === 'string'
      ? newLocale.code
      : newLocale
  const valid = SUPPORTED_LOCALES.some((l) => l.code === code) ? code : 'en'
  i18n.global.locale.value = valid
  try {
    localStorage.setItem(LANG_KEY, valid)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = valid
  }
  return valid
}

/**
 * Localize an error_code from the API without relying on English developer message.
 * Supports `localizeError(errObj)`, `localizeError(errObj, lang)`, `localizeError(errObj, tFn)`,
 * and `localizeError(errorCode, payload, lang)`.
 * @param {string | Record<string, any>} errorOrCode
 * @param {Record<string, any> | string | Function} [payload]
 * @param {string} [lang]
 * @returns {string}
 */
export function localizeError(errorOrCode, payload = {}, lang) {
  let normalizedPayload = payload
  let resolvedLang = lang
  if (typeof payload === 'string') {
    resolvedLang = payload
    normalizedPayload = {}
  } else if (typeof payload === 'function' || payload === null || typeof payload !== 'object') {
    normalizedPayload = {}
  }

  if (errorOrCode && typeof errorOrCode === 'object') {
    const err = errorOrCode
    const code = err.errorCode || err.payload?.error_code || 'DEFAULT'
    const mergedPayload = {
      ...(err.payload || {}),
      trace_id: err.traceId || err.payload?.trace_id || '',
      ...normalizedPayload,
    }
    return localizeError(code, mergedPayload, resolvedLang)
  }

  const errorCode = errorOrCode
  const activeLocale = resolvedLang || i18n.global.locale.value || 'en'
  const dict = MESSAGES[activeLocale]?.errors || MESSAGES.en.errors
  payload = normalizedPayload

  let key = dict[errorCode] ? errorCode : 'DEFAULT'
  if (errorCode === 'PASSWORD_TOO_WEAK' && payload?.reason) {
    const reasonKey = `PASSWORD_TOO_WEAK_${String(payload.reason).toUpperCase()}`
    if (dict[reasonKey]) {
      key = reasonKey
    }
  }

  if (
    errorCode === 'VALIDATION_ERROR' &&
    Array.isArray(payload?.errors) &&
    payload.errors.length > 0 &&
    payload.errors[0]?.message
  ) {
    return payload.errors.map((e) => e.message).join(' ')
  }

  const rawSeconds = Number(payload?.retry_after_seconds ?? payload?.seconds ?? 60)
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.ceil(rawSeconds) : 60
  const minutes = Math.max(1, Math.ceil(seconds / 60))

  const previousValue =
    payload?.previous_value ||
    (activeLocale === 'et' ? 'eelmine' : activeLocale === 'ru' ? 'предыдущее' : 'previous')
  const allowedStatuses =
    (payload?.allowed_statuses || []).join(', ') ||
    (activeLocale === 'et' ? 'puudub' : activeLocale === 'ru' ? 'нет' : 'none')
  const traceSuffix = payload?.trace_id
    ? activeLocale === 'et'
      ? ` Veakood: ${payload.trace_id}`
      : activeLocale === 'ru'
        ? ` Код ошибки: ${payload.trace_id}`
        : ` Error code: ${payload.trace_id}`
    : ''

  return i18n.global.t(
    `errors.${key}`,
    {
      ...payload,
      seconds,
      minutes,
      previous_value: previousValue,
      allowed_statuses: allowedStatuses,
      trace_suffix: traceSuffix,
    },
    { locale: activeLocale },
  )
}

/**
 * Get dictionary for current language.
 * @param {string} [lang]
 */
export function useTranslations(lang) {
  const activeLocale = lang || i18n.global.locale.value || 'en'
  return MESSAGES[activeLocale] || MESSAGES.en
}

