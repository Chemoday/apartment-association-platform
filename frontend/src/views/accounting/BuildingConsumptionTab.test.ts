import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createServer } from 'vite'

const Dummy = { template: '<div />' }

const USER_IDS: Record<string, string> = {
  CHAIRMAN: '018f0000-0000-7000-8000-000000000101',
  USER: '018f0000-0000-7000-8000-000000000102',
  ACCOUNTANT: '018f0000-0000-7000-8000-000000000103',
  BOARD: '018f0000-0000-7000-8000-000000000105',
}

interface VTestNode {
  kind: 'element' | 'text' | 'comment'
  tag?: string
  props: Record<string, any>
  text?: string
  children: VTestNode[]
  parentNode: VTestNode | null
}

function createFakeDomHarness() {
  const { createApp } = createRenderer<VTestNode, VTestNode>({
    patchProp(el, key, _prevValue, nextValue) {
      if (key === 'class') {
        el.props.class = Array.isArray(nextValue) ? nextValue.join(' ') : nextValue
      } else {
        el.props[key] = nextValue
      }
    },
    insert(child, parent, anchor) {
      if (child.parentNode && child.parentNode !== parent) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx !== -1) child.parentNode.children.splice(idx, 1)
      }
      child.parentNode = parent
      if (anchor) {
        const idx = parent.children.indexOf(anchor)
        if (idx !== -1) {
          parent.children.splice(idx, 0, child)
          return
        }
      }
      if (!parent.children.includes(child)) {
        parent.children.push(child)
      }
    },
    remove(child) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx !== -1) child.parentNode.children.splice(idx, 1)
        child.parentNode = null
      }
    },
    createElement(type) {
      return {
        kind: 'element',
        tag: type,
        props: {},
        children: [],
        parentNode: null,
        options: [],
        addEventListener() {},
        removeEventListener() {},
      } as any
    },
    createText(text) {
      return { kind: 'text', props: {}, text, children: [], parentNode: null }
    },
    createComment(text) {
      return { kind: 'comment', props: {}, text, children: [], parentNode: null }
    },
    setText(node, text) {
      node.text = text
    },
    setElementText(el, text) {
      el.children = [{ kind: 'text', props: {}, text, children: [], parentNode: el }]
    },
    parentNode(node) {
      return node.parentNode
    },
    nextSibling(node) {
      const parent = node.parentNode
      if (!parent) return null
      const idx = parent.children.indexOf(node)
      return idx >= 0 && idx + 1 < parent.children.length ? parent.children[idx + 1] : null
    },
    cloneNode(node) {
      return {
        ...node,
        props: { ...node.props },
        children: node.children.map((c) => ({ ...c })),
        parentNode: null,
      }
    },
  })

  function collectText(node: VTestNode): string {
    if (node.kind === 'text') return node.text || ''
    if (node.kind === 'comment') return ''
    return node.children.map(collectText).join(' ')
  }

  function findAll(root: VTestNode, predicate: (node: VTestNode) => boolean): VTestNode[] {
    const hits: VTestNode[] = []
    if (predicate(root)) hits.push(root)
    for (const c of root.children) {
      hits.push(...findAll(c, predicate))
    }
    return hits
  }

  function findByTestId(root: VTestNode, testId: string): VTestNode | null {
    return findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === testId)[0] || null
  }

  async function flushUpdates(ticks = 15) {
    for (let i = 0; i < ticks; i += 1) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  return { createApp, collectText, findAll, findByTestId, flushUpdates }
}

function createClientVueViteServer() {
  return createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [
      {
        name: 'test-client-vue',
        configResolved(config) {
          const vp = config.plugins.find((p) => p.name === 'vite:vue')
          if (vp?.api?.options) {
            vp.api.options.isProduction = true
          }
          if (vp?.transform) {
            const orig = vp.transform as any
            const fn = typeof orig === 'function' ? orig : orig.handler
            const wrapped = function (this: any, code: string, id: string, opts: any) {
              return fn.call(this, code, id, { ...opts, ssr: false })
            }
            if (typeof orig === 'function') (vp as any).transform = wrapped
            else orig.handler = wrapped
          }
        },
      },
    ],
  })
}

