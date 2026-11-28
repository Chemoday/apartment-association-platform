<script setup>
import { useSessionStore } from '@/stores/session.js'
import { formatIncompleteBalanceMessage } from '@/utils/matrixStarts.js'
import MeterValueText from '@/components/domain/MeterValueText.vue'

defineProps({
  balances: {
    type: Array,
    default: () => [],
  },
  masterMeters: {
    type: Array,
    default: () => [],
  },
  periodCode: {
    type: String,
    required: true,
  },
  filteredByKind: {
    type: Boolean,
    default: false,
  },
})

const session = useSessionStore()

function resourceLabel(resourceType) {
  const key = `resources.${resourceType}`
  const translated = session.t(key)
  return translated && translated !== key ? translated : resourceType
}

function unitLabel(unit) {
  const key = `units.${unit}`
  const translated = session.t(key)
  if (translated && translated !== key) return translated
  return unit === 'm3' ? 'm³' : unit
}
</script>

<template>
  <div class="space-y-space-lg">
    <!-- Real API Resource Balances Table -->
    <div class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-2xs overflow-hidden">
      <div class="px-space-lg py-3 bg-surface-container-low/80 border-b border-surface-container flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="font-label-lg text-label-lg font-bold text-on-surface">
            {{ session.t('accounting.balanceTableTitle') }}
          </h3>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('accounting.balanceTableSub', { period: periodCode }) }}
          </p>
        </div>
        <span
          data-testid="balance-whole-building-badge"
          class="inline-flex items-center gap-1 rounded-full bg-surface-container px-2.5 py-0.5 text-[11px] font-semibold text-on-surface-variant"
        >
          <span class="material-symbols-outlined text-[13px]" aria-hidden="true">domain</span>
          <span>{{ session.t('accounting.wholeBuildingBalancesBadge') }}</span>
        </span>
      </div>

      <div
        v-if="balances.length === 0"
        data-testid="balance-table-empty"
        class="p-space-lg text-center text-sm text-on-surface-variant"
      >
        {{ session.t('accounting.noBalancesDesc') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-left font-body-sm text-body-sm">
          <thead class="bg-surface-container/60 text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-surface-container">
            <tr>
              <th class="py-3 px-space-md">{{ session.t('accounting.colResource') }}</th>
              <th class="py-3 px-space-md text-right">{{ session.t('accounting.colMasterTotal') }}</th>
              <th class="py-3 px-space-md text-right">{{ session.t('accounting.colApartmentsSum') }}</th>
              <th class="py-3 px-space-md text-right">{{ session.t('accounting.colUnallocatedLoss') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-container">
            <tr
              v-for="b in balances"
              :key="`${b.resource_type}-${b.unit}`"
              class="hover:bg-surface-container-low/50"
            >
              <td class="py-3.5 px-space-md font-semibold text-on-surface align-top">
                <div>{{ resourceLabel(b.resource_type) }}</div>
                <div
                  v-if="Number(b.starting_meters) > 0"
                  data-testid="balance-row-incomplete"
                  class="mt-1 inline-flex items-start gap-1 px-2 py-0.5 rounded bg-amber-100/80 dark:bg-amber-950/50 text-amber-950 dark:text-amber-200 text-[11px] font-medium leading-snug"
                >
                  <span class="material-symbols-outlined text-[14px] shrink-0 mt-px">flag</span>
                  <span>{{ formatIncompleteBalanceMessage(b.starting_meters, session.t, session.lang) }}</span>
                </div>
              </td>
              <td class="py-3.5 px-space-md text-right align-top">
                <MeterValueText v-if="b.master_total !== null" :value="b.master_total" :unit="b.unit" />
                <span
                  v-else
                  data-testid="balance-row-awaiting-master"
                  class="text-xs text-on-surface-variant italic"
                >
                  {{ session.t('accounting.awaitingMasterReading') }}
                </span>
              </td>
              <td class="py-3.5 px-space-md text-right align-top">
                <MeterValueText :value="b.apartments_sum" :unit="b.unit" />
              </td>
              <td class="py-3.5 px-space-md text-right align-top">
                <span
                  v-if="b.unallocated_loss !== null"
                  class="font-mono tabular-nums font-bold"
                  :class="b.unallocated_loss.startsWith('-') ? 'text-error' : 'text-on-surface'"
                >
                  {{ b.unallocated_loss }} {{ unitLabel(b.unit) }}
                </span>
                <span v-else class="text-xs text-on-surface-variant italic">
                  {{ session.t('accounting.awaitingMasterReading') }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Clearly Labelled Phase 2 Billing Demo Content (per FRONTEND_CONVENTIONS.md Section 4) -->
    <div class="rounded-xl bg-surface-container-lowest border border-surface-container p-space-lg shadow-2xs">
      <div class="flex items-center justify-between mb-space-md">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-secondary">receipt_long</span>
          <h3 class="font-headline-md text-headline-md font-bold text-on-surface">
            {{ session.t('accounting.tariffsPreviewTitle') }}
          </h3>
          <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-label-md text-[10px] uppercase font-bold tracking-wider">
            Phase 2 Demo
          </span>
        </div>
      </div>

      <p class="font-body-sm text-body-sm text-on-surface-variant mb-space-md">
        {{ session.t('accounting.tariffsPreviewDesc') }}
      </p>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-space-md">
        <div class="p-space-md rounded-lg bg-surface-container-low border border-surface-container">
          <span class="font-label-md text-xs text-on-surface-variant uppercase">Tallinna Vesi Tariff (Demo)</span>
          <p class="font-numeric-display tabular-nums text-lg font-bold text-on-surface mt-1">€2.14 / m³</p>
          <span class="text-xs text-on-surface-variant">Cold water + sewerage</span>
        </div>
        <div class="p-space-md rounded-lg bg-surface-container-low border border-surface-container">
          <span class="font-label-md text-xs text-on-surface-variant uppercase">Utilitas District Heat (Demo)</span>
          <p class="font-numeric-display tabular-nums text-lg font-bold text-on-surface mt-1">€84.50 / MWh</p>
          <span class="text-xs text-on-surface-variant">Water heating + radiators</span>
        </div>
        <div class="p-space-md rounded-lg bg-surface-container-low border border-surface-container">
          <span class="font-label-md text-xs text-on-surface-variant uppercase">Loss Allocation Rule (Demo)</span>
          <p class="font-numeric-display tabular-nums text-lg font-bold text-on-surface mt-1">Proportional m²</p>
          <span class="text-xs text-on-surface-variant">2,480 m² total heated area</span>
        </div>
      </div>
    </div>
  </div>
</template>
