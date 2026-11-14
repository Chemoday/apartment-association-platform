import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  apiRequest,
  apiUpload,
  applySession,
  clearSession,
  refreshSession,
  setDemoUser,
  setSessionEndedHandler,
  signedIn,
} from './client.js'
import {
  deleteIssuePhoto,
  fetchIssuePhotoBlob,
  uploadIssuePhoto,
} from './endpoints/issues.js'
import {
  deleteDocument,
  downloadDocumentFile,
  editDocument,
  getDocumentUploadOptions,
  listDocuments,
  uploadDocument,
} from './endpoints/documents.js'
import { getFileUsage } from './endpoints/files.js'
import { disableOfflineDemo, enableOfflineDemo } from './offlineDemoData.js'
import {
  closeAccount,
  endMembership,
  getPasswordStatus,
  listPeople,
  passwordLogin,
  removePassword,
  setPassword,
  setRole,
} from './endpoints/auth.js'
import {
  createInvitation,
  deleteInvitation,
  getResidents,
  listInvitations,
  removeTenant,
  replaceTenant,
  resendInvitation,
} from './endpoints/invitations.js'
import { unsubscribeByToken } from './endpoints/notifications.js'
import { getApartmentCard, listApartments } from './endpoints/property.js'
import { getApartmentReadings } from './endpoints/meters.js'
import {
  createApartmentThread,
  createBoardTopic,
  listApartmentThreads,
  listBoardTopics,
} from './endpoints/communication.js'

function mockJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body !== null ? JSON.stringify(body) : null, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

test('client attaches Authorization Bearer when signed in and omits X-Demo-User-Id', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return mockJsonResponse(200, { ok: true })
  }

  try {
    setDemoUser('00000000-0000-0000-0000-000000000101')
    applySession({
      access_token: 'jwt-secret-token',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-1',
      user_id: 'user-1',
    })

    assert.equal(signedIn.value, true)
    await apiRequest('/property/me')

    assert.equal(calls.length, 1)
    const headers = calls[0].init?.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer jwt-secret-token')
    assert.equal(headers['X-Demo-User-Id'], undefined)
  } finally {
    clearSession()
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('client attaches X-Demo-User-Id in demo mode and X-Requested-With on /auth/* routes', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return mockJsonResponse(200, { ok: true })
  }

  try {
    clearSession()
    setDemoUser('demo-user-1')

    await apiRequest('/property/me')
    const propHeaders = calls[0].init?.headers as Record<string, string>
    assert.equal(propHeaders['X-Demo-User-Id'], 'demo-user-1')
    assert.equal(propHeaders.Authorization, undefined)

    await apiRequest('/auth/magic-link/request', {
      method: 'POST',
      body: { email: 'user@example.com' },
    })
    const authHeaders = calls[1].init?.headers as Record<string, string>
    assert.equal(authHeaders['X-Requested-With'], 'fetch')
    assert.equal(authHeaders['X-Demo-User-Id'], undefined)
  } finally {
    clearSession()
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('client performs single-flight refresh and retries once on 401 INVALID_TOKEN', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const headers = (init?.headers || {}) as Record<string, string>

    if (url === '/api/v1/auth/refresh') {
      return mockJsonResponse(200, {
        access_token: 'fresh-jwt',
        token_type: 'Bearer',
        expires_in: 900,
        session_id: 'sess-1',
        user_id: 'user-1',
      })
    }

    if (headers.Authorization === 'Bearer expired-jwt') {
      return mockJsonResponse(401, {
        error_code: 'INVALID_TOKEN',
        message: 'Expired token',
      })
    }

    return mockJsonResponse(200, { recovered: true })
  }

  try {
    applySession({
      access_token: 'expired-jwt',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-1',
      user_id: 'user-1',
    })

    const res = await apiRequest('/notifications/unread-count')
    assert.deepEqual(res, { recovered: true })
    assert.deepEqual(calls, [
      '/api/v1/notifications/unread-count',
      '/api/v1/auth/refresh',
      '/api/v1/notifications/unread-count',
    ])
  } finally {
    clearSession()
    globalThis.fetch = originalFetch
  }
})

test('concurrent refreshSession calls share a single /auth/refresh request and notify onSessionEnded on 401', async () => {
  const originalFetch = globalThis.fetch
  let refreshFetchCount = 0
  let endedReason = ''

  globalThis.fetch = async () => {
    refreshFetchCount += 1
    return mockJsonResponse(401, {
      error_code: 'SESSION_EXPIRED',
      message: 'Refresh expired',
    })
  }

  try {
    applySession({
      access_token: 'initial-jwt',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-1',
      user_id: 'user-1',
    })
    setSessionEndedHandler((reason: string) => {
      endedReason = reason
    })

    const [r1, r2] = await Promise.all([refreshSession(), refreshSession()])
    assert.equal(r1, false)
    assert.equal(r2, false)
    assert.equal(refreshFetchCount, 1)
    assert.equal(signedIn.value, false)
    assert.equal(endedReason, 'expired')
  } finally {
    setSessionEndedHandler(() => {})
    clearSession()
    globalThis.fetch = originalFetch
  }
})

