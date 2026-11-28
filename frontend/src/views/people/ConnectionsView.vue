<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  getConnectionOverview,
  setApartmentPaperStatus,
} from '@/api/endpoints/connections.js'
import type {
  ConnectionItem,
  ConnectionOverview,
  ConnectionStatus,
} from '@/api/schema.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import {
  CONNECTION_STATUSES,
  getPresentKindSummaries,
} from '@/utils/connections.js'
import { objectKindPluralLabel, objectName } from '@/utils/objectName.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const PAGE_LIMIT = 50

const router = useRouter()
const session = useSessionStore()

const overview = ref<ConnectionOverview | null>(null)
const selectedStatus = ref<ConnectionStatus | ''>('')
const offset = ref(0)
const loading = ref(false)
const loadError = ref<unknown>(null)
const paperBusyId = ref<string | null>(null)
const actionError = ref('')
let loadController: AbortController | null = null

const presentKinds = computed(() => getPresentKindSummaries(overview.value?.summary?.by_kind))

const connectedPercent = computed(() => {
  const total = overview.value?.summary?.apartments ?? 0
  const connected = overview.value?.summary?.connected ?? 0
  if (total <= 0) return 0
  return Math.round((connected / total) * 100)
})

const hasPrevPage = computed(() => offset.value > 0)
const hasNextPage = computed(() => {
  const matching = overview.value?.matching ?? 0
  return offset.value + PAGE_LIMIT < matching
})

async function loadOverview() {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (!session.isSignedIn) {
    overview.value = null
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  loadError.value = null
  actionError.value = ''
  try {
    const res = await getConnectionOverview({
      status: selectedStatus.value || undefined,
      limit: PAGE_LIMIT,
      offset: offset.value,
      signal: controller.signal,
    })
    if (loadController === controller) {
      overview.value = res
    }
  } catch (err) {
    const e = err as { errorCode?: string; name?: string }
    if (e?.errorCode === 'REQUEST_ABORTED' || e?.name === 'AbortError') return
    if (loadController === controller) {
      loadError.value = err
    }
  } finally {
    if (loadController === controller) {
      loading.value = false
    }
  }
}

onMounted(loadOverview)

onBeforeUnmount(() => {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
})

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    loadOverview()
  },
)

function selectStatus(status: ConnectionStatus | '') {
  selectedStatus.value = status
  offset.value = 0
  loadOverview()
}

function goPrevPage() {
  if (!hasPrevPage.value) return
  offset.value = Math.max(0, offset.value - PAGE_LIMIT)
  loadOverview()
}

function goNextPage() {
  if (!hasNextPage.value) return
  offset.value += PAGE_LIMIT
  loadOverview()
}

async function togglePaper(item: ConnectionItem) {
  if (paperBusyId.value) return
  paperBusyId.value = item.apartment_id
  actionError.value = ''
  try {
    const updated = await setApartmentPaperStatus(item.apartment_id, !item.on_paper)
    if (overview.value) {
      const idx = overview.value.items.findIndex((i) => i.apartment_id === item.apartment_id)
      if (idx !== -1) {
        overview.value.items[idx] = updated
      }
    }
    await loadOverview()
  } catch (err) {
    actionError.value = localizeError((err ?? {}) as Record<string, unknown>)
  } finally {
    paperBusyId.value = null
  }
}

function openInviteForItem(item: ConnectionItem) {
  router.push({
    name: 'people',
    query: {
      tab: 'invitations',
      inviteApartment: item.apartment_number,
      inviteKind: item.apartment_kind,
    },
  })
}

function openJoinCodeForItem(item: ConnectionItem) {
  router.push({
    name: 'join-codes',
    query: { apartmentId: item.apartment_id },
  })
}

function openJoinRequests() {
  router.push({
    name: 'people',
    query: { tab: 'join-requests' },
  })
}

