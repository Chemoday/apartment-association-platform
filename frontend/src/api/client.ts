import { ref } from 'vue'
import type { SessionResponse, ValidationErrorItem } from './schema.js'
import { isOfflineDemoMode, resolveOfflineDemoRequestLazy } from './offlineDemoState.js'

const STORAGE_KEY = 'demo_user_id'
const CSRF_HEADERS: Record<string, string> = { 'X-Requested-With': 'fetch' }
const REFRESH_EARLY_SECONDS = 60
const MIN_REFRESH_DELAY_MS = 10_000

export type SessionEndedReason = 'expired' | 'closed' | ''

export interface ApiErrorBody {
  error_code?: string
  message?: string
  trace_id?: string
  errors?: ValidationErrorItem[]
  retry_after_seconds?: number | null
  [key: string]: unknown
}

export interface ApiErrorLike {
  name?: string
  message?: string
  status?: number
  errorCode?: string
  retryAfterSeconds?: number | null
  isBackendUnavailable?: boolean
  payload?: ApiErrorBody | null
}

export function asApiErrorLike(err: unknown): ApiErrorLike {
  return err && typeof err === 'object' ? (err as ApiErrorLike) : {}
}

export interface ApiRequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  raw?: boolean
  signal?: AbortSignal
  noAuth?: boolean
}

export interface ApiUploadOptions {
  method?: string
  body?: Blob
  contentType?: string
  headers?: Record<string, string>
  onProgress?: (loaded: number, total: number) => void
  timeoutMs?: number
  signal?: AbortSignal
  noAuth?: boolean
}

function readStoredUser(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export const activeDemoUserId = ref<string>(readStoredUser())
export const lastTraceId = ref<string>('')

export function setDemoUser(userId: string): void {
  activeDemoUserId.value = userId
  try {
    if (userId) {
      localStorage.setItem(STORAGE_KEY, userId)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    /* private mode: keep in memory */
  }
}

export class ApiError extends Error {
  status: number
  errorCode: string
  payload: ApiErrorBody
  fieldErrors: ValidationErrorItem[]
  traceId: string
  isBackendUnavailable: boolean

  constructor(
    status: number,
    body?: ApiErrorBody | null,
    traceId: string = '',
    isBackendUnavailable: boolean = false,
  ) {
    super(body?.message || `HTTP ${status}`) // developer text only, never shown to users
    this.status = status
    this.errorCode = body?.error_code || `HTTP_${status}`
    this.payload = body || {} // extra fields, e.g. consumption_delta
    this.fieldErrors = body?.errors || [] // VALIDATION_ERROR: [{ loc, message, type }]
    this.traceId = body?.trace_id || traceId // show it on 500s
    const isAborted =
      body?.error_code === 'UPLOAD_ABORTED' || body?.error_code === 'REQUEST_ABORTED'
    this.isBackendUnavailable =
      !isAborted &&
      Boolean(
        isBackendUnavailable ||
          status === 0 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          body?.error_code === 'BACKEND_UNAVAILABLE',
      )
  }
}

// --- Session state (memory only — never exported or stored in web storage) ----------------------

let accessToken = ''
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<boolean> | null = null
let onSessionEnded: (reason: Exclude<SessionEndedReason, ''>) => void = () => {}

/** True while a Bearer token is held in memory. */
export const signedIn = ref<boolean>(false)
export const currentSessionId = ref<string>('')

/** Register callback invoked when a signed-in session ends on its own ('expired' | 'closed'). */
export function setSessionEndedHandler(
  handler: (reason: Exclude<SessionEndedReason, ''>) => void,
): void {
  onSessionEnded = handler
}

function isValidSessionPayload(session: unknown): session is SessionResponse {
  if (!session || typeof session !== 'object') return false
  const s = session as Partial<SessionResponse>
  return (
    typeof s.access_token === 'string' &&
    s.access_token.trim().length > 0 &&
    typeof s.expires_in === 'number' &&
    Number.isFinite(s.expires_in) &&
    s.expires_in > 0
  )
}

/** Store the result of a sign-in or token refresh and schedule proactive refresh. */
export function applySession(
  session: SessionResponse & { session_id?: string; user_id?: string },
): void {
  if (!isValidSessionPayload(session)) {
    clearSession()
    throw new ApiError(503, {
      error_code: 'INVALID_SESSION_RESPONSE',
      message: 'Session response is missing a valid access token or expiration.',
    })
  }
  accessToken = session.access_token
  currentSessionId.value = typeof session.session_id === 'string' ? session.session_id : ''
  signedIn.value = true
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
  }
  const rawDelay = (session.expires_in - REFRESH_EARLY_SECONDS) * 1000
  const delay = Number.isFinite(rawDelay)
    ? Math.max(rawDelay, MIN_REFRESH_DELAY_MS)
    : MIN_REFRESH_DELAY_MS
  refreshTimer = setTimeout(() => {
    refreshSession().catch(() => {})
  }, delay)
}

/** Forget the session locally (after logout or when the server ends it). */
export function clearSession(): void {
  accessToken = ''
  currentSessionId.value = ''
  signedIn.value = false
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

/**
 * Exchange the HttpOnly refresh cookie for a new access token (single-flight per tab).
 * Resolves true (signed in) or false (no session).
 */
export function refreshSession(): Promise<boolean> {
  if (isOfflineDemoMode.value) {
    return Promise.resolve(false)
  }
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          headers: CSRF_HEADERS,
        })
        if (response.ok) {
          let payload: unknown = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (!isValidSessionPayload(payload)) {
            clearSession()
            throw new ApiError(
              503,
              {
                error_code: 'INVALID_SESSION_RESPONSE',
                message: 'Invalid token refresh response from server.',
              },
              response.headers.get('X-Trace-Id') || '',
            )
          }
          applySession(payload)
          return true
        }
        if (response.status === 401) {
          const wasSignedIn = signedIn.value
          clearSession()
          if (wasSignedIn) onSessionEnded('expired')
          return false
        }
        throw new ApiError(response.status, null, response.headers.get('X-Trace-Id') || '')
      } finally {
        refreshInFlight = null
      }
    })()
  }
  return refreshInFlight
}

