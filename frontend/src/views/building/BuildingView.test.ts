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
  const bodyNode: VTestNode = {
    kind: 'element',
    tag: 'body',
    props: {},
    children: [],
    parentNode: null,
  }

  const nodeOps = {
    patchProp(el: VTestNode, key: string, _prevValue: any, nextValue: any) {
      if (key === 'class') {
        el.props.class = Array.isArray(nextValue) ? nextValue.join(' ') : nextValue
      } else {
        el.props[key] = nextValue
      }
    },
    insert(child: VTestNode, parent: VTestNode, anchor?: VTestNode | null) {
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
    remove(child: VTestNode) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx !== -1) child.parentNode.children.splice(idx, 1)
        child.parentNode = null
      }
    },
    createElement(type: string) {
      return {
        kind: 'element',
        tag: type,
        props: {},
        children: [],
        parentNode: null,
        getRootNode() {
          return bodyNode
        },
        contains() {
          return false
        },
        addEventListener() {},
        removeEventListener() {},
      } as any
    },
    createText(text: string): VTestNode {
      return { kind: 'text', props: {}, text, children: [], parentNode: null }
    },
    createComment(text: string): VTestNode {
      return { kind: 'comment', props: {}, text, children: [], parentNode: null }
    },
    setText(node: VTestNode, text: string) {
      node.text = text
    },
    setElementText(el: VTestNode, text: string) {
      el.children = [{ kind: 'text', props: {}, text, children: [], parentNode: el }]
    },
    parentNode(node: VTestNode) {
      return node.parentNode
    },
    nextSibling(node: VTestNode) {
      const parent = node.parentNode
      if (!parent) return null
      const idx = parent.children.indexOf(node)
      return idx >= 0 && idx + 1 < parent.children.length ? parent.children[idx + 1] : null
    },
    cloneNode(node: VTestNode): VTestNode {
      return {
        ...node,
        props: { ...node.props },
        children: node.children.map((c) => ({ ...c })),
        parentNode: null,
      }
    },
    insertStaticContent(content: string, parent: VTestNode, anchor: VTestNode | null) {
      const node: VTestNode = {
        kind: 'text',
        props: {},
        text: content.replace(/<[^>]+>/g, ' '),
        children: [],
        parentNode: null,
      }
      nodeOps.insert(node, parent, anchor)
      return [node, node] as [VTestNode, VTestNode]
    },
    querySelector(selector: string) {
      if (selector === 'body') return bodyNode
      return null
    },
  }

  const { createApp } = createRenderer<VTestNode, VTestNode>(nodeOps as any)

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
    return (
      findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === testId)[0] ||
      findAll(bodyNode, (n) => n.kind === 'element' && n.props['data-testid'] === testId)[0] ||
      null
    )
  }

  async function flushUpdates(ticks = 12) {
    for (let i = 0; i < ticks; i += 1) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  return { createApp, bodyNode, collectText, findAll, findByTestId, flushUpdates }
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

function createDocAndWindowSpy() {
  const docListeners = new Map<string, Set<Function>>()
  const winListeners = new Map<string, Set<Function>>()
  const documentObj = {
    visibilityState: 'visible',
    addEventListener(type: string, fn: Function) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: Function) {
      docListeners.get(type)?.delete(fn)
    },
  }
  const windowObj = {
    addEventListener(type: string, fn: Function) {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: Function) {
      winListeners.get(type)?.delete(fn)
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    location: { search: '' },
  }
  return { documentObj, windowObj }
}

test('BuildingView renders accepted ee/1 sections, exact decimals, empty energy cert text, and no personal data (#034)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { createDemoEeBuildingFacts } = await vite.ssrLoadModule('/src/utils/buildingPassport.js')
    const { default: BuildingView } = await vite.ssrLoadModule('/src/views/building/BuildingView.vue')

    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response(JSON.stringify({}), { status: 200 })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/building', name: 'building', component: Dummy },
        { path: '/settings/association', name: 'association-settings', component: Dummy },
      ],
    })
    await router.push('/building')
    await router.isReady()

    const facts = createDemoEeBuildingFacts('2026-11-15T09:00:00Z')
    // Inject trailing-zero decimal string & nullable heated_area to verify exact preservation
    facts.building.closed_net_area_m2 = '2001.40'
    facts.building.lifts = null

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.USER)
    session.me = {
      user_id: USER_IDS.USER,
      building_role: 'USER',
      memberships: [],
      locale: 'en',
    } as any
    session.building = {
      building_id: 'b1',
      name: 'KÜ Sõpruse 12',
      address: 'Sõpruse pst 12, Tallinn',
      registry_facts: facts,
    } as any

    const RootWrapper = defineComponent({
      setup() {
        return () => h(BuildingView)
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    assert.equal(fetchCount, 0, 'BuildingView must reuse session.building without issuing new API requests')
    assert.ok(findByTestId(root, 'ee-building-facts'))
    assert.equal(findByTestId(root, 'building-passport-empty'), null)

    // Basics: exact year, zeroes rendered as "0", lifts null -> "-", calendar date in UTC, translated purpose
    assert.match(collectText(findByTestId(root, 'basic-row-first_use_year')!), /1978/)
    assert.match(collectText(findByTestId(root, 'basic-row-floors_min')!), /-1/)
    assert.match(collectText(findByTestId(root, 'basic-row-lifts')!), /-\s*$/)
    assert.match(collectText(findByTestId(root, 'basic-row-purpose')!), /Apartment building/)
    assert.match(collectText(findByTestId(root, 'basic-row-construction_started_on')!), /12 Apr 1976/)

    // Areas: decimal string "2001.40" MUST NOT be truncated to "2001.4"
    const areaText = collectText(findByTestId(root, 'area-row-closed_net_area_m2')!)
    assert.ok(areaText.includes('2001.40 m²'), `Expected trailing zero preserved, got: ${areaText}`)

    // Units table rendered with nullable number -> "-" and zero resident names
    const unitRows = findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === 'building-unit-row')
    assert.equal(unitRows.length, facts.units.length)
    const commonUnitText = collectText(unitRows[facts.units.length - 1])
    assert.match(commonUnitText, /^\s*-\s+Common space/)
    assert.match(commonUnitText, /98\.5 m²/)

    // Energy certificate & technical & cadastral & source line (including cert dates & ETA value_type distinction)
    const energySectionText = collectText(findByTestId(root, 'building-energy-section')!)
    assert.ok(findByTestId(root, 'building-energy-card'))
    assert.match(energySectionText, /Class C/)
    assert.match(energySectionText, /18 Mar 2024/)
    assert.match(energySectionText, /18 Mar 2034/)
    assert.match(energySectionText, /142 \(Calculated energy indicator \(ETA\)\)/)
    assert.match(collectText(findByTestId(root, 'building-technical-section')!), /Foundation type/)
    assert.match(collectText(findByTestId(root, 'building-technical-section')!), /Kaugküte/)
    assert.match(collectText(findByTestId(root, 'building-cadastral-section')!), /78407:701:0421/)
    const sourceText = collectText(findByTestId(root, 'building-source-line')!)
    assert.match(sourceText, /Source: Ehitisregister,/)
    assert.match(sourceText, /15 Nov 2026/)

    // Zero integer values render "0" (not "-"), empty units/technical/cadastral/energy lists + blank cert state pill
    session.building = {
      ...session.building,
      registry_facts: {
        ...facts,
        building: { ...facts.building, lifts: 0, floors_max: 0 },
        units: [],
        technical: [],
        cadastral_units: [],
        energy_certificates: [
          {
            ...facts.energy_certificates[0],
            state: { code: null, label_et: null },
          },
        ],
      },
    } as any
    await flushUpdates()
    assert.match(collectText(findByTestId(root, 'basic-row-lifts')!), /0\s*$/)
    assert.match(collectText(findByTestId(root, 'basic-row-floors_max')!), /0\s*$/)
    assert.ok(findByTestId(root, 'building-units-empty'))
    assert.ok(findByTestId(root, 'building-technical-empty'))
    assert.ok(findByTestId(root, 'building-cadastral-empty'))
    assert.ok(!collectText(findByTestId(root, 'building-energy-card')!).includes('-\n'))

    // Empty energy_certificates list displays localized empty message + switching to ru updates texts
    session.building = {
      ...session.building,
      registry_facts: {
        ...facts,
        energy_certificates: [],
      },
    } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'building-energy-card'), null)
    const energyEmpty = findByTestId(root, 'building-energy-empty')!
    assert.match(collectText(energyEmpty), /No energy certificate in the register/)

    session.setLang('ru')
    await flushUpdates()
    assert.match(collectText(findByTestId(root, 'building-energy-empty')!), /В реестре нет энергосертификата/)

    session.setLang('et')
    await flushUpdates()
    assert.match(collectText(findByTestId(root, 'building-energy-empty')!), /Registris puudub energiamärgis/)
  } finally {
    app?.unmount?.()
    globalThis.fetch = originalFetch
    await vite.close()
  }
})

