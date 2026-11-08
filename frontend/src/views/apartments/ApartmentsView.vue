<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { listApartments } from '@/api/endpoints/property.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const session = useSessionStore()

const apartments = ref([])
const loading = ref(false)
const loadError = ref(null)
const selectedEntrance = ref('ALL')
const occupancyFilter = ref('ALL') // 'ALL' | 'OCCUPIED' | 'EMPTY'
const searchQuery = ref('')

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

        <!-- Search by apartment number -->
        <div class="relative w-full sm:w-56">
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
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
      >
        {{ session.t('apartments.emptyList') }}
      </div>

      <!-- Apartments Grid -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-space-md">
        <RouterLink
          v-for="apt in filteredApartments"
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

          <!-- Footer Link Prompt -->
          <div class="flex items-center justify-between text-xs font-semibold text-primary pt-1">
            <span>{{ session.t('apartments.openCard') }}</span>
            <span class="material-symbols-outlined text-[16px] group-hover:translate-x-0.5 transition-transform">
              arrow_forward
            </span>
          </div>
        </RouterLink>
      </div>
    </template>
  </div>
</template>
