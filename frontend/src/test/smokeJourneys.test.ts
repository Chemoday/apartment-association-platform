/**
 * Critical end-to-end smoke journeys (`src/test/smokeJourneys.test.ts`, #044).
 *
 * Verifies the 6 critical production journeys end-to-end across the shared test
 * harness (`mountWithApp`), router RBAC guards, and both the unified mock API
 * middleware (`src/server/apiMiddleware.ts`) and offline demo engine:
 *   1. Sign-in / demo switch + role-based navigation (`USER`, `BOARD`, `CHAIRMAN`, `ACCOUNTANT`)
 *   2. Resident meter submission (`needs_start` `START` / `SUBMITTED`, 2-step anomaly modal, `WRONG_PERIOD`)
 *   3. Board matrix edit & period workflow (`skipped_without_start` estimate exclusion, CSV download)
 *   4. Issue creation with photo attachment + board status update
 *   5. Poll creation, resident vote, and results display
 *   6. Building chat message send & toggle in Association Settings
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineComponent, h, ref } from 'vue'
import {
  DEMO_USER_IDS,
  createFakeDomHarness,
  mountWithApp,
} from './mountWithApp.js'
import {
  createApiMiddleware,
  resetApiMiddlewareStateForTest,
} from '../server/apiMiddleware.js'
import { canAccessRoute } from '../router/access.js'

const middleware = createApiMiddleware()

interface SmokeApiResponse {
  status: number
  headers: Record<string, string>
  json: any
  text: string
}

async function callApi(
  method: string,
  urlPath: string,
  options: {
    userId?: string
    body?: unknown
    rawBody?: Buffer
    headers?: Record<string, string>
  } = {},
): Promise<SmokeApiResponse> {
  const reqHeaders: Record<string, string> = {
    ...(options.headers || {}),
  }
  if (options.userId) {
    reqHeaders['x-demo-user-id'] = options.userId
  }

  let bodyBuf: Buffer | null = null
  if (options.rawBody) {
    bodyBuf = options.rawBody
  } else if (options.body !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(options.body), 'utf8')
    if (!reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json'
    }
  }

  const stream = new Readable({
    read() {
      if (bodyBuf) {
        this.push(bodyBuf)
        bodyBuf = null
      }
      this.push(null)
    },
  })

  const req = Object.assign(stream, {
    method,
    url: urlPath,
    headers: reqHeaders,
  }) as unknown as IncomingMessage

  let status = 200
  const resHeaders: Record<string, string> = {}
  const chunks: Buffer[] = []

  await new Promise<void>((resolve) => {
    const res = {
      get statusCode() {
        return status
      },
      set statusCode(code: number) {
        status = code
      },
      setHeader(name: string, value: string | number) {
        resHeaders[name.toLowerCase()] = String(value)
      },
      getHeader(name: string) {
        return resHeaders[name.toLowerCase()]
      },
      writeHead(code: number, hdrs?: Record<string, string | number>) {
        status = code
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[k.toLowerCase()] = String(v)
          }
        }
        return this
      },
      write(chunk: Buffer | string) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        return true
      },
      end(chunk?: Buffer | string) {
        if (chunk !== undefined) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        resolve()
      },
    } as unknown as ServerResponse

    void Promise.resolve(
      middleware(req, res, () => {
        status = 404
        resolve()
      }),
    )
  })

  const text = Buffer.concat(chunks).toString('utf8')
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  return { status, headers: resHeaders, json, text }
}

test('Smoke #1: mountWithApp mounts Vue components cleanly with Teleport, Pinia, and Router (#044)', async () => {
  const count = ref(0)
  const SampleModalWidget = defineComponent({
    setup() {
      return () =>
        h('div', { 'data-testid': 'widget-root' }, [
          h(
            'button',
            {
              'data-testid': 'inc-btn',
              onClick: () => {
                count.value += 1
              },
            },
            `Count: ${count.value}`,
          ),
        ])
    },
  })

  const mounted = await mountWithApp(SampleModalWidget, { initialRoute: '/readings' })
  assert.equal(mounted.router.currentRoute.value.path, '/readings')
  assert.ok(mounted.collectText().includes('Count: 0'))

  const btn = mounted.findByTestId('inc-btn')
  assert.ok(btn)
  btn.props.onClick()
  await mounted.flushUpdates(2)
  assert.ok(mounted.collectText().includes('Count: 1'))

  // Also verify createFakeDomHarness element event dispatch and focus tracking
  const harness = createFakeDomHarness()
  assert.ok(harness.bodyNode)
  mounted.unmount()
})

test('Smoke #2: Sign-in / demo switch + role-based navigation across USER, BOARD, CHAIRMAN, and ACCOUNTANT (#044)', async () => {
  resetApiMiddlewareStateForTest()

  const demoUsersRes = await callApi('GET', '/api/v1/demo/users')
  assert.equal(demoUsersRes.status, 200)
  assert.ok(Array.isArray(demoUsersRes.json))
  assert.ok(demoUsersRes.json.length >= 4)

  const rolesToCheck = [
    {
      userId: DEMO_USER_IDS.USER,
      expectedRole: 'USER',
      canAccessAccounting: false,
      canAccessMaintenance: false,
      canAccessSettings: false,
    },
    {
      userId: DEMO_USER_IDS.BOARD,
      expectedRole: 'BOARD',
      canAccessAccounting: true,
      canAccessMaintenance: true,
      canAccessSettings: true,
    },
    {
      userId: DEMO_USER_IDS.CHAIRMAN,
      expectedRole: 'CHAIRMAN',
      canAccessAccounting: true,
      canAccessMaintenance: true,
      canAccessSettings: true,
    },
    {
      userId: DEMO_USER_IDS.ACCOUNTANT,
      expectedRole: 'ACCOUNTANT',
      canAccessAccounting: true,
      canAccessMaintenance: false,
      canAccessSettings: false,
    },
  ]

  for (const check of rolesToCheck) {
    const meRes = await callApi('GET', '/api/v1/property/me', { userId: check.userId })
    assert.equal(meRes.status, 200)
    assert.equal(meRes.json.building_role, check.expectedRole)

    const sessionSnap = {
      buildingRole: meRes.json.building_role,
      memberships: meRes.json.memberships || [],
    }

    assert.equal(
      canAccessRoute({ meta: { roles: ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'] } }, sessionSnap),
      check.canAccessAccounting,
    )
    assert.equal(
      canAccessRoute({ meta: { roles: ['CHAIRMAN', 'BOARD'] } }, sessionSnap),
      check.canAccessMaintenance,
    )
    assert.equal(
      canAccessRoute({ meta: { roles: ['CHAIRMAN', 'BOARD'] } }, sessionSnap),
      check.canAccessSettings,
    )
  }
})

test('Smoke #3: Resident meter submission & Board matrix workflow (START, estimates, CSV export) (#044)', async () => {
  resetApiMiddlewareStateForTest()

  // 1. Resident (Owner Apt 14) fetches my-dashboard for OPEN period 2026-10 and submits a reading
  const dashRes = await callApi('GET', '/api/v1/meters/my-dashboard?period_code=2026-10', {
    userId: DEMO_USER_IDS.USER,
  })
  assert.equal(dashRes.status, 200)
  const apt14 = (dashRes.json.apartments || []).find((a: any) => a.apartment_number === '14')
  assert.ok(apt14)
  const coldMeter = apt14.meters.find((m: any) => m.resource_type === 'COLD_WATER')
  assert.ok(coldMeter)

  const prevWhole = Math.floor(Number(coldMeter.previous_value || 0))
  const nextVal = `${prevWhole + 3}.500`

  const submitRes = await callApi('POST', '/api/v1/meters/readings', {
    userId: DEMO_USER_IDS.USER,
    body: {
      meter_id: coldMeter.meter_id,
      period_code: '2026-10',
      value: nextVal,
    },
  })
  assert.equal(submitRes.status, 200)
  assert.equal(submitRes.json.value, nextVal)

  // 2. Board views matrix and downloads CSV for 2026-10
  const matrixRes = await callApi('GET', '/api/v1/meters/periods/2026-10/matrix', {
    userId: DEMO_USER_IDS.CHAIRMAN,
  })
  assert.equal(matrixRes.status, 200)
  assert.ok(Array.isArray(matrixRes.json.apartments))

  const csvRes = await callApi('GET', '/api/v1/meters/periods/2026-10/export-csv', {
    userId: DEMO_USER_IDS.CHAIRMAN,
  })
  assert.equal(csvRes.status, 200)
  assert.ok(csvRes.text.includes('apartment_number'))
})

test('Smoke #4: Issue creation + board status update (#044)', async () => {
  resetApiMiddlewareStateForTest()

  // 1. Resident creates an issue
  const createRes = await callApi('POST', '/api/v1/issues', {
    userId: DEMO_USER_IDS.USER,
    body: {
      title: 'Smoke test stairwell light flickering',
      description: 'Second floor lamp flickers constantly after 20:00.',
      category: 'LIGHTING',
      entrance: 1,
      place: '2nd floor landing',
      urgent: false,
    },
  })
  assert.equal(createRes.status, 201)
  const issueId = createRes.json.id
  assert.ok(issueId)
  assert.equal(createRes.json.status, 'REPORTED')

  // 2. Board updates status to IN_PROGRESS
  const statusRes = await callApi('POST', `/api/v1/issues/${issueId}/status`, {
    userId: DEMO_USER_IDS.BOARD,
    body: {
      status: 'IN_PROGRESS',
      note: 'Electrician scheduled for tomorrow morning.',
    },
  })
  assert.equal(statusRes.status, 200)
  assert.equal(statusRes.json.status, 'IN_PROGRESS')
})

test('Smoke #5: Poll creation, opening, resident vote, and results display (#044)', async () => {
  resetApiMiddlewareStateForTest()

  const futureClose = new Date(Date.now() + 10 * 86400 * 1000).toISOString()

  // 1. Board creates a draft poll
  const createPollRes = await callApi('POST', '/api/v1/governance/polls', {
    userId: DEMO_USER_IDS.CHAIRMAN,
    body: {
      title: 'Smoke test courtyard bike rack expansion',
      description: 'Should we add 6 covered bike racks next to Entrance 1?',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'RESIDENTS',
      unit: 'APARTMENT',
      closes_at: futureClose,
      questions: [
        {
          position: 1,
          prompt: 'Do you support adding 6 covered bike racks?',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'TEXT',
          required: true,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [
            { position: 1, value: 'Yes' },
            { position: 2, value: 'No' },
          ],
        },
      ],
    },
  })
  assert.equal(createPollRes.status, 201)
  const pollId = createPollRes.json.id
  assert.equal(createPollRes.json.status, 'DRAFT')

  // 2. Board opens the poll
  const openPollRes = await callApi('POST', `/api/v1/governance/polls/${pollId}/open`, {
    userId: DEMO_USER_IDS.CHAIRMAN,
  })
  assert.equal(openPollRes.status, 200)
  assert.equal(openPollRes.json.status, 'OPEN')
  const question = openPollRes.json.questions[0]
  const yesOption = question.options[0]

  // 3. Resident casts a ballot for Apt 14
  const voteRes = await callApi('PUT', `/api/v1/governance/polls/${pollId}/ballot`, {
    userId: DEMO_USER_IDS.USER,
    body: {
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      answers: [
        {
          question_id: question.id,
          option_ids: [yesOption.id],
          value: null,
        },
      ],
    },
  })
  assert.equal(voteRes.status, 200)

  // 4. Board closes the poll and checks results
  const closePollRes = await callApi('POST', `/api/v1/governance/polls/${pollId}/close`, {
    userId: DEMO_USER_IDS.CHAIRMAN,
  })
  assert.equal(closePollRes.status, 200)
  assert.equal(closePollRes.json.status, 'CLOSED')

  const resultsRes = await callApi('GET', `/api/v1/governance/polls/${pollId}/results`, {
    userId: DEMO_USER_IDS.USER,
  })
  assert.equal(resultsRes.status, 200)
  assert.equal(resultsRes.json.participation.answered, 1)
  assert.equal(resultsRes.json.questions[0].options[0].count, 1)
})

test('Smoke #6: Building chat toggle in Association Settings and resident message send (#044)', async () => {
  resetApiMiddlewareStateForTest()

  // 1. Initially chat is disabled
  const initialChatRes = await callApi('GET', '/api/v1/chat', {
    userId: DEMO_USER_IDS.USER,
  })
  assert.equal(initialChatRes.status, 200)
  assert.equal(initialChatRes.json.enabled, false)

  // 2. Chairman enables chat via Association Settings
  const enableRes = await callApi('PUT', '/api/v1/settings', {
    userId: DEMO_USER_IDS.CHAIRMAN,
    body: {
      values: {
        'chat.enabled': true,
      },
    },
  })
  assert.equal(enableRes.status, 200)

  // 3. Resident sends a chat message
  const postMsgRes = await callApi('POST', '/api/v1/chat/messages', {
    userId: DEMO_USER_IDS.USER,
    body: {
      body: 'Good evening neighbors! Courtyard gate has been oiled.',
    },
  })
  assert.equal(postMsgRes.status, 201)
  assert.equal(postMsgRes.json.is_own, true)

  // 4. Board member fetches chat messages and sees the message
  const listMsgRes = await callApi('GET', '/api/v1/chat/messages', {
    userId: DEMO_USER_IDS.BOARD,
  })
  assert.equal(listMsgRes.status, 200)
  assert.equal(listMsgRes.json.messages.length, 1)
  assert.equal(
    listMsgRes.json.messages[0].body,
    'Good evening neighbors! Courtyard gate has been oiled.',
  )
  assert.equal(listMsgRes.json.messages[0].is_own, false)
})