test('A4 and A5 endpoint helpers call exact API contract routes and methods', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const headers = (init?.headers || {}) as Record<string, string>
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(input), method, body, headers })
    if (method === 'DELETE' && !String(input).includes('/memberships/')) {
      return new Response(null, { status: 204 })
    }
    return mockJsonResponse(200, { ok: true })
  }

  try {
    applySession({
      access_token: 'jwt-a4-a5',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-a4',
      user_id: 'user-a4',
    })

    await passwordLogin({ email: 'user@example.com', password: 'demo-password-ok' })
    await getPasswordStatus()
    await setPassword({ new_password: 'new-phrase-15chars' })
    await removePassword({ current_password: 'new-phrase-15chars' })

    await listPeople()
    await setRole('user-102', { building_role: 'BOARD' })
    await endMembership('user-102', 'mem-214')
    await closeAccount('user-102')

    await createInvitation({ kind: 'TENANT', email: 't@example.com', apartment_id: 'apt-14' })
    await createInvitation({ kind: 'OWNER', email: 'o@example.com', apartment_number: '14' })
    await createInvitation({ kind: 'STAFF', email: 's@example.com', building_role: 'BOARD' })
    await listInvitations()
    await resendInvitation('inv-301')
    await deleteInvitation('inv-301')
    await getResidents('apt-14')
    await removeTenant('apt-14', 'user-104')
    await replaceTenant('apt-14', 'user-104', { email: 'new@example.com' })

    assert.equal(calls.length, 17)
    assert.equal(calls[0].url, '/api/v1/auth/password/login')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[1].url, '/api/v1/auth/password')
    assert.equal(calls[1].method, 'GET')
    assert.equal(calls[2].url, '/api/v1/auth/password')
    assert.equal(calls[2].method, 'PUT')
    assert.equal(calls[3].url, '/api/v1/auth/password')
    assert.equal(calls[3].method, 'DELETE')

    assert.equal(calls[4].url, '/api/v1/auth/users')
    assert.equal(calls[4].method, 'GET')
    assert.equal(calls[5].url, '/api/v1/auth/users/user-102/role')
    assert.equal(calls[5].method, 'PUT')
    assert.equal(calls[6].url, '/api/v1/auth/users/user-102/memberships/mem-214')
    assert.equal(calls[6].method, 'DELETE')
    assert.equal(calls[7].url, '/api/v1/auth/users/user-102')
    assert.equal(calls[7].method, 'DELETE')

    assert.equal(calls[8].url, '/api/v1/auth/invitations')
    assert.equal(calls[8].method, 'POST')
    assert.deepEqual(calls[8].body, {
      kind: 'TENANT',
      email: 't@example.com',
      apartment_id: 'apt-14',
    })
    assert.deepEqual(calls[9].body, {
      kind: 'OWNER',
      email: 'o@example.com',
      apartment_number: '14',
    })
    assert.deepEqual(calls[10].body, {
      kind: 'STAFF',
      email: 's@example.com',
      building_role: 'BOARD',
    })
    assert.equal(calls[11].url, '/api/v1/auth/invitations')
    assert.equal(calls[11].method, 'GET')
    assert.equal(calls[12].url, '/api/v1/auth/invitations/inv-301/resend')
    assert.equal(calls[12].method, 'POST')
    assert.equal(calls[13].url, '/api/v1/auth/invitations/inv-301')
    assert.equal(calls[13].method, 'DELETE')
    assert.equal(calls[14].url, '/api/v1/auth/apartments/apt-14/residents')
    assert.equal(calls[14].method, 'GET')
    assert.equal(calls[15].url, '/api/v1/auth/apartments/apt-14/tenants/user-104')
    assert.equal(calls[15].method, 'DELETE')
    assert.equal(calls[16].url, '/api/v1/auth/apartments/apt-14/tenants/user-104/replace')
    assert.equal(calls[16].method, 'POST')

    for (const c of calls) {
      assert.equal(c.headers['X-Requested-With'], 'fetch')
      assert.equal(c.headers['X-Demo-User-Id'], undefined)
    }
  } finally {
    clearSession()
    globalThis.fetch = originalFetch
  }
})

test('privacy and contract audit: views have no client-side tenant counting, email masking, or legacy field names', () => {
  const profileView = fs.readFileSync(
    path.resolve(process.cwd(), 'src/views/settings/ProfileView.vue'),
    'utf-8',
  )
  const peopleView = fs.readFileSync(
    path.resolve(process.cwd(), 'src/views/people/PeopleView.vue'),
    'utf-8',
  )
  const securityView = fs.readFileSync(
    path.resolve(process.cwd(), 'src/views/settings/SecurityView.vue'),
    'utf-8',
  )

  for (const content of [profileView, peopleView, securityView]) {
    assert.equal(content.includes('MAX_TENANTS'), false)
    assert.equal(content.includes('countTenantsAndPending'), false)
    assert.equal(content.includes('maskContactInput'), false)
    assert.equal(content.includes('masked_target'), false)
    assert.equal(content.includes('invited_label'), false)
    assert.equal(content.includes('localStorage'), false)
    assert.equal(content.includes('sessionStorage'), false)
  }
})

