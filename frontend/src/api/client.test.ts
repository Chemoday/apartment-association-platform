import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  apiRequest,
  applySession,
  clearSession,
  refreshSession,
  setDemoUser,
  setSessionEndedHandler,
  signedIn,
} from './client.js'
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



