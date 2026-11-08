<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { listPolls } from '@/api/endpoints/governance.js'
import { formatPollDateTime } from '@/utils/pollValidation.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

const polls = ref([])
const loading = ref(false)
const loadError = ref(null)
const statusFilter = ref('ALL')

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const filterTabs = computed(() => {
  const base = [
    { key: 'ALL', label: session.t('polls.filters.all') },
    { key: 'OPEN', label: session.t('polls.filters.open') },
    { key: 'CLOSED', label: session.t('polls.filters.closed') },
    { key: 'CANCELLED', label: session.t('polls.filters.cancelled') },
  ]
  if (isBoardOrChairman.value) {
    base.splice(2, 0, { key: 'DRAFT', label: session.t('polls.filters.draft') })
  }
  return base
})

let fetchPollsSeq = 0

async function fetchPolls() {
  const seq = ++fetchPollsSeq
  loading.value = true
  loadError.value = null
  try {
    if (statusFilter.value === 'DRAFT' && !isBoardOrChairman.value) {
      statusFilter.value = 'ALL'
    }
    const params = {}
    if (statusFilter.value && statusFilter.value !== 'ALL') {
      params.status = statusFilter.value
    }
    const res = await listPolls(params)
    if (seq !== fetchPollsSeq) return
    polls.value = Array.isArray(res) ? res : []
  } catch (err) {
    if (seq !== fetchPollsSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchPollsSeq) {
      loading.value = false
    }
  }
}

function formatTargetScope(poll) {
  if (poll.target_scope === 'ENTRANCE' && poll.target_entrance != null) {
    return session.t('polls.target.entrance', { entrance: poll.target_entrance })
  }
  if (poll.target_scope === 'APARTMENT_LIST') {
    return session.t('polls.target.selectedApartments')
  }
  return session.t('polls.target.allBuilding')
}

function statusBadgeClass(status) {
  if (status === 'OPEN') {
    return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
  }
  if (status === 'CLOSED') {
    return 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
  }
  if (status === 'CANCELLED') {
    return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
  }
  return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
}

watch(
  () => [statusFilter.value, session.actingUserId],
  () => {
    fetchPolls()
  },
)

