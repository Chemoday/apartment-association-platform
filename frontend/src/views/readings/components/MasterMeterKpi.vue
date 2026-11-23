<script setup>
import { computed, ref } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  formatIncompleteBalanceMessage,
  summarizeWaterBalance,
} from '@/utils/matrixStarts.js'
import BaseModal from '@/components/base/BaseModal.vue'
import MeterCard from './MeterCard.vue'

const props = defineProps({
  balances: {
    type: Array,
    default: () => [],
  },
  masterMeters: {
    type: Array,
    default: () => [],
  },
  apartments: {
    type: Array,
    default: () => [],
  },
  periodCode: {
    type: String,
    required: true,
  },
  periodStatus: {
    type: String,
    default: 'OPEN_FOR_RESIDENTS',
  },
})

const emit = defineEmits(['master-saved', 'open-history'])

const session = useSessionStore()
const { canSubmitAnyMeter } = useRole()
const masterModalOpen = ref(false)

const waterBalance = computed(() => summarizeWaterBalance(props.balances))

const hasBuildingMeters = computed(
  () => props.masterMeters.length > 0 || props.balances.length > 0,
)

const displayUnit = computed(() => {
  const code = waterBalance.value?.unitCode || 'm3'
  const key = `units.${code}`
  const translated = session.t(key)
  if (translated && translated !== key) return translated
  return waterBalance.value?.unit || 'm³'
})

const totalStartingMeters = computed(() => waterBalance.value?.totalStartingMeters ?? 0)

const incompleteBalanceText = computed(() =>
  formatIncompleteBalanceMessage(totalStartingMeters.value, session.t, session.lang),
)

const counts = computed(() => {
  const total = props.apartments.length
  let submitted = 0
  let missing = 0
  let estimated = 0
  let anomaly = 0

  for (const apt of props.apartments) {
    if (apt.status === 'SUBMITTED') submitted += 1
    else if (apt.status === 'MISSING') missing += 1
    else if (apt.status === 'AUTO_ESTIMATED') estimated += 1
    else if (apt.status === 'ANOMALY_CONFIRMED') anomaly += 1
  }

  const reportedPct = total > 0 ? Math.round(((total - missing) / total) * 1000) / 10 : 100

  return {
    total,
    submitted,
    missing,
    estimated,
    anomaly,
    attention: missing + estimated + anomaly,
    reportedPct,
  }
})

function handleMasterSaved(reading) {
  emit('master-saved', reading)
}
</script>

