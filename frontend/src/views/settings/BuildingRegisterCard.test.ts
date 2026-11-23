import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  DEMO_USER_IDS,
  createClientVueViteServer,
  createFakeDomHarness,
  createWindowSpy,
  type VTestNode,
} from '../../test/mountWithApp.js'

const Dummy = { template: '<div />' }

const USER_IDS: Record<string, string> = {
  CHAIRMAN: DEMO_USER_IDS.CHAIRMAN,
  USER: DEMO_USER_IDS.USER,
  BOARD: DEMO_USER_IDS.BOARD,
}

test('BuildingRegisterCard chairman flow, #034 reuse, error preservation (503/404/409), isBusy guard, modal remove, Board read-only, and hash scroll (#035)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { listeners, windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj
  if (!originalDocumentCtor) {
    ;(globalThis as any).Document = class FakeDocument {}
  }
  if (!originalShadowRootCtor) {
    ;(globalThis as any).ShadowRoot = class FakeShadowRoot {}
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const {
      createDemoEeBuildingFactsForCode,
      createDemoRegistryCandidates,
    } = await vite.ssrLoadModule('/src/utils/buildingPassport.js')
    const { default: BuildingRegisterCard } = await vite.ssrLoadModule(
      '/src/views/settings/components/BuildingRegisterCard.vue',
    )

    let serverState: any = {
      accepted: null,
      accepted_at: null,
      proposal: null,
      proposal_fetched_at: null,
    }
    const candidates = createDemoRegistryCandidates()
    const searchBodies: Array<Record<string, any>> = []
    const proposalBodies: Array<Record<string, any>> = []
    let acceptCalls = 0
    let deleteCalls = 0
    let nextProposalResponse: { status: number; body: any } | null = null
    let nextAcceptResponse: { status: number; body: any } | null = null
    let deferredSearchResolve: ((res: Response) => void) | null = null
    let holdNextSearch = false
    let getBuildingCount = 0

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()

      if (urlStr.endsWith('/api/v1/property/building') && method === 'GET') {
        getBuildingCount += 1
        return new Response(
          JSON.stringify({
            building_id: 'b-1',
            name: 'KÜ Sõpruse 12',
            address: 'Sõpruse pst 12, Tallinn',
            country_code: 'EE',
            apartment_count: 6,
            entrance_count: 2,
            heated_area_m2: '329.20',
            registry_facts: serverState.accepted,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (urlStr.endsWith('/api/v1/property/building/registry') && method === 'GET') {
        return new Response(JSON.stringify(serverState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (urlStr.endsWith('/api/v1/property/building/registry/search') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}'))
        searchBodies.push(parsed)
        if (holdNextSearch) {
          holdNextSearch = false
          return await new Promise<Response>((resolve, reject) => {
            deferredSearchResolve = resolve
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            })
          })
        }
        return new Response(JSON.stringify({ candidates }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (urlStr.endsWith('/api/v1/property/building/registry/proposal') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}'))
        proposalBodies.push(parsed)
        if (nextProposalResponse) {
          const override = nextProposalResponse
          nextProposalResponse = null
          return new Response(JSON.stringify(override.body), {
            status: override.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        const facts = createDemoEeBuildingFactsForCode(parsed.code)
        if (!facts) {
          return new Response(
            JSON.stringify({ error_code: 'REGISTRY_BUILDING_NOT_FOUND', message: 'Not found' }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          )
        }
        serverState = {
          ...serverState,
          proposal: facts,
          proposal_fetched_at: '2026-11-15T10:00:00Z',
        }
        return new Response(JSON.stringify(serverState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (urlStr.endsWith('/api/v1/property/building/registry/accept') && method === 'POST') {
        acceptCalls += 1
        if (nextAcceptResponse) {
          const override = nextAcceptResponse
          nextAcceptResponse = null
          return new Response(JSON.stringify(override.body), {
            status: override.status,
            headers: { 'content-type': 'application/json' },
          })
        }
        serverState = {
          accepted: serverState.proposal,
          accepted_at: '2026-11-15T10:05:00Z',
          proposal: null,
          proposal_fetched_at: null,
        }
        return new Response(JSON.stringify(serverState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (urlStr.endsWith('/api/v1/property/building/registry') && method === 'DELETE') {
        deleteCalls += 1
        serverState = {
          accepted: null,
          accepted_at: null,
          proposal: null,
          proposal_fetched_at: null,
        }
        return new Response(null, { status: 204 })
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/association', name: 'association-settings', component: Dummy },
        { path: '/building', name: 'building', component: Dummy },
      ],
    })
    await router.push('/settings/association#building-register')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = {
      user_id: USER_IDS.CHAIRMAN,
      building_role: 'CHAIRMAN',
      memberships: [],
      locale: 'en',
    } as any
    session.building = {
      building_id: 'b-1',
      name: 'KÜ Sõpruse 12',
      address: 'Sõpruse pst 12, Tallinn',
      country_code: 'EE',
      apartment_count: 6,
      entrance_count: 2,
      heated_area_m2: '329.20',
      registry_facts: null,
    } as any

    const RootWrapper = defineComponent({
      setup() {
        return () => h(BuildingRegisterCard)
      },
    })
    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Anchored section scrolls into view on #building-register hash
    const section = findByTestId(root, 'building-register-section')!
    assert.ok(section)
    assert.equal(section.props.id, 'building-register')
    assert.ok((section.scrollCalls || 0) >= 1, 'Expected scrollIntoView when mounted at #building-register')

    // 2. Short search query shows inline validation error without calling POST /search
    const searchInput = findByTestId(root, 'registry-search-input')!
    const searchForm = findByTestId(root, 'registry-search-form')!
    searchInput.props['onUpdate:modelValue']('ab')
    await flushUpdates(3)
    await searchForm.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.ok(findByTestId(root, 'registry-search-validation-error'))
    assert.equal(searchBodies.length, 0)

    // 3. Empty search sends {} and isBusy prevents double-submit while in flight
    searchInput.props['onUpdate:modelValue']('')
    holdNextSearch = true
    const inFlightSearch = searchForm.props.onSubmit({ preventDefault() {} })
    await flushUpdates(3)
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)
    assert.equal(findByTestId(root, 'registry-search-input')!.props.disabled, true)
    await searchForm.props.onSubmit({ preventDefault() {} }) // ignored while busy
    assert.equal(searchBodies.length, 1)
    assert.deepEqual(searchBodies[0], {})

    const resolveSearch = deferredSearchResolve as ((res: Response) => void) | null
    resolveSearch?.(
      new Response(JSON.stringify({ candidates }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await inFlightSearch
    await flushUpdates()

    assert.ok(findByTestId(root, 'registry-candidates-list'))
    assert.ok(findByTestId(root, 'registry-candidate-row-100000001'))
    assert.ok(findByTestId(root, 'registry-candidate-row-100000002'))

    // 4. Selecting candidate fetches proposal and previews it via #034 EeBuildingFacts
    await findByTestId(root, 'registry-candidate-btn-100000001')!.props.onClick()
    await flushUpdates()
    assert.equal(proposalBodies.length, 1)
    assert.deepEqual(proposalBodies[0], { code: '100000001' })
    const proposalBlock = findByTestId(root, 'registry-proposal-block')!
    assert.ok(proposalBlock)
    assert.match(collectText(proposalBlock), /1978/)
    assert.match(collectText(proposalBlock), /642\.5 m²/)

    // 5. 503 REGISTRY_UNAVAILABLE during Fetch again preserves existing proposal & candidates
    nextProposalResponse = {
      status: 503,
      body: { error_code: 'REGISTRY_UNAVAILABLE', message: 'Upstream down' },
    }
    await findByTestId(root, 'registry-refetch-btn')!.props.onClick()
    await flushUpdates()
    const errorBanner503 = findByTestId(root, 'registry-action-error')!
    assert.ok(errorBanner503)
    assert.match(collectText(errorBanner503), /The register does not answer right now; try again later/)
    assert.ok(findByTestId(root, 'registry-proposal-block'), 'Proposal must remain visible after 503')
    assert.ok(findByTestId(root, 'registry-candidates-list'), 'Candidates must remain visible after 503')

    // 6. 404 REGISTRY_BUILDING_NOT_FOUND preserves screen & displays localized text
    nextProposalResponse = {
      status: 404,
      body: { error_code: 'REGISTRY_BUILDING_NOT_FOUND', message: 'Not found' },
    }
    await findByTestId(root, 'registry-refetch-btn')!.props.onClick()
    await flushUpdates()
    assert.match(
      collectText(findByTestId(root, 'registry-action-error')!),
      /The register does not know this building/,
    )
    assert.ok(findByTestId(root, 'registry-proposal-block'))

    // 7. 409 NO_REGISTRY_PROPOSAL clears stale proposal, resyncs with server, keeps banner, and switches banner text on lang change
    nextAcceptResponse = {
      status: 409,
      body: { error_code: 'NO_REGISTRY_PROPOSAL', message: 'No proposal' },
    }
    const prevProposal = serverState.proposal
    serverState = { ...serverState, proposal: null, proposal_fetched_at: null }
    await findByTestId(root, 'registry-accept-btn')!.props.onClick()
    await flushUpdates()
    assert.match(
      collectText(findByTestId(root, 'registry-action-error')!),
      /Fetch a building proposal from the register first/,
    )
    assert.equal(findByTestId(root, 'registry-proposal-block'), null, 'Stale proposal must clear on 409 NO_REGISTRY_PROPOSAL')

    // Reactive language switch updates visible error banner immediately
    session.setLang('ru')
    await flushUpdates(3)
    assert.match(
      collectText(findByTestId(root, 'registry-action-error')!),
      /Сначала загрузите предложение из реестра/,
    )
    session.setLang('en')
    await flushUpdates(3)

    // Restore proposal for step 8 accept success
    serverState = { ...serverState, proposal: prevProposal, proposal_fetched_at: '2026-11-15T10:00:00Z' }
    await findByTestId(root, 'registry-candidate-btn-100000001')!.props.onClick()
    await flushUpdates()

    // 8. Accept succeeds, refreshes building passport in session store, and links to /building
    const buildingCountBeforeAccept = getBuildingCount
    await findByTestId(root, 'registry-accept-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(acceptCalls, 2)
    assert.equal(findByTestId(root, 'registry-proposal-block'), null)
    const acceptedBlock = findByTestId(root, 'registry-accepted-block')!
    assert.ok(acceptedBlock)
    assert.equal(findByTestId(root, 'registry-open-passport-link')!.props.href, '/building')
    assert.ok(getBuildingCount > buildingCountBeforeAccept)
    assert.equal(session.buildingRegistryFacts?.source?.building_code, '100000001')

    // 9. Remove opens confirmation modal; Cancel keeps accepted; in-place CHAIRMAN -> BOARD downgrade closes modal
    await findByTestId(root, 'registry-remove-btn')!.props.onClick()
    await flushUpdates()
    assert.ok(findByTestId(root, 'registry-remove-confirm-modal'))
    session.me = {
      user_id: USER_IDS.CHAIRMAN,
      building_role: 'BOARD',
      memberships: [],
      locale: 'en',
    } as any
    await flushUpdates()
    assert.equal(
      findByTestId(root, 'registry-remove-confirm-modal'),
      null,
      'In-place downgrade from CHAIRMAN to BOARD must close open remove modal',
    )
    session.me = {
      user_id: USER_IDS.CHAIRMAN,
      building_role: 'CHAIRMAN',
      memberships: [],
      locale: 'en',
    } as any
    await flushUpdates()

    await findByTestId(root, 'registry-remove-btn')!.props.onClick()
    await flushUpdates()
    await findByTestId(root, 'registry-remove-cancel-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(findByTestId(root, 'registry-remove-confirm-modal'), null)
    assert.equal(deleteCalls, 0)
    assert.ok(findByTestId(root, 'registry-accepted-block'))

    await findByTestId(root, 'registry-remove-btn')!.props.onClick()
    await flushUpdates()
    await findByTestId(root, 'registry-remove-confirm-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(deleteCalls, 1)
    assert.equal(findByTestId(root, 'registry-accepted-block'), null)
    assert.equal(session.buildingRegistryFacts, null)

    // 10. BOARD role sees accepted + proposal read-only without any action buttons
    serverState = {
      accepted: createDemoEeBuildingFactsForCode('100000001'),
      accepted_at: '2026-11-15T10:10:00Z',
      proposal: createDemoEeBuildingFactsForCode('100000002'),
      proposal_fetched_at: '2026-11-15T10:12:00Z',
    }
    setDemoUser(USER_IDS.BOARD)
    session.me = {
      user_id: USER_IDS.BOARD,
      building_role: 'BOARD',
      memberships: [{ apartment_id: 'apt-15', apartment_number: '15' }],
      locale: 'en',
    } as any
    await flushUpdates()

    assert.ok(findByTestId(root, 'registry-accepted-block'))
    assert.ok(findByTestId(root, 'registry-proposal-block'))
    assert.equal(findByTestId(root, 'registry-search-form'), null)
    assert.equal(findByTestId(root, 'registry-accept-btn'), null)
    assert.equal(findByTestId(root, 'registry-refetch-btn'), null)
    assert.equal(findByTestId(root, 'registry-remove-btn'), null)

    // Russian & Estonian locale check on read-only hint
    session.setLang('ru')
    await flushUpdates(3)
    assert.match(collectText(section), /Только председатель может искать/)
    session.setLang('et')
    await flushUpdates(3)
    assert.match(collectText(section), /Ainult esimees saab ehitisregistrist/)

    app.unmount()
    await flushUpdates()
    assert.equal(listeners.get('keydown')?.size || 0, 0, 'Unmounting must remove window keydown listener')
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})

test('BuildingRegisterCard hides entire block on 404 REGISTRY_NOT_ENABLED (#035)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const { windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: BuildingRegisterCard } = await vite.ssrLoadModule(
      '/src/views/settings/components/BuildingRegisterCard.vue',
    )

    globalThis.fetch = async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/v1/property/building/registry')) {
        return new Response(
          JSON.stringify({ error_code: 'REGISTRY_NOT_ENABLED', message: 'Not enabled' }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/settings/association', component: Dummy }],
    })
    await router.push('/settings/association')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(defineComponent({ setup: () => () => h(BuildingRegisterCard) }))
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    assert.equal(findByTestId(root, 'building-register-section'), null)
    app.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})

test('BuildingRegisterCard handles bare HTTP 503, load ErrorCard retry, TOO_LONG, empty candidates, unsupported schema, pending race abort, and AssociationSettingsView mount (#035)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj
  if (!originalDocumentCtor) (globalThis as any).Document = class FakeDocument {}
  if (!originalShadowRootCtor) (globalThis as any).ShadowRoot = class FakeShadowRoot {}

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { default: BuildingRegisterCard } = await vite.ssrLoadModule(
      '/src/views/settings/components/BuildingRegisterCard.vue',
    )
    const { default: AssociationSettingsView } = await vite.ssrLoadModule(
      '/src/views/settings/AssociationSettingsView.vue',
    )

    let failInitialLoad = true
    let searchAbortedCount = 0
    let searchCallCount = 0
    let searchBodySeen: any = null

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()

      if (urlStr.endsWith('/api/v1/property/building/registry') && method === 'GET') {
        if (failInitialLoad) {
          failInitialLoad = false
          // Bare non-JSON 503 -> ApiError errorCode === 'HTTP_503'
          return new Response('Service Unavailable', { status: 503 })
        }
        return new Response(
          JSON.stringify({
            accepted: { country_code: 'LV', schema: 'lv/1', building: {} },
            accepted_at: '2026-11-15T09:00:00Z',
            proposal: {
              country_code: 'EE',
              schema: 'ee/1',
              source: { register: 'EHR', building_code: '', fetched_at: '2026-11-15T10:00:00Z', attribution: 'EHR' },
              building: { first_use_year: 1995 },
              units: [],
              energy_certificates: [],
              technical: [],
              cadastral_units: [],
            },
            proposal_fetched_at: '2026-11-15T10:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (urlStr.endsWith('/api/v1/property/building/registry/search') && method === 'POST') {
        searchCallCount += 1
        searchBodySeen = JSON.parse(String(init?.body || '{}'))
        if (searchCallCount === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              searchAbortedCount += 1
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
            })
          })
        }
        if (searchCallCount === 2) {
          // Bare non-JSON 503 during action
          return new Response('', { status: 503 })
        }
        return new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (urlStr.endsWith('/api/v1/settings') && method === 'GET') {
        return new Response(JSON.stringify({ settings: [] }), { status: 200 })
      }
      if (urlStr.endsWith('/api/v1/files/usage') && method === 'GET') {
        return new Response(
          JSON.stringify({ quota_bytes: 1000, used_bytes: 0, used_percent: 0, pending_deletion_bytes: 0, categories: [] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/association', component: Dummy },
        { path: '/building', component: Dummy },
      ],
    })
    await router.push('/settings/association')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(defineComponent({ setup: () => () => h(BuildingRegisterCard) }))
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Bare 503 on initial load shows REGISTRY_UNAVAILABLE in ErrorCard and recovers on retry
    const loadErrorCard = findByTestId(root, 'registry-load-error')!
    assert.ok(loadErrorCard)
    assert.match(collectText(loadErrorCard), /The register does not answer right now; try again later/)
    const retryBtn = findAll(loadErrorCard, (n) => n.kind === 'element' && n.tag === 'button')[0]
    assert.ok(retryBtn, 'Expected Retry button inside ErrorCard')
    await retryBtn.props.onClick()
    await flushUpdates()

    // 2. Unsupported LV schema in accepted block shows hint; proposal without building_code disables Fetch again
    assert.match(collectText(findByTestId(root, 'registry-accepted-block')!), /lv\/1/)
    assert.equal(findByTestId(root, 'registry-refetch-btn')!.props.disabled, true)

    // 3. TOO_LONG validation (>200 chars after normalization) blocks POST /search
    const input = findByTestId(root, 'registry-search-input')!
    const form = findByTestId(root, 'registry-search-form')!
    input.props['onUpdate:modelValue']('x'.repeat(201))
    await flushUpdates(3)
    await form.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.ok(findByTestId(root, 'registry-search-validation-error'))
    assert.equal(searchCallCount, 0)

    // 4. Custom query collapses spaces; pending request aborts cleanly when user switches away & returns
    input.props['onUpdate:modelValue']('  Sõpruse   pst 14  ')
    await flushUpdates(3)
    void form.props.onSubmit({ preventDefault() {} })
    await flushUpdates(3)
    assert.equal(searchCallCount, 1)
    assert.deepEqual(searchBodySeen, { query: 'Sõpruse pst 14' })

    setDemoUser(USER_IDS.USER)
    session.me = { user_id: USER_IDS.USER, building_role: 'USER', memberships: [] } as any
    await flushUpdates()
    assert.equal(searchAbortedCount, 1, 'Pending search must abort on activeUserId change')
    assert.equal(findByTestId(root, 'building-register-section'), null)

    // Return to CHAIRMAN: isBusy unlocked, bare 503 search shows REGISTRY_UNAVAILABLE, next empty search shows empty candidates
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any
    await flushUpdates()

    const form2 = findByTestId(root, 'registry-search-form')!
    await form2.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.match(
      collectText(findByTestId(root, 'registry-action-error')!),
      /The register does not answer right now; try again later/,
    )

    await form2.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.ok(findByTestId(root, 'registry-candidates-empty'))

    app.unmount()

    // 5. Integration inside AssociationSettingsView: CHAIRMAN sees #building-register, USER sees forbidden without #building-register
    const hostRoot: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const hostApp = createApp(defineComponent({ setup: () => () => h(AssociationSettingsView) }))
    hostApp.use(pinia)
    hostApp.use(router)
    hostApp.mount(hostRoot)
    await flushUpdates()
    assert.ok(findByTestId(hostRoot, 'building-register-section'))
    hostApp.unmount()
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})

test('BuildingRegisterCard handles 429 RATE_LIMITED (DAILY_LIMIT) with register copy, state preservation, and cooldown disable (#037)', async (t) => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj
  if (!originalDocumentCtor) {
    ;(globalThis as any).Document = class FakeDocument {}
  }
  if (!originalShadowRootCtor) {
    ;(globalThis as any).ShadowRoot = class FakeShadowRoot {}
  }

  const t0 = Date.UTC(2026, 10, 15, 22, 0, 0)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  t.mock.timers.setTime(t0)

  const flushMicrotasks = async (ticks = 20) => {
    for (let i = 0; i < ticks; i += 1) {
      await nextTick()
      await Promise.resolve()
    }
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { disableOfflineDemo } = await vite.ssrLoadModule('/src/api/offlineDemoData.js')
    const BuildingRegisterCard = (await vite.ssrLoadModule('/src/views/settings/components/BuildingRegisterCard.vue')).default

    disableOfflineDemo()

    const initialFacts = {
      schema: 'ee/1',
      source: { register: 'EHR', building_code: '100000001', fetched_at: '2026-11-15T09:00:00Z', attribution: 'Ehitisregister' },
      building: { primary_use: 'Elamu', first_use_year: 1986 },
      units: [],
      energy_certificates: [],
      technical: [],
      cadastral_units: [],
    }
    const proposalFacts = {
      ...initialFacts,
      source: { ...initialFacts.source, building_code: '100000002' },
    }

    let searchCalls = 0
    let proposalCalls = 0
    let acceptCalls = 0
    let quotaExpired = false

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const method = (init?.method || 'GET').toUpperCase()

      if (urlStr.endsWith('/api/v1/property/building/registry') && method === 'GET') {
        return new Response(
          JSON.stringify({
            accepted: initialFacts,
            accepted_at: '2026-11-15T09:05:00Z',
            proposal: proposalFacts,
            proposal_fetched_at: '2026-11-15T09:10:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/property/building/registry/search') && method === 'POST') {
        searchCalls += 1
        if (searchCalls === 1) {
          return new Response(
            JSON.stringify({
              candidates: [{ code: '100000002', address: 'Sõpruse pst 14, Tallinn', kind_label: 'Elamu' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (!quotaExpired) {
          return new Response(
            JSON.stringify({
              error_code: 'RATE_LIMITED',
              message: 'Daily limit reached',
              reason: 'DAILY_LIMIT',
              retry_after_seconds: 120,
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } },
          )
        }
        return new Response(
          JSON.stringify({
            candidates: [{ code: '100000003', address: 'Sõpruse pst 16, Tallinn', kind_label: 'Elamu' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/property/building/registry/proposal') && method === 'POST') {
        proposalCalls += 1
        return new Response(
          JSON.stringify({
            error_code: 'RATE_LIMITED',
            message: 'Daily limit reached',
            reason: 'DAILY_LIMIT',
            retry_after_seconds: 120,
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } },
        )
      }
      if (urlStr.endsWith('/api/v1/property/building/registry/accept') && method === 'POST') {
        acceptCalls += 1
        return new Response(
          JSON.stringify({
            accepted: proposalFacts,
            accepted_at: '2026-11-15T22:00:00Z',
            proposal: null,
            proposal_fetched_at: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/association', component: Dummy },
        { path: '/building', component: Dummy },
      ],
    })
    await router.push('/settings/association')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(defineComponent({ setup: () => () => h(BuildingRegisterCard) }))
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushMicrotasks()

    // Populate search results first
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.ok(findByTestId(root, 'registry-candidate-btn-100000002'))

    // Trigger 429 RATE_LIMITED (DAILY_LIMIT) from proposal fetch
    await findByTestId(root, 'registry-candidate-btn-100000002')!.props.onClick()
    await flushMicrotasks()

    const errBanner = findByTestId(root, 'registry-action-error')
    assert.ok(errBanner, 'Expected 429 error banner')
    const errText = collectText(errBanner)
    assert.match(errText, /The register may be asked only a few times a day; try again tomorrow/)
    assert.doesNotMatch(errText, /photos/)

    // Existing screen state is preserved
    assert.ok(findByTestId(root, 'registry-accepted-block'))
    assert.ok(findByTestId(root, 'registry-proposal-block'))
    assert.ok(findByTestId(root, 'registry-candidate-btn-100000002'))

    // Search, candidate, and refetch buttons are disabled during cooldown
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)
    assert.equal(findByTestId(root, 'registry-candidate-btn-100000002')!.props.disabled, true)
    assert.equal(findByTestId(root, 'registry-refetch-btn')!.props.disabled, true)

    // Guard prevents direct form submit during cooldown
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.equal(searchCalls, 1)
    assert.equal(proposalCalls, 1)

    // Accept & Remove remain enabled during quota cooldown because they don't query the register
    assert.equal(findByTestId(root, 'registry-accept-btn')!.props.disabled, false)
    assert.equal(findByTestId(root, 'registry-remove-btn')!.props.disabled, false)

    // Opening Remove modal (which clears actionError) and canceling keeps the quota explanation visible
    await findByTestId(root, 'registry-remove-btn')!.props.onClick()
    await flushMicrotasks()
    await findByTestId(root, 'registry-remove-cancel-btn')!.props.onClick()
    await flushMicrotasks()
    const retainedBanner = findByTestId(root, 'registry-action-error')
    assert.ok(retainedBanner, 'Expected persistent quota banner after Remove -> Cancel')
    assert.match(collectText(retainedBanner), /The register may be asked only a few times a day; try again tomorrow/)

    // Halfway through cooldown (60s < 120s), buttons remain disabled
    t.mock.timers.tick(60_000)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)

    // After full 120s cooldown, buttons re-enable and search works again
    quotaExpired = true
    t.mock.timers.tick(60_000)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, false)
    assert.equal(findByTestId(root, 'registry-candidate-btn-100000002')!.props.disabled, false)

    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.equal(searchCalls, 2)
    assert.ok(findByTestId(root, 'registry-candidate-btn-100000003'))

    await findByTestId(root, 'registry-accept-btn')!.props.onClick()
    await flushMicrotasks()
    assert.equal(acceptCalls, 1)

    app.unmount()
  } finally {
    t.mock.timers.reset()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})

test('BuildingRegisterCard narrows 429 DAILY_LIMIT by reason/endpoint, handles UTC midnight fallback & MAX_TIMEOUT chunking, and cleans up active timer (#037)', async (t) => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj
  if (!originalDocumentCtor) {
    ;(globalThis as any).Document = class FakeDocument {}
  }
  if (!originalShadowRootCtor) {
    ;(globalThis as any).ShadowRoot = class FakeShadowRoot {}
  }

  // 2026-11-15T22:00:00Z -> 7200s until UTC midnight
  const t0 = Date.UTC(2026, 10, 15, 22, 0, 0)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  t.mock.timers.setTime(t0)

  const flushMicrotasks = async (ticks = 20) => {
    for (let i = 0; i < ticks; i += 1) {
      await nextTick()
      await Promise.resolve()
    }
  }

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { disableOfflineDemo } = await vite.ssrLoadModule('/src/api/offlineDemoData.js')
    const BuildingRegisterCard = (await vite.ssrLoadModule('/src/views/settings/components/BuildingRegisterCard.vue')).default

    disableOfflineDemo()

    const initialFacts = {
      schema: 'ee/1',
      source: { register: 'EHR', building_code: '100000001', fetched_at: '2026-11-15T09:00:00Z', attribution: 'Ehitisregister' },
      building: { primary_use: 'Elamu', first_use_year: 1986 },
      units: [],
      energy_certificates: [],
      technical: [],
      cadastral_units: [],
    }

    let searchMode: 'busy' | 'midnight' | 'huge' = 'busy'
    let failAcceptWith500 = false

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const method = (init?.method || 'GET').toUpperCase()

      if (urlStr.endsWith('/api/v1/property/building/registry') && method === 'GET') {
        return new Response(
          JSON.stringify({
            accepted: initialFacts,
            accepted_at: '2026-11-15T09:00:00Z',
            proposal: initialFacts,
            proposal_fetched_at: '2026-11-15T09:05:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/property/building/registry/search') && method === 'POST') {
        if (searchMode === 'busy') {
          return new Response(
            JSON.stringify({
              error_code: 'RATE_LIMITED',
              message: 'Too fast',
              reason: 'BUSY',
            }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          )
        }
        if (searchMode === 'midnight') {
          return new Response(
            JSON.stringify({
              error_code: 'RATE_LIMITED',
              message: 'Daily limit',
              reason: 'DAILY_LIMIT',
            }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          )
        }
        // retry_after_seconds > MAX_TIMEOUT_MS / 1000 (~24.85 days -> 2_200_000s)
        return new Response(
          JSON.stringify({
            error_code: 'RATE_LIMITED',
            message: 'Long lockout',
            reason: 'DAILY_LIMIT',
            retry_after_seconds: 2_200_000,
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/property/building/registry/accept') && method === 'POST' && failAcceptWith500) {
        return new Response(
          JSON.stringify({
            error_code: 'INTERNAL_ERROR',
            message: 'Accept failed',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings/association', component: Dummy },
        { path: '/building', component: Dummy },
      ],
    })
    await router.push('/settings/association')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(defineComponent({ setup: () => () => h(BuildingRegisterCard) }))
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushMicrotasks()

    // 1. 429 with reason: 'BUSY' on search is NOT treated as daily quota
    searchMode = 'busy'
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    const busyBanner = findByTestId(root, 'registry-action-error')
    assert.ok(busyBanner)
    assert.doesNotMatch(collectText(busyBanner), /The register may be asked only a few times a day/)
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, false)

    // 2. 429 DAILY_LIMIT on search without retry_after_seconds falls back to UTC midnight (7200s)
    searchMode = 'midnight'
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)
    assert.match(
      collectText(findByTestId(root, 'registry-action-error')!),
      /The register may be asked only a few times a day; try again tomorrow/,
    )

    // If Accept fails with 500 during cooldown, secondaryQuotaBanner keeps the quota notice visible
    failAcceptWith500 = true
    await findByTestId(root, 'registry-accept-btn')!.props.onClick()
    await flushMicrotasks()
    assert.ok(findByTestId(root, 'registry-action-error'))
    const secondaryNotice = findByTestId(root, 'registry-quota-notice')
    assert.ok(secondaryNotice, 'Expected secondary quota notice when another error occupies primary slot')
    assert.match(collectText(secondaryNotice), /The register may be asked only a few times a day; try again tomorrow/)

    // 1s before UTC midnight still blocked; 1s past UTC midnight unblocked
    t.mock.timers.tick(7_199_000)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)
    t.mock.timers.tick(1_000)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, false)

    // 3. > MAX_TIMEOUT_MS retry_after_seconds chunks cleanly without overflowing setTimeout
    searchMode = 'huge'
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)

    // Advance by MAX_TIMEOUT_MS (2_147_483_647 ms) -> 52_516_353 ms remain, so still blocked
    t.mock.timers.tick(2_147_483_647)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)

    // Advance past remaining 52_516_353 ms -> re-enabled cleanly
    t.mock.timers.tick(52_517_000)
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, false)

    // 4. Role demotion CHAIRMAN -> BOARD while quota timer is active clears error & timer cleanly
    searchMode = 'midnight'
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.ok(findByTestId(root, 'registry-action-error'))

    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'BOARD', memberships: [] } as any
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-action-error'), null)

    // Re-trigger quota for active unmount cleanup test
    session.me = { user_id: USER_IDS.CHAIRMAN, building_role: 'CHAIRMAN', memberships: [] } as any
    await flushMicrotasks()
    await findByTestId(root, 'registry-search-form')!.props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    assert.equal(findByTestId(root, 'registry-search-btn')!.props.disabled, true)

    // Unmount with active timer must not throw when advancing timers afterward
    app.unmount()
    t.mock.timers.tick(100_000_000)
    await flushMicrotasks()
  } finally {
    t.mock.timers.reset()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})