test('N8 unsubscribeByToken calls POST /api/v1/notifications/unsubscribe?token=... without auth, demo, or CSRF headers', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const headers = (init?.headers || {}) as Record<string, string>
    calls.push({ url: String(input), method, body: init?.body, headers })
    return mockJsonResponse(200, { event_type: 'READING_DEADLINE', channel: 'email' })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000101')
    applySession({
      access_token: 'jwt-should-not-be-sent',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-unsub',
    })

    const res = await unsubscribeByToken('demo-reading-token')
    assert.deepEqual(res, { event_type: 'READING_DEADLINE', channel: 'email' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/v1/notifications/unsubscribe?token=demo-reading-token')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body, undefined)
    assert.equal(calls[0].headers.Authorization, undefined)
    assert.equal(calls[0].headers['X-Demo-User-Id'], undefined)
    assert.equal(calls[0].headers['X-Requested-With'], undefined)
  } finally {
    clearSession()
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('E8/P1 apartment card and reading endpoints call exact routes and views keep area_m2 and meter values as strings', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method || 'GET').toUpperCase() })
    return mockJsonResponse(200, { ok: true })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000101')
    await listApartments()
    await getApartmentCard('apt-14')
    await getApartmentReadings('apt-14')

    assert.equal(calls.length, 3)
    assert.deepEqual(calls[0], { url: '/api/v1/property/apartments', method: 'GET' })
    assert.deepEqual(calls[1], { url: '/api/v1/property/apartments/apt-14', method: 'GET' })
    assert.deepEqual(calls[2], { url: '/api/v1/meters/apartments/apt-14/readings', method: 'GET' })
  } finally {
    setDemoUser('')
    globalThis.fetch = originalFetch
  }

  const apartmentsView = fs.readFileSync(
    path.resolve(process.cwd(), 'src/views/apartments/ApartmentsView.vue'),
    'utf-8',
  )
  const apartmentCardView = fs.readFileSync(
    path.resolve(process.cwd(), 'src/views/apartments/ApartmentCardView.vue'),
    'utf-8',
  )
  for (const content of [apartmentsView, apartmentCardView]) {
    assert.equal(content.includes('parseFloat'), false)
    assert.equal(content.includes('full_name'), false)
  }
})

test('E8/P2 apartment threads list and create endpoints use exact query params and omit author_apartment_id', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method || 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return mockJsonResponse(200, { id: 'thread-1' })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    await listApartmentThreads()
    await listApartmentThreads({ apartment_id: 'apt-14' })
    await createApartmentThread({
      apartmentId: 'apt-14',
      title: 'Water meter inspection',
      body: 'Thursday at 18:00 works for us.',
    })

    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, '/api/v1/communication/posts?post_type=APARTMENT_THREAD')
    assert.equal(calls[0].method, 'GET')
    assert.equal(
      calls[1].url,
      '/api/v1/communication/posts?post_type=APARTMENT_THREAD&apartment_id=apt-14',
    )
    assert.equal(calls[1].method, 'GET')
    assert.equal(calls[2].url, '/api/v1/communication/posts')
    assert.equal(calls[2].method, 'POST')
    assert.deepEqual(calls[2].body, {
      post_type: 'APARTMENT_THREAD',
      category: 'GENERAL',
      title: 'Water meter inspection',
      body: 'Thursday at 18:00 works for us.',
      target_scope: 'APARTMENT_LIST',
      target_apartment_ids: ['apt-14'],
      comments_enabled: true,
    })
    assert.equal('author_apartment_id' in (calls[2].body || {}), false)
  } finally {
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('E8/P4 board micro-forum list and create endpoints use post_type=BOARD_TOPIC and omit target fields and author_apartment_id', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; body: any }> = []

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: (init?.method || 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return mockJsonResponse(200, { id: 'board-topic-1' })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000101')
    await listBoardTopics()
    await createBoardTopic({
      title: 'Where the keys to the basement and the roof are',
      body: 'Stored in Entrance 1 utility room.',
    })

    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, '/api/v1/communication/posts?post_type=BOARD_TOPIC')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[1].url, '/api/v1/communication/posts')
    assert.equal(calls[1].method, 'POST')
    assert.deepEqual(calls[1].body, {
      post_type: 'BOARD_TOPIC',
      category: 'GENERAL',
      title: 'Where the keys to the basement and the roof are',
      body: 'Stored in Entrance 1 utility room.',
      comments_enabled: true,
    })
    assert.equal('author_apartment_id' in (calls[1].body || {}), false)
    assert.equal('target_scope' in (calls[1].body || {}), false)
    assert.equal('target_apartment_ids' in (calls[1].body || {}), false)
  } finally {
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('client normalizes bare 413 HTML/text response to FILE_TOO_LARGE with isBackendUnavailable=false (while 503 is true)', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/too-big')) {
      return new Response('<html><body><h1>413 Request Entity Too Large</h1></body></html>', {
        status: 413,
        headers: { 'content-type': 'text/html' },
      })
    }
    return new Response('Service Unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000102')

    await assert.rejects(
      () => apiRequest('/issues/abc/too-big', { method: 'POST' }),
      (err: any) =>
        err?.status === 413 &&
        err?.errorCode === 'FILE_TOO_LARGE' &&
        err?.isBackendUnavailable === false,
    )

    await assert.rejects(
      () => apiRequest('/issues/abc/down', { method: 'GET' }),
      (err: any) => err?.status === 503 && err?.isBackendUnavailable === true,
    )
  } finally {
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})

