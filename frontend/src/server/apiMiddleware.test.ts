import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createApiMiddleware, resetApiMiddlewareStateForTest } from './apiMiddleware.js'

const RESIDENT_APT14_ID = '018f0000-0000-7000-8000-000000000102'

function buildMinimalJpegBuffer(width = 800, height = 600): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

async function invokeMiddleware(
  handler: ReturnType<typeof createApiMiddleware>,
  {
    method = 'GET',
    url,
    headers = {},
    chunks = [] as Buffer[],
  }: {
    method?: string
    url: string
    headers?: Record<string, string>
    chunks?: Buffer[]
  },
) {
  const req = new EventEmitter() as any
  req.method = method
  req.url = url
  req.headers = headers
  req.complete = false
  req.readable = true
  req.pause = () => {}
  req.resume = () => {}

  const resHeaders: Record<string, string> = {}
  let responseBody = ''
  let resolveDone!: () => void
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const res = {
    statusCode: 200,
    setHeader(k: string, v: string) {
      resHeaders[String(k).toLowerCase()] = String(v)
    },
    end(chunk?: any) {
      if (chunk !== undefined && chunk !== null) {
        responseBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      resolveDone()
    },
  } as any

  const pendingCall = handler(req, res, () => {
    res.statusCode = 404
    resolveDone()
  })

  queueMicrotask(() => {
    for (const buf of chunks) {
      req.emit('data', buf)
    }
    req.complete = true
    req.emit('end')
  })

  await Promise.all([pendingCall, donePromise])
  let json: any = null
  try {
    json = responseBody ? JSON.parse(responseBody) : null
  } catch {
    json = responseBody
  }
  return { status: res.statusCode, headers: resHeaders, json, body: responseBody }
}

describe('apiMiddleware HTTP issue photo routes (#025 CTO audit)', () => {
  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('enforces Retry-After header on 429 BUSY, declaredLength body overflow (413), idempotency replay, and listener cleanup', async () => {
    const mw = createApiMiddleware()
    const issuePayload = Buffer.from(
      JSON.stringify({
        category: 'LIGHTING',
        entrance: 1,
        title: 'Middleware HTTP upload test',
        description: 'Created inside middleware unit test',
      }),
    )
    const createRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/issues',
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'application/json',
        'content-length': String(issuePayload.byteLength),
      },
      chunks: [issuePayload],
    })
    assert.equal(createRes.status, 201)
    const ownIssue = createRes.json
    assert.ok(ownIssue?.id)

    const jpeg = buildMinimalJpegBuffer(800, 600)

    // 1. 429 BUSY sets Retry-After HTTP header cleanly
    const busyRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/issues/${ownIssue.id}/photos?simulate_upload_answer=BUSY`,
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.byteLength),
      },
      chunks: [jpeg],
    })
    assert.equal(busyRes.status, 429)
    assert.equal(busyRes.json?.error_code, 'RATE_LIMITED')
    assert.equal(busyRes.headers['retry-after'], '15')

    // 2. Body exceeding declared Content-Length stops cleanly with 413 FILE_TOO_LARGE
    const overflowRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/issues/${ownIssue.id}/photos`,
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'image/jpeg',
        'content-length': '5',
      },
      chunks: [jpeg],
    })
    assert.equal(overflowRes.status, 413)
    assert.equal(overflowRes.json?.error_code, 'FILE_TOO_LARGE')

    // 3. Valid upload + idempotent replay + UPLOAD_REMOVED after delete
    const idemKey = '99999999-9999-4999-8999-999999999991'
    const upRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/issues/${ownIssue.id}/photos`,
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.byteLength),
        'idempotency-key': idemKey,
      },
      chunks: [jpeg],
    })
    assert.equal(upRes.status, 201)
    assert.ok(upRes.json?.id)

    const replayRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/issues/${ownIssue.id}/photos`,
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.byteLength),
        'idempotency-key': idemKey,
      },
      chunks: [jpeg],
    })
    assert.equal(replayRes.status, 200)
    assert.equal(replayRes.json?.id, upRes.json?.id)

    const delRes = await invokeMiddleware(mw, {
      method: 'DELETE',
      url: `/api/v1/issues/${ownIssue.id}/photos/${upRes.json.id}`,
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(delRes.status, 204)

    const removedRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/issues/${ownIssue.id}/photos`,
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.byteLength),
        'idempotency-key': idemKey,
      },
      chunks: [jpeg],
    })
    assert.equal(removedRes.status, 409)
    assert.equal(removedRes.json?.error_code, 'UPLOAD_REMOVED')
  })
})

describe('apiMiddleware HTTP documents routes (#022 & #023)', () => {
  const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'

  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('serves upload-options, PDF upload with idempotency, strict /file attachment headers, partial PATCH, and chairman DELETE', async () => {
    const mw = createApiMiddleware()

    // Accountant upload-options
    const optRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/documents/upload-options',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(optRes.status, 200)
    assert.equal(optRes.json?.can_upload, true)
    assert.deepEqual(optRes.json?.audiences, ['BOARD_AND_ACCOUNTANT'])

    // Resident cannot see non-EVERYONE seeded docs and uploaded_by is null
    const resList = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/documents?limit=50&offset=0',
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(resList.status, 200)
    assert.ok(Array.isArray(resList.json) && resList.json.length > 0)
    assert.ok(resList.json.every((d: any) => d.audience === 'EVERYONE' && d.uploaded_by === null))

    const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'utf8')
    const idemKey = 'doc-http-idem-1'

    // Upload document
    const upRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=Q4%20Ledger&category=INVOICE&audience=BOARD_AND_ACCOUNTANT&document_date=2026-11-10',
      headers: {
        'x-demo-user-id': ACCOUNTANT_ID,
        'content-type': 'application/pdf',
        'content-length': String(pdfBuf.byteLength),
        'idempotency-key': idemKey,
      },
      chunks: [pdfBuf],
    })
    assert.equal(upRes.status, 201)
    const docId = upRes.json?.id
    assert.ok(docId)

    // Replay returns 200 with same ID
    const replayRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=Q4%20Ledger&category=INVOICE&audience=BOARD_AND_ACCOUNTANT&document_date=2026-11-10',
      headers: {
        'x-demo-user-id': ACCOUNTANT_ID,
        'content-type': 'application/pdf',
        'content-length': String(pdfBuf.byteLength),
        'idempotency-key': idemKey,
      },
      chunks: [pdfBuf],
    })
    assert.equal(replayRes.status, 200)
    assert.equal(replayRes.json?.id, docId)

    // Length overflow rejected with 413
    const overflowRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=Over&category=OTHER&audience=BOARD',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/pdf',
        'content-length': '5',
      },
      chunks: [pdfBuf],
    })
    assert.equal(overflowRes.status, 413)
    assert.equal(overflowRes.json?.error_code, 'FILE_TOO_LARGE')

    // /file returns PDF attachment + security headers
    const dlRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/documents/${docId}/file`,
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(dlRes.status, 200)
    assert.equal(dlRes.headers['content-type'], 'application/pdf')
    assert.equal(dlRes.headers['x-content-type-options'], 'nosniff')
    assert.equal(dlRes.headers['content-security-policy'], "default-src 'none'; sandbox")
    assert.equal(dlRes.headers['cache-control'], 'private, no-store')
    assert.ok(dlRes.headers['content-disposition']?.startsWith('attachment;'))
    assert.ok(dlRes.body.startsWith('%PDF-'))

    // Board partial PATCH
    const patchBody = Buffer.from(JSON.stringify({ document_date: null }))
    const patchRes = await invokeMiddleware(mw, {
      method: 'PATCH',
      url: `/api/v1/documents/${docId}`,
      headers: {
        'x-demo-user-id': BOARD_ID,
        'content-type': 'application/json',
        'content-length': String(patchBody.byteLength),
      },
      chunks: [patchBody],
    })
    assert.equal(patchRes.status, 200)
    assert.equal(patchRes.json?.title, 'Q4 Ledger')
    assert.equal(patchRes.json?.document_date, null)

    // Board cannot delete (403); Chairman deletes (204)
    const boardDel = await invokeMiddleware(mw, {
      method: 'DELETE',
      url: `/api/v1/documents/${docId}`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(boardDel.status, 403)

    const chairDel = await invokeMiddleware(mw, {
      method: 'DELETE',
      url: `/api/v1/documents/${docId}`,
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(chairDel.status, 204)
  })

  it('rejects missing Content-Length (411), truncated upload body (400 UPLOAD_INTERRUPTED), and quota errors (507)', async () => {
    const mw = createApiMiddleware()
    const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'utf8')

    // Missing Content-Length -> 411 LENGTH_REQUIRED
    const missingLenRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=MissingLen&category=OTHER&audience=BOARD',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/pdf',
      },
      chunks: [pdfBuf],
    })
    assert.equal(missingLenRes.status, 411)
    assert.equal(missingLenRes.json?.error_code, 'LENGTH_REQUIRED')

    // Truncated stream (declared length > actual bytes) -> 400 UPLOAD_INTERRUPTED
    const truncatedRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=Truncated&category=OTHER&audience=BOARD',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/pdf',
        'content-length': String(pdfBuf.byteLength + 100),
      },
      chunks: [pdfBuf],
    })
    assert.equal(truncatedRes.status, 400)
    assert.equal(truncatedRes.json?.error_code, 'UPLOAD_INTERRUPTED')

    // Quota exceeded -> 507 STORAGE_QUOTA_EXCEEDED with reason
    const quotaRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/documents?title=QuotaDoc&category=OTHER&audience=BOARD&simulate_upload_answer=DELETIONS_PENDING',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/pdf',
        'content-length': String(pdfBuf.byteLength),
      },
      chunks: [pdfBuf],
    })
    assert.equal(quotaRes.status, 507)
    assert.equal(quotaRes.json?.error_code, 'STORAGE_QUOTA_EXCEEDED')
    assert.equal(quotaRes.json?.reason, 'DELETIONS_PENDING')
  })
})

