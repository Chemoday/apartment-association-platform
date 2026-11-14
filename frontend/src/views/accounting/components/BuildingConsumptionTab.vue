<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { useBuildingConsumption } from '@/composables/useBuildingConsumption.js'
import { getResourceChartStyle } from '@/utils/consumption.js'
import { formatPeriodLabel } from '@/utils/dates.js'
import ConsumptionChart from '@/components/domain/ConsumptionChart.vue'

const props = defineProps({
  knownApartmentsCount: {
    type: [Number, null],
    default: null,
  },
})

const session = useSessionStore()
const { canViewMatrix } = useRole()
const selectedMonths = ref(12)

const { data, loading, error, load, reset } = useBuildingConsumption()

function fetchBuildingConsumption({ preserveDataOnReload = false } = {}) {
  if (!session.actingUserId || !canViewMatrix.value) {
    reset()
    return
  }
  load(selectedMonths.value, { preserveDataOnReload })
}

onMounted(() => {
  fetchBuildingConsumption()
})

watch(
  () => [session.actingUserId, session.sessionRevision, session.buildingRole, selectedMonths.value],
  ([_uid, _rev, _role, newMonths], [_oldUid, _oldRev, _oldRole, oldMonths]) => {
    const onlyMonthsChanged = newMonths !== oldMonths
    fetchBuildingConsumption({ preserveDataOnReload: onlyMonthsChanged })
  },
)

function selectMonths(monthsCount) {
  if (!canViewMatrix.value || selectedMonths.value === monthsCount) return
  selectedMonths.value = monthsCount
}

function unitLabel(unit) {
  const translated = session.t(`units.${unit}`)
  return translated === `units.${unit}` ? unit : translated
}

function resourceLabel(resourceType) {
  const translated = session.t(`resources.${resourceType}`)
  return translated === `resources.${resourceType}` ? resourceType : translated
}

function inProgressBadgeText(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0))
  const lang = session.lang || 'en'
  if (lang === 'ru') {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) {
      return session.t('buildingConsumption.inProgressSoFarOne', { count: n })
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return session.t('buildingConsumption.inProgressSoFarFew', { count: n })
    }
    return session.t('buildingConsumption.inProgressSoFar', { count: n })
  }
  if (n === 1) {
    return session.t('buildingConsumption.inProgressSoFarOne', { count: n })
  }
  return session.t('buildingConsumption.inProgressSoFar', { count: n })
}

const resolvedTotalApartments = computed(() => {
  const candidate = props.knownApartmentsCount ?? session.knownBuildingApartmentsCount
  const num = Number(candidate)
  return Number.isInteger(num) && num > 0 ? num : null
})

const tables = computed(() => {
  const periods = Array.isArray(data.value?.periods) ? data.value.periods : []
  const resources = Array.isArray(data.value?.resources) ? data.value.resources : []
  const newestFirstPeriods = [...periods].reverse()

  return resources.map((series) => {
    const byCode = new Map((series.months || []).map((m) => [m.period_code, m]))
    const displayUnit = unitLabel(series.unit)
    const rows = newestFirstPeriods.map((period) => {
      const entry = byCode.get(period.period_code) ?? null
      const counted = entry?.apartments_counted ?? 0
      const estimatedCount = entry?.estimated_readings ?? 0
      return {
        periodCode: period.period_code,
        periodStatus: period.status || 'LOCKED',
        isOpen: period.status === 'OPEN_FOR_RESIDENTS',
        total: entry?.total ?? null,
        isNegative: typeof entry?.total === 'string' && entry.total.startsWith('-'),
        apartmentsCounted: counted,
        averagePerApartment: entry?.average_per_apartment ?? null,
        averagePerM2: entry?.average_per_m2 ?? null,
        estimatedReadings: estimatedCount,
      }
    })

    return {
      key: `${series.resource_type}::${series.unit}`,
      resourceType: series.resource_type,
      resourceName: resourceLabel(series.resource_type),
      unit: series.unit,
      displayUnit,
      style: getResourceChartStyle(series.resource_type),
      rows,
    }
  })
})
</script>

