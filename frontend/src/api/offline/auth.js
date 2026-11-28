import {
  UNHANDLED,
  OFFLINE_DEMO_USERS,
  OFFLINE_APARTMENT_CARDS,
  OFFLINE_MEMBERSHIPS_BY_USER,
  makeOfflineError,
  offlineStore,
} from './state.js'
import { evaluateBulkInvitationsText } from '../../utils/bulkInvitations.js'
import { buildConnectionItems, buildConnectionOverview } from '../../utils/connections.js'
import { normalizePhoneToE164 } from '../../utils/phone.js'

export async function handleOfflineAuth(ctx) {
  const { urlObj, pathname, method, body, user } = ctx

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
      const objKindRaw = (parts[4] || '').toUpperCase()
      const objKind =
        objKindRaw === 'PARKING' || objKindRaw === 'GARAGE' ? objKindRaw : 'APARTMENT'
      const invitation =
        kindRaw === 'STAFF'
          ? {
              kind: 'STAFF',
              apartment_number: null,
              apartment_kind: null,
              building_role: ['BOARD', 'ACCOUNTANT', 'CHAIRMAN'].includes(targetVal)
                ? targetVal
                : 'BOARD',
              country_code: 'EE',
            }
          : {
              kind: kindRaw === 'TENANT' ? 'TENANT' : 'OWNER',
              apartment_number: targetVal,
              apartment_kind: objKind,
              building_role: null,
              country_code: 'EE',
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
      const objKindRaw = (parts[4] || '').toUpperCase()
      const objKind =
        objKindRaw === 'PARKING' || objKindRaw === 'GARAGE' ? objKindRaw : 'APARTMENT'
      return {
        status: 'SIGN_IN_TO_ACCEPT',
        invitation: {
          kind: kindRaw === 'OWNER' ? 'OWNER' : 'TENANT',
          apartment_number: targetVal,
          apartment_kind: objKind,
          building_role: null,
          country_code: 'EE',
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
          apartment_kind: 'APARTMENT',
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
              apartment_kind: 'APARTMENT',
              relation_type: 'OWNER',
              display_label: 'Peeter Tamm (Apt 01)',
              since: '2021-03-10T10:00:00Z',
              invited_email: null,
            },
            {
              membership_id: '018f0000-0000-7000-8000-000000000242',
              apartment_id: '018f0000-0000-7000-8000-000000000412',
              apartment_number: '12',
              apartment_kind: 'GARAGE',
              relation_type: 'OWNER',
              display_label: 'Peeter Tamm (G12)',
              since: '2026-01-01T09:00:00Z',
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
              apartment_kind: 'APARTMENT',
              relation_type: 'OWNER',
              display_label: 'Kati Kask (Apt 14)',
              since: '2022-01-12T10:00:00Z',
              invited_email: 'ivan.petrov@demo.invalid',
            },
            {
              membership_id: '018f0000-0000-7000-8000-000000000241',
              apartment_id: '018f0000-0000-7000-8000-000000000401',
              apartment_number: '1',
              apartment_kind: 'PARKING',
              relation_type: 'OWNER',
              display_label: 'Kati Kask (P1)',
              since: '2026-01-12T10:00:00Z',
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
        apartment_kind: 'APARTMENT',
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
        apartment_kind: 'APARTMENT',
        building_role: null,
        status: 'PENDING',
        mine: true,
        created_at: '2026-10-29T12:00:00Z',
        expires_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
      },
    ]
  }

  if (
    (pathname === '/auth/invitations/bulk/preview' || pathname === '/auth/invitations/bulk') &&
    method === 'POST'
  ) {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const text = typeof body?.text === 'string' ? body.text : ''
    const isSend = pathname.endsWith('/bulk')
    try {
      const { report } = evaluateBulkInvitationsText(text, {
        apartments: OFFLINE_APARTMENT_CARDS,
        existingPending: [
          {
            apartment_id: '018f0000-0000-7000-8000-000000000305',
            apartment_number: '05',
            apartment_kind: 'APARTMENT',
            raw_email: 'tonu.owner@demo.invalid',
          },
        ],
        limitRemaining: 50,
        mode: isSend ? 'send' : 'preview',
      })
      return report
    } catch (err) {
      if (err && (err.status === 422 || err.status === 429)) {
        throw makeOfflineError(
          err.status,
          err.errorCode,
          err.message,
          err.retry_after_seconds ? { retry_after_seconds: err.retry_after_seconds } : {},
        )
      }
      throw err
    }
  }

  if (pathname === '/auth/connections' && method === 'GET') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const allMemberships = Object.values(OFFLINE_MEMBERSHIPS_BY_USER).flat()
    return buildConnectionOverview({
      apartments: OFFLINE_APARTMENT_CARDS,
      memberships: allMemberships,
      invitations: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000305',
          kind: 'OWNER',
          status: 'PENDING',
          created_at: '2026-10-29T12:00:00Z',
          delivery: 'QUEUED',
        },
      ],
      paperApartmentIds: offlineStore.offlinePaperApartmentIds,
      activeJoinCodeApartmentIds: new Set(offlineStore.offlineJoinCodes.map((c) => c.apartment_id)),
      pendingJoinRequestApartmentIds: new Set(
        offlineStore.offlineJoinRequests.map((r) => r.apartment_id),
      ),
      statusFilter: urlObj?.searchParams?.get('status'),
      limit: Number(urlObj?.searchParams?.get('limit') || 50),
      offset: Number(urlObj?.searchParams?.get('offset') || 0),
    })
  }

  const offlineConnPaperMatch = pathname.match(/^\/auth\/connections\/([^/]+)\/paper$/)
  if (offlineConnPaperMatch && method === 'PUT') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const aptId = offlineConnPaperMatch[1]
    const apt = OFFLINE_APARTMENT_CARDS.find((c) => c.apartment_id === aptId)
    if (!apt) {
      throw makeOfflineError(404, 'APARTMENT_NOT_FOUND', 'Object not found.')
    }
    if (body?.on_paper) {
      offlineStore.offlinePaperApartmentIds.add(aptId)
    } else {
      offlineStore.offlinePaperApartmentIds.delete(aptId)
    }
    const allMemberships = Object.values(OFFLINE_MEMBERSHIPS_BY_USER).flat()
    return buildConnectionItems({
      apartments: [apt],
      memberships: allMemberships,
      invitations: [],
      paperApartmentIds: offlineStore.offlinePaperApartmentIds,
      activeJoinCodeApartmentIds: new Set(offlineStore.offlineJoinCodes.map((c) => c.apartment_id)),
      pendingJoinRequestApartmentIds: new Set(
        offlineStore.offlineJoinRequests.map((r) => r.apartment_id),
      ),
    })[0]
  }

  if (pathname === '/auth/join-codes' && method === 'GET') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    return offlineStore.offlineJoinCodes.map((c) => ({
      code_id: c.code_id,
      apartment_id: c.apartment_id,
      apartment_number: c.apartment_number,
      apartment_kind: c.apartment_kind,
      created_at: c.created_at,
      expires_at: c.expires_at,
    }))
  }

  if (pathname === '/auth/join-codes' && method === 'POST') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const requestedIds = Array.isArray(body?.apartment_ids) ? body.apartment_ids : null
    const allMemberships = Object.values(OFFLINE_MEMBERSHIPS_BY_USER).flat()
    const ownerAptIds = new Set(
      allMemberships.filter((m) => m.relation_type === 'OWNER').map((m) => m.apartment_id),
    )
    const activeCodeAptIds = new Set(offlineStore.offlineJoinCodes.map((c) => c.apartment_id))
    const pendingReqAptIds = new Set(offlineStore.offlineJoinRequests.map((r) => r.apartment_id))
    const targets = requestedIds
      ? requestedIds.map((id) => {
          const found = OFFLINE_APARTMENT_CARDS.find((c) => c.apartment_id === id)
          if (!found) throw makeOfflineError(404, 'APARTMENT_NOT_FOUND', 'Object not found.')
          return found
        })
      : OFFLINE_APARTMENT_CARDS.filter(
          (c) =>
            !ownerAptIds.has(c.apartment_id) &&
            !activeCodeAptIds.has(c.apartment_id) &&
            !pendingReqAptIds.has(c.apartment_id),
        )
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const pick = (n) =>
      Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
    const nowIso = new Date().toISOString()
    const expiresIso = new Date(Date.now() + 30 * 86400 * 1000).toISOString()
    const issued = targets.map((apt) => {
      const rec = {
        code_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        apartment_id: apt.apartment_id,
        apartment_number: apt.apartment_number,
        apartment_kind: apt.apartment_kind || 'APARTMENT',
        join_code: `${pick(4)}-${pick(4)}-${pick(2)}`,
        created_at: nowIso,
        expires_at: expiresIso,
      }
      offlineStore.offlineJoinCodes.unshift(rec)
      return {
        code_id: rec.code_id,
        apartment_id: rec.apartment_id,
        apartment_number: rec.apartment_number,
        apartment_kind: rec.apartment_kind,
        join_code: rec.join_code,
        expires_at: rec.expires_at,
      }
    })
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://app.example.ee'
    return {
      association_name: offlineStore.offlineSettings?.name || 'KÜ Tamme 14',
      join_url: `${origin}/join`,
      codes: issued,
    }
  }

  const offlineJoinCodeDel = pathname.match(/^\/auth\/join-codes\/([^/]+)$/)
  if (offlineJoinCodeDel && method === 'DELETE') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const codeId = offlineJoinCodeDel[1]
    const idx = offlineStore.offlineJoinCodes.findIndex((c) => c.code_id === codeId)
    if (idx === -1) {
      throw makeOfflineError(404, 'JOIN_CODE_NOT_FOUND', 'Join code not found.')
    }
    offlineStore.offlineJoinCodes.splice(idx, 1)
    return null
  }

  const normalizeCrockfordJoinCode = (raw) =>
    String(raw || '')
      .replace(/[\s-]/g, '')
      .toUpperCase()
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0')

  if (pathname === '/auth/join/lookup' && method === 'POST') {
    const normalized = normalizeCrockfordJoinCode(body?.join_code)
    const matched = offlineStore.offlineJoinCodes.find(
      (c) => normalizeCrockfordJoinCode(c.join_code) === normalized,
    )
    if (!matched) {
      throw makeOfflineError(400, 'INVALID_JOIN_CODE', 'This code is wrong, used or expired.')
    }
    return {
      association_name: offlineStore.offlineSettings?.name || 'KÜ Tamme 14',
      apartment_number: matched.apartment_number,
      apartment_kind: matched.apartment_kind,
      country_code: 'EE',
    }
  }

  if (pathname === '/auth/join/privacy-notice' && method === 'GET') {
    const rawLocale = String(urlObj?.searchParams?.get('locale') || 'en').toLowerCase()
    const locale = ['en', 'et', 'ru'].includes(rawLocale) ? rawLocale : 'en'
    return {
      custom_url: null,
      locale,
      text: 'Your name, phone number, and e-mail address are used only so the chairman of the apartment association can verify that you are the owner of an apartment, a parking space or a garage. This request data is deleted immediately after the decision (or automatically after 30 days).',
    }
  }

  if (pathname === '/auth/join' && method === 'POST') {
    const normalized = normalizeCrockfordJoinCode(body?.join_code)
    const idx = offlineStore.offlineJoinCodes.findIndex(
      (c) => normalizeCrockfordJoinCode(c.join_code) === normalized,
    )
    if (idx === -1) {
      throw makeOfflineError(400, 'INVALID_JOIN_CODE', 'This code is wrong, used or expired.')
    }
    const fullName = String(body?.full_name || '').trim()
    const email = String(body?.email || '').trim()
    const e164Phone = normalizePhoneToE164(typeof body?.phone === 'string' ? body.phone : '')
    if (!fullName || fullName.length > 200 || !email.includes('@')) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid join request details.')
    }
    if (!e164Phone) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid phone number.', {
        errors: [{ loc: ['body', 'phone'], message: 'Invalid phone number', type: 'value_error' }],
      })
    }
    const [usedCode] = offlineStore.offlineJoinCodes.splice(idx, 1)
    offlineStore.offlineJoinRequests.push({
      request_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      apartment_id: usedCode.apartment_id,
      apartment_number: usedCode.apartment_number,
      apartment_kind: usedCode.apartment_kind,
      full_name: fullName,
      phone: e164Phone,
      email,
      locale: body?.locale || 'en',
      created_at: new Date().toISOString(),
    })
    return { accepted: true }
  }

  if (pathname === '/auth/join-requests' && method === 'GET') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    return [...offlineStore.offlineJoinRequests].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    )
  }

  const offlineJoinReqAction = pathname.match(/^\/auth\/join-requests\/([^/]+)\/(confirm|reject)$/)
  if (offlineJoinReqAction && method === 'POST') {
    if (user?.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman access required.')
    }
    const [, reqId, action] = offlineJoinReqAction
    const idx = offlineStore.offlineJoinRequests.findIndex((r) => r.request_id === reqId)
    if (idx === -1) {
      throw makeOfflineError(404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found.')
    }
    const [request] = offlineStore.offlineJoinRequests.splice(idx, 1)
    const nowIso = new Date().toISOString()
    offlineStore.offlineJoinDecisions.unshift({
      apartment_id: request.apartment_id,
      apartment_number: request.apartment_number,
      apartment_kind: request.apartment_kind,
      outcome: action === 'confirm' ? 'CONFIRMED' : 'REJECTED',
      decided_by_user_id: user.user_id,
      decided_at: nowIso,
    })
    if (action === 'reject') {
      return null
    }
    return {
      invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      kind: 'OWNER',
      email: request.email,
      apartment_id: request.apartment_id,
      apartment_number: request.apartment_number,
      apartment_kind: request.apartment_kind,
      building_role: null,
      status: 'PENDING',
      mine: true,
      locale: request.locale || 'en',
      delivery: 'QUEUED',
      created_at: nowIso,
      expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    }
  }

  if (pathname === '/auth/join-decisions' && method === 'GET') {
    if (user?.building_role !== 'CHAIRMAN' && user?.building_role !== 'BOARD') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Board or chairman access required.')
    }
    const limit = Math.min(Math.max(Number(urlObj?.searchParams?.get('limit') || 20), 1), 100)
    const offset = Math.max(Number(urlObj?.searchParams?.get('offset') || 0), 0)
    const newestFirst = [...offlineStore.offlineJoinDecisions].sort(
      (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at),
    )
    return newestFirst.slice(offset, offset + limit)
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
