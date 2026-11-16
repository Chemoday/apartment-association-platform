import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from './session.js'
import { formatPollDateTime, formatPollValue } from '../utils/pollValidation.js'

function collectVueFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectVueFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.vue')) {
      results.push(full)
    }
  }
  return results
}

test('useSessionStore exposes synchronized lang/locale, actingUserId/activeUserId, buildingRole, and notificationLocale', async () => {
  setActivePinia(createPinia())
  const session = useSessionStore() as Record<string, any>

  // Initial state & supportedLocales structure
  assert.equal(Array.isArray(session.supportedLocales), true)
  assert.equal(session.supportedLocales.length, 3)
  for (const loc of session.supportedLocales) {
    assert.equal(typeof loc.code, 'string')
    assert.equal(typeof loc.label, 'string')
  }

  // Switching language with string code and object updates both lang and locale
  session.setLang('ru')
  assert.equal(session.lang, 'ru')
  assert.equal(session.locale, 'ru')

  session.setLang({ code: 'et', label: 'ET' })
  assert.equal(session.lang, 'et')
  assert.equal(session.locale, 'et')

  // Poll value and date formatting respect session.lang
  const numEt = formatPollValue('12.5', 'NUMBER', session.lang)
  assert.equal(numEt, '12,5')
  const dateEt = formatPollDateTime('2026-11-15T18:00:00Z', session.lang)
  assert.ok(dateEt.length > 0)

  session.setLang('en')
  assert.equal(formatPollValue('12.5', 'NUMBER', session.lang), '12.5')

  // Activate offline demo mode and verify actingUserId/activeUserId, buildingRole, and notificationLocale
  await session.activateOfflineDemoMode()
  assert.ok(session.actingUserId.length > 0)
  assert.equal(session.activeUserId, session.actingUserId)
  assert.equal(session.buildingRole, session.me?.building_role || 'USER')
  assert.equal(session.notificationLocale, session.me?.locale ?? null)

  // Switch demo user to Chairman and verify reactive contract properties
  const chairman = (session.demoUsers as any[]).find((u: any) => u.building_role === 'CHAIRMAN')
  assert.ok(chairman, 'Expected Chairman demo user in offline demo seed')
  await session.switchUser(chairman.user_id)
  assert.equal(session.actingUserId, chairman.user_id)
  assert.equal(session.activeUserId, chairman.user_id)
  assert.equal(session.buildingRole, 'CHAIRMAN')

  // Change notification locale and verify notificationLocale updates
  await session.changeNotificationLocale('ru')
  assert.equal(session.notificationLocale, 'ru')
  await session.changeNotificationLocale(null)
  assert.equal(session.notificationLocale, null)
})

test('every session.<prop> referenced in Vue templates and scripts exists on useSessionStore()', () => {
  setActivePinia(createPinia())
  const session = useSessionStore() as Record<string, any>
  const vueFiles = collectVueFiles(path.resolve(process.cwd(), 'src'))
  const propPattern = /(?<![/'"\w])session\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g

  for (const file of vueFiles) {
    const content = fs.readFileSync(file, 'utf8')
    let match: RegExpExecArray | null
    while ((match = propPattern.exec(content)) !== null) {
      const propName = match[1]
      assert.equal(
        propName in session,
        true,
        `Missing property session.${propName} referenced in ${path.relative(process.cwd(), file)}`,
      )
    }
  }
})

test('session store clears building on failure/user switch and reloads via refreshBuilding()', async () => {
  const originalFetch = globalThis.fetch
  let failBuilding = false

  try {
    setActivePinia(createPinia())
    const session = useSessionStore() as Record<string, any>
    await session.activateOfflineDemoMode()
    assert.ok(session.building)
    assert.equal(session.buildingError, null)

    // Switch off offline demo fallback for fetch test using a controlled fetch stub on refreshBuilding
    // First test buildingError & clearing on a fresh pinia instance in online demo mode via fetch mock
    const { setDemoUser } = await import('../api/client.js')
    const { disableOfflineDemo } = await import('../api/offlineDemoData.js')
    disableOfflineDemo()
    setActivePinia(createPinia())
    const s2 = useSessionStore() as Record<string, any>
    setDemoUser('018f0000-0000-7000-8000-000000000102')

    globalThis.fetch = async (url: any) => {
      const u = String(url)
      if (u.includes('/property/me')) {
        return new Response(
          JSON.stringify({ user_id: '018f0000-0000-7000-8000-000000000102', building_role: 'USER', memberships: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (u.includes('/property/building')) {
        if (failBuilding) {
          return new Response(
            JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: 'boom' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            building_id: 'b1',
            name: 'KÜ Sõpruse 12',
            address: 'Sõpruse pst 12, Tallinn',
            registry_facts: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    await s2.loadMe()
    assert.equal(s2.building?.address, 'Sõpruse pst 12, Tallinn')
    assert.equal(s2.buildingError, null)

    // Subsequent user switch where getBuilding fails must clear stale building and expose buildingError
    failBuilding = true
    await s2.switchUser('018f0000-0000-7000-8000-000000000101')
    assert.equal(s2.building, null)
    assert.ok(s2.buildingError)

    // Retry via refreshBuilding recovers building state
    failBuilding = false
    await s2.refreshBuilding()
    assert.equal((s2.building as any)?.address, 'Sõpruse pst 12, Tallinn')
    assert.equal(s2.buildingError, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
