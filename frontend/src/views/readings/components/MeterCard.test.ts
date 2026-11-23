import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import {
  createClientVueViteServer,
  createFakeDomHarness,
  type VTestNode,
} from '../../../test/mountWithApp.js'

test('MeterCard handles needs_start first reading, START/SUBMITTED display, null serial_number, prefill/clear/omit, no client floor, anomaly flow, and error codes (#038)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, bodyNode, collectText, findAll, findByTestId, flushUpdates } =
    createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  ;(globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    location: { search: '' },
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: MeterCard } = await vite.ssrLoadModule(
      '/src/views/readings/components/MeterCard.vue',
    )

    const postedBodies: Array<Record<string, any>> = []
    let nextResponseQueue: Array<{ status: number; body: any }> = []

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.endsWith('/api/v1/meters/readings') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}'))
        postedBodies.push(parsed)
        const queued = nextResponseQueue.shift()
        if (queued) {
          return new Response(JSON.stringify(queued.body), {
            status: queued.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        const currentOrigin = meterRef.value?.next_submission?.reading?.previous_origin
        const resolvedOrigin =
          typeof parsed.previous_value === 'string'
            ? 'SUBMITTED'
            : parsed.previous_value === null
              ? 'START'
              : currentOrigin === 'SUBMITTED'
                ? 'SUBMITTED'
                : 'START'
        return new Response(
          JSON.stringify({
            reading_id: 'r-ok',
            meter_id: parsed.meter_id,
            period_code: parsed.period_code,
            value: parsed.value,
            consumption_delta:
              resolvedOrigin === 'SUBMITTED' ? '7.500' : '0.000',
            source: 'RESIDENT',
            is_anomaly_confirmed: false,
            previous_origin: resolvedOrigin,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const meterRef = ref<any>({
      meter_id: '018f0000-0000-7000-8000-000000000519',
      resource_type: 'HOT_WATER',
      serial_number: null,
      location_label: 'Laundry Hot Water',
      unit: 'm3',
      previous_value: null,
      needs_start: true,
      previous_delta: null,
      average_delta: null,
      reading: null,
      next_submission: {
        period_code: '2026-11',
        due_date: '2026-12-04T21:59:59Z',
        final: false,
        previous_value: null,
        needs_start: true,
        average_delta: null,
        reading: null,
      },
    })

    const savedEvents: any[] = []
    const Root = defineComponent({
      setup() {
        return () =>
          h(MeterCard, {
            meter: meterRef.value,
            periodCode: '2026-11',
            periodStatus: 'OPEN_FOR_RESIDENTS',
            canSubmit: true,
            useNextSubmission: true,
            onSaved: (payload: any) => savedEvents.push(payload),
          })
      },
    })

    const pinia = createPinia()
    const app = createApp(Root)
    app.use(pinia)
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    const session = useSessionStore(pinia)
    session.lang = 'en'
    session.profile = { building_role: 'USER' }

    const container: VTestNode = {
      kind: 'element',
      tag: 'div',
      props: {},
      children: [],
      parentNode: null,
    }
    app.mount(container)
    await flushUpdates()

    // 1. Fresh needs_start meter with null serial_number:
    //    - Renders bill field + exact help text + no-start label
    //    - Never renders "null" or "#null"
    assert.equal(findByTestId(container, 'meter-serial-number'), null)
    const initialText = collectText(container)
    assert.equal(initialText.includes('null'), false, `Unexpected "null" in: ${initialText}`)
    assert.equal(initialText.includes('#null'), false)
    assert.ok(findByTestId(container, 'meter-no-start-yet'))
    const billSection = findByTestId(container, 'meter-bill-previous-section')
    assert.ok(billSection)
    assert.ok(collectText(billSection).includes('Reading on your last bill'))
    const billHelp = findByTestId(container, 'meter-bill-previous-help')
    assert.ok(billHelp)
    assert.ok(
      collectText(billHelp).includes(
        'If you do not know it, leave it empty: this month will count as the start of your meter.',
      ),
    )

    // 2. Submitting first reading with empty bill field omits `previous_value`
    const curInput = findByTestId(container, 'meter-current-input')!
    curInput.props.onInput({ target: { value: '1250' } })
    await flushUpdates()
    const saveBtn = findByTestId(container, 'meter-save-btn')!
    await saveBtn.props.onClick()
    await flushUpdates()

    assert.equal(postedBodies.length, 1)
    assert.equal(postedBodies[0].value, '1250')
    assert.equal('previous_value' in postedBodies[0], false)
    assert.equal(savedEvents.length, 1)

    // 3. After START reading exists: shows START label, bill field stays EMPTY, downward correction NOT blocked
    meterRef.value = {
      ...meterRef.value,
      previous_value: '1250.000',
      reading: {
        reading_id: 'r-start',
        value: '1250.000',
        previous_value: '1250.000',
        consumption_delta: '0.000',
        source: 'RESIDENT',
        is_anomaly_confirmed: false,
        previous_origin: 'START',
      },
      next_submission: {
        ...meterRef.value.next_submission,
        previous_value: '1250.000',
        needs_start: true,
        reading: {
          reading_id: 'r-start',
          value: '1250.000',
          previous_value: '1250.000',
          consumption_delta: '0.000',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'START',
        },
      },
    }
    await flushUpdates()

    const originStartEl = findByTestId(container, 'meter-origin-start')
    assert.ok(originStartEl)
    assert.ok(
      collectText(originStartEl).includes('Start of the meter (no consumption this month)'),
    )
    const billInputAfterStart = findByTestId(container, 'meter-bill-previous-input')!
    assert.equal(billInputAfterStart.props.value, '')

    // Lower mistyped 1250 -> 125: client MUST NOT block below previous_value on needs_start
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '125' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 2)
    assert.equal(postedBodies[1].value, '125')
    assert.equal('previous_value' in postedBodies[1], false)

    // 4. Invalid bill field input blocks locally without posting
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({
      target: { value: 'not-a-number' },
    })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 2)
    assert.ok(findByTestId(container, 'meter-bill-previous-error'))

    // 5. Existing SUBMITTED reading: shows "Start from the last bill", prefills bill input
    meterRef.value = {
      ...meterRef.value,
      previous_value: '120.500',
      reading: {
        reading_id: 'r-sub',
        value: '125.000',
        previous_value: '120.500',
        consumption_delta: '4.500',
        source: 'RESIDENT',
        is_anomaly_confirmed: false,
        previous_origin: 'SUBMITTED',
      },
      next_submission: {
        ...meterRef.value.next_submission,
        previous_value: '120.500',
        needs_start: true,
        reading: {
          reading_id: 'r-sub',
          value: '125.000',
          previous_value: '120.500',
          consumption_delta: '4.500',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'SUBMITTED',
        },
      },
    }
    await flushUpdates()

    const originSubEl = findByTestId(container, 'meter-origin-submitted')
    assert.ok(originSubEl)
    assert.ok(collectText(originSubEl).includes('Start from the last bill'))
    assert.ok(collectText(originSubEl).includes('120.500'))
    assert.equal(findByTestId(container, 'meter-bill-previous-input')!.props.value, '120.500')

    // 6. Untouched prefilled bill field: correcting current reading OMITS previous_value
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '128' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 3)
    assert.equal(postedBodies[2].value, '128')
    assert.equal('previous_value' in postedBodies[2], false)

    // 7. Value below bill's previous_value is sent to server (no client floor), and 422 READING_BELOW_PREVIOUS renders translated message
    nextResponseQueue.push({
      status: 422,
      body: {
        error_code: 'READING_BELOW_PREVIOUS',
        message: 'Value too low',
        previous_value: '120.500',
      },
    })
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '110' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 4)
    assert.equal(postedBodies[3].value, '110')
    const belowErrEl = findByTestId(container, 'meter-error-message')
    assert.ok(belowErrEl)
    assert.ok(collectText(belowErrEl).includes('120.500'))

    // 8. Clearing a prefilled bill field sends EXPLICIT `previous_value: null`
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({ target: { value: '' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 5)
    assert.equal(postedBodies[4].value, '110')
    assert.equal('previous_value' in postedBodies[4], true)
    assert.equal(postedBodies[4].previous_value, null)

    // 9. Anomaly 2-step confirmation preserves entered `previous_value` across level 0 -> 1 -> 2
    nextResponseQueue.push(
      {
        status: 409,
        body: {
          error_code: 'ANOMALY_CONFIRMATION_STEP_1',
          consumption_delta: '140.000',
          average_delta: null,
          max_reasonable_delta: '15.000',
        },
      },
      {
        status: 409,
        body: {
          error_code: 'ANOMALY_CONFIRMATION_STEP_2',
          consumption_delta: '140.000',
        },
      },
      {
        status: 200,
        body: {
          reading_id: 'r-anom',
          meter_id: meterRef.value.meter_id,
          period_code: '2026-11',
          value: '150.000',
          consumption_delta: '140.000',
          source: 'RESIDENT',
          is_anomaly_confirmed: true,
          previous_origin: 'SUBMITTED',
        },
      },
    )
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '150' } })
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({ target: { value: '10' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()

    // Step 1 popup open in bodyNode
    assert.equal(postedBodies.length, 6)
    assert.equal(postedBodies[5].confirmation_level, 0)
    assert.equal(postedBodies[5].previous_value, '10')

    const step1Confirm = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.tag === 'button' && collectText(n).includes('Yes'),
    )[0]
    assert.ok(step1Confirm, 'Expected anomaly step 1 confirm button')
    await step1Confirm.props.onClick()
    await flushUpdates()

    assert.equal(postedBodies.length, 7)
    assert.equal(postedBodies[6].confirmation_level, 1)
    assert.equal(postedBodies[6].previous_value, '10')

    const step2Confirm = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.tag === 'button' && collectText(n).includes('Confirm'),
    )[0]
    assert.ok(step2Confirm, 'Expected anomaly step 2 confirm button')
    await step2Confirm.props.onClick()
    await flushUpdates()

    assert.equal(postedBodies.length, 8)
    assert.equal(postedBodies[7].confirmation_level, 2)
    assert.equal(postedBodies[7].previous_value, '10')

    // 10. Normal meter (needs_start: false): hides bill field, shows serial, omits previous_value, translates PREVIOUS_VALUE_NOT_ALLOWED
    meterRef.value = {
      meter_id: '018f0000-0000-7000-8000-000000000516',
      resource_type: 'COLD_WATER',
      serial_number: 'CW-1429-B',
      location_label: 'Bathroom Cold Water',
      unit: 'm3',
      previous_value: '142.350',
      needs_start: false,
      previous_delta: '3.200',
      average_delta: '3.200',
      reading: null,
      next_submission: {
        period_code: '2026-11',
        due_date: '2026-12-04T21:59:59Z',
        final: false,
        previous_value: '142.350',
        needs_start: false,
        average_delta: '3.200',
        reading: null,
      },
    }
    await flushUpdates()

    assert.equal(findByTestId(container, 'meter-bill-previous-section'), null)
    const serialEl = findByTestId(container, 'meter-serial-number')
    assert.ok(serialEl)
    assert.ok(collectText(serialEl).includes('#CW-1429-B'))

    nextResponseQueue.push({
      status: 422,
      body: {
        error_code: 'PREVIOUS_VALUE_NOT_ALLOWED',
        message: 'previous_value is not allowed',
      },
    })
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '145' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()

    assert.equal(postedBodies.length, 9)
    assert.equal('previous_value' in postedBodies[8], false)
    const notAllowedEl = findByTestId(container, 'meter-error-message')
    assert.ok(notAllowedEl)
    assert.ok(
      collectText(notAllowedEl).includes(
        'A starting reading from the last bill cannot be set for this meter.',
      ),
    )

    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})

