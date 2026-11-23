<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { isAbortLikeError } from '@/composables/useApartmentConsumption.js'
import {
  changePeriodStatus,
  estimateMissingReadings,
  exportPeriodCsv,
  getPeriodMatrix,
  listPeriods,
} from '@/api/endpoints/meters.js'
import { formatPeriodLabel } from '@/utils/dates.js'
import { resolveSkippedMetersWithoutStart } from '@/utils/matrixStarts.js'
import { localizeError } from '@/locales/index.js'
import PeriodToolbar from '@/views/readings/components/PeriodToolbar.vue'
import MasterMeterKpi from '@/views/readings/components/MasterMeterKpi.vue'
import ReadingsMatrix from '@/views/readings/components/ReadingsMatrix.vue'
import ReadingHistoryModal from '@/views/readings/components/ReadingHistoryModal.vue'
import AccountingBalanceTab from './components/AccountingBalanceTab.vue'
import BuildingConsumptionTab from './components/BuildingConsumptionTab.vue'
import BaseEmptyState from '@/components/base/BaseEmptyState.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import StatusChip from '@/components/domain/StatusChip.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canViewMatrix } = useRole()

function resolveTabFromQuery(rawTab) {
  if (rawTab === 'consumption') return 'consumption'
  if (rawTab === 'balance') return 'balance'
  return 'matrix'
}

const periodCode = ref('')
const periodsList = ref([])
const periodsLoaded = ref(false)
const periodCodes = computed(() => periodsList.value.map((p) => p.period_code))
const activeTab = ref(resolveTabFromQuery(route?.query?.tab)) // 'matrix' | 'balance' | 'consumption'
const matrix = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref(null)

const busyAction = ref('')
const actionBanner = ref(null) // { tone: 'success' | 'error', text: string, skippedItems?: Array }
const csvSupported = ref(true)

const historyReadingId = ref('')
const historyTitle = ref('')

let isUnmounted = false
let loadMatrixSeq = 0
let actionSeq = 0
let matrixController = null
let csvController = null
let suppressPeriodWatch = false

function abortMatrixRequest() {
  if (matrixController) {
    matrixController.abort()
    matrixController = null
  }
}

function abortCsvRequest() {
  if (csvController) {
    csvController.abort()
    csvController = null
  }
}

async function loadMatrix({ silent = false } = {}) {
  if (!session.actingUserId || !canViewMatrix.value) {
    abortMatrixRequest()
    matrix.value = null
    error.value = null
    loading.value = false
    refreshing.value = false
    return
  }
  abortMatrixRequest()
  const controller = new AbortController()
  matrixController = controller
  const seq = ++loadMatrixSeq
  const keepMounted = Boolean(silent && matrix.value)
  if (keepMounted) {
    refreshing.value = true
  } else {
    loading.value = true
  }
  error.value = null
  try {
    if (!periodsLoaded.value) {
      const fetchedPeriods = await listPeriods({ signal: controller.signal })
      if (isUnmounted || seq !== loadMatrixSeq || controller.signal.aborted) return
      periodsLoaded.value = true
      periodsList.value = Array.isArray(fetchedPeriods) ? fetchedPeriods : []
      if (periodsList.value.length === 0) {
        matrix.value = null
        if (periodCode.value !== '') {
          suppressPeriodWatch = true
          periodCode.value = ''
        }
        return
      }
      if (!periodsList.value.some((p) => p.period_code === periodCode.value)) {
        suppressPeriodWatch = true
        periodCode.value = periodsList.value[0].period_code
      }
    }
    if (!periodCode.value) {
      matrix.value = null
      return
    }
    const data = await getPeriodMatrix(periodCode.value, { signal: controller.signal })
    if (isUnmounted || seq !== loadMatrixSeq || controller.signal.aborted) return
    matrix.value = data
  } catch (err) {
    if (isUnmounted || seq !== loadMatrixSeq || isAbortLikeError(err, controller.signal)) return
    error.value = err
  } finally {
    if (matrixController === controller) {
      matrixController = null
    }
    if (!isUnmounted && seq === loadMatrixSeq) {
      loading.value = false
      refreshing.value = false
    }
  }
}