function isSimulatedOffline(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('simulate_offline') === '1') return true
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('simulate_backend_offline') === '1'
    }
  } catch {
    /* ignore */
  }
  return false
}

export function apiRequest<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return send(path, options, true) as Promise<T>
}

/**
 * Upload raw binary content (e.g., JPEG photo Blob) with upload progress tracking.
 * Uses XMLHttpRequest because fetch lacks upload progress events.
 */
export function apiUpload<T = unknown>(path: string, options: ApiUploadOptions = {}): Promise<T> {
  return sendUpload(path, options, true) as Promise<T>
}

function parseRetryAfterSeconds(headerVal: string | number | null | undefined): number | null {
  if (headerVal === null || headerVal === undefined) return null
  const trimmed = String(headerVal).trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    return Math.max(1, Number(trimmed))
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000))
  }
  return null
}

function normalizeHttpErrorBody(
  status: number,
  errorBody: ApiErrorBody | null,
  retryAfterHeader: string | null = null,
  { isUpload = false }: { isUpload?: boolean } = {},
): ApiErrorBody | null {
  if (isUpload && status === 408 && !errorBody?.error_code) {
    return {
      ...(errorBody || {}),
      error_code: 'UPLOAD_TIMEOUT',
      message: errorBody?.message || 'Upload timeout',
    }
  }
  if (status === 413 && !errorBody?.error_code) {
    return {
      ...(errorBody || {}),
      error_code: 'FILE_TOO_LARGE',
      message: errorBody?.message || 'File too large',
    }
  }
  if (status === 429) {
    const parsedRetry = parseRetryAfterSeconds(retryAfterHeader)
    const needsCode = !errorBody?.error_code
    const needsRetryAfter = errorBody?.retry_after_seconds == null && parsedRetry !== null
    if (needsCode || needsRetryAfter) {
      return {
        ...(errorBody || {}),
        error_code: errorBody?.error_code || 'RATE_LIMITED',
        message: errorBody?.message || 'Rate limited',
        ...(needsRetryAfter ? { retry_after_seconds: parsedRetry } : {}),
      }
    }
  }
  return errorBody
}

