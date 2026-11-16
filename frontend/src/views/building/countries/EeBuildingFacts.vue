<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { formatCalendarDate, formatDateTime } from '@/utils/dates.js'
import {
  formatRegisterDecimal,
  formatRegisterInt,
  formatRegisterText,
  resolveCertValueTypeLabel,
  resolveClassifiedLabel,
  resolveUnitKindLabel,
} from '@/utils/buildingPassport.js'

const props = defineProps({
  facts: {
    type: Object,
    required: true,
  },
  compact: {
    type: Boolean,
    default: false,
  },
})

const session = useSessionStore()
const t = (key, params) => session.t(key, params)

const building = computed(() => props.facts?.building || {})
const source = computed(() => props.facts?.source || {})
const units = computed(() => (Array.isArray(props.facts?.units) ? props.facts.units : []))
const energyCertificates = computed(() =>
  Array.isArray(props.facts?.energy_certificates) ? props.facts.energy_certificates : [],
)
const technicalItems = computed(() =>
  Array.isArray(props.facts?.technical) ? props.facts.technical : [],
)
const cadastralUnits = computed(() =>
  Array.isArray(props.facts?.cadastral_units) ? props.facts.cadastral_units : [],
)

const basicRows = computed(() => {
  const b = building.value
  return [
    {
      id: 'building_code',
      label: t('buildingPassport.sections.basics.buildingCode'),
      value: formatRegisterText(source.value?.building_code),
      mono: true,
    },
    {
      id: 'first_use_year',
      label: t('buildingPassport.sections.basics.firstUseYear'),
      value: formatRegisterInt(b.first_use_year),
      numeric: true,
    },
    {
      id: 'purpose',
      label: t('buildingPassport.sections.basics.purpose'),
      value: resolveClassifiedLabel(b.purpose, t),
    },
    {
      id: 'state',
      label: t('buildingPassport.sections.basics.state'),
      value: resolveClassifiedLabel(b.state, t),
    },
    {
      id: 'ownership',
      label: t('buildingPassport.sections.basics.ownership'),
      value: resolveClassifiedLabel(b.ownership, t),
    },
    {
      id: 'construction_started_on',
      label: t('buildingPassport.sections.basics.constructionStartedOn'),
      value: formatCalendarDate(b.construction_started_on, session.lang),
    },
    {
      id: 'floors_max',
      label: t('buildingPassport.sections.basics.floorsMax'),
      value: formatRegisterInt(b.floors_max),
      numeric: true,
    },
    {
      id: 'floors_min',
      label: t('buildingPassport.sections.basics.floorsMin'),
      value: formatRegisterInt(b.floors_min),
      numeric: true,
    },
    {
      id: 'lifts',
      label: t('buildingPassport.sections.basics.lifts'),
      value: formatRegisterInt(b.lifts),
      numeric: true,
    },
    {
      id: 'rooms',
      label: t('buildingPassport.sections.basics.rooms'),
      value: formatRegisterInt(b.rooms),
      numeric: true,
    },
    {
      id: 'non_residential_units',
      label: t('buildingPassport.sections.basics.nonResidentialUnits'),
      value: formatRegisterInt(b.non_residential_units),
      numeric: true,
    },
  ]
})

const areaRows = computed(() => {
  const b = building.value
  return [
    {
      id: 'closed_net_area_m2',
      label: t('buildingPassport.sections.areas.closedNetArea'),
      value: formatRegisterDecimal(b.closed_net_area_m2, 'm²'),
    },
    {
      id: 'heated_area_m2',
      label: t('buildingPassport.sections.areas.heatedArea'),
      value: formatRegisterDecimal(b.heated_area_m2, 'm²'),
    },
    {
      id: 'common_area_m2',
      label: t('buildingPassport.sections.areas.commonArea'),
      value: formatRegisterDecimal(b.common_area_m2, 'm²'),
    },
    {
      id: 'auxiliary_area_m2',
      label: t('buildingPassport.sections.areas.auxiliaryArea'),
      value: formatRegisterDecimal(b.auxiliary_area_m2, 'm²'),
    },
    {
      id: 'footprint_m2',
      label: t('buildingPassport.sections.areas.footprint'),
      value: formatRegisterDecimal(b.footprint_m2, 'm²'),
    },
    {
      id: 'volume_m3',
      label: t('buildingPassport.sections.areas.volume'),
      value: formatRegisterDecimal(b.volume_m3, 'm³'),
    },
    {
      id: 'height_m',
      label: t('buildingPassport.sections.areas.height'),
      value: formatRegisterDecimal(b.height_m, 'm'),
    },
  ]
})

