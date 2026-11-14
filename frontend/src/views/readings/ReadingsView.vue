<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { useApartmentConsumption } from '@/composables/useApartmentConsumption.js'
import { getMyDashboard, listPeriods } from '@/api/endpoints/meters.js'
import {
  compareMeterValues,
  formatSignedDelta,
  subtractMeterValues,
  sumMeterValues,
} from '@/utils/meterValue.js'
import { formatDate, formatMonthName, formatPeriodLabel } from '@/utils/dates.js'
import MeterCard from './components/MeterCard.vue'
import ReadingHistoryModal from './components/ReadingHistoryModal.vue'
import ConsumptionChart from '@/components/domain/ConsumptionChart.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import BaseEmptyState from '@/components/base/BaseEmptyState.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import StatusChip from '@/components/domain/StatusChip.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canViewMatrix } = useRole()

const periodCode = ref(typeof route.query?.period === 'string' ? route.query.period : '')
const periodsList = ref([])
const periods = computed(() =>
  periodsList.value.length > 0
    ? periodsList.value.map((p) => p.period_code)
    : ['2026-11', '2026-10', '2026-09', '2026-08', '2026-07'],
)

const dashboard = ref(null)
const loading = ref(true)
const error = ref(null)

// Track live draft deltas per meter_id for the right-side Total Consumption calculator
const draftDeltas = ref({})
const wrongPeriodDrafts = ref({})
const meterCardRefs = ref([])
const submitBannerMessage = ref('')
const wrongPeriodBanner = ref('')

// History modal state
const historyReadingId = ref('')
const historyTitle = ref('')

let loadDashboardSeq = 0

async function loadDashboard({ quiet = false } = {}) {
  if (!session.actingUserId) return
  const seq = ++loadDashboardSeq
  if (!quiet) {
    loading.value = true
    submitBannerMessage.value = ''
    wrongPeriodBanner.value = ''
  }
  error.value = null
  try {
    if (!periodsList.value.length || quiet) {
      const pList = await listPeriods().catch(() => [])
      if (seq !== loadDashboardSeq) return
      if (Array.isArray(pList) && pList.length > 0) {
        periodsList.value = pList
      }
    }
    if (
      typeof route.query?.period === 'string' &&
      periods.value.includes(route.query.period)
    ) {
      periodCode.value = route.query.period
    } else if (periodCode.value && !periods.value.includes(periodCode.value)) {
      periodCode.value = ''
    }
    const res = await getMyDashboard(periodCode.value || null)
    if (seq !== loadDashboardSeq) return
    dashboard.value = res
    if (!periodCode.value && res.period?.period_code) {
      periodCode.value = res.period.period_code
    }
    if (!quiet) {
      draftDeltas.value = {}
    }
    if (res.apartments?.length) {
      const exists = res.apartments.some((a) => a.apartment_id === session.selectedApartmentId)
      if (!exists) {
        session.selectApartment(res.apartments[0].apartment_id)
      }
    }
  } catch (err) {
    if (seq !== loadDashboardSeq) return
    error.value = err
  } finally {
    if (seq === loadDashboardSeq) {
      loading.value = false
    }
  }
}

onMounted(() => loadDashboard())

watch(
  () => [session.actingUserId, session.sessionRevision],
  () => {
    wrongPeriodDrafts.value = {}
    wrongPeriodBanner.value = ''
    dashboard.value = null
    resetConsumption()
    loadDashboard()
  },
)

watch(
  () => periodCode.value,
  (newCode, oldCode) => {
    if (newCode === oldCode) return
    // Selecting an initial period code during initial load already fetched with the server default
    if (!oldCode && dashboard.value?.period?.period_code === newCode) return
    loadDashboard()
  },
)

const apartments = computed(() => dashboard.value?.apartments || [])

const activeApartment = computed(() => {
  if (!apartments.value.length) return null
  return (
    apartments.value.find((a) => a.apartment_id === session.selectedApartmentId) ||
    apartments.value[0]
  )
})

const {
  data: consumptionData,
  loading: consumptionLoading,
  error: consumptionError,
  load: loadConsumption,
  reset: resetConsumption,
} = useApartmentConsumption()

watch(
  () => activeApartment.value?.apartment_id,
  (aptId) => {
    if (!aptId) {
      resetConsumption()
      return
    }
    loadConsumption(aptId, 12)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  loadDashboardSeq += 1
})

