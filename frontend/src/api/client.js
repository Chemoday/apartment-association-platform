import { ref } from 'vue'
import { isOfflineDemoMode, resolveOfflineDemoRequest } from './offlineDemoData.js'

const STORAGE_KEY = 'demo_user_id'
const CSRF_HEADERS = { 'X-Requested-With': 'fetch' }
const REFRESH_EARLY_SECONDS = 60
const MIN_REFRESH_DELAY_MS = 10_000

function readStoredUser() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export const activeDemoUserId = ref(readStoredUser())
export const lastTraceId = ref('')

export function setDemoUser(userId) {
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
  constructor(status, body, traceId, isBackendUnavailable = false) {
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
let refreshTimer = null
let refreshInFlight = null
let onSessionEnded = () => {}

/** True while a Bearer token is held in memory. */
export const signedIn = ref(false)
export const currentSessionId = ref('')

/** Register callback invoked when a signed-in session ends on its own ('expired' | 'closed'). */
export function setSessionEndedHandler(handler) {
  onSessionEnded = handler
}

/** Store the result of a sign-in or token refresh and schedule proactive refresh. */
export function applySession(session) {
  accessToken = session.access_token
  currentSessionId.value = session.session_id
  signedIn.value = true
  clearTimeout(refreshTimer)
  const delay = Math.max((session.expires_in - REFRESH_EARLY_SECONDS) * 1000, MIN_REFRESH_DELAY_MS)
  refreshTimer = setTimeout(() => {
    refreshSession().catch(() => {})
  }, delay)
}

/** Forget the session locally (after logout or when the server ends it). */
export function clearSession() {
  accessToken = ''
  currentSessionId.value = ''
  signedIn.value = false
  clearTimeout(refreshTimer)
  refreshTimer = null
}

/**
 * Exchange the HttpOnly refresh cookie for a new access token (single-flight per tab).
 * Resolves true (signed in) or false (no session).
 */
export function refreshSession() {
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
          applySession(await response.json())
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

function isSimulatedOffline() {
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

export function apiRequest(path, options = {}) {
  return send(path, options, true)
}

/**
 * Upload raw binary content (e.g., JPEG photo Blob) with upload progress tracking.
 * Uses XMLHttpRequest because fetch lacks upload progress events.
 * @param {string} path
 * @param {{
 *   method?: string,
 *   body: Blob,
 *   contentType?: string,
 *   headers?: Record<string, string>,
 *   onProgress?: (loaded: number, total: number) => void,
 *   noAuth?: boolean,
 * }} options
 */
export function apiUpload(path, options = {}) {
  return sendUpload(path, options, true)
}

function parseRetryAfterSeconds(headerVal) {
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
  status,
  errorBody,
  retryAfterHeader = null,
  { isUpload = false } = {},
) {
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

async function sendUpload(path, options, mayRetry) {
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
    const res = await resolveOfflineDemoRequest(path, {
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

        let parsedBody = null
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

      xhr.send(body)
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

async function send(path, options, mayRetry) {
  const { method = 'GET', body, headers = {}, raw = false, signal, noAuth = false } = options

  if (signal?.aborted) {
    throw new ApiError(0, { error_code: 'REQUEST_ABORTED', message: 'Request aborted' }, '', false)
  }

  if (isOfflineDemoMode.value) {
    const result = await resolveOfflineDemoRequest(path, {
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

  let response
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
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ApiError(0, { error_code: 'REQUEST_ABORTED', message: 'Request aborted' }, '', false)
    }
    throw new ApiError(
      0,
      { error_code: 'BACKEND_UNAVAILABLE', message: err?.message || 'Network Error' },
      '',
      true,
    )
  }

  const traceId = response.headers.get('X-Trace-Id') || ''
  if (traceId) lastTraceId.value = traceId

  if (!response.ok) {
    let errorBody = null
    try {
      errorBody = await response.json()
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
