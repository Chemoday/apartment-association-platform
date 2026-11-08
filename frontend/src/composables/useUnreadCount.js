import { ref, watch } from 'vue'
import { getUnreadCount } from '@/api/endpoints/notifications.js'

const POLL_MS = 60_000
export const unread = ref(0)
export const bellEnabled = ref(true)
let timer = null
let running = false
let activeSession = null
let watcherRegistered = false

async function poll() {
  if (
    running ||
    !bellEnabled.value ||
    !activeSession ||
    activeSession.authMode === 'none' ||
    activeSession.backendOffline ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  ) {
    return
  }
  running = true
  try {
    const res = await getUnreadCount()
    if (res && typeof res.unread === 'number') {
      unread.value = Math.max(0, res.unread)
    }
  } catch (error) {
    if (error?.status === 404) {
      bellEnabled.value = false
    }
  } finally {
    running = false
  }
}

export function startUnreadPolling(session) {
  activeSession = session
  if (!timer && typeof window !== 'undefined') {
    timer = window.setInterval(poll, POLL_MS)
  }
  if (!watcherRegistered) {
    watcherRegistered = true
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', poll)
    }
    watch(
      () => [session.sessionRevision, session.authMode],
      () => {
        unread.value = 0
        if (session.authMode !== 'none') {
          poll()
        }
      },
    )
  }
  poll()
}

export function refreshUnreadCount() {
  return poll()
}

export function setUnread(value) {
  unread.value = Math.max(0, Number(value) || 0)
}
