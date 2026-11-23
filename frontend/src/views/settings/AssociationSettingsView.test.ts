import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h } from 'vue'
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

test('AssociationSettingsView handles chat.enabled lifecycle, reset null, Escape modal, 500 error, RBAC, and async races (#032)', async () => {
  const vite = await createClientVueViteServer()
  const { createApp, collectText, findByTestId, flushUpdates } = createFakeDomHarness()
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as any).window
  const { listeners, windowObj } = createWindowSpy()
  ;(globalThis as any).window = windowObj

  try {
    const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
    const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
    const { cloneDefaultAssociationSettings, validateAndApplySettingsUpdate } =
      await vite.ssrLoadModule('/src/utils/associationSettings.js')
    const { default: AssociationSettingsView } = await vite.ssrLoadModule(
      '/src/views/settings/AssociationSettingsView.vue',
    )

    let serverSettings = cloneDefaultAssociationSettings()
    const getCalls: string[] = []
    const putCalls: Array<Record<string, any>> = []
    let nextPutStatus = 200
    let deferredPutResolve: ((res: Response) => void) | null = null

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.endsWith('/api/v1/settings') && method === 'GET') {
        const actorHeader =
          (init?.headers as any)?.get?.('X-Demo-User-Id') ||
          (init?.headers as Record<string, string>)?.['X-Demo-User-Id'] ||
          ''
        getCalls.push(actorHeader)
        return new Response(JSON.stringify({ settings: serverSettings }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.endsWith('/api/v1/settings') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}'))
        putCalls.push(body)
        if (deferredPutResolve) {
          return await new Promise<Response>((resolve) => {
            deferredPutResolve = resolve
          })
        }
        if (nextPutStatus !== 200) {
          const code = nextPutStatus
          nextPutStatus = 200
          return new Response(JSON.stringify({ error_code: 'INTERNAL_SERVER_ERROR' }), {
            status: code,
            headers: { 'content-type': 'application/json' },
          })
        }
        const outcome = validateAndApplySettingsUpdate(serverSettings, body, '2026-11-15T10:00:00Z')
        if (!outcome.ok) {
          return new Response(
            JSON.stringify({ error_code: 'VALIDATION_ERROR', errors: outcome.errors }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          )
        }
        serverSettings = outcome.settings
        return new Response(JSON.stringify({ settings: serverSettings }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.endsWith('/api/v1/files/usage') && method === 'GET') {
        return new Response(
          JSON.stringify({
            quota_bytes: 1000000,
            used_bytes: 0,
            used_percent: 0,
            pending_deletion_bytes: 0,
            categories: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
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
      routes: [{ path: '/settings', name: 'association-settings', component: Dummy }],
    })
    await router.push('/settings')
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

    const RootWrapper = defineComponent({
      setup() {
        return () => h(AssociationSettingsView)
      },
    })

    const root: VTestNode = { kind: 'element', tag: 'div', props: {}, children: [], parentNode: null }
    const app = createApp(RootWrapper)
    app.use(pinia)
    app.use(router)
    app.mount(root)
    await flushUpdates()

    // 1. Chat group and switch appear with help text and default Disabled
    const chatGroup = findByTestId(root, 'settings-group-chat')
    assert.ok(chatGroup, 'Expected settings-group-chat section')
    const chatRow = findByTestId(root, 'setting-row-chat.enabled')
    assert.ok(chatRow, 'Expected setting-row-chat.enabled row')
    const rowText = collectText(chatRow!)
    assert.match(rowText, /Building chat/)
    assert.match(
      rowText,
      /A chat of the residents; messages disappear after 2 hours; nobody moderates it\. Turning it off deletes all messages\./,
    )

    const chatSwitch = findByTestId(root, 'setting-control-chat.enabled')!
    assert.ok(chatSwitch)
    assert.equal(chatSwitch.props['aria-checked'], false)
    assert.equal(chatSwitch.props.disabled, false)

    // 2. Enabling chat.enabled saves directly without confirmation modal
    await chatSwitch.props.onClick()
    await flushUpdates()
    assert.equal(findByTestId(root, 'chat-disable-pending-warning'), null)

    const formNode = findByTestId(root, 'settings-group-chat')!.parentNode!
    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()

    assert.equal(putCalls.length, 1)
    assert.deepEqual(putCalls[0], { values: { 'chat.enabled': true } })
    assert.equal(findByTestId(root, 'chat-disable-confirm-modal'), null)
    assert.equal(findByTestId(root, 'setting-control-chat.enabled')!.props['aria-checked'], true)

    // 3. Disabling via Reset-to-default also triggers warning + confirmation modal and sends null
    const resetBtn = findByTestId(root, 'setting-reset-btn-chat.enabled')
    assert.ok(resetBtn, 'Expected Reset to default button when chat.enabled is true')
    await resetBtn!.props.onClick()
    await flushUpdates()
    assert.ok(findByTestId(root, 'chat-disable-pending-warning'))

    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.equal(putCalls.length, 1, 'PUT must wait for modal confirmation on reset to default')
    assert.ok(findByTestId(root, 'chat-disable-confirm-modal'))

    // Escape key closes confirmation modal via registered keydown listener
    assert.ok((listeners.get('keydown')?.size || 0) > 0, 'Expected Escape listener while modal open')
    windowObj.dispatchEvent({ type: 'keydown', key: 'Escape' })
    await flushUpdates()
    assert.equal(findByTestId(root, 'chat-disable-confirm-modal'), null)
    assert.equal(putCalls.length, 1)

    // Re-open and confirm reset -> PUT with { 'chat.enabled': null }
    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    await findByTestId(root, 'chat-disable-confirm-btn')!.props.onClick()
    await flushUpdates()
    assert.equal(putCalls.length, 2)
    assert.deepEqual(putCalls[1], { values: { 'chat.enabled': null } })
    assert.equal(serverSettings.find((s: any) => s.key === 'chat.enabled').value, false)

    // 4. Enable again, toggle off, confirm when server returns 500 -> closes modal and surfaces error banner
    await findByTestId(root, 'setting-control-chat.enabled')!.props.onClick()
    await flushUpdates()
    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.equal(serverSettings.find((s: any) => s.key === 'chat.enabled').value, true)

    await findByTestId(root, 'setting-control-chat.enabled')!.props.onClick()
    await flushUpdates()
    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    nextPutStatus = 500
    await findByTestId(root, 'chat-disable-confirm-btn')!.props.onClick()
    await flushUpdates()

    assert.equal(findByTestId(root, 'chat-disable-confirm-modal'), null, 'Modal must close on save error')
    assert.ok(findByTestId(root, 'association-settings-error-banner'), 'Error banner must appear after 500')
    assert.equal(serverSettings.find((s: any) => s.key === 'chat.enabled').value, true)

    // 5. Async race: confirm slow PUT as CHAIRMAN, switch to USER before it resolves, then back to CHAIRMAN
    let finishSlowPut: ((res: Response) => void) | null = null
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      const method = (init?.method || 'GET').toUpperCase()
      if (urlStr.endsWith('/api/v1/settings') && method === 'PUT') {
        return await new Promise<Response>((resolve) => {
          finishSlowPut = resolve
        })
      }
      return origFetch(url, init)
    }

    await formNode.props.onSubmit({ preventDefault() {} })
    await flushUpdates()
    assert.ok(findByTestId(root, 'chat-disable-confirm-modal'))
    const confirmPromise = findByTestId(root, 'chat-disable-confirm-btn')!.props.onClick()
    await flushUpdates(3)

    const getsBeforeUserSwitch = getCalls.length
    setDemoUser(USER_IDS.USER)
    session.me = {
      user_id: USER_IDS.USER,
      building_role: 'USER',
      memberships: [{ apartment_id: 'apt-14', apartment_number: '14' }],
      locale: 'en',
    } as any
    await flushUpdates()

    // USER fails closed with forbidden card and fires zero GET /api/v1/settings
    assert.ok(findByTestId(root, 'association-settings-forbidden'))
    assert.equal(findByTestId(root, 'chat-disable-confirm-modal'), null)
    assert.equal(getCalls.length, getsBeforeUserSwitch, 'USER role switch must not trigger GET /settings')

    // Now resolve the stale slow PUT
    globalThis.fetch = origFetch
    const resolveSlowPut = finishSlowPut as ((res: Response) => void) | null
    resolveSlowPut?.(
      new Response(JSON.stringify({ settings: cloneDefaultAssociationSettings() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await confirmPromise
    await flushUpdates()
    assert.equal(findByTestId(root, 'association-settings-success-banner'), null, 'Stale PUT must not show banner')

    // Switching back to CHAIRMAN restores full settings form unlocked (saving = false)
    setDemoUser(USER_IDS.CHAIRMAN)
    session.me = {
      user_id: USER_IDS.CHAIRMAN,
      building_role: 'CHAIRMAN',
      memberships: [],
      locale: 'en',
    } as any
    await flushUpdates()
    assert.equal(findByTestId(root, 'association-settings-forbidden'), null)
    assert.equal(findByTestId(root, 'setting-control-chat.enabled')!.props.disabled, false)

    // 6. BOARD member sees chat.enabled read-only (disabled) and no save button
    setDemoUser(USER_IDS.BOARD)
    session.me = {
      user_id: USER_IDS.BOARD,
      building_role: 'BOARD',
      memberships: [{ apartment_id: 'apt-15', apartment_number: '15' }],
      locale: 'en',
    } as any
    await flushUpdates()

    assert.ok(findByTestId(root, 'association-settings-readonly-banner'))
    assert.equal(findByTestId(root, 'setting-control-chat.enabled')!.props.disabled, true)
    assert.equal(findByTestId(root, 'association-settings-save-btn'), null)

    app.unmount()
    await flushUpdates()
    assert.equal(listeners.get('keydown')?.size || 0, 0, 'Unmounting must remove window keydown listener')
  } finally {
    globalThis.fetch = originalFetch
    ;(globalThis as any).window = originalWindow
    await vite.close()
  }
})
