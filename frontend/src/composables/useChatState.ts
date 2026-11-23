import { computed, ref, watch, type WatchStopHandle } from 'vue'
import { asApiErrorLike } from '@/api/client.js'
import { getChatState } from '@/api/endpoints/chat.js'
import type { ChatPage, ChatState } from '@/api/schema.js'
import { computeStatePollDelayMs, CHAT_STATE_POLL_ON_MS } from '@/utils/chat.js'
import type { UseChatSessionLike } from './useChat.js'

const chatState = ref<ChatState | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let stateSeq = 0
let abortController: AbortController | null = null
let activeSession: UseChatSessionLike | null = null
let chatScreenOpen = false
let visibilityAttached = false
let sessionWatcherStop: WatchStopHandle | null = null
let routeWatcherStop: WatchStopHandle | null = null
let fetchStateImpl: typeof getChatState = getChatState

export const chatEnabled = computed<boolean>(() => Boolean(chatState.value?.enabled))
export const canTakePartInChat = computed<boolean>(() => Boolean(chatState.value?.can_take_part))
export const canShowChat = computed<boolean>(() => chatEnabled.value && canTakePartInChat.value)
export const chatRecentCount = computed<number>(() =>
  canShowChat.value ? Math.max(0, Number(chatState.value?.recent_count || 0)) : 0,
)
export const chatRecentMinutes = computed<number>(() =>
  Math.max(1, Number(chatState.value?.recent_minutes || 10)),
)
export const chatLastMessageAt = computed<string | null>(() =>
  canShowChat.value ? chatState.value?.last_message_at || null : null,
)
export const chatTurnedOnAt = computed<string | null>(() =>
  chatEnabled.value ? chatState.value?.turned_on_at || null : null,
)
export const chatHistoryHours = computed<number>(() =>
  Math.max(1, Number(chatState.value?.history_hours || 2)),
)
export const chatMaxLength = computed<number>(() =>
  Math.max(1, Number(chatState.value?.max_length || 500)),
)

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function canPollState(): boolean {
  return Boolean(
    activeSession &&
      activeSession.authMode !== 'none' &&
      !activeSession.backendOffline &&
      !chatScreenOpen &&
      isDocumentVisible(),
  )
}

function clearPollTimer(): void {
  if (timer !== null) {
    globalThis.clearTimeout(timer)
    timer = null
  }
}

function abortInFlight(): void {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
  inFlight = false
}

function scheduleNextPoll(): void {
  clearPollTimer()
  if (!canPollState()) return
  const delayMs =
    chatState.value === null
      ? CHAT_STATE_POLL_ON_MS
      : computeStatePollDelayMs(Boolean(chatState.value.enabled))
  timer = globalThis.setTimeout(() => {
    timer = null
    pollOnce()
  }, delayMs)
}

async function pollOnce(): Promise<void> {
  if (inFlight || !canPollState()) {
    return
  }
  clearPollTimer()
  const seq = ++stateSeq
  const expectedUserId = activeSession?.actingUserId
  const controller = new AbortController()
  abortController = controller
  inFlight = true

  try {
    const res = await fetchStateImpl({ signal: controller.signal })
    if (seq !== stateSeq || activeSession?.actingUserId !== expectedUserId) return
    chatState.value = res || null
  } catch (err: unknown) {
    const errLike = asApiErrorLike(err)
    if (
      seq !== stateSeq ||
      activeSession?.actingUserId !== expectedUserId ||
      errLike.name === 'AbortError' ||
      errLike.errorCode === 'REQUEST_ABORTED'
    ) {
      return
    }
    if (errLike.status === 401 || errLike.status === 403) {
      chatState.value = {
        ...(chatState.value || {
          recent_minutes: 10,
          history_hours: 2,
          max_length: 500,
        }),
        enabled: false,
        turned_on_at: null,
        can_take_part: false,
        recent_count: 0,
        last_message_at: null,
      }
    }
  } finally {
    if (seq === stateSeq) {
      inFlight = false
      if (abortController === controller) {
        abortController = null
      }
      scheduleNextPoll()
    }
  }
}

function handleVisibilityChange(): void {
  if (!isDocumentVisible()) {
    clearPollTimer()
    ++stateSeq
    abortInFlight()
    return
  }
  if (canPollState()) {
    pollOnce()
  }
}

export function setChatScreenOpen(isOpen: boolean): void {
  const next = Boolean(isOpen)
  if (chatScreenOpen === next) return
  chatScreenOpen = next
  if (next) {
    clearPollTimer()
    ++stateSeq
    abortInFlight()
  } else if (canPollState()) {
    pollOnce()
  }
}

