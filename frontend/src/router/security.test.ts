import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ref } from 'vue'
import { canAccessRoute, createAuthGuard } from './access.js'
import { useUnsavedChangesGuard } from '../composables/useUnsavedChangesGuard.js'

const SRC_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(full, acc)
    } else if (
      entry.isFile() &&
      /\.(?:vue|js|ts)$/.test(entry.name) &&
      !/\.test\.(?:js|ts)$/.test(entry.name)
    ) {
      acc.push(full)
    }
  }
  return acc
}

test('canAccessRoute enforces meta.roles fail-closed across all 4 building roles (#048)', () => {
  const chairmanOnly = { meta: { roles: ['CHAIRMAN'] } }
  const boardOrChair = { meta: { roles: ['BOARD', 'CHAIRMAN'] } }
  const staffAccounting = { meta: { roles: ['BOARD', 'CHAIRMAN', 'ACCOUNTANT'] } }
  const allRoles = { meta: { roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'] } }
  const publicRoute = { meta: { public: true } }

  const sessions = {
    USER: { buildingRole: 'USER', memberships: [{ apartment_id: 'a1' }] },
    BOARD: { buildingRole: 'BOARD', memberships: [] },
    CHAIRMAN: { buildingRole: 'CHAIRMAN', memberships: [] },
    ACCOUNTANT: { buildingRole: 'ACCOUNTANT', memberships: [] },
    UNKNOWN: { buildingRole: '', me: null, memberships: [] },
  }

  assert.equal(canAccessRoute(chairmanOnly, sessions.CHAIRMAN), true)
  assert.equal(canAccessRoute(chairmanOnly, sessions.BOARD), false)
  assert.equal(canAccessRoute(chairmanOnly, sessions.ACCOUNTANT), false)
  assert.equal(canAccessRoute(chairmanOnly, sessions.USER), false)
  assert.equal(canAccessRoute(chairmanOnly, sessions.UNKNOWN), false)

  assert.equal(canAccessRoute(boardOrChair, sessions.CHAIRMAN), true)
  assert.equal(canAccessRoute(boardOrChair, sessions.BOARD), true)
  assert.equal(canAccessRoute(boardOrChair, sessions.ACCOUNTANT), false)
  assert.equal(canAccessRoute(boardOrChair, sessions.USER), false)

  assert.equal(canAccessRoute(staffAccounting, sessions.ACCOUNTANT), true)
  assert.equal(canAccessRoute(staffAccounting, sessions.BOARD), true)
  assert.equal(canAccessRoute(staffAccounting, sessions.CHAIRMAN), true)
  assert.equal(canAccessRoute(staffAccounting, sessions.USER), false)

  assert.equal(canAccessRoute(allRoles, sessions.USER), true)
  assert.equal(canAccessRoute(publicRoute, sessions.UNKNOWN), true)
})

test('canAccessRoute enforces requiresApartmentOrBoard cleanly (#048)', () => {
  const aptOrBoardRoute = {
    meta: { roles: ['USER', 'BOARD', 'CHAIRMAN', 'ACCOUNTANT'], requiresApartmentOrBoard: true },
  }

  assert.equal(
    canAccessRoute(aptOrBoardRoute, { buildingRole: 'USER', memberships: [] }),
    false,
  )
  assert.equal(
    canAccessRoute(aptOrBoardRoute, { buildingRole: 'ACCOUNTANT', memberships: [] }),
    false,
  )
  assert.equal(
    canAccessRoute(aptOrBoardRoute, {
      buildingRole: 'USER',
      memberships: [{ apartment_id: 'apt-1' }],
    }),
    true,
  )
  assert.equal(
    canAccessRoute(aptOrBoardRoute, { buildingRole: 'BOARD', memberships: [] }),
    true,
  )
  assert.equal(
    canAccessRoute(aptOrBoardRoute, { buildingRole: 'CHAIRMAN', memberships: [] }),
    true,
  )
})

test('createAuthGuard redirects unauthenticated users to welcome and unauthorized roles to forbidden (#048)', async () => {
  let bootstrapCalls = 0
  let currentSession: {
    authMode: string
    backendOffline: boolean
    buildingRole: string
    memberships: Array<{ apartment_id: string }>
    bootstrap: () => Promise<void>
  } = {
    authMode: 'none',
    backendOffline: false,
    buildingRole: 'USER',
    memberships: [],
    async bootstrap() {
      bootstrapCalls += 1
    },
  }

  const guard = createAuthGuard(() => currentSession)

  // Unauthenticated on protected route -> welcome
  const unauthResult = await guard({
    name: 'people',
    path: '/people',
    fullPath: '/people',
    meta: { roles: ['CHAIRMAN'] },
  })
  assert.deepEqual(unauthResult, { name: 'welcome' })
  assert.equal(bootstrapCalls, 1)

  // Public route stays allowed when unauthenticated
  const publicResult = await guard({
    name: 'login',
    path: '/login',
    fullPath: '/login',
    meta: { public: true },
  })
  assert.equal(publicResult, true)

  // Signed-in USER hitting CHAIRMAN-only route -> forbidden (replace, preserves from)
  currentSession = {
    ...currentSession,
    authMode: 'signed_in',
    buildingRole: 'USER',
    memberships: [{ apartment_id: 'apt-1' }],
  }
  const forbiddenResult = await guard({
    name: 'people',
    path: '/people',
    fullPath: '/people?tab=invites',
    meta: { roles: ['CHAIRMAN'] },
  })
  assert.deepEqual(forbiddenResult, {
    name: 'forbidden',
    query: { from: '/people?tab=invites' },
    replace: true,
  })

  // Role downgrade from CHAIRMAN -> BOARD on /people blocks immediately
  currentSession = { ...currentSession, buildingRole: 'BOARD' }
  const demotedResult = await guard({
    name: 'people',
    path: '/people',
    fullPath: '/people',
    meta: { roles: ['CHAIRMAN'] },
  })
  assert.deepEqual(demotedResult, {
    name: 'forbidden',
    query: { from: '/people' },
    replace: true,
  })

  // CHAIRMAN succeeds
  currentSession = { ...currentSession, buildingRole: 'CHAIRMAN' }
  assert.equal(
    await guard({
      name: 'people',
      path: '/people',
      fullPath: '/people',
      meta: { roles: ['CHAIRMAN'] },
    }),
    true,
  )

  // Explicit 404 route is reachable for signed-in users without looping
  assert.equal(
    await guard({
      name: 'not-found',
      path: '/non-existent-page',
      fullPath: '/non-existent-page',
      meta: { layout: 'AppLayout' },
    }),
    true,
  )
})

test('useUnsavedChangesGuard blocks dirty navigation until confirmed and handles beforeunload (#048)', async () => {
  const dirty = ref(false)
  const guard = useUnsavedChangesGuard(dirty, { registerRouteGuard: false })

  // Clean form: allows leave and ignores beforeunload
  assert.equal(guard.requestLeaveDecision(), true)
  let prevented = false
  const cleanEvent = {
    returnValue: undefined,
    preventDefault() {
      prevented = true
    },
  }
  guard.handleBeforeUnload(cleanEvent)
  assert.equal(prevented, false)

  // Dirty form: blocks beforeunload and opens modal decision
  dirty.value = true
  const dirtyEvent = {
    returnValue: undefined,
    preventDefault() {
      prevented = true
    },
  }
  guard.handleBeforeUnload(dirtyEvent)
  assert.equal(prevented, true)
  assert.equal(dirtyEvent.returnValue, '')

  const cancelPromise = guard.requestLeaveDecision()
  assert.equal(guard.showLeaveModal.value, true)
  guard.cancelLeave()
  assert.equal(await cancelPromise, false)
  assert.equal(guard.showLeaveModal.value, false)

  const confirmPromise = guard.requestLeaveDecision()
  assert.equal(guard.showLeaveModal.value, true)
  guard.confirmLeave()
  assert.equal(await confirmPromise, true)
  assert.equal(guard.showLeaveModal.value, false)
})

test('static security invariant: zero v-html, eval, new Function, or javascript: URLs in src/ (#048)', () => {
  const files = walkSourceFiles(SRC_DIR)
  assert.ok(files.length > 50, 'Expected to scan application source files')

  const forbiddenPatterns = [
    { name: 'v-html', re: /\bv-html\s*=/ },
    { name: 'eval()', re: /\beval\s*\(/ },
    { name: 'new Function()', re: /\bnew\s+Function\s*\(/ },
    { name: 'script protocol URL', re: /['"`]\s*javascript\s*:/i },
  ]

  const violations: string[] = []
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    for (const pattern of forbiddenPatterns) {
      if (pattern.re.test(content)) {
        violations.push(`${pattern.name} found in ${file}`)
      }
    }
  }

  assert.deepEqual(violations, [], `Security invariant violations:\n${violations.join('\n')}`)
})

test('GDPR & performance invariants: zero third-party font CDN links in index.html and all routes are lazy-loaded (#046)', async () => {
  const indexHtml = readFileSync(resolve(SRC_DIR, '..', 'index.html'), 'utf8')
  assert.equal(indexHtml.includes('fonts.googleapis.com'), false, 'index.html must not load Google Fonts CDN')
  assert.equal(indexHtml.includes('fonts.gstatic.com'), false, 'index.html must not preconnect Google Fonts CDN')
  assert.equal(/https?:\/\/.*(?:cdn|unpkg|jsdelivr|googleapis)/i.test(indexHtml), false)

  const routesSource = readFileSync(resolve(SRC_DIR, 'router', 'routes.ts'), 'utf8')
  assert.equal(
    /^import\s+\w+\s+from\s+['"]@\/views\//m.test(routesSource),
    false,
    'src/router/routes.ts must not statically import view components',
  )
})

test('every non-redirect route in APP_ROUTES declares explicit meta.public or non-empty meta.roles (#048 CTO audit)', async () => {
  const { APP_ROUTES } = await import('./routes.js')
  assert.ok(Array.isArray(APP_ROUTES) && APP_ROUTES.length > 20)

  for (const route of APP_ROUTES) {
    if (route.redirect) continue
    const isPublic = Boolean(route.meta?.public)
    const roles = route.meta?.roles
    assert.ok(
      isPublic || (Array.isArray(roles) && roles.length > 0),
      `Route "${String(route.name || route.path)}" must declare either meta.public: true or non-empty meta.roles`,
    )
  }
})

test('createAuthGuard allows public routes even if session.bootstrap() throws and blocks protected routes fail-closed (#048 CTO audit)', async () => {
  const brokenSession = {
    authMode: 'none',
    backendOffline: false,
    buildingRole: 'USER',
    memberships: [],
    async bootstrap() {
      throw new Error('Unexpected bootstrap failure')
    },
  }
  const guard = createAuthGuard(() => brokenSession)

  const pubRes = await guard({
    name: 'login',
    path: '/login',
    fullPath: '/login',
    meta: { public: true },
  })
  assert.equal(pubRes, true)

  const privRes = await guard({
    name: 'people',
    path: '/people',
    fullPath: '/people',
    meta: { roles: ['CHAIRMAN'] },
  })
  assert.deepEqual(privRes, { name: 'welcome' })
})

test('loadOfflineDemoModule resets cachedModulePromise on transient import error so retry succeeds (#041 CTO audit P1-3)', async () => {
  const { loadOfflineDemoModule, setOfflineDemoImporterForTest } = await import(
    '../api/offlineDemoState.js'
  )

  let attempts = 0
  setOfflineDemoImporterForTest(async () => {
    attempts += 1
    if (attempts === 1) {
      throw new Error('Chunk network error')
    }
    return { enableOfflineDemo: () => {}, resolveOfflineDemoRequest: async () => ({ ok: true }) }
  })

  try {
    await assert.rejects(() => loadOfflineDemoModule(), /Chunk network error/)
    assert.equal(attempts, 1)

    // Second attempt must retry rather than returning a permanently cached rejected promise
    const mod = await loadOfflineDemoModule()
    assert.equal(attempts, 2)
    assert.equal(typeof mod.enableOfflineDemo, 'function')
  } finally {
    setOfflineDemoImporterForTest(null)
  }
})
