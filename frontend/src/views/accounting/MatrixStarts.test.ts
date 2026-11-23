import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  createClientVueViteServer,
  createFakeDomHarness,
  type VTestNode,
} from '../../test/mountWithApp.js'

test('AccountingView renders START/SUBMITTED marks, incomplete balance & null master_total, real matrix MeterCard without fake floor, starting master meter bill field, skipped estimate list, and zero resident names (#039)', async () => {
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
    const { default: AccountingView } = await vite.ssrLoadModule(
      '/src/views/accounting/AccountingView.vue',
    )

    const postedReadings: Array<Record<string, any>> = []
    let matrixState: any = {
      period: {
        period_code: '2026-10',
        status: 'REVIEW_BY_BOARD',
        due_date: '2026-11-04',
      },
      balances: [
        {
          resource_type: 'COLD_WATER',
          unit: 'm3',
          master_total: '28.500',
          apartments_sum: '22.550',
          unallocated_loss: '5.950',
          starting_meters: 1,
        },
        {
          resource_type: 'HOT_WATER',
          unit: 'm3',
          master_total: null,
          apartments_sum: '7.850',
          unallocated_loss: null,
          starting_meters: 0,
        },
      ],
      master_meters: [
        {
          meter_id: '018f0000-0000-7000-8000-000000000991',
          resource_type: 'COLD_WATER',
          location_label: 'Basement Main Cold Water Inlet',
          unit: 'm3',
          previous_value: '4120.000',
          needs_start: false,
          status: 'SUBMITTED',
          reading: {
            reading_id: 'r-m1',
            value: '4148.500',
            previous_value: '4120.000',
            consumption_delta: '28.500',
            source: 'ADMIN_OVERRIDE',
            is_anomaly_confirmed: false,
            previous_origin: 'HISTORY',
          },
        },
        {
          meter_id: '018f0000-0000-7000-8000-000000000993',
          resource_type: 'HOT_WATER',
          location_label: 'Stairwell B Hot Water Branch',
          unit: 'm3',
          previous_value: null,
          needs_start: true,
          status: 'MISSING',
          reading: null,
        },
      ],
      apartments: [
        {
          apartment_id: 'apt-01',
          apartment_number: '01',
          entrance: 1,
          floor: 1,
          status: 'SUBMITTED',
          meters: [
            {
              meter_id: 'm-01-start',
              resource_type: 'COLD_WATER',
              location_label: 'Utility Room Cold Water',
              unit: 'm3',
              previous_value: '45.000',
              needs_start: true,
              status: 'SUBMITTED',
              reading: {
                reading_id: 'r-01-start',
                value: '45.000',
                previous_value: '45.000',
                consumption_delta: '0.000',
                source: 'RESIDENT',
                is_anomaly_confirmed: false,
                previous_origin: 'START',
              },
            },
          ],
        },
        {
          apartment_id: 'apt-02',
          apartment_number: '02',
          entrance: 1,
          floor: 1,
          status: 'SUBMITTED',
          meters: [
            {
              meter_id: 'm-02-sub',
              resource_type: 'HOT_WATER',
              location_label: 'Bathroom Hot Water',
              unit: 'm3',
              previous_value: '95.500',
              needs_start: true,
              status: 'SUBMITTED',
              reading: {
                reading_id: 'r-02-sub',
                value: '97.950',
                previous_value: '95.500',
                consumption_delta: '2.450',
                source: 'RESIDENT',
                is_anomaly_confirmed: false,
                previous_origin: 'SUBMITTED',
              },
            },
          ],
        },
        {
          apartment_id: 'apt-14',
          apartment_number: '14',
          entrance: 2,
          floor: 4,
          status: 'MISSING',
          meters: [
            {
              meter_id: 'm-14-normal',
              resource_type: 'COLD_WATER',
              location_label: 'Bathroom Cold Water',
              unit: 'm3',
              previous_value: '142.350',
              needs_start: false,
              status: 'MISSING',
              reading: null,
            },
            {
              meter_id: 'm-14-start',
              resource_type: 'HOT_WATER',
              location_label: 'Laundry Hot Water',
              unit: 'm3',
              previous_value: null,
              needs_start: true,
              status: 'MISSING',
              reading: null,
            },
          ],
        },
      ],
    }

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.endsWith('/api/v1/meters/periods') && method === 'GET') {
        return new Response(JSON.stringify({ periods: [matrixState.period] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.endsWith('/api/v1/meters/periods/2026-10/matrix') && method === 'GET') {
        return new Response(JSON.stringify(matrixState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.endsWith('/api/v1/meters/readings') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}'))
        postedReadings.push(parsed)
        return new Response(
          JSON.stringify({
            reading_id: 'r-new',
            meter_id: parsed.meter_id,
            period_code: parsed.period_code,
            value: parsed.value,
            consumption_delta:
              typeof parsed.previous_value === 'string' ? '10.000' : '0.000',
            source: 'ADMIN_OVERRIDE',
            is_anomaly_confirmed: false,
            previous_origin:
              typeof parsed.previous_value === 'string' ? 'SUBMITTED' : 'START',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (
        urlStr.endsWith('/api/v1/meters/periods/2026-10/estimate-missing') &&
        method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            period_code: '2026-10',
            estimated_count: 1,
            estimated: [
              {
                reading_id: 'r-est-1',
                meter_id: 'm-14-normal',
                apartment_id: 'apt-14',
                value: '145.550',
                consumption_delta: '3.200',
              },
            ],
            skipped_without_start: ['m-14-start'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/accounting', name: 'accounting', component: AccountingView }],
    })
    await router.push('/accounting')
    await router.isReady()

    const pinia = createPinia()
    const app = createApp(defineComponent({ setup: () => () => h(AccountingView) }))
    app.use(pinia)
    app.use(router)

    setDemoUser('018f0000-0000-7000-8000-000000000101')
    const session = useSessionStore(pinia)
    session.lang = 'en'
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000101',
      building_role: 'CHAIRMAN',
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

    const pageText = collectText(container)

    // 1. Privacy check: matrix stays without resident names
    for (const forbiddenName of ['Kati Kask', 'Peeter Tamm', 'Martin Saar', 'Liina Vaher', 'Marika Rebane']) {
      assert.equal(pageText.includes(forbiddenName), false, `Found leaked name ${forbiddenName}`)
    }

    // 2. START and SUBMITTED marks in matrix rows: icon + text (not colour only)
    const startMarks = findAll(
      container,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'matrix-origin-start',
    )
    assert.equal(startMarks.length, 1)
    assert.ok(collectText(startMarks[0]).includes('flag'))
    assert.ok(collectText(startMarks[0]).includes('Start of the meter, no consumption this month'))

    const subMarks = findAll(
      container,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'matrix-origin-submitted',
    )
    assert.equal(subMarks.length, 1)
    assert.ok(collectText(subMarks[0]).includes('receipt_long'))
    assert.ok(
      collectText(subMarks[0]).includes(
        'Start given by the resident: check it against the last bill',
      ),
    )

    // 3. KPI strip: null master_total on HOT_WATER -> shows '—' + Awaiting master meter reading (NOT Within 5% norm),
    //    AND starting_meters > 0 shows incomplete balance banner
    assert.equal(collectText(findByTestId(container, 'master-kpi-intake-value')!).trim(), '—')
    assert.equal(collectText(findByTestId(container, 'master-kpi-loss-value')!).trim(), '—')
    assert.ok(
      collectText(findByTestId(container, 'master-kpi-awaiting')!).includes(
        'Awaiting master meter reading',
      ),
    )
    const incompleteBanner = findByTestId(container, 'balance-incomplete-banner')
    assert.ok(incompleteBanner)
    assert.ok(
      collectText(incompleteBanner).includes(
        "This month's balance is incomplete: 1 meter started this month",
      ),
    )

    // 4. Board edit modal for Apt 14: NO invented APT14 serial, NO fake 100.000 floor, bill field ONLY on needs_start meter
    const editApt14Btn = findByTestId(container, 'matrix-edit-apt-14')
    assert.ok(editApt14Btn)
    await editApt14Btn.props.onClick()
    await flushUpdates()

    const modalText = collectText(bodyNode)
    assert.equal(modalText.includes('APT14-'), false, 'Must not invent APT14 serial number')
    assert.equal(modalText.includes('100.000'), false, 'Must not invent 100.000 previous_value floor')

    const billSectionsInApt14 = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-bill-previous-section',
    )
    assert.equal(billSectionsInApt14.length, 1, 'Only needs_start meter 0519 should show bill field')

    // Submit 80 (below old fake 100.000 floor!) on m-14-start without bill -> succeeds without previous_value
    const curInputs = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-current-input',
    )
    const saveBtns = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-save-btn',
    )
    assert.equal(curInputs.length, 2)
    curInputs[1].props.onInput({ target: { value: '80' } })
    await flushUpdates()
    await saveBtns[1].props.onClick()
    await flushUpdates()

    assert.equal(postedReadings.length, 1)
    assert.equal(postedReadings[0].meter_id, 'm-14-start')
    assert.equal(postedReadings[0].value, '80')
    assert.equal('previous_value' in postedReadings[0], false)

    // P1-4: Apt 14 modal MUST stay open after saving (silent refresh, no unmount)
    const closeBtns1 = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.tag === 'button' && n.props['aria-label'] === 'Close modal',
    )
    assert.ok(
      closeBtns1[0]?.props.onClick,
      'Apt modal must stay open after saving a reading (silent matrix refresh)',
    )
    await closeBtns1[0].props.onClick()
    await flushUpdates()

    // 5. Building master meters modal: starting master meter 0993 gets the bill field, 0991 does NOT
    const editMasterBtn = findByTestId(container, 'master-kpi-edit-btn')
    assert.ok(editMasterBtn)
    await editMasterBtn.props.onClick()
    await flushUpdates()

    const masterBillSections = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-bill-previous-section',
    )
    assert.equal(masterBillSections.length, 1, 'Only starting master meter 0993 gets the bill field')

    const masterCurInputs = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-current-input',
    )
    const masterBillInput = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-bill-previous-input',
    )[0]
    const masterSaveBtns = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-save-btn',
    )
    masterCurInputs[1].props.onInput({ target: { value: '510' } })
    masterBillInput.props.onInput({ target: { value: '500' } })
    await flushUpdates()
    await masterSaveBtns[1].props.onClick()
    await flushUpdates()

    assert.equal(postedReadings.length, 2)
    assert.equal(postedReadings[1].meter_id, '018f0000-0000-7000-8000-000000000993')
    assert.equal(postedReadings[1].value, '510')
    assert.equal(postedReadings[1].previous_value, '500')

    const closeBtns2 = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.tag === 'button' && n.props['aria-label'] === 'Close modal',
    )
    assert.ok(
      closeBtns2[0]?.props.onClick,
      'Master meters modal must stay open after saving a reading',
    )
    await closeBtns2[0].props.onClick()
    await flushUpdates()

    // 6. Clicking "Estimate missing" lists skipped_without_start by apartment number & resource
    const estBtn = findByTestId(container, 'period-toolbar-estimate-btn')
    assert.ok(estBtn)
    await estBtn.props.onClick()
    await flushUpdates()

    const skippedList = findByTestId(container, 'estimate-skipped-list')
    assert.ok(skippedList, 'Expected skipped_without_start list in action banner')
    const skippedText = collectText(skippedList)
    assert.ok(skippedText.includes('Apt 14'))
    assert.ok(skippedText.includes('Hot Water'))
    assert.ok(skippedText.includes('no start yet: cannot be estimated'))

    // 7. Switching to Building Balance tab shows incomplete-balance badge on COLD_WATER and awaiting state on HOT_WATER
    const balanceTabBtn = findByTestId(container, 'accounting-tab-balance')
    assert.ok(balanceTabBtn)
    await balanceTabBtn.props.onClick()
    await flushUpdates()

    const rowIncomplete = findByTestId(container, 'balance-row-incomplete')
    assert.ok(rowIncomplete)
    assert.ok(
      collectText(rowIncomplete).includes(
        "This month's balance is incomplete: 1 meter started this month",
      ),
    )
    const rowAwaiting = findByTestId(container, 'balance-row-awaiting-master')
    assert.ok(rowAwaiting)
    assert.ok(collectText(rowAwaiting).includes('Awaiting master meter reading'))

    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})

