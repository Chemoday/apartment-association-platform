import {
  UNHANDLED,
  OFFLINE_DEMO_USERS,
  offlineStore,
} from './state.js'

export async function handleOfflineAuth(ctx) {
  const { pathname, method, body, user } = ctx

  if (pathname === '/auth/magic-link' && method === 'POST') {
    offlineStore.offlineMagicLinkUsed = false
    return { accepted: true }
  }

  if (pathname === '/auth/magic-link/redeem' && method === 'POST') {
    const tokenStr = String(body?.token || '')

    if (tokenStr.startsWith('demo-register-')) {
      const parts = tokenStr.split('-')
      const kindRaw = (parts[2] || 'owner').toUpperCase()
      const targetVal = parts[3] || '14'
      const invitation =
        kindRaw === 'STAFF'
          ? {
              kind: 'STAFF',
              apartment_number: null,
              building_role: ['BOARD', 'ACCOUNTANT', 'CHAIRMAN'].includes(targetVal)
                ? targetVal
                : 'BOARD',
            }
          : {
              kind: kindRaw === 'TENANT' ? 'TENANT' : 'OWNER',
              apartment_number: targetVal,
              building_role: null,
            }
      return {
        status: 'REGISTRATION_REQUIRED',
        registration_token: `reg-${Date.now()}`,
        expires_in: 1800,
        invitation,
      }
    }

    if (tokenStr.startsWith('demo-accept-')) {
      const parts = tokenStr.split('-')
      const kindRaw = (parts[2] || 'tenant').toUpperCase()
      const targetVal = parts[3] || '14'
      return {
        status: 'SIGN_IN_TO_ACCEPT',
        invitation: {
          kind: kindRaw === 'OWNER' ? 'OWNER' : 'TENANT',
          apartment_number: targetVal,
          building_role: null,
        },
      }
    }

    if (
      (tokenStr === 'demo-valid-token' && !offlineStore.offlineMagicLinkUsed) ||
      tokenStr.startsWith('demo-user-')
    ) {
      if (tokenStr === 'demo-valid-token') {
        offlineStore.offlineMagicLinkUsed = true
        offlineStore.offlineSignedInUserId = OFFLINE_DEMO_USERS[0].user_id
      } else {
        offlineStore.offlineSignedInUserId = tokenStr.replace('demo-user-', '')
      }
      const nowIso = new Date().toISOString()
      offlineStore.offlineSessions = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'MAGIC_LINK',
          authenticated_at: nowIso,
          last_used_at: nowIso,
          current: true,
        },
        {
          session_id: '018f0000-0000-7000-8000-000000009902',
          device_kind: 'MOBILE_BROWSER',
          auth_method: 'MAGIC_LINK',
          authenticated_at: '2026-10-28T18:30:00Z',
          last_used_at: '2026-10-30T11:20:00Z',
          current: false,
        },
      ]
      return {
        status: 'SIGNED_IN',
        session: {
          access_token: `offline-demo-jwt-${offlineStore.offlineSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        },
      }
    }
    const err = new Error('Invalid link')
    err.status = 400
    err.errorCode = 'INVALID_LINK'
    err.payload = { error_code: 'INVALID_LINK' }
    throw err
  }

  if (pathname === '/auth/password/login' && method === 'POST') {
    const email = String(body?.email || '').trim()
    const rawPassword = typeof body?.password === 'string' ? body.password : ''
    if (email.length < 3 || email.length > 320 || !email.includes('@') || !rawPassword || rawPassword.length > 1024) {
      const err = new Error('Validation error')
      err.status = 422
      err.errorCode = 'VALIDATION_ERROR'
      err.payload = { error_code: 'VALIDATION_ERROR' }
      throw err
    }
    const password = rawPassword.normalize('NFKC')
    if (password !== 'demo-password-ok') {
      const err = new Error('Invalid credentials')
      err.status = 401
      err.errorCode = 'INVALID_CREDENTIALS'
      err.payload = { error_code: 'INVALID_CREDENTIALS' }
      throw err
    }
    offlineStore.offlineSignedInUserId = email.toLowerCase().includes('peeter')
      ? '018f0000-0000-7000-8000-000000000101'
      : '018f0000-0000-7000-8000-000000000102'
    const nowIso = new Date().toISOString()
    offlineStore.offlineSessions = [
      {
        session_id: '018f0000-0000-7000-8000-000000009901',
        device_kind: 'DESKTOP_BROWSER',
        auth_method: 'PASSWORD',
        authenticated_at: nowIso,
        last_used_at: nowIso,
        current: true,
      },
    ]
    return {
      access_token: `offline-demo-jwt-${offlineStore.offlineSignedInUserId}`,
      token_type: 'Bearer',
      expires_in: 900,
      session_id: '018f0000-0000-7000-8000-000000009901',
    }
  }

  if (pathname === '/auth/password') {
    if (method === 'GET') {
      return { is_set: offlineStore.offlineHasPassword }
    }
    if (method === 'PUT') {
      const np = String(body?.new_password || '').normalize('NFKC')
      const cp = String(body?.current_password || '').normalize('NFKC')
      if (cp === 'wrong' || np.includes('reauth')) {
        const err = new Error('Reauthentication required')
        err.status = 403
        err.errorCode = 'REAUTHENTICATION_REQUIRED'
        err.payload = { error_code: 'REAUTHENTICATION_REQUIRED' }
        throw err
      }
      const len = [...np].length
      if (len < 15) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_SHORT' }
        throw err
      }
      if (len > 128) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_LONG' }
        throw err
      }
      if (np.toLowerCase().replace(/\s+/g, '') === 'password123password' || new Set([...np]).size < 5) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_COMMON' }
        throw err
      }
      offlineStore.offlineHasPassword = true
      offlineStore.offlineSessions = offlineStore.offlineSessions.filter((s) => s.current)
      return null
    }
    if (method === 'DELETE') {
      if (!offlineStore.offlineHasPassword) {
        return null
      }
      const cp = String(body?.current_password || '').normalize('NFKC')
      if (cp === 'wrong') {
        const err = new Error('Reauthentication required')
        err.status = 403
        err.errorCode = 'REAUTHENTICATION_REQUIRED'
        err.payload = { error_code: 'REAUTHENTICATION_REQUIRED' }
        throw err
      }
      offlineStore.offlineHasPassword = false
      offlineStore.offlineSessions = offlineStore.offlineSessions.filter((s) => s.current)
      return null
    }
  }

  const offlineResidentsMatch = pathname.match(/^\/auth\/apartments\/([^/]+)\/residents$/)
  if (offlineResidentsMatch && method === 'GET') {
    const aptId = offlineResidentsMatch[1]
    return {
      residents: [
        {
          user_id: '018f0000-0000-7000-8000-000000000102',
          membership_id: '018f0000-0000-7000-8000-000000000214',
          relation_type: 'OWNER',
          display_label: 'Kati Kask (Apt 14)',
          since: '2022-01-12T10:00:00Z',
          invited_email: null,
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000104',
          membership_id: '018f0000-0000-7000-8000-000000000399',
          relation_type: 'TENANT',
          display_label: 'M. T. (Apt 14)',
          since: '2025-09-03T10:00:00Z',
          invited_email: 'martin.tenant@demo.invalid',
        },
      ],
      pending_invitations: [
        {
          invitation_id: '018f0000-0000-7000-8000-000000008301',
          kind: 'TENANT',
          email: 'new.tenant@demo.invalid',
          apartment_id: aptId,
          apartment_number: '14',
          building_role: null,
          status: 'PENDING',
          mine: true,
          created_at: '2026-10-30T10:00:00Z',
          expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        },
      ],
    }
  }

  if (pathname === '/auth/users' && method === 'GET') {
    return {
      people: [
        {
          user_id: '018f0000-0000-7000-8000-000000000101',
          is_me: true,
          display_label: 'Peeter Tamm (Apt 01)',
          building_role: 'CHAIRMAN',
          invited_email: null,
          memberships: [
            {
              membership_id: '018f0000-0000-7000-8000-000000000201',
              apartment_id: '018f0000-0000-7000-8000-000000000301',
              apartment_number: '01',
              relation_type: 'OWNER',
              display_label: 'Peeter Tamm (Apt 01)',
              since: '2021-03-10T10:00:00Z',
              invited_email: null,
            },
          ],
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000102',
          is_me: false,
          display_label: 'Kati Kask (Apt 14)',
          building_role: 'USER',
          invited_email: null,
          memberships: [
            {
              membership_id: '018f0000-0000-7000-8000-000000000214',
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              relation_type: 'OWNER',
              display_label: 'Kati Kask (Apt 14)',
              since: '2022-01-12T10:00:00Z',
              invited_email: 'ivan.petrov@demo.invalid',
            },
          ],
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000103',
          is_me: false,
          display_label: 'Marika Rebane (Accountant)',
          building_role: 'ACCOUNTANT',
          invited_email: 'anna.kask@demo.invalid',
          memberships: [],
        },
      ],
    }
  }

  if (pathname === '/auth/invitations' && method === 'GET') {
    return [
      {
        invitation_id: '018f0000-0000-7000-8000-000000008301',
        kind: 'TENANT',
        email: 'n***@demo.invalid',
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        building_role: null,
        status: 'PENDING',
        mine: false,
        created_at: '2026-10-30T10:00:00Z',
        expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
      },
      {
        invitation_id: '018f0000-0000-7000-8000-000000008302',
        kind: 'OWNER',
        email: 'tonu.owner@demo.invalid',
        apartment_id: '018f0000-0000-7000-8000-000000000305',
        apartment_number: '05',
        building_role: null,
        status: 'PENDING',
        mine: true,
        created_at: '2026-10-29T12:00:00Z',
        expires_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
      },
    ]
  }

  if (pathname === '/auth/registration' && method === 'POST') {
    const nowIso = new Date().toISOString()
    offlineStore.offlineSessions = [
      {
        session_id: '018f0000-0000-7000-8000-000000009901',
        device_kind: 'DESKTOP_BROWSER',
        auth_method: 'INVITATION',
        authenticated_at: nowIso,
        last_used_at: nowIso,
        current: true,
      },
    ]
    return {
      status: 'SIGNED_IN',
      session: {
        access_token: 'offline-demo-jwt-token',
        token_type: 'Bearer',
        expires_in: 900,
        session_id: '018f0000-0000-7000-8000-000000009901',
      },
    }
  }

  if (pathname === '/auth/invitations/accept' && method === 'POST') {
    return { applied: true }
  }

  if (pathname === '/auth/sessions' && method === 'GET') {
    return offlineStore.offlineSessions
  }

  if (pathname === '/auth/sessions' && method === 'DELETE') {
    offlineStore.offlineSessions = []
    return null
  }

  const offlineSessionDel = pathname.match(/^\/auth\/sessions\/([^/]+)$/)
  if (offlineSessionDel && method === 'DELETE') {
    offlineStore.offlineSessions = offlineStore.offlineSessions.filter((s) => s.session_id !== offlineSessionDel[1])
    return null
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    offlineStore.offlineSignedInUserId = ''
    offlineStore.offlineSessions = []
    return null
  }

  // =========================================================================
  // Governance Polls (/governance/polls)
  // =========================================================================

  return UNHANDLED
}
