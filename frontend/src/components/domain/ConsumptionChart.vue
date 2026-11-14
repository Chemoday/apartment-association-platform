<script setup>
import { computed, ref, useId, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { formatPeriodLabel } from '@/utils/dates.js'
import {
  computeConsumptionChartGeometry,
  formatCompactPeriodTick,
  getResourceChartStyle,
} from '@/utils/consumption.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const props = defineProps({
  periods: {
    type: Array,
    default: () => [],
  },
  series: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: Object,
    default: null,
  },
  title: {
    type: String,
    default: '',
  },
  subtitle: {
    type: String,
    default: '',
  },
  emptyText: {
    type: String,
    default: '',
  },
  months: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits(['retry'])

const session = useSessionStore()
const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')

const activeBySeries = ref({}) // seriesKey -> periodCode
const pinnedBySeries = ref({}) // seriesKey -> periodCode

watch(
  () => [props.periods, props.series],
  () => {
    activeBySeries.value = {}
    pinnedBySeries.value = {}
  },
)

function seriesKey(item) {
  return `${item.resource_type}::${item.unit}`
}

function hatchPatternId(item) {
  return `hatch-${instanceId}-${item.resource_type}-${item.unit}`.replace(/[^a-zA-Z0-9_-]/g, '')
}

function unitLabel(unit) {
  const translated = session.t(`units.${unit}`)
  return translated === `units.${unit}` ? unit : translated
}

function resourceLabel(resourceType) {
  const translated = session.t(`resources.${resourceType}`)
  return translated === `resources.${resourceType}` ? resourceType : translated
}

const resolvedTitle = computed(() => {
  if (props.title) return props.title
  if (props.months && props.months !== 12) {
    return session.t('consumptionChart.sectionTitleMonths', { months: props.months })
  }
  return session.t('consumptionChart.sectionTitle')
})

const chartWidth = computed(() => ((props.periods?.length || 0) > 14 ? 660 : 560))
const chartHeight = 218

const charts = computed(() => {
  const w = chartWidth.value
  return (props.series || []).map((item) => {
    const key = seriesKey(item)
    const style = getResourceChartStyle(item.resource_type)
    const displayUnit = unitLabel(item.unit)
    const geometry = computeConsumptionChartGeometry(item.months || [], props.periods || [], {
      plotLeft: 46,
      plotRight: w - 34,
      plotTop: 20,
      plotBottom: 170,
      unitLabel: displayUnit,
    })

    const hasOpenPeriod = geometry.bars.some((b) => b.isOpen)
    const hasEstimated = geometry.bars.some((b) => b.estimated)
    const hasGap = geometry.bars.some((b) => b.isGap)

    const inspectedCode = activeBySeries.value[key] || pinnedBySeries.value[key] || ''
    const inspectedBar = inspectedCode
      ? geometry.bars.find((b) => b.periodCode === inspectedCode) || null
      : null

    return {
      key,
      patternId: hatchPatternId(item),
      resourceType: item.resource_type,
      resourceName: resourceLabel(item.resource_type),
      unit: item.unit,
      displayUnit,
      style,
      geometry,
      hasOpenPeriod,
      hasEstimated,
      hasGap,
      inspectedBar,
    }
  })
})

function setHoveredBar(sKey, periodCode) {
  activeBySeries.value = {
    ...activeBySeries.value,
    [sKey]: periodCode,
  }
}

function clearHoveredBar(sKey) {
  if (!activeBySeries.value[sKey]) return
  const next = { ...activeBySeries.value }
  delete next[sKey]
  activeBySeries.value = next
}

function handleBarClick(sKey, periodCode) {
  const wasPinned = pinnedBySeries.value[sKey] === periodCode
  if (wasPinned) {
    const nextPinned = { ...pinnedBySeries.value }
    delete nextPinned[sKey]
    pinnedBySeries.value = nextPinned
    clearHoveredBar(sKey)
    return
  }
  pinnedBySeries.value = {
    ...pinnedBySeries.value,
    [sKey]: periodCode,
  }
  setHoveredBar(sKey, periodCode)
}

