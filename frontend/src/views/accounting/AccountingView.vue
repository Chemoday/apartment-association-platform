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
import { localizeError } from '@/locales/index.js'
import PeriodToolbar from '@/views/readings/components/PeriodToolbar.vue'
import MasterMeterKpi from '@/views/readings/components/MasterMeterKpi.vue'
import ReadingsMatrix from '@/views/readings/components/ReadingsMatrix.vue'
import ReadingHistoryModal from '@/views/readings/components/ReadingHistoryModal.vue'
import AccountingBalanceTab from './components/AccountingBalanceTab.vue'
import BuildingConsumptionTab from './components/BuildingConsumptionTab.vue'
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

const periodCode = ref('2026-10')
const periodsList = ref([])
const periodCodes = computed(() =>
  periodsList.value.length > 0
    ? periodsList.value.map((p) => p.period_code)
    : ['2026-10', '2026-09', '2026-08', '2026-07'],
)
const activeTab = ref(resolveTabFromQuery(route?.query?.tab)) // 'matrix' | 'balance' | 'consumption'
const matrix = ref(null)
const loading = ref(true)
const error = ref(null)

const busyAction = ref('')
const actionBanner = ref(null) // { tone: 'success' | 'error', text: string }
const csvSupported = ref(true)

const historyReadingId = ref('')
const historyTitle = ref('')

let loadMatrixSeq = 0
let matrixController = null

function abortMatrixRequest() {
  if (matrixController) {
    matrixController.abort()
    matrixController = null
  }
}

async function loadMatrix() {
  if (!session.actingUserId || !canViewMatrix.value) {
    abortMatrixRequest()
    matrix.value = null
    error.value = null
    loading.value = false
    return
  }
  abortMatrixRequest()
  const controller = new AbortController()
  matrixController = controller
  const seq = ++loadMatrixSeq
  loading.value = true
  error.value = null
  try {
    if (!periodsList.value.length) {
      const fetchedPeriods = await listPeriods({ signal: controller.signal }).catch(() => [])
      if (seq !== loadMatrixSeq || controller.signal.aborted) return
      if (Array.isArray(fetchedPeriods) && fetchedPeriods.length > 0) {
        periodsList.value = fetchedPeriods
        if (!fetchedPeriods.some((p) => p.period_code === periodCode.value)) {
          periodCode.value = fetchedPeriods[0].period_code
        }
      }
    }
    const data = await getPeriodMatrix(periodCode.value, { signal: controller.signal })
    if (seq !== loadMatrixSeq || controller.signal.aborted) return
    matrix.value = data
  } catch (err) {
    if (seq !== loadMatrixSeq || isAbortLikeError(err, controller.signal)) return
    error.value = err
  } finally {
    if (matrixController === controller) {
      matrixController = null
    }
    if (seq === loadMatrixSeq) {
      loading.value = false
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
  loadMatrixSeq += 1
  abortMatrixRequest()
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
  () => {
    matrix.value = null
    actionBanner.value = null
    if (!session.actingUserId || !canViewMatrix.value) {
      abortMatrixRequest()
      error.value = null
      loading.value = false
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

async function handleStatusChange(newStatus) {
  if (busyAction.value) return
  busyAction.value = 'status'
  actionBanner.value = null
  try {
    await changePeriodStatus(periodCode.value, newStatus)
    await loadMatrix()
    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.statusUpdatedBanner', { status: newStatus }),
    }
  } catch (err) {
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    busyAction.value = ''
  }
}

async function handleEstimateMissing() {
  if (busyAction.value) return
  busyAction.value = 'estimate'
  actionBanner.value = null
  try {
    const res = await estimateMissingReadings(periodCode.value)
    await loadMatrix()
    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.estimatedBanner', { count: res.estimated_count }),
    }
  } catch (err) {
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    busyAction.value = ''
  }
}

async function handleExportCsv() {
  if (busyAction.value) return
  busyAction.value = 'csv'
  actionBanner.value = null
  try {
    const response = await exportPeriodCsv(periodCode.value)
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename="?([^";]+)"?/i)
    const filename = match ? match[1] : `readings-${periodCode.value}.csv`

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    actionBanner.value = {
      tone: 'success',
      text: session.t('accounting.csvDownloadedBanner', { filename }),
    }
  } catch (err) {
    if (err.errorCode === 'EXPORTER_NOT_ENABLED') {
      csvSupported.value = false
    }
    actionBanner.value = {
      tone: 'error',
      text: localizeError(err.errorCode, err.payload, session.lang),
    }
  } finally {
    busyAction.value = ''
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
            <span>{{ session.buildingName }} • Reg: {{ session.buildingRegistryCode }}</span>
          </div>
          <h1 class="font-headline-lg text-headline-lg text-on-surface tracking-tight font-bold">
            {{ session.t('accounting.title') }}
          </h1>
          <p v-if="canViewMatrix" class="text-on-surface-variant font-body-sm text-body-sm">
            <template v-if="activeTab !== 'consumption'">
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
            v-if="csvSupported"
            type="button"
            class="flex items-center gap-2 px-space-md py-2.5 border-b-2 border-transparent text-on-surface-variant hover:text-on-surface font-label-lg text-label-lg whitespace-nowrap transition-colors"
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
        :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
        :periods="periodCodes"
        :missing-count="missingCount"
        :busy-action="busyAction"
        :csv-supported="csvSupported"
        @change-period="(code) => (periodCode = code)"
        @change-status="handleStatusChange"
        @estimate-missing="handleEstimateMissing"
        @export-csv="handleExportCsv"
      />

      <!-- Action Feedback Banner -->
      <div
        v-if="actionBanner"
        role="status"
        class="mb-space-md p-3 rounded-xl font-label-md text-xs font-semibold flex items-center justify-between"
        :class="
          actionBanner.tone === 'error'
            ? 'bg-error-container text-on-error-container'
            : 'bg-secondary-container/50 text-on-secondary-container'
        "
      >
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px]">
            {{ actionBanner.tone === 'error' ? 'error' : 'check_circle' }}
          </span>
          <span>{{ actionBanner.text }}</span>
        </div>
        <button type="button" class="underline text-xs" @click="actionBanner = null">
          {{ session.t('common.dismiss') }}
        </button>
      </div>

      <ErrorCard v-if="error" :error="error" @retry="loadMatrix" />

      <div v-else-if="loading" class="py-8">
        <BaseSkeleton :lines="6" />
      </div>

      <template v-else-if="matrix">
        <!-- 4 KPI Strip + Master Meter Submission Modal -->
        <MasterMeterKpi
          :balances="balances"
          :master-meters="masterMeters"
          :apartments="apartments"
          :period-code="periodCode"
          :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
          @master-saved="loadMatrix"
          @open-history="openHistory"
        />

        <!-- Tab 1: Readings Matrix Table -->
        <ReadingsMatrix
          v-if="activeTab === 'matrix'"
          :apartments="apartments"
          :period-code="periodCode"
          :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
          @open-history="openHistory"
          @reading-updated="loadMatrix"
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