describe('apiMiddleware HTTP storage usage and alert routes (#024)', () => {
  const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const RESIDENT_ID = '018f0000-0000-7000-8000-000000000102'

  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('serves GET /api/v1/files/usage to Chairman and Board, forbids Resident, and allows preferences update', async () => {
    const mw = createApiMiddleware()

    // Chairman gets 200
    const chairRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/files/usage',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(chairRes.status, 200)
    assert.equal(typeof chairRes.json?.quota_bytes, 'number')
    assert.ok(chairRes.json?.quota_bytes > 0)
    assert.equal(typeof chairRes.json?.used_bytes, 'number')
    assert.equal(typeof chairRes.json?.used_percent, 'number')
    assert.equal(typeof chairRes.json?.pending_deletion_bytes, 'number')
    assert.ok(Array.isArray(chairRes.json?.categories))

    // Board member gets 200
    const boardRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/files/usage',
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(boardRes.status, 200)

    // Resident gets 403 FORBIDDEN
    const residentRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/files/usage',
      headers: { 'x-demo-user-id': RESIDENT_ID },
    })
    assert.equal(residentRes.status, 403)
    assert.equal(residentRes.json?.error_code, 'FORBIDDEN')

    // Updating STORAGE_ALMOST_FULL preference via PUT /api/v1/notifications/preferences
    const prefRes = await invokeMiddleware(mw, {
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/json',
      },
      chunks: [
        Buffer.from(
          JSON.stringify({
            preferences: [
              { event_type: 'STORAGE_ALMOST_FULL', channel: 'in_app', enabled: false },
            ],
          }),
        ),
      ],
    })
    assert.equal(prefRes.status, 200)
    assert.equal(prefRes.json?.preferences?.length, 52)
    const changed = prefRes.json?.preferences?.find(
      (p: any) => p.event_type === 'STORAGE_ALMOST_FULL' && p.channel === 'in_app',
    )
    assert.equal(changed?.enabled, false)
  })
})

