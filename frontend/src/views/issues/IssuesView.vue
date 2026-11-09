<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { listIssues, getIssueForm, followIssue } from '@/api/endpoints/issues.js'
import {
  ISSUE_CATEGORIES,
  ALL_ISSUE_STATUSES,
  isIssueOpen,
} from '@/utils/issues.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import IssueFormModal from './components/IssueFormModal.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const issues = ref([])
const entrances = ref([1, 2])
const isLoading = ref(true)
const loadError = ref(null)

const statusTab = ref('ALL') // 'ALL' | 'OPEN' | 'ENDED' | specific IssueStatus
const selectedCategory = ref('')
const selectedEntrance = ref('') // '' = all, '0' = outside/whole building, '1'..'N' = entrance N
const includeOld = ref(false)

const showReportModal = ref(false)
const followingId = ref('')

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const CATEGORY_ICONS = {
  LIGHTING: 'lightbulb',
  DOORS_AND_LOCKS: 'door_front',
  LIFT: 'elevator',
  HEATING: 'thermostat',
  WATER_AND_SEWAGE: 'water_drop',
  ELECTRICITY: 'bolt',
  CLEANING: 'cleaning_services',
  WASTE: 'delete',
  YARD: 'park',
  ROOF_AND_FACADE: 'roofing',
  OTHER: 'build',
}

function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || 'report_problem'
}

function statusBadgeClass(status) {
  if (status === 'REPORTED') {
    return 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800'
  }
  if (status === 'IN_PROGRESS' || status === 'WAITING_FOR_CONTRACTOR') {
    return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800'
  }
  if (status === 'RESOLVED') {
    return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
  }
  return 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
}

async function fetchFormMetadata() {
  try {
    const meta = await getIssueForm()
    if (Array.isArray(meta?.entrances) && meta.entrances.length > 0) {
      entrances.value = meta.entrances
    }
  } catch {
    // Keep default entrances [1, 2]
  }
}

