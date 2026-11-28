<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { isSupportedBuildingFacts } from '@/utils/buildingPassport.js'
import { OBJECT_KINDS, formatObjectArea, objectKindPluralLabel } from '@/utils/objectName.js'
import EeBuildingFacts from './countries/EeBuildingFacts.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const session = useSessionStore()
const { buildingRole } = useRole()

const facts = computed(() => session.buildingRegistryFacts)
const supportedFacts = computed(() =>
  isSupportedBuildingFacts(facts.value) ? facts.value : null,
)
const isChairman = computed(() => buildingRole.value === 'CHAIRMAN')
const isInitialLoading = computed(
  () => (session.meLoading || session.buildingLoading) && !session.building && !session.buildingError,
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

const buildingHeatedAreaText = computed(() =>
  formatObjectArea(session.building?.heated_area_m2),
)

const showObjectsSummary = computed(
  () =>
    Boolean(session.building) &&
    (objectCountEntries.value.length > 0 ||
      Boolean(buildingHeatedAreaText.value) ||
      session.building?.entrance_count != null),
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-lg">
    <header class="mb-space-lg">
      <div class="flex items-center gap-2 text-xs mb-1">
        <span class="font-label-md text-label-md uppercase tracking-wider text-secondary font-semibold">
          {{ session.t('buildingPassport.kicker') }}
        </span>
      </div>
      <h1 class="font-headline-xl text-headline-xl text-on-surface tracking-tight">
        {{ session.t('buildingPassport.title') }}
      </h1>
      <p class="font-body-md text-body-md text-on-surface-variant mt-1">
        <template v-if="session.building?.address">{{ session.building.address }} · </template>{{ session.t('buildingPassport.subtitle') }}
      </p>
    </header>

    <div v-if="isInitialLoading" data-testid="building-passport-skeleton">
      <BaseSkeleton :lines="6" />
    </div>

    <ErrorCard
      v-else-if="session.buildingError && !session.building"
      data-testid="building-passport-error"
      :error="session.buildingError"
      @retry="session.refreshBuilding"
    />

    <template v-else>
      <section
        v-if="showObjectsSummary"
        data-testid="building-objects-summary"
        class="mb-space-lg bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-lg space-y-3"
      >
        <h2 class="font-label-lg text-sm font-bold text-on-surface">
          {{ session.t('buildingPassport.objectsHeading') }}
        </h2>

        <div class="flex flex-wrap items-stretch gap-3">
          <div
            v-for="entry in objectCountEntries"
            :key="entry.kind"
            :data-testid="`building-object-count-${entry.kind}`"
            class="min-w-[120px] rounded-lg bg-surface-container-low border border-surface-container px-3.5 py-2.5 flex flex-col"
          >
            <span class="text-xs text-on-surface-variant">{{ entry.label }}</span>
            <span class="font-headline-md text-lg font-bold text-on-surface font-numeric-display tabular-nums">
              {{ entry.count }}
            </span>
          </div>

          <div
            v-if="session.building?.entrance_count != null"
            data-testid="building-entrances-count"
            class="min-w-[140px] rounded-lg bg-surface-container-low border border-surface-container px-3.5 py-2.5 flex flex-col"
          >
            <span class="text-xs text-on-surface-variant">
              {{ session.t('buildingPassport.entrancesLabel') }}
            </span>
            <span class="font-headline-md text-lg font-bold text-on-surface font-numeric-display tabular-nums">
              {{ session.building.entrance_count }}
            </span>
          </div>

          <div
            v-if="buildingHeatedAreaText"
            data-testid="building-heated-area"
            class="min-w-[160px] rounded-lg bg-surface-container-low border border-surface-container px-3.5 py-2.5 flex flex-col"
          >
            <span class="text-xs text-on-surface-variant">
              {{ session.t('buildingPassport.heatedAreaLabel') }}
            </span>
            <span class="font-headline-md text-lg font-bold text-on-surface font-numeric-display tabular-nums">
              {{ buildingHeatedAreaText }}
            </span>
          </div>
        </div>

        <p
          data-testid="building-apartments-only-note"
          class="text-xs text-on-surface-variant"
        >
          {{ session.t('buildingPassport.apartmentsOnlyNote') }}
        </p>
      </section>

      <EeBuildingFacts
        v-if="supportedFacts"
        :facts="supportedFacts"
      />

      <section
        v-else
        data-testid="building-passport-empty"
        class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-xl text-center max-w-2xl mx-auto"
      >
      <div class="w-12 h-12 rounded-2xl bg-surface-container text-primary flex items-center justify-center mx-auto mb-space-md">
        <span class="material-symbols-outlined text-[26px]">apartment</span>
      </div>
      <h2 class="font-headline-md text-lg font-bold text-on-surface">
        {{ session.t('buildingPassport.emptyTitle') }}
      </h2>
      <p class="font-body-md text-sm text-on-surface-variant mt-2">
        {{ session.t('buildingPassport.emptyBody') }}
      </p>

      <div v-if="isChairman" class="mt-space-lg pt-space-md border-t border-surface-container flex flex-col items-center gap-space-sm">
        <p class="text-xs text-on-surface-variant">
          {{ session.t('buildingPassport.emptyChairmanHint') }}
        </p>
        <RouterLink
          data-testid="building-open-settings-link"
          to="/settings/association#building-register"
          class="inline-flex items-center gap-2 px-space-md py-space-sm rounded-lg bg-primary text-on-primary hover:bg-primary-container text-sm font-semibold transition-colors"
        >
          <span class="material-symbols-outlined text-[18px]">settings</span>
          <span>{{ session.t('buildingPassport.emptyOpenSettingsBtn') }}</span>
        </RouterLink>
      </div>
    </section>
    </template>
  </div>
</template>
