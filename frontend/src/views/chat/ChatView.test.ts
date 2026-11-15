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
        options: [],
        value: '',
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 200,
        getRootNode() {
          return bodyNode
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

  async function flushUpdates(ticks = 15) {
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
    dispatchEvent(evt: any) {
      for (const fn of [...(docListeners.get(evt.type) || [])]) {
        fn(evt)
      }
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
    dispatchEvent(evt: any) {
      for (const fn of [...(winListeners.get(evt.type) || [])]) {
        fn(evt)
      }
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    location: { search: '' },
  }
  return { documentObj, windowObj }
}

test('AppNavbar, AppSidebar, AppBottomNav, and DashboardCommunityPulse share ONE GET /api/v1/chat request (#033)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  const { documentObj, windowObj } = createDocAndWindowSpy()
  ;(globalThis as any).window = windowObj
  ;(globalThis as any).document = documentObj

  let stopChatStatePollingFn: (() => void) | null = null
  let resetChatStateForTestFn: (() => void) | null = null
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const {
      startChatStatePolling,
      stopChatStatePolling,
      refreshChatState,
      resetChatStateForTest,
    } = await vite.ssrLoadModule('/src/composables/useChatState.js')
    stopChatStatePollingFn = stopChatStatePolling
    resetChatStateForTestFn = resetChatStateForTest
    resetChatStateForTest()

    const { default: AppNavbar } = await vite.ssrLoadModule('/src/layouts/components/AppNavbar.vue')
    const { default: AppSidebar } = await vite.ssrLoadModule('/src/layouts/components/AppSidebar.vue')
    const { default: AppBottomNav } = await vite.ssrLoadModule('/src/layouts/components/AppBottomNav.vue')
    const { default: DashboardCommunityPulse } = await vite.ssrLoadModule(
      '/src/views/dashboard/components/DashboardCommunityPulse.vue',
    )

    let serverChatState = {
      enabled: false,
      turned_on_at: null as string | null,
      can_take_part: true,
      recent_count: 0,
      recent_minutes: 10,
      last_message_at: null as string | null,
      history_hours: 2,
      max_length: 500,
    }
    let chatStateGetCalls = 0

    globalThis.fetch = async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/api/v1/chat')) {
        chatStateGetCalls += 1
        return new Response(JSON.stringify(serverChatState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const pinia = createPinia()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/login', name: 'login', component: Dummy },
        { path: '/forum', name: 'forum', component: Dummy },
        { path: '/chat', name: 'chat', component: Dummy },
        { path: '/messages', name: 'messages', component: Dummy },
        { path: '/polls', name: 'polls', component: Dummy },
      ],
    })
    await router.push('/')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.USER)
    session.me = {
      user_id: USER_IDS.USER,
      building_role: 'USER',
      memberships: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000314',
          apartment_number: '14',
          preview_badge: { display_label: 'Ivan Petrov (Apt. 14)', role_badge: 'OWNER' },
        },
      ],
      locale: 'en',
    } as any

    const CombinedShell = defineComponent({
      setup() {
        return () =>
          h('div', [
            h(AppNavbar),
            h(AppSidebar),
            h(AppBottomNav),
            h(DashboardCommunityPulse, { topics: [] }),
          ])
      },
    })

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(CombinedShell)
    app.use(pinia)
    app.use(router)
    app.mount(root)

    startChatStatePolling(session, router.currentRoute.value)
    await flushUpdates()

    // 1. Disabled: all 4 consumers mounted, ONLY ONE GET /api/v1/chat fired, all indicators hidden
    assert.equal(chatStateGetCalls, 1)
    assert.equal(findByTestId(root, 'navbar-chat-link'), null)
    assert.equal(findByTestId(root, 'community-pulse-chat-line'), null)
    const commTriggerInitially = findByTestId(root, 'nav-group-community')
    assert.ok(commTriggerInitially)
    await commTriggerInitially!.props.onClick({ stopPropagation() {} })
    await flushUpdates()
    assert.equal(findByTestId(root, 'nav-link-chat'), null)
    // close menu
    await commTriggerInitially!.props.onClick({ stopPropagation() {} })
    await flushUpdates()

    // 2. Enabled with recent_count=5 -> ONE shared refresh updates navbar, sidebar, mobile sheet, and dashboard
    serverChatState = {
      enabled: true,
      turned_on_at: '2026-11-15T10:00:00Z',
      can_take_part: true,
      recent_count: 5,
      recent_minutes: 10,
      last_message_at: '2026-11-15T10:05:00Z',
      history_hours: 2,
      max_length: 500,
    }
    await refreshChatState()
    await flushUpdates()
    assert.equal(chatStateGetCalls, 2)

    const navChatLink = findByTestId(root, 'navbar-chat-link')
    assert.ok(navChatLink, 'Navbar chat icon must appear when enabled & can_take_part')
    assert.equal(navChatLink!.props.title, 'Chat active: 5 messages in 10 min')
    assert.equal(navChatLink!.props['aria-label'], 'Chat active: 5 messages in 10 min')
    const dotBadge = findByTestId(root, 'navbar-chat-activity-dot')
    assert.ok(dotBadge)
    assert.match(collectText(dotBadge!), /5/)

    // Sidebar Community menu includes nav-link-chat
    const commGroupBtn = findByTestId(root, 'nav-group-community')!
    await commGroupBtn.props.onClick({ stopPropagation() {} })
    await flushUpdates()
    const sidebarChatLink = findByTestId(root, 'nav-link-chat')
    assert.ok(sidebarChatLink, 'Sidebar community menu must include Building chat')
    assert.match(collectText(sidebarChatLink!), /Building chat/)

    // Mobile bottom nav Community sheet includes mobile-nav-link-chat
    const mobileCommBtn = findByTestId(root, 'mobile-nav-group-community')!
    await mobileCommBtn.props.onClick()
    await flushUpdates()
    assert.ok(findByTestId(root, 'mobile-nav-link-chat'))

    // Dashboard community pulse shows active chat line without another API request
    const pulseChatLine = findByTestId(root, 'community-pulse-chat-line')
    assert.ok(pulseChatLine)
    assert.match(collectText(pulseChatLine!), /Chat active: 5 messages in 10 min/)
    assert.equal(chatStateGetCalls, 2)

    // 3. Accountant (can_take_part = false) hides chat UI across navbar, sidebar & dashboard
    serverChatState = {
      ...serverChatState,
      can_take_part: false,
      recent_count: 0,
      last_message_at: null,
    }
    await refreshChatState()
    await flushUpdates()
    assert.equal(findByTestId(root, 'navbar-chat-link'), null)
    assert.equal(findByTestId(root, 'nav-link-chat'), null)
    assert.equal(findByTestId(root, 'community-pulse-chat-line'), null)
  } finally {
    stopChatStatePollingFn?.()
    resetChatStateForTestFn?.()
    app?.unmount?.()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    await vite.close()
  }
})

