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

test('localizeError translates all #020 and #025 photo error codes and #021 retention notices across en, et, and ru', () => {
  const photoErrorCodes = [
    'UPLOAD_INTERRUPTED',
    'UPLOAD_TIMEOUT',
    'UPLOAD_REMOVED',
    'UPLOADS_DISABLED',
    'PHOTO_NOT_FOUND',
    'PHOTO_LIMIT_REACHED',
    'IDEMPOTENCY_KEY_REUSED',
    'LENGTH_REQUIRED',
    'FILE_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'INVALID_IMAGE',
    'IMAGE_TOO_LARGE',
    'PHOTO_SCALING_FAILED',
    'RATE_LIMITED',
    'STORAGE_QUOTA_EXCEEDED',
    'STORAGE_LOW_DISK',
  ]

  for (const locale of ['en', 'et', 'ru'] as const) {
    const defaultText = i18n.global.t('errors.DEFAULT', { trace_suffix: '' }, { locale })
    for (const code of photoErrorCodes) {
      const rendered = localizeError(code, { retry_after_seconds: 30 }, locale)
      assert.ok(rendered.length > 0, `Empty translation for ${locale}.errors.${code}`)
      assert.notEqual(
        rendered,
        defaultText,
        `${locale}.errors.${code} unexpectedly fell back to DEFAULT`,
      )
    }

    const busyRendered = localizeError(
      'RATE_LIMITED',
      { reason: 'BUSY', retry_after_seconds: 14 },
      locale,
    )
    const dailyRendered = localizeError('RATE_LIMITED', { reason: 'DAILY_LIMIT' }, locale)
    assert.ok(busyRendered.includes('14'))
    assert.notEqual(busyRendered, localizeError('RATE_LIMITED', { retry_after_seconds: 14 }, locale))
    assert.ok(dailyRendered.length > 10)
    assert.equal(i18n.global.t('issues.photos.dailyLimitRetryWait', {}, { locale }), dailyRendered)

    const hint = i18n.global.t('issues.photos.retentionHint', {}, { locale })
    const scheduled = i18n.global.t('issues.photos.photosWillBeDeletedOn', { date: '2026-12-12' }, { locale })
    const warn = i18n.global.t('issues.photos.confirmPhotosDeletedWarning', {}, { locale })
    const disabledSavedTitle = i18n.global.t('issues.photos.uploadsDisabledSavedTitle', {}, { locale })
    const disabledSavedBody = i18n.global.t('issues.photos.uploadsDisabledSavedBody', {}, { locale })
    const disabledPartialSavedBody = i18n.global.t('issues.photos.uploadsDisabledPartialSavedBody', {}, { locale })
    const photoNotAttached = i18n.global.t('issues.photos.photoNotAttached', {}, { locale })
    assert.ok(hint.length > 10)
    assert.ok(scheduled.includes('2026-12-12'))
    assert.ok(warn.length > 5)
    assert.ok(disabledSavedTitle.length > 5)
    assert.ok(disabledSavedBody.length > 10)
    assert.ok(disabledPartialSavedBody.length > 10)
    assert.ok(photoNotAttached.length > 2)

    // #022 & #023 Documents categories, audiences, confirm prompt & errors
    for (const cat of [
      'ARTICLES',
      'GENERAL_MEETING_MINUTES',
      'BOARD_MINUTES',
      'CONTRACT',
      'INVOICE',
      'FINANCIAL_REPORT',
      'INSURANCE',
      'HOUSE_RULES',
      'OTHER',
    ]) {
      assert.ok(i18n.global.t(`documents.categories.${cat}`, {}, { locale }).length > 1)
    }
    for (const aud of ['EVERYONE', 'BOARD_AND_ACCOUNTANT', 'BOARD']) {
      assert.ok(i18n.global.t(`documents.audiences.${aud}`, {}, { locale }).length > 2)
    }
    assert.ok(i18n.global.t('documents.confirmDeletePrompt', {}, { locale }).length > 5)
    for (const errKey of [
      'FILE_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UPLOAD_INTERRUPTED',
      'UPLOAD_REMOVED',
      'IDEMPOTENCY_KEY_REUSED',
      'UPLOADS_DISABLED',
      'FORBIDDEN',
      'DOCUMENT_NOT_FOUND',
      'RATE_LIMITED',
      'RATE_LIMITED_WAIT',
      'STORAGE_FULL',
      'VALIDATION_ERROR',
      'UNKNOWN',
    ]) {
      assert.ok(
        i18n.global.t(`documents.errors.${errKey}`, { max_mb: 20, seconds: 15 }, { locale }).length > 3,
      )
    }
    for (const valKey of [
      'FILE_REQUIRED',
      'FILE_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'TITLE_REQUIRED',
      'TITLE_TOO_LONG',
      'TITLE_INVALID',
      'CATEGORY_REQUIRED',
      'AUDIENCE_INVALID',
      'DATE_INVALID',
    ]) {
      assert.ok(
        i18n.global.t(`documents.validation.${valKey}`, { max_mb: 20 }, { locale }).length > 3,
      )
    }

    // #024 Storage usage & alerts translations
    assert.ok(i18n.global.t('associationSettings.storage.title', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('associationSettings.storage.subtitle', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('associationSettings.storage.progressAria', { percent: 50 }, { locale }).includes('50'))
    assert.ok(i18n.global.t('associationSettings.storage.usedOfTotal', { used: '10 MB', total: '100 MB', percent: 10 }, { locale }).includes('10 MB'))
    assert.ok(i18n.global.t('associationSettings.storage.categoriesTitle', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('associationSettings.storage.categories.photos', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('associationSettings.storage.categories.documents', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('associationSettings.storage.categoryUsage', { used: '5 MB', limit: '80 MB' }, { locale }).includes('5 MB'))
    assert.ok(i18n.global.t('associationSettings.storage.pendingDeletion', { size: '2 MB' }, { locale }).includes('2 MB'))
    assert.ok(i18n.global.t('associationSettings.storage.pendingDeletionHint', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('notifications.events.STORAGE_ALMOST_FULL', { used_percent: 85 }, { locale }).includes('85'))

    // #026 Hidden and edited posts/comments error codes & UI strings
    for (const commErr of [
      'POST_HIDDEN',
      'POST_NOT_EDITABLE',
      'COMMENT_NOT_EDITABLE',
      'POST_NOT_HIDEABLE',
      'COMMENT_NOT_HIDEABLE',
      'EDIT_WINDOW_CLOSED',
      'COMMENT_NOT_FOUND',
    ]) {
      const msg = localizeError(commErr, {}, locale)
      assert.ok(msg.length > 5, `Empty translation for ${locale}.errors.${commErr}`)
      assert.notEqual(msg, defaultText, `${locale}.errors.${commErr} fell back to DEFAULT`)
    }
    assert.ok(i18n.global.t('forum.editedLabel', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('forum.editedAtTooltip', { time: '20 Oct 2026' }, { locale }).includes('20 Oct 2026'))
    assert.ok(i18n.global.t('forum.hiddenByBoard', {}, { locale }).length > 2)
    assert.ok(
      i18n.global.t('forum.hiddenByBoardWithReason', { reason: 'House rules' }, { locale }).includes('House rules'),
    )
    assert.ok(i18n.global.t('forum.hiddenTopicBadge', {}, { locale }).length > 1)
    assert.ok(i18n.global.t('forum.hiddenTopicNotice', {}, { locale }).length > 5)

    // #028 Board hide/unhide modal and button strings
    for (const key of [
      'forum.hideBtn',
      'forum.unhideBtn',
      'forum.hideTopicModalTitle',
      'forum.hideCommentModalTitle',
      'forum.hideModalAuthorHint',
      'forum.hideReasonLabel',
      'forum.hideReasonPlaceholder',
      'forum.hideReasonRequired',
      'forum.hideReasonTooLong',
      'forum.hideReasonInvalidChars',
      'forum.hideConfirmBtn',
    ]) {
      assert.ok(i18n.global.t(key, {}, { locale }).length > 1, `Missing or empty ${locale}.${key}`)
    }

    // #027 Edit own posts and comments strings
    for (const key of [
      'forum.editBtn',
      'forum.editPostModalTitle',
      'forum.editPostTitleLabel',
      'forum.editPostBodyLabel',
      'forum.editPostTitleRequired',
      'forum.editPostBodyRequired',
      'forum.editInvalidChars',
      'forum.saveEditBtn',
      'forum.editCommentLabel',
      'forum.commentBodyRequired',
    ]) {
      assert.ok(i18n.global.t(key, {}, { locale }).length > 1, `Missing or empty ${locale}.${key}`)
    }
    assert.ok(i18n.global.t('forum.editPostTitleTooLong', { max: 255 }, { locale }).includes('255'))
    assert.ok(i18n.global.t('forum.editPostBodyTooLong', { max: 10000 }, { locale }).includes('10000'))
    assert.ok(i18n.global.t('forum.commentBodyTooLong', { max: 4000 }, { locale }).includes('4000'))
    assert.ok(i18n.global.t('forum.charsCounter', { count: 12, max: 255 }, { locale }).includes('12'))
    assert.ok(localizeError('EDIT_WINDOW_CLOSED', {}, locale).includes('24'))
  }
})