function barAccessibleLabel(bar, unit) {
  const periodText = `${formatPeriodLabel(bar.periodCode, session.lang)} (${bar.periodCode})`
  if (bar.isGap) {
    return session.t('consumptionChart.gapAriaLabel', { period: periodText })
  }
  return session.t('consumptionChart.barAriaLabel', {
    period: periodText,
    value: bar.valueStr,
    unit,
  })
}
</script>

<template>
  <section
    data-testid="consumption-chart-section"
    class="bg-surface-container-lowest border border-surface-container-high rounded-2xl p-space-md sm:p-space-lg space-y-4 shadow-2xs"
  >
    <!-- Header & Optional Controls Slot -->
    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div>
        <h2 class="font-title-md text-title-md font-bold text-on-surface flex items-center gap-2">
          <span class="material-symbols-outlined text-[20px] text-primary">bar_chart</span>
          <span>{{ resolvedTitle }}</span>
        </h2>
        <p class="text-xs text-on-surface-variant mt-0.5">
          {{ subtitle || session.t('consumptionChart.sectionSubtitle') }}
        </p>
      </div>
      <slot name="actions" />
    </div>

    <!-- Error State -->
    <ErrorCard
      v-if="error"
      data-testid="consumption-chart-error"
      :error="error"
      @retry="emit('retry')"
    />

    <!-- Loading Skeleton -->
    <div
      v-else-if="loading"
      data-testid="consumption-chart-loading"
      class="grid grid-cols-1 xl:grid-cols-2 gap-4"
    >
      <div
        v-for="i in 2"
        :key="i"
        class="p-4 rounded-xl bg-surface-container-low/60 border border-surface-container animate-pulse space-y-3"
      >
        <div class="h-4 bg-surface-container-high rounded w-1/3"></div>
        <div class="h-36 bg-surface-container rounded w-full"></div>
      </div>
    </div>

    <!-- No Series Empty State -->
    <div
      v-else-if="charts.length === 0"
      data-testid="consumption-chart-empty"
      class="bg-surface-container-low rounded-xl p-6 text-center text-xs text-on-surface-variant"
    >
      {{ emptyText || session.t('consumptionChart.noSeries') }}
    </div>

    <!-- Per-Resource Charts -->
    <div
      v-else
      class="grid grid-cols-1 xl:grid-cols-2 gap-4"
    >
      <article
        v-for="chart in charts"
        :key="chart.key"
        :data-testid="`consumption-chart-card-${chart.resourceType}`"
        class="rounded-xl bg-surface-container-low/40 border border-surface-container p-3.5 sm:p-4 space-y-3 min-w-0"
      >
        <!-- Series Title & Legend -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0"
              :class="chart.style.dotClass"
            />
            <h3 class="font-bold text-sm text-on-surface truncate">
              {{ chart.resourceName }}
            </h3>
            <span class="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-md border" :class="chart.style.badgeClass">
              {{ chart.displayUnit }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2.5 text-[10px] font-medium text-on-surface-variant">
            <span class="inline-flex items-center gap-1">
              <span class="w-2.5 h-2.5 rounded-[2px]" :class="chart.style.dotClass" />
              <span>{{ session.t('consumptionChart.confirmed') }}</span>
            </span>
            <span v-if="chart.hasEstimated" class="inline-flex items-center gap-1">
              <span
                class="w-2.5 h-2.5 rounded-[2px] border-2 bg-transparent"
                :style="{ borderColor: chart.style.strokeHex, backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 2px, ${chart.style.strokeHex}55 2px, ${chart.style.strokeHex}55 4px)` }"
              />
              <span>{{ session.t('consumptionChart.estimated') }}</span>
            </span>
            <span v-if="chart.hasGap" class="inline-flex items-center gap-1">
              <span class="w-2.5 h-2.5 rounded-[2px] border border-dashed border-on-surface-variant/60" />
              <span>{{ session.t('consumptionChart.noReading') }}</span>
            </span>
            <span v-if="chart.hasOpenPeriod" class="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-semibold">
              <span class="w-2 h-2 rounded-full bg-amber-500" />
              <span>{{ session.t('consumptionChart.inProgress') }}</span>
            </span>
          </div>
        </div>

        <!-- Exact Tooltip / Readout Bar -->
        <div
          :data-testid="`chart-tooltip-${chart.resourceType}`"
          class="min-h-[34px] px-3 py-1.5 rounded-lg bg-surface-container-lowest border border-surface-container flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <template v-if="chart.inspectedBar">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-on-surface">
                {{ formatPeriodLabel(chart.inspectedBar.periodCode, session.lang) }}
              </span>
              <span class="font-mono text-[11px] text-on-surface-variant">
                ({{ chart.inspectedBar.periodCode }})
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-if="chart.inspectedBar.isGap"
                data-testid="chart-tooltip-gap"
                class="font-medium text-on-surface-variant italic"
              >
                {{ session.t('consumptionChart.noReading') }}
              </span>
              <span
                v-else
                data-testid="chart-tooltip-value"
                class="font-mono font-bold text-on-surface tabular-nums"
              >
                {{ chart.inspectedBar.valueStr }} {{ chart.displayUnit }}
              </span>

              <span
                v-if="chart.inspectedBar.apartmentsCounted !== null && !chart.inspectedBar.isGap"
                class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-[10px] font-semibold font-mono tabular-nums"
              >
                {{ session.t('consumptionChart.apartmentsCountedBadge', { count: chart.inspectedBar.apartmentsCounted }) }}
              </span>
              <span
                v-if="chart.inspectedBar.estimated"
                class="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 text-[10px] font-semibold"
              >
                {{
                  chart.inspectedBar.estimatedReadings > 0
                    ? session.t('consumptionChart.estimatedCountBadge', { count: chart.inspectedBar.estimatedReadings })
                    : session.t('consumptionChart.estimated')
                }}
              </span>
              <span
                v-if="chart.inspectedBar.isOpen"
                class="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-800 dark:text-sky-300 text-[10px] font-semibold"
              >
                {{ session.t('consumptionChart.inProgress') }}
              </span>
              <span
                v-if="chart.inspectedBar.isNegative"
                class="px-1.5 py-0.5 rounded bg-error/15 text-error text-[10px] font-semibold"
              >
                {{ session.t('consumptionChart.negativeCorrection') }}
              </span>
            </div>
          </template>
          <span v-else class="text-[11px] text-on-surface-variant">
            {{
              chart.geometry.hasAnyData
                ? session.t('consumptionChart.selectMonthHint')
                : session.t('consumptionChart.emptySeries')
            }}
          </span>
        </div>

        <!-- Responsive SVG Bar Chart (zero page horizontal overflow) -->
        <div class="w-full overflow-hidden">
          <svg
            :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
            class="w-full h-auto block select-none"
            role="img"
            :aria-label="`${chart.resourceName} (${chart.displayUnit})`"
            @mouseleave="clearHoveredBar(chart.key)"
          >
            <defs>
              <pattern
                :id="chart.patternId"
                width="6"
                height="6"
                patternTransform="rotate(45 0 0)"
                patternUnits="userSpaceOnUse"
              >
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  :stroke="chart.style.strokeHex"
                  stroke-width="2"
                  stroke-opacity="0.55"
                />
              </pattern>
            </defs>

            <!-- Y-axis gridlines & labels -->
            <g v-for="tick in chart.geometry.ticks" :key="tick.value">
              <line
                :x1="chart.geometry.plotLeft"
                :x2="chart.geometry.plotRight"
                :y1="tick.y"
                :y2="tick.y"
                :stroke="tick.isZero ? 'currentColor' : 'currentColor'"
                :stroke-opacity="tick.isZero ? 0.35 : 0.1"
                :stroke-dasharray="tick.isZero ? undefined : '3 3'"
                stroke-width="1"
              />
              <text
                :x="chart.geometry.plotLeft - 6"
                :y="tick.y + 3"
                text-anchor="end"
                class="fill-on-surface-variant font-mono"
                font-size="10"
              >
                {{ tick.label }}
              </text>
            </g>

            <!-- Y-axis unit label -->
            <text
              :x="chart.geometry.plotLeft - 6"
              y="11"
              text-anchor="end"
              class="fill-on-surface-variant font-semibold"
              font-size="9"
            >
              {{ chart.displayUnit }}
            </text>

            <!-- Month Bars / Gaps -->
            <g
              v-for="bar in chart.geometry.bars"
              :key="bar.periodCode"
              :data-testid="`chart-bar-${chart.resourceType}-${bar.periodCode}`"
              role="button"
              tabindex="0"
              :aria-pressed="pinnedBySeries[chart.key] === bar.periodCode ? 'true' : 'false'"
              :aria-label="barAccessibleLabel(bar, chart.displayUnit)"
              class="cursor-pointer outline-none [&:focus-visible_.bar-focus-ring]:opacity-100"
              @mouseenter="setHoveredBar(chart.key, bar.periodCode)"
              @focus="setHoveredBar(chart.key, bar.periodCode)"
              @blur="clearHoveredBar(chart.key)"
              @click="handleBarClick(chart.key, bar.periodCode)"
              @keydown.enter.prevent="handleBarClick(chart.key, bar.periodCode)"
              @keydown.space.prevent="handleBarClick(chart.key, bar.periodCode)"
            >
              <!-- Full-height hover hitbox -->
              <rect
                :x="bar.hitX"
                :y="chart.geometry.plotTop"
                :width="bar.hitWidth"
                :height="chart.geometry.plotBottom - chart.geometry.plotTop"
                fill="currentColor"
                :fill-opacity="chart.inspectedBar?.periodCode === bar.periodCode ? 0.06 : 0"
                rx="4"
              />

              <!-- Accessible SVG focus ring on keyboard focus-visible -->
              <rect
                :x="bar.hitX + 1"
                :y="chart.geometry.plotTop + 1"
                :width="Math.max(4, bar.hitWidth - 2)"
                :height="Math.max(4, chart.geometry.plotBottom - chart.geometry.plotTop - 2)"
                rx="4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="bar-focus-ring opacity-0 pointer-events-none text-primary transition-opacity"
              />

              <!-- Gap (consumption === null) - never drawn as 0 -->
              <rect
                v-if="bar.isGap"
                :x="bar.x"
                :y="bar.y"
                :width="bar.width"
                :height="bar.height"
                rx="2"
                fill="none"
                stroke="currentColor"
                stroke-opacity="0.35"
                stroke-dasharray="2 2"
                stroke-width="1.2"
              />

              <!-- Estimated Reading: Hollow + Diagonal Hatch -->
              <rect
                v-else-if="bar.estimated"
                :x="bar.x"
                :y="bar.y"
                :width="bar.width"
                :height="bar.height"
                rx="3"
                :fill="`url(#${chart.patternId})`"
                :class="chart.style.strokeClass"
                stroke-width="1.75"
              />

              <!-- Confirmed Reading (including 0.000 or negative correction) -->
              <rect
                v-else
                :x="bar.x"
                :y="bar.y"
                :width="bar.width"
                :height="bar.height"
                rx="3"
                :class="bar.isNegative ? 'fill-error/80' : chart.style.barClass"
                :stroke="bar.isOpen ? 'currentColor' : 'none'"
                :stroke-dasharray="bar.isOpen ? '3 2' : undefined"
                :stroke-width="bar.isOpen ? 1.5 : 0"
              />

              <!-- Open-month indicator dot above bar/gap -->
              <circle
                v-if="bar.isOpen"
                :cx="bar.centerX"
                :cy="chart.geometry.plotTop - 6"
                r="3"
                class="fill-amber-500"
              />

              <!-- X-axis period tick -->
              <text
                v-if="bar.showXLabel"
                :x="bar.centerX"
                :y="chart.geometry.plotBottom + 15"
                text-anchor="middle"
                :class="bar.isOpen ? 'fill-amber-700 dark:fill-amber-300 font-bold font-mono' : 'fill-on-surface-variant font-mono'"
                font-size="9.5"
              >
                {{ formatCompactPeriodTick(bar.periodCode) }}
              </text>

              <!-- Compact Open-month marker beneath tick -->
              <text
                v-if="bar.showOpenText"
                :x="bar.centerX"
                :y="chart.geometry.plotBottom + 28"
                text-anchor="middle"
                class="fill-amber-700 dark:fill-amber-300 font-semibold"
                font-size="8.5"
              >
                {{ session.t('consumptionChart.inProgress') }}
              </text>
            </g>
          </svg>
        </div>
      </article>
    </div>
  </section>
</template>
