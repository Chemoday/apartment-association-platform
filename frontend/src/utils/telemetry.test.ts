import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDiagnosticReport,
  handleVitePreloadError,
  reportError,
  scrubPii,
  scrubPiiString,
  setTelemetrySink,
} from './telemetry.js'
import { i18n } from '../locales/index.js'

test('scrubPiiString redacts Bearer tokens, JWTs, emails, secret tokens, and URL params (#047)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.signaturepart12345'
  const raw = `Auth Bearer secret_abc.123 failed for mari.tamm@example.ee on https://app.example.ee/login/link#token=abc&next=/readings with ${jwt} and tok_abcdef123456789`
  const scrubbed = scrubPiiString(raw)

  assert.equal(scrubbed.includes('secret_abc'), false)
  assert.equal(scrubbed.includes('mari.tamm@example.ee'), false)
  assert.equal(scrubbed.includes('token=abc'), false)
  assert.equal(scrubbed.includes('eyJhbGciOiJIUzI1NiJ9'), false)
  assert.equal(scrubbed.includes('tok_abcdef123456789'), false)
  assert.ok(scrubbed.includes('Bearer [REDACTED]'))
  assert.ok(scrubbed.includes('[REDACTED_EMAIL]'))
  assert.ok(scrubbed.includes('[REDACTED_JWT]'))
  assert.ok(scrubbed.includes('[REDACTED_PARAMS]'))

  // Relative paths containing dots/extensions (/index.html#token=..., /files/doc.pdf?signature=...)
  const relativeWithDot = scrubPiiString(
    'Failed at /index.html#token=magic_link_secret_999 and /files/report.pdf?signature=sig_12345',
  )
  assert.equal(relativeWithDot.includes('magic_link_secret_999'), false)
  assert.equal(relativeWithDot.includes('sig_12345'), false)
  assert.ok(relativeWithDot.includes('/index.html[REDACTED_PARAMS]'))
  assert.ok(relativeWithDot.includes('/files/report.pdf[REDACTED_PARAMS]'))
})

test('scrubPii redacts sensitive object keys (including camelCase) and survives circular references (#047)', () => {
  const circular: Record<string, unknown> = {
    route: '/readings',
    authorization: 'Bearer xyz',
    access_token: 'tok-123',
    accessToken: 'camel-tok-456',
    personalCode: '38501010000',
    fullName: 'Mari Tamm',
    rawBody: 'private message body',
    setCookie: 'session=abc',
    password: 'super-secret-password',
    email: 'owner@example.ee',
    emailAddress: 'camel@example.ee',
    payload: { rawBody: 'private message' },
    nested: { detail: 'Contact admin@example.ee for help' },
  }
  circular.self = circular

  const cleaned = scrubPii(circular) as Record<string, any>
  assert.equal(cleaned.route, '/readings')
  assert.equal(cleaned.authorization, '[REDACTED]')
  assert.equal(cleaned.access_token, '[REDACTED]')
  assert.equal(cleaned.accessToken, '[REDACTED]')
  assert.equal(cleaned.personalCode, '[REDACTED]')
  assert.equal(cleaned.fullName, '[REDACTED]')
  assert.equal(cleaned.rawBody, '[REDACTED]')
  assert.equal(cleaned.setCookie, '[REDACTED]')
  assert.equal(cleaned.password, '[REDACTED]')
  assert.equal(cleaned.email, '[REDACTED]')
  assert.equal(cleaned.emailAddress, '[REDACTED]')
  assert.equal(cleaned.payload, '[REDACTED]')
  assert.equal(cleaned.nested.detail, 'Contact [REDACTED_EMAIL] for help')
  assert.equal(cleaned.self, '[Circular]')
})