test('ApartmentCardView displays icon+text START and SUBMITTED marks and omits null serial_number (#039)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, flushUpdates } = createFakeDomHarness()
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
    const { default: ApartmentCardView } = await vite.ssrLoadModule(
      '/src/views/apartments/ApartmentCardView.vue',
    )

    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/api/v1/property/apartments/apt-01')) {
        return new Response(
          JSON.stringify({
            apartment_id: 'apt-01',
            apartment_number: '01',
            entrance: 1,
            floor: 1,
            area_m2: '54.30',
            residents: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('/api/v1/meters/apartments/apt-01/readings')) {
        return new Response(
          JSON.stringify({
            apartment_id: 'apt-01',
            apartment_number: '01',
            periods: [{ period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS', due_date: '2026-11-04' }],
            meters: [
              {
                meter_id: 'm-start',
                resource_type: 'COLD_WATER',
                serial_number: null,
                location_label: 'Utility Room',
                unit: 'm3',
                is_active: true,
                readings: [
                  {
                    period_code: '2026-10',
                    reading_id: 'r-1',
                    value: '45.000',
                    consumption_delta: '0.000',
                    source: 'RESIDENT',
                    is_anomaly_confirmed: false,
                    previous_origin: 'START',
                  },
                ],
              },
              {
                meter_id: 'm-sub',
                resource_type: 'HOT_WATER',
                serial_number: 'HW-01',
                location_label: 'Bathroom',
                unit: 'm3',
                is_active: true,
                readings: [
                  {
                    period_code: '2026-10',
                    reading_id: 'r-2',
                    value: '97.950',
                    consumption_delta: '2.450',
                    source: 'RESIDENT',
                    is_anomaly_confirmed: false,
                    previous_origin: 'SUBMITTED',
                  },
                ],
              },
              {
                meter_id: 'm-neg',
                resource_type: 'HEAT',
                serial_number: '   ',
                location_label: 'Living Room',
                unit: 'MWh',
                is_active: true,
                readings: [
                  {
                    period_code: '2026-10',
                    reading_id: 'r-3',
                    value: '10.000',
                    consumption_delta: '-1.200',
                    source: 'ADMIN_OVERRIDE',
                    is_anomaly_confirmed: false,
                    previous_origin: 'HISTORY',
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('/api/v1/meters/apartments/apt-01/consumption')) {
        return new Response(
          JSON.stringify({
            apartment_id: 'apt-01',
            apartment_number: '01',
            periods: [{ period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS', due_date: '2026-11-04' }],
            resources: [
              {
                resource_type: 'COLD_WATER',
                unit: 'm3',
                months: [{ period_code: '2026-10', consumption: null, estimated: false }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('/api/v1/communication/posts')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/apartments/:apartmentId', name: 'apartment-card', component: ApartmentCardView },
        { path: '/apartments', name: 'apartments', component: { template: '<div />' } },
      ],
    })
    await router.push('/apartments/apt-01')
    await router.isReady()

    const pinia = createPinia()
    const app = createApp(defineComponent({ setup: () => () => h(ApartmentCardView) }))
    app.use(pinia)
    app.use(router)

    setDemoUser('018f0000-0000-7000-8000-000000000101')
    const session = useSessionStore(pinia)
    session.lang = 'en'
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000101',
      building_role: 'CHAIRMAN',
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

    const text = collectText(container)
    assert.equal(text.includes('null'), false, `Unexpected "null" in apartment card: ${text}`)
    assert.equal(text.includes('#null'), false)
    // P2-3: Negative delta renders as -1.200 without "+-" double sign
    assert.equal(text.includes('+-1.200'), false, `Found "+-" double sign in: ${text}`)
    assert.ok(text.includes('-1.200 MWh'))

    const startBadge = findAll(
      container,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'apt-card-origin-start',
    )[0]
    assert.ok(startBadge)
    assert.ok(collectText(startBadge).includes('flag'))
    assert.ok(collectText(startBadge).includes('Start of the meter, no consumption this month'))

    const subBadge = findAll(
      container,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'apt-card-origin-submitted',
    )[0]
    assert.ok(subBadge)
    assert.ok(collectText(subBadge).includes('receipt_long'))
    assert.ok(
      collectText(subBadge).includes(
        'Start given by the resident: check it against the last bill',
      ),
    )

    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})

test('AccountingView CTO audit regressions: fail-closed PeriodToolbar, single GET /matrix on non-default period, GAS excluded from water total, nested Escape in BaseModal, Russian plural 21, empty periods, and BOARD/USER RBAC (P1-5..P1-7, P2-1, P2-5)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, bodyNode, collectText, findAll, findByTestId, flushUpdates } =
    createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const keydownListeners: Array<(e: any) => void> = []
  ;(globalThis as any).window = {
    addEventListener(type: string, fn: any) {
      if (type === 'keydown') keydownListeners.push(fn)
    },
    removeEventListener(type: string, fn: any) {
      if (type === 'keydown') {
        const idx = keydownListeners.indexOf(fn)
        if (idx !== -1) keydownListeners.splice(idx, 1)
      }
    },
    location: { search: '' },
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: AccountingView } = await vite.ssrLoadModule(
      '/src/views/accounting/AccountingView.vue',
    )

    let matrixFetchCount = 0
    const deferredMatrix: { resolve: ((resp: Response) => void) | null } = { resolve: null }
    let periodsPayload: any[] = [
      { period_code: '2026-11', status: 'REVIEW_BY_BOARD', due_date: '2026-12-04T20:59:59Z' },
    ]
    const matrixPayload = {
      period: { period_code: '2026-11', status: 'REVIEW_BY_BOARD', due_date: '2026-12-04T20:59:59Z' },
      balances: [
        {
          resource_type: 'COLD_WATER',
          unit: 'm3',
          master_total: '10.000',
          apartments_sum: '3.000',
          unallocated_loss: '7.000',
          starting_meters: 21,
        },
        {
          resource_type: 'HOT_WATER',
          unit: 'm3',
          master_total: '5.000',
          apartments_sum: '2.000',
          unallocated_loss: '3.000',
          starting_meters: 0,
        },
      ],
      master_meters: [],
      apartments: [
        {
          apartment_id: 'apt-01',
          apartment_number: '01',
          entrance: 1,
          floor: 1,
          status: 'SUBMITTED',
          meters: [
            {
              meter_id: 'm-cw',
              resource_type: 'COLD_WATER',
              serial_number: 'CW-1',
              location_label: 'Kitchen',
              unit: 'm3',
              previous_value: '10.000',
              needs_start: false,
              status: 'SUBMITTED',
              reading: {
                reading_id: 'r-cw',
                value: '13.000',
                previous_value: '10.000',
                consumption_delta: '3.000',
                source: 'RESIDENT',
                is_anomaly_confirmed: false,
                previous_origin: 'HISTORY',
              },
            },
            {
              meter_id: 'm-hw',
              resource_type: 'HOT_WATER',
              serial_number: 'HW-1',
              location_label: 'Bath',
              unit: 'm3',
              previous_value: '20.000',
              needs_start: false,
              status: 'SUBMITTED',
              reading: {
                reading_id: 'r-hw',
                value: '22.000',
                previous_value: '20.000',
                consumption_delta: '2.000',
                source: 'RESIDENT',
                is_anomaly_confirmed: false,
                previous_origin: 'HISTORY',
              },
            },
            {
              meter_id: 'm-gas',
              resource_type: 'GAS',
              serial_number: 'GAS-1',
              location_label: 'Stove',
              unit: 'm3',
              previous_value: '100.000',
              needs_start: true,
              status: 'MISSING',
              reading: {
                reading_id: 'r-gas',
                value: '115.000',
                previous_value: '100.000',
                consumption_delta: '15.000',
                source: 'RESIDENT',
                is_anomaly_confirmed: false,
                previous_origin: 'HISTORY',
              },
            },
          ],
        },
      ],
    }

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/api/v1/meters/periods')) {
        return new Response(JSON.stringify(periodsPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('/api/v1/meters/periods/') && urlStr.endsWith('/matrix')) {
        matrixFetchCount += 1
        if (matrixFetchCount === 1) {
          return new Promise<Response>((resolve) => {
            deferredMatrix.resolve = resolve
          })
        }
        return new Response(JSON.stringify(matrixPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.endsWith('/api/v1/meters/readings') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error_code: 'ANOMALY_CONFIRMATION_STEP_1',
            consumption_delta: '500.000',
            average_delta: null,
            max_reasonable_delta: '25.000',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/accounting', name: 'accounting', component: AccountingView }],
    })
    await router.push('/accounting')
    await router.isReady()

    const pinia = createPinia()
    const app = createApp(defineComponent({ setup: () => () => h(AccountingView) }))
    app.use(pinia)
    app.use(router)

    setDemoUser('018f0000-0000-7000-8000-000000000101')
    const session = useSessionStore(pinia)
    session.lang = 'ru'
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000101',
      building_role: 'CHAIRMAN',
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

    // P1-5: While GET /matrix is pending, PeriodToolbar MUST NOT show fake OPEN_FOR_RESIDENTS status buttons
    assert.equal(findByTestId(container, 'period-toolbar-status-REVIEW_BY_BOARD'), null)
    assert.equal(findByTestId(container, 'period-toolbar-status-LOCKED'), null)
    assert.equal(findByTestId(container, 'period-toolbar-estimate-btn'), null)
    assert.ok(deferredMatrix.resolve)

    deferredMatrix.resolve!(
      new Response(JSON.stringify(matrixPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await flushUpdates()

    // P1-6: Starting with non-2026-10 period ('2026-11') fetches GET /matrix exactly ONCE (no duplicate fetch)
    assert.equal(matrixFetchCount, 1)

    // P2-1: GAS (m3) is excluded from totalWaterDelta -> 3.000 + 2.000 = 5.000 (NOT 20.000!)
    assert.equal(collectText(findByTestId(container, 'matrix-row-total-01')!).trim(), '5.000')

    // P2-5: Russian 3-form plural for 21 starting meters -> "21 счётчик начал учёт"
    const ruBanner = findByTestId(container, 'balance-incomplete-banner')
    assert.ok(ruBanner)
    assert.ok(
      collectText(ruBanner).includes(
        'Баланс за этот месяц неполный: 21 счётчик начал учёт в этом месяце',
      ),
    )

    // P1-7: Nested BaseModal Escape closes ONLY MeterCardAnomalyModal, keeping Apt edit modal open!
    const editBtn = findByTestId(container, 'matrix-edit-apt-01')
    assert.ok(editBtn)
    await editBtn.props.onClick()
    await flushUpdates()

    const curInputs = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-current-input',
    )
    const reasonInputs = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.tag === 'input' && String(n.props.id || '').startsWith('meter-reason-'),
    )
    const saveBtns = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props['data-testid'] === 'meter-save-btn',
    )
    curInputs[0].props.onInput({ target: { value: '510' } })
    reasonInputs[0].props.onInput({ target: { value: 'High leak test' } })
    await flushUpdates()
    await saveBtns[0].props.onClick()
    await flushUpdates()

    // Now TWO modals are open (Apt edit modal + Anomaly confirmation modal)
    const dialogsBeforeEsc = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props.role === 'dialog',
    )
    assert.equal(dialogsBeforeEsc.length, 2, 'Expected both Apt edit modal and Anomaly modal open')

    // Press Escape once -> ONLY the top Anomaly modal closes; Apt edit modal stays open!
    const escEvent = { key: 'Escape', stopImmediatePropagation() {} }
    for (const fn of [...keydownListeners]) {
      fn(escEvent)
    }
    await flushUpdates()

    const dialogsAfterEsc1 = findAll(
      bodyNode,
      (n) => n.kind === 'element' && n.props.role === 'dialog',
    )
    assert.equal(
      dialogsAfterEsc1.length,
      1,
      'First Escape must close only nested Anomaly modal and keep Apt edit modal open',
    )

    // Second Escape closes the parent Apt edit modal
    const escEvent2 = { key: 'Escape', stopImmediatePropagation() {} }
    for (const fn of [...keydownListeners]) {
      fn(escEvent2)
    }
    await flushUpdates()
    assert.equal(
      findAll(bodyNode, (n) => n.kind === 'element' && n.props.role === 'dialog').length,
      0,
    )

    // RBAC check: BOARD hides status transitions & edit buttons; USER renders accounting-forbidden
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000104',
      building_role: 'BOARD',
      memberships: [],
    } as any
    setDemoUser('018f0000-0000-7000-8000-000000000104')
    await flushUpdates()
    assert.equal(findByTestId(container, 'period-toolbar-estimate-btn'), null)
    assert.equal(findByTestId(container, 'matrix-edit-apt-01'), null)

    // Empty periods list on a brand-new building shows accounting-no-periods without requesting 2026-10
    periodsPayload = []
    const fetchesBeforeEmpty = matrixFetchCount
    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000101',
      building_role: 'CHAIRMAN',
      memberships: [],
    } as any
    setDemoUser('018f0000-0000-7000-8000-000000000101')
    await flushUpdates()
    assert.ok(findByTestId(container, 'accounting-no-periods'))
    assert.equal(matrixFetchCount, fetchesBeforeEmpty)

    session.me = {
      user_id: '018f0000-0000-7000-8000-000000000102',
      building_role: 'USER',
      memberships: [],
    } as any
    setDemoUser('018f0000-0000-7000-8000-000000000102')
    await flushUpdates()
    assert.ok(findByTestId(container, 'accounting-forbidden'))

    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})