onMounted(() => {
  if (canViewMatrix.value && activeTab.value !== 'consumption') {
    loadMatrix()
  } else {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
  loadMatrixSeq += 1
  actionSeq += 1
  abortMatrixRequest()
  abortCsvRequest()
})

watch(
  () => route?.query?.tab,
  (newTab) => {
    const resolved = resolveTabFromQuery(newTab)
    if (resolved !== activeTab.value) {
      activeTab.value = resolved
      if (resolved === 'consumption') {
        abortMatrixRequest()
        loading.value = false
        refreshing.value = false
      } else if (canViewMatrix.value && !matrix.value) {
        loadMatrix()
      }
    }
  },
)

function selectTab(nextTab) {
  if (!canViewMatrix.value) return
  activeTab.value = nextTab
  if (nextTab === 'consumption') {
    abortMatrixRequest()
    loading.value = false
    refreshing.value = false
  } else if (!matrix.value) {
    loadMatrix()
  }
  const targetQuery = nextTab === 'matrix' ? {} : { tab: nextTab }
  if (typeof router?.replace === 'function') {
    router.replace({ name: 'accounting', query: targetQuery }).catch(() => {})
  }
}

watch(
  () => [session.actingUserId, session.sessionRevision, session.buildingRole, periodCode.value],
  ([newUser, newRev, newRole], oldTuple) => {
    const oldUser = oldTuple?.[0]
    const oldRev = oldTuple?.[1]
    const oldRole = oldTuple?.[2]
    const sessionChanged = newUser !== oldUser || newRev !== oldRev || newRole !== oldRole

    if (!sessionChanged && suppressPeriodWatch) {
      suppressPeriodWatch = false
      return
    }
    suppressPeriodWatch = false

    actionSeq += 1
    busyAction.value = ''
    abortCsvRequest()
    actionBanner.value = null
    matrix.value = null

    if (sessionChanged) {
      periodsList.value = []
      periodsLoaded.value = false
      if (periodCode.value !== '') {
        suppressPeriodWatch = true
        periodCode.value = ''
      }
    }

    if (!session.actingUserId || !canViewMatrix.value) {
      abortMatrixRequest()
      error.value = null
      loading.value = false
      refreshing.value = false
      return
    }
    if (activeTab.value !== 'consumption') {
      loadMatrix()
    }
  },
)

const apartments = computed(() => matrix.value?.apartments || [])
const balances = computed(() => matrix.value?.balances || [])
const masterMeters = computed(() => matrix.value?.master_meters || [])
const period = computed(() => matrix.value?.period || null)

const missingCount = computed(
  () => apartments.value.filter((a) => a.status === 'MISSING').length,
)

const reportedUnitsCount = computed(
  () => apartments.value.filter((a) => a.status !== 'MISSING').length,
)

function captureActionContext() {
  const mySeq = ++actionSeq
  const reqPeriod = periodCode.value
  const reqUser = session.actingUserId
  const reqRev = session.sessionRevision
  const reqRole = session.buildingRole
  return {
    mySeq,
    reqPeriod,
    isStale: () =>
      isUnmounted ||
      mySeq !== actionSeq ||
      periodCode.value !== reqPeriod ||
      session.actingUserId !== reqUser ||
      session.sessionRevision !== reqRev ||
      session.buildingRole !== reqRole ||
      !canViewMatrix.value,
  }
}

async function handleStatusChange(newStatus) {
  if (busyAction.value || loading.value || !period.value || !periodCode.value) return
  const ctx = captureActionContext()
  busyAction.value = 'status'
  actionBanner.value = null
  try {
    await changePeriodStatus(ctx.reqPeriod, newStatus)
    if (ctx.isStale()) return
    await loadMatrix({ silent: true })
    if (ctx.isStale()) return
    const statusKey = `status.${newStatus}`
    const translatedStatus = session.t(statusKey)
    const statusLabel = translatedStatus && translatedStatus !== statusKey ? translatedStatus : newStatus
    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.statusUpdatedBanner', { status: statusLabel }),
    }
  } catch (err) {
    if (ctx.isStale()) return
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    if (!isUnmounted && ctx.mySeq === actionSeq) {
      busyAction.value = ''
    }
  }
}

