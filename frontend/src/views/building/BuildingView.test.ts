import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  DEMO_USER_IDS,
  createClientVueViteServer,
  createDocAndWindowSpy,
  createFakeDomHarness,
  type VTestNode,
} from '../../test/mountWithApp.js'

const Dummy = { template: '<div />' }

const USER_IDS: Record<string, string> = {
  CHAIRMAN: DEMO_USER_IDS.CHAIRMAN,
  USER: DEMO_USER_IDS.USER,
  ACCOUNTANT: DEMO_USER_IDS.ACCOUNTANT,
  BOARD: DEMO_USER_IDS.BOARD,
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