test('useBuildingConsumption cancels stale window requests, ignores REQUEST_ABORTED, and aborts on unmount (#031)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, flushUpdates } = createFakeDomHarness()

  try {
    const { useBuildingConsumption } = await vite.ssrLoadModule(
      '/src/composables/useBuildingConsumption.js',
    )

    const calls: Array<{ months: number; signal: AbortSignal }> = []
    const resolvers: Array<{
      resolve: (v: any) => void
      reject: (e: any) => void
      signal: AbortSignal
    }> = []

    const fetcher = (months = 12, { signal }: { signal: AbortSignal }) => {
      calls.push({ months, signal })
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Request aborted'), { errorCode: 'REQUEST_ABORTED' }))
        })
        resolvers.push({ resolve, reject, signal })
      })
    }

    let loader!: ReturnType<typeof useBuildingConsumption>
    const Harness = defineComponent({
      setup() {
        loader = useBuildingConsumption(fetcher)
        return () => h('div')
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(Harness)
    app.mount(root)
    await flushUpdates()

    const p12 = loader.load(12)
    const p24 = loader.load(24, { preserveDataOnReload: true })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(calls[1].signal.aborted, false)

    await p12
    assert.equal(loader.error.value, null)

    resolvers[1].resolve({ periods: [{ period_code: '2026-10', status: 'LOCKED' }], resources: [] })
    await p24
    assert.equal(loader.data.value?.periods?.length, 1)
    assert.equal(loader.loading.value, false)

    // Verify reset() clears data/error cleanly
    loader.reset()
    assert.equal(loader.data.value, null)
    assert.equal(loader.error.value, null)
    assert.equal(loader.loading.value, false)

    // Verify onBeforeUnmount aborts in-flight request
    const pUnmount = loader.load(12)
    assert.equal(calls[2].signal.aborted, false)
    app.unmount()
    assert.equal(calls[2].signal.aborted, true)
    await pUnmount
    assert.equal(loader.error.value, null)
  } finally {
    await vite.close()
  }
})