function statusBadgeClass(status: ConnectionStatus): string {
  switch (status) {
    case 'CONNECTED':
      return 'bg-secondary-container text-on-secondary-container'
    case 'JOIN_REQUEST':
      return 'bg-primary-container text-on-primary-container'
    case 'INVITED':
    case 'CODE_ISSUED':
      return 'bg-amber-100 text-amber-900'
    case 'EXPIRED':
      return 'bg-error-container text-on-error-container'
    default:
      return 'bg-surface-container text-on-surface-variant'
  }
}
</script>

<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h1 class="font-headline-lg text-2xl font-extrabold text-on-surface tracking-tight">
          {{ session.t('connections.title') }}
        </h1>
        <p class="font-body-md text-sm text-on-surface-variant mt-1">
          {{ session.t('connections.subtitle') }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="px-3.5 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
          @click="router.push({ name: 'bulk-invitations' })"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">upload_file</span>
          <span>{{ session.t('people.bulk.openButton') }}</span>
        </button>
        <button
          type="button"
          class="px-3.5 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold inline-flex items-center gap-1.5 hover:opacity-95 cursor-pointer"
          @click="router.push({ name: 'join-codes' })"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">qr_code_2</span>
          <span>{{ session.t('connections.issueAllCodes') }}</span>
        </button>
      </div>
    </header>

    <ErrorCard v-if="loadError" :error="loadError" @retry="loadOverview" />

    <template v-else-if="overview">
      <!-- Top Summary Card -->
      <section
        class="rounded-xl bg-surface-container-lowest border border-surface-container p-5 space-y-4 shadow-xs"
      >
        <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p class="text-lg font-headline-md font-extrabold text-on-surface">
              {{
                session.t('connections.connectedProgress', {
                  connected: overview.summary.connected,
                  total: overview.summary.apartments,
                })
              }}
            </p>
            <p class="text-xs text-on-surface-variant mt-0.5">
              {{ session.t('connections.noPersonalDataNote') }}
            </p>
          </div>
          <span class="text-sm font-mono font-bold text-primary">{{ connectedPercent }}%</span>
        </div>

        <div
          class="h-2.5 w-full rounded-full bg-surface-container overflow-hidden"
          role="progressbar"
          :aria-valuenow="connectedPercent"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="h-full bg-primary transition-all duration-300"
            :style="{ width: `${connectedPercent}%` }"
          ></div>
        </div>

        <!-- Per-Kind Summary (#069) -->
        <div v-if="presentKinds.length > 0" class="flex flex-wrap items-center gap-2.5 pt-1">
          <div
            v-for="entry in presentKinds"
            :key="entry.kind"
            class="px-3 py-1.5 rounded-lg bg-surface-container-low border border-surface-container text-xs flex items-center gap-2"
          >
            <span class="font-semibold text-on-surface">
              {{ objectKindPluralLabel(entry.kind, session.t) }}
            </span>
            <span class="font-mono text-on-surface-variant">
              {{ entry.connected }} / {{ entry.objects }}
            </span>
          </div>
        </div>

        <!-- Status Filter Chips -->
        <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-surface-container">
          <button
            type="button"
            class="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer"
            :class="
              selectedStatus === ''
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-low text-on-surface-variant hover:text-on-surface'
            "
            @click="selectStatus('')"
          >
            {{ session.t('connections.all') }} ({{ overview.summary.apartments }})
          </button>

          <button
            v-for="st in CONNECTION_STATUSES"
            :key="st"
            type="button"
            class="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer"
            :class="
              selectedStatus === st
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-low text-on-surface-variant hover:text-on-surface'
            "
            @click="selectStatus(st)"
          >
            {{ session.t(`connections.statuses.${st}`) }} ({{ overview.summary.by_status[st] ?? 0 }})
          </button>
        </div>
      </section>

      <div
        v-if="actionError"
        role="alert"
        class="px-4 py-3 rounded-lg bg-error-container text-on-error-container text-xs font-medium"
      >
        {{ actionError }}
      </div>

      <!-- Connections Table -->
      <section
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden"
      >
        <div v-if="overview.items.length === 0" class="p-8 text-center text-xs text-on-surface-variant">
          {{ session.t('connections.empty') }}
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-container bg-surface-container-low text-on-surface-variant uppercase text-[10px]">
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.object') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.entrance') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.status') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.people') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.lastInvited') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('connections.columns.onPaper') }}</th>
                <th class="py-2.5 px-4 font-bold text-right">{{ session.t('connections.columns.actions') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-container">
              <tr v-for="item in overview.items" :key="item.apartment_id">
                <td class="py-3 px-4 font-semibold text-on-surface">
                  {{ objectName(item.apartment_kind, item.apartment_number, session.t) }}
                </td>
                <td class="py-3 px-4 text-on-surface-variant">
                  {{ item.entrance != null ? item.entrance : '—' }}
                </td>
                <td class="py-3 px-4">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span
                      class="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold"
                      :class="statusBadgeClass(item.status)"
                    >
                      {{ session.t(`connections.statuses.${item.status}`) }}
                    </span>
                    <span
                      v-if="item.invitation_delivery === 'QUEUED'"
                      class="inline-flex px-2 py-0.5 rounded bg-surface-container text-on-surface-variant text-[10px] font-medium"
                    >
                      {{ session.t('connections.waitingToBeSent') }}
                    </span>
                  </div>
                </td>
                <td class="py-3 px-4 text-on-surface-variant font-mono">
                  {{
                    session.t('connections.ownersTenantsCount', {
                      owners: item.owners,
                      tenants: item.tenants,
                    })
                  }}
                </td>
                <td class="py-3 px-4 text-on-surface-variant">
                  {{ item.last_invited_at ? formatShortDate(item.last_invited_at, session.lang) : '—' }}
                </td>
                <td class="py-3 px-4">
                  <label class="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      :checked="item.on_paper"
                      :disabled="Boolean(paperBusyId)"
                      class="accent-primary w-4 h-4 cursor-pointer"
                      @change="togglePaper(item)"
                    />
                    <span class="text-[11px] text-on-surface-variant">
                      {{ session.t('connections.onPaperLabel') }}
                    </span>
                  </label>
                </td>
                <td class="py-3 px-4 text-right">
                  <div class="inline-flex flex-wrap items-center justify-end gap-1.5">
                    <template v-if="item.status === 'NOT_INVITED' || item.status === 'EXPIRED'">
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-[11px] font-semibold cursor-pointer"
                        @click="openInviteForItem(item)"
                      >
                        {{ session.t('connections.actions.inviteEmail') }}
                      </button>
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg bg-secondary-container text-on-secondary-container text-[11px] font-semibold cursor-pointer"
                        @click="openJoinCodeForItem(item)"
                      >
                        {{ session.t('connections.actions.codeOnPaper') }}
                      </button>
                    </template>
                    <button
                      v-else-if="item.status === 'JOIN_REQUEST'"
                      type="button"
                      class="px-2.5 py-1 rounded-lg bg-primary text-on-primary text-[11px] font-semibold cursor-pointer"
                      @click="openJoinRequests"
                    >
                      {{ session.t('connections.actions.seeRequest') }}
                    </button>
                    <span v-else class="text-on-surface-variant">—</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div
          v-if="overview.matching > PAGE_LIMIT"
          class="px-4 py-3 border-t border-surface-container flex items-center justify-between text-xs text-on-surface-variant bg-surface-container-low"
        >
          <span>
            {{
              session.t('connections.pagingSummary', {
                from: offset + 1,
                to: Math.min(offset + overview.items.length, overview.matching),
                total: overview.matching,
              })
            }}
          </span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              :disabled="!hasPrevPage || loading"
              class="px-3 py-1 rounded-lg bg-surface-container text-on-surface font-semibold disabled:opacity-40 cursor-pointer"
              @click="goPrevPage"
            >
              {{ session.t('common.previous') }}
            </button>
            <button
              type="button"
              :disabled="!hasNextPage || loading"
              class="px-3 py-1 rounded-lg bg-surface-container text-on-surface font-semibold disabled:opacity-40 cursor-pointer"
              @click="goNextPage"
            >
              {{ session.t('common.next') }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <div v-else-if="loading" class="p-8 text-center text-xs text-on-surface-variant">
      {{ session.t('common.loading') }}
    </div>
  </div>
</template>
