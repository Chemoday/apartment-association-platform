import { onBeforeUnmount, ref, watch } from 'vue'
import { getChatMessages, postChatMessage } from '@/api/endpoints/chat.js'
import { useSessionStore } from '@/stores/session.js'
import {
  CHAT_MAX_LENGTH,
  computeOpenChatPollDelayMs,
  mergeChatMessages,
  pruneExpiredChatMessages,
} from '@/utils/chat.js'
import {
  markChatDisabledFromApi,
  markChatForbiddenFromApi,
  syncChatStateFromMessagesPage,
} from './useChatState.js'

const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Composable for the open `/chat` view (#033).
 * Implements adaptive polling (3s hot / 15s normal / 30s idle / 0ms has_more),
 * visibility pause/resume, single-flight concurrency, AbortController cleanup,
 * `turned_on_at` epoch reset, client expiry pruning, 409 disable, and 429 cooldown.
 */
export function useChat(options = {}) {
  const session = options.session || useSessionStore()
  const fetchMessagesFn = options.fetchMessagesFn || getChatMessages
  const sendMessageFn = options.sendMessageFn || postChatMessage
  const nowFn = options.nowFn || (() => Date.now())
  const onDisabled = options.onDisabled || markChatDisabledFromApi
  const onForbidden = options.onForbidden || markChatForbiddenFromApi
  const onPageSync = options.onPageSync || syncChatStateFromMessagesPage
  const autoLifecycle = options.autoLifecycle !== false

  const messages = ref([])
  const cursor = ref(null)
  const turnedOnAt = ref(null)
  const initialLoading = ref(false)
  const loadError = ref(null)
  const disabled = ref(false)
  const forbidden = ref(false)
  const sending = ref(false)
  const sendError = ref(null)
  const cooldownSeconds = ref(0)

  let lifecycleSeq = 0
  let pollSeq = 0
  let started = false
  let hasLoadedOnce = false
  let pollInFlight = false
  let pollTimer = null
  let pollScheduledDelayMs = null
  let expiryTimer = null
  let cooldownTimer = null
  let pollAbortController = null
  let postAbortController = null
  let lastMessageAtMs = null
  let lastTypingAtMs = null
  let openedAtMs = null
  let visibilityListenerAttached = false
  let sessionWatchStop = null

  function isVisible() {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  }

  function clearPollTimer() {
    if (pollTimer !== null) {
      globalThis.clearTimeout(pollTimer)
      pollTimer = null
      pollScheduledDelayMs = null
    }
  }

  function clearExpiryTimer() {
    if (expiryTimer !== null) {
      globalThis.clearTimeout(expiryTimer)
      expiryTimer = null
    }
  }

  function clearCooldownTimer() {
    if (cooldownTimer !== null) {
      globalThis.clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }

  function abortRequests() {
    ++pollSeq
    if (pollAbortController) {
      pollAbortController.abort()
      pollAbortController = null
    }
    if (postAbortController) {
      postAbortController.abort()
      postAbortController = null
    }
    pollInFlight = false
    sending.value = false
  }

  function runExpiryPrune() {
    clearExpiryTimer()
    const nowMs = nowFn()
    const { messages: kept, removedCount, nextExpiryMs } = pruneExpiredChatMessages(
      messages.value,
      nowMs,
    )
    if (removedCount > 0) {
      messages.value = kept
      if (kept.length > 0) {
        const newestCreated = Date.parse(kept[kept.length - 1].created_at)
        lastMessageAtMs = Number.isFinite(newestCreated) ? newestCreated : lastMessageAtMs
      } else {
        lastMessageAtMs = null
      }
    }
    if (nextExpiryMs !== null && started && !disabled.value && !forbidden.value) {
      const waitMs = Math.min(MAX_TIMEOUT_MS, Math.max(25, nextExpiryMs - nowMs + 10))
      expiryTimer = globalThis.setTimeout(() => {
        expiryTimer = null
        runExpiryPrune()
      }, waitMs)
    }
  }

  function scheduleNextPoll(hasMore = false) {
    clearPollTimer()
    if (!started || disabled.value || forbidden.value || !isVisible() || pollInFlight) {
      return
    }
    if (!session || session.authMode === 'none' || session.backendOffline) {
      return
    }
    const delayMs = computeOpenChatPollDelayMs({
      nowMs: nowFn(),
      lastMessageAtMs,
      lastTypingAtMs,
      openedAtMs,
      hasMore,
    })
    pollScheduledDelayMs = delayMs
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = null
      pollScheduledDelayMs = null
      pollMessages()
    }, delayMs)
  }

  async function pollMessages({ initial = false } = {}) {
    if (!started || disabled.value || forbidden.value || !isVisible() || pollInFlight) {
      return
    }
    if (!session || session.authMode === 'none' || session.backendOffline) {
      return
    }

    clearPollTimer()
    const seq = lifecycleSeq
    const currentPollSeq = ++pollSeq
    const expectedUserId = session?.actingUserId
    const controller = new AbortController()
    pollAbortController = controller
    pollInFlight = true
    if (initial || !hasLoadedOnce) {
      initialLoading.value = true
      loadError.value = null
    }

    let nextHasMore = false
    let skipSchedule = false

    try {
      const useAfter = !initial && cursor.value !== null && cursor.value !== undefined
      const page = await fetchMessagesFn({
        ...(useAfter ? { after: cursor.value } : {}),
        limit: 100,
        signal: controller.signal,
      })

      if (
        seq !== lifecycleSeq ||
        currentPollSeq !== pollSeq ||
        session?.actingUserId !== expectedUserId
      ) {
        skipSchedule = true
        return
      }

      const incomingTurnedOnAt = page?.turned_on_at ?? null
      if (turnedOnAt.value !== null && incomingTurnedOnAt !== turnedOnAt.value) {
        // Chat was disabled and re-enabled while client wasn't looking: clear & reload without `after`
        messages.value = []
        cursor.value = null
        turnedOnAt.value = incomingTurnedOnAt
        lastMessageAtMs = null
        openedAtMs = nowFn()
        sendError.value = null
        onPageSync(page)
        nextHasMore = true
        return
      }

      if (turnedOnAt.value === null) {
        turnedOnAt.value = incomingTurnedOnAt
      }
      onPageSync(page)

      const nowMs = nowFn()
      const merged = mergeChatMessages(messages.value, Array.isArray(page?.messages) ? page.messages : [])
      const pruned = pruneExpiredChatMessages(merged, nowMs)
      messages.value = pruned.messages

      if (page && page.cursor !== undefined && page.cursor !== null) {
        cursor.value = page.cursor
      }
      if (pruned.messages.length > 0) {
        const newestMs = Date.parse(pruned.messages[pruned.messages.length - 1].created_at)
        if (Number.isFinite(newestMs)) {
          lastMessageAtMs = newestMs
        }
      }
      hasLoadedOnce = true
      loadError.value = null
      nextHasMore = Boolean(page?.has_more)
      runExpiryPrune()
    } catch (err) {
      if (
        seq !== lifecycleSeq ||
        currentPollSeq !== pollSeq ||
        session?.actingUserId !== expectedUserId ||
        err?.name === 'AbortError' ||
        err?.errorCode === 'REQUEST_ABORTED'
      ) {
        skipSchedule = true
        return
      }

      if (err?.status === 409 || err?.errorCode === 'CHAT_DISABLED') {
        clearPollTimer()
        clearExpiryTimer()
        clearCooldownTimer()
        messages.value = []
        cursor.value = null
        turnedOnAt.value = null
        sendError.value = null
        cooldownSeconds.value = 0
        disabled.value = true
        loadError.value = null
        onDisabled()
        skipSchedule = true
        return
      }

      if (err?.status === 403 || err?.errorCode === 'FORBIDDEN') {
        clearPollTimer()
        clearExpiryTimer()
        clearCooldownTimer()
        messages.value = []
        cursor.value = null
        turnedOnAt.value = null
        sendError.value = null
        cooldownSeconds.value = 0
        forbidden.value = true
        loadError.value = null
        onForbidden()
        skipSchedule = true
        return
      }

      if (!hasLoadedOnce) {
        loadError.value = err
        skipSchedule = true
      }
    } finally {
      if (seq === lifecycleSeq && currentPollSeq === pollSeq) {
        pollInFlight = false
        initialLoading.value = false
        if (pollAbortController === controller) {
          pollAbortController = null
        }
        if (!skipSchedule) {
          scheduleNextPoll(nextHasMore)
        }
      }
    }
  }

  function startCooldown(seconds) {
    clearCooldownTimer()
    const total = Math.max(1, Math.ceil(Number(seconds) || 1))
    cooldownSeconds.value = total
    cooldownTimer = globalThis.setInterval(() => {
      if (cooldownSeconds.value <= 1) {
        cooldownSeconds.value = 0
        clearCooldownTimer()
      } else {
        cooldownSeconds.value -= 1
      }
    }, 1_000)
  }

  async function sendMessage(payload) {
    if (!started || disabled.value || forbidden.value || sending.value || cooldownSeconds.value > 0) {
      return { ok: false, skipped: true }
    }

    const seq = lifecycleSeq
    const expectedUserId = session?.actingUserId
    const controller = new AbortController()
    postAbortController = controller
    sending.value = true
    sendError.value = null

    try {
      const created = await sendMessageFn(
        {
          body: payload?.body ?? '',
          ...(payload?.author_apartment_id !== undefined
            ? { author_apartment_id: payload.author_apartment_id }
            : {}),
        },
        { signal: controller.signal },
      )
      if (seq !== lifecycleSeq || session?.actingUserId !== expectedUserId) {
        return { ok: false, stale: true }
      }

      const nowMs = nowFn()
      const merged = mergeChatMessages(messages.value, [created])
      const pruned = pruneExpiredChatMessages(merged, nowMs)
      messages.value = pruned.messages

      const createdMs = Date.parse(created?.created_at || '')
      lastMessageAtMs = Number.isFinite(createdMs) ? createdMs : nowMs
      runExpiryPrune()

      // Do NOT advance `cursor` on POST (so parallel neighbor messages between polls are not skipped)
      // and do NOT fire an extra GET poll; only ensure adaptive wait timer updates if it wasn't running
      if (!pollInFlight) {
        scheduleNextPoll(false)
      }
      return { ok: true, message: created }
    } catch (err) {
      if (
        seq !== lifecycleSeq ||
        session?.actingUserId !== expectedUserId ||
        err?.name === 'AbortError' ||
        err?.errorCode === 'REQUEST_ABORTED'
      ) {
        return { ok: false, aborted: true }
      }

      if (err?.status === 409 || err?.errorCode === 'CHAT_DISABLED') {
        clearPollTimer()
        clearExpiryTimer()
        clearCooldownTimer()
        messages.value = []
        cursor.value = null
        turnedOnAt.value = null
        sendError.value = null
        cooldownSeconds.value = 0
        disabled.value = true
        onDisabled()
        return { ok: false, disabled: true, error: err }
      }

      if (err?.status === 403 || err?.errorCode === 'FORBIDDEN') {
        clearPollTimer()
        clearExpiryTimer()
        clearCooldownTimer()
        messages.value = []
        cursor.value = null
        turnedOnAt.value = null
        sendError.value = null
        cooldownSeconds.value = 0
        forbidden.value = true
        onForbidden()
        return { ok: false, forbidden: true, error: err }
      }

      if (err?.status === 429 || err?.errorCode === 'RATE_LIMITED') {
        const retrySec = Number(err?.payload?.retry_after_seconds || 1)
        startCooldown(retrySec)
        return { ok: false, rateLimited: true, retryAfterSeconds: retrySec, error: err }
      }

      sendError.value = err || { errorCode: 'DEFAULT' }
      return { ok: false, error: err }
    } finally {
      if (seq === lifecycleSeq) {
        sending.value = false
        if (postAbortController === controller) {
          postAbortController = null
        }
      }
    }
  }

  function notifyTyping() {
    const nowMs = nowFn()
    lastTypingAtMs = nowMs
    // If sleeping on the 30s idle interval, tighten timer down to the 15s window without triggering immediate fetch
    if (started && !pollInFlight && pollScheduledDelayMs !== null && pollScheduledDelayMs >= 30_000) {
      scheduleNextPoll(false)
    }
  }

  function handleVisibilityChange() {
    if (!started) return
    if (!isVisible()) {
      clearPollTimer()
      clearExpiryTimer()
      ++pollSeq
      if (pollAbortController) {
        pollAbortController.abort()
        pollAbortController = null
      }
      pollInFlight = false
      return
    }
    runExpiryPrune()
    if (!disabled.value && !forbidden.value) {
      pollMessages({ initial: !hasLoadedOnce })
    }
  }

  function resetInternalState() {
    clearPollTimer()
    clearExpiryTimer()
    clearCooldownTimer()
    abortRequests()
    messages.value = []
    cursor.value = null
    turnedOnAt.value = null
    initialLoading.value = false
    loadError.value = null
    disabled.value = false
    forbidden.value = false
    sending.value = false
    sendError.value = null
    cooldownSeconds.value = 0
    hasLoadedOnce = false
    lastMessageAtMs = null
    lastTypingAtMs = null
    openedAtMs = nowFn()
  }

  function reload() {
    if (!started) return
    ++lifecycleSeq
    resetInternalState()
    return pollMessages({ initial: true })
  }

  function start() {
    if (started) return
    started = true
    ++lifecycleSeq
    resetInternalState()

    if (
      !visibilityListenerAttached &&
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function'
    ) {
      document.addEventListener('visibilitychange', handleVisibilityChange)
      visibilityListenerAttached = true
    }

    if (!sessionWatchStop && session) {
      sessionWatchStop = watch(
        () => [session.sessionRevision, session.actingUserId, session.authMode, session.backendOffline],
        () => {
          if (!started) return
          ++lifecycleSeq
          resetInternalState()
          pollMessages({ initial: true })
        },
      )
    }

    return pollMessages({ initial: true })
  }

  function stop() {
    started = false
    ++lifecycleSeq
    clearPollTimer()
    clearExpiryTimer()
    clearCooldownTimer()
    abortRequests()
    if (
      visibilityListenerAttached &&
      typeof document !== 'undefined' &&
      typeof document.removeEventListener === 'function'
    ) {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      visibilityListenerAttached = false
    }
    if (sessionWatchStop) {
      sessionWatchStop()
      sessionWatchStop = null
    }
  }

  if (autoLifecycle) {
    onBeforeUnmount(() => {
      stop()
    })
  }

  return {
    messages,
    cursor,
    turnedOnAt,
    initialLoading,
    loadError,
    disabled,
    forbidden,
    sending,
    sendError,
    cooldownSeconds,
    maxLength: CHAT_MAX_LENGTH,
    start,
    stop,
    reload,
    sendMessage,
    notifyTyping,
    runExpiryPrune,
  }
}