test('BuildingView renders skeleton during loading and ErrorCard with retry without leaking demo address (#034)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: BuildingView } = await vite.ssrLoadModule('/src/views/building/BuildingView.vue')

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/building', name: 'building', component: Dummy },
        { path: '/settings/association', name: 'association-settings', component: Dummy },
      ],
    })
    await router.push('/building')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    setDemoUser(USER_IDS.USER)
    session.me = { user_id: USER_IDS.USER, building_role: 'USER', memberships: [] } as any
    session.building = null
    session.buildingLoading = true
    session.buildingError = null

    const RootWrapper = defineComponent({
      setup() {
        return () => h(BuildingView)
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    assert.ok(findByTestId(root, 'building-passport-skeleton'))
    assert.equal(findByTestId(root, 'building-passport-error'), null)
    assert.equal(collectText(root).includes('Sõpruse pst 12, Kristiine, Tallinn'), false)

    // Failure state renders ErrorCard instead of empty state and does not leak fallback demo address
    session.buildingLoading = false
    session.buildingError = { status: 500, errorCode: 'INTERNAL_SERVER_ERROR' } as any
    await flushUpdates()

    const errCard = findByTestId(root, 'building-passport-error')
    assert.ok(errCard, 'Expected ErrorCard when session.buildingError is present')
    assert.equal(findByTestId(root, 'building-passport-empty'), null)
    assert.equal(collectText(root).includes('Sõpruse pst 12, Kristiine, Tallinn'), false)

    // Clicking retry triggers session.refreshBuilding() and recovers view
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          building_id: 'b1',
          name: 'Recovered Building',
          address: 'Recovered Street 5',
          registry_facts: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    const retryBtn = findAll(errCard!, (n) => n.kind === 'element' && n.tag === 'button')[0]
    assert.ok(retryBtn)
    await retryBtn.props.onClick()
    await flushUpdates()
    assert.equal(findByTestId(root, 'building-passport-error'), null)
    assert.ok(findByTestId(root, 'building-passport-empty'))
    assert.ok(collectText(root).includes('Recovered Street 5'))
  } finally {
    app?.unmount?.()
    globalThis.fetch = originalFetch
    await vite.close()
  }
})