function formatSkippedMeterLine(item) {
  if (item.apartment_number && item.resource_type) {
    const resourceKey = `resources.${item.resource_type}`
    const translated = session.t(resourceKey)
    const resourceLabel = translated && translated !== resourceKey ? translated : item.resource_type
    if (item.location_label) {
      return session.t('accounting.estimateSkippedItemWithLocation', {
        apartment: item.apartment_number,
        resource: resourceLabel,
        location: item.location_label,
      })
    }
    return session.t('accounting.estimateSkippedItem', {
      apartment: item.apartment_number,
      resource: resourceLabel,
    })
  }
  return session.t('accounting.estimateSkippedFallback', { meterId: item.meter_id })
}

async function handleEstimateMissing() {
  if (busyAction.value || loading.value || !period.value || !periodCode.value) return
  const ctx = captureActionContext()
  busyAction.value = 'estimate'
  actionBanner.value = null
  const apartmentsSnapshot = matrix.value?.apartments || []
  try {
    const res = await estimateMissingReadings(ctx.reqPeriod)
    if (ctx.isStale()) return
    await loadMatrix({ silent: true })
    if (ctx.isStale()) return
    const lookupApartments = matrix.value?.apartments?.length
      ? matrix.value.apartments
      : apartmentsSnapshot
    const skippedItems = resolveSkippedMetersWithoutStart(
      res.skipped_without_start,
      lookupApartments,
    )
    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.estimatedBanner', { count: res.estimated_count }),
      skippedItems,
    }
  } catch (err) {
    if (ctx.isStale()) return
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    if (!isUnmounted && ctx.mySeq === actionSeq) {
      busyAction.value = ''
    }
  }
}

async function handleExportCsv() {
  if (busyAction.value || loading.value || !periodCode.value) return
  const ctx = captureActionContext()
  abortCsvRequest()
  const controller = new AbortController()
  csvController = controller
  busyAction.value = 'csv'
  actionBanner.value = null
  try {
    const response = await exportPeriodCsv(ctx.reqPeriod, { signal: controller.signal })
    if (ctx.isStale() || controller.signal.aborted) return
    const blob = await response.blob()
    if (ctx.isStale() || controller.signal.aborted) return
    const disposition = response.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename="?([^";]+)"?/i)
    const filename = match ? match[1] : `readings-${ctx.reqPeriod}.csv`

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    try {
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link)
      }
      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 1000)
    }

    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.csvDownloadedBanner', { filename }),
    }
  } catch (err) {
    if (ctx.isStale() || isAbortLikeError(err, controller.signal)) return
    if (err.errorCode === 'EXPORTER_NOT_ENABLED') {
      csvSupported.value = false
    }
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    if (csvController === controller) {
      csvController = null
    }
    if (!isUnmounted && ctx.mySeq === actionSeq) {
      busyAction.value = ''
    }
  }
}

