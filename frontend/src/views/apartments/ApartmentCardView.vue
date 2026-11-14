<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { getApartmentCard } from '@/api/endpoints/property.js'
import { getApartmentReadings } from '@/api/endpoints/meters.js'
import { useApartmentConsumption } from '@/composables/useApartmentConsumption.js'
import { createApartmentThread, listApartmentThreads } from '@/api/endpoints/communication.js'
import { formatDate, formatDateTime, formatPeriodLabel, formatRelativeTime } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ConsumptionChart from '@/components/domain/ConsumptionChart.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const apartmentId = computed(() => String(route.params.apartmentId || ''))
const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const card = ref(null)
const readingsData = ref(null)
const {
  data: consumptionData,
  loading: consumptionLoading,
  error: consumptionError,
  load: loadConsumption,
  reset: resetConsumption,
} = useApartmentConsumption()
const apartmentThreads = ref([])
const loading = ref(false)
const loadError = ref(null)

// Write to this apartment form state
const showWriteForm = ref(false)
const draftTitle = ref('')
const draftBody = ref('')
const sendingMessage = ref(false)
const writeError = ref('')

const trimmedTitle = computed(() => draftTitle.value.trim())
const trimmedBody = computed(() => draftBody.value.trim())
const canSendMessage = computed(
  () =>
    trimmedTitle.value.length >= 1 &&
    trimmedTitle.value.length <= 255 &&
    trimmedBody.value.length >= 1 &&
    trimmedBody.value.length <= 10000 &&
    !sendingMessage.value,
)

const periods = computed(() => readingsData.value?.periods || [])
const meters = computed(() => readingsData.value?.meters || [])

/**
 * Align each meter's readings by period_code for O(1) cell lookup.
 */
const readingMapByMeter = computed(() => {
  const map = {}
  for (const m of meters.value) {
    const byPeriod = {}
    for (const r of m.readings || []) {
      byPeriod[r.period_code] = r
    }
    map[m.meter_id] = byPeriod
  }
  return map
})

function getCellReading(meterId, periodCode) {
  return readingMapByMeter.value[meterId]?.[periodCode] || null
}

function formatRelationSince(resident) {
  const relationLabel = session.t(`apartments.relation.${resident.relation_type}`)
  const sinceDate = formatDate(resident.since, session.lang)
  return session.t('apartments.residentSinceLine', {
    relation: relationLabel,
    date: sinceDate,
  })
}

function getResourceIcon(resourceType) {
  if (resourceType === 'COLD_WATER') return 'water_drop'
  if (resourceType === 'HOT_WATER') return 'thermostat'
  if (resourceType === 'ELECTRICITY') return 'bolt'
  if (resourceType === 'HEATING') return 'mode_heat'
  return 'speed'
}

let fetchCardSeq = 0

function reloadConsumption() {
  if (!isBoardOrChairman.value || !apartmentId.value) {
    resetConsumption()
    return
  }
  loadConsumption(apartmentId.value, 12)
}

async function fetchCardData() {
  if (!isBoardOrChairman.value || !apartmentId.value) {
    fetchCardSeq += 1
    card.value = null
    readingsData.value = null
    apartmentThreads.value = []
    loading.value = false
    resetConsumption()
    return
  }
  const seq = ++fetchCardSeq
  loading.value = true
  loadError.value = null
  reloadConsumption()
  try {
    const [cardRes, readingsRes, threadsRes] = await Promise.all([
      getApartmentCard(apartmentId.value),
      getApartmentReadings(apartmentId.value),
      listApartmentThreads({ apartment_id: apartmentId.value }).catch(() => []),
    ])
    if (seq !== fetchCardSeq) return
    card.value = cardRes
    readingsData.value = readingsRes
    apartmentThreads.value = Array.isArray(threadsRes) ? threadsRes : []
  } catch (err) {
    if (seq !== fetchCardSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchCardSeq) {
      loading.value = false
    }
  }
}