test('apiUpload and issue photo endpoints send JPEG body, Idempotency-Key, progress, auth, and handle 401 refresh & DELETE', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = (globalThis as any).XMLHttpRequest
  const xhrRequests: any[] = []
  const fetchCalls: any[] = []

  class MockXHR {
    status = 0
    responseText = ''
    upload: { onprogress?: (evt: any) => void } = {}
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    method = ''
    url = ''
    headers: Record<string, string> = {}

    open(method: string, url: string) {
      this.method = method
      this.url = url
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    getResponseHeader(name: string) {
      if (name.toLowerCase() === 'content-type') return 'application/json'
      return ''
    }
    send(body: any) {
      xhrRequests.push({
        method: this.method,
        url: this.url,
        headers: { ...this.headers },
        body,
      })

      if (this.headers.Authorization === 'Bearer expired-token') {
        this.status = 401
        this.responseText = JSON.stringify({ error_code: 'INVALID_TOKEN', message: 'Expired' })
        this.onload?.()
        return
      }

      if (this.headers['Idempotency-Key'] === 'bare-413-key') {
        this.status = 413
        this.responseText = '413 Payload Too Large'
        this.onload?.()
        return
      }

      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 })
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 })
      this.status = 201
      this.responseText = JSON.stringify({
        id: 'photo-1',
        mine: true,
        can_delete: true,
        created_at: '2026-11-10T10:00:00Z',
      })
      this.onload?.()
    }
  }

  ;(globalThis as any).XMLHttpRequest = MockXHR
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, method: init?.method || 'GET', headers: init?.headers || {} })
    if (url === '/api/v1/auth/refresh') {
      return mockJsonResponse(200, {
        access_token: 'fresh-token',
        token_type: 'Bearer',
        expires_in: 900,
        session_id: 'sess-1',
        user_id: 'user-1',
      })
    }
    if (url.includes('/photos/photo-1?variant=thumb')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return mockJsonResponse(204, null)
  }

  try {
    applySession({
      access_token: 'expired-token',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-1',
      user_id: 'user-1',
    })

    const progressValues: [number, number][] = []
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    const uploaded = await uploadIssuePhoto('issue-1', blob, {
      idempotencyKey: 'idem-123',
      onProgress: (loaded: number, total: number) => progressValues.push([loaded, total]),
    })

    assert.equal(uploaded.id, 'photo-1')
    assert.deepEqual(progressValues, [
      [50, 100],
      [100, 100],
    ])
    assert.equal(xhrRequests.length, 2)
    assert.equal(xhrRequests[0].headers.Authorization, 'Bearer expired-token')
    assert.equal(xhrRequests[1].headers.Authorization, 'Bearer fresh-token')
    assert.equal(xhrRequests[1].headers['Idempotency-Key'], 'idem-123')
    assert.equal(xhrRequests[1].headers['Content-Type'], 'image/jpeg')
    assert.equal(xhrRequests[1].headers['Content-Length'], undefined)

    // Bare 413 over apiUpload normalizes cleanly
    await assert.rejects(
      () =>
        apiUpload('/issues/issue-1/photos', {
          method: 'POST',
          body: blob,
          contentType: 'image/jpeg',
          headers: { 'Idempotency-Key': 'bare-413-key' },
        }),
      (err: any) =>
        err?.status === 413 &&
        err?.errorCode === 'FILE_TOO_LARGE' &&
        err?.isBackendUnavailable === false,
    )

    const photoBlob = await fetchIssuePhotoBlob('issue-1', 'photo-1', 'thumb')
    assert.equal(photoBlob.size, 3)

    await deleteIssuePhoto('issue-1', 'photo-1')
    assert.equal(fetchCalls.some((c) => c.url.endsWith('/photos/photo-1') && c.method === 'DELETE'), true)
  } finally {
    clearSession()
    setDemoUser('')
    globalThis.fetch = originalFetch
    ;(globalThis as any).XMLHttpRequest = originalXhr
  }
})