const period = computed(() => dashboard.value?.period || null)

const hasOpenSubmissions = computed(() => {
  if (!activeApartment.value?.can_submit_readings) return false
  const meters = activeApartment.value.meters || []
  if (!meters.length) return false
  return meters.some((m) =>
    m.next_submission !== undefined
      ? m.next_submission !== null
      : period.value?.status !== 'LOCKED',
  )
})

function isKitchenLabel(label = '') {
  const l = label.toLowerCase()
  return l.includes('kitchen') || l.includes('köök') || l.includes('кухн')
}

function isBathroomLabel(label = '') {
  const l = label.toLowerCase()
  return (
    l.includes('bath') ||
    l.includes('laundry') ||
    l.includes('vann') ||
    l.includes('pesu') ||
    l.includes('ванн') ||
    l.includes('сануз')
  )
}

// Group meters into Kitchen, Bathroom, and Auxiliary sections with multilingual support
const kitchenMeters = computed(() =>
  (activeApartment.value?.meters || []).filter((m) => isKitchenLabel(m.location_label)),
)

const bathroomMeters = computed(() =>
  (activeApartment.value?.meters || []).filter(
    (m) => !isKitchenLabel(m.location_label) && isBathroomLabel(m.location_label),
  ),
)

const auxiliaryMeters = computed(() =>
  (activeApartment.value?.meters || []).filter(
    (m) => !isKitchenLabel(m.location_label) && !isBathroomLabel(m.location_label),
  ),
)

function getEffectiveDelta(meter) {
  if (draftDeltas.value[meter.meter_id] !== undefined) {
    return draftDeltas.value[meter.meter_id]
  }
  if (meter.next_submission && typeof meter.next_submission === 'object') {
    return meter.next_submission.reading?.consumption_delta || null
  }
  return meter.reading?.consumption_delta || null
}

// Total Cold Water (m³) using scaled BigInt
const totalColdWaterM3 = computed(() => {
  const deltas = (activeApartment.value?.meters || [])
    .filter((m) => m.resource_type === 'COLD_WATER' && m.unit === 'm3')
    .map((m) => getEffectiveDelta(m))
    .filter((d) => d && !d.startsWith('-'))
  return sumMeterValues(deltas)
})

// Total Hot Water (m³) using scaled BigInt
const totalHotWaterM3 = computed(() => {
  const deltas = (activeApartment.value?.meters || [])
    .filter((m) => m.resource_type === 'HOT_WATER' && m.unit === 'm3')
    .map((m) => getEffectiveDelta(m))
    .filter((d) => d && !d.startsWith('-'))
  return sumMeterValues(deltas)
})

// Combined Water (m³) — never sums kWh or MWh with m³
const totalCombinedWaterM3 = computed(() =>
  sumMeterValues([totalColdWaterM3.value, totalHotWaterM3.value]),
)

// Apartment's own 3-month average water consumption (sum of water meters' average_delta)
const apartmentWaterAverageM3 = computed(() => {
  const avgs = (activeApartment.value?.meters || [])
    .filter((m) => {
      const avg = m.next_submission?.average_delta ?? m.average_delta
      return (m.resource_type === 'COLD_WATER' || m.resource_type === 'HOT_WATER') &&
        m.unit === 'm3' &&
        avg
    })
    .map((m) => m.next_submission?.average_delta ?? m.average_delta)
  return avgs.length > 0 ? sumMeterValues(avgs) : null
})

// Apartment's own previous month water consumption (sum of water meters' previous_delta)
const apartmentWaterPreviousM3 = computed(() => {
  const prevs = (activeApartment.value?.meters || [])
    .filter(
      (m) =>
        (m.resource_type === 'COLD_WATER' || m.resource_type === 'HOT_WATER') &&
        m.unit === 'm3' &&
        m.previous_delta,
    )
    .map((m) => m.previous_delta)
  return prevs.length > 0 ? sumMeterValues(prevs) : null
})

// Difference vs apartment's own 3-month average (using scaled BigInt)
const diffVsOwnAverageM3 = computed(() => {
  if (!apartmentWaterAverageM3.value) return null
  return subtractMeterValues(totalCombinedWaterM3.value, apartmentWaterAverageM3.value)
})