test('BuildingConsumptionTab renders 6 columns, toggles 12/24 with abort, handles error + retry, enforces role guard & unmount abort (#031)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
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
    const { default: BuildingConsumptionTab } = await vite.ssrLoadModule(
      '/src/views/accounting/components/BuildingConsumptionTab.vue',
    )
    const { default: AccountingView } = await vite.ssrLoadModule(
      '/src/views/accounting/AccountingView.vue',
    )
    const { default: ReadingsView } = await vite.ssrLoadModule(
      '/src/views/readings/ReadingsView.vue',
    )

    const samplePayload = (months: number) => ({
      periods: [
        { period_code: '2026-08', status: 'LOCKED', due_date: '2026-09-04T20:59:59Z' },
        { period_code: '2026-09', status: 'LOCKED', due_date: '2026-10-04T20:59:59Z' },
        { period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS', due_date: '2026-11-04T21:59:59Z' },
      ],
      resources: [
        {
          resource_type: 'COLD_WATER',
          unit: 'm3',
          months: [
            {
              period_code: '2026-08',
              total: '-1.500',
              apartments_counted: 5,
              average_per_apartment: '-0.300',
              average_per_m2: '-0.0056',
              estimated_readings: 2,
            },
            {
              period_code: '2026-09',
              total: null,
              apartments_counted: 0,
              average_per_apartment: null,
              average_per_m2: null,
              estimated_readings: 0,
            },
            {
              period_code: '2026-10',
              total: months === 24 ? '11.200' : '4.500',
              apartments_counted: 1,
              average_per_apartment: months === 24 ? '11.200' : '4.500',
              average_per_m2: months === 24 ? '0.2063' : '0.0928',
              estimated_readings: 0,
            },
          ],
        },
      ],
    })

    const fetchRequests: Array<{
      url: string
      signal?: AbortSignal
      aborted: boolean
    }> = []
    let fetchMode: 'ok' | 'fail-500' | 'deferred' = 'ok'
    let deferredResolvers: Array<{ resolve: (r: any) => void; reject: (e: any) => void }> = []
    let stubDashboardApartments: any[] = []

    globalThis.fetch = ((input: any, init: any = {}) => {
      const url = String(input)
      const rec = { url, signal: init?.signal as AbortSignal | undefined, aborted: false }
      if (rec.signal) {
        rec.signal.addEventListener('abort', () => {
          rec.aborted = true
        })
      }
      fetchRequests.push(rec)

      if (fetchMode === 'deferred') {
        return new Promise((resolve, reject) => {
          if (rec.signal) {
            rec.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted')
              abortErr.name = 'AbortError'
              reject(abortErr)
            })
          }
          deferredResolvers.push({ resolve, reject })
        })
      }

      if (fetchMode === 'fail-500') {
        return Promise.resolve(
          new Response(JSON.stringify({ error_code: 'INTERNAL_SERVER_ERROR', message: 'boom' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }

      const monthsMatch = url.match(/[?&]months=(\d+)/)
      const m = monthsMatch ? Number(monthsMatch[1]) : 12
      const payload = url.includes('/meters/consumption')
        ? samplePayload(m)
        : url.includes('/meters/my-dashboard')
          ? {
              period: { period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS' },
              apartments: stubDashboardApartments,
            }
          : { periods: [{ period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS' }], apartments: [], balances: [], master_meters: [] }

      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as any

    async function mountComponent(
      comp: any,
      {
        role,
        lang,
        path = '/accounting?tab=consumption',
        buildingCount = 6,
        props = {},
        memberships = [],
      }: {
        role: string
        lang: string
        path?: string
        buildingCount?: number | null
        props?: Record<string, any>
        memberships?: any[]
      },
    ) {
      const pinia = createPinia()
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/readings', name: 'readings', component: Dummy },
          { path: '/accounting', name: 'accounting', component: Dummy },
          { path: '/', name: 'home', component: Dummy },
        ],
      })
      await router.push(path)
      await router.isReady()

      setDemoUser(USER_IDS[role] || USER_IDS.USER)
      const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
      const app = createApp(defineComponent({ render: () => h(comp, props) }))
      app.use(pinia)
      app.use(router)

      const session = useSessionStore(pinia)
      session.setLang(lang)
      session.me = {
        user_id: USER_IDS[role] || USER_IDS.USER,
        building_role: role,
        memberships,
        locale: lang,
      } as any
      session.building = buildingCount !== null
        ? ({
            name: 'KÜ Sõpruse 12',
            registry_code: '80123456',
            apartment_count: buildingCount,
          } as any)
        : null

      app.mount(root)
      await flushUpdates()
      return { app, root, session }
    }

    // 1. Mounted BuildingConsumptionTab for CHAIRMAN (en): renders all 6 columns, verbatim strings, singular 1-apt badge, negative class, null dashes
    fetchRequests.length = 0
    const staffTab = await mountComponent(BuildingConsumptionTab, {
      role: 'CHAIRMAN',
      lang: 'en',
      buildingCount: 6,
    })
    assert.equal(
      fetchRequests.some((r) => r.url.endsWith('/meters/consumption?months=12')),
      true,
    )

    const tbl = findByTestId(staffTab.root, 'building-consumption-table-COLD_WATER')
    assert.ok(tbl, 'Breakdown table should be rendered after fetch resolves')
    const tableText = collectText(tbl)
    for (const heading of ['Month', 'Total', 'Apartments', 'Per apartment', 'Per m²', 'Estimated']) {
      assert.equal(tableText.includes(heading), true, `Missing column heading ${heading}`)
    }
    const octRow = findByTestId(staffTab.root, 'building-consumption-row-COLD_WATER-2026-10')!
    assert.ok(octRow)
    const octText = collectText(octRow)
    assert.equal(octText.includes('In progress, 1 apartment so far'), true)
    assert.equal(octText.includes('4.500 m³'), true)
    assert.equal(octText.includes('0.0928 m³/m²'), true)
    assert.equal(octText.includes('of 6'), true)

    const sepRow = findByTestId(staffTab.root, 'building-consumption-row-COLD_WATER-2026-09')!
    assert.equal(collectText(sepRow).includes('—'), true)

    const augRow = findByTestId(staffTab.root, 'building-consumption-row-COLD_WATER-2026-08')!
    const augText = collectText(augRow)
    assert.equal(augText.includes('-1.500 m³'), true)
    assert.equal(augText.includes('-0.0056 m³/m²'), true)
    const negSpan = findAll(augRow, (n) => n.kind === 'element' && String(n.props.class || '').includes('text-error'))[0]
    assert.ok(negSpan, 'Negative total should use text-error class')

    // 2. Clicking 24-month button toggles aria-pressed and loads ?months=24
    const btn24 = findByTestId(staffTab.root, 'building-consumption-months-24')!
    assert.equal(btn24.props['aria-pressed'], 'false')
    btn24.props.onClick()
    await flushUpdates()
    assert.equal(btn24.props['aria-pressed'], 'true')
    assert.equal(
      fetchRequests.some((r) => r.url.endsWith('/meters/consumption?months=24')),
      true,
    )
    assert.equal(collectText(findByTestId(staffTab.root, 'building-consumption-row-COLD_WATER-2026-10')!).includes('11.200 m³'), true)

    // 3. Switching role to USER resets data cleanly and hides staff panel without firing 403 requests
    const countBeforeRoleDrop = fetchRequests.length
    staffTab.session.me = { user_id: USER_IDS.USER, building_role: 'USER', memberships: [], locale: 'en' } as any
    await flushUpdates()
    assert.equal(fetchRequests.length, countBeforeRoleDrop)
    assert.equal(findByTestId(staffTab.root, 'building-consumption-tab'), null)
    assert.ok(findByTestId(staffTab.root, 'building-consumption-forbidden'))
    staffTab.app.unmount()

    // 4. When building metadata failed (knownApartmentsCount = null), omits "(of N)" and NEVER shows 36
    const noBuilding = await mountComponent(BuildingConsumptionTab, {
      role: 'BOARD',
      lang: 'en',
      buildingCount: null,
    })
    const noBuildingText = collectText(noBuilding.root)
    assert.equal(noBuildingText.includes('of 36'), false)
    assert.equal(noBuildingText.includes('36 '), false)
    noBuilding.app.unmount()

    // 5. Network/500 error shows ErrorCard, and clicking Retry recovers with data
    fetchMode = 'fail-500'
    const errTab = await mountComponent(BuildingConsumptionTab, {
      role: 'ACCOUNTANT',
      lang: 'en',
      buildingCount: 6,
    })
    assert.equal(findByTestId(errTab.root, 'building-consumption-table-COLD_WATER'), null)
    const retryBtn = findAll(
      errTab.root,
      (n) => n.kind === 'element' && n.tag === 'button' && collectText(n).includes('Try again'),
    )[0]
    assert.ok(retryBtn, 'Retry button should render on failed consumption fetch')

    fetchMode = 'ok'
    retryBtn.props.onClick()
    await flushUpdates()
    assert.ok(findByTestId(errTab.root, 'building-consumption-table-COLD_WATER'))
    errTab.app.unmount()

    // 6. Unmounting while a request is in-flight aborts the fetch signal cleanly
    fetchRequests.length = 0
    deferredResolvers = []
    fetchMode = 'deferred'
    const pendingTab = await mountComponent(BuildingConsumptionTab, {
      role: 'CHAIRMAN',
      lang: 'en',
      buildingCount: 6,
    })
    assert.equal(fetchRequests.length, 1)
    assert.equal(fetchRequests[0].aborted, false)
    pendingTab.app.unmount()
    await flushUpdates()
    assert.equal(fetchRequests[0].aborted, true)
    fetchMode = 'ok'

    // 7. AccountingView: Direct visit to /accounting?tab=consumption as Resident (USER)
    // Strictly hides building-consumption-tab & accounting-tab-consumption, renders accounting-forbidden, fires 0 requests
    fetchRequests.length = 0
    const residentAcc = await mountComponent(AccountingView, {
      role: 'USER',
      lang: 'en',
      path: '/accounting?tab=consumption',
    })
    assert.equal(fetchRequests.length, 0)
    assert.equal(findByTestId(residentAcc.root, 'accounting-tab-consumption'), null)
    assert.equal(findByTestId(residentAcc.root, 'accounting-tab-matrix'), null)
    assert.equal(findByTestId(residentAcc.root, 'building-consumption-tab'), null)
    assert.ok(findByTestId(residentAcc.root, 'accounting-forbidden'))
    residentAcc.app.unmount()

    // 8. AccountingView: Staff across en/et/ru never render 0/36 or matrix before opening matrix tab
    for (const [role, lang] of [
      ['BOARD', 'en'],
      ['CHAIRMAN', 'et'],
      ['ACCOUNTANT', 'ru'],
    ] as const) {
      const staffAcc = await mountComponent(AccountingView, {
        role,
        lang,
        path: '/accounting?tab=consumption',
        buildingCount: 6,
      })
      assert.ok(findByTestId(staffAcc.root, 'accounting-tab-consumption'))
      assert.ok(findByTestId(staffAcc.root, 'building-consumption-tab'))
      const matrixTabBtn = findByTestId(staffAcc.root, 'accounting-tab-matrix')!
      assert.equal(collectText(matrixTabBtn).includes('/'), false)
      staffAcc.app.unmount()
    }

    // 9. ReadingsView: strictly hides consumption links for USER, shows for ACCOUNTANT (empty) and BOARD (with header link)
    const residentReadings = await mountComponent(ReadingsView, {
      role: 'USER',
      lang: 'en',
      path: '/readings',
      memberships: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000314',
          apartment_number: '14',
          relation_type: 'OWNER',
          can_submit_readings: true,
        },
      ],
    })
    assert.equal(findByTestId(residentReadings.root, 'readings-staff-consumption-link'), null)
    assert.equal(findByTestId(residentReadings.root, 'readings-header-consumption-link'), null)
    residentReadings.app.unmount()

    const accReadings = await mountComponent(ReadingsView, {
      role: 'ACCOUNTANT',
      lang: 'en',
      path: '/readings',
    })
    assert.ok(findByTestId(accReadings.root, 'readings-staff-consumption-link'))
    accReadings.app.unmount()

    stubDashboardApartments = [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        apartment_number: '01',
        can_submit_readings: true,
        meters: [],
      },
    ]
    const boardReadings = await mountComponent(ReadingsView, {
      role: 'BOARD',
      lang: 'et',
      path: '/readings',
      memberships: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000301',
          apartment_number: '01',
          relation_type: 'OWNER',
          can_submit_readings: true,
        },
      ],
    })
    assert.ok(
      findByTestId(boardReadings.root, 'readings-header-consumption-link'),
      `Missing readings-header-consumption-link. Rendered text: ${collectText(boardReadings.root).slice(0, 300)}`,
    )
    boardReadings.app.unmount()
    stubDashboardApartments = []

    setDemoUser('')
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) {
      delete (globalThis as any).window
    } else {
      ;(globalThis as any).window = originalWindow
    }
    await vite.close()
  }
})