async function sendUpload(
  path: string,
  options: ApiUploadOptions,
  mayRetry: boolean,
): Promise<unknown> {
  const {
    method = 'POST',
    body,
    contentType = 'application/octet-stream',
    headers = {},
    onProgress,
    timeoutMs = 190000,
    signal,
    noAuth = false,
  } = options

  if (signal?.aborted) {
    throw new ApiError(0, { error_code: 'UPLOAD_ABORTED', message: 'Upload aborted' }, '', false)
  }

  if (isOfflineDemoMode.value) {
    if (typeof onProgress === 'function') {
      const total = body?.size || 1
      onProgress(Math.round(total * 0.5), total)
    }
    const res = await resolveOfflineDemoRequestLazy(path, {
      method,
      body,
      contentType,
      headers,
      signal,
      actingUserId: noAuth ? '' : activeDemoUserId.value,
    })
    if (signal?.aborted) {
      throw new ApiError(0, { error_code: 'UPLOAD_ABORTED', message: 'Upload aborted' }, '', false)
    }
    if (typeof onProgress === 'function') {
      const total = body?.size || 1
      onProgress(total, total)
    }
    return res
  }

  if (isSimulatedOffline()) {
    throw new ApiError(
      503,
      { error_code: 'BACKEND_UNAVAILABLE', message: 'Backend offline (simulated)' },
      '',
      true,
    )
  }

  const isAuthPath = path.startsWith('/auth/')
  const usedBearer = !noAuth && Boolean(accessToken)
  const usedDemo = !noAuth && !usedBearer && !isAuthPath && Boolean(activeDemoUserId.value)

  try {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open(method, `/api/v1${path}`)
      xhr.withCredentials = true
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        xhr.timeout = timeoutMs
      }

      if (contentType) {
        xhr.setRequestHeader('Content-Type', contentType)
      }
      if (usedBearer) {
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
      } else if (usedDemo) {
        xhr.setRequestHeader('X-Demo-User-Id', activeDemoUserId.value)
      }
      if (isAuthPath) {
        xhr.setRequestHeader('X-Requested-With', CSRF_HEADERS['X-Requested-With'])
      }
      const reservedHeaders = new Set([
        'content-length',
        'authorization',
        'x-demo-user-id',
        'x-requested-with',
        ...(contentType ? ['content-type'] : []),
      ])
      for (const [k, v] of Object.entries(headers || {})) {
        if (v !== undefined && v !== null && !reservedHeaders.has(k.toLowerCase())) {
          xhr.setRequestHeader(k, String(v))
        }
      }

      const handleAbortSignal = () => {
        try {
          xhr.abort()
        } catch {
          /* ignore */
        }
      }
      const cleanupSignal = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', handleAbortSignal)
        }
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', handleAbortSignal, { once: true })
      }

      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            onProgress(ev.loaded, ev.total)
          } else if (body?.size) {
            onProgress(Math.min(ev.loaded || 0, body.size), body.size)
          }
        }
      }

      xhr.onload = () => {
        cleanupSignal()
        const traceId = xhr.getResponseHeader('X-Trace-Id') || ''
        if (traceId) lastTraceId.value = traceId

        let parsedBody: ApiErrorBody | null = null
        if (xhr.responseText) {
          try {
            parsedBody = JSON.parse(xhr.responseText)
          } catch {
            parsedBody = null
          }
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          if (xhr.status === 204) {
            resolve(null)
            return
          }
          const respContentType = (xhr.getResponseHeader('Content-Type') || '').toLowerCase()
          if (respContentType.includes('text/html') || parsedBody === null) {
            reject(
              new ApiError(
                503,
                { error_code: 'BACKEND_UNAVAILABLE', message: 'Invalid JSON response from API' },
                traceId,
                true,
              ),
            )
            return
          }
          resolve(parsedBody)
          return
        }

        const isProxyGatewayDown =
          xhr.status === 502 ||
          xhr.status === 503 ||
          xhr.status === 504 ||
          (xhr.status === 500 && !parsedBody)
        const normalized = normalizeHttpErrorBody(
          xhr.status,
          parsedBody,
          xhr.getResponseHeader('Retry-After'),
          { isUpload: true },
        )
        reject(new ApiError(xhr.status, normalized, traceId, isProxyGatewayDown))
      }

      xhr.onerror = () => {
        cleanupSignal()
        reject(
          new ApiError(
            0,
            { error_code: 'BACKEND_UNAVAILABLE', message: 'Network Error' },
            '',
            true,
          ),
        )
      }

      xhr.ontimeout = () => {
        cleanupSignal()
        reject(
          new ApiError(
            408,
            { error_code: 'UPLOAD_TIMEOUT', message: 'Upload Timeout' },
            '',
            false,
          ),
        )
      }

      xhr.onabort = () => {
        cleanupSignal()
        reject(
          new ApiError(
            0,
            { error_code: 'UPLOAD_ABORTED', message: 'Upload aborted' },
            '',
            false,
          ),
        )
      }

      xhr.send(body || null)
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (usedBearer) {
        if (err.errorCode === 'INVALID_TOKEN' && mayRetry) {
          let refreshed = false
          let refreshRejected = false
          try {
            refreshed = await refreshSession()
            if (!refreshed) refreshRejected = true
          } catch {
            /* fall through */
          }
          if (refreshed) return sendUpload(path, options, false)
          if (refreshRejected && signedIn.value) {
            clearSession()
            onSessionEnded('expired')
          }
        } else if (err.errorCode === 'UNKNOWN_USER' || err.errorCode === 'INVALID_TOKEN') {
          clearSession()
          onSessionEnded(err.errorCode === 'UNKNOWN_USER' ? 'closed' : 'expired')
        }
      } else if (usedDemo) {
        setDemoUser('')
      }
    }
    throw err
  }
}