test('BuildingView renders empty state cleanly for null or unknown schema and shows settings link only to chairman (#034)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId, flushUpdates } = createFakeDomHarness()
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { createDemoEeBuildingFacts } = await vite.ssrLoadModule('/src/utils/buildingPassport.js')
    const { default: BuildingView } = await vite.ssrLoadModule('/src/views/building/BuildingView.vue')

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/building', name: 'building', component: Dummy },
        { path: '/settings/association', name: 'association-settings', component: Dummy },
      ],
    })
    await router.push('/building')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.USER)
    session.me = { user_id: USER_IDS.USER, building_role: 'USER', memberships: [] } as any
    session.building = {
      building_id: 'b1',
      name: 'KÜ Sõpruse 12',
      address: 'Sõpruse pst 12, Tallinn',
      registry_facts: null,
    } as any

    const RootWrapper = defineComponent({
      setup() {
        return () => h(BuildingView)
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    const emptyEl = findByTestId(root, 'building-passport-empty')
    assert.ok(emptyEl)
    assert.match(collectText(emptyEl!), /The chairman has not added the building's register data yet/)
    assert.equal(findByTestId(root, 'building-open-settings-link'), null, 'Resident should not see chairman settings link')

    // Chairman sees settings link to #035 block
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any
    setDemoUser(USER_IDS.CHAIRMAN)
    await flushUpdates()
    const settingsLink = findByTestId(root, 'building-open-settings-link')
    assert.ok(settingsLink, 'Chairman should see settings link on empty building passport')
    assert.equal(settingsLink!.props.href, '/settings/association#building-register')

    // Unknown schema ("ee/99") renders empty state cleanly without errors
    const unknownSchemaFacts = { ...createDemoEeBuildingFacts(), schema: 'ee/99' }
    session.building = { ...session.building, registry_facts: unknownSchemaFacts } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'ee-building-facts'), null)
    assert.ok(findByTestId(root, 'building-passport-empty'))

    // Unknown country ("LV") also renders empty state cleanly
    const unknownCountryFacts = { ...createDemoEeBuildingFacts(), country_code: 'LV' }
    session.building = { ...session.building, registry_facts: unknownCountryFacts } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'ee-building-facts'), null)
    assert.ok(findByTestId(root, 'building-passport-empty'))
  } finally {
    app?.unmount?.()
    await vite.close()
  }
})