async function loadIssues() {
  isLoading.value = true
  loadError.value = null
  try {
    const params = {}
    if (statusTab.value && statusTab.value !== 'ALL') {
      params.status = statusTab.value
    }
    if (selectedCategory.value) {
      params.category = selectedCategory.value
    }
    if (selectedEntrance.value !== '') {
      params.entrance = selectedEntrance.value
    }
    if (isBoardOrChairman.value && includeOld.value) {
      params.include_old = true
    }
    const data = await listIssues(params)
    issues.value = Array.isArray(data) ? data : []
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

const openIssuesList = computed(() =>
  issues.value.filter((item) => isIssueOpen(item.status)),
)
const endedIssuesList = computed(() =>
  issues.value.filter((item) => !isIssueOpen(item.status)),
)

function formatLocation(issue) {
  const base =
    issue.entrance === null || issue.entrance === undefined
      ? session.t('issues.locationOutside')
      : session.t('issues.locationEntrance', { n: issue.entrance })
  return issue.place ? `${base} · ${issue.place}` : base
}

function formatDate(isoStr) {
  if (!isoStr) return ''
  try {
    return new Intl.DateTimeFormat(session.lang || 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(isoStr))
  } catch {
    return isoStr.slice(0, 10)
  }
}

async function handleQuickFollow(issue, event) {
  event?.stopPropagation()
  if (!issue?.can_follow || followingId.value) return
  followingId.value = issue.id
  try {
    const updated = await followIssue(issue.id)
    const idx = issues.value.findIndex((i) => i.id === issue.id)
    if (idx !== -1 && updated) {
      issues.value[idx] = { ...issues.value[idx], ...updated }
    } else {
      await loadIssues()
    }
  } catch {
    await loadIssues()
  } finally {
    followingId.value = ''
  }
}

function handleIssueCreated(created) {
  showReportModal.value = false
  if (created?.id) {
    router.push({ name: 'issue-detail', params: { issueId: created.id } })
  } else {
    loadIssues()
  }
}

function handleSuggestionFollowed(updated) {
  showReportModal.value = false
  if (updated?.id) {
    router.push({ name: 'issue-detail', params: { issueId: updated.id } })
  } else {
    loadIssues()
  }
}

function resetFilters() {
  statusTab.value = 'ALL'
  selectedCategory.value = ''
  selectedEntrance.value = ''
  includeOld.value = false
}

watch([statusTab, selectedCategory, selectedEntrance, includeOld], () => {
  loadIssues()
})

watch(
  () => session.actingUserId,
  () => {
    if (!isBoardOrChairman.value && includeOld.value) {
      includeOld.value = false
    }
    fetchFormMetadata()
    loadIssues()
  },
)

onMounted(() => {
  if (route.query.report === '1') {
    showReportModal.value = true
  }
  fetchFormMetadata()
  loadIssues()
})

watch(
  () => route.query.report,
  (val) => {
    if (val === '1') {
      showReportModal.value = true
    }
  },
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <header
      class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-surface-container pb-5"
    >
      <div>
        <h1
          class="font-headline-xl text-2xl font-bold tracking-tight text-on-surface sm:text-3xl"
        >
          {{ session.t('issues.title') }}
        </h1>
        <p class="mt-1.5 text-sm text-on-surface-variant">
          {{ session.t('issues.subtitle') }}
        </p>
      </div>

      <button
        v-if="!loadError"
        type="button"
        data-testid="report-issue-button"
        class="inline-flex items-center gap-2 self-start rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-container sm:self-auto cursor-pointer"
        @click="showReportModal = true"
      >
        <span class="material-symbols-outlined text-[18px]">add_alert</span>
        <span>{{ session.t('issues.reportButton') }}</span>
      </button>
    </header>

    <!-- Error state (e.g. 403 FORBIDDEN for accountant without apartment) -->
    <ErrorCard
      v-if="loadError"
      :error="loadError"
      @retry="loadIssues"
    />

    <template v-else>
      <!-- Filters bar -->
      <div
        class="rounded-xl border border-surface-container bg-surface-container-lowest p-4 shadow-2xs"
      >
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <!-- Primary status tabs -->
          <div class="flex flex-wrap items-center gap-1.5" role="tablist">
            <button
              v-for="tab in ['ALL', 'OPEN', 'ENDED']"
              :key="tab"
              type="button"
              role="tab"
              :data-testid="`issues-status-tab-${tab}`"
              :aria-selected="statusTab === tab"
              class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer"
              :class="
                statusTab === tab
                  ? 'bg-primary text-on-primary shadow-2xs'
                  : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
              "
              @click="statusTab = tab"
            >
              {{ session.t(`issues.filters.statusTabs.${tab}`) }}
            </button>
          </div>

          <!-- Specific status, category, and entrance filters -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label for="issues-filter-status" class="sr-only">
                {{ session.t('issues.filters.statusLabel') }}
              </label>
              <select
                id="issues-filter-status"
                v-model="statusTab"
                data-testid="issues-filter-status"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-medium text-on-surface"
              >
                <option value="ALL">{{ session.t('issues.filters.statusTabs.ALL') }}</option>
                <option value="OPEN">{{ session.t('issues.filters.statusTabs.OPEN') }}</option>
                <option value="ENDED">{{ session.t('issues.filters.statusTabs.ENDED') }}</option>
                <optgroup :label="session.t('issues.filters.specificStatusGroup')">
                  <option
                    v-for="st in ALL_ISSUE_STATUSES"
                    :key="st"
                    :value="st"
                  >
                    {{ session.t(`issues.statuses.${st}`) }}
                  </option>
                </optgroup>
              </select>
            </div>

            <div>
              <label for="issues-filter-category" class="sr-only">
                {{ session.t('issues.filters.categoryLabel') }}
              </label>
              <select
                id="issues-filter-category"
                v-model="selectedCategory"
                data-testid="issues-filter-category"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-medium text-on-surface"
              >
                <option value="">{{ session.t('issues.filters.allCategories') }}</option>
                <option
                  v-for="cat in ISSUE_CATEGORIES"
                  :key="cat"
                  :value="cat"
                >
                  {{ session.t(`issues.categories.${cat}`) }}
                </option>
              </select>
            </div>

            <div>
              <label for="issues-filter-entrance" class="sr-only">
                {{ session.t('issues.filters.locationLabel') }}
              </label>
              <select
                id="issues-filter-entrance"
                v-model="selectedEntrance"
                data-testid="issues-filter-entrance"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-medium text-on-surface"
              >
                <option value="">{{ session.t('issues.filters.allLocations') }}</option>
                <option value="0">{{ session.t('issues.locationOutside') }}</option>
                <option
                  v-for="ent in entrances"
                  :key="ent"
                  :value="String(ent)"
                >
                  {{ session.t('issues.locationEntrance', { n: ent }) }}
                </option>
              </select>
            </div>
          </div>
        </div>

        <!-- Board-only "Old issues" switch (include_old=true) -->
        <div
          v-if="isBoardOrChairman"
          class="mt-3 pt-3 border-t border-surface-container flex flex-wrap items-center justify-between gap-2"
        >
          <label
            for="issues-include-old-toggle"
            class="inline-flex items-center gap-2.5 text-xs font-semibold text-on-surface cursor-pointer select-none"
          >
            <input
              id="issues-include-old-toggle"
              v-model="includeOld"
              type="checkbox"
              data-testid="issues-include-old-toggle"
              class="h-4 w-4 rounded border-surface-container-high text-primary focus:ring-primary cursor-pointer"
            />
            <span>{{ session.t('issues.filters.includeOld') }}</span>
          </label>
          <span class="text-xs text-on-surface-variant">
            {{ session.t('issues.filters.includeOldHint') }}
          </span>
        </div>
      </div>

      <!-- Loading state -->
      <div
        v-if="isLoading"
        class="rounded-xl border border-surface-container bg-surface-container-lowest p-8 text-center text-sm text-on-surface-variant"
      >
        {{ session.t('common.loading') }}
      </div>

      <!-- Empty state -->
      <div
        v-else-if="issues.length === 0"
        data-testid="issues-empty-state"
        class="rounded-xl border border-dashed border-surface-container-high bg-surface-container-lowest p-10 text-center"
      >
        <span class="material-symbols-outlined text-3xl text-on-surface-variant/60">
          check_circle
        </span>
        <h2 class="mt-2 text-base font-semibold text-on-surface">
          {{ session.t('issues.emptyTitle') }}
        </h2>
        <p class="mt-1 text-sm text-on-surface-variant">
          {{ session.t('issues.emptyBody') }}
        </p>
        <div class="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            v-if="statusTab !== 'ALL' || selectedCategory || selectedEntrance !== '' || includeOld"
            type="button"
            class="rounded-lg border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer"
            @click="resetFilters"
          >
            {{ session.t('issues.filters.clearFilters') }}
          </button>
          <button
            type="button"
            class="rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary hover:bg-primary-container cursor-pointer"
            @click="showReportModal = true"
          >
            {{ session.t('issues.reportButton') }}
          </button>
        </div>
      </div>

      <!-- Issues list grouped: Open first, then Ended (last 30 days) -->
      <div v-else class="space-y-6">
        <!-- Open issues section -->
        <section v-if="openIssuesList.length > 0" class="space-y-3">
          <h2
            class="text-xs font-bold uppercase tracking-wider text-on-surface-variant px-1"
          >
            {{ session.t('issues.sections.openIssues', { count: openIssuesList.length }) }}
          </h2>

          <div class="space-y-3">
            <article
              v-for="issue in openIssuesList"
              :key="issue.id"
              :data-testid="`issue-card-${issue.id}`"
              class="rounded-xl border border-surface-container bg-surface-container-lowest p-4 sm:p-5 transition hover:border-primary/40 hover:shadow-2xs cursor-pointer"
              @click="router.push({ name: 'issue-detail', params: { issueId: issue.id } })"
            >
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div class="flex items-start gap-3.5 min-w-0">
                  <div
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary-container/60 text-on-secondary-container"
                  >
                    <span class="material-symbols-outlined text-[20px]">
                      {{ getCategoryIcon(issue.category) }}
                    </span>
                  </div>

                  <div class="min-w-0 space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold"
                        :class="statusBadgeClass(issue.status)"
                      >
                        {{ session.t(`issues.statuses.${issue.status}`) }}
                      </span>
                      <span
                        v-if="issue.urgent"
                        data-testid="issue-urgent-badge"
                        class="inline-flex items-center gap-1 rounded-md bg-rose-100 dark:bg-rose-950/60 px-2 py-0.5 text-xs font-bold text-rose-700 dark:text-rose-300"
                      >
                        <span class="material-symbols-outlined text-[14px]">priority_high</span>
                        {{ session.t('issues.urgentBadge') }}
                      </span>
                      <span class="text-xs font-semibold text-on-surface-variant">
                        {{ session.t(`issues.categories.${issue.category}`) }}
                      </span>
                      <span class="text-xs text-on-surface-variant/60">·</span>
                      <span class="text-xs text-on-surface-variant">
                        {{ formatLocation(issue) }}
                      </span>
                    </div>

                    <h3
                      class="text-base font-semibold text-on-surface truncate"
                    >
                      {{ issue.title }}
                    </h3>

                    <div
                      class="flex flex-wrap items-center gap-2.5 text-xs text-on-surface-variant"
                    >
                      <span>{{
                        session.t('issues.reportedOn', { date: formatDate(issue.created_at) })
                      }}</span>
                      <template v-if="issue.i_reported">
                        <span>·</span>
                        <span class="font-medium text-secondary">
                          {{ session.t('issues.reportedByYou') }}
                        </span>
                      </template>
                    </div>
                  </div>
                </div>

                <!-- Right column: followers & quick +1 -->
                <div
                  class="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-surface-container"
                >
                  <div
                    class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-2.5 py-1 text-xs font-semibold text-on-surface"
                    :title="session.t('issues.followersCount', { count: issue.followers })"
                  >
                    <span class="material-symbols-outlined text-[16px]">group</span>
                    <span>{{ issue.followers }}</span>
                  </div>

                  <button
                    v-if="issue.can_follow"
                    type="button"
                    :data-testid="`issue-follow-btn-${issue.id}`"
                    :disabled="followingId === issue.id"
                    class="inline-flex items-center gap-1 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-60"
                    @click="handleQuickFollow(issue, $event)"
                  >
                    <span class="material-symbols-outlined text-[15px]">thumb_up</span>
                    <span>{{ session.t('issues.followShort') }}</span>
                  </button>
                  <span
                    v-else-if="issue.i_follow"
                    class="inline-flex items-center gap-1 rounded-lg bg-secondary-container/60 px-2.5 py-1 text-xs font-semibold text-on-secondary-container"
                  >
                    <span class="material-symbols-outlined text-[15px]">check_circle</span>
                    {{ session.t('issues.youFollowBadge') }}
                  </span>
                </div>
              </div>
            </article>
          </div>
        </section>

        <!-- Ended issues section (within last 30 days, or all when includeOld is enabled) -->
        <section v-if="endedIssuesList.length > 0" class="space-y-3">
          <h2
            class="text-xs font-bold uppercase tracking-wider text-on-surface-variant px-1"
          >
            {{
              isBoardOrChairman && includeOld
                ? session.t('issues.sections.endedIssuesAll', { count: endedIssuesList.length })
                : session.t('issues.sections.endedIssues', { count: endedIssuesList.length })
            }}
          </h2>

          <div class="space-y-3">
            <article
              v-for="issue in endedIssuesList"
              :key="issue.id"
              :data-testid="`issue-card-${issue.id}`"
              class="rounded-xl border border-surface-container bg-surface-container-lowest p-4 sm:p-5 opacity-90 transition hover:opacity-100 hover:border-surface-container-high cursor-pointer"
              @click="router.push({ name: 'issue-detail', params: { issueId: issue.id } })"
            >
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div class="flex items-start gap-3.5 min-w-0">
                  <div
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-container text-on-surface-variant"
                  >
                    <span class="material-symbols-outlined text-[20px]">
                      {{ getCategoryIcon(issue.category) }}
                    </span>
                  </div>

                  <div class="min-w-0 space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold"
                        :class="statusBadgeClass(issue.status)"
                      >
                        {{ session.t(`issues.statuses.${issue.status}`) }}
                      </span>
                      <span class="text-xs font-semibold text-on-surface-variant">
                        {{ session.t(`issues.categories.${issue.category}`) }}
                      </span>
                      <span class="text-xs text-on-surface-variant/60">·</span>
                      <span class="text-xs text-on-surface-variant">
                        {{ formatLocation(issue) }}
                      </span>
                    </div>

                    <h3
                      class="text-base font-semibold text-on-surface truncate"
                    >
                      {{ issue.title }}
                    </h3>

                    <div
                      class="flex flex-wrap items-center gap-2.5 text-xs text-on-surface-variant"
                    >
                      <span>
                        {{
                          session.t('issues.endedOn', {
                            date: formatDate(issue.ended_at || issue.updated_at),
                          })
                        }}
                      </span>
                      <template v-if="issue.i_reported">
                        <span>·</span>
                        <span class="font-medium text-secondary">
                          {{ session.t('issues.reportedByYou') }}
                        </span>
                      </template>
                    </div>
                  </div>
                </div>

                <div class="flex items-center justify-end gap-2 shrink-0">
                  <div
                    class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-2.5 py-1 text-xs font-semibold text-on-surface-variant"
                  >
                    <span class="material-symbols-outlined text-[16px]">group</span>
                    <span>{{ issue.followers }}</span>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>
      </div>
    </template>

    <!-- Report Issue Modal -->
    <IssueFormModal
      :open="showReportModal"
      mode="create"
      @close="showReportModal = false"
      @saved="handleIssueCreated"
      @followed="handleSuggestionFollowed"
    />
  </div>
</template>