export function markChatDisabledFromApi(): void {
  chatState.value = {
    enabled: false,
    turned_on_at: null,
    can_take_part: chatState.value?.can_take_part ?? true,
    recent_count: 0,
    recent_minutes: chatState.value?.recent_minutes ?? 10,
    last_message_at: null,
    history_hours: chatState.value?.history_hours ?? 2,
    max_length: chatState.value?.max_length ?? 500,
  }
  scheduleNextPoll()
}

export function markChatForbiddenFromApi(): void {
  chatState.value = {
    enabled: chatState.value?.enabled ?? false,
    turned_on_at: chatState.value?.turned_on_at ?? null,
    can_take_part: false,
    recent_count: 0,
    recent_minutes: chatState.value?.recent_minutes ?? 10,
    last_message_at: null,
    history_hours: chatState.value?.history_hours ?? 2,
    max_length: chatState.value?.max_length ?? 500,
  }
  scheduleNextPoll()
}

export function syncChatStateFromMessagesPage(page?: Partial<ChatPage> | null): void {
  if (!page || typeof page !== 'object' || !('turned_on_at' in page)) return
  if (chatState.value) {
    chatState.value = {
      ...chatState.value,
      enabled: true,
      can_take_part: true,
      turned_on_at: page.turned_on_at ?? null,
    }
    return
  }
  const msgs = Array.isArray(page.messages) ? page.messages : []
  const lastMsgAt = msgs.length > 0 ? msgs[msgs.length - 1]?.created_at ?? null : null
  chatState.value = {
    enabled: true,
    turned_on_at: page.turned_on_at ?? null,
    can_take_part: true,
    recent_count: 0,
    recent_minutes: 10,
    last_message_at: lastMsgAt,
    history_hours: 2,
    max_length: 500,
  }
}

export function refreshChatState(): Promise<void> {
  clearPollTimer()
  ++stateSeq
  abortInFlight()
  if (canPollState()) {
    return pollOnce()
  }
  return Promise.resolve()
}

export function startChatStatePolling(
  session: UseChatSessionLike,
  route: { name?: string | symbol | null } | null = null,
  options: { fetchStateFn?: typeof getChatState } = {},
): void {
  if (typeof options.fetchStateFn === 'function') {
    fetchStateImpl = options.fetchStateFn
  }
  activeSession = session

  if (
    !visibilityAttached &&
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    visibilityAttached = true
  }

  if (!sessionWatcherStop && session) {
    sessionWatcherStop = watch(
      () => [
        session.sessionRevision,
        session.actingUserId,
        session.authMode,
        session.backendOffline,
      ],
      () => {
        clearPollTimer()
        ++stateSeq
        abortInFlight()
        chatState.value = null
        if (canPollState()) {
          pollOnce()
        }
      },
    )
  }

  if (route && !routeWatcherStop) {
    routeWatcherStop = watch(
      () => route.name === 'chat',
      (isOpen) => {
        setChatScreenOpen(isOpen)
      },
      { immediate: true },
    )
  }

  if (canPollState() && !inFlight && timer === null) {
    pollOnce()
  }
}

export function stopChatStatePolling(): void {
  clearPollTimer()
  ++stateSeq
  abortInFlight()
  if (
    visibilityAttached &&
    typeof document !== 'undefined' &&
    typeof document.removeEventListener === 'function'
  ) {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    visibilityAttached = false
  }
  if (sessionWatcherStop) {
    sessionWatcherStop()
    sessionWatcherStop = null
  }
  if (routeWatcherStop) {
    routeWatcherStop()
    routeWatcherStop = null
  }
  activeSession = null
}

export function resetChatStateForTest(): void {
  stopChatStatePolling()
  chatState.value = null
  chatScreenOpen = false
  fetchStateImpl = getChatState
}

/**
 * Shared singleton composable consumed by navbar, sidebar, mobile bottom nav, dashboard, and chat view.
 * Issues at most ONE shared GET /api/v1/chat poll regardless of how many components mount it.
 */
export function useChatState() {
  return {
    chatState,
    chatEnabled,
    canTakePart: canTakePartInChat,
    canShowChat,
    recentCount: chatRecentCount,
    recentMinutes: chatRecentMinutes,
    lastMessageAt: chatLastMessageAt,
    turnedOnAt: chatTurnedOnAt,
    historyHours: chatHistoryHours,
    maxLength: chatMaxLength,
    startChatStatePolling,
    stopChatStatePolling,
    setChatScreenOpen,
    refreshChatState,
    markChatDisabledFromApi,
    markChatForbiddenFromApi,
    syncChatStateFromMessagesPage,
  }
}