// Total Electricity (kWh)
const totalElectricityKwh = computed(() => {
  const deltas = (activeApartment.value?.meters || [])
    .filter((m) => m.resource_type === 'ELECTRICITY' && m.unit === 'kWh')
    .map((m) => getEffectiveDelta(m))
    .filter((d) => d && !d.startsWith('-'))
  return sumMeterValues(deltas)
})

function handleDraftChange({ meterId, delta }) {
  draftDeltas.value = {
    ...draftDeltas.value,
    [meterId]: delta,
  }
  if (wrongPeriodDrafts.value[meterId] !== undefined) {
    const nextDrafts = { ...wrongPeriodDrafts.value }
    delete nextDrafts[meterId]
    wrongPeriodDrafts.value = nextDrafts
  }
}

async function handleWrongPeriod({ meterId, targetPeriodCode, draftValue }) {
  wrongPeriodDrafts.value = {
    ...wrongPeriodDrafts.value,
    [meterId]: draftValue,
  }
  submitBannerMessage.value = ''
  const monthLabel = targetPeriodCode
    ? formatMonthName(targetPeriodCode, session.lang, { capitalize: true })
    : ''
  wrongPeriodBanner.value = session.t('readings.wrongPeriodBanner', { month: monthLabel })
  await loadDashboard({ quiet: true })
}

async function handleMeterSaved(savedReading) {
  if (!dashboard.value) return
  if (wrongPeriodDrafts.value[savedReading.meter_id] !== undefined) {
    const nextDrafts = { ...wrongPeriodDrafts.value }
    delete nextDrafts[savedReading.meter_id]
    wrongPeriodDrafts.value = nextDrafts
  }
  if (draftDeltas.value[savedReading.meter_id] !== undefined) {
    const nextDeltas = { ...draftDeltas.value }
    delete nextDeltas[savedReading.meter_id]
    draftDeltas.value = nextDeltas
  }
  wrongPeriodBanner.value = ''
  submitBannerMessage.value = session.t('readings.savedBanner', { value: savedReading.value })
  // Refresh dashboard in-place so late-final submissions advance next_submission cleanly to the new month
  await loadDashboard({ quiet: true })
  if (activeApartment.value?.apartment_id) {
    await loadConsumption(activeApartment.value.apartment_id, 12, { preserveDataOnReload: true })
  }
}

async function submitAllMeters() {
  submitBannerMessage.value = ''
  if (!meterCardRefs.value.length) return
  for (const card of meterCardRefs.value) {
    if (card && typeof card.submit === 'function') {
      await card.submit(0)
    }
  }
}

function openHistory(readingId, label) {
  historyReadingId.value = readingId
  historyTitle.value = label
}
</script>

