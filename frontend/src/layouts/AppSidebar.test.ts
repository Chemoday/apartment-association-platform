import test from 'node:test'
import assert from 'node:assert/strict'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  createClientVueViteServer,
  createDocAndWindowSpy,
  createFakeDomHarness,
  type VTestNode,
} from '../test/mountWithApp.js'

const Dummy = { template: '<div />' }

test('AppLayout & AppSidebar render vertical Warm Nordic sidebar, collapse toggle, RBAC nav links, skip-link, and mobile AppBottomNav', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  const { documentObj, windowObj } = createDocAndWindowSpy()
  ;(globalThis as any).window = windowObj
  ;(globalThis as any).document = documentObj

  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/notifications/unread-count')) {
      return new Response(JSON.stringify({ unread_count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/chat')) {
      return new Response(
        JSON.stringify({
          enabled: false,
          turned_on_at: null,
          can_take_part: false,
          recent_count: 0,
          recent_minutes: 10,
          last_message_at: null,
          history_hours: 2,
          max_length: 500,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.includes('/emergencies')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any

  let app: any = null
  let stopUnreadPollingFn: (() => void) | null = null
  let stopChatStatePollingFn: (() => void) | null = null
  let resetChatStateForTestFn: (() => void) | null = null

  try {
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { stopUnreadPolling } = await vite.ssrLoadModule('/src/composables/useUnreadCount.js')
    const { stopChatStatePolling, resetChatStateForTest } = await vite.ssrLoadModule(
      '/src/composables/useChatState.js',
    )
    const { default: AppLayout } = await vite.ssrLoadModule('/src/layouts/AppLayout.vue')
    stopUnreadPollingFn = stopUnreadPolling
    stopChatStatePollingFn = stopChatStatePolling
    resetChatStateForTestFn = resetChatStateForTest
    resetChatStateForTest()

    const pinia = createPinia()
    setActivePinia(pinia)
    const session = useSessionStore()
    session.me = {
      user_id: 'u-chairman',
      building_id: 'b-1',
      building_role: 'CHAIRMAN',
      privacy_display_mode: 'FULL_NAME',
      locale: 'en',
      shared_access: true,
      memberships: [
        {
          membership_id: 'm-1',
          apartment_id: 'apt-1',
          apartment_number: '1',
          apartment_kind: 'APARTMENT',
          role: 'OWNER',
          privacy_display_mode: 'FULL_NAME',
          preview_badge: { display_label: 'Katri Tamm', role_badge: 'Chairman' },
        },
      ],
    } as any
    session.building = {
      id: 'b-1',
      name: 'KÜ Sõpruse 12',
      address: 'Sõpruse pst 12',
      district: 'Kristiine',
      registry_code: '80012345',
    } as any

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy, meta: { roles: ['CHAIRMAN', 'BOARD', 'ACCOUNTANT', 'USER'] } },
        { path: '/building', name: 'building', component: Dummy },
        { path: '/readings', name: 'readings', component: Dummy },
        { path: '/issues', name: 'issues', component: Dummy },
        { path: '/documents', name: 'documents', component: Dummy },
        { path: '/forum', name: 'forum', component: Dummy },
        { path: '/messages', name: 'messages', component: Dummy },
        { path: '/polls', name: 'polls', component: Dummy },
        { path: '/accounting', name: 'accounting', component: Dummy },
        { path: '/apartments', name: 'apartments', component: Dummy },
        { path: '/board-room', name: 'boardRoom', component: Dummy },
        { path: '/people', name: 'people', component: Dummy },
        { path: '/people/connections', name: 'connections', component: Dummy },
        { path: '/join-decisions', name: 'joinDecisions', component: Dummy },
        { path: '/maintenance', name: 'maintenance', component: Dummy },
        { path: '/maintenance/log', name: 'maintenanceLog', component: Dummy },
        { path: '/settings/association', name: 'associationSettings', component: Dummy },
        { path: '/settings/profile', name: 'profile', component: Dummy },
        { path: '/theme-lab', name: 'themeLab', component: Dummy },
        { path: '/login', name: 'login', component: Dummy },
      ],
    })
    await router.push('/')
    await router.isReady()

    const Host = defineComponent({
      setup() {
        return () => h(AppLayout, null, { default: () => h('div', { 'data-testid': 'page-body' }, 'Hello') })
      },
    })

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(Host)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Skip-to-content link & main content preserved
    const skipLinks = findAll(root, (n) => n.kind === 'element' && n.tag === 'a' && n.props.href === '#main-content')
    assert.equal(skipLinks.length, 1, 'Expected skip-to-content link')
    const mains = findAll(root, (n) => n.kind === 'element' && n.tag === 'main' && n.props.id === 'main-content')
    assert.equal(mains.length, 1, 'Expected #main-content landmark')
    assert.ok(String(mains[0].props.class || '').includes('min-w-0'), 'Expected min-w-0 on main for wide tables')

    // 2. Vertical sidebar renders NAV_GROUPS and direct nav-link-* for Chairman
    const sidebar = findByTestId(root, 'app-sidebar')
    assert.ok(sidebar, 'Expected vertical app-sidebar')
    assert.ok(String(sidebar!.props.class || '').includes('w-[252px]'), 'Expected expanded sidebar width')
    assert.ok(findByTestId(root, 'nav-group-home'))
    assert.ok(findByTestId(root, 'nav-group-services'))
    assert.ok(findByTestId(root, 'nav-group-community'))
    assert.ok(findByTestId(root, 'nav-group-management'))

    const dashLink = findByTestId(root, 'nav-link-dashboard')
    assert.ok(dashLink, 'Expected nav-link-dashboard')
    assert.equal(dashLink!.props['aria-current'], 'page')
    assert.ok(findByTestId(root, 'nav-link-readings'))
    assert.ok(findByTestId(root, 'nav-link-accounting'))
    assert.ok(findByTestId(root, 'sidebar-user-footer'))
    assert.match(collectText(findByTestId(root, 'sidebar-user-footer')!), /Katri Tamm/)

    // 3. Mobile bottom nav preserved alongside desktop sidebar
    assert.ok(findByTestId(root, 'mobile-nav-group-home'))
    assert.ok(findByTestId(root, 'mobile-nav-group-services'))

    // 4. Collapse toggle shrinks sidebar to w-[72px] and updates aria-expanded + accessible labels
    const toggleBtn = findByTestId(root, 'sidebar-collapse-toggle')
    assert.ok(toggleBtn)
    assert.equal(toggleBtn!.props['aria-expanded'], true)
    await toggleBtn!.props.onClick()
    await flushUpdates()

    assert.ok(String(findByTestId(root, 'app-sidebar')!.props.class || '').includes('w-[72px]'))
    const expandBtn = findByTestId(root, 'sidebar-collapse-toggle')
    assert.equal(expandBtn!.props['aria-expanded'], false)
    assert.ok(findByTestId(root, 'nav-link-dashboard')!.props['aria-label'], 'Collapsed icon links must expose aria-label')
    assert.ok(findByTestId(root, 'sidebar-brand-link')!.props['aria-label'], 'Collapsed brand link must expose aria-label')
    assert.ok(findByTestId(root, 'sidebar-user-footer')!.props['aria-label'], 'Collapsed user footer must expose aria-label')

    // 5. Nested route /people/connections highlights ONLY connections, NOT /people (CTO P1-3)
    await router.push('/people/connections')
    await flushUpdates()
    assert.equal(findByTestId(root, 'nav-link-connections')!.props['aria-current'], 'page')
    assert.equal(findByTestId(root, 'nav-link-people')!.props['aria-current'], undefined)

    // 6. Sticky AppHeader has z-40 and print:hidden directly (CTO P1-1 & P1-2)
    const headers = findAll(root, (n) => n.kind === 'element' && n.tag === 'header')
    assert.equal(headers.length, 1)
    assert.ok(String(headers[0].props.class || '').includes('z-40'))
    assert.ok(String(headers[0].props.class || '').includes('sticky'))
    assert.ok(String(headers[0].props.class || '').includes('print:hidden'))
    assert.ok(String(findByTestId(root, 'app-sidebar')!.props.class || '').includes('print:hidden'))

    // 7. ACCOUNTANT without preview_badge shows localized role label instead of raw enum (CTO P2-4)
    await expandBtn!.props.onClick()
    await flushUpdates()
    session.me = {
      ...session.me,
      building_role: 'ACCOUNTANT',
      memberships: [],
    } as any
    await flushUpdates()
    assert.match(collectText(findByTestId(root, 'sidebar-user-footer')!), /Accountant/)

    // 8. Role switch to USER hides management group fail-closed
    session.me = {
      ...session.me,
      building_role: 'USER',
      memberships: [
        {
          membership_id: 'm-1',
          apartment_id: 'apt-1',
          apartment_number: '1',
          apartment_kind: 'APARTMENT',
          role: 'OWNER',
          privacy_display_mode: 'FULL_NAME',
          preview_badge: { display_label: 'Resident', role_badge: 'Resident' },
        },
      ],
    } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'nav-group-management'), null)
    assert.equal(findByTestId(root, 'nav-link-accounting'), null)
    assert.ok(findByTestId(root, 'nav-link-readings'))
  } finally {
    stopUnreadPollingFn?.()
    stopChatStatePollingFn?.()
    resetChatStateForTestFn?.()
    app?.unmount?.()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    await vite.close()
  }
})
