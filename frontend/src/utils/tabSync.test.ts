import test from 'node:test'
import assert from 'node:assert/strict'
import { createTabSync, sanitizeTabSyncEvent } from './tabSync.js'
import { useNetworkStatus } from '../composables/useNetworkStatus.js'
import { applyRouteA11yMetadata, resolveRoutePageTitle, routeAnnouncement } from '../router/title.js'
import { i18n } from '../locales/index.js'

test('sanitizeTabSyncEvent allows only safe event types and strips tokens/PII (#049)', () => {
  assert.equal(sanitizeTabSyncEvent({ type: 'UNKNOWN_EVENT' }), null)
  assert.equal(sanitizeTabSyncEvent(null), null)

  const logout = sanitizeTabSyncEvent({
    type: 'LOGOUT',
    senderId: 'tab-1',
    access_token: 'secret-jwt',
    email: 'resident@example.ee',
    lang: 'et',
  })
  assert.ok(logout)
  assert.equal(logout.type, 'LOGOUT')
  assert.equal('access_token' in logout, false)
  assert.equal('email' in logout, false)
  assert.equal('lang' in logout, false)

  const locale = sanitizeTabSyncEvent({
    type: 'LOCALE_CHANGED',
    senderId: 'tab-1',
    lang: 'et',
    token: 'should-not-leak',
  })
  assert.ok(locale)
  assert.equal(locale.lang, 'et')
  assert.equal('token' in locale, false)
})

test('createTabSync syncs across tabs via BroadcastChannel without same-tab echo and cleans up (#049)', () => {
  const channels: FakeBroadcastChannel[] = []

  class FakeBroadcastChannel {
    name: string
    onmessage: ((event: { data: unknown }) => void) | null = null
    closed = false
    constructor(name: string) {
      this.name = name
      channels.push(this)
    }
    postMessage(data: unknown) {
      for (const peer of channels) {
        if (peer !== this && !peer.closed && peer.name === this.name && peer.onmessage) {
          peer.onmessage({ data })
        }
      }
    }
    close() {
      this.closed = true
    }
  }

  const tabA = createTabSync({
    tabId: 'tab-A',
    BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
    win: null,
    storage: null,
  })
  const tabB = createTabSync({
    tabId: 'tab-B',
    BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
    win: null,
    storage: null,
  })

  const receivedA: Array<Record<string, any>> = []
  const receivedB: Array<Record<string, any>> = []

  const unsubA = tabA.subscribe((evt: Record<string, any>) => receivedA.push(evt))
  const unsubB = tabB.subscribe((evt: Record<string, any>) => receivedB.push(evt))

  tabA.broadcast('LOGOUT', { access_token: 'must-be-stripped' })
  assert.equal(receivedA.length, 0, 'Sender tab must not receive its own broadcast')
  assert.equal(receivedB.length, 1)
  assert.equal(receivedB[0].type, 'LOGOUT')
  assert.equal('access_token' in receivedB[0], false)

  tabB.broadcast('LOCALE_CHANGED', { lang: 'ru' })
  assert.equal(receivedA.length, 1)
  assert.equal(receivedA[0].lang, 'ru')

  unsubA()
  unsubB()
  tabA.close()
  tabB.close()
  assert.equal(channels.every((c) => c.closed), true)
})

test('createTabSync falls back to window storage events when BroadcastChannel is unavailable (#049)', () => {
  const listeners = new Map<string, Set<(e: any) => void>>()
  const fakeWindow = {
    addEventListener(type: string, fn: (e: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      listeners.get(type)?.delete(fn)
    },
  } as unknown as Window

  const stored = new Map<string, string>()
  const fakeStorage = {
    setItem(key: string, val: string) {
      stored.set(key, val)
    },
  } as unknown as Storage

  const tab = createTabSync({
    tabId: 'tab-storage-1',
    BroadcastChannelCtor: null,
    win: fakeWindow,
    storage: fakeStorage,
  })

  const received: Array<Record<string, any>> = []
  tab.subscribe((evt: Record<string, any>) => received.push(evt))

  // Simulate another tab writing to localStorage
  const payload = JSON.stringify({
    type: 'THEME_CHANGED',
    theme: 'nordic-slate',
    senderId: 'tab-storage-2',
    ts: Date.now(),
  })
  for (const fn of listeners.get('storage') || []) {
    fn({ key: 'hoa_platform_tab_sync_event', newValue: payload })
  }

  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'THEME_CHANGED')
  assert.equal(received[0].theme, 'nordic-slate')

  tab.broadcast('LOGOUT')
  assert.ok(stored.has('hoa_platform_tab_sync_event'))

  tab.close()
  assert.equal(listeners.get('storage')?.size ?? 0, 0)
})

test('useNetworkStatus reacts to browser offline/online events and cleans up listeners (#049)', () => {
  const listeners = new Map<string, Set<() => void>>()
  const fakeWindow = {
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
  } as unknown as Window

  const status = useNetworkStatus({ win: fakeWindow, nav: { onLine: true } })
  status.attach()
  assert.equal(status.isOnline.value, true)

  for (const fn of listeners.get('offline') || []) fn()
  assert.equal(status.isOnline.value, false)

  for (const fn of listeners.get('online') || []) fn()
  assert.equal(status.isOnline.value, true)

  status.detach()
  assert.equal(listeners.get('online')?.size ?? 0, 0)
  assert.equal(listeners.get('offline')?.size ?? 0, 0)
})

test('resolveRoutePageTitle and applyRouteA11yMetadata localize document.title and announcements across en, et, ru (#049)', () => {
  for (const locale of ['en', 'et', 'ru'] as const) {
    const t = (key: string, params?: Record<string, any>) =>
      i18n.global.t(key, params || {}, { locale })

    const readings = resolveRoutePageTitle(
      { name: 'readings', meta: { navKey: 'readings' } },
      t,
      'KÜ Sõpruse 12',
    )
    assert.ok(readings.documentTitle.endsWith(' — KÜ Sõpruse 12'))
    assert.ok(readings.pageTitle.length > 2)

    const notFound = resolveRoutePageTitle({ name: 'not-found', meta: {} }, t, 'KÜ Sõpruse 12')
    assert.ok(notFound.documentTitle.includes('KÜ Sõpruse 12'))

    applyRouteA11yMetadata(
      { name: 'readings', meta: { navKey: 'readings' } },
      { t, buildingName: 'KÜ Sõpruse 12' },
      { announce: true },
    )
    assert.ok(routeAnnouncement.value.includes(readings.pageTitle))
    assert.ok(t('a11y.skipToContent').length > 3)
    assert.ok(t('network.offlineTitle').length > 3)
  }
})
