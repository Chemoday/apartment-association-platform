import assert from 'node:assert/strict'
import test from 'node:test'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'

const Dummy = { template: '<div />' }

async function renderMaintenanceLogView({
  vite,
  role = 'BOARD',
  lang = 'en',
  url = '/maintenance/log?tab=report',
}: {
  vite: ViteDevServer
  role?: string
  lang?: string
  url?: string
}) {
  const { setDemoUser } = await vite.ssrLoadModule('/src/api/client.js')
  const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
  const { default: MaintenanceLogView } = await vite.ssrLoadModule(
    '/src/views/maintenance/MaintenanceLogView.vue',
  )

  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/maintenance', component: Dummy },
      { path: '/maintenance/log', component: MaintenanceLogView },
      { path: '/maintenance/:taskId', component: Dummy },
    ],
  })

  await router.push(url)
  await router.isReady()

  const userIds: Record<string, string> = {
    CHAIRMAN: '018f0000-0000-7000-8000-000000000101',
    USER: '018f0000-0000-7000-8000-000000000102',
    ACCOUNTANT: '018f0000-0000-7000-8000-000000000103',
    BOARD: '018f0000-0000-7000-8000-000000000105',
  }
  setDemoUser(userIds[role] || userIds.USER)

  const app = createSSRApp({ render: () => h(MaintenanceLogView) })
  app.use(pinia)
  app.use(router)

  const session = useSessionStore(pinia)
  await session.setLang(lang)
  session.me = {
    user_id: userIds[role] || userIds.USER,
    building_role: role,
    memberships: [],
    locale: lang,
  } as any

  const html = await renderToString(app)
  setDemoUser('')
  return { html, session }
}

test('MaintenanceLogView.vue compiles and enforces role, tab routing, and localized aria attributes (#029)', async () => {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })

  try {
    // 1. Resident (USER) sees forbidden guard and never report panel or calendar back link
    const resident = await renderMaintenanceLogView({
      vite,
      role: 'USER',
      lang: 'en',
      url: '/maintenance/log?tab=report',
    })
    assert.equal(resident.html.includes('data-testid="maintenance-log-forbidden"'), true)
    assert.equal(resident.html.includes('data-testid="maintenance-yearly-report-panel"'), false)
    assert.equal(resident.html.includes('data-testid="back-to-maintenance-calendar-link"'), false)

    // 2. Accountant sees report tab panel, year select, CSV button, NO back-to-calendar link, and localized ET aria-label
    const accountantEt = await renderMaintenanceLogView({
      vite,
      role: 'ACCOUNTANT',
      lang: 'et',
      url: '/maintenance/log?tab=report',
    })
    assert.equal(accountantEt.html.includes('data-testid="maintenance-log-forbidden"'), false)
    assert.equal(accountantEt.html.includes('data-testid="maintenance-yearly-report-panel"'), true)
    assert.equal(accountantEt.html.includes('data-testid="report-year-select"'), true)
    assert.equal(accountantEt.html.includes('data-testid="download-maintenance-csv-btn"'), true)
    assert.equal(accountantEt.html.includes('data-testid="back-to-maintenance-calendar-link"'), false)
    assert.equal(accountantEt.html.includes('aria-label="Hoolduspäeviku vaated"'), true)
    assert.equal(accountantEt.html.includes('aria-label="Maintenance log views"'), false)

    // 3. Board sees back-to-calendar link and RU localized aria-label on log tab
    const boardRu = await renderMaintenanceLogView({
      vite,
      role: 'BOARD',
      lang: 'ru',
      url: '/maintenance/log',
    })
    assert.equal(boardRu.html.includes('data-testid="back-to-maintenance-calendar-link"'), true)
    assert.equal(boardRu.html.includes('data-testid="maintenance-yearly-report-panel"'), false)
    assert.equal(boardRu.html.includes('aria-label="Разделы журнала обслуживания"'), true)
  } finally {
    await vite.close()
  }
})