test('DashboardBuildingCard visibility and navigation links work across roles without extra requests (#034)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  const { documentObj, windowObj } = createDocAndWindowSpy()
  ;(globalThis as any).window = windowObj
  ;(globalThis as any).document = documentObj

  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { createDemoEeBuildingFacts } = await vite.ssrLoadModule('/src/utils/buildingPassport.js')
    const { default: DashboardBuildingCard } = await vite.ssrLoadModule(
      '/src/views/dashboard/components/DashboardBuildingCard.vue',
    )
    const { default: AppSidebar } = await vite.ssrLoadModule('/src/layouts/components/AppSidebar.vue')
    const { default: AppBottomNav } = await vite.ssrLoadModule('/src/layouts/components/AppBottomNav.vue')

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/building', name: 'building', component: Dummy },
        { path: '/readings', name: 'readings', component: Dummy },
        { path: '/forum', name: 'forum', component: Dummy },
        { path: '/messages', name: 'messages', component: Dummy },
        { path: '/polls', name: 'polls', component: Dummy },
      ],
    })
    await router.push('/')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.ACCOUNTANT)
    session.me = { user_id: USER_IDS.ACCOUNTANT, building_role: 'ACCOUNTANT', memberships: [] } as any
    session.building = {
      building_id: 'b1',
      name: 'KÜ Sõpruse 12',
      address: 'Sõpruse pst 12, Tallinn',
      registry_facts: null,
    } as any

    const Combined = defineComponent({
      setup() {
        return () => h('div', [h(AppSidebar), h(AppBottomNav), h(DashboardBuildingCard)])
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(Combined)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // Null registry_facts -> DashboardBuildingCard hidden
    assert.equal(findByTestId(root, 'dashboard-building-card'), null)

    // Nav links present in home group even for Accountant
    const homeGroupBtn = findByTestId(root, 'nav-group-home')!
    assert.ok(homeGroupBtn)
    await homeGroupBtn.props.onClick({ stopPropagation() {} })
    await flushUpdates()
    const navBuildingLink = findByTestId(root, 'nav-link-building')
    assert.ok(navBuildingLink)
    assert.equal(navBuildingLink!.props.href, '/building')

    // Mobile sheet home group also includes building
    const mobileHomeBtn = findByTestId(root, 'mobile-nav-group-home')!
    await mobileHomeBtn.props.onClick()
    await flushUpdates()
    assert.ok(findByTestId(root, 'mobile-nav-link-building'))

    // When registry_facts is populated -> DashboardBuildingCard shows year, floors, energy class and links to /building
    session.building = {
      ...session.building,
      registry_facts: createDemoEeBuildingFacts(),
    } as any
    await flushUpdates()

    const card = findByTestId(root, 'dashboard-building-card')
    assert.ok(card, 'DashboardBuildingCard must appear once registry_facts is set')
    assert.equal(card!.props.href, '/building')
    assert.match(collectText(findByTestId(root, 'dashboard-building-year')!), /1978/)
    assert.match(collectText(findByTestId(root, 'dashboard-building-floors')!), /5/)
    assert.match(collectText(findByTestId(root, 'dashboard-building-energy')!), /C/)

    // Empty energy_certificates + null year/floors render "-" consistently
    const partialFacts = createDemoEeBuildingFacts()
    partialFacts.building.first_use_year = null
    partialFacts.building.floors_max = null
    partialFacts.energy_certificates = []
    session.building = { ...session.building, registry_facts: partialFacts } as any
    await flushUpdates()
    assert.match(collectText(findByTestId(root, 'dashboard-building-year')!), /-\s*$/)
    assert.match(collectText(findByTestId(root, 'dashboard-building-floors')!), /-\s*$/)
    assert.match(collectText(findByTestId(root, 'dashboard-building-energy')!), /-\s*$/)

    // Unknown schema hides DashboardBuildingCard
    session.building = {
      ...session.building,
      registry_facts: { ...createDemoEeBuildingFacts(), schema: 'ee/99' },
    } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'dashboard-building-card'), null)
  } finally {
    app?.unmount?.()
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    await vite.close()
  }
})