async function handleWriteToApartment() {
  if (!canSendMessage.value || !apartmentId.value) return
  sendingMessage.value = true
  writeError.value = ''
  try {
    const created = await createApartmentThread({
      apartmentId: apartmentId.value,
      title: trimmedTitle.value,
      body: trimmedBody.value,
    })
    draftTitle.value = ''
    draftBody.value = ''
    showWriteForm.value = false
    if (created?.id) {
      router.push({ name: 'message-thread', params: { postId: created.id } })
    } else {
      const threadsRes = await listApartmentThreads({ apartment_id: apartmentId.value })
      apartmentThreads.value = Array.isArray(threadsRes) ? threadsRes : []
    }
  } catch (err) {
    writeError.value = localizeError(err.errorCode, err.payload, session.lang)
  } finally {
    sendingMessage.value = false
  }
}

onMounted(() => {
  if (route.query.write === '1') {
    showWriteForm.value = true
  }
  fetchCardData()
})

onBeforeUnmount(() => {
  fetchCardSeq += 1
})

watch(
  () => route.query.write,
  (val) => {
    if (val === '1') {
      showWriteForm.value = true
    }
  },
)

watch(
  () => [apartmentId.value, session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    resetConsumption()
    fetchCardData()
  },
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-lg">
    <!-- Top Breadcrumb / Back Navigation -->
    <div>
      <RouterLink
        to="/apartments"
        class="inline-flex items-center gap-1.5 text-xs font-label-md font-semibold text-on-surface-variant hover:text-primary transition-colors"
      >
        <span class="material-symbols-outlined text-[16px]">arrow_back</span>
        <span>{{ session.t('apartments.backToList') }}</span>
      </RouterLink>
    </div>

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

    <!-- Loading State -->
    <div
      v-else-if="loading"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
    >
      {{ session.t('apartments.loadingCard') }}
    </div>

    <!-- Error State -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="fetchCardData"
    />

    <!-- Card Content -->
    <template v-else-if="card">
      <!-- Apartment Overview Header Card -->
      <section class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg shadow-xs">
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <div class="w-14 h-14 rounded-2xl bg-primary-container text-on-primary flex items-center justify-center font-headline-md text-xl font-bold shrink-0">
              {{ card.apartment_number }}
            </div>
            <div>
              <div class="inline-flex items-center gap-1.5 text-xs font-label-md uppercase tracking-wider text-primary font-semibold">
                {{ session.t('apartments.cardEyebrow') }}
              </div>
              <h1 class="font-headline-md text-headline-md font-bold text-on-surface">
                {{ session.t('apartments.apartmentTitle', { number: card.apartment_number }) }}
              </h1>
              <p class="text-xs sm:text-sm text-on-surface-variant mt-0.5">
                {{ session.t('apartments.entranceNumber', { entrance: card.entrance }) }}
                ·
                {{ session.t('apartments.floorNumber', { floor: card.floor }) }}
                ·
                <span class="font-mono font-semibold text-on-surface">
                  {{ card.area_m2 }} {{ session.t('apartments.areaUnit') }}
                </span>
              </p>
            </div>
          </div>

          <!-- Summary Resident Counts -->
          <div class="grid grid-cols-3 gap-2 sm:gap-3 shrink-0">
            <div class="bg-surface-container-low border border-surface-container rounded-xl px-3.5 py-2 text-center">
              <div class="text-[11px] font-label-md text-on-surface-variant">
                {{ session.t('apartments.ownersCountLabel') }}
              </div>
              <div class="font-mono text-base font-bold text-on-surface">{{ card.owner_count }}</div>
            </div>
            <div class="bg-surface-container-low border border-surface-container rounded-xl px-3.5 py-2 text-center">
              <div class="text-[11px] font-label-md text-on-surface-variant">
                {{ session.t('apartments.tenantsCountLabel') }}
              </div>
              <div class="font-mono text-base font-bold text-on-surface">{{ card.tenant_count }}</div>
            </div>
            <div class="bg-surface-container-low border border-surface-container rounded-xl px-3.5 py-2 text-center">
              <div class="text-[11px] font-label-md text-on-surface-variant">
                {{ session.t('apartments.familyCountLabel') }}
              </div>
              <div class="font-mono text-base font-bold text-on-surface">{{ card.resident_count }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- Two-Column Section: Residents (Anonymized by Role & Since Date) + Messages with this Apartment -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-space-md">
        <!-- Residents Card -->
        <section class="lg:col-span-5 bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg space-y-4">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h2 class="font-title-md text-title-md font-bold text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-[20px] text-primary">group</span>
                <span>{{ session.t('apartments.residentsSectionTitle') }}</span>
              </h2>
              <p class="text-xs text-on-surface-variant mt-0.5">
                {{ session.t('apartments.residentsPrivacyNote') }}
              </p>
            </div>
          </div>

          <div
            v-if="!card.residents || card.residents.length === 0"
            class="bg-surface-container-low rounded-xl p-space-md text-sm text-on-surface-variant flex items-center gap-2"
          >
            <span class="material-symbols-outlined text-[18px]">person_off</span>
            <span>{{ session.t('apartments.noResidentsYet') }}</span>
          </div>

          <ul v-else class="divide-y divide-surface-container">
            <li
              v-for="(resItem, idx) in card.residents"
              :key="`${resItem.relation_type}-${resItem.since}-${idx}`"
              class="py-2.5 flex items-center justify-between gap-3"
            >
              <div class="flex items-center gap-2.5">
                <span
                  class="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                  :class="
                    resItem.relation_type === 'OWNER'
                      ? 'bg-primary-container text-on-primary'
                      : resItem.relation_type === 'TENANT'
                        ? 'bg-secondary-container text-on-secondary-container'
                        : 'bg-surface-container-high text-on-surface-variant'
                  "
                >
                  <span class="material-symbols-outlined text-[15px]">
                    {{ resItem.relation_type === 'OWNER' ? 'verified_user' : 'person' }}
                  </span>
                </span>
                <span class="text-sm font-medium text-on-surface">
                  {{ formatRelationSince(resItem) }}
                </span>
              </div>
              <span
                class="text-[11px] font-label-md uppercase px-2 py-0.5 rounded-md font-semibold"
                :class="
                  resItem.relation_type === 'OWNER'
                    ? 'bg-primary-container/20 text-primary'
                    : 'bg-surface-container text-on-surface-variant'
                "
              >
                {{ session.t(`apartments.relation.${resItem.relation_type}`) }}
              </span>
            </li>
          </ul>
        </section>

        <!-- Messages with this apartment section (Task #004) -->
        <section class="lg:col-span-7 bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="font-title-md text-title-md font-bold text-on-surface flex items-center gap-2">
                <span class="material-symbols-outlined text-[20px] text-primary">mail</span>
                <span>{{ session.t('apartments.messagesSectionTitle') }}</span>
              </h2>
              <p class="text-xs text-on-surface-variant mt-0.5">
                {{ session.t('apartments.messagesSectionSubtitle') }}
              </p>
            </div>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors cursor-pointer"
              @click="
                showWriteForm = !showWriteForm;
                writeError = ''
              "
            >
              <span class="material-symbols-outlined text-[15px]">
                {{ showWriteForm ? 'close' : 'edit_square' }}
              </span>
              <span>
                {{
                  showWriteForm
                    ? session.t('common.cancel')
                    : session.t('messages.writeToApartmentBtn')
                }}
              </span>
            </button>
          </div>

          <!-- Inline composer to start a thread with this apartment -->
          <form
            v-if="showWriteForm"
            class="bg-surface-container-low border border-surface-container-high rounded-xl p-space-md space-y-3"
            @submit.prevent="handleWriteToApartment"
          >
            <div class="space-y-1">
              <div class="flex items-center justify-between">
                <label class="text-xs font-label-md font-semibold text-on-surface">
                  {{ session.t('messages.subjectLabel') }}
                </label>
                <span class="font-mono text-[11px] text-on-surface-variant">
                  {{ trimmedTitle.length }} / 255
                </span>
              </div>
              <input
                v-model="draftTitle"
                type="text"
                maxlength="255"
                required
                :placeholder="session.t('messages.subjectPlaceholder')"
                class="w-full rounded-lg bg-surface-container-lowest border border-surface-container-high px-3 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
              />
            </div>

            <div class="space-y-1">
              <div class="flex items-center justify-between">
                <label class="text-xs font-label-md font-semibold text-on-surface">
                  {{ session.t('messages.bodyLabel') }}
                </label>
                <span class="font-mono text-[11px] text-on-surface-variant">
                  {{ trimmedBody.length }} / 10000
                </span>
              </div>
              <textarea
                v-model="draftBody"
                rows="3"
                maxlength="10000"
                required
                :placeholder="session.t('messages.bodyPlaceholder')"
                class="w-full rounded-lg bg-surface-container-lowest border border-surface-container-high px-3 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
              />
            </div>

            <p v-if="writeError" class="text-xs text-error font-medium">
              {{ writeError }}
            </p>

            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface-variant text-xs font-semibold cursor-pointer"
                @click="showWriteForm = false"
              >
                {{ session.t('common.cancel') }}
              </button>
              <button
                type="submit"
                :disabled="!canSendMessage"
                class="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container disabled:opacity-50 cursor-pointer"
              >
                {{ sendingMessage ? session.t('common.saving') : session.t('messages.sendBtn') }}
              </button>
            </div>
          </form>

          <!-- Threads list for this apartment -->
          <div
            v-if="apartmentThreads.length === 0"
            class="bg-surface-container-low rounded-xl p-space-md text-xs text-on-surface-variant"
          >
            {{ session.t('apartments.messagesEmptyPlaceholder') }}
          </div>

          <div v-else class="space-y-2.5">
            <RouterLink
              v-for="thread in apartmentThreads"
              :key="thread.id"
              :to="{ name: 'message-thread', params: { postId: thread.id } }"
              class="block rounded-xl bg-surface-container-low hover:bg-surface-container border border-surface-container p-3 transition-colors space-y-1.5"
            >
              <div class="flex items-start justify-between gap-2">
                <h3 class="font-label-lg text-sm font-bold text-on-surface hover:text-primary transition-colors">
                  {{ thread.title }}
                </h3>
                <span class="text-[11px] text-on-surface-variant whitespace-nowrap">
                  {{ formatRelativeTime(thread.last_activity_at || thread.created_at, session.lang) }}
                </span>
              </div>
              <p class="text-xs text-on-surface-variant line-clamp-1">
                {{ thread.body ?? '' }}
              </p>
              <div class="flex items-center justify-between gap-2 pt-1">
                <AuthorBadge
                  v-if="thread.author_badge"
                  :badge="thread.author_badge"
                  :is-mine="thread.is_mine"
                />
                <span class="text-[11px] font-mono text-on-surface-variant">
                  {{ formatDateTime(thread.last_activity_at || thread.created_at, session.lang) }}
                  ·
                  {{ session.t('messages.repliesCount', { count: thread.comments_count || 0 }) }}
                </span>
              </div>
            </RouterLink>
          </div>
        </section>
      </div>

      <!-- Last 12 Months Consumption Chart (#030) -->
      <ConsumptionChart
        :periods="consumptionData?.periods || []"
        :series="consumptionData?.resources || []"
        :loading="consumptionLoading"
        :error="consumptionError"
        :title="session.t('consumptionChart.sectionTitle')"
        :subtitle="session.t('consumptionChart.sectionSubtitle')"
        @retry="reloadConsumption"
      />

      <!-- Meter Readings Table Across Periods -->
      <section class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 class="font-title-md text-title-md font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px] text-primary">speed</span>
              <span>{{ session.t('apartments.readingsSectionTitle') }}</span>
            </h2>
            <p class="text-xs text-on-surface-variant mt-0.5">
              {{ session.t('apartments.readingsSectionSubtitle') }}
            </p>
          </div>

          <!-- Legend for Estimates, Anomalies, and Replaced Meters -->
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 dark:text-amber-300 font-medium">
              {{ session.t('apartments.estimatedBadge') }}
            </span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-error-container text-on-error-container font-medium">
              {{ session.t('apartments.anomalyBadge') }}
            </span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-container-high text-on-surface-variant font-medium">
              {{ session.t('apartments.replacedMeter') }}
            </span>
          </div>
        </div>

        <div
          v-if="meters.length === 0 || periods.length === 0"
          class="bg-surface-container-low rounded-xl p-space-md text-sm text-on-surface-variant text-center"
        >
          {{ session.t('apartments.noReadingsHistory') }}
        </div>

        <div v-else class="overflow-x-auto border border-surface-container rounded-xl">
          <table class="w-full text-left border-collapse min-w-[640px]">
            <thead>
              <tr class="bg-surface-container-low border-b border-surface-container">
                <th class="py-3 px-3.5 text-xs font-label-md uppercase text-on-surface-variant font-bold sticky left-0 bg-surface-container-low z-10">
                  {{ session.t('apartments.periodColumn') }}
                </th>
                <th
                  v-for="m in meters"
                  :key="m.meter_id"
                  class="py-3 px-3.5 text-xs font-label-md text-on-surface align-top min-w-[170px]"
                >
                  <div class="flex items-start justify-between gap-1.5">
                    <div class="flex items-center gap-1.5 font-bold">
                      <span class="material-symbols-outlined text-[15px] text-primary">
                        {{ getResourceIcon(m.resource_type) }}
                      </span>
                      <span>{{ session.t(`resources.${m.resource_type}`) }}</span>
                    </div>
                    <span
                      v-if="!m.is_active"
                      class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant text-[10px] font-semibold uppercase shrink-0"
                    >
                      {{ session.t('apartments.replacedMeter') }}
                    </span>
                  </div>
                  <div class="text-[11px] text-on-surface-variant font-normal mt-0.5">
                    {{ m.location_label || '—' }}
                  </div>
                  <div class="font-mono text-[10px] text-on-surface-variant font-normal">
                    {{ m.serial_number }} ({{ session.t(`units.${m.unit}`) || m.unit }})
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-container text-xs">
              <tr
                v-for="p in periods"
                :key="p.period_code"
                class="hover:bg-surface-container-low/60 transition-colors"
              >
                <td class="py-3 px-3.5 font-medium text-on-surface whitespace-nowrap sticky left-0 bg-surface-container-lowest z-10">
                  <div class="font-semibold">{{ formatPeriodLabel(p.period_code, session.lang) }}</div>
                  <div class="font-mono text-[11px] text-on-surface-variant">{{ p.period_code }}</div>
                </td>
                <td
                  v-for="m in meters"
                  :key="`${p.period_code}-${m.meter_id}`"
                  class="py-3 px-3.5 align-top"
                >
                  <template v-if="getCellReading(m.meter_id, p.period_code)">
                    <div class="font-mono font-bold text-on-surface text-xs">
                      {{ getCellReading(m.meter_id, p.period_code).value }}
                      <span class="text-on-surface-variant font-normal">
                        {{ session.t(`units.${m.unit}`) || m.unit }}
                      </span>
                    </div>
                    <div class="font-mono text-[11px] text-on-surface-variant mt-0.5">
                      +{{ getCellReading(m.meter_id, p.period_code).consumption_delta }}
                      {{ session.t(`units.${m.unit}`) || m.unit }}
                    </div>
                    <div class="flex flex-wrap items-center gap-1 mt-1">
                      <span
                        v-if="getCellReading(m.meter_id, p.period_code).source === 'AUTO_ESTIMATED'"
                        class="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 text-[10px] font-semibold"
                      >
                        {{ session.t('apartments.estimatedBadge') }}
                      </span>
                      <span
                        v-if="getCellReading(m.meter_id, p.period_code).is_anomaly_confirmed"
                        class="inline-flex items-center px-1.5 py-0.5 rounded bg-error-container text-on-error-container text-[10px] font-semibold"
                      >
                        {{ session.t('apartments.anomalyBadge') }}
                      </span>
                    </div>
                  </template>
                  <span v-else class="text-on-surface-variant font-mono">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
