const PRELOAD_RELOAD_KEY = 'hoa_vite_preload_reload_ts'
const PRELOAD_RELOAD_COOLDOWN_MS = 60_000

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set_cookie',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'email',
  'email_address',
  'phone',
  'phone_number',
  'body',
  'raw_body',
  'payload',
  'headers',
  'raw',
  'personal_code',
  'full_name',
])

const BEARER_RE = /\bBearer\s+[^\s'",;)}\]]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const URL_QUERY_HASH_RE = /(https?:\/\/[^\s?#]+|\/[A-Za-z0-9/._~%:@+-]+)[?#][^\s'")}\]]*/g
const SENSITIVE_PARAM_RE =
  /([?#&](?:token|access_token|refresh_token|code|key|auth|secret|sig|signature|email|password)=)[^&#\s'")}\]]+/gi
const LONG_SECRET_RE = /\b(?:tok|key|sec|sess|auth)_[A-Za-z0-9_-]{12,}\b/gi

export interface TelemetryEvent {
  timestamp: string
  appVersion: string
  source: string
  routeName: string
  traceId: string
  errorCode: string
  error: {
    name: string
    message: string
  }
  extra: unknown
}

export type TelemetrySink = ((event: TelemetryEvent) => void) | null

let telemetrySink: TelemetrySink = null

function normalizeKeyName(key: string): string {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/**
 * Scrub PII, credentials, tokens, emails, and URL query/hash fragments from arbitrary text.
 */
export function scrubPiiString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(LONG_SECRET_RE, '[REDACTED_TOKEN]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(URL_QUERY_HASH_RE, '$1[REDACTED_PARAMS]')
    .replace(SENSITIVE_PARAM_RE, '$1[REDACTED]')
}

/**
 * Recursively sanitize an arbitrary diagnostic context object (safe against circular references).
 */
export function scrubPii(input: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return scrubPiiString(input)
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (input instanceof Error) {
    return {
      name: scrubPiiString(input.name || 'Error'),
      message: scrubPiiString(input.message || ''),
    }
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return scrubPiiString(input.toString())
  }
  if (typeof input !== 'object') return scrubPiiString(input)
  if (seen.has(input)) return '[Circular]'
  seen.add(input)

  if (Array.isArray(input)) {
    return input.slice(0, 20).map((item) => scrubPii(item, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    const normalized = normalizeKeyName(key)
    if (
      SENSITIVE_KEYS.has(normalized) ||
      normalized.includes('token') ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('cookie')
    ) {
      out[key] = '[REDACTED]'
      continue
    }
    out[key] = scrubPii(val, seen)
  }
  return out
}

/**
 * Register a custom telemetry sink (e.g. Sentry / OpenTelemetry exporter).
 * Pass `null` to restore default no-op sink.
 */
export function setTelemetrySink(sink: TelemetrySink): void {
  telemetrySink = typeof sink === 'function' ? sink : null
}

/**
 * Resolve build version identifier safely without leaking environment secrets.
 */
export function getAppBuildVersion(): string {
  try {
    const env =
      typeof import.meta !== 'undefined'
        ? (import.meta as unknown as { env?: Record<string, unknown> }).env
        : null
    return String(env?.VITE_APP_VERSION || env?.MODE || '0.1.0')
  } catch {
    return '0.1.0'
  }
}

/**
 * Emit a PII-scrubbed diagnostic event to the configured telemetry sink.
 * Never throws, even if the sink fails.
 */
export function reportError(error: unknown, context: Record<string, unknown> = {}): TelemetryEvent {
  const errObj =
    error instanceof Error
      ? {
          name: scrubPiiString(error.name || 'Error'),
          message: scrubPiiString(error.message || ''),
        }
      : {
          name: 'Error',
          message: scrubPiiString(error),
        }

  const extractedCode =
    error && typeof error === 'object' && 'errorCode' in error
      ? (error as { errorCode?: unknown }).errorCode
      : ''

  const event: TelemetryEvent = {
    timestamp: new Date().toISOString(),
    appVersion: getAppBuildVersion(),
    source: scrubPiiString(context?.source || 'runtime'),
    routeName: scrubPiiString(context?.routeName || ''),
    traceId: scrubPiiString(context?.traceId || ''),
    errorCode: scrubPiiString(context?.errorCode || extractedCode || ''),
    error: errObj,
    extra: scrubPii(context?.extra || {}),
  }

  if (telemetrySink) {
    try {
      telemetrySink(event)
    } catch {
      /* telemetry must never crash the app */
    }
  }

  return event
}

export interface DiagnosticReportInfo {
  traceId?: string
  errorCode?: string
  routeName?: string
  appVersion?: string
  timestamp?: string
}

/**
 * Build a plain-text, PII-free diagnostic summary for user support tickets.
 * Contains ONLY technical metadata (app version, route, error code, trace ID, UTC timestamp).
 */
export function buildDiagnosticReport(info: DiagnosticReportInfo = {}): string {
  const lines = [
    `App: apartment-association-platform-frontend (${scrubPiiString(info.appVersion || getAppBuildVersion())})`,
    `Time (UTC): ${scrubPiiString(info.timestamp || new Date().toISOString())}`,
  ]
  if (info.routeName) {
    lines.push(`Route: ${scrubPiiString(info.routeName)}`)
  }
  if (info.errorCode) {
    lines.push(`Error code: ${scrubPiiString(info.errorCode)}`)
  }
  if (info.traceId) {
    lines.push(`Trace ID: ${scrubPiiString(info.traceId)}`)
  }
  return lines.join('\n')
}

export interface VitePreloadErrorDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  reload?: () => void
  now?: () => number
  cooldownMs?: number
}

/**
 * Handle Vite dynamic-import preload errors after a fresh deployment with a
 * single-reload cooldown guard in sessionStorage so an outage never loops infinitely.
 */
export function handleVitePreloadError(
  event?: Event | { preventDefault?: () => void } | null,
  deps: VitePreloadErrorDeps = {},
): boolean {
  const nowFn = deps.now || (() => Date.now())
  const cooldownMs = deps.cooldownMs ?? PRELOAD_RELOAD_COOLDOWN_MS
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null
  const reload =
    deps.reload ||
    (() => {
      if (typeof window !== 'undefined' && window.location?.reload) {
        window.location.reload()
      }
    })

  const nowMs = nowFn()
  try {
    const rawLast = storage?.getItem(PRELOAD_RELOAD_KEY)
    const lastMs = rawLast ? Number(rawLast) : 0
    if (Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs < cooldownMs) {
      reportError(new Error('Chunk preload failed within reload cooldown window'), {
        source: 'vite:preloadError',
      })
      return false
    }
    storage?.setItem(PRELOAD_RELOAD_KEY, String(nowMs))
  } catch {
    /* private mode: still attempt a single safe reload */
  }

  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault()
  }
  reload()
  return true
}
