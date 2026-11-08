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
    this.isBackendUnavailable = Boolean(
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

async function send(path, options, mayRetry) {
  const { method = 'GET', body, headers = {}, raw = false, noAuth = false } = options

  if (isOfflineDemoMode.value) {
    return resolveOfflineDemoRequest(path, {
      method,
      body,
      raw,
      actingUserId: noAuth ? '' : activeDemoUserId.value,
    })
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
    const error = new ApiError(response.status, errorBody, traceId, isProxyGatewayDown)

    if (response.status === 401 && usedBearer) {
      if (error.errorCode === 'INVALID_TOKEN' && mayRetry) {
        let refreshed = false
        try {
          refreshed = await refreshSession()
        } catch {
          /* network error: fall through and report the original 401 */
        }
        if (refreshed) return send(path, options, false)
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
  if (raw) return response

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new ApiError(
      503,
      { error_code: 'BACKEND_UNAVAILABLE', message: 'Received HTML fallback instead of API JSON' },
      traceId,
      true,
    )
  }

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