<template>
  <div>
    <!-- CLEAN KPI STRIP (4 cards in one row matching chairman_view_streamlined_meter_matrix_accounting) -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md mb-space-md">
      <!-- 1. Basement Intake (Main) -->
      <div class="p-space-md rounded-xl bg-surface-container-lowest border border-surface-container shadow-2xs flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant">
          <span class="font-label-md text-label-md uppercase tracking-wider font-semibold">
            {{ session.t('masterKpi.basementIntake') }}
          </span>
          <span class="material-symbols-outlined text-[20px] text-surface-tint">water_drop</span>
        </div>
        <div class="mt-2 flex items-baseline gap-2">
          <span
            data-testid="master-kpi-intake-value"
            class="font-numeric-display tabular-nums text-[1.65rem] font-bold text-on-surface"
          >
            {{ waterBalance?.master_total ?? '—' }}
          </span>
          <span
            v-if="waterBalance?.master_total !== null && waterBalance?.master_total !== undefined"
            class="text-on-surface-variant font-label-md text-[13px]"
          >
            {{ displayUnit }}
          </span>
        </div>
        <div class="mt-1 flex items-center justify-between text-[12px]">
          <span class="text-on-surface-variant font-label-md">
            {{ session.t('masterKpi.masterMetersCount', { count: masterMeters.length }) }}
          </span>
          <button
            v-if="canSubmitAnyMeter && masterMeters.length > 0"
            type="button"
            data-testid="master-kpi-edit-btn"
            class="text-secondary font-semibold hover:underline"
            @click="masterModalOpen = true"
          >
            {{ session.t('masterKpi.editMasterLink') }}
          </button>
        </div>
      </div>

      <!-- 2. Subtotal Submitted -->
      <div class="p-space-md rounded-xl bg-surface-container-lowest border border-surface-container shadow-2xs flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant">
          <span class="font-label-md text-label-md uppercase tracking-wider font-semibold">
            {{ session.t('masterKpi.subtotalSubmitted') }}
          </span>
          <span class="material-symbols-outlined text-[20px] text-secondary">fact_check</span>
        </div>
        <div class="mt-2 flex items-baseline gap-2">
          <span
            data-testid="master-kpi-subtotal-value"
            class="font-numeric-display tabular-nums text-[1.65rem] font-bold text-on-surface"
          >
            {{ waterBalance?.apartments_sum ?? '—' }}
          </span>
          <span
            v-if="waterBalance?.apartments_sum !== null && waterBalance?.apartments_sum !== undefined"
            class="text-on-surface-variant font-label-md text-[13px]"
          >
            {{ displayUnit }}
          </span>
        </div>
        <span class="mt-1 text-secondary font-label-md text-[12px] font-medium">
          {{ session.t('masterKpi.reportedPct', { pct: counts.reportedPct }) }} •
          {{ session.t('masterKpi.pendingCount', { count: counts.missing }) }}
        </span>
      </div>

      <!-- 3. Building Delta (Üldvesi) -->
      <div class="p-space-md rounded-xl bg-surface-container-lowest border border-surface-container shadow-2xs flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant">
          <span class="font-label-md text-label-md uppercase tracking-wider font-semibold">
            {{ session.t('masterKpi.buildingDelta') }}
          </span>
          <span class="material-symbols-outlined text-[20px] text-surface-tint">difference</span>
        </div>
        <div class="mt-2 flex items-baseline gap-2">
          <span
            data-testid="master-kpi-loss-value"
            class="font-numeric-display tabular-nums text-[1.65rem] font-bold"
            :class="waterBalance?.isNegativeLoss ? 'text-error' : 'text-on-surface'"
          >
            {{ waterBalance?.unallocated_loss ?? '—' }}
          </span>
          <span
            v-if="waterBalance?.unallocated_loss !== null && waterBalance?.unallocated_loss !== undefined"
            class="text-on-surface-variant font-label-md text-[13px]"
          >
            {{ displayUnit }}
          </span>
        </div>
        <span
          v-if="waterBalance?.unallocated_loss !== null && waterBalance?.unallocated_loss !== undefined"
          class="mt-1 text-on-surface-variant font-label-md text-[12px]"
        >
          <template v-if="waterBalance?.lossPercentage">
            <strong class="text-on-surface">{{ waterBalance.lossPercentage }}</strong> •
          </template>
          {{
            waterBalance?.isNegativeLoss
              ? session.t('masterKpi.negativeLossWarning')
              : session.t('masterKpi.withinNorm')
          }}
        </span>
        <span
          v-else-if="!hasBuildingMeters"
          data-testid="master-kpi-no-meters"
          class="mt-1 text-on-surface-variant font-label-md text-[12px] italic"
        >
          {{ session.t('masterKpi.noBuildingMeters') }}
        </span>
        <span
          v-else
          data-testid="master-kpi-awaiting"
          class="mt-1 text-on-surface-variant font-label-md text-[12px] italic"
        >
          {{ session.t('accounting.awaitingMasterReading') }}
        </span>
      </div>

      <!-- 4. Needs Attention -->
      <div class="p-space-md rounded-xl bg-surface-container-lowest border border-surface-container shadow-2xs flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant">
          <span class="font-label-md text-label-md uppercase tracking-wider font-semibold">
            {{ session.t('masterKpi.needsAttention') }}
          </span>
          <span class="material-symbols-outlined text-[20px] text-error">notification_important</span>
        </div>
        <div class="mt-2 flex items-baseline gap-2">
          <span class="font-numeric-display tabular-nums text-[1.65rem] font-bold text-error">
            {{ session.t('masterKpi.unitsCount', { count: counts.attention }) }}
          </span>
        </div>
        <span class="mt-1 text-on-surface-variant font-label-md text-[12px]">
          {{
            session.t('masterKpi.attentionBreakdown', {
              anomaly: counts.anomaly,
              estimated: counts.estimated,
              missing: counts.missing,
            })
          }}
        </span>
      </div>
    </div>

    <!-- Incomplete Balance Notice when starting_meters > 0 (#039) -->
    <div
      v-if="incompleteBalanceText"
      data-testid="balance-incomplete-banner"
      role="status"
      class="mb-space-lg px-3.5 py-2.5 rounded-xl bg-amber-100/75 dark:bg-amber-950/45 border border-amber-300/70 text-amber-950 dark:text-amber-200 text-xs font-medium flex items-center gap-2"
    >
      <span class="material-symbols-outlined text-[18px] shrink-0">flag</span>
      <span>{{ incompleteBalanceText }}</span>
    </div>
    <div v-else class="mb-space-sm" />

    <!-- Modal to submit/override Building Master Meters -->
    <BaseModal
      :open="masterModalOpen"
      :title="session.t('masterKpi.masterModalTitle')"
      :subtitle="session.t('masterKpi.masterModalSubtitle', { period: periodCode })"
      max-width="max-w-2xl"
      @close="masterModalOpen = false"
    >
      <div class="grid grid-cols-1 gap-space-md">
        <MeterCard
          v-for="mm in masterMeters"
          :key="mm.meter_id"
          :meter="mm"
          :period-code="periodCode"
          :period-status="periodStatus"
          :can-submit="canSubmitAnyMeter"
          @saved="handleMasterSaved"
          @open-history="(id, label) => $emit('open-history', id, label)"
        />
      </div>
    </BaseModal>
  </div>
</template>