<template>
  <div
    v-if="!canViewMatrix"
    data-testid="building-consumption-forbidden"
    role="alert"
    class="rounded-2xl bg-surface-container-lowest border border-error/30 p-space-lg text-center max-w-lg mx-auto space-y-3 shadow-xs"
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

  <div v-else data-testid="building-consumption-tab" class="space-y-space-lg">
    <ConsumptionChart
      :periods="data?.periods || []"
      :series="data?.resources || []"
      :loading="loading"
      :error="error"
      :months="selectedMonths"
      :title="session.t('buildingConsumption.sectionTitle', { months: selectedMonths })"
      :subtitle="session.t('buildingConsumption.sectionSubtitle')"
      :empty-text="session.t('buildingConsumption.emptySeries')"
      @retry="fetchBuildingConsumption()"
    >
      <template #actions>
        <div
          role="group"
          :aria-label="session.t('buildingConsumption.windowSelectorLabel')"
          class="inline-flex items-center gap-1 p-1 rounded-full bg-surface-container-low border border-surface-container-high self-start"
        >
          <button
            type="button"
            data-testid="building-consumption-months-12"
            :aria-pressed="selectedMonths === 12 ? 'true' : 'false'"
            class="px-3 py-1.5 rounded-full font-label-md text-xs transition-colors cursor-pointer"
            :class="
              selectedMonths === 12
                ? 'bg-primary text-on-primary font-semibold shadow-2xs'
                : 'text-on-surface-variant hover:text-on-surface'
            "
            @click="selectMonths(12)"
          >
            {{ session.t('buildingConsumption.months12') }}
          </button>
          <button
            type="button"
            data-testid="building-consumption-months-24"
            :aria-pressed="selectedMonths === 24 ? 'true' : 'false'"
            class="px-3 py-1.5 rounded-full font-label-md text-xs transition-colors cursor-pointer"
            :class="
              selectedMonths === 24
                ? 'bg-primary text-on-primary font-semibold shadow-2xs'
                : 'text-on-surface-variant hover:text-on-surface'
            "
            @click="selectMonths(24)"
          >
            {{ session.t('buildingConsumption.months24') }}
          </button>
        </div>
      </template>
    </ConsumptionChart>

    <!-- Per-Resource Monthly Totals, Averages & Estimated Readings Tables -->
    <template v-if="!loading && !error && tables.length > 0">
      <section
        v-for="tbl in tables"
        :key="tbl.key"
        :data-testid="`building-consumption-table-${tbl.resourceType}`"
        class="rounded-2xl bg-surface-container-lowest border border-surface-container-high shadow-2xs overflow-hidden"
      >
        <div class="px-space-md sm:px-space-lg py-3.5 bg-surface-container-low/70 border-b border-surface-container flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="w-3 h-3 rounded-full shrink-0" :class="tbl.style.dotClass" />
            <h3 class="font-title-md text-sm font-bold text-on-surface truncate">
              {{ tbl.resourceName }}
            </h3>
            <span
              class="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-md border"
              :class="tbl.style.badgeClass"
            >
              {{ tbl.displayUnit }}
            </span>
          </div>
          <span
            v-if="resolvedTotalApartments !== null"
            class="text-[11px] font-medium text-on-surface-variant"
          >
            {{ resolvedTotalApartments }} {{ session.t('accounting.unitsTotal') }}
          </span>
        </div>

        <div class="overflow-x-auto">
          <table
            class="w-full text-left font-body-sm text-xs sm:text-sm"
            :aria-label="session.t('buildingConsumption.tableAriaLabel', { resource: tbl.resourceName })"
          >
            <thead class="bg-surface-container/50 text-on-surface-variant font-label-md text-[11px] uppercase tracking-wider border-b border-surface-container">
              <tr>
                <th class="py-3 px-space-md whitespace-nowrap">
                  {{ session.t('buildingConsumption.colMonth') }}
                </th>
                <th class="py-3 px-space-md text-right whitespace-nowrap">
                  {{ session.t('buildingConsumption.colTotal') }}
                </th>
                <th class="py-3 px-space-md text-right whitespace-nowrap">
                  {{ session.t('buildingConsumption.colApartments') }}
                </th>
                <th class="py-3 px-space-md text-right whitespace-nowrap">
                  {{ session.t('buildingConsumption.colPerApartment') }}
                </th>
                <th class="py-3 px-space-md text-right whitespace-nowrap">
                  {{ session.t('buildingConsumption.colPerM2') }}
                </th>
                <th class="py-3 px-space-md text-right whitespace-nowrap">
                  {{ session.t('buildingConsumption.colEstimated') }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-container">
              <tr
                v-for="row in tbl.rows"
                :key="row.periodCode"
                :data-testid="`building-consumption-row-${tbl.resourceType}-${row.periodCode}`"
                class="hover:bg-surface-container-low/40 transition-colors"
                :class="row.isOpen ? 'bg-amber-500/5 dark:bg-amber-400/5' : ''"
              >
                <td class="py-3 px-space-md">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold text-on-surface whitespace-nowrap">
                      {{ formatPeriodLabel(row.periodCode, session.lang) }}
                    </span>
                    <span class="font-mono text-[11px] text-on-surface-variant">
                      {{ row.periodCode }}
                    </span>
                    <span
                      v-if="row.isOpen"
                      :data-testid="`building-consumption-open-${row.periodCode}`"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-800 dark:text-amber-300 text-[10px] font-semibold"
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      <span>
                        {{ inProgressBadgeText(row.apartmentsCounted) }}
                      </span>
                    </span>
                  </div>
                </td>

                <td class="py-3 px-space-md text-right font-mono tabular-nums whitespace-nowrap">
                  <span
                    v-if="row.total !== null"
                    class="font-bold"
                    :class="row.isNegative ? 'text-error' : 'text-on-surface'"
                  >
                    {{ row.total }} {{ tbl.displayUnit }}
                  </span>
                  <span v-else class="text-on-surface-variant italic font-sans font-normal">
                    —
                  </span>
                </td>

                <td class="py-3 px-space-md text-right font-mono tabular-nums whitespace-nowrap text-on-surface">
                  <span>{{ row.apartmentsCounted }}</span>
                  <span
                    v-if="resolvedTotalApartments !== null && resolvedTotalApartments >= row.apartmentsCounted"
                    class="text-xs text-on-surface-variant font-sans ml-1"
                  >
                    ({{ session.t('buildingConsumption.ofApartments', { total: resolvedTotalApartments }) }})
                  </span>
                </td>

                <td class="py-3 px-space-md text-right font-mono tabular-nums whitespace-nowrap">
                  <span v-if="row.averagePerApartment !== null" class="text-on-surface">
                    {{ row.averagePerApartment }} {{ tbl.displayUnit }}
                  </span>
                  <span v-else class="text-on-surface-variant italic font-sans">—</span>
                </td>

                <td class="py-3 px-space-md text-right font-mono tabular-nums whitespace-nowrap">
                  <span v-if="row.averagePerM2 !== null" class="text-on-surface">
                    {{ row.averagePerM2 }} {{ tbl.displayUnit }}/m²
                  </span>
                  <span v-else class="text-on-surface-variant italic font-sans">—</span>
                </td>

                <td class="py-3 px-space-md text-right font-mono tabular-nums whitespace-nowrap">
                  <span
                    v-if="row.estimatedReadings > 0"
                    class="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 dark:text-amber-300 text-xs font-semibold"
                  >
                    {{ row.estimatedReadings }}
                  </span>
                  <span v-else class="text-on-surface-variant">0</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
