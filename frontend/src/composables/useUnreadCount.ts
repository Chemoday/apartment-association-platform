import { ref, watch, type WatchStopHandle } from 'vue'
import { asApiErrorLike } from '@/api/client.js'
import { getUnreadCount } from '@/api/endpoints/notifications.js'

const POLL_MS = 60_000
export const unread = ref<number>(0)
export const bellEnabled = ref<boolean>(true)

export interface UnreadPollingSessionLike {
  authMode?: string
  backendOffline?: boolean
  sessionRevision?: number
}

let timer: number | null = null
let activeSession: UnreadPollingSessionLike | null = null
let stopSessionWatch: WatchStopHandle | null = null
let pollSeq = 0
let activeController: AbortController | null = null

function abortInFlightPoll(): void {
  pollSeq += 1
  if (activeController) {
    try {
      activeController.abort()
    } catch {
      /* ignore */
    }
    activeController = null
  }
}

async function poll({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (
    !bellEnabled.value ||
    !activeSession ||
    activeSession.authMode === 'none' ||
    activeSession.backendOffline ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  ) {
    return
  }
  if (activeController && !force) {
    return
  }
  abortInFlightPoll()
  const seq = ++pollSeq
  const sessionAtStart = activeSession
  const revAtStart = sessionAtStart.sessionRevision
  const authModeAtStart = sessionAtStart.authMode
  const controller = new AbortController()
  activeController = controller

  try {
    const res = await getUnreadCount({ signal: controller.signal })
    if (
      seq !== pollSeq ||
      activeSession !== sessionAtStart ||
      sessionAtStart.sessionRevision !== revAtStart ||
      sessionAtStart.authMode !== authModeAtStart
    ) {
      return
    }
    if (res && typeof res.unread === 'number') {
      unread.value = Math.max(0, res.unread)
    }
  } catch (error: unknown) {
    const errLike = asApiErrorLike(error)
    if (
      seq !== pollSeq ||
      errLike.errorCode === 'REQUEST_ABORTED' ||
      errLike.name === 'AbortError'
    ) {
      return
    }
    if (errLike.status === 404) {
      bellEnabled.value = false
    }
  } finally {
    if (seq === pollSeq) {
      activeController = null
    }
  }
}

function handleVisibilityChange(): void {
  void poll()
}

export function stopUnreadPolling(): void {
  abortInFlightPoll()
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  if (stopSessionWatch) {
    stopSessionWatch()
    stopSessionWatch = null
  }
  activeSession = null
}

export function startUnreadPolling(session: UnreadPollingSessionLike): void {
  stopUnreadPolling()
  activeSession = session
  if (typeof window !== 'undefined') {
    timer = window.setInterval(() => {
      void poll()
    }, POLL_MS)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  stopSessionWatch = watch(
    () => [session.sessionRevision, session.authMode],
    () => {
      abortInFlightPoll()
      unread.value = 0
      if (session.authMode !== 'none') {
        void poll({ force: true })
      }
    },
  )
  void poll({ force: true })
}

export function refreshUnreadCount(): Promise<void> {
  return poll({ force: true })
}

export function setUnread(value: number | string): void {
  unread.value = Math.max(0, Number(value) || 0)
}
