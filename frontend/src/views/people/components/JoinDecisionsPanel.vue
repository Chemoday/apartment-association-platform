<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { listJoinDecisions } from '@/api/endpoints/join.js'
import type { JoinDecisionView, JoinOutcome } from '@/api/schema.js'
import { formatShortDate } from '@/utils/dates.js'
import { objectName } from '@/utils/objectName.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const PAGE_LIMIT = 20

const props = defineProps<{
  peopleById?: Record<string, string>
}>()

const session = useSessionStore()

const decisions = ref<JoinDecisionView[]>([])
const offset = ref(0)
const loading = ref(false)
const demoUnavailable = ref(false)
const loadError = ref<unknown>(null)
let loadController: AbortController | null = null

const hasPrev = computed(() => offset.value > 0)
const hasNext = computed(() => decisions.value.length === PAGE_LIMIT)

function isNotFoundDemoError(err: unknown): boolean {
  const e = err as { status?: number; errorCode?: string; payload?: { error_code?: string } }
  const code = e?.errorCode || e?.payload?.error_code
  return e?.status === 404 && (!code || code === 'NOT_FOUND')
}

async function loadDecisions() {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (!session.isSignedIn) {
    decisions.value = []
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  loadError.value = null
  demoUnavailable.value = false
  try {
    const res = await listJoinDecisions({
      limit: PAGE_LIMIT,
      offset: offset.value,
      signal: controller.signal,
    })
    if (loadController === controller) {
      decisions.value = res
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

onMounted(loadDecisions)

onBeforeUnmount(() => {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
})

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    offset.value = 0
    loadDecisions()
  },
)

defineExpose({ reload: loadDecisions })

function goPrev() {
  if (!hasPrev.value) return
  offset.value = Math.max(0, offset.value - PAGE_LIMIT)
  loadDecisions()
}

function goNext() {
  if (!hasNext.value) return
  offset.value += PAGE_LIMIT
  loadDecisions()
}

function formatDecisionObject(dec: JoinDecisionView): string {
  if (!dec.apartment_number) return '—'
  return objectName(dec.apartment_kind, dec.apartment_number, session.t)
}

function formatDecider(dec: JoinDecisionView): string {
  if (dec.outcome === 'EXPIRED') {
    return session.t('people.joinDecisions.expiredAfter30Days')
  }
  if (dec.decided_by_user_id && props.peopleById?.[dec.decided_by_user_id]) {
    return props.peopleById[dec.decided_by_user_id]
  }
  return session.t('people.joinDecisions.boardMemberFallback')
}

function outcomeBadgeClass(outcome: JoinOutcome): string {
  if (outcome === 'CONFIRMED') return 'bg-secondary-container text-on-secondary-container'
  if (outcome === 'REJECTED') return 'bg-error-container text-on-error-container'
  return 'bg-surface-container text-on-surface-variant'
}
</script>

<template>
  <section class="space-y-3">
    <div
      v-if="demoUnavailable"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 text-sm text-on-surface-variant"
    >
      {{ session.t('joinCodes.demoUnavailable') }}
    </div>

    <template v-else>
      <p class="text-xs text-on-surface-variant">
        {{ session.t('people.joinDecisions.noPersonalDataNote') }}
      </p>

      <ErrorCard v-if="loadError" :error="loadError" @retry="loadDecisions" />

    <div
      v-else
      class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden"
    >
      <div v-if="loading" class="p-6 text-center text-xs text-on-surface-variant">
        {{ session.t('common.loading') }}
      </div>

      <div v-else-if="decisions.length === 0" class="p-6 text-center text-xs text-on-surface-variant">
        {{ session.t('people.joinDecisions.empty') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-surface-container bg-surface-container-low text-on-surface-variant uppercase text-[10px]">
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.joinDecisions.columns.object') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.joinDecisions.columns.outcome') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.joinDecisions.columns.decidedBy') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.joinDecisions.columns.date') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-container">
            <tr v-for="(dec, idx) in decisions" :key="`${dec.decided_at}-${idx}`">
              <td class="py-3 px-4 font-semibold text-on-surface">
                {{ formatDecisionObject(dec) }}
              </td>
              <td class="py-3 px-4">
                <span
                  class="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold"
                  :class="outcomeBadgeClass(dec.outcome)"
                >
                  {{ session.t(`people.joinDecisions.outcomes.${dec.outcome}`) }}
                </span>
              </td>
              <td class="py-3 px-4 text-on-surface-variant">
                {{ formatDecider(dec) }}
              </td>
              <td class="py-3 px-4 text-on-surface-variant">
                {{ formatShortDate(dec.decided_at, session.lang) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="hasPrev || hasNext"
        class="px-4 py-3 border-t border-surface-container flex items-center justify-end gap-2 bg-surface-container-low text-xs"
      >
        <button
          type="button"
          :disabled="!hasPrev || loading"
          class="px-3 py-1 rounded-lg bg-surface-container text-on-surface font-semibold disabled:opacity-40 cursor-pointer"
          @click="goPrev"
        >
          {{ session.t('common.previous') }}
        </button>
        <button
          type="button"
          :disabled="!hasNext || loading"
          class="px-3 py-1 rounded-lg bg-surface-container text-on-surface font-semibold disabled:opacity-40 cursor-pointer"
          @click="goNext"
        >
          {{ session.t('common.next') }}
        </button>
      </div>
    </div>
    </template>
  </section>
</template>