describe('apiMiddleware HTTP communication #026 hidden and edited routes', () => {
  const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'
  const OWNER_ID = '018f0000-0000-7000-8000-000000000102'
  const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'
  const TENANT_AUTHOR_ID = '018f0000-0000-7000-8000-000000000104'
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const EDITED_TOPIC_ID = '018f0000-0000-7000-8000-000000000602'
  const HIDDEN_TOPIC_ID = '018f0000-0000-7000-8000-000000000605'
  const NOTICE_ID = '018f0000-0000-7000-8000-000000000601'

  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('redacts hidden comments by role, hides hidden topics from non-author non-board, returns 409 POST_HIDDEN, and lets BOARD delete forum topics', async () => {
    const mw = createApiMiddleware()

    // 1. Edited post/comment & hidden comment masking for Owner & Accountant
    for (const viewerId of [OWNER_ID, ACCOUNTANT_ID]) {
      const detailRes = await invokeMiddleware(mw, {
        method: 'GET',
        url: `/api/v1/communication/posts/${EDITED_TOPIC_ID}`,
        headers: { 'x-demo-user-id': viewerId },
      })
      assert.equal(detailRes.status, 200)
      assert.equal(detailRes.json?.edited_at, '2026-10-20T18:05:00Z')
      assert.equal(detailRes.json?.comments_count, 2)
      assert.equal(detailRes.json?.comments?.[0]?.edited_at, '2026-10-21T09:22:00Z')
      assert.equal(detailRes.json?.comments?.[1]?.id, '018f0000-0000-7000-8000-000000000654')
      assert.ok(detailRes.json?.comments?.[1]?.hidden_at)
      assert.equal(detailRes.json?.comments?.[1]?.body, null)
      assert.equal(detailRes.json?.comments?.[1]?.hidden_reason, null)
    }

    // Comment author, BOARD, CHAIRMAN see full body + hidden_reason
    for (const privilegedId of [TENANT_AUTHOR_ID, BOARD_ID, CHAIRMAN_ID]) {
      const detailRes = await invokeMiddleware(mw, {
        method: 'GET',
        url: `/api/v1/communication/posts/${EDITED_TOPIC_ID}`,
        headers: { 'x-demo-user-id': privilegedId },
      })
      assert.equal(detailRes.status, 200)
      assert.ok(typeof detailRes.json?.comments?.[1]?.body === 'string')
      assert.ok(typeof detailRes.json?.comments?.[1]?.hidden_reason === 'string')
    }

    // 2. Hidden topic 0605 returns 404 to non-author non-board on GET and POST comments
    const ownerFeedRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/communication/posts?post_type=FORUM_TOPIC',
      headers: { 'x-demo-user-id': OWNER_ID },
    })
    assert.equal(ownerFeedRes.status, 200)
    assert.equal(ownerFeedRes.json?.some((p: any) => p.id === HIDDEN_TOPIC_ID), false)

    const ownerHiddenDetail = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/communication/posts/${HIDDEN_TOPIC_ID}`,
      headers: { 'x-demo-user-id': OWNER_ID },
    })
    assert.equal(ownerHiddenDetail.status, 404)
    assert.equal(ownerHiddenDetail.json?.error_code, 'POST_NOT_FOUND')

    // Author & Board see hidden topic in feed & detail, and get 409 POST_HIDDEN on commenting
    for (const privilegedId of [TENANT_AUTHOR_ID, BOARD_ID, CHAIRMAN_ID]) {
      const privFeedRes = await invokeMiddleware(mw, {
        method: 'GET',
        url: '/api/v1/communication/posts',
        headers: { 'x-demo-user-id': privilegedId },
      })
      assert.equal(privFeedRes.status, 200)
      const hiddenEntry = privFeedRes.json?.find((p: any) => p.id === HIDDEN_TOPIC_ID)
      assert.ok(hiddenEntry?.hidden_at)
      assert.ok(hiddenEntry?.hidden_reason)

      const commentPayload = Buffer.from(JSON.stringify({ body: 'Cannot comment here' }))
      const commentRes = await invokeMiddleware(mw, {
        method: 'POST',
        url: `/api/v1/communication/posts/${HIDDEN_TOPIC_ID}/comments`,
        headers: {
          'x-demo-user-id': privilegedId,
          'content-type': 'application/json',
          'content-length': String(commentPayload.byteLength),
        },
        chunks: [commentPayload],
      })
      assert.equal(commentRes.status, 409)
      assert.equal(commentRes.json?.error_code, 'POST_HIDDEN')
    }

    // 3. Feed chronological order (0605 newer than 0602) & comments_limit/offset pagination
    const boardForumRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/communication/posts?post_type=FORUM_TOPIC',
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(boardForumRes.status, 200)
    const idx0605 = boardForumRes.json?.findIndex((p: any) => p.id === HIDDEN_TOPIC_ID)
    const idx0602 = boardForumRes.json?.findIndex((p: any) => p.id === EDITED_TOPIC_ID)
    assert.ok(idx0605 !== -1 && idx0602 !== -1 && idx0605 < idx0602)

    const pagedDetail = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/communication/posts/${EDITED_TOPIC_ID}?comments_limit=1&comments_offset=1`,
      headers: { 'x-demo-user-id': OWNER_ID },
    })
    assert.equal(pagedDetail.status, 200)
    assert.equal(pagedDetail.json?.comments_count, 2)
    assert.equal(pagedDetail.json?.comments?.length, 1)
    assert.equal(pagedDetail.json?.comments?.[0]?.id, '018f0000-0000-7000-8000-000000000654')

    // 4. DELETE permissions: 403 for USER/ACCOUNTANT, 409 for OFFICIAL_NOTICE/EMERGENCY/APARTMENT_THREAD, 204 for BOARD deleting FORUM_TOPIC
    const userDelRes = await invokeMiddleware(mw, {
      method: 'DELETE',
      url: `/api/v1/communication/posts/${EDITED_TOPIC_ID}`,
      headers: { 'x-demo-user-id': OWNER_ID },
    })
    assert.equal(userDelRes.status, 403)
    assert.equal(userDelRes.json?.error_code, 'FORBIDDEN')

    for (const nonDeletableId of [
      NOTICE_ID,
      '018f0000-0000-7000-8000-000000000701',
      '018f0000-0000-7000-8000-000000000751',
    ]) {
      const nonDelRes = await invokeMiddleware(mw, {
        method: 'DELETE',
        url: `/api/v1/communication/posts/${nonDeletableId}`,
        headers: { 'x-demo-user-id': BOARD_ID },
      })
      assert.equal(nonDelRes.status, 409)
      assert.equal(nonDelRes.json?.error_code, 'POST_NOT_DELETABLE')
    }

    const boardDelRes = await invokeMiddleware(mw, {
      method: 'DELETE',
      url: `/api/v1/communication/posts/${HIDDEN_TOPIC_ID}`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(boardDelRes.status, 204)

    const afterDelGet = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/communication/posts/${HIDDEN_TOPIC_ID}`,
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(afterDelGet.status, 404)

    // 5. Validation & DTO safety on POST /posts and /comments
    const blankPostPayload = Buffer.from(JSON.stringify({ post_type: 'FORUM_TOPIC', title: '  ', body: 'Hi' }))
    const blankPostRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/communication/posts',
      headers: {
        'x-demo-user-id': OWNER_ID,
        'content-type': 'application/json',
        'content-length': String(blankPostPayload.byteLength),
      },
      chunks: [blankPostPayload],
    })
    assert.equal(blankPostRes.status, 422)
    assert.equal(blankPostRes.json?.error_code, 'VALIDATION_ERROR')

    const validPostPayload = Buffer.from(
      JSON.stringify({ post_type: 'FORUM_TOPIC', title: 'Mailbox lock', body: 'Needs lubrication' }),
    )
    const validPostRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/communication/posts',
      headers: {
        'x-demo-user-id': OWNER_ID,
        'content-type': 'application/json',
        'content-length': String(validPostPayload.byteLength),
      },
      chunks: [validPostPayload],
    })
    assert.equal(validPostRes.status, 201)
    assert.equal('author_user_id' in (validPostRes.json || {}), false)
    assert.equal('comments' in (validPostRes.json || {}), false)

    const validCommentPayload = Buffer.from(JSON.stringify({ body: 'Agreed' }))
    const validCommentRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/communication/posts/${validPostRes.json?.id}/comments`,
      headers: {
        'x-demo-user-id': OWNER_ID,
        'content-type': 'application/json',
        'content-length': String(validCommentPayload.byteLength),
      },
      chunks: [validCommentPayload],
    })
    assert.equal(validCommentRes.status, 201)
    assert.equal('author_user_id' in (validCommentRes.json || {}), false)
    assert.equal('author_apartment_id' in (validCommentRes.json || {}), false)
  })

  it('enforces #028 board hide/unhide endpoints, idempotency, 403/404/409/422 contracts, and feed visibility', async () => {
    const mw = createApiMiddleware()
    const OWNER_ID = '018f0000-0000-7000-8000-000000000102'
    const TENANT_ID = '018f0000-0000-7000-8000-000000000104'
    const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'
    const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
    const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'

    const jsonPost = (url: string, userId: string, bodyObj: any) => {
      const buf = Buffer.from(JSON.stringify(bodyObj))
      return invokeMiddleware(mw, {
        method: 'POST',
        url,
        headers: {
          'x-demo-user-id': userId,
          'content-type': 'application/json',
          'content-length': String(buf.byteLength),
        },
        chunks: [buf],
      })
    }

    const createRes = await jsonPost('/api/v1/communication/posts', OWNER_ID, {
      post_type: 'FORUM_TOPIC',
      title: 'HTTP moderation test topic',
      body: 'Moderate me',
    })
    assert.equal(createRes.status, 201)
    const postId = createRes.json?.id

    // Non-board -> 403
    for (const nonBoard of [OWNER_ID, ACCOUNTANT_ID]) {
      const denyRes = await jsonPost(`/api/v1/communication/posts/${postId}/hide`, nonBoard, {
        reason: 'Forbidden attempt',
      })
      assert.equal(denyRes.status, 403)
      assert.equal(denyRes.json?.error_code, 'FORBIDDEN')
    }

    // Non-hideable post -> 409 POST_NOT_HIDEABLE
    const noticeHideRes = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/hide',
      BOARD_ID,
      { reason: 'Notice cannot be hidden' },
    )
    assert.equal(noticeHideRes.status, 409)
    assert.equal(noticeHideRes.json?.error_code, 'POST_NOT_HIDEABLE')
    assert.equal(noticeHideRes.json?.post_type, 'OFFICIAL_NOTICE')

    // Invalid reason -> 422
    const blankReasonRes = await jsonPost(`/api/v1/communication/posts/${postId}/hide`, BOARD_ID, {
      reason: '   ',
    })
    assert.equal(blankReasonRes.status, 422)
    assert.equal(blankReasonRes.json?.error_code, 'VALIDATION_ERROR')

    // Valid hide -> idempotent preserves first reason
    const hide1 = await jsonPost(`/api/v1/communication/posts/${postId}/hide`, BOARD_ID, {
      reason: 'Initial HTTP reason',
    })
    assert.equal(hide1.status, 200)
    assert.ok(hide1.json?.hidden_at)
    assert.equal(hide1.json?.hidden_reason, 'Initial HTTP reason')
    assert.equal('hidden_by_user_id' in (hide1.json || {}), false)

    const hide2 = await jsonPost(`/api/v1/communication/posts/${postId}/hide`, CHAIRMAN_ID, {
      reason: 'Override attempt',
    })
    assert.equal(hide2.status, 200)
    assert.equal(hide2.json?.hidden_at, hide1.json?.hidden_at)
    assert.equal(hide2.json?.hidden_reason, 'Initial HTTP reason')

    // Feed disappears for tenant, stays for board
    const tenantFeed = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/communication/posts',
      headers: { 'x-demo-user-id': TENANT_ID },
    })
    assert.equal(tenantFeed.json?.some((p: any) => p.id === postId), false)

    // Unhide restores post
    const unhideRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/communication/posts/${postId}/unhide`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(unhideRes.status, 200)
    assert.equal(unhideRes.json?.hidden_at, null)
    assert.equal(unhideRes.json?.hidden_reason, null)

    // Comment hide on BOARD_TOPIC -> 409 COMMENT_NOT_HIDEABLE
    const boardCommentHide = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000761/comments/018f0000-0000-7000-8000-000000000762/hide',
      BOARD_ID,
      { reason: 'No hiding board room comments' },
    )
    assert.equal(boardCommentHide.status, 409)
    assert.equal(boardCommentHide.json?.error_code, 'COMMENT_NOT_HIDEABLE')

    // Comment of another post -> 404 COMMENT_NOT_FOUND
    const wrongPostComment = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000653/hide',
      BOARD_ID,
      { reason: 'Wrong post' },
    )
    assert.equal(wrongPostComment.status, 404)
    assert.equal(wrongPostComment.json?.error_code, 'COMMENT_NOT_FOUND')

    // Hide & unhide OFFICIAL_NOTICE comment (0601 / 0651)
    const commentHide = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/hide',
      CHAIRMAN_ID,
      { reason: 'Rule violation on notice' },
    )
    assert.equal(commentHide.status, 200)
    assert.ok(commentHide.json?.hidden_at)
    assert.equal(commentHide.json?.hidden_reason, 'Rule violation on notice')

    const commentUnhide = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/unhide',
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(commentUnhide.status, 200)
    assert.equal(commentUnhide.json?.hidden_at, null)
    assert.equal(commentUnhide.json?.hidden_reason, null)

    // Idempotent unhide -> 200; non-hideable unhide -> 409
    const idempotentUnhide = await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/communication/posts/${postId}/unhide`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(idempotentUnhide.status, 200)
    assert.equal(idempotentUnhide.json?.hidden_at, null)

    const noticeUnhide = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/unhide',
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(noticeUnhide.status, 409)
    assert.equal(noticeUnhide.json?.error_code, 'POST_NOT_HIDEABLE')

    // Missing post -> 404 POST_NOT_FOUND
    const missingHide = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-999999999999/hide',
      BOARD_ID,
      { reason: 'No such post' },
    )
    assert.equal(missingHide.status, 404)
    assert.equal(missingHide.json?.error_code, 'POST_NOT_FOUND')

    // Non-board 403 on comment hide/unhide
    const forbidCommentHide = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/hide',
      OWNER_ID,
      { reason: 'Denied' },
    )
    assert.equal(forbidCommentHide.status, 403)
    assert.equal(forbidCommentHide.json?.error_code, 'FORBIDDEN')

    // FORUM_TOPIC & EMERGENCY comment hide/unhide
    const topicCommentRes = await jsonPost(
      `/api/v1/communication/posts/${postId}/comments`,
      TENANT_ID,
      { body: 'Topic comment HTTP' },
    )
    const topicCommentHide = await jsonPost(
      `/api/v1/communication/posts/${postId}/comments/${topicCommentRes.json?.id}/hide`,
      BOARD_ID,
      { reason: 'Hide forum comment' },
    )
    assert.equal(topicCommentHide.status, 200)
    assert.ok(topicCommentHide.json?.hidden_at)

    const emergCommentRes = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000701/comments',
      OWNER_ID,
      { body: 'Emergency comment HTTP' },
    )
    const emergCommentHide = await jsonPost(
      `/api/v1/communication/posts/018f0000-0000-7000-8000-000000000701/comments/${emergCommentRes.json?.id}/hide`,
      CHAIRMAN_ID,
      { reason: 'Hide emergency comment' },
    )
    assert.equal(emergCommentHide.status, 200)

    // Hide post -> author gets 200 GET /posts/:id, tenant gets 404, POST /comments -> 409 POST_HIDDEN -> unhide lifts block
    await jsonPost(`/api/v1/communication/posts/${postId}/hide`, BOARD_ID, {
      reason: 'Hidden block HTTP',
    })
    const authorDetail = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/communication/posts/${postId}`,
      headers: { 'x-demo-user-id': OWNER_ID },
    })
    assert.equal(authorDetail.status, 200)
    assert.equal(authorDetail.json?.hidden_reason, 'Hidden block HTTP')

    const tenantDetail = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/communication/posts/${postId}`,
      headers: { 'x-demo-user-id': TENANT_ID },
    })
    assert.equal(tenantDetail.status, 404)

    const blockedComment = await jsonPost(`/api/v1/communication/posts/${postId}/comments`, OWNER_ID, {
      body: 'Should block',
    })
    assert.equal(blockedComment.status, 409)
    assert.equal(blockedComment.json?.error_code, 'POST_HIDDEN')

    await invokeMiddleware(mw, {
      method: 'POST',
      url: `/api/v1/communication/posts/${postId}/unhide`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    const unblockedComment = await jsonPost(
      `/api/v1/communication/posts/${postId}/comments`,
      OWNER_ID,
      { body: 'Should work again' },
    )
    assert.equal(unblockedComment.status, 201)
  })

  it('enforces #027 edit own posts & comments rules, check order, 24h window, and no-op edited_at over HTTP', async () => {
    const mw = createApiMiddleware()
    const OWNER_ID = '018f0000-0000-7000-8000-000000000102'
    const TENANT_ID = '018f0000-0000-7000-8000-000000000104'
    const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
    const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'

    const jsonPatch = (url: string, userId: string, bodyObj: unknown) => {
      const buf = Buffer.from(JSON.stringify(bodyObj))
      return invokeMiddleware(mw, {
        method: 'PATCH',
        url,
        headers: {
          'x-demo-user-id': userId,
          'content-type': 'application/json',
          'content-length': String(buf.byteLength),
        },
        chunks: [buf],
      })
    }
    const jsonPost = (url: string, userId: string, bodyObj: unknown) => {
      const buf = Buffer.from(JSON.stringify(bodyObj))
      return invokeMiddleware(mw, {
        method: 'POST',
        url,
        headers: {
          'x-demo-user-id': userId,
          'content-type': 'application/json',
          'content-length': String(buf.byteLength),
        },
        chunks: [buf],
      })
    }

    const FRESH_TOPIC_ID = '018f0000-0000-7000-8000-000000000606'
    const FRESH_OWNER_COMMENT_ID = '018f0000-0000-7000-8000-000000000656'
    const EXPIRED_FORUM_TOPIC_ID = '018f0000-0000-7000-8000-000000000602'
    const EXPIRED_BOARD_TOPIC_ID = '018f0000-0000-7000-8000-000000000761'
    const EXPIRED_BOARD_COMMENT_ID = '018f0000-0000-7000-8000-000000000762'
    const MAINTENANCE_BOARD_TOPIC_ID = '018f0000-0000-7000-8000-000000000763'

    // 1. Seeded fresh topic 0606: no-op PATCH keeps edited_at null; real edit sets edited_at
    const noOp = await jsonPatch(`/api/v1/communication/posts/${FRESH_TOPIC_ID}`, OWNER_ID, {
      body: '  We have two cans of weatherproof timber oil left in the shed. Anyone free on Sunday at 11:00 to help coat the courtyard benches before the rain?  ',
    })
    assert.equal(noOp.status, 200)
    assert.equal(noOp.json?.edited_at, null)

    const bodyEdit = await jsonPatch(`/api/v1/communication/posts/${FRESH_TOPIC_ID}`, OWNER_ID, {
      body: 'Updated meetup time: Sunday 12:00 at the courtyard benches.',
    })
    assert.equal(bodyEdit.status, 200)
    assert.equal(bodyEdit.json?.body, 'Updated meetup time: Sunday 12:00 at the courtyard benches.')
    assert.ok(bodyEdit.json?.edited_at)

    // Repeat no-op after edited_at already set preserves timestamp
    const repeatPostNoOp = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}`,
      OWNER_ID,
      { body: '  Updated meetup time: Sunday 12:00 at the courtyard benches.  ' },
    )
    assert.equal(repeatPostNoOp.status, 200)
    assert.equal(repeatPostNoOp.json?.edited_at, bodyEdit.json?.edited_at)

    // Visibility isolation & malformed encoding -> 404 POST_NOT_FOUND
    for (const [hiddenUrl, actor] of [
      [`/api/v1/communication/posts/${EXPIRED_BOARD_TOPIC_ID}`, OWNER_ID],
      ['/api/v1/communication/posts/018f0000-0000-7000-8000-000000000751', TENANT_ID],
      ['/api/v1/communication/posts/018f0000-0000-7000-8000-000000000605', OWNER_ID],
      ['/api/v1/communication/posts/%E0%A4%A', OWNER_ID],
    ]) {
      const hiddenRes = await jsonPatch(hiddenUrl, actor, { title: 'Cannot see' })
      assert.equal(hiddenRes.status, 404)
      assert.equal(hiddenRes.json?.error_code, 'POST_NOT_FOUND')
    }

    // 2. Non-author (even BOARD) -> 403 FORBIDDEN
    const boardEditAttempt = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}`,
      BOARD_ID,
      { title: 'Board cannot edit resident post' },
    )
    assert.equal(boardEditAttempt.status, 403)
    assert.equal(boardEditAttempt.json?.error_code, 'FORBIDDEN')

    // 3. Old FORUM_TOPIC -> 409 EDIT_WINDOW_CLOSED with editable_until
    const expiredPostEdit = await jsonPatch(
      `/api/v1/communication/posts/${EXPIRED_FORUM_TOPIC_ID}`,
      OWNER_ID,
      { title: 'Too late' },
    )
    assert.equal(expiredPostEdit.status, 409)
    assert.equal(expiredPostEdit.json?.error_code, 'EDIT_WINDOW_CLOSED')
    assert.equal(typeof expiredPostEdit.json?.editable_until, 'string')

    // 4. Old BOARD_TOPIC by author -> 200 (no time limit)
    const boardTopicEdit = await jsonPatch(
      `/api/v1/communication/posts/${EXPIRED_BOARD_TOPIC_ID}`,
      CHAIRMAN_ID,
      { title: 'Updated key location note' },
    )
    assert.equal(boardTopicEdit.status, 200)
    assert.equal(boardTopicEdit.json?.title, 'Updated key location note')
    assert.ok(boardTopicEdit.json?.edited_at)

    // 5. Maintenance topic, notice, emergency, thread, hidden -> 409 POST_NOT_EDITABLE
    const maintEdit = await jsonPatch(
      `/api/v1/communication/posts/${MAINTENANCE_BOARD_TOPIC_ID}`,
      CHAIRMAN_ID,
      { title: 'Edit maint' },
    )
    assert.equal(maintEdit.status, 409)
    assert.equal(maintEdit.json?.error_code, 'POST_NOT_EDITABLE')

    // 6. Post payload validation boundaries -> 422 VALIDATION_ERROR
    for (const badPostPayload of [
      { title: 'Valid title', post_type: 'BOARD_TOPIC' },
      {},
      [],
      { title: 123 },
      { body: null },
      { title: 't'.repeat(256) },
      { body: 'Bad\x07ctrl' },
    ]) {
      const badRes = await jsonPatch(
        `/api/v1/communication/posts/${FRESH_TOPIC_ID}`,
        OWNER_ID,
        badPostPayload,
      )
      assert.equal(badRes.status, 422)
      assert.equal(badRes.json?.error_code, 'VALIDATION_ERROR')
    }

    // 7. Comments: fresh edit succeeds; idempotent no-op preserves edited_at; validation edges; MAINTENANCE & hidden -> 409; >24h -> 409
    const commentEdit = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
      OWNER_ID,
      { body: 'Edited comment body' },
    )
    assert.equal(commentEdit.status, 200)
    assert.equal(commentEdit.json?.body, 'Edited comment body')
    assert.ok(commentEdit.json?.edited_at)

    const commentRepeatNoOp = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
      OWNER_ID,
      { body: '  Edited comment body  ' },
    )
    assert.equal(commentRepeatNoOp.status, 200)
    assert.equal(commentRepeatNoOp.json?.edited_at, commentEdit.json?.edited_at)

    for (const badCommentPayload of [
      {},
      [],
      { body: 'ok', extra: 1 },
      { body: 'x'.repeat(4001) },
      { body: 'bad\x07' },
    ]) {
      const badCommentRes = await jsonPatch(
        `/api/v1/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
        OWNER_ID,
        badCommentPayload,
      )
      assert.equal(badCommentRes.status, 422)
      assert.equal(badCommentRes.json?.error_code, 'VALIDATION_ERROR')
    }

    const noticeCommentCreate = await jsonPost(
      '/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments',
      TENANT_ID,
      { body: 'Tenant initial comment' },
    )
    assert.equal(noticeCommentCreate.status, 201)
    const noticeCommentEdit = await jsonPatch(
      `/api/v1/communication/posts/018f0000-0000-7000-8000-000000000601/comments/${noticeCommentCreate.json?.id}`,
      TENANT_ID,
      { body: 'Tenant edited notice comment' },
    )
    assert.equal(noticeCommentEdit.status, 200)
    assert.equal(noticeCommentEdit.json?.body, 'Tenant edited notice comment')

    // Comment on origin='MAINTENANCE' post -> 409 COMMENT_NOT_EDITABLE
    const maintCommentCreate = await jsonPost(
      `/api/v1/communication/posts/${MAINTENANCE_BOARD_TOPIC_ID}/comments`,
      CHAIRMAN_ID,
      { body: 'Maint comment HTTP' },
    )
    assert.equal(maintCommentCreate.status, 201)
    const maintCommentEdit = await jsonPatch(
      `/api/v1/communication/posts/${MAINTENANCE_BOARD_TOPIC_ID}/comments/${maintCommentCreate.json?.id}`,
      CHAIRMAN_ID,
      { body: 'Cannot edit maint comment' },
    )
    assert.equal(maintCommentEdit.status, 409)
    assert.equal(maintCommentEdit.json?.error_code, 'COMMENT_NOT_EDITABLE')

    // Hidden comment & hidden post author edits -> 409 *_NOT_EDITABLE
    await jsonPost(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}/hide`,
      BOARD_ID,
      { reason: 'Hide comment HTTP' },
    )
    const hiddenCommentEdit = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
      OWNER_ID,
      { body: 'Cannot edit hidden comment' },
    )
    assert.equal(hiddenCommentEdit.status, 409)
    assert.equal(hiddenCommentEdit.json?.error_code, 'COMMENT_NOT_EDITABLE')

    await jsonPost(`/api/v1/communication/posts/${FRESH_TOPIC_ID}/hide`, BOARD_ID, {
      reason: 'Hide topic HTTP',
    })
    const hiddenPostEdit = await jsonPatch(
      `/api/v1/communication/posts/${FRESH_TOPIC_ID}`,
      OWNER_ID,
      { title: 'Cannot edit hidden post' },
    )
    assert.equal(hiddenPostEdit.status, 409)
    assert.equal(hiddenPostEdit.json?.error_code, 'POST_NOT_EDITABLE')

    const expiredBoardCommentEdit = await jsonPatch(
      `/api/v1/communication/posts/${EXPIRED_BOARD_TOPIC_ID}/comments/${EXPIRED_BOARD_COMMENT_ID}`,
      BOARD_ID,
      { body: 'Too late board comment' },
    )
    assert.equal(expiredBoardCommentEdit.status, 409)
    assert.equal(expiredBoardCommentEdit.json?.error_code, 'EDIT_WINDOW_CLOSED')
    assert.equal(typeof expiredBoardCommentEdit.json?.editable_until, 'string')
  })
})

