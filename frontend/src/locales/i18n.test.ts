import test from 'node:test'
import assert from 'node:assert/strict'
import en from './en.js'
import et from './et.js'
import ru from './ru.js'
import { i18n, setI18nLocale, localizeError, SUPPORTED_LOCALES } from './index.js'

function collectKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v as Record<string, any>, path))
    } else {
      keys.push(path)
    }
  }
  return keys.sort()
}

test('en, et, and ru dictionaries have identical translation key sets', () => {
  const enKeys = collectKeys(en)
  const etKeys = collectKeys(et)
  const ruKeys = collectKeys(ru)
  assert.deepEqual(enKeys, etKeys)
  assert.deepEqual(enKeys, ruKeys)
  assert.ok(enKeys.length > 150, 'Expected comprehensive dictionary key coverage')
})

test('SUPPORTED_LOCALES includes en, et, and ru and setI18nLocale switches active language', () => {
  const codes = SUPPORTED_LOCALES.map((l) => l.code)
  assert.deepEqual(codes, ['en', 'et', 'ru'])

  setI18nLocale('et')
  assert.equal(i18n.global.locale.value, 'et')
  assert.equal(i18n.global.t('nav.dashboard'), 'Töölaud')
  assert.equal(i18n.global.t('dashboard.greeting', { name: 'Kati' }), 'Tere päevast, Kati')

  setI18nLocale('ru')
  assert.equal(i18n.global.locale.value, 'ru')
  assert.equal(i18n.global.t('nav.dashboard'), 'Главная')
  assert.equal(i18n.global.t('dashboard.greeting', { name: 'Kati' }), 'Добрый день, Kati')

  setI18nLocale('en')
  assert.equal(i18n.global.locale.value, 'en')
  assert.equal(i18n.global.t('nav.dashboard'), 'Dashboard')
  assert.equal(i18n.global.t('dashboard.greeting', { name: 'Kati' }), 'Good afternoon, Kati')
})

test('localizeError translates backend error codes with parameters in all locales', () => {
  const msgEn = localizeError(
    'READING_BELOW_PREVIOUS',
    { previous_value: '84.100' },
    'en',
  )
  assert.equal(msgEn, 'Reading cannot be lower than the previous recorded value (84.100).')

  const msgEt = localizeError(
    'READING_BELOW_PREVIOUS',
    { previous_value: '84.100' },
    'et',
  )
  assert.equal(msgEt, 'Näit ei saa olla väiksem kui eelmine kinnitatud näit (84.100).')

  const msgRu = localizeError(
    'READING_BELOW_PREVIOUS',
    { previous_value: '84.100' },
    'ru',
  )
  assert.equal(
    msgRu,
    'Показание не может быть меньше предыдущего зафиксированного значения (84.100).',
  )

  assert.equal(
    localizeError('PASSWORD_TOO_WEAK', { reason: 'TOO_SHORT' }, 'en'),
    'Use at least 15 characters.',
  )
  assert.equal(
    localizeError('PASSWORD_TOO_WEAK', { reason: 'TOO_COMMON' }, 'ru'),
    'Выберите менее распространённый пароль.',
  )
  assert.equal(
    localizeError('INVITATION_NO_LONGER_VALID', {}, 'en'),
    'This invitation no longer applies. Delete it and invite again.',
  )
  assert.equal(
    localizeError('APARTMENT_NOT_FOUND', {}, 'ru'),
    'Квартиры с таким номером нет.',
  )
  assert.equal(
    localizeError('RATE_LIMITED', { retry_after_seconds: 600 }, 'en'),
    'Too many attempts. Try again in 600 seconds.',
  )
})

test('every translation key in en, et, and ru compiles cleanly without vue-i18n syntax errors', () => {
  const keys = collectKeys(en)
  for (const locale of ['en', 'et', 'ru'] as const) {
    for (const key of keys) {
      const rendered = i18n.global.t(key, {}, { locale })
      assert.equal(typeof rendered, 'string', `Failed to compile ${locale}.${key}`)
    }
  }
  assert.equal(i18n.global.t('auth.login.emailPlaceholder', {}, { locale: 'en' }), 'name@example.com')
  assert.equal(i18n.global.t('auth.login.emailPlaceholder', {}, { locale: 'et' }), 'nimi@naide.ee')
  assert.equal(i18n.global.t('auth.login.emailPlaceholder', {}, { locale: 'ru' }), 'name@example.com')
})

test('setI18nLocale accepts SUPPORTED_LOCALES objects as well as string codes', () => {
  for (const locObj of SUPPORTED_LOCALES) {
    const applied = setI18nLocale(locObj as any)
    assert.equal(applied, locObj.code)
    assert.equal(i18n.global.locale.value, locObj.code)
  }
  setI18nLocale('en')
})

test('localizeError handles error objects with string locale or function passed as 2nd argument', () => {
  setI18nLocale('ru')
  const errObj = {
    errorCode: 'POLL_NOT_OPEN',
    payload: { error_code: 'POLL_NOT_OPEN' },
  }
  // Called with (errObj, session.t)
  const msgWithFn = localizeError(errObj, (() => '') as any)
  assert.equal(msgWithFn, ru.errors.POLL_NOT_OPEN)

  // Called with (errObj, 'et')
  const msgWithLangString = localizeError(errObj, 'et')
  assert.equal(msgWithLangString, et.errors.POLL_NOT_OPEN)

  setI18nLocale('en')
})