<template>
  <div class="w-full flex flex-col">
    <!-- Main Content Container -->
    <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-xl flex-1">
      <ErrorCard v-if="error" :error="error" @retry="loadDashboard" />

      <div v-else-if="loading" class="py-8">
        <BaseSkeleton :lines="6" />
      </div>

      <!-- User has no apartment (e.g. Chairman or Accountant) -->
      <div v-else-if="!activeApartment" class="py-4">
        <BaseEmptyState
          icon="domain"
          :title="session.t('readings.noPersonalApartmentTitle')"
          :description="session.t('readings.noPersonalApartmentDesc')"
        >
          <div v-if="canViewMatrix" class="mt-2 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              class="px-5 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:bg-primary-container transition-colors inline-flex items-center gap-2"
              @click="router.push('/accounting')"
            >
              <span class="material-symbols-outlined text-[18px]">table_view</span>
              <span>{{ session.t('readings.openBuildingMatrixBtn') }}</span>
            </button>
            <button
              type="button"
              data-testid="readings-staff-consumption-link"
              class="px-5 py-2.5 rounded-lg bg-surface-container-low border border-surface-container-high text-on-surface font-label-lg text-sm font-semibold hover:bg-surface-container transition-colors inline-flex items-center gap-2"
              @click="router.push({ name: 'accounting', query: { tab: 'consumption' } })"
            >
              <span class="material-symbols-outlined text-[18px]">monitoring</span>
              <span>{{ session.t('buildingConsumption.openConsumptionLink') }}</span>
            </button>
          </div>
        </BaseEmptyState>
      </div>

      <template v-else>
        <!-- Title, Period & Apartment Controls Bar -->
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md pb-space-lg border-b border-surface-container-high/70">
          <div>
            <h1 class="font-headline-lg text-headline-lg text-on-surface tracking-tight">
              {{ session.t('readings.aptMeterSubmissionTitle', { number: activeApartment.apartment_number }) }}
            </h1>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
              {{ session.t('readings.billingPeriodLabel') }}
              {{ period ? formatPeriodLabel(period.period_code, session.lang) : periodCode }}
              <template v-if="period?.due_date">
                • {{ session.t('readings.dueByLabel') }} {{ formatDate(period.due_date, session.lang) }}
              </template>
            </p>
            <p v-if="hasOpenSubmissions" class="text-xs text-primary font-medium mt-1 inline-flex items-center gap-1">
              <span class="material-symbols-outlined text-[15px]">keyboard</span>
              <span>{{ session.t('readings.fastEntryHint') }}</span>
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            <label for="readings-period-select" class="sr-only">Billing Period</label>
            <select
              id="readings-period-select"
              v-model="periodCode"
              class="h-9 px-3.5 rounded-full bg-surface-container-lowest border border-surface-container-high text-on-surface font-label-md text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option v-for="code in periods" :key="code" :value="code">
                {{ formatPeriodLabel(code, session.lang) }} ({{ code }})
              </option>
            </select>

            <div
              v-if="apartments.length > 1"
              class="inline-flex items-center gap-1 p-1 rounded-full bg-surface-container-low border border-surface-container-high"
            >
              <button
                v-for="apt in apartments"
                :key="apt.apartment_id"
                type="button"
                class="px-3 py-1 rounded-full font-label-md text-xs transition-colors"
                :class="
                  apt.apartment_id === activeApartment?.apartment_id
                    ? 'bg-primary text-on-primary font-semibold'
                    : 'text-on-surface-variant hover:text-on-surface'
                "
                @click="session.selectApartment(apt.apartment_id)"
              >
                {{ session.t('common.apartmentNumber', { number: apt.apartment_number }) }}
              </button>
            </div>

            <StatusChip v-if="period" :status="period.status" />
            <button
              v-if="canViewMatrix"
              type="button"
              data-testid="readings-header-consumption-link"
              class="px-3 py-1.5 rounded-full bg-surface-container-low border border-surface-container-high text-on-surface font-label-md text-xs font-semibold hover:bg-surface-container transition-colors inline-flex items-center gap-1.5"
              @click="router.push({ name: 'accounting', query: { tab: 'consumption' } })"
            >
              <span class="material-symbols-outlined text-[15px]">monitoring</span>
              <span>{{ session.t('buildingConsumption.openConsumptionLink') }}</span>
            </button>
            <span
              v-if="!activeApartment.can_submit_readings"
              class="px-3 py-1 rounded-full bg-error-container text-on-error-container font-label-md text-xs font-semibold"
            >
              {{ session.t('readings.viewOnlyBadge') }}
            </span>
          </div>
        </div>

        <!-- Wrong Period Info Banner (409 WRONG_PERIOD) -->
        <div
          v-if="wrongPeriodBanner"
          role="status"
          class="mt-space-md p-3 rounded-xl bg-amber-100/80 dark:bg-amber-950/50 text-amber-950 dark:text-amber-200 border border-amber-300/70 font-label-md text-xs font-semibold flex items-center justify-between gap-2"
        >
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px]">update</span>
            <span>{{ wrongPeriodBanner }}</span>
          </div>
          <button
            type="button"
            class="text-xs underline shrink-0"
            @click="wrongPeriodBanner = ''"
          >
            {{ session.t('common.dismiss') }}
          </button>
        </div>

        <!-- Feedback Toast Banner -->
        <div
          v-if="submitBannerMessage"
          role="status"
          class="mt-space-md p-3 rounded-xl bg-secondary-container/50 text-on-secondary-container font-label-md text-xs font-semibold flex items-center justify-between"
        >
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px] text-secondary">check_circle</span>
            <span>{{ submitBannerMessage }}</span>
          </div>
          <button
            type="button"
            class="text-xs underline"
            @click="submitBannerMessage = ''"
          >
            {{ session.t('common.dismiss') }}
          </button>
        </div>

        <!-- Two-Column Layout: Left (Meters Form) & Right (Consumption Summary & Action) -->
        <div class="mt-space-lg grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
          <!-- Left: Cohesive Apartment Meters Form (8 cols) -->
          <div class="lg:col-span-8 flex flex-col gap-space-lg">
            <div class="bg-surface-container-lowest rounded-xl border border-surface-container-high shadow-2xs overflow-hidden">
              <!-- SECTION A: KITCHEN METERS -->
              <div v-if="kitchenMeters.length > 0" class="p-space-lg border-b border-surface-container-high">
                <div class="flex items-center justify-between gap-space-sm mb-space-md">
                  <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
                      <span class="material-symbols-outlined text-[20px]">countertops</span>
                    </span>
                    <div>
                      <h2 class="font-headline-md text-headline-md text-on-surface font-semibold">
                        {{ session.t('readings.kitchenMetersTitle') }}
                      </h2>
                      <p class="font-label-md text-label-md text-on-surface-variant">
                        {{ session.t('readings.kitchenMetersSub') }}
                      </p>
                    </div>
                  </div>
                  <span class="font-label-md text-label-md text-on-surface-variant">
                    {{ session.t('readings.activeMetersCount', { count: kitchenMeters.length }) }}
                  </span>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                  <MeterCard
                    v-for="meter in kitchenMeters"
                    :key="meter.meter_id"
                    ref="meterCardRefs"
                    :meter="meter"
                    :period-code="period?.period_code || periodCode"
                    :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
                    :can-submit="activeApartment.can_submit_readings"
                    :use-next-submission="true"
                    :preserved-draft="wrongPeriodDrafts[meter.meter_id] ?? null"
                    @saved="handleMeterSaved"
                    @wrong-period="handleWrongPeriod"
                    @draft-change="handleDraftChange"
                    @open-history="openHistory"
                  />
                </div>
              </div>

              <!-- SECTION B: BATHROOM METERS -->
              <div v-if="bathroomMeters.length > 0" class="p-space-lg border-b border-surface-container-high">
                <div class="flex items-center justify-between gap-space-sm mb-space-md">
                  <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
                      <span class="material-symbols-outlined text-[20px]">bathtub</span>
                    </span>
                    <div>
                      <h2 class="font-headline-md text-headline-md text-on-surface font-semibold">
                        {{ session.t('readings.bathroomMetersTitle') }}
                      </h2>
                      <p class="font-label-md text-label-md text-on-surface-variant">
                        {{ session.t('readings.bathroomMetersSub') }}
                      </p>
                    </div>
                  </div>
                  <span class="font-label-md text-label-md text-on-surface-variant">
                    {{ session.t('readings.activeMetersCount', { count: bathroomMeters.length }) }}
                  </span>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                  <MeterCard
                    v-for="meter in bathroomMeters"
                    :key="meter.meter_id"
                    ref="meterCardRefs"
                    :meter="meter"
                    :period-code="period?.period_code || periodCode"
                    :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
                    :can-submit="activeApartment.can_submit_readings"
                    :use-next-submission="true"
                    :preserved-draft="wrongPeriodDrafts[meter.meter_id] ?? null"
                    @saved="handleMeterSaved"
                    @wrong-period="handleWrongPeriod"
                    @draft-change="handleDraftChange"
                    @open-history="openHistory"
                  />
                </div>
              </div>

              <!-- SECTION C: AUXILIARY / ELECTRICITY -->
              <div v-if="auxiliaryMeters.length > 0" class="p-space-lg">
                <div class="flex items-center justify-between gap-space-sm mb-space-md">
                  <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
                      <span class="material-symbols-outlined text-[20px]">electric_car</span>
                    </span>
                    <div>
                      <h2 class="font-headline-md text-headline-md text-on-surface font-semibold">
                        {{ session.t('readings.auxiliaryMetersTitle') }}
                      </h2>
                      <p class="font-label-md text-label-md text-on-surface-variant">
                        {{ session.t('readings.auxiliaryMetersSub') }}
                      </p>
                    </div>
                  </div>
                  <span class="font-label-md text-label-md text-on-surface-variant">
                    Sub-meter
                  </span>
                </div>

                <div class="grid grid-cols-1 gap-space-md">
                  <MeterCard
                    v-for="meter in auxiliaryMeters"
                    :key="meter.meter_id"
                    ref="meterCardRefs"
                    :meter="meter"
                    :period-code="period?.period_code || periodCode"
                    :period-status="period?.status || 'OPEN_FOR_RESIDENTS'"
                    :can-submit="activeApartment.can_submit_readings"
                    :use-next-submission="true"
                    :preserved-draft="wrongPeriodDrafts[meter.meter_id] ?? null"
                    @saved="handleMeterSaved"
                    @wrong-period="handleWrongPeriod"
                    @draft-change="handleDraftChange"
                    @open-history="openHistory"
                  />
                </div>
              </div>
            </div>

            <!-- Calibration & Verification Footer Strip -->
            <div class="flex items-center justify-between p-space-md rounded-lg bg-surface-container-low border border-surface-container text-body-sm text-on-surface-variant">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-[20px] text-secondary">verified</span>
                <span>
                  {{ session.t('readings.calibrationFooter') }}
                </span>
              </div>
            </div>
          </div>

          <!-- Right: Prominent Total Consumption Summary & Action Panel (4 cols) -->
          <div class="lg:col-span-4 flex flex-col gap-space-md">
            <div class="bg-surface-container-lowest rounded-xl border border-surface-container-high p-space-lg shadow-2xs flex flex-col gap-space-md sticky top-28">
              <div class="flex items-center justify-between pb-space-xs border-b border-surface-container">
                <div>
                  <h3 class="font-headline-md text-headline-md text-on-surface font-semibold">
                    {{ session.t('readings.totalConsumptionTitle') }}
                  </h3>
                  <p class="font-body-sm text-body-sm text-on-surface-variant">
                    {{ session.t('readings.totalConsumptionSub') }}
                  </p>
                </div>
                <span class="material-symbols-outlined text-secondary text-[24px]">calculate</span>
              </div>

              <div class="flex flex-col gap-space-sm">
                <!-- Cold Water Combined -->
                <div class="flex items-center justify-between py-2 border-b border-surface-container-low">
                  <div class="flex items-center gap-2 text-body-sm">
                    <span class="w-2.5 h-2.5 rounded-full bg-blue-500" />
                    <span class="text-on-surface font-medium">
                      {{ session.t('readings.totalColdWater') }}
                    </span>
                  </div>
                  <span class="font-mono tabular-nums font-bold text-on-surface text-base">
                    {{ totalColdWaterM3 }} m³
                  </span>
                </div>

                <!-- Hot Water Combined -->
                <div class="flex items-center justify-between py-2 border-b border-surface-container-low">
                  <div class="flex items-center gap-2 text-body-sm">
                    <span class="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    <span class="text-on-surface font-medium">
                      {{ session.t('readings.totalHotWater') }}
                    </span>
                  </div>
                  <span class="font-mono tabular-nums font-bold text-on-surface text-base">
                    {{ totalHotWaterM3 }} m³
                  </span>
                </div>

                <!-- Combined Water Highlight Card -->
                <div class="p-space-sm bg-surface-container-low rounded-lg flex flex-col gap-1 border border-surface-container">
                  <div class="flex items-center justify-between font-label-md text-label-md">
                    <span class="text-on-surface font-semibold">
                      {{ session.t('readings.totalWaterCombined') }}
                    </span>
                    <span class="font-numeric-display tabular-nums font-bold text-on-surface text-lg">
                      {{ totalCombinedWaterM3 }} m³
                    </span>
                  </div>
                  <div class="flex items-center justify-between text-xs text-on-surface-variant">
                    <span>{{ session.t('readings.unitPrecision') }}</span>
                    <span class="font-semibold text-secondary font-mono">3 decimals (m³)</span>
                  </div>
                </div>

                <!-- Electricity Sub-meter (kept strictly separate from m³) -->
                <div
                  v-if="auxiliaryMeters.length > 0"
                  class="flex items-center justify-between py-2 border-b border-surface-container-low"
                >
                  <div class="flex items-center gap-2 text-body-sm">
                    <span class="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <span class="text-on-surface font-medium">
                      {{ session.t('readings.totalElectricity') }}
                    </span>
                  </div>
                  <span class="font-mono tabular-nums font-bold text-on-surface text-base">
                    {{ totalElectricityKwh }} kWh
                  </span>
                </div>
              </div>

              <!-- Comparison with Apartment's Own 3-Month Average & Previous Month (PR #31) -->
              <div
                v-if="apartmentWaterAverageM3 || apartmentWaterPreviousM3"
                class="p-3 bg-secondary-fixed/20 rounded-lg text-xs text-on-secondary-fixed-variant space-y-1.5"
              >
                <div class="flex items-center justify-between font-medium">
                  <span class="flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[16px] text-secondary">
                      {{
                        diffVsOwnAverageM3 && compareMeterValues(totalCombinedWaterM3, apartmentWaterAverageM3) > 0
                          ? 'trending_up'
                          : 'trending_down'
                      }}
                    </span>
                    <span>
                      {{ session.t('readings.your3MonthAvg') }}
                    </span>
                  </span>
                  <strong class="font-mono tabular-nums">{{ apartmentWaterAverageM3 }} m³</strong>
                </div>

                <div
                  v-if="apartmentWaterPreviousM3"
                  class="flex items-center justify-between text-[11px] opacity-90"
                >
                  <span>{{ session.t('readings.previousMonthWater') }}</span>
                  <span class="font-mono tabular-nums">{{ apartmentWaterPreviousM3 }} m³</span>
                </div>

                <div
                  v-if="diffVsOwnAverageM3"
                  class="flex items-center justify-between text-[11px] pt-1 border-t border-secondary/20 font-semibold"
                >
                  <span>{{ session.t('readings.diffVsAvg') }}</span>
                  <span class="font-mono tabular-nums">
                    {{ formatSignedDelta(diffVsOwnAverageM3) }} m³
                  </span>
                </div>
              </div>

              <!-- Primary Submission Button -->
              <div class="pt-2 flex flex-col gap-2">
                <button
                  type="button"
                  :disabled="!hasOpenSubmissions"
                  class="w-full py-3.5 px-space-md bg-primary text-on-primary font-label-lg text-label-lg rounded-lg shadow-xs hover:bg-primary-container transition-all flex items-center justify-center gap-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  @click="submitAllMeters"
                >
                  <span>
                    {{ session.t('readings.confirmAndSubmitBtn') }}
                  </span>
                  <span class="material-symbols-outlined text-[18px]">send</span>
                </button>
                <p class="text-center text-[11px] text-on-surface-variant">
                  {{ session.t('readings.anomalyNotice') }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- Last 12 Months Apartment Consumption Chart (#030 - strictly apartment-only, no building averages) -->
        <div class="mt-space-lg">
          <ConsumptionChart
            :periods="consumptionData?.periods || []"
            :series="consumptionData?.resources || []"
            :loading="consumptionLoading"
            :error="consumptionError"
            :title="session.t('consumptionChart.sectionTitle')"
            :subtitle="session.t('consumptionChart.sectionSubtitle')"
            @retry="loadConsumption(activeApartment?.apartment_id || '')"
          />
        </div>

        <!-- Mobile Sticky Consumption Summary & Quick Submit Bar (< lg) -->
        <div
          v-if="hasOpenSubmissions"
          data-testid="readings-mobile-sticky-bar"
          class="lg:hidden sticky bottom-16 z-20 mt-space-md rounded-2xl bg-surface-container-lowest/95 backdrop-blur-md border border-surface-container-high p-3 shadow-lg flex items-center justify-between gap-3"
        >
          <div class="min-w-0">
            <span class="block text-[10px] uppercase tracking-wider font-bold text-on-surface-variant">
              {{ session.t('readings.totalWaterCombined') }}
            </span>
            <span class="font-mono tabular-nums font-bold text-sm text-on-surface">
              {{ totalCombinedWaterM3 }} m³
            </span>
          </div>

          <button
            type="button"
            class="px-4 py-2.5 bg-primary text-on-primary font-label-md text-xs font-semibold rounded-xl shadow-xs hover:bg-primary-container transition-all inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            @click="submitAllMeters"
          >
            <span>{{ session.t('readings.confirmAndSubmitBtn') }}</span>
            <span class="material-symbols-outlined text-[16px]">send</span>
          </button>
        </div>
      </template>
    </div>

    <!-- Reading Audit History Modal -->
    <ReadingHistoryModal
      :reading-id="historyReadingId"
      :title-label="historyTitle"
      @close="historyReadingId = ''"
    />
  </div>
</template>
