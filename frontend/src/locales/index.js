import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { formatMonthName } from '../utils/dates.js'
import en from './en.js'

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'EN' },
  { code: 'et', label: 'ET' },
  { code: 'ru', label: 'RU' },
]

const LANG_KEY = 'hoa_ui_lang'

/**
 * Reactive counter incremented whenever a lazy locale dictionary chunk finishes loading.
 * Consumed by `session.t`, `localizeError`, `useTranslations`, and layout title watchers
 * so UI and `document.title` re-evaluate immediately when `et.js` / `ru.js` arrives.
 */
export const localeMessagesRevision = ref(0)

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

/** @type {Record<'en' | 'et' | 'ru', any>} */
const MESSAGES = {
  en,
  et: {},
  ru: {},
}

const loadedLocales = new Set(['en'])

const LOCALE_LOADERS = {
  en: async () => en,
  et: () => import('./et.js').then((mod) => mod.default),
  ru: () => import('./ru.js').then((mod) => mod.default),
}

const inFlightLoads = new Map()

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: readStoredLocale(),
  fallbackLocale: 'en',
  messages: MESSAGES,
})

export function normalizeLocaleCode(newLocale) {
  const code =
    newLocale && typeof newLocale === 'object' && typeof newLocale.code === 'string'
      ? newLocale.code
      : newLocale
  return SUPPORTED_LOCALES.some((l) => l.code === code) ? code : 'en'
}

export function isLocaleLoaded(localeCode) {
  return loadedLocales.has(normalizeLocaleCode(localeCode))
}

/**
 * Test-only helper to simulate a cold (unloaded) lazy locale chunk in unit tests.
 * @param {'et' | 'ru'} localeCode
 * @param {(() => Promise<Record<string, any>>) | null} [customLoader]
 */
export function evictLocaleForTest(localeCode, customLoader = null) {
  if (localeCode !== 'et' && localeCode !== 'ru') return
  loadedLocales.delete(localeCode)
  inFlightLoads.delete(localeCode)
  MESSAGES[localeCode] = {}
  i18n.global.setLocaleMessage(localeCode, {})
  if (customLoader) {
    LOCALE_LOADERS[localeCode] = customLoader
  } else if (localeCode === 'et') {
    LOCALE_LOADERS.et = () => import('./et.js').then((mod) => mod.default)
  } else {
    LOCALE_LOADERS.ru = () => import('./ru.js').then((mod) => mod.default)
  }
  localeMessagesRevision.value += 1
}

/**
 * Lazy-load a locale dictionary chunk on demand and register it with vue-i18n.
 * @param {string} localeCode
 * @returns {Promise<Record<string, any>>}
 */
export async function ensureLocaleLoaded(localeCode) {
  const valid = normalizeLocaleCode(localeCode)
  if (loadedLocales.has(valid)) return MESSAGES[valid]
  if (inFlightLoads.has(valid)) return inFlightLoads.get(valid)

  const loader = LOCALE_LOADERS[valid]
  const promise = loader()
    .then((dict) => {
      MESSAGES[valid] = dict
      loadedLocales.add(valid)
      i18n.global.setLocaleMessage(valid, dict)
      localeMessagesRevision.value += 1
      return dict
    })
    .finally(() => {
      inFlightLoads.delete(valid)
    })

  inFlightLoads.set(valid, promise)
  return promise
}

// Under Node/Vite-SSR test runners, preload et & ru so synchronous assertions work,
// while production client Vite builds replace import.meta.env.SSR with false and code-split them.
if (typeof import.meta.env === 'undefined' || import.meta.env.SSR) {
  await Promise.all([ensureLocaleLoaded('et'), ensureLocaleLoaded('ru')])
}

/**
 * Synchronize vue-i18n locale, localStorage, and document.documentElement.lang.
 * Triggers lazy dictionary loading automatically if the locale chunk is not yet loaded.
 * @param {string} newLocale
 * @returns {string}
 */
export function setI18nLocale(newLocale) {
  const valid = normalizeLocaleCode(newLocale)
  if (!loadedLocales.has(valid)) {
    ensureLocaleLoaded(valid).catch(() => {})
  }
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

  // Touch reactive revision so computed callers (e.g. ErrorCard) re-evaluate when lazy locale loads
  void localeMessagesRevision.value
  const errorCode = errorOrCode
  const activeLocale = resolvedLang || i18n.global.locale.value || 'en'
  const dict =
    (loadedLocales.has(activeLocale) ? MESSAGES[activeLocale]?.errors : null) || MESSAGES.en.errors
  payload = normalizedPayload

  let key = dict[errorCode] ? errorCode : 'DEFAULT'
  if (
    (errorCode === 'PASSWORD_TOO_WEAK' || errorCode === 'RATE_LIMITED') &&
    payload?.reason
  ) {
    const reasonKey = `${errorCode}_${String(payload.reason).toUpperCase()}`
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

  const month = payload?.target_period_code
    ? formatMonthName(payload.target_period_code, activeLocale)
    : payload?.month || ''

  return i18n.global.t(
    `errors.${key}`,
    {
      ...payload,
      month,
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
  void localeMessagesRevision.value
  const activeLocale = lang || i18n.global.locale.value || 'en'
  return loadedLocales.has(activeLocale) ? MESSAGES[activeLocale] : MESSAGES.en
}

