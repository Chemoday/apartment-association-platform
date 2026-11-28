<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  formatRegisterInt,
  getPrimaryEnergyClass,
  isSupportedBuildingFacts,
} from '@/utils/buildingPassport.js'
import { OBJECT_KINDS, objectKindPluralLabel } from '@/utils/objectName.js'

const session = useSessionStore()

const facts = computed(() => session.buildingRegistryFacts)
const isVisible = computed(() => isSupportedBuildingFacts(facts.value))

const firstUseYear = computed(() =>
  isVisible.value ? formatRegisterInt(facts.value.building?.first_use_year) : '-',
)
const floorsDisplay = computed(() =>
  isVisible.value ? formatRegisterInt(facts.value.building?.floors_max) : '-',
)
const energyClass = computed(() =>
  isVisible.value ? getPrimaryEnergyClass(facts.value) : null,
)
const objectCountEntries = computed(() => {
  const counts = session.building?.object_counts
  if (!counts || typeof counts !== 'object') return []
  return OBJECT_KINDS
    .map((kind) => ({
      kind,
      count: Number(counts[kind] || 0),
      label: objectKindPluralLabel(kind, session.t),
    }))
    .filter((entry) => entry.count > 0)
})
</script>

<template>
  <RouterLink
    v-if="isVisible"
    to="/building"
    data-testid="dashboard-building-card"
    class="block bg-surface-container-lowest rounded-xl p-space-md sm:p-space-lg shadow-xs border border-surface-container hover:border-primary/40 hover:shadow-sm transition-all group"
  >
    <div class="flex flex-wrap items-center justify-between gap-space-md">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-xl bg-surface-container text-primary group-hover:bg-primary group-hover:text-on-primary transition-colors flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[20px]">apartment</span>
        </div>
        <div class="min-w-0">
          <span class="font-label-md text-[11px] uppercase tracking-wider text-secondary font-bold block">
            {{ session.t('buildingPassport.dashboardCard.kicker') }}
          </span>
          <h3 class="font-title-sm text-base font-bold text-on-surface group-hover:text-primary transition-colors truncate">
            {{ session.t('buildingPassport.dashboardCard.title') }} · {{ session.buildingAddress }}
          </h3>
        </div>
      </div>

      <span class="inline-flex items-center gap-1 text-xs font-semibold text-primary shrink-0">
        <span>{{ session.t('buildingPassport.dashboardCard.openPassportBtn') }}</span>
        <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
      </span>
    </div>

    <div class="grid grid-cols-3 gap-space-md mt-space-md pt-space-md border-t border-surface-container">
      <div>
        <span class="text-xs text-on-surface-variant block">
          {{ session.t('buildingPassport.dashboardCard.firstUseYear') }}
        </span>
        <span
          data-testid="dashboard-building-year"
          class="text-base font-bold text-on-surface font-numeric-display"
        >
          {{ firstUseYear }}
        </span>
      </div>
      <div>
        <span class="text-xs text-on-surface-variant block">
          {{ session.t('buildingPassport.dashboardCard.floors') }}
        </span>
        <span
          data-testid="dashboard-building-floors"
          class="text-base font-bold text-on-surface font-numeric-display"
        >
          {{ floorsDisplay }}
        </span>
      </div>
      <div>
        <span class="text-xs text-on-surface-variant block">
          {{ session.t('buildingPassport.dashboardCard.energyClass') }}
        </span>
        <span
          data-testid="dashboard-building-energy"
          class="inline-flex items-center px-2 py-0.5 mt-0.5 rounded bg-secondary-container text-on-secondary-container text-xs font-bold"
        >
          {{ energyClass || session.t('buildingPassport.dashboardCard.noEnergyClass') }}
        </span>
      </div>
    </div>

    <div
      v-if="objectCountEntries.length > 0"
      data-testid="dashboard-building-object-counts"
      class="flex flex-wrap items-center gap-2 mt-space-sm pt-space-sm border-t border-surface-container"
    >
      <span
        v-for="entry in objectCountEntries"
        :key="entry.kind"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-low text-xs text-on-surface-variant font-medium"
      >
        <strong class="text-on-surface font-mono tabular-nums">{{ entry.count }}</strong>
        <span>{{ entry.label }}</span>
      </span>
    </div>
  </RouterLink>
</template>
