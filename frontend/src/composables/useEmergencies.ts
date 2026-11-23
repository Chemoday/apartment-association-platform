import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  acknowledgeEmergency,
  getActiveEmergencies,
  resolveEmergency,
} from '@/api/endpoints/communication.js'
import type { AcknowledgeResponse, EmergencyView, ResolveResponse } from '@/api/schema.js'
import { useSessionStore } from '@/stores/session.js'

const POLL_INTERVAL_MS = 45000

export function useEmergencies() {
  const session = useSessionStore()
  const emergencies = ref<EmergencyView[]>([])
  const loading = ref<boolean>(false)
  let timerId: number | null = null
  let requestSeq = 0
  let activeController: AbortController | null = null
  let unmounted = false

  function abortActiveRequest(): void {
    requestSeq += 1
    if (activeController) {
      try {
        activeController.abort()
      } catch {
        /* ignore */
      }
      activeController = null
    }
    loading.value = false
  }

  const unacknowledgedEmergencies = computed<EmergencyView[]>(() =>
    emergencies.value.filter((item) => item.is_active && item.acknowledged_at === null),
  )

  const activeEmergencies = computed<EmergencyView[]>(() =>
    emergencies.value.filter((item) => item.is_active),
  )

  async function refresh(): Promise<void> {
    if (unmounted || !session.actingUserId || session.backendOffline) {
      abortActiveRequest()
      emergencies.value = []
      return
    }
    abortActiveRequest()
    const seq = ++requestSeq
    const actingAtStart = session.actingUserId
    const revAtStart = session.sessionRevision
    const controller = new AbortController()
    activeController = controller
    loading.value = true
    try {
      const list = await getActiveEmergencies({ signal: controller.signal })
      if (
        unmounted ||
        seq !== requestSeq ||
        session.actingUserId !== actingAtStart ||
        session.sessionRevision !== revAtStart
      ) {
        return
      }
      emergencies.value = Array.isArray(list) ? list : []
    } catch {
      /* keep previous or empty on transient poll error / abort */
    } finally {
      if (!unmounted && seq === requestSeq) {
        loading.value = false
        activeController = null
      }
    }
  }

  async function acknowledge(postId: string): Promise<AcknowledgeResponse> {
    // Invalidate any in-flight poll so it cannot resurrect unacknowledged state
    abortActiveRequest()
    const revAtStart = session.sessionRevision
    const res = await acknowledgeEmergency(postId)
    if (!unmounted && session.sessionRevision === revAtStart) {
      emergencies.value = emergencies.value.map((e) =>
        e.id === postId ? { ...e, acknowledged_at: res.acknowledged_at } : e,
      )
    }
    return res
  }

  async function resolve(postId: string): Promise<ResolveResponse> {
    // Invalidate any in-flight poll so it cannot resurrect resolved emergency
    abortActiveRequest()
    const revAtStart = session.sessionRevision
    const res = await resolveEmergency(postId)
    if (!unmounted && session.sessionRevision === revAtStart) {
      emergencies.value = emergencies.value.filter((e) => e.id !== postId)
    }
    return res
  }

  function handleWindowFocus(): void {
    if (!session.backendOffline && !session.offlineDemoMode) {
      refresh()
    }
  }

  onMounted(() => {
    refresh()
    if (typeof window !== 'undefined') {
      timerId = window.setInterval(() => {
        if (!session.backendOffline && !session.offlineDemoMode) {
          refresh()
        }
      }, POLL_INTERVAL_MS)
      window.addEventListener('focus', handleWindowFocus)
    }
  })

  onUnmounted(() => {
    unmounted = true
    abortActiveRequest()
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', handleWindowFocus)
    }
  })

  watch(
    () => [session.actingUserId, session.sessionRevision],
    () => {
      abortActiveRequest()
      emergencies.value = []
      refresh()
    },
  )

  return {
    emergencies,
    activeEmergencies,
    unacknowledgedEmergencies,
    loading,
    refresh,
    acknowledge,
    resolve,
  }
}