onMounted(() => {
  fetchPolls()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <!-- Page Header -->
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-slate-200 dark:border-slate-800 pb-5">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">
          {{ session.t('polls.eyebrow') }}
        </p>
        <h1 class="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-3xl">
          {{ session.t('polls.title') }}
        </h1>
        <p class="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
          {{ session.t('polls.subtitle') }}
        </p>
      </div>

      <RouterLink
        v-if="isBoardOrChairman"
        :to="{ name: 'poll-new' }"
        data-testid="polls-new-poll-btn"
        class="inline-flex items-center gap-2 self-start rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 sm:self-auto dark:bg-teal-600 dark:hover:bg-teal-500"
      >
        <span class="material-symbols-outlined text-[18px]">add</span>
        <span>{{ session.t('polls.board.newPollBtn') }}</span>
      </RouterLink>
    </header>

    <!-- Status Filter Bar -->
    <div
      class="flex flex-wrap items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3"
      role="tablist"
      :aria-label="session.t('polls.filters.ariaLabel')"
    >
      <button
        v-for="tab in filterTabs"
        :key="tab.key"
        type="button"
        role="tab"
        :aria-selected="statusFilter === tab.key"
        :data-testid="`polls-filter-${tab.key.toLowerCase()}`"
        class="rounded-md px-3.5 py-2 text-sm font-medium transition-colors"
        :class="
          statusFilter === tab.key
            ? 'bg-slate-900 text-white dark:bg-teal-600 dark:text-white shadow-xs'
            : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800 dark:hover:bg-slate-800'
        "
        @click="statusFilter = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Error State -->
    <ErrorCard
      v-if="loadError"
      :error="loadError"
      @retry="fetchPolls"
    />

    <!-- Loading State -->
    <div
      v-else-if="loading"
      class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
    >
      {{ session.t('polls.loading') }}
    </div>

    <!-- Empty State -->
    <div
      v-else-if="polls.length === 0"
      data-testid="polls-empty-state"
      class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900"
    >
      <span class="material-symbols-outlined text-3xl text-slate-400 dark:text-slate-500">
        how_to_vote
      </span>
      <h2 class="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        {{ session.t('polls.emptyTitle') }}
      </h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {{ session.t('polls.emptySubtitle') }}
      </p>
    </div>

    <!-- Polls List -->
    <div v-else class="space-y-4" data-testid="polls-list">
      <article
        v-for="poll in polls"
        :key="poll.id"
        :data-testid="`poll-card-${poll.id}`"
        class="group cursor-pointer rounded-xl border border-slate-200 bg-white p-5 transition-all hover:border-teal-600/60 hover:shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-500/60"
        @click="router.push({ name: 'poll-detail', params: { pollId: poll.id } })"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="space-y-1.5 min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide"
                :class="statusBadgeClass(poll.status)"
              >
                {{ session.t(`polls.status.${poll.status}`) }}
              </span>

              <!-- Action Needed Badge ONLY when can_answer && !answered -->
              <span
                v-if="poll.can_answer && !poll.answered"
                data-testid="poll-please-answer-badge"
                class="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
              >
                <span class="material-symbols-outlined text-[14px]">schedule</span>
                {{ session.t('polls.pleaseAnswerBadge') }}
              </span>

              <!-- Answered Indicator -->
              <span
                v-else-if="poll.answered && poll.status !== 'CANCELLED'"
                data-testid="poll-answered-badge"
                class="inline-flex items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300"
              >
                <span class="material-symbols-outlined text-[14px]">check_circle</span>
                {{
                  poll.unit === 'APARTMENT'
                    ? session.t('polls.yourApartmentAnsweredBadge')
                    : session.t('polls.youAnsweredBadge')
                }}
              </span>
            </div>

            <h2 class="text-lg font-semibold text-slate-900 group-hover:text-teal-700 dark:text-slate-100 dark:group-hover:text-teal-400">
              <RouterLink
                :to="{ name: 'poll-detail', params: { pollId: poll.id } }"
                @click.stop
              >
                {{ poll.title }}
              </RouterLink>
            </h2>

            <p
              v-if="poll.description"
              class="line-clamp-2 text-sm text-slate-600 dark:text-slate-400"
            >
              {{ poll.description }}
            </p>
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2 sm:self-center">
            <RouterLink
              v-if="poll.results_available"
              :to="{ name: 'poll-results', params: { pollId: poll.id } }"
              data-testid="poll-results-link"
              class="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-1.5 text-xs font-semibold text-teal-800 transition-colors hover:bg-teal-100 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300 dark:hover:bg-teal-900/60"
              @click.stop
            >
              <span class="material-symbols-outlined text-[15px]">bar_chart</span>
              <span>{{ session.t('polls.results.viewResultsBtn') }}</span>
            </RouterLink>

            <RouterLink
              :to="{ name: 'poll-detail', params: { pollId: poll.id } }"
              class="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 dark:text-teal-400"
              @click.stop
            >
              <span>{{ session.t('polls.openPollLink') }}</span>
              <span class="material-symbols-outlined text-[16px] transition-transform group-hover:translate-x-0.5">
                arrow_forward
              </span>
            </RouterLink>
          </div>
        </div>

        <!-- Metadata Footer -->
        <div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-xs text-slate-600 dark:border-slate-800/80 dark:text-slate-400">
          <span class="inline-flex items-center gap-1.5 font-mono">
            <span class="material-symbols-outlined text-[15px] text-slate-400">event</span>
            <template v-if="poll.status === 'OPEN'">
              {{ session.t('polls.closesAtLabel', { date: formatPollDateTime(poll.closes_at, session.lang) }) }}
            </template>
            <template v-else-if="poll.status === 'CLOSED'">
              {{ session.t('polls.closedAtLabel', { date: formatPollDateTime(poll.closed_at || poll.closes_at, session.lang) }) }}
            </template>
            <template v-else-if="poll.status === 'CANCELLED'">
              {{ session.t('polls.cancelledAtLabel', { date: formatPollDateTime(poll.cancelled_at || poll.closes_at, session.lang) }) }}
            </template>
            <template v-else>
              {{ session.t('polls.closesAtLabel', { date: formatPollDateTime(poll.closes_at, session.lang) }) }}
            </template>
          </span>

          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px] text-slate-400">group</span>
            {{ session.t(`polls.eligibility.${poll.eligibility}`) }}
          </span>

          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px] text-slate-400">ballot</span>
            {{ session.t(`polls.unit.${poll.unit}`) }}
          </span>

          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px] text-slate-400">domain</span>
            {{ formatTargetScope(poll) }}
          </span>
        </div>
      </article>
    </div>
  </div>
</template>
