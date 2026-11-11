<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { listApartments } from '@/api/endpoints/property.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

const apartments = ref([])
const loading = ref(false)
const loadError = ref(null)
const selectedEntrance = ref('ALL')
const occupancyFilter = ref('ALL') // 'ALL' | 'OCCUPIED' | 'EMPTY'
const searchQuery = ref('')
const viewMode = ref('cards') // 'cards' | 'table'
const currentPage = ref(1)
const perPage = ref(24)

const hasActiveFilters = computed(
  () =>
    selectedEntrance.value !== 'ALL' ||
    occupancyFilter.value !== 'ALL' ||
    searchQuery.value.trim().length > 0,
)

function resetFilters() {
  selectedEntrance.value = 'ALL'
  occupancyFilter.value = 'ALL'
  searchQuery.value = ''
  currentPage.value = 1
}

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

function isEmptyApartment(apt) {
  return (
    (apt.owner_count || 0) === 0 &&
    (apt.tenant_count || 0) === 0 &&
    (apt.resident_count || 0) === 0
  )
}

const entrances = computed(() => {
  const set = new Set()
  for (const apt of apartments.value) {
    if (apt.entrance != null) set.add(apt.entrance)
  }
  return [...set].sort((a, b) => a - b)
})

const filteredApartments = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return apartments.value.filter((apt) => {
    if (selectedEntrance.value !== 'ALL' && apt.entrance !== Number(selectedEntrance.value)) {
      return false
    }
    const empty = isEmptyApartment(apt)
    if (occupancyFilter.value === 'OCCUPIED' && empty) return false
    if (occupancyFilter.value === 'EMPTY' && !empty) return false
    if (q && !String(apt.apartment_number || '').toLowerCase().includes(q)) return false
    return true
  })
})

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredApartments.value.length / perPage.value)),
)

const paginatedApartments = computed(() => {
  const start = (currentPage.value - 1) * perPage.value
  return filteredApartments.value.slice(start, start + perPage.value)
})

const paginationShowingText = computed(() => {
  const total = filteredApartments.value.length
  if (total === 0) return ''
  const from = (currentPage.value - 1) * perPage.value + 1
  const to = Math.min(currentPage.value * perPage.value, total)
  return session.t('apartments.paginationShowing', { from, to, total })
})

watch(
  () => [selectedEntrance.value, occupancyFilter.value, searchQuery.value, perPage.value],
  () => {
    currentPage.value = 1
  },
)

const summaryStats = computed(() => {
  const total = apartments.value.length
  const empty = apartments.value.filter((a) => isEmptyApartment(a)).length
  const occupied = total - empty
  return { total, occupied, empty }
})

let fetchApartmentsSeq = 0

async function fetchApartments() {
  if (!isBoardOrChairman.value) {
    fetchApartmentsSeq += 1
    apartments.value = []
    loading.value = false
    return
  }
  const seq = ++fetchApartmentsSeq
  loading.value = true
  loadError.value = null
  try {
    const res = await listApartments()
    if (seq !== fetchApartmentsSeq) return
    apartments.value = Array.isArray(res?.apartments)
      ? res.apartments
      : Array.isArray(res)
        ? res
        : []
  } catch (err) {
    if (seq !== fetchApartmentsSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchApartmentsSeq) {
      loading.value = false
    }
  }
}

onMounted(fetchApartments)