async function send(
  path: string,
  options: ApiRequestOptions,
  mayRetry: boolean,
): Promise<unknown> {
  const { method = 'GET', body, headers = {}, raw = false, signal, noAuth = false } = options

  if (signal?.aborted) {
    throw new ApiError(0, { error_code: 'REQUEST_ABORTED', message: 'Request aborted' }, '', false)
  }

  if (isOfflineDemoMode.value) {
    const result = await resolveOfflineDemoRequestLazy(path, {
      method,
      body,
      headers,
      raw,
      signal,
      actingUserId: noAuth ? '' : activeDemoUserId.value,
    })
    if (signal?.aborted) {
      throw new ApiError(0, { error_code: 'REQUEST_ABORTED', message: 'Request aborted' }, '', false)
    }
    return result
  }

  if (isSimulatedOffline()) {
    throw new ApiError(
      503,
      { error_code: 'BACKEND_UNAVAILABLE', message: 'Backend offline (simulated)' },
      '',
      true,
    )
  }

  const isAuthPath = path.startsWith('/auth/')
  const usedBearer = !noAuth && Boolean(accessToken)
  const usedDemo = !noAuth && !usedBearer && !isAuthPath && Boolean(activeDemoUserId.value)

  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(usedBearer ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(usedDemo ? { 'X-Demo-User-Id': activeDemoUserId.value } : {}),
        ...(isAuthPath ? CSRF_HEADERS : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err: unknown) {
    const errLike = asApiErrorLike(err)
    if (errLike.name === 'AbortError') {
      throw new ApiError(0, { error_code: 'REQUEST_ABORTED', message: 'Request aborted' }, '', false)
    }
    throw new ApiError(
      0,
      { error_code: 'BACKEND_UNAVAILABLE', message: errLike.message || 'Network Error' },
      '',
      true,
    )
  }

  const traceId = response.headers.get('X-Trace-Id') || ''
  if (traceId) lastTraceId.value = traceId

  if (!response.ok) {
    let errorBody: ApiErrorBody | null = null
    try {
      errorBody = (await response.json()) as ApiErrorBody
    } catch {
      /* non-JSON error */
    }
    const isProxyGatewayDown =
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504 ||
      (response.status === 500 && !errorBody)
    const normalizedBody = normalizeHttpErrorBody(
      response.status,
      errorBody,
      response.headers.get('Retry-After'),
    )
    const error = new ApiError(response.status, normalizedBody, traceId, isProxyGatewayDown)

    if (response.status === 401 && usedBearer) {
      if (error.errorCode === 'INVALID_TOKEN' && mayRetry) {
        let refreshed = false
        let refreshRejected = false
        try {
          refreshed = await refreshSession()
          if (!refreshed) refreshRejected = true
        } catch {
          /* network error: fall through and report the original 401 */
        }
        if (refreshed) return send(path, options, false)
        if (refreshRejected && signedIn.value) {
          clearSession()
          onSessionEnded('expired')
        }
      } else if (error.errorCode === 'UNKNOWN_USER' || error.errorCode === 'INVALID_TOKEN') {
        clearSession()
        onSessionEnded(error.errorCode === 'UNKNOWN_USER' ? 'closed' : 'expired')
      }
    } else if (response.status === 401 && usedDemo) {
      setDemoUser('')
    }
    throw error
  }

  if (response.status === 204) return null

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/html')) {
    throw new ApiError(
      503,
      { error_code: 'BACKEND_UNAVAILABLE', message: 'Received HTML fallback instead of API response' },
      traceId,
      true,
    )
  }

  if (raw) return response

  try {
    return await response.json()
  } catch {
    throw new ApiError(
      503,
      { error_code: 'BACKEND_UNAVAILABLE', message: 'Invalid JSON response from API' },
      traceId,
      true,
    )
  }
}