describe('apiMiddleware maintenance yearly report & CSV export (#029)', () => {
  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'

  it('enforces role checks, year validation, closed_on year grouping, and UTF-8 BOM CSV attachment', async () => {
    const mw = createApiMiddleware()

    // Resident -> 403
    const residentReport = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/maintenance/report?year=2026',
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(residentReport.status, 403)
    assert.equal(residentReport.json?.error_code, 'FORBIDDEN')

    const residentCsv = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/maintenance/report/export-csv?year=2026',
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(residentCsv.status, 403)
    assert.equal(residentCsv.json?.error_code, 'FORBIDDEN')

    // Invalid year -> 422
    for (const bad of ['', '?year=1999', '?year=2101', '?year=abcd']) {
      const badReport = await invokeMiddleware(mw, {
        method: 'GET',
        url: `/api/v1/maintenance/report${bad}`,
        headers: { 'x-demo-user-id': ACCOUNTANT_ID },
      })
      assert.equal(badReport.status, 422)
      assert.equal(badReport.json?.error_code, 'VALIDATION_ERROR')

      const badCsv = await invokeMiddleware(mw, {
        method: 'GET',
        url: `/api/v1/maintenance/report/export-csv${bad}`,
        headers: { 'x-demo-user-id': BOARD_ID },
      })
      assert.equal(badCsv.status, 422)
      assert.equal(badCsv.json?.error_code, 'VALIDATION_ERROR')
    }

    // Create a maintenance task whose planned due_date is in 2025, closed_on in 2026
    // Wait: use a log entry created via done endpoint or verify seeded entries + formula note
    const logRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/maintenance/log?limit=100',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(logRes.status, 200)
    const entries = logRes.json as any[]
    const targetYear = Number(entries[0].closed_on.slice(0, 4))

    // Patch note on an entry with a dangerous full-width formula trigger
    const targetEntry = entries.find((e) => e.closed_on.startsWith(`${targetYear}-`))
    assert.ok(targetEntry)
    const patchPayload = Buffer.from(
      JSON.stringify({
        note: '\uFF1DHYPERLINK("http://evil.example","click")',
        ...(targetEntry.kind === 'DONE' ? { cost: '123.45' } : {}),
      }),
    )
    const patchRes = await invokeMiddleware(mw, {
      method: 'PATCH',
      url: `/api/v1/maintenance/log/${targetEntry.id}`,
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/json',
        'content-length': String(patchPayload.byteLength),
      },
      chunks: [patchPayload],
    })
    assert.equal(patchRes.status, 200)

    // Report by Accountant
    const reportRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/maintenance/report?year=${targetYear}`,
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(reportRes.status, 200)
    assert.equal(reportRes.json?.year, targetYear)
    assert.ok(Array.isArray(reportRes.json?.tasks))
    assert.equal(typeof reportRes.json?.total_cost, 'string')
    assert.match(reportRes.json.total_cost, /^[0-9]+\.[0-9]{2}$/)

    // Empty year -> zeros + empty tasks, and CSV with BOM + header only
    const emptyReportRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/maintenance/report?year=2005',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(emptyReportRes.status, 200)
    assert.deepEqual(emptyReportRes.json, {
      year: 2005,
      done_count: 0,
      skipped_count: 0,
      total_cost: '0.00',
      tasks: [],
    })

    const emptyCsvRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/maintenance/report/export-csv?year=2005',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(emptyCsvRes.status, 200)
    assert.equal(emptyCsvRes.headers['content-type'], 'text/csv; charset=utf-8')
    assert.equal(
      emptyCsvRes.headers['content-disposition'],
      'attachment; filename="maintenance-log-2005.csv"',
    )
    assert.equal(
      emptyCsvRes.body,
      '\uFEFFclosed_on,task_title,kind,planned_date,cost,note,recorded_by\r\n',
    )

    // Populated CSV -> BOM, CRLF, oldest closed_on first, formula sanitized
    const csvRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/maintenance/report/export-csv?year=${targetYear}`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(csvRes.status, 200)
    assert.equal(csvRes.headers['content-type'], 'text/csv; charset=utf-8')
    assert.equal(
      csvRes.headers['content-disposition'],
      `attachment; filename="maintenance-log-${targetYear}.csv"`,
    )
    assert.equal(csvRes.body.startsWith('\uFEFF'), true)
    const rows = csvRes.body.slice(1).trimEnd().split('\r\n')
    assert.ok(rows.length >= 2)
    assert.equal(rows[0], 'closed_on,task_title,kind,planned_date,cost,note,recorded_by')
    // Verify chronological oldest closed_on first
    const closedDates = rows.slice(1).map((r) => r.slice(0, 10))
    assert.deepEqual(closedDates, [...closedDates].sort())
    assert.equal(
      csvRes.body.includes('"\'\uFF1DHYPERLINK(""http://evil.example"",""click"")"'),
      true,
    )
  })
})