function openHistory(readingId, label) {
  historyReadingId.value = readingId
  historyTitle.value = label
}
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-lg">
    <!-- Header & Context Area matching chairman_view_streamlined_meter_matrix_accounting -->
    <div class="flex flex-col gap-space-md mb-space-lg">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm pb-1">
        <div class="flex flex-col gap-0.5">
          <div class="flex items-center gap-space-xs text-on-surface-variant font-label-md text-[11px] tracking-wider uppercase font-medium">
            <span>{{ session.t('accounting.breadcrumb') }}</span>
            <span>/</span>
            <span>
              {{ session.buildingName }}
              <template v-if="session.buildingRegistryCode">
                • Reg: {{ session.buildingRegistryCode }}
              </template>
            </span>
          </div>
          <h1 class="font-headline-lg text-headline-lg text-on-surface tracking-tight font-bold">
            {{ session.t('accounting.title') }}
          </h1>
          <p v-if="canViewMatrix" class="text-on-surface-variant font-body-sm text-body-sm">
            <template v-if="activeTab !== 'consumption' && periodCode">
              {{ session.t('accounting.billingPeriod') }}
              {{ formatPeriodLabel(periodCode, session.lang) }}
              <template v-if="apartments.length || session.knownBuildingApartmentsCount !== null">
                • {{ apartments.length || session.knownBuildingApartmentsCount }} {{ session.t('accounting.unitsTotal') }}
              </template>
            </template>
            <template v-else-if="session.knownBuildingApartmentsCount !== null">
              {{ session.knownBuildingApartmentsCount }} {{ session.t('accounting.unitsTotal') }}
            </template>
          </p>
        </div>

        <div v-if="canViewMatrix && period && activeTab !== 'consumption'" class="flex items-center gap-space-sm self-start sm:self-auto">
          <StatusChip :status="period.status" />
        </div>
      </div>

      <!-- Sub-Nav Bar (visible to CHAIRMAN, BOARD, ACCOUNTANT only) -->
      <div v-if="canViewMatrix" class="border-b border-surface-container-high">
        <nav aria-label="Accounting Views" class="flex items-center gap-space-xs overflow-x-auto pb-px">
          <button
            type="button"
            data-testid="accounting-tab-matrix"
            class="flex items-center gap-2 px-space-md py-2.5 border-b-2 font-label-lg text-label-lg whitespace-nowrap rounded-t-lg transition-colors"
            :class="
              activeTab === 'matrix'
                ? 'border-primary text-on-surface bg-surface-container-lowest/50 font-bold'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            "
            @click="selectTab('matrix')"
          >
            <span class="material-symbols-outlined text-[19px]">table_view</span>
            <span>{{ session.t('accounting.tabMatrix') }}</span>
            <span
              v-if="apartments.length > 0"
              class="px-2 py-0.5 rounded-full bg-secondary/15 text-secondary text-label-md font-semibold font-mono tabular-nums"
            >
              {{ reportedUnitsCount }}/{{ apartments.length }}
            </span>
          </button>

          <button
            type="button"
            data-testid="accounting-tab-balance"
            class="flex items-center gap-2 px-space-md py-2.5 border-b-2 font-label-lg text-label-lg whitespace-nowrap rounded-t-lg transition-colors"
            :class="
              activeTab === 'balance'
                ? 'border-primary text-on-surface bg-surface-container-lowest/50 font-bold'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            "
            @click="selectTab('balance')"
          >
            <span class="material-symbols-outlined text-[19px]">balance</span>
            <span>{{ session.t('accounting.tabBalance') }}</span>
          </button>

          <button
            type="button"
            data-testid="accounting-tab-consumption"
            class="flex items-center gap-2 px-space-md py-2.5 border-b-2 font-label-lg text-label-lg whitespace-nowrap rounded-t-lg transition-colors"
            :class="
              activeTab === 'consumption'
                ? 'border-primary text-on-surface bg-surface-container-lowest/50 font-bold'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            "
            @click="selectTab('consumption')"
          >
            <span class="material-symbols-outlined text-[19px]">monitoring</span>
            <span>{{ session.t('accounting.tabConsumption') }}</span>
          </button>

          <button
            v-if="csvSupported && activeTab !== 'consumption'"
            type="button"
            :disabled="Boolean(busyAction) || loading || !periodCode"
            class="flex items-center gap-2 px-space-md py-2.5 border-b-2 border-transparent text-on-surface-variant hover:text-on-surface font-label-lg text-label-lg whitespace-nowrap transition-colors disabled:opacity-50"
            @click="handleExportCsv"
          >
            <span class="material-symbols-outlined text-[19px]">file_download</span>
            <span>{{ session.t('accounting.exportCsvTab') }}</span>
          </button>
        </nav>
      </div>
    </div>

    <!-- Fail-closed 403 panel when non-staff reaches AccountingView directly -->
    <div
      v-if="!canViewMatrix"
      data-testid="accounting-forbidden"
      role="alert"
      class="bg-surface-container-lowest border border-error/30 rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-3 shadow-xs"
    >
      <div class="w-11 h-11 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto">
        <span class="material-symbols-outlined text-[22px]">lock</span>
      </div>
      <h2 class="font-title-md text-title-md font-bold text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h2>
      <p class="font-body-sm text-body-sm text-on-surface-variant">
        {{ session.t('errors.FORBIDDEN') }}
      </p>
      <p class="font-label-md text-xs text-on-surface-variant font-medium">
        {{ session.t('buildingConsumption.staffOnlyAccess') }}
      </p>
    </div>

    <!-- Multi-month Building Consumption & Averages (#031) -->
    <BuildingConsumptionTab
      v-else-if="activeTab === 'consumption'"
      :known-apartments-count="session.knownBuildingApartmentsCount"
    />

    <!-- Single-Period Matrix & Balance -->
    <template v-else>
      <PeriodToolbar
        v-if="canViewMatrix"
        class="mb-space-md"
        :period-code="periodCode"
        :period-status="period?.status || ''"
        :periods="periodCodes"
        :missing-count="missingCount"
        :busy-action="busyAction"
        :loading="loading || !period"
        :csv-supported="csvSupported"
        @change-period="(code) => (periodCode = code)"
        @change-status="handleStatusChange"
        @estimate-missing="handleEstimateMissing"
        @export-csv="handleExportCsv"
      />

      <!-- Action Feedback Banner -->
      <div
        v-if="actionBanner"
        data-testid="accounting-action-banner"
        role="status"
        class="mb-space-md p-3 rounded-xl font-label-md text-xs font-semibold flex flex-col gap-2"
        :class="
          actionBanner.tone === 'error'
            ? 'bg-error-container text-on-error-container'
            : 'bg-secondary-container/50 text-on-secondary-container'
        "
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px] shrink-0">
              {{ actionBanner.tone === 'error' ? 'error' : 'check_circle' }}
            </span>
            <span>{{ actionBanner.text }}</span>
          </div>
          <button type="button" class="underline text-xs shrink-0" @click="actionBanner = null">
            {{ session.t('common.dismiss') }}
          </button>
        </div>

        <div
          v-if="actionBanner.skippedItems?.length"
          data-testid="estimate-skipped-list"
          class="pl-6 pt-1.5 border-t border-current/15 font-normal space-y-1"
        >
          <div class="flex items-center gap-1.5 font-semibold">
            <span class="material-symbols-outlined text-[15px] shrink-0">flag</span>
            <span>
              {{ session.t('accounting.estimateSkippedHeading', { count: actionBanner.skippedItems.length }) }}
            </span>
          </div>
          <ul class="list-disc pl-5 space-y-0.5">
            <li v-for="item in actionBanner.skippedItems" :key="item.meter_id">
              {{ formatSkippedMeterLine(item) }}
            </li>
          </ul>
        </div>
      </div>

      <ErrorCard v-if="error" :error="error" @retry="() => loadMatrix()" />

      <div v-else-if="loading" class="py-8">
        <BaseSkeleton :lines="6" />
      </div>

      <div
        v-else-if="periodsLoaded && periodCodes.length === 0"
        data-testid="accounting-no-periods"
        class="py-6"
      >
        <BaseEmptyState
          icon="calendar_month"
          :title="session.t('accounting.noPeriodsTitle')"
          :description="session.t('accounting.noPeriodsDesc')"
        />
      </div>

      <template v-else-if="matrix">
        <!-- 4 KPI Strip + Master Meter Submission Modal -->
        <MasterMeterKpi
          :balances="balances"
          :master-meters="masterMeters"
          :apartments="apartments"
          :period-code="periodCode"
          :period-status="period?.status || ''"
          @master-saved="() => loadMatrix({ silent: true })"
          @open-history="openHistory"
        />

        <!-- Tab 1: Readings Matrix Table -->
        <ReadingsMatrix
          v-if="activeTab === 'matrix'"
          :apartments="apartments"
          :period-code="periodCode"
          :period-status="period?.status || ''"
          @open-history="openHistory"
          @reading-updated="() => loadMatrix({ silent: true })"
        />

        <!-- Tab 2: Building Balance & Phase 2 Demo Preview -->
        <AccountingBalanceTab
          v-else
          :balances="balances"
          :master-meters="masterMeters"
          :period-code="periodCode"
        />
      </template>
    </template>

    <!-- Audit History Modal -->
    <ReadingHistoryModal
      :reading-id="historyReadingId"
      :title-label="historyTitle"
      @close="historyReadingId = ''"
    />
  </div>
</template>
