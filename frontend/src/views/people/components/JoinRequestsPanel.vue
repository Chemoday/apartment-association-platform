<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import {
  confirmJoinRequest,
  listJoinRequests,
  rejectJoinRequest,
} from '@/api/endpoints/join.js'
import type { JoinRequestView } from '@/api/schema.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import { objectName } from '@/utils/objectName.js'
import { formatPhoneDisplay } from '@/utils/phone.js'
import { safeTelHref } from '@/utils/safeUrls.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const emit = defineEmits<{
  decided: [message: string]
}>()

const session = useSessionStore()

const requests = ref<JoinRequestView[]>([])
const loading = ref(false)
const demoUnavailable = ref(false)
const loadError = ref<unknown>(null)
const actionError = ref('')
const busy = ref(false)
const pendingAction = ref<{ type: 'confirm' | 'reject'; request: JoinRequestView } | null>(null)
let loadController: AbortController | null = null

function isNotFoundDemoError(err: unknown): boolean {
  const e = err as { status?: number; errorCode?: string; payload?: { error_code?: string } }
  const code = e?.errorCode || e?.payload?.error_code
  return e?.status === 404 && (!code || code === 'NOT_FOUND')
}

async function loadRequests() {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (!session.isSignedIn || session.buildingRole !== 'CHAIRMAN') {
    requests.value = []
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  loadError.value = null
  demoUnavailable.value = false
  try {
    const res = await listJoinRequests({ signal: controller.signal })
    if (loadController === controller) {
      requests.value = res
    }
  } catch (err) {
    const e = err as { errorCode?: string; name?: string }
    if (e?.errorCode === 'REQUEST_ABORTED' || e?.name === 'AbortError') return
    if (loadController === controller) {
      if (isNotFoundDemoError(err)) {
        demoUnavailable.value = true
      } else {
        loadError.value = err
      }
    }
  } finally {
    if (loadController === controller) {
      loading.value = false
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && pendingAction.value && !busy.value) {
    pendingAction.value = null
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown)
  }
  loadRequests()
})

onBeforeUnmount(() => {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    loadRequests()
  },
)

defineExpose({ reload: loadRequests, count: () => requests.value.length })

async function executeDecision() {
  const act = pendingAction.value
  if (!act || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    if (act.type === 'confirm') {
      await confirmJoinRequest(act.request.request_id)
      pendingAction.value = null
      requests.value = requests.value.filter((r) => r.request_id !== act.request.request_id)
      emit('decided', session.t('people.joinRequests.confirmedBanner'))
    } else {
      await rejectJoinRequest(act.request.request_id)
      pendingAction.value = null
      requests.value = requests.value.filter((r) => r.request_id !== act.request.request_id)
      emit('decided', session.t('people.joinRequests.rejectedBanner'))
    }
  } catch (err) {
    pendingAction.value = null
    const e = err as {
      status?: number
      errorCode?: string
      payload?: { error_code?: string; retry_after_seconds?: number }
    }
    const code = e?.errorCode || e?.payload?.error_code
    if (isNotFoundDemoError(err)) {
      demoUnavailable.value = true
    } else if (e?.status === 404 || code === 'JOIN_REQUEST_NOT_FOUND') {
      emit('decided', session.t('people.joinRequests.alreadyDecided'))
      await loadRequests()
    } else if (e?.status === 429 || code === 'RATE_LIMITED') {
      const secs = Number(e?.payload?.retry_after_seconds || 0)
      if (secs > 0) {
        const mins = Math.max(1, Math.ceil(secs / 60))
        actionError.value = session.t('people.bulk.errors.rateLimitedMinutes', { minutes: mins })
      } else {
        actionError.value = session.t('people.bulk.errors.rateLimited')
      }
    } else {
      actionError.value = localizeError((err ?? {}) as Record<string, unknown>)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="space-y-4">
    <div
      v-if="demoUnavailable"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 text-sm text-on-surface-variant"
    >
      {{ session.t('joinCodes.demoUnavailable') }}
    </div>

    <template v-else>
      <div class="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-950">
        {{ session.t('people.joinRequests.verificationHint') }}
      </div>

      <div
        v-if="actionError"
        role="alert"
        class="px-4 py-3 rounded-lg bg-error-container text-on-error-container text-xs font-medium"
      >
        {{ actionError }}
      </div>

      <ErrorCard v-if="loadError" :error="loadError" @retry="loadRequests" />

      <div
        v-else
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs divide-y divide-surface-container"
      >
        <div v-if="loading" class="p-6 text-center text-xs text-on-surface-variant">
          {{ session.t('common.loading') }}
        </div>

        <div v-else-if="requests.length === 0" class="p-6 text-center text-xs text-on-surface-variant">
          {{ session.t('people.joinRequests.empty') }}
        </div>

        <div
          v-for="req in requests"
          :key="req.request_id"
          class="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div class="space-y-1.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2.5 py-0.5 rounded bg-secondary-container text-on-secondary-container text-xs font-bold">
                {{ objectName(req.apartment_kind, req.apartment_number, session.t) }}
              </span>
              <span class="font-headline-md text-sm font-bold text-on-surface">
                {{ req.full_name }}
              </span>
              <span class="text-xs text-on-surface-variant">
                · {{ formatShortDate(req.created_at, session.lang) }}
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-3 text-xs">
              <a
                v-if="safeTelHref(req.phone)"
                :href="safeTelHref(req.phone)!"
                class="font-mono font-semibold text-primary hover:underline inline-flex items-center gap-1"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">call</span>
                <span>{{ formatPhoneDisplay(req.phone) }}</span>
              </a>
              <span v-else class="font-mono text-on-surface">
                {{ formatPhoneDisplay(req.phone) }}
              </span>
              <span class="font-mono text-on-surface-variant">{{ req.email }}</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              class="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold cursor-pointer"
              @click="pendingAction = { type: 'confirm', request: req }"
            >
              {{ session.t('people.joinRequests.confirm') }}
            </button>
            <button
              type="button"
              class="px-3.5 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-xs font-semibold cursor-pointer"
              @click="pendingAction = { type: 'reject', request: req }"
            >
              {{ session.t('people.joinRequests.reject') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Confirm / Reject Modal -->
    <div
      v-if="pendingAction"
      class="fixed inset-0 z-50 bg-scrim/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-2xl bg-surface-container-lowest border border-surface-container p-6 space-y-4 shadow-xl">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{
            pendingAction.type === 'confirm'
              ? session.t('people.joinRequests.confirmModalTitle')
              : session.t('people.joinRequests.rejectModalTitle')
          }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{
            pendingAction.type === 'confirm'
              ? session.t('people.joinRequests.confirmModalBody', {
                  name: pendingAction.request.full_name,
                  object: objectName(
                    pendingAction.request.apartment_kind,
                    pendingAction.request.apartment_number,
                    session.t,
                  ),
                })
              : session.t('people.joinRequests.rejectModalBody', {
                  name: pendingAction.request.full_name,
                  object: objectName(
                    pendingAction.request.apartment_kind,
                    pendingAction.request.apartment_number,
                    session.t,
                  ),
                })
          }}
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            :disabled="busy"
            class="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-semibold cursor-pointer"
            @click="pendingAction = null"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="busy"
            class="px-4 py-2 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-50"
            :class="
              pendingAction.type === 'confirm'
                ? 'bg-primary text-on-primary'
                : 'bg-error text-on-error'
            "
            @click="executeDecision"
          >
            {{
              busy
                ? session.t('common.loading')
                : pendingAction.type === 'confirm'
                  ? session.t('people.joinRequests.confirm')
                  : session.t('people.joinRequests.reject')
            }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