test('ChatView renders disclaimer, oldest-first messages, multi-apt select, char limit, 429 cooldown, 409 disable, and 403 fail-closed (#033)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { documentObj, windowObj } = createDocAndWindowSpy()
  ;(globalThis as any).window = windowObj
  ;(globalThis as any).document = documentObj
  ;(globalThis as any).Document = originalDocumentCtor || class FakeDocument {}
  ;(globalThis as any).ShadowRoot = originalShadowRootCtor || class FakeShadowRoot {}

  let stopChatStatePollingFn: (() => void) | null = null
  let resetChatStateForTestFn: (() => void) | null = null
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { canShowChat, resetChatStateForTest, stopChatStatePolling } =
      await vite.ssrLoadModule('/src/composables/useChatState.js')
    stopChatStatePollingFn = stopChatStatePolling
    resetChatStateForTestFn = resetChatStateForTest
    resetChatStateForTest()

    const { default: ChatView } = await vite.ssrLoadModule('/src/views/chat/ChatView.vue')

    const nowMs = Date.now()
    const created1 = new Date(nowMs - 60_000).toISOString()
    const created2 = new Date(nowMs - 30_000).toISOString()
    const expiresFuture = new Date(nowMs + 7_100_000).toISOString()

    let getMessagesCalls = 0
    let nextPostId = 12
    const postCalls: Array<Record<string, any>> = []
    let nextGetOutcome: 'ok' | '409' | '403' = 'ok'
    let nextPostOutcome: 'ok' | '429' | '409' = 'ok'

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.includes('/api/v1/chat/messages') && method === 'GET') {
        getMessagesCalls += 1
        if (nextGetOutcome === '409') {
          return new Response(
            JSON.stringify({
              error_code: 'CHAT_DISABLED',
              message: 'Building chat is currently turned off.',
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        }
        if (nextGetOutcome === '403') {
          return new Response(
            JSON.stringify({
              error_code: 'FORBIDDEN',
              message: 'Access denied.',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 10,
                body: 'Water pressure dropped on 3rd floor',
                author_badge: { display_label: 'Apt. 05', role_badge: 'RESIDENT' },
                created_at: created1,
                expires_at: expiresFuture,
                is_own: false,
              },
              {
                id: 11,
                body: 'Checking the valve now',
                author_badge: { display_label: 'Ivan Petrov (Apt. 14)', role_badge: 'OWNER' },
                created_at: created2,
                expires_at: expiresFuture,
                is_own: true,
              },
            ],
            cursor: 11,
            has_more: false,
            turned_on_at: new Date(nowMs - 300_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/chat/messages') && method === 'POST') {
        const parsed = JSON.parse(String(init?.body || '{}'))
        postCalls.push(parsed)
        if (nextPostOutcome === '429') {
          return new Response(
            JSON.stringify({
              error_code: 'RATE_LIMITED',
              message: 'Too many messages sent.',
              retry_after_seconds: 12,
              reason: 'PER_MINUTE',
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'Retry-After': '12' },
            },
          )
        }
        if (nextPostOutcome === '409') {
          return new Response(
            JSON.stringify({
              error_code: 'CHAT_DISABLED',
              message: 'Building chat is currently turned off.',
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            id: nextPostId++,
            body: parsed.body,
            author_badge: { display_label: 'Apt. 15', role_badge: 'OWNER' },
            created_at: new Date(nowMs).toISOString(),
            expires_at: expiresFuture,
            is_own: true,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
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
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/chat', name: 'chat', component: Dummy },
        { path: '/settings/association', name: 'association-settings', component: Dummy },
      ],
    })
    await router.push('/chat')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.USER)
    session.me = {
      user_id: USER_IDS.USER,
      building_role: 'USER',
      active_apartment_id: '018f0000-0000-7000-8000-000000000314',
      memberships: [
        { apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' },
        { apartment_id: '018f0000-0000-7000-8000-000000000315', apartment_number: '15' },
      ],
      locale: 'en',
    } as any

    const RootWrapper = defineComponent({
      setup() {
        return () => h(ChatView)
      },
    })

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Ephemeral disclaimer & oldest-first messages rendered
    const disclaimer = findByTestId(root, 'chat-ephemeral-disclaimer')
    assert.ok(disclaimer)
    assert.match(
      collectText(disclaimer!),
      /Messages disappear after 2 hours\. Others can still take screenshots\./,
    )

    const rows = findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === 'chat-message-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].props['data-message-id'], 10)
    assert.equal(rows[0].props['data-own'], 'false')
    assert.equal(rows[1].props['data-message-id'], 11)
    assert.equal(rows[1].props['data-own'], 'true')
    assert.match(collectText(rows[0]), /Apt\. 05/)
    assert.match(collectText(rows[0]), /Water pressure dropped on 3rd floor/)
    assert.match(collectText(rows[1]), /Ivan Petrov \(Apt\. 14\)/)

    // 2. Multi-apartment select defaults to active membership (14), can switch to 15 and send message without follow-up GET
    const aptSelect = findByTestId(root, 'chat-apartment-select')!
    assert.ok(aptSelect)
    const bodyInput = findByTestId(root, 'chat-body-input')!
    await bodyInput.props['onUpdate:modelValue']('Message from default active apt')
    await bodyInput.props.onInput()
    await flushUpdates()

    const formNode = findByTestId(root, 'chat-composer-form')!
    const getCountBeforePost = getMessagesCalls
    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()

    assert.equal(postCalls.length, 1)
    assert.deepEqual(postCalls[0], {
      body: 'Message from default active apt',
      author_apartment_id: '018f0000-0000-7000-8000-000000000314',
    })

    await aptSelect.props['onUpdate:modelValue']('018f0000-0000-7000-8000-000000000315')
    await findByTestId(root, 'chat-body-input')!.props['onUpdate:modelValue']('All clear in apt 15 now')
    await findByTestId(root, 'chat-body-input')!.props.onInput()
    await flushUpdates()

    await findByTestId(root, 'chat-composer-form')!.props.onSubmit({ preventDefault() {} })
    await flushUpdates()

    assert.equal(postCalls.length, 2)
    assert.deepEqual(postCalls[1], {
      body: 'All clear in apt 15 now',
      author_apartment_id: '018f0000-0000-7000-8000-000000000315',
    })
    assert.equal(getMessagesCalls, getCountBeforePost, 'POST must not trigger extra GET /messages')
    assert.equal((findByTestId(root, 'chat-body-input') as any).value, '')
    assert.match(collectText(findByTestId(root, 'chat-char-counter')!), /0 \/ 500/)
    assert.equal(
      findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === 'chat-message-row').length,
      4,
    )

    // 3. Char counter highlights with text-error at >= 500 chars
    const maxCharsText = 'a'.repeat(500)
    await findByTestId(root, 'chat-body-input')!.props['onUpdate:modelValue'](maxCharsText)
    await flushUpdates()
    const counter = findByTestId(root, 'chat-char-counter')!
    assert.match(collectText(counter), /500 \/ 500/)
    assert.match(String(counter.props.class || ''), /text-error/)

    // 4. 429 RATE_LIMITED displays countdown banner and disables Send button
    nextPostOutcome = '429'
    await findByTestId(root, 'chat-body-input')!.props['onUpdate:modelValue']('One more')
    await flushUpdates()
    await findByTestId(root, 'chat-composer-form')!.props.onSubmit({ preventDefault() {} })
    await flushUpdates()

    const rateBanner = findByTestId(root, 'chat-rate-limit-banner')
    assert.ok(rateBanner, 'Expected 429 cooldown banner')
    assert.match(collectText(rateBanner!), /12/)
    const sendBtn = findByTestId(root, 'chat-send-btn')!
    assert.equal(sendBtn.props.disabled, true)
    assert.match(collectText(sendBtn), /Wait 12s/)

    // 5. 409 CHAT_DISABLED clears messages, closes room, hides shared indicators, and shows Settings button only to chairman
    app.unmount()
    app = null

    nextGetOutcome = '409'
    session.me = {
      ...session.me,
      building_role: 'CHAIRMAN',
    } as any
    setDemoUser(USER_IDS.CHAIRMAN)

    const rootDisabled: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(rootDisabled)
    await flushUpdates()

    assert.equal(findByTestId(rootDisabled, 'chat-room'), null)
    const disabledState = findByTestId(rootDisabled, 'chat-disabled-state')
    assert.ok(disabledState)
    assert.match(collectText(disabledState!), /Building chat is turned off/)
    assert.ok(findByTestId(rootDisabled, 'chat-open-settings-link'))
    assert.equal(canShowChat.value, false)

    // 6. 403 FORBIDDEN fail-closed screen for direct /chat access (e.g. Accountant)
    app.unmount()
    app = null
    nextGetOutcome = '403'
    session.me = {
      user_id: USER_IDS.ACCOUNTANT,
      building_role: 'ACCOUNTANT',
      memberships: [],
      locale: 'en',
    } as any
    setDemoUser(USER_IDS.ACCOUNTANT)

    const rootForbidden: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(rootForbidden)
    await flushUpdates()

    assert.equal(findByTestId(rootForbidden, 'chat-room'), null)
    const forbiddenState = findByTestId(rootForbidden, 'chat-forbidden-state')
    assert.ok(forbiddenState)
    assert.match(collectText(forbiddenState!), /Chat is only for residents and the board/)
  } finally {
    stopChatStatePollingFn?.()
    resetChatStateForTestFn?.()
    app?.unmount?.()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})

test('ChatView handles direct /chat entry state sync, load retry, POST 500 traceId & 422 errors, Enter/IME keys, empty state, and expiry prune (#033)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findAll, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document
  const originalDocumentCtor = (globalThis as any).Document
  const originalShadowRootCtor = (globalThis as any).ShadowRoot
  const { documentObj, windowObj } = createDocAndWindowSpy()
  ;(globalThis as any).window = windowObj
  ;(globalThis as any).document = documentObj
  ;(globalThis as any).Document = originalDocumentCtor || class FakeDocument {}
  ;(globalThis as any).ShadowRoot = originalShadowRootCtor || class FakeShadowRoot {}

  let stopChatStatePollingFn: (() => void) | null = null
  let resetChatStateForTestFn: (() => void) | null = null
  let app: any = null

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { resetChatStateForTest, stopChatStatePolling } = await vite.ssrLoadModule(
      '/src/composables/useChatState.js',
    )
    stopChatStatePollingFn = stopChatStatePolling
    resetChatStateForTestFn = resetChatStateForTest
    resetChatStateForTest()

    const { default: AppNavbar } = await vite.ssrLoadModule('/src/layouts/components/AppNavbar.vue')
    const { default: AppSidebar } = await vite.ssrLoadModule('/src/layouts/components/AppSidebar.vue')
    const { default: ChatView } = await vite.ssrLoadModule('/src/views/chat/ChatView.vue')

    let nextGetStatus: '500' | 'soon-expiring' | 'empty' = '500'
    let nextPostStatus: '500' | '422' | '201' = '500'
    let postRequests = 0

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.includes('/api/v1/chat/messages') && method === 'GET') {
        if (nextGetStatus === '500') {
          return new Response(
            JSON.stringify({
              error_code: 'INTERNAL_ERROR',
              message: 'Backend unavailable',
              trace_id: 'trace-chat-load-500',
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }
        if (nextGetStatus === 'soon-expiring') {
          const nowMs = Date.now()
          return new Response(
            JSON.stringify({
              messages: [
                {
                  id: 77,
                  body: 'Ephemeral ping',
                  author_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
                  created_at: new Date(nowMs - 5_000).toISOString(),
                  expires_at: new Date(nowMs + 80).toISOString(),
                  is_own: true,
                },
              ],
              cursor: 77,
              has_more: false,
              turned_on_at: new Date(nowMs - 60_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            messages: [],
            cursor: null,
            has_more: false,
            turned_on_at: new Date(Date.now() - 60_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.endsWith('/api/v1/chat/messages') && method === 'POST') {
        postRequests += 1
        const parsed = JSON.parse(String(init?.body || '{}'))
        if (nextPostStatus === '500') {
          return new Response(
            JSON.stringify({
              error_code: 'INTERNAL_ERROR',
              message: 'Write failed',
              trace_id: 'trace-post-500',
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }
        if (nextPostStatus === '422') {
          return new Response(
            JSON.stringify({
              error_code: 'VALIDATION_ERROR',
              message: 'Invalid message body',
              errors: [{ loc: ['body', 'body'], message: 'Message cannot contain null bytes', type: 'value_error' }],
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          )
        }
        const nowMs = Date.now()
        return new Response(
          JSON.stringify({
            id: 78,
            body: parsed.body,
            author_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
            created_at: new Date(nowMs).toISOString(),
            expires_at: new Date(nowMs + 3_600_000).toISOString(),
            is_own: true,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
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
        { path: '/', name: 'dashboard', component: Dummy },
        { path: '/login', name: 'login', component: Dummy },
        { path: '/chat', name: 'chat', component: Dummy },
        { path: '/forum', name: 'forum', component: Dummy },
        { path: '/messages', name: 'messages', component: Dummy },
        { path: '/polls', name: 'polls', component: Dummy },
      ],
    })
    await router.push('/chat')
    await router.isReady()

    const session = useSessionStore(pinia)
    session.setLang('en')
    session.mode = 'demo'
    setDemoUser(USER_IDS.USER)
    session.me = {
      user_id: USER_IDS.USER,
      building_role: 'USER',
      active_apartment_id: '018f0000-0000-7000-8000-000000000314',
      memberships: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000314',
          apartment_number: '14',
          preview_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
        },
      ],
      locale: 'en',
    } as any

    const DirectEntryShell = defineComponent({
      setup() {
        return () => h('div', [h(AppNavbar), h(AppSidebar), h(ChatView)])
      },
    })

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    app = createApp(DirectEntryShell)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Initial load 500 shows ErrorCard with Retry button; clicking Retry after recovery loads room
    //    AND P1-2: direct /chat entry initializes shared state so AppNavbar + AppSidebar show chat links!
    const retryBtn = findAll(
      root,
      (n) => n.kind === 'element' && n.tag === 'button' && /Try again/.test(collectText(n)),
    )[0]
    assert.ok(retryBtn, 'Expected ErrorCard Try again button on initial 500')
    assert.match(collectText(root), /trace-chat-load-500/)

    nextGetStatus = 'soon-expiring'
    await retryBtn.props.onClick()
    await flushUpdates()

    assert.ok(findByTestId(root, 'chat-room'))
    assert.ok(
      findByTestId(root, 'navbar-chat-link'),
      'Direct /chat navigation must populate navbar chat icon without prior /api/v1/chat poll',
    )
    const commBtn = findByTestId(root, 'nav-group-community')!
    await commBtn.props.onClick({ stopPropagation() {} })
    await flushUpdates()
    assert.ok(
      findByTestId(root, 'nav-link-chat'),
      'Direct /chat navigation must populate sidebar chat link without prior /api/v1/chat poll',
    )

    // 2. Client-side expiry timer removes expired message and shows chat-empty-state
    assert.equal(
      findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === 'chat-message-row').length,
      1,
    )
    await new Promise((r) => setTimeout(r, 150))
    await flushUpdates()
    assert.equal(
      findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === 'chat-message-row').length,
      0,
    )
    assert.ok(findByTestId(root, 'chat-empty-state'))

    // 3. POST 500 displays trace_id in chat-send-error; POST 422 displays backend errors[] message
    const inputNode = findByTestId(root, 'chat-body-input')!
    await inputNode.props['onUpdate:modelValue']('Attempt 1')
    await inputNode.props.onInput()
    await flushUpdates()

    await findByTestId(root, 'chat-composer-form')!.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    const sendErr500 = findByTestId(root, 'chat-send-error')!
    assert.ok(sendErr500)
    assert.match(collectText(sendErr500), /trace-post-500/)

    nextPostStatus = '422'
    await findByTestId(root, 'chat-composer-form')!.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    const sendErr422 = findByTestId(root, 'chat-send-error')!
    assert.match(collectText(sendErr422), /Message cannot contain null bytes/)

    // 4. Enter key handling: IME composition & Shift+Enter do NOT submit; plain Enter calls preventDefault & submits
    const countBeforeKeys = postRequests
    nextPostStatus = '201'
    const inputForKeys = findByTestId(root, 'chat-body-input')!
    await inputForKeys.props['onUpdate:modelValue']('Ready via Enter')
    await inputForKeys.props.onInput()
    await flushUpdates()

    let imePrevented = false
    await inputForKeys.props.onKeydown({
      key: 'Enter',
      isComposing: true,
      preventDefault() {
        imePrevented = true
      },
    })
    assert.equal(imePrevented, false)
    assert.equal(postRequests, countBeforeKeys)

    let shiftPrevented = false
    await inputForKeys.props.onKeydown({
      key: 'Enter',
      shiftKey: true,
      preventDefault() {
        shiftPrevented = true
      },
    })
    assert.equal(shiftPrevented, false)
    assert.equal(postRequests, countBeforeKeys)

    let enterPrevented = false
    await inputForKeys.props.onKeydown({
      key: 'Enter',
      preventDefault() {
        enterPrevented = true
      },
    })
    await flushUpdates()
    assert.equal(enterPrevented, true)
    assert.equal(postRequests, countBeforeKeys + 1)
  } finally {
    stopChatStatePollingFn?.()
    resetChatStateForTestFn?.()
    app?.unmount?.()
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
    ;(globalThis as any).Document = originalDocumentCtor
    ;(globalThis as any).ShadowRoot = originalShadowRootCtor
    await vite.close()
  }
})