watch(
  () => [session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    fetchApartments()
  },
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-lg">
    <!-- Page Header -->
    <header class="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-surface-container pb-space-md">
      <div>
        <div class="inline-flex items-center gap-1.5 text-xs font-label-md uppercase tracking-wider text-primary font-semibold mb-1">
          <span class="material-symbols-outlined text-[16px]">apartment</span>
          <span>{{ session.t('apartments.eyebrow') }}</span>
        </div>
        <h1 class="font-headline-lg text-headline-lg font-bold text-on-surface">
          {{ session.t('apartments.title') }}
        </h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-1 max-w-2xl">
          {{ session.t('apartments.subtitle') }}
        </p>
      </div>

      <!-- Summary Counters -->
      <div v-if="isBoardOrChairman && apartments.length > 0" class="flex items-center gap-3 shrink-0">
        <div class="bg-surface-container-lowest border border-surface-container rounded-xl px-3.5 py-2 text-center">
          <div class="text-xs font-label-md text-on-surface-variant">{{ session.t('apartments.statsTotal') }}</div>
          <div class="font-headline-sm text-lg font-bold text-on-surface">{{ summaryStats.total }}</div>
        </div>
        <div class="bg-surface-container-lowest border border-surface-container rounded-xl px-3.5 py-2 text-center">
          <div class="text-xs font-label-md text-on-surface-variant">{{ session.t('apartments.statsOccupied') }}</div>
          <div class="font-headline-sm text-lg font-bold text-primary">{{ summaryStats.occupied }}</div>
        </div>
        <div class="bg-surface-container-lowest border border-surface-container rounded-xl px-3.5 py-2 text-center">
          <div class="text-xs font-label-md text-on-surface-variant">{{ session.t('apartments.statsEmpty') }}</div>
          <div class="font-headline-sm text-lg font-bold text-on-surface-variant">{{ summaryStats.empty }}</div>
        </div>
      </div>
    </header>

    <!-- No Access Fallback if opened directly by non-board role -->
    <div
      v-if="!isBoardOrChairman"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto my-space-lg space-y-4"
      role="alert"
    >
      <div class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto">
        <span class="material-symbols-outlined text-[24px]">lock</span>
      </div>
      <h2 class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h2>
      <p class="font-body-md text-body-md text-on-surface-variant">
        {{ session.t('errors.FORBIDDEN') }}
      </p>
      <div>
        <RouterLink
          to="/"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>{{ session.t('nav.dashboard') }}</span>
        </RouterLink>
      </div>
    </div>

    <template v-else>
      <!-- Filters Bar -->
      <div class="bg-surface-container-lowest border border-surface-container rounded-xl p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <!-- Entrance filter -->
          <div class="inline-flex items-center gap-1.5">
            <span class="text-xs font-label-md text-on-surface-variant">{{ session.t('apartments.filterEntrance') }}:</span>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-label-md transition-colors"
              :class="
                selectedEntrance === 'ALL'
                  ? 'bg-primary text-on-primary font-semibold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="selectedEntrance = 'ALL'"
            >
              {{ session.t('apartments.filterAll') }}
            </button>
            <button
              v-for="ent in entrances"
              :key="ent"
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-label-md transition-colors"
              :class="
                selectedEntrance === String(ent)
                  ? 'bg-primary text-on-primary font-semibold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="selectedEntrance = String(ent)"
            >
              {{ session.t('apartments.entranceNumber', { entrance: ent }) }}
            </button>
          </div>

          <span class="hidden sm:inline text-surface-container-highest">|</span>

          <!-- Occupancy filter -->
          <div class="inline-flex items-center gap-1.5">
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-label-md transition-colors"
              :class="
                occupancyFilter === 'ALL'
                  ? 'bg-secondary-container text-on-secondary-container font-semibold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="occupancyFilter = 'ALL'"
            >
              {{ session.t('apartments.filterAll') }}
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-label-md transition-colors"
              :class="
                occupancyFilter === 'OCCUPIED'
                  ? 'bg-secondary-container text-on-secondary-container font-semibold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="occupancyFilter = 'OCCUPIED'"
            >
              {{ session.t('apartments.statsOccupied') }}
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-xs font-label-md transition-colors"
              :class="
                occupancyFilter === 'EMPTY'
                  ? 'bg-secondary-container text-on-secondary-container font-semibold'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="occupancyFilter = 'EMPTY'"
            >
              {{ session.t('apartments.statsEmpty') }}
            </button>
          </div>
        </div>

        <!-- Search, View Switcher & Reset Filters -->
        <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <!-- View Switcher (Cards / Compact Table) -->
          <div class="inline-flex items-center p-0.5 rounded-lg bg-surface-container border border-surface-container-high">
            <button
              type="button"
              data-testid="apartments-view-cards-btn"
              :aria-label="session.t('apartments.viewCards')"
              class="px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer"
              :class="
                viewMode === 'cards'
                  ? 'bg-surface-container-lowest text-primary shadow-2xs'
                  : 'text-on-surface-variant hover:text-on-surface'
              "
              @click="viewMode = 'cards'"
            >
              <span class="material-symbols-outlined text-[16px]">grid_view</span>
              <span class="hidden md:inline">{{ session.t('apartments.viewCards') }}</span>
            </button>
            <button
              type="button"
              data-testid="apartments-view-table-btn"
              :aria-label="session.t('apartments.viewTable')"
              class="px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition-colors cursor-pointer"
              :class="
                viewMode === 'table'
                  ? 'bg-surface-container-lowest text-primary shadow-2xs'
                  : 'text-on-surface-variant hover:text-on-surface'
              "
              @click="viewMode = 'table'"
            >
              <span class="material-symbols-outlined text-[16px]">table_rows</span>
              <span class="hidden md:inline">{{ session.t('apartments.viewTable') }}</span>
            </button>
          </div>

          <!-- Search Input -->
          <div class="relative flex-1 sm:w-52">
            <span class="material-symbols-outlined text-[18px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2">
              search
            </span>
            <input
              v-model="searchQuery"
              type="search"
              :placeholder="session.t('apartments.searchPlaceholder')"
              class="w-full pl-9 pr-3 py-1.5 rounded-lg bg-surface-container-low border border-surface-container-high text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
            />
          </div>

          <button
            v-if="hasActiveFilters"
            type="button"
            data-testid="apartments-reset-filters-btn"
            class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high text-xs font-label-md font-semibold transition-colors shrink-0 cursor-pointer"
            @click="resetFilters"
          >
            <span class="material-symbols-outlined text-[15px]">filter_alt_off</span>
            <span>{{ session.t('apartments.filterAll') }}</span>
          </button>
        </div>
      </div>

      <!-- Loading State -->
      <div
        v-if="loading"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
      >
        {{ session.t('apartments.loading') }}
      </div>

      <!-- Error State -->
      <ErrorCard
        v-else-if="loadError"
        :error="loadError"
        @retry="fetchApartments"
      />

      <!-- Empty Filter Result -->
      <div
        v-else-if="filteredApartments.length === 0"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm space-y-3"
      >
        <p>{{ session.t('apartments.emptyList') }}</p>
        <button
          v-if="hasActiveFilters"
          type="button"
          class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors cursor-pointer"
          @click="resetFilters"
        >
          <span class="material-symbols-outlined text-[15px]">filter_alt_off</span>
          <span>{{ session.t('apartments.filterAll') }}</span>
        </button>
      </div>

      <!-- Apartments View: Cards Mode vs Compact Table Mode -->
      <template v-else>
        <!-- Mode A: Cards Grid -->
        <div
          v-if="viewMode === 'cards'"
          data-testid="apartments-cards-grid"
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-space-md"
        >
          <RouterLink
            v-for="apt in paginatedApartments"
            :key="apt.apartment_id"
            :to="{ name: 'apartment-card', params: { apartmentId: apt.apartment_id } }"
            class="group bg-surface-container-lowest border border-surface-container hover:border-primary/50 rounded-2xl p-space-md transition-all shadow-xs hover:shadow-md flex flex-col justify-between gap-4"
          >
            <div class="space-y-3">
              <!-- Top Row: Apartment Number + Empty/Occupied Status -->
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5">
                  <div
                    class="w-10 h-10 rounded-xl flex items-center justify-center font-headline-sm font-bold text-sm shrink-0"
                    :class="
                      isEmptyApartment(apt)
                        ? 'bg-surface-container-high text-on-surface-variant'
                        : 'bg-primary-container text-on-primary'
                    "
                  >
                    {{ apt.apartment_number }}
                  </div>
                  <div>
                    <h2 class="font-title-md text-title-md font-bold text-on-surface group-hover:text-primary transition-colors">
                      {{ session.t('apartments.apartmentTitle', { number: apt.apartment_number }) }}
                    </h2>
                    <p class="text-xs text-on-surface-variant">
                      {{ session.t('apartments.entranceNumber', { entrance: apt.entrance }) }}
                      ·
                      {{ session.t('apartments.floorNumber', { floor: apt.floor }) }}
                    </p>
                  </div>
                </div>

                <!-- Heated Area (strictly string) -->
                <div class="text-right shrink-0">
                  <div class="text-[11px] font-label-md text-on-surface-variant uppercase">
                    {{ session.t('apartments.areaLabel') }}
                  </div>
                  <div class="font-mono text-xs font-bold text-on-surface">
                    {{ apt.area_m2 }} {{ session.t('apartments.areaUnit') }}
                  </div>
                </div>
              </div>

              <!-- Occupancy / Resident Counts -->
              <div class="pt-2 border-t border-surface-container">
                <div
                  v-if="isEmptyApartment(apt)"
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-container text-on-surface-variant text-xs font-medium"
                >
                  <span class="material-symbols-outlined text-[15px]">person_off</span>
                  <span>{{ session.t('apartments.noResidentsYet') }}</span>
                </div>

                <div v-else class="grid grid-cols-3 gap-2 text-center">
                  <div class="bg-surface-container-low rounded-lg py-1.5 px-2">
                    <div class="text-[11px] text-on-surface-variant">{{ session.t('apartments.ownersCountLabel') }}</div>
                    <div class="font-mono text-xs font-bold text-on-surface">{{ apt.owner_count }}</div>
                  </div>
                  <div class="bg-surface-container-low rounded-lg py-1.5 px-2">
                    <div class="text-[11px] text-on-surface-variant">{{ session.t('apartments.tenantsCountLabel') }}</div>
                    <div class="font-mono text-xs font-bold text-on-surface">{{ apt.tenant_count }}</div>
                  </div>
                  <div class="bg-surface-container-low rounded-lg py-1.5 px-2">
                    <div class="text-[11px] text-on-surface-variant">{{ session.t('apartments.familyCountLabel') }}</div>
                    <div class="font-mono text-xs font-bold text-on-surface">{{ apt.resident_count }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Footer Actions: Quick Message + Open Card -->
            <div class="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                :data-testid="`apartment-quick-write-${apt.apartment_id}`"
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container-low hover:bg-primary/10 text-on-surface-variant hover:text-primary text-xs font-semibold transition-colors cursor-pointer"
                @click.stop.prevent="
                  router.push({
                    name: 'apartment-card',
                    params: { apartmentId: apt.apartment_id },
                    query: { write: '1' },
                  })
                "
              >
                <span class="material-symbols-outlined text-[15px]">edit_square</span>
                <span>{{ session.t('messages.writeToApartmentBtn') }}</span>
              </button>

              <div class="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                <span>{{ session.t('apartments.openCard') }}</span>
                <span class="material-symbols-outlined text-[16px] group-hover:translate-x-0.5 transition-transform">
                  arrow_forward
                </span>
              </div>
            </div>
          </RouterLink>
        </div>

        <!-- Mode B: Compact Table (High Density for 100-600 apartments) -->
        <div
          v-else
          data-testid="apartments-compact-table"
          class="bg-surface-container-lowest border border-surface-container rounded-2xl overflow-hidden shadow-xs"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="bg-surface-container-low border-b border-surface-container text-on-surface-variant font-semibold">
                  <th class="py-2.5 px-4 font-label-md">{{ session.t('apartments.title') }}</th>
                  <th class="py-2.5 px-4 font-label-md">{{ session.t('apartments.filterEntrance') }}</th>
                  <th class="py-2.5 px-4 font-label-md">{{ session.t('common.floorEntrance').split('•')[0].trim() }}</th>
                  <th class="py-2.5 px-4 font-label-md text-right">{{ session.t('apartments.areaLabel') }}</th>
                  <th class="py-2.5 px-4 font-label-md text-center">{{ session.t('apartments.ownersCountLabel') }}</th>
                  <th class="py-2.5 px-4 font-label-md text-center">{{ session.t('apartments.tenantsCountLabel') }}</th>
                  <th class="py-2.5 px-4 font-label-md text-center">{{ session.t('apartments.familyCountLabel') }}</th>
                  <th class="py-2.5 px-4 font-label-md text-right">{{ session.t('common.preview') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-surface-container">
                <tr
                  v-for="apt in paginatedApartments"
                  :key="apt.apartment_id"
                  class="hover:bg-surface-container-low/70 transition-colors cursor-pointer"
                  @click="router.push({ name: 'apartment-card', params: { apartmentId: apt.apartment_id } })"
                >
                  <td class="py-2.5 px-4 font-bold text-on-surface">
                    <div class="flex items-center gap-2">
                      <span
                        class="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs"
                        :class="
                          isEmptyApartment(apt)
                            ? 'bg-surface-container text-on-surface-variant'
                            : 'bg-primary-container text-on-primary'
                        "
                      >
                        {{ apt.apartment_number }}
                      </span>
                      <span>{{ session.t('apartments.apartmentTitle', { number: apt.apartment_number }) }}</span>
                    </div>
                  </td>
                  <td class="py-2.5 px-4 text-on-surface-variant">
                    {{ session.t('apartments.entranceNumber', { entrance: apt.entrance }) }}
                  </td>
                  <td class="py-2.5 px-4 text-on-surface-variant">
                    {{ session.t('apartments.floorNumber', { floor: apt.floor }) }}
                  </td>
                  <td class="py-2.5 px-4 text-right font-mono font-semibold text-on-surface">
                    {{ apt.area_m2 }} {{ session.t('apartments.areaUnit') }}
                  </td>
                  <td class="py-2.5 px-4 text-center font-mono">
                    <span :class="apt.owner_count > 0 ? 'text-on-surface font-semibold' : 'text-on-surface-variant/40'">
                      {{ apt.owner_count }}
                    </span>
                  </td>
                  <td class="py-2.5 px-4 text-center font-mono">
                    <span :class="apt.tenant_count > 0 ? 'text-on-surface font-semibold' : 'text-on-surface-variant/40'">
                      {{ apt.tenant_count }}
                    </span>
                  </td>
                  <td class="py-2.5 px-4 text-center font-mono">
                    <span :class="apt.resident_count > 0 ? 'text-on-surface font-semibold' : 'text-on-surface-variant/40'">
                      {{ apt.resident_count }}
                    </span>
                  </td>
                  <td class="py-2.5 px-4 text-right">
                    <div class="inline-flex items-center gap-1.5" @click.stop>
                      <button
                        type="button"
                        :data-testid="`table-quick-write-${apt.apartment_id}`"
                        class="p-1 rounded-md hover:bg-surface-container text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                        :title="session.t('messages.writeToApartmentBtn')"
                        @click="
                          router.push({
                            name: 'apartment-card',
                            params: { apartmentId: apt.apartment_id },
                            query: { write: '1' },
                          })
                        "
                      >
                        <span class="material-symbols-outlined text-[17px]">edit_square</span>
                      </button>
                      <button
                        type="button"
                        class="p-1 rounded-md hover:bg-surface-container text-primary transition-colors cursor-pointer"
                        :title="session.t('apartments.openCard')"
                        @click="router.push({ name: 'apartment-card', params: { apartmentId: apt.apartment_id } })"
                      >
                        <span class="material-symbols-outlined text-[17px]">arrow_forward</span>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Pagination Controls Bar -->
        <div
          v-if="filteredApartments.length > 0"
          data-testid="apartments-pagination"
          class="bg-surface-container-lowest border border-surface-container rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
        >
          <div class="flex items-center gap-3 text-on-surface-variant">
            <span>{{ paginationShowingText }}</span>
            <div class="inline-flex items-center gap-1.5 pl-3 border-l border-surface-container">
              <span>{{ session.t('apartments.perPage') }}</span>
              <select
                v-model.number="perPage"
                class="px-2 py-1 rounded bg-surface-container border border-surface-container-high text-on-surface focus:outline-none focus:border-primary text-xs"
              >
                <option :value="12">12</option>
                <option :value="24">24</option>
                <option :value="48">48</option>
                <option :value="96">96</option>
              </select>
            </div>
          </div>

          <div v-if="totalPages > 1" class="flex items-center gap-1.5 self-center sm:self-auto">
            <button
              type="button"
              :disabled="currentPage <= 1"
              class="px-2.5 py-1 rounded-lg border border-surface-container font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-container"
              @click="currentPage--"
            >
              <span class="material-symbols-outlined text-[15px]">chevron_left</span>
              <span class="hidden sm:inline">{{ session.t('common.previous') }}</span>
            </button>

            <span class="px-3 py-1 font-mono font-bold text-on-surface">
              {{ currentPage }} / {{ totalPages }}
            </span>

            <button
              type="button"
              :disabled="currentPage >= totalPages"
              class="px-2.5 py-1 rounded-lg border border-surface-container font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-container"
              @click="currentPage++"
            >
              <span class="hidden sm:inline">{{ session.t('common.next') }}</span>
              <span class="material-symbols-outlined text-[15px]">chevron_right</span>
            </button>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