test('apiUpload handles network error, timeout, proxy HTML 200 fallback, demo user auth, and UNKNOWN_USER session closure', async () => {
  const originalXhr = (globalThis as any).XMLHttpRequest
  let mode: 'network' | 'timeout' | 'html200' | 'unknown_user' | 'demo_ok' = 'network'
  let lastHeaders: Record<string, string> = {}
  let endedReason = ''

  class EdgeMockXHR {
    status = 0
    responseText = ''
    upload: { onprogress?: (evt: any) => void } = {}
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    ontimeout: (() => void) | null = null
    headers: Record<string, string> = {}

    open() {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    getResponseHeader(name: string) {
      if (name.toLowerCase() === 'content-type') {
        return mode === 'html200' ? 'text/html' : 'application/json'
      }
      return ''
    }
    send() {
      lastHeaders = { ...this.headers }
      if (mode === 'network') {
        this.onerror?.()
      } else if (mode === 'timeout') {
        this.ontimeout?.()
      } else if (mode === 'html200') {
        this.status = 200
        this.responseText = '<html>nginx fallback</html>'
        this.onload?.()
      } else if (mode === 'unknown_user') {
        this.status = 401
        this.responseText = JSON.stringify({ error_code: 'UNKNOWN_USER', message: 'Closed' })
        this.onload?.()
      } else {
        this.status = 201
        this.responseText = JSON.stringify({ id: 'demo-photo-1' })
        this.onload?.()
      }
    }
  }

  ;(globalThis as any).XMLHttpRequest = EdgeMockXHR

  try {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })

    // Demo user mode sets X-Demo-User-Id and omits Authorization
    setDemoUser('demo-user-99')
    mode = 'demo_ok'
    const demoRes = await uploadIssuePhoto('issue-demo', blob, { idempotencyKey: 'k-demo' })
    assert.equal(demoRes.id, 'demo-photo-1')
    assert.equal(lastHeaders['X-Demo-User-Id'], 'demo-user-99')
    assert.equal(lastHeaders.Authorization, undefined)
    setDemoUser('')

    // Network error -> status 0, BACKEND_UNAVAILABLE, isBackendUnavailable=true
    mode = 'network'
    await assert.rejects(
      () => uploadIssuePhoto('issue-1', blob, { idempotencyKey: 'k-net' }),
      (err: any) => err?.status === 0 && err?.isBackendUnavailable === true,
    )

    // Timeout -> 408 UPLOAD_TIMEOUT (#025)
    mode = 'timeout'
    await assert.rejects(
      () => uploadIssuePhoto('issue-1', blob, { idempotencyKey: 'k-to' }),
      (err: any) =>
        err?.status === 408 &&
        err?.errorCode === 'UPLOAD_TIMEOUT' &&
        err?.isBackendUnavailable === false,
    )

    // Proxy HTML 200 fallback -> 503 BACKEND_UNAVAILABLE
    mode = 'html200'
    await assert.rejects(
      () => uploadIssuePhoto('issue-1', blob, { idempotencyKey: 'k-html' }),
      (err: any) => err?.status === 503 && err?.isBackendUnavailable === true,
    )

    // 401 UNKNOWN_USER ends active session with 'closed'
    setSessionEndedHandler((r: string) => {
      endedReason = r
    })
    applySession({
      access_token: 'valid-jwt',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 's1',
      user_id: 'u1',
    })
    mode = 'unknown_user'
    await assert.rejects(
      () => uploadIssuePhoto('issue-1', blob, { idempotencyKey: 'k-unk' }),
      (err: any) => err?.status === 401 && err?.errorCode === 'UNKNOWN_USER',
    )
    assert.equal(signedIn.value, false)
    assert.equal(endedReason, 'closed')
  } finally {
    setSessionEndedHandler(() => {})
    clearSession()
    setDemoUser('')
    ;(globalThis as any).XMLHttpRequest = originalXhr
  }
})