test('reportError emits sanitized payload to custom sink and never throws when sink fails (#047)', () => {
  const events: Array<Record<string, any>> = []
  setTelemetrySink((evt) => {
    events.push(evt)
  })

  try {
    const emitted = reportError(new Error('Failed for user@example.ee with Bearer abc.123'), {
      source: 'errorBoundary',
      routeName: 'readings',
      traceId: 'trace-42',
      extra: { token: 'should-be-redacted', lifecycleHook: 'render' },
    })

    assert.equal(events.length, 1)
    assert.equal(emitted.source, 'errorBoundary')
    assert.equal(emitted.routeName, 'readings')
    assert.equal(emitted.traceId, 'trace-42')
    assert.equal(emitted.error.message.includes('user@example.ee'), false)
    assert.equal(emitted.error.message.includes('abc.123'), false)
    assert.equal((emitted.extra as Record<string, any>).token, '[REDACTED]')
    assert.equal((emitted.extra as Record<string, any>).lifecycleHook, 'render')

    setTelemetrySink(() => {
      throw new Error('sink crash')
    })
    assert.doesNotThrow(() => reportError(new Error('boom')))
  } finally {
    setTelemetrySink(null)
  }
})

test('handleVitePreloadError triggers single reload and prevents infinite reload loops within cooldown (#047)', () => {
  const store = new Map<string, string>()
  const fakeStorage = {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, val: string) {
      store.set(key, val)
    },
  } as unknown as Storage

  let nowMs = 1_700_000_000_000
  let reloadCount = 0
  let preventedCount = 0
  const fakeEvent = {
    preventDefault() {
      preventedCount += 1
    },
  }

  // First preload error triggers reload
  const first = handleVitePreloadError(fakeEvent, {
    storage: fakeStorage,
    reload: () => {
      reloadCount += 1
    },
    now: () => nowMs,
    cooldownMs: 60_000,
  })
  assert.equal(first, true)
  assert.equal(reloadCount, 1)
  assert.equal(preventedCount, 1)

  // Immediate repeat inside cooldown is suppressed (no infinite reload loop)
  nowMs += 5_000
  const second = handleVitePreloadError(fakeEvent, {
    storage: fakeStorage,
    reload: () => {
      reloadCount += 1
    },
    now: () => nowMs,
    cooldownMs: 60_000,
  })
  assert.equal(second, false)
  assert.equal(reloadCount, 1)
  assert.equal(preventedCount, 1)

  // After cooldown expires, a fresh deploy can reload once again
  nowMs += 61_000
  const third = handleVitePreloadError(fakeEvent, {
    storage: fakeStorage,
    reload: () => {
      reloadCount += 1
    },
    now: () => nowMs,
    cooldownMs: 60_000,
  })
  assert.equal(third, true)
  assert.equal(reloadCount, 2)
  assert.equal(preventedCount, 2)
})

test('buildDiagnosticReport includes only technical metadata and errorBoundary copy exists in en, et, ru (#047)', () => {
  const report = buildDiagnosticReport({
    traceId: 'req-9988',
    errorCode: 'INTERNAL_SERVER_ERROR',
    routeName: 'accounting',
    appVersion: '0.1.0',
    timestamp: '2026-11-21T12:00:00.000Z',
  })

  assert.ok(report.includes('req-9988'))
  assert.ok(report.includes('INTERNAL_SERVER_ERROR'))
  assert.ok(report.includes('accounting'))
  assert.ok(report.includes('2026-11-21T12:00:00.000Z'))

  for (const locale of ['en', 'et', 'ru'] as const) {
    assert.ok(i18n.global.t('errorBoundary.title', {}, { locale }).length > 3)
    assert.ok(i18n.global.t('errorBoundary.description', {}, { locale }).length > 10)
    assert.ok(i18n.global.t('errorBoundary.tryAgain', {}, { locale }).length > 2)
    assert.ok(i18n.global.t('errorBoundary.reloadPage', {}, { locale }).length > 2)
    assert.ok(i18n.global.t('common.copyDiagnostics', {}, { locale }).length > 2)
    assert.ok(i18n.global.t('common.copied', {}, { locale }).length > 2)
  }
})