test('MeterCard CTO audit regressions: WRONG_PERIOD bill draft, stale submit guard, localSavedBaseline, anomaly external reset, period change reset, VALIDATION_ERROR field map, and GAS i18n (P1-1..P1-3, P2-4, P2-5)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, bodyNode, collectText, findAll, findByTestId, flushUpdates } =
    createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  ;(globalThis as any).window = {
    addEventListener() {},
    removeEventListener() {},
    location: { search: '' },
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: MeterCard } = await vite.ssrLoadModule(
      '/src/views/readings/components/MeterCard.vue',
    )

    const postedBodies: any[] = []
    const deferredSubmit: { resolve: ((resp: Response) => void) | null } = { resolve: null }
    const nextResponseQueue: Array<{ status: number; body: any; defer?: boolean }> = []

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/api/v1/meters/readings') && init?.method === 'POST') {
        const parsed = JSON.parse(String(init.body || '{}'))
        postedBodies.push(parsed)
        const queued = nextResponseQueue.shift()
        if (queued?.defer) {
          return new Promise<Response>((resolve) => {
            deferredSubmit.resolve = resolve
          })
        }
        if (queued) {
          return new Response(JSON.stringify(queued.body), {
            status: queued.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({
            reading_id: 'r-default',
            meter_id: parsed.meter_id,
            period_code: parsed.period_code,
            value: parsed.value,
            consumption_delta:
              typeof parsed.previous_value === 'string' ? '4.500' : '0.000',
            source: 'RESIDENT',
            is_anomaly_confirmed: false,
            previous_origin:
              typeof parsed.previous_value === 'string' ? 'SUBMITTED' : 'START',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const meterRef = ref<any>({
      meter_id: 'm-start-gas',
      resource_type: 'GAS',
      serial_number: null,
      location_label: 'Kitchen Gas',
      unit: 'm3',
      previous_value: null,
      needs_start: true,
      reading: null,
      next_submission: {
        period_code: '2026-10',
        due_date: '2026-11-04T20:59:59Z',
        final: false,
        previous_value: null,
        needs_start: true,
        average_delta: null,
        reading: null,
      },
    })
    const periodCodeRef = ref('2026-10')
    const useNextSubRef = ref(true)
    const preservedDraftRef = ref<string | null>(null)
    const preservedBillDraftRef = ref<{ value: string; touched: boolean } | null>(null)
    const wrongPeriodEvents: any[] = []
    const savedEvents: any[] = []

    const Root = defineComponent({
      setup() {
        return () =>
          h(MeterCard, {
            meter: meterRef.value,
            periodCode: periodCodeRef.value,
            periodStatus: 'OPEN_FOR_RESIDENTS',
            canSubmit: true,
            useNextSubmission: useNextSubRef.value,
            preservedDraft: preservedDraftRef.value,
            preservedBillPreviousDraft: preservedBillDraftRef.value,
            onWrongPeriod: (payload: any) => wrongPeriodEvents.push(payload),
            onSaved: (payload: any) => savedEvents.push(payload),
          })
      },
    })

    const pinia = createPinia()
    const app = createApp(Root)
    app.use(pinia)
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    const session = useSessionStore(pinia)
    session.lang = 'ru'
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000102',
      building_role: 'USER',
      memberships: [],
    } as any

    const container: VTestNode = {
      kind: 'element',
      tag: 'div',
      props: {},
      children: [],
      parentNode: null,
    }
    app.mount(container)
    await flushUpdates()

    // P2-5: GAS resource is localized in RU (never raw 'GAS')
    assert.ok(collectText(container).includes('Газ'))
    assert.equal(collectText(container).includes('GAS'), false)
    session.lang = 'en'
    await flushUpdates()
    assert.ok(collectText(container).includes('Gas'))

    // P1-1: 409 WRONG_PERIOD preserves BOTH value AND billPreviousInput across period switch
    nextResponseQueue.push({
      status: 409,
      body: {
        error_code: 'WRONG_PERIOD',
        target_period_code: '2026-11',
      },
    })
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '125' } })
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({
      target: { value: '120.5' },
    })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()

    assert.equal(wrongPeriodEvents.length, 1)
    assert.equal(wrongPeriodEvents[0].draftValue, '125')
    assert.equal(wrongPeriodEvents[0].billPreviousValue, '120.5')
    assert.equal(wrongPeriodEvents[0].billPreviousTouched, true)

    // Simulate ReadingsView preserving both drafts and refreshing next_submission to 2026-11
    preservedDraftRef.value = wrongPeriodEvents[0].draftValue
    preservedBillDraftRef.value = {
      value: wrongPeriodEvents[0].billPreviousValue,
      touched: wrongPeriodEvents[0].billPreviousTouched,
    }
    meterRef.value = {
      ...meterRef.value,
      next_submission: {
        ...meterRef.value.next_submission,
        period_code: '2026-11',
      },
    }
    await flushUpdates()
    assert.equal(findByTestId(container, 'meter-current-input')!.props.value, '125')
    assert.equal(findByTestId(container, 'meter-bill-previous-input')!.props.value, '120.5')

    // Re-submit on 2026-11 -> MUST include previous_value '120.5' (NOT silent START!)
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 2)
    assert.equal(postedBodies[1].period_code, '2026-11')
    assert.equal(postedBodies[1].previous_value, '120.5')
    preservedDraftRef.value = null
    preservedBillDraftRef.value = null
    await flushUpdates()

    // P1-2: Local saved baseline immediately remembers SUBMITTED even before parent reloads meterRef!
    // Clearing billPreviousInput right after 200 OK MUST send explicit previous_value: null.
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({ target: { value: '' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(postedBodies.length, 3)
    assert.equal('previous_value' in postedBodies[2], true)
    assert.equal(postedBodies[2].previous_value, null)

    // P2-4: 422 VALIDATION_ERROR on loc[1] === 'previous_value' maps to localized billPreviousError (no raw Pydantic text)
    nextResponseQueue.push({
      status: 422,
      body: {
        error_code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        errors: [
          {
            loc: ['body', 'previous_value'],
            message: 'String should match pattern ^[0-9]{1,9}$',
            type: 'string_pattern_mismatch',
          },
        ],
      },
    })
    findByTestId(container, 'meter-bill-previous-input')!.props.onInput({
      target: { value: '120.5' },
    })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    const billErr = findByTestId(container, 'meter-bill-previous-error')
    assert.ok(billErr)
    assert.equal(collectText(billErr).includes('String should match pattern'), false)
    assert.ok(collectText(billErr).includes('valid meter value'))

    // P1-3a: External change to reading_id/previous_origin while anomaly step 1 is open resets flow
    nextResponseQueue.push({
      status: 409,
      body: {
        error_code: 'ANOMALY_CONFIRMATION_STEP_1',
        consumption_delta: '200.000',
        average_delta: null,
        max_reasonable_delta: '50.000',
      },
    })
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '320.5' } })
    await flushUpdates()
    await findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(
      findAll(bodyNode, (n) => n.kind === 'element' && n.props.role === 'dialog').length,
      1,
      'Anomaly step 1 dialog should be open in bodyNode',
    )

    // External update arrives -> must close anomaly flow so user cannot confirm stale step 1->2
    meterRef.value = {
      ...meterRef.value,
      next_submission: {
        ...meterRef.value.next_submission,
        reading: {
          reading_id: 'r-external',
          value: '130.000',
          previous_value: '130.000',
          consumption_delta: '0.000',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'START',
        },
      },
    }
    await flushUpdates()
    assert.equal(
      findAll(bodyNode, (n) => n.kind === 'element' && n.props.role === 'dialog').length,
      0,
      'External reading update must close open anomaly dialog',
    )

    // P1-2: Stale in-flight POST ignored when meter_id switches before response resolves
    nextResponseQueue.push({ status: 200, body: {}, defer: true })
    const savedBeforeStale = savedEvents.length
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '140' } })
    await flushUpdates()
    const pendingSubmit = findByTestId(container, 'meter-save-btn')!.props.onClick()
    await flushUpdates()
    assert.ok(deferredSubmit.resolve)

    // Switch to a different meter before POST resolves
    meterRef.value = {
      meter_id: 'm-other-meter',
      resource_type: 'COLD_WATER',
      serial_number: 'CW-99',
      location_label: 'Kitchen',
      unit: 'm3',
      previous_value: '50.000',
      needs_start: false,
      reading: null,
      next_submission: null,
    }
    useNextSubRef.value = false
    periodCodeRef.value = '2026-10'
    await flushUpdates()

    // Now resolve stale POST from m-start-gas
    deferredSubmit.resolve!(
      new Response(
        JSON.stringify({
          reading_id: 'r-stale',
          meter_id: 'm-start-gas',
          period_code: '2026-11',
          value: '140.000',
          consumption_delta: '0.000',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'START',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    await pendingSubmit
    await flushUpdates()
    assert.equal(savedEvents.length, savedBeforeStale, 'Stale POST must not emit saved on new meter')
    assert.equal(
      findByTestId(container, 'meter-current-input')!.props.value,
      '',
      'Stale POST must not overwrite new meter input',
    )

    // P1-3b: In board mode (useNextSubmission=false), changing props.periodCode resets input
    findByTestId(container, 'meter-current-input')!.props.onInput({ target: { value: '55.5' } })
    await flushUpdates()
    assert.equal(findByTestId(container, 'meter-current-input')!.props.value, '55.5')
    periodCodeRef.value = '2026-09'
    await flushUpdates()
    assert.equal(
      findByTestId(container, 'meter-current-input')!.props.value,
      '',
      'Switching props.periodCode in useNextSubmission=false must clear prior period input',
    )

    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})