test('sendUpload configures positive XHR timeout, handles AbortSignal cancellation, and fetchIssuePhotoBlob rejects 200 text/html proxy fallbacks', async () => {
  const originalXhr = (globalThis as any).XMLHttpRequest
  const originalFetch = globalThis.fetch
  let observedTimeout = -1
  let abortCalled = false

  class AbortMockXHR {
    status = 0
    timeout = 0
    responseText = ''
    upload: { onprogress?: (evt: any) => void } = {}
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    ontimeout: (() => void) | null = null

    open() {}
    setRequestHeader() {}
    getResponseHeader() {
      return ''
    }
    abort() {
      abortCalled = true
      this.onabort?.()
    }
    send() {
      observedTimeout = this.timeout
    }
  }

  ;(globalThis as any).XMLHttpRequest = AbortMockXHR
  globalThis.fetch = async () =>
    new Response('<!doctype html><html><body>SPA fallback</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })

  try {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    const controller = new AbortController()
    const uploadPromise = uploadIssuePhoto('issue-abort', blob, {
      idempotencyKey: 'k-abort',
      signal: controller.signal,
    })

    // Give microtask/XHR open a tick, then abort
    await Promise.resolve()
    assert.ok(observedTimeout > 0)
    controller.abort()

    await assert.rejects(
      () => uploadPromise,
      (err: any) => err?.errorCode === 'UPLOAD_ABORTED' && err?.isBackendUnavailable === false,
    )
    assert.equal(abortCalled, true)

    // Pre-aborted signal rejects immediately
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await assert.rejects(
      () =>
        uploadIssuePhoto('issue-abort-2', blob, {
          idempotencyKey: 'k-abort-2',
          signal: alreadyAborted.signal,
        }),
      (err: any) => err?.errorCode === 'UPLOAD_ABORTED',
    )

    // fetchIssuePhotoBlob receiving 200 text/html SPA fallback must throw 503 BACKEND_UNAVAILABLE
    await assert.rejects(
      () => fetchIssuePhotoBlob('issue-1', 'photo-1', 'display'),
      (err: any) => err?.status === 503 && err?.errorCode === 'BACKEND_UNAVAILABLE',
    )
  } finally {
    ;(globalThis as any).XMLHttpRequest = originalXhr
    globalThis.fetch = originalFetch
  }
})

test('sendUpload retries once after 401 INVALID_TOKEN refresh and parses Retry-After headers on 429', async () => {
  const originalXhr = (globalThis as any).XMLHttpRequest
  const originalFetch = globalThis.fetch

  clearSession()
  applySession({ access_token: 'expired-tok', session_id: 's1', expires_in: 900 })

  const xhrCalls: Array<{ auth: string; key: string }> = []
  let attempt = 0

  class RefreshAndRetryMockXHR {
    status = 0
    timeout = 0
    responseText = ''
    headers: Record<string, string> = {}
    responseHeaders: Record<string, string> = {}
    upload: { onprogress?: (evt: any) => void } = {}
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    ontimeout: (() => void) | null = null

    open() {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    getResponseHeader(name: string) {
      return this.responseHeaders[name] || ''
    }
    send() {
      attempt += 1
      xhrCalls.push({
        auth: this.headers['Authorization'] || '',
        key: this.headers['Idempotency-Key'] || '',
      })
      if (attempt === 1) {
        this.status = 401
        this.responseHeaders = { 'Content-Type': 'application/json' }
        this.responseText = JSON.stringify({ error_code: 'INVALID_TOKEN', message: 'Expired' })
      } else if (attempt === 2) {
        this.status = 201
        this.responseHeaders = { 'Content-Type': 'application/json' }
        this.responseText = JSON.stringify({ id: 'p-refreshed', width: 800, height: 600 })
      } else {
        this.status = 429
        this.responseHeaders = {
          'Content-Type': 'application/json',
          'Retry-After': '45',
        }
        this.responseText = JSON.stringify({ error_code: 'RATE_LIMITED', message: 'Busy' })
      }
      queueMicrotask(() => this.onload?.())
    }
  }

  ;(globalThis as any).XMLHttpRequest = RefreshAndRetryMockXHR
  globalThis.fetch = async (url: any) => {
    if (String(url).includes('/auth/refresh')) {
      return new Response(
        JSON.stringify({ access_token: 'fresh-tok', session_id: 's2', expires_in: 900 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ error_code: 'RATE_LIMITED', message: 'Too many requests' }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '95' },
      },
    )
  }

  try {
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    const uploaded = await uploadIssuePhoto('issue-refresh', blob, {
      idempotencyKey: 'keep-same-key',
    })
    assert.equal(uploaded.id, 'p-refreshed')
    assert.equal(xhrCalls.length, 2)
    assert.equal(xhrCalls[0].auth, 'Bearer expired-tok')
    assert.equal(xhrCalls[1].auth, 'Bearer fresh-tok')
    assert.equal(xhrCalls[0].key, 'keep-same-key')
    assert.equal(xhrCalls[1].key, 'keep-same-key')

    // XHR 429 with Retry-After header only (missing retry_after_seconds in JSON)
    await assert.rejects(
      () => uploadIssuePhoto('issue-429', blob, { idempotencyKey: 'k-429' }),
      (err: any) =>
        err?.status === 429 &&
        err?.errorCode === 'RATE_LIMITED' &&
        err?.payload?.retry_after_seconds === 45,
    )

    // fetch 429 with Retry-After header fallback
    await assert.rejects(
      () => apiRequest('/issues', { method: 'POST', body: {} }),
      (err: any) =>
        err?.status === 429 &&
        err?.errorCode === 'RATE_LIMITED' &&
        err?.payload?.retry_after_seconds === 95,
    )
  } finally {
    clearSession()
    ;(globalThis as any).XMLHttpRequest = originalXhr
    globalThis.fetch = originalFetch
  }
})

test('sendUpload ends session fail-closed when 401 INVALID_TOKEN refresh fails, and honors reserved headers + offline demo mode', async () => {
  const originalXhr = (globalThis as any).XMLHttpRequest
  const originalFetch = globalThis.fetch
  const seenSentHeaders: Record<string, string>[] = []
  let endedReason = ''

  class ExpiredMockXHR {
    status = 0
    timeout = 0
    responseText = ''
    headers: Record<string, string> = {}
    responseHeaders: Record<string, string> = {}
    upload: { onprogress?: (evt: any) => void } = {}
    onload: (() => void) | null = null
    open() {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    getResponseHeader(name: string) {
      return this.responseHeaders[name] || ''
    }
    send() {
      seenSentHeaders.push({ ...this.headers })
      this.status = 401
      this.responseHeaders = { 'Content-Type': 'application/json' }
      this.responseText = JSON.stringify({ error_code: 'INVALID_TOKEN', message: 'Expired' })
      queueMicrotask(() => this.onload?.())
    }
  }

  ;(globalThis as any).XMLHttpRequest = ExpiredMockXHR
  globalThis.fetch = async (url: any) => {
    if (String(url).includes('/auth/refresh')) {
      return new Response(
        JSON.stringify({ error_code: 'SESSION_EXPIRED', message: 'Refresh expired' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error('Unexpected fetch call')
  }

  try {
    setSessionEndedHandler((reason: string) => {
      endedReason = reason
    })
    applySession({ access_token: 'real-tok', session_id: 's-exp', expires_in: 900 })

    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    await assert.rejects(
      () =>
        apiUpload('/issues/iss-1/photos', {
          body: blob,
          contentType: 'image/jpeg',
          headers: {
            Authorization: 'Bearer spoofed',
            'Idempotency-Key': 'k-fail-closed',
          },
        }),
      (err: any) => err?.status === 401 && err?.errorCode === 'INVALID_TOKEN',
    )

    assert.equal(seenSentHeaders.length, 1)
    assert.equal(seenSentHeaders[0]['Authorization'], 'Bearer real-tok')
    assert.equal(seenSentHeaders[0]['Idempotency-Key'], 'k-fail-closed')
    assert.equal(signedIn.value, false)
    assert.equal(endedReason, 'expired')

    // Verify offline demo mode path for apiUpload streams progress and creates photo
    enableOfflineDemo()
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    const createdIssue = await apiRequest('/issues', {
      method: 'POST',
      body: {
        category: 'LIFT',
        title: 'Offline upload check',
        description: 'Testing apiUpload in offline demo mode.',
        entrance: 1,
        place: null,
        urgent: false,
      },
    })
    const validJpeg = new Blob(
      [
        new Uint8Array([
          0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
          0xff, 0xd9,
        ]),
      ],
      { type: 'image/jpeg' },
    )
    const progressEvents: number[] = []
    const uploaded = await uploadIssuePhoto(createdIssue.id, validJpeg, {
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440099',
      onProgress: (loaded: number, total: number) => progressEvents.push(loaded / total),
    })
    assert.ok(uploaded?.id)
    assert.equal(uploaded.width, 800)
    assert.equal(uploaded.height, 600)
    assert.equal(progressEvents.length, 2)
    assert.ok(progressEvents[0] > 0 && progressEvents[0] < 1)
    assert.equal(progressEvents[1], 1)

    // Verify bare 408 without JSON body normalizes to UPLOAD_TIMEOUT
    disableOfflineDemo()
    const status408Mock = (() => {
      class Bare408Xhr {
        upload: Record<string, any> = {}
        headers: Record<string, string> = {}
        status = 0
        responseText = ''
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        ontimeout: (() => void) | null = null
        onabort: (() => void) | null = null
        open() {}
        setRequestHeader(k: string, v: string) {
          this.headers[k] = v
        }
        getResponseHeader() {
          return null
        }
        send() {
          this.status = 408
          this.responseText = 'Request Timeout'
          queueMicrotask(() => this.onload && this.onload())
        }
        abort() {}
      }
      return Bare408Xhr
    })()
    ;(globalThis as any).XMLHttpRequest = status408Mock
    applySession({ access_token: 'tok-408', session_id: 's-408', expires_in: 900 })
    await assert.rejects(
      () =>
        apiUpload('/issues/iss-1/photos', {
          body: validJpeg,
          contentType: 'image/jpeg',
        }),
      (err: any) => err?.status === 408 && err?.errorCode === 'UPLOAD_TIMEOUT',
    )

    // Verify offline apiUpload throws UPLOAD_ABORTED when signal aborts before final progress
    enableOfflineDemo()
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    const created2 = await apiRequest('/issues', {
      method: 'POST',
      body: {
        category: 'LIFT',
        title: 'Offline abort check',
        description: 'Testing abort in offline upload.',
        entrance: 1,
        place: null,
        urgent: false,
      },
    })
    const abortCtrl = new AbortController()
    const abortProgress: number[] = []
    await assert.rejects(
      () =>
        uploadIssuePhoto(created2.id, validJpeg, {
          signal: abortCtrl.signal,
          idempotencyKey: '550e8400-e29b-41d4-a716-446655440199',
          onProgress: (loaded: number, total: number) => {
            abortProgress.push(loaded / total)
            abortCtrl.abort()
          },
        }),
      (err: any) => err?.errorCode === 'UPLOAD_ABORTED',
    )
    assert.equal(abortProgress.length, 1)

    // Verify bare 408 on non-upload apiRequest stays HTTP_408 (never mislabeled UPLOAD_TIMEOUT),
    // and bare 429 without Retry-After still normalizes to RATE_LIMITED (#025 CTO audit)
    disableOfflineDemo()
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (String(input).includes('bare-408')) {
        return new Response('Request Timeout', { status: 408 })
      }
      return new Response('Too Many Requests', { status: 429 })
    }
    applySession({ access_token: 'tok-norm', session_id: 's-norm', expires_in: 900 })
    await assert.rejects(
      () => apiRequest('/bare-408', { method: 'POST', body: {} }),
      (err: any) => err?.status === 408 && err?.errorCode === 'HTTP_408',
    )
    await assert.rejects(
      () => apiRequest('/bare-429', { method: 'POST', body: {} }),
      (err: any) => err?.status === 429 && err?.errorCode === 'RATE_LIMITED',
    )
  } finally {
    disableOfflineDemo()
    setDemoUser('')
    setSessionEndedHandler(() => {})
    clearSession()
    ;(globalThis as any).XMLHttpRequest = originalXhr
    globalThis.fetch = originalFetch
  }
})

test('documents endpoints send exact query params, raw download, XHR PDF body + Idempotency-Key, PATCH/DELETE, and require documentId', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = (globalThis as any).XMLHttpRequest
  const fetchCalls: Array<{ url: string; method: string; body: any }> = []
  const xhrCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = []

  class DocMockXHR {
    status = 0
    timeout = 0
    responseText = ''
    headers: Record<string, string> = {}
    upload: Record<string, any> = {}
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    ontimeout: (() => void) | null = null
    open(method: string, url: string) {
      xhrCalls.push({ method, url, headers: {} })
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
      if (xhrCalls.length > 0) {
        xhrCalls[xhrCalls.length - 1].headers[k] = v
      }
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === 'content-type' ? 'application/json' : ''
    }
    send() {
      this.status = 201
      this.responseText = JSON.stringify({ id: 'doc-new', title: 'Rules 2026' })
      queueMicrotask(() => this.onload?.())
    }
    abort() {}
  }

  ;(globalThis as any).XMLHttpRequest = DocMockXHR
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    fetchCalls.push({ url, method, body })
    if (url.endsWith('/file')) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': "attachment; filename*=UTF-8''Rules%202026.pdf",
        },
      })
    }
    if (method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    return mockJsonResponse(200, { ok: true })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000101')

    await getDocumentUploadOptions()
    await listDocuments({ category: 'INVOICE', limit: 25, offset: 50 })
    const rawRes = await downloadDocumentFile('doc/special')
    assert.equal(rawRes.headers.get('content-disposition'), "attachment; filename*=UTF-8''Rules%202026.pdf")
    await editDocument('doc-1', { document_date: null })
    await deleteDocument('doc-1')

    const pdfBlob = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], { type: 'application/pdf' })
    await uploadDocument(
      pdfBlob,
      { title: '  Rules 2026  ', category: 'HOUSE_RULES', audience: 'EVERYONE', document_date: '' },
      { idempotencyKey: 'doc-idem-1' },
    )

    assert.equal(fetchCalls[0].url, '/api/v1/documents/upload-options')
    assert.equal(fetchCalls[1].url, '/api/v1/documents?category=INVOICE&limit=25&offset=50')
    assert.equal(fetchCalls[2].url, '/api/v1/documents/doc%2Fspecial/file')
    assert.equal(fetchCalls[3].url, '/api/v1/documents/doc-1')
    assert.equal(fetchCalls[3].method, 'PATCH')
    assert.deepEqual(fetchCalls[3].body, { document_date: null })
    assert.equal(fetchCalls[4].url, '/api/v1/documents/doc-1')
    assert.equal(fetchCalls[4].method, 'DELETE')

    assert.equal(xhrCalls.length, 1)
    assert.equal(
      xhrCalls[0].url,
      '/api/v1/documents?title=Rules+2026&category=HOUSE_RULES&audience=EVERYONE',
    )
    assert.equal(xhrCalls[0].headers['Content-Type'], 'application/pdf')
    assert.equal(xhrCalls[0].headers['Idempotency-Key'], 'doc-idem-1')

    assert.throws(() => downloadDocumentFile(''), /documentId is required/)
    assert.throws(() => editDocument('  ', { title: 'X' }), /documentId is required/)
    assert.throws(() => deleteDocument(''), /documentId is required/)
  } finally {
    setDemoUser('')
    ;(globalThis as any).XMLHttpRequest = originalXhr
    globalThis.fetch = originalFetch
  }
})

test('getFileUsage calls GET /api/v1/files/usage with signal support', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; method: string }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method || 'GET').toUpperCase() })
    return mockJsonResponse(200, {
      quota_bytes: 104857600,
      used_bytes: 1024,
      used_percent: 1,
      pending_deletion_bytes: 0,
      categories: [
        { category: 'photos', used_bytes: 1024, file_count: 1 },
        { category: 'documents', used_bytes: 0, file_count: 0 },
      ],
    })
  }

  try {
    setDemoUser('018f0000-0000-7000-8000-000000000101')
    const usage = await getFileUsage()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/v1/files/usage')
    assert.equal(calls[0].method, 'GET')
    assert.equal(usage.quota_bytes, 104857600)
    assert.equal(usage.categories.length, 2)
  } finally {
    setDemoUser('')
    globalThis.fetch = originalFetch
  }
})








