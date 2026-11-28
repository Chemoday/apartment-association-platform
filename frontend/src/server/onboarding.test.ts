import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiMiddleware } from './apiMiddleware.js'

interface MockResponseResult {
  status: number
  body: string
  json: () => unknown
}

function callApi(
  middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<MockResponseResult> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as IncomingMessage & {
      method: string
      url: string
      headers: Record<string, string>
    }
    req.method = method
    req.url = url
    req.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json',
      ...(options.headers || {}),
    }

    const chunks: Buffer[] = []
    const resHeaders: Record<string, string> = {}
    const mockRes = {
      statusCode: 200,
      setHeader(k: string, v: string) {
        resHeaders[k.toLowerCase()] = v
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: mockRes.statusCode,
          body: text,
          json: () => (text ? JSON.parse(text) : null),
        })
      },
    }
    const res = mockRes as unknown as ServerResponse

    try {
      middleware(req, res, () => {
        resolve({ status: 404, body: '', json: () => null })
      })
      if (options.body !== undefined) {
        req.emit('data', Buffer.from(JSON.stringify(options.body)))
      }
      req.emit('end')
    } catch (err) {
      reject(err)
    }
  })
}

const CHAIRMAN_AUTH = { authorization: 'Bearer mock-jwt-018f0000-0000-7000-8000-000000000101' }
const BOARD_AUTH = { authorization: 'Bearer mock-jwt-018f0000-0000-7000-8000-000000000105' }
const OWNER_AUTH = { authorization: 'Bearer mock-jwt-018f0000-0000-7000-8000-000000000102' }