const sourceLineText = computed(() => {
  const attribution = formatRegisterText(source.value?.attribution)
  const fetchedAt = source.value?.fetched_at
    ? formatDateTime(source.value.fetched_at, session.lang)
    : '-'
  return t('buildingPassport.sourceLine', { attribution, fetchedAt })
})

function formatCertValue(cert) {
  if (cert?.value === null || cert?.value === undefined || typeof cert.value !== 'number') {
    return '-'
  }
  const typeLabel = resolveCertValueTypeLabel(cert.value_type, t)
  return typeLabel ? `${cert.value} (${typeLabel})` : String(cert.value)
}

function getCertStateLabel(cert) {
  return resolveClassifiedLabel(cert?.state, t)
}
</script>

<template>
  <div data-testid="ee-building-facts" class="flex flex-col gap-space-lg">
    <!-- 1 & 2. Basics and Areas -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-space-lg items-start">
      <!-- Section 1: Basics & Structure -->
      <section
        data-testid="building-basics-section"
        class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
      >
        <div class="flex items-center gap-2 mb-space-md pb-space-xs border-b border-surface-container">
          <span class="material-symbols-outlined text-[20px] text-primary">domain</span>
          <h2 class="font-headline-sm text-base font-bold text-on-surface">
            {{ t('buildingPassport.sections.basics.title') }}
          </h2>
        </div>

        <dl class="divide-y divide-surface-container">
          <div
            v-for="row in basicRows"
            :key="row.id"
            :data-testid="`basic-row-${row.id}`"
            class="py-2 flex items-baseline justify-between gap-4 text-sm"
          >
            <dt class="text-on-surface-variant">{{ row.label }}</dt>
            <dd
              class="font-semibold text-on-surface text-right"
              :class="row.mono ? 'font-mono text-xs' : row.numeric ? 'font-numeric-display' : ''"
            >
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>

      <!-- Section 2: Areas, Volume & Height -->
      <section
        data-testid="building-areas-section"
        class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
      >
        <div class="flex items-center gap-2 mb-space-md pb-space-xs border-b border-surface-container">
          <span class="material-symbols-outlined text-[20px] text-primary">square_foot</span>
          <h2 class="font-headline-sm text-base font-bold text-on-surface">
            {{ t('buildingPassport.sections.areas.title') }}
          </h2>
        </div>

        <dl class="divide-y divide-surface-container">
          <div
            v-for="row in areaRows"
            :key="row.id"
            :data-testid="`area-row-${row.id}`"
            class="py-2.5 flex items-baseline justify-between gap-4 text-sm"
          >
            <dt class="text-on-surface-variant">{{ row.label }}</dt>
            <dd class="font-semibold text-on-surface font-numeric-display text-right">
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>
    </div>

    <!-- 3. Register Units Table -->
    <section
      data-testid="building-units-section"
      class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 mb-space-sm">
        <div>
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[20px] text-primary">grid_view</span>
            <h2 class="font-headline-sm text-base font-bold text-on-surface">
              {{ t('buildingPassport.sections.units.title') }}
            </h2>
          </div>
          <p class="text-xs text-on-surface-variant mt-0.5">
            {{ t('buildingPassport.sections.units.subtitle') }}
          </p>
        </div>
        <span class="px-2.5 py-1 rounded-full bg-surface-container text-on-surface-variant text-xs font-semibold">
          {{ t('buildingPassport.sections.units.countBadge', { count: units.length }) }}
        </span>
      </div>

      <p class="text-[11px] text-on-surface-variant mb-space-md">
        {{ t('buildingPassport.sections.units.privacyNote') }}
      </p>

      <div v-if="units.length === 0" data-testid="building-units-empty" class="text-sm text-on-surface-variant py-4">
        {{ t('buildingPassport.sections.units.empty') }}
      </div>

      <div v-else class="overflow-x-auto -mx-space-sm px-space-sm">
        <table
          data-testid="building-units-table"
          class="w-full text-left border-collapse text-sm"
          :class="compact ? 'text-xs' : ''"
        >
          <thead>
            <tr class="border-b border-surface-container text-xs uppercase tracking-wider text-on-surface-variant">
              <th class="py-2 pr-3 font-semibold">{{ t('buildingPassport.sections.units.cols.number') }}</th>
              <th class="py-2 px-3 font-semibold">{{ t('buildingPassport.sections.units.cols.kind') }}</th>
              <th class="py-2 px-3 font-semibold text-right">{{ t('buildingPassport.sections.units.cols.area') }}</th>
              <th class="py-2 px-3 font-semibold text-right">{{ t('buildingPassport.sections.units.cols.heatedArea') }}</th>
              <th class="py-2 px-3 font-semibold text-right">{{ t('buildingPassport.sections.units.cols.rooms') }}</th>
              <th class="py-2 px-3 font-semibold text-right">{{ t('buildingPassport.sections.units.cols.toilets') }}</th>
              <th class="py-2 pl-3 font-semibold text-right">{{ t('buildingPassport.sections.units.cols.entranceFloor') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-container">
            <tr
              v-for="(unit, idx) in units"
              :key="`${unit.number ?? 'none'}-${unit.kind}-${idx}`"
              data-testid="building-unit-row"
              class="hover:bg-surface-container-low/60 transition-colors"
            >
              <td class="py-2.5 pr-3 font-semibold text-on-surface whitespace-nowrap">
                {{ formatRegisterText(unit.number) }}
              </td>
              <td class="py-2.5 px-3 text-on-surface-variant whitespace-nowrap">
                {{ resolveUnitKindLabel(unit.kind, t) }}
              </td>
              <td class="py-2.5 px-3 text-right font-numeric-display whitespace-nowrap text-on-surface">
                {{ formatRegisterDecimal(unit.area_m2, 'm²') }}
              </td>
              <td class="py-2.5 px-3 text-right font-numeric-display whitespace-nowrap text-on-surface-variant">
                {{ formatRegisterDecimal(unit.heated_area_m2, 'm²') }}
              </td>
              <td class="py-2.5 px-3 text-right font-numeric-display whitespace-nowrap text-on-surface-variant">
                {{ formatRegisterInt(unit.rooms) }}
              </td>
              <td class="py-2.5 px-3 text-right font-numeric-display whitespace-nowrap text-on-surface-variant">
                {{ formatRegisterInt(unit.toilets) }}
              </td>
              <td class="py-2.5 pl-3 text-right font-numeric-display whitespace-nowrap text-on-surface-variant">
                {{ formatRegisterInt(unit.entrance_floor) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 4 & 5. Energy Certificates & Technical Construction -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-space-lg items-start">
      <!-- Section 4: Energy Certificate -->
      <section
        data-testid="building-energy-section"
        class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
      >
        <div class="flex items-center gap-2 mb-space-md pb-space-xs border-b border-surface-container">
          <span class="material-symbols-outlined text-[20px] text-secondary">bolt</span>
          <h2 class="font-headline-sm text-base font-bold text-on-surface">
            {{ t('buildingPassport.sections.energy.title') }}
          </h2>
        </div>

        <p
          v-if="energyCertificates.length === 0"
          data-testid="building-energy-empty"
          class="text-sm text-on-surface-variant py-2"
        >
          {{ t('buildingPassport.sections.energy.empty') }}
        </p>

        <div v-else class="flex flex-col gap-space-md">
          <div
            v-for="(cert, idx) in energyCertificates"
            :key="`${cert.document_number ?? 'cert'}-${idx}`"
            data-testid="building-energy-card"
            class="rounded-lg border border-surface-container bg-surface-container-low/50 p-space-md"
          >
            <div class="flex flex-wrap items-center justify-between gap-2 mb-space-sm">
              <span
                class="inline-flex items-center px-2.5 py-1 rounded-md bg-secondary-container text-on-secondary-container font-bold text-sm"
              >
                {{
                  cert.energy_class?.trim()
                    ? t('buildingPassport.sections.energy.classLabel', { class: cert.energy_class.trim() })
                    : '-'
                }}
              </span>
              <span
                v-if="getCertStateLabel(cert) !== '-'"
                class="px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-xs font-medium"
              >
                {{ getCertStateLabel(cert) }}
              </span>
            </div>

            <dl class="space-y-1.5 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-on-surface-variant">{{ t('buildingPassport.sections.energy.documentKind') }}</dt>
                <dd class="font-medium text-on-surface text-right">
                  {{ resolveClassifiedLabel(cert.document_kind, t) }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-on-surface-variant">{{ t('buildingPassport.sections.energy.documentNumber') }}</dt>
                <dd class="font-mono text-xs font-medium text-on-surface text-right">
                  {{ formatRegisterText(cert.document_number) }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-on-surface-variant">{{ t('buildingPassport.sections.energy.issuedOn') }}</dt>
                <dd class="font-medium text-on-surface text-right">
                  {{ formatCalendarDate(cert.issued_on, session.lang) }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-on-surface-variant">{{ t('buildingPassport.sections.energy.validUntil') }}</dt>
                <dd class="font-medium text-on-surface text-right">
                  {{ formatCalendarDate(cert.valid_until, session.lang) }}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-on-surface-variant">{{ t('buildingPassport.sections.energy.value') }}</dt>
                <dd class="font-medium text-on-surface font-numeric-display text-right">
                  {{ formatCertValue(cert) }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <!-- Section 5: Construction & Technical Systems -->
      <section
        data-testid="building-technical-section"
        class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
      >
        <div class="flex items-center gap-2 mb-space-md pb-space-xs border-b border-surface-container">
          <span class="material-symbols-outlined text-[20px] text-primary">foundation</span>
          <h2 class="font-headline-sm text-base font-bold text-on-surface">
            {{ t('buildingPassport.sections.technical.title') }}
          </h2>
        </div>

        <p
          v-if="technicalItems.length === 0"
          data-testid="building-technical-empty"
          class="text-sm text-on-surface-variant py-2"
        >
          {{ t('buildingPassport.sections.technical.empty') }}
        </p>

        <dl v-else class="divide-y divide-surface-container">
          <div
            v-for="(item, idx) in technicalItems"
            :key="`${item.group?.code ?? 'grp'}-${item.value?.code ?? idx}-${idx}`"
            data-testid="building-technical-row"
            class="py-2.5 flex items-baseline justify-between gap-4 text-sm"
          >
            <dt class="text-on-surface-variant">{{ resolveClassifiedLabel(item.group, t) }}</dt>
            <dd class="font-semibold text-on-surface text-right">
              {{ resolveClassifiedLabel(item.value, t) }}
            </dd>
          </div>
        </dl>
      </section>
    </div>

    <!-- 6. Cadastral Units -->
    <section
      data-testid="building-cadastral-section"
      class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs p-space-md sm:p-space-lg"
    >
      <div class="flex items-center gap-2 mb-space-sm">
        <span class="material-symbols-outlined text-[20px] text-primary">map</span>
        <h2 class="font-headline-sm text-base font-bold text-on-surface">
          {{ t('buildingPassport.sections.cadastral.title') }}
        </h2>
      </div>

      <p
        v-if="cadastralUnits.length === 0"
        data-testid="building-cadastral-empty"
        class="text-sm text-on-surface-variant"
      >
        {{ t('buildingPassport.sections.cadastral.empty') }}
      </p>

      <div v-else class="flex flex-wrap gap-2">
        <span
          v-for="(cu, idx) in cadastralUnits"
          :key="`${cu?.code ?? 'cu'}-${idx}`"
          data-testid="cadastral-unit-code"
          class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-surface-container text-on-surface font-mono text-xs font-semibold"
        >
          <span class="text-on-surface-variant font-sans">{{ t('buildingPassport.sections.cadastral.codeLabel') }}:</span>
          <span>{{ formatRegisterText(cu?.code) }}</span>
        </span>
      </div>
    </section>

    <!-- 7. Source Attribution -->
    <p
      data-testid="building-source-line"
      class="text-xs text-on-surface-variant px-1"
    >
      {{ sourceLineText }}
    </p>
  </div>
</template>