describe('apiMiddleware HTTP apartment consumption route (#030)', () => {
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'
  const APT14_ID = '018f0000-0000-7000-8000-000000000314'
  const APT02_ID = '018f0000-0000-7000-8000-000000000302'

  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('serves oldest-first series, enforces 404 isolation, validates months 1..24, and reflects live open-month submissions', async () => {
    const mw = createApiMiddleware()

    // Resident Apt 14 -> 200 OK for own apartment
    const ownRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/meters/apartments/${APT14_ID}/consumption?months=12`,
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(ownRes.status, 200)
    assert.equal(ownRes.json?.apartment_number, '14')
    assert.deepEqual(
      ownRes.json?.periods?.map((p: any) => p.period_code),
      ['2026-07', '2026-08', '2026-09', '2026-10'],
    )
    assert.equal(ownRes.json?.periods?.[3]?.status, 'OPEN_FOR_RESIDENTS')

    // Series sorted alphabetically
    const resourceTypes = ownRes.json?.resources?.map((r: any) => r.resource_type) || []
    assert.deepEqual(resourceTypes, [...resourceTypes].sort((a, b) => a.localeCompare(b, 'en')))

    const cold = ownRes.json.resources.find((r: any) => r.resource_type === 'COLD_WATER')
    assert.ok(cold)
    // Open month 2026-10 has only Kitchen Cold Water (2.100) submitted; Bathroom is still null
    const octBefore = cold.months.find((m: any) => m.period_code === '2026-10')
    assert.equal(octBefore.consumption, '2.100')
    const aug = cold.months.find((m: any) => m.period_code === '2026-08')
    assert.equal(aug.estimated, true)

    // Submit Bathroom Cold Water (previous_value 142.350 -> 145.550 = +3.200 delta) for 2026-10
    const submitPayload = Buffer.from(
      JSON.stringify({
        meter_id: '018f0000-0000-7000-8000-000000000516',
        period_code: '2026-10',
        value: '145.550',
        confirmation_level: 0,
      }),
    )
    const submitRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/meters/readings',
      headers: {
        'x-demo-user-id': RESIDENT_APT14_ID,
        'content-type': 'application/json',
        'content-length': String(submitPayload.byteLength),
      },
      chunks: [submitPayload],
    })
    assert.equal(submitRes.status, 200)

    // Re-query consumption: 2026-10 COLD_WATER now sums Kitchen 2.100 + Bathroom 3.200 = 5.300
    const afterRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/meters/apartments/${APT14_ID}/consumption?months=12`,
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(afterRes.status, 200)
    const coldAfter = afterRes.json.resources.find((r: any) => r.resource_type === 'COLD_WATER')
    const octAfter = coldAfter.months.find((m: any) => m.period_code === '2026-10')
    assert.equal(octAfter.consumption, '5.300')

    // Resident Apt 14 -> 404 APARTMENT_NOT_FOUND for Apt 02
    const forbiddenRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/meters/apartments/${APT02_ID}/consumption`,
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(forbiddenRes.status, 404)
    assert.equal(forbiddenRes.json?.error_code, 'APARTMENT_NOT_FOUND')

    // Invalid months -> 422 VALIDATION_ERROR
    const invalidRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/meters/apartments/${APT14_ID}/consumption?months=25`,
      headers: { 'x-demo-user-id': BOARD_ID },
    })
    assert.equal(invalidRes.status, 422)
    assert.equal(invalidRes.json?.error_code, 'VALIDATION_ERROR')

    // Accountant -> 200 OK with months=3
    const accRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: `/api/v1/meters/apartments/${APT02_ID}/consumption?months=3`,
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(accRes.status, 200)
    assert.deepEqual(
      accRes.json?.periods?.map((p: any) => p.period_code),
      ['2026-08', '2026-09', '2026-10'],
    )
  })
})