describe('onboarding API integration (#057-#061 + #069)', () => {
  const middleware = createApiMiddleware()

  it('supports bulk invitation preview with 4th kind cell and INVALID_KIND (#057 + #069)', async () => {
    const res = await callApi(middleware, 'POST', '/api/v1/auth/invitations/bulk/preview', {
      headers: CHAIRMAN_AUTH,
      body: {
        text: '14; bulk14@demo.invalid; et\n1; park1@demo.invalid; en; PARKING\n12; badkind@demo.invalid; ru; CELLAR',
      },
    })
    assert.equal(res.status, 200)
    const data = res.json() as {
      counts: Record<string, number>
      rows: Array<{ apartment_kind: string | null; outcome: string }>
    }
    assert.equal(data.counts.READY, 2)
    assert.equal(data.counts.INVALID_KIND, 1)
    assert.equal(data.rows[1].apartment_kind, 'PARKING')
    assert.equal(data.rows[2].outcome, 'INVALID_KIND')

    const forbidden = await callApi(middleware, 'POST', '/api/v1/auth/invitations/bulk/preview', {
      headers: OWNER_AUTH,
      body: { text: '14; bulk14@demo.invalid; et' },
    })
    assert.equal(forbidden.status, 403)
  })

  it('serves connection overview with by_kind summary and paper toggle (#058 + #069)', async () => {
    const res = await callApi(middleware, 'GET', '/api/v1/auth/connections', {
      headers: CHAIRMAN_AUTH,
    })
    assert.equal(res.status, 200)
    const data = res.json() as {
      summary: {
        apartments: number
        by_kind: Record<string, { objects: number; connected: number }>
      }
      items: Array<{ apartment_id: string; apartment_kind: string }>
    }
    assert.ok(data.summary.apartments > 0)
    assert.ok(data.summary.by_kind.APARTMENT.objects > 0)
    assert.ok(data.summary.by_kind.PARKING.objects > 0)
    assert.ok(data.summary.by_kind.GARAGE.objects > 0)

    const targetId = data.items[0].apartment_id
    const putRes = await callApi(middleware, 'PUT', `/api/v1/auth/connections/${targetId}/paper`, {
      headers: CHAIRMAN_AUTH,
      body: { on_paper: true },
    })
    assert.equal(putRes.status, 200)
    assert.equal((putRes.json() as { on_paper: boolean }).on_paper, true)
  })

  it('runs end-to-end join code -> public /join -> chairman confirm -> board decisions (#059-#061 + #069)', async () => {
    // Issue a code specifically for Garage 12
    const issueRes = await callApi(middleware, 'POST', '/api/v1/auth/join-codes', {
      headers: CHAIRMAN_AUTH,
      body: { apartment_ids: ['018f0000-0000-7000-8000-000000000412'] },
    })
    assert.equal(issueRes.status, 201)
    const issued = issueRes.json() as {
      codes: Array<{ join_code: string; apartment_kind: string; apartment_number: string }>
    }
    assert.equal(issued.codes.length, 1)
    assert.equal(issued.codes[0].apartment_kind, 'GARAGE')
    const joinCode = issued.codes[0].join_code

    // Public lookup (no auth)
    const lookupRes = await callApi(middleware, 'POST', '/api/v1/auth/join/lookup', {
      body: { join_code: joinCode.toLowerCase().replace(/-/g, ' ') },
    })
    assert.equal(lookupRes.status, 200)
    const target = lookupRes.json() as { apartment_kind: string; apartment_number: string; country_code: string }
    assert.equal(target.apartment_kind, 'GARAGE')
    assert.equal(target.apartment_number, '12')
    assert.equal(target.country_code, 'EE')

    // Public submit (no auth)
    const submitRes = await callApi(middleware, 'POST', '/api/v1/auth/join', {
      body: {
        join_code: joinCode,
        full_name: 'Mati Garage',
        phone: '+372 5559 8765',
        email: 'mati.garage@demo.invalid',
        locale: 'et',
      },
    })
    assert.equal(submitRes.status, 202)

    // Board cannot see join requests (chairman only)
    const boardReqRes = await callApi(middleware, 'GET', '/api/v1/auth/join-requests', {
      headers: BOARD_AUTH,
    })
    assert.equal(boardReqRes.status, 403)

    // Chairman sees the request and confirms it
    const reqListRes = await callApi(middleware, 'GET', '/api/v1/auth/join-requests', {
      headers: CHAIRMAN_AUTH,
    })
    assert.equal(reqListRes.status, 200)
    const reqList = reqListRes.json() as Array<{
      request_id: string
      apartment_kind: string
      full_name: string
    }>
    const garageReq = reqList.find((r) => r.full_name === 'Mati Garage')
    assert.ok(garageReq)
    assert.equal(garageReq.apartment_kind, 'GARAGE')

    const confirmRes = await callApi(
      middleware,
      'POST',
      `/api/v1/auth/join-requests/${garageReq.request_id}/confirm`,
      { headers: CHAIRMAN_AUTH },
    )
    assert.equal(confirmRes.status, 200)
    assert.equal((confirmRes.json() as { apartment_kind: string }).apartment_kind, 'GARAGE')

    // Board sees the decision log without personal data
    const decRes = await callApi(middleware, 'GET', '/api/v1/auth/join-decisions', {
      headers: BOARD_AUTH,
    })
    assert.equal(decRes.status, 200)
    const decisions = decRes.json() as Array<{
      apartment_kind: string | null
      outcome: string
      full_name?: unknown
      email?: unknown
      phone?: unknown
    }>
    assert.equal(decisions[0].apartment_kind, 'GARAGE')
    assert.equal(decisions[0].outcome, 'CONFIRMED')
    assert.equal(decisions[0].full_name, undefined)
    assert.equal(decisions[0].email, undefined)
    assert.equal(decisions[0].phone, undefined)

    // Reusing the consumed join code returns 400 INVALID_JOIN_CODE
    const reuseRes = await callApi(middleware, 'POST', '/api/v1/auth/join/lookup', {
      body: { join_code: joinCode },
    })
    assert.equal(reuseRes.status, 400)

    // Empty apartment_ids returns 422 VALIDATION_ERROR
    const emptyIssueRes = await callApi(middleware, 'POST', '/api/v1/auth/join-codes', {
      headers: CHAIRMAN_AUTH,
      body: { apartment_ids: [] },
    })
    assert.equal(emptyIssueRes.status, 422)

    // Deleting unknown join code returns 404 JOIN_CODE_NOT_FOUND
    const delMissing = await callApi(middleware, 'DELETE', '/api/v1/auth/join-codes/missing-id', {
      headers: CHAIRMAN_AUTH,
    })
    assert.equal(delMissing.status, 404)
  })

  it('returns ErrorResponse.errors (not detail) on 422 invalid phone in POST /auth/join (P1-2)', async () => {
    const issueRes = await callApi(middleware, 'POST', '/api/v1/auth/join-codes', {
      headers: CHAIRMAN_AUTH,
      body: { apartment_ids: ['018f0000-0000-7000-8000-000000000401'] },
    })
    assert.equal(issueRes.status, 201)
    const code = (issueRes.json() as { codes: Array<{ join_code: string }> }).codes[0].join_code

    const badPhoneRes = await callApi(middleware, 'POST', '/api/v1/auth/join', {
      body: {
        join_code: code,
        full_name: 'Bad Phone',
        phone: '55512345',
        email: 'bad.phone@demo.invalid',
        locale: 'en',
      },
    })
    assert.equal(badPhoneRes.status, 422)
    const errPayload = badPhoneRes.json() as { errors?: Array<{ loc?: string[] }> }
    assert.ok(Array.isArray(errPayload.errors))
    assert.ok(errPayload.errors.some((e) => e.loc?.includes('phone')))
  })

  it('rejects FORUM_TOPIC with ENTRANCE (P1-8) and preserves strict GARAGE badge on GET /posts (P1-10)', async () => {
    const badScope = await callApi(middleware, 'POST', '/api/v1/communication/posts', {
      headers: CHAIRMAN_AUTH,
      body: {
        post_type: 'FORUM_TOPIC',
        title: 'Bad entrance forum topic',
        body: 'Should be rejected by contract',
        target_scope: 'ENTRANCE',
        target_entrance: 1,
      },
    })
    assert.equal(badScope.status, 422)

    // Chairman (holds Apt 01 + Garage 12) posts a GARAGE topic -> GET /posts must NOT leak Apt 01
    const garageTopic = await callApi(middleware, 'POST', '/api/v1/communication/posts', {
      headers: CHAIRMAN_AUTH,
      body: {
        post_type: 'FORUM_TOPIC',
        title: 'Garage gate repair',
        body: 'Testing strict badge on GET',
        target_scope: 'KINDS',
        target_kinds: ['GARAGE'],
      },
    })
    assert.equal(garageTopic.status, 201)
    const created = garageTopic.json() as { id: string; author_badge: { display_label: string } }
    assert.ok(created.author_badge.display_label.includes('G12'))
    assert.ok(!created.author_badge.display_label.includes('Apt 01'))

    const listRes = await callApi(middleware, 'GET', '/api/v1/communication/posts?post_type=FORUM_TOPIC', {
      headers: CHAIRMAN_AUTH,
    })
    assert.equal(listRes.status, 200)
    const listed = (listRes.json() as Array<{ id: string; author_badge: { display_label: string } }>).find(
      (p) => p.id === created.id,
    )
    assert.ok(listed?.author_badge.display_label.includes('G12'))
    assert.ok(!listed?.author_badge.display_label.includes('Apt 01'))

    // Official notice without author_apartment_id must speak as board (no Apt 01 or G12)
    const noticeRes = await callApi(middleware, 'POST', '/api/v1/communication/posts', {
      headers: CHAIRMAN_AUTH,
      body: {
        post_type: 'OFFICIAL_NOTICE',
        title: 'Board notice',
        body: 'Official board announcement',
        target_scope: 'ALL_OBJECTS',
      },
    })
    assert.equal(noticeRes.status, 201)
    const notice = noticeRes.json() as { author_badge: { display_label: string } }
    assert.ok(!notice.author_badge.display_label.includes('Apt 01'))
    assert.ok(!notice.author_badge.display_label.includes('G12'))
  })
})