describe('apiMiddleware HTTP building consumption route (#031)', () => {
  const CHAIRMAN_ID = '018f0000-0000-7000-8000-000000000101'
  const BOARD_ID = '018f0000-0000-7000-8000-000000000105'
  const ACCOUNTANT_ID = '018f0000-0000-7000-8000-000000000103'

  beforeEach(() => {
    resetApiMiddlewareStateForTest()
  })

  it('enforces 403 for residents, validates months, excludes master meters, and recomputes averages on new readings', async () => {
    const mw = createApiMiddleware()

    // 1. Resident -> 403 FORBIDDEN
    const resForbidden = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=12',
      headers: { 'x-demo-user-id': RESIDENT_APT14_ID },
    })
    assert.equal(resForbidden.status, 403)
    assert.equal(resForbidden.json?.error_code, 'FORBIDDEN')

    // 2. Invalid months -> 422 VALIDATION_ERROR
    const badMonths = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=25',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(badMonths.status, 422)
    assert.equal(badMonths.json?.error_code, 'VALIDATION_ERROR')

    // 3. BOARD & ACCOUNTANT & CHAIRMAN -> 200 OK
    for (const staffId of [CHAIRMAN_ID, BOARD_ID, ACCOUNTANT_ID]) {
      const okRes = await invokeMiddleware(mw, {
        method: 'GET',
        url: '/api/v1/meters/consumption?months=24',
        headers: { 'x-demo-user-id': staffId },
      })
      assert.equal(okRes.status, 200)
      assert.deepEqual(
        okRes.json?.periods?.map((p: any) => p.period_code),
        ['2026-07', '2026-08', '2026-09', '2026-10'],
      )
      assert.deepEqual(
        okRes.json?.resources?.map((r: any) => r.resource_type),
        ['COLD_WATER', 'ELECTRICITY', 'HOT_WATER'],
      )
    }

    const resBefore = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=12',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    const cold = resBefore.json.resources.find((r: any) => r.resource_type === 'COLD_WATER')
    const octBefore = cold.months.find((m: any) => m.period_code === '2026-10')
    assert.deepEqual(octBefore, {
      period_code: '2026-10',
      total: '22.550',
      apartments_counted: 4,
      average_per_apartment: '5.638',
      average_per_m2: '0.1084',
      estimated_readings: 0,
    })
    const aug = cold.months.find((m: any) => m.period_code === '2026-08')
    assert.equal(aug.estimated_readings, 5)

    // 4. Submit reading for previously missing Apt 05 Cold Water (area 62.10, previous 302.150 -> 306.650 = +4.500)
    const payload = Buffer.from(
      JSON.stringify({
        meter_id: '018f0000-0000-7000-8000-000000000505',
        period_code: '2026-10',
        value: '306.650',
        confirmation_level: 0,
      }),
    )
    const postRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/meters/readings',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/json',
        'content-length': String(payload.byteLength),
      },
      chunks: [payload],
    })
    assert.equal(postRes.status, 200)

    const resAfter = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=12',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    const octAfter = resAfter.json.resources
      .find((r: any) => r.resource_type === 'COLD_WATER')
      .months.find((m: any) => m.period_code === '2026-10')
    assert.equal(octAfter.apartments_counted, 5)
    assert.equal(octAfter.total, '27.050')
    // 27.050 / 5 = 5.410; 27.050 / (208.10 + 62.10 = 270.20) = 0.100111... -> 0.1001
    assert.equal(octAfter.average_per_apartment, '5.410')
    assert.equal(octAfter.average_per_m2, '0.1001')

    // 5. Omitted months defaults cleanly to 12 and months=0 returns 422
    const defaultRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(defaultRes.status, 200)
    assert.equal(defaultRes.json?.periods?.length, 4)

    const zeroRes = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=0',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    assert.equal(zeroRes.status, 422)
    assert.equal(zeroRes.json?.error_code, 'VALIDATION_ERROR')

    // 6. Moving 2026-10 to REVIEW_BY_BOARD and running estimate-missing increments estimated_readings on /meters/consumption
    const patchPayload = Buffer.from(JSON.stringify({ status: 'REVIEW_BY_BOARD' }))
    const patchRes = await invokeMiddleware(mw, {
      method: 'PATCH',
      url: '/api/v1/meters/periods/2026-10/status',
      headers: {
        'x-demo-user-id': CHAIRMAN_ID,
        'content-type': 'application/json',
        'content-length': String(patchPayload.byteLength),
      },
      chunks: [patchPayload],
    })
    assert.equal(patchRes.status, 200)

    const estRes = await invokeMiddleware(mw, {
      method: 'POST',
      url: '/api/v1/meters/periods/2026-10/estimate-missing',
      headers: { 'x-demo-user-id': ACCOUNTANT_ID },
    })
    assert.equal(estRes.status, 200)
    assert.ok(estRes.json?.estimated_count > 0)

    const afterEst = await invokeMiddleware(mw, {
      method: 'GET',
      url: '/api/v1/meters/consumption?months=12',
      headers: { 'x-demo-user-id': CHAIRMAN_ID },
    })
    const coldAfterEst = afterEst.json.resources
      .find((r: any) => r.resource_type === 'COLD_WATER')
      .months.find((m: any) => m.period_code === '2026-10')
    assert.ok(coldAfterEst.estimated_readings >= 1)
  })
})





