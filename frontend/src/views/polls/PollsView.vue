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
const searchQuery = ref('')

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const needsVoteCount = computed(
  () => polls.value.filter((p) => p.can_answer && !p.answered && p.status === 'OPEN').length,
)
const openCount = computed(
  () => polls.value.filter((p) => p.status === 'OPEN').length,
)
const votedCount = computed(
  () => polls.value.filter((p) => p.answered).length,
)

const filterTabs = computed(() => {
  const base = [
    { key: 'ALL', label: session.t('polls.filters.all'), count: polls.value.length },
    {
      key: 'NEEDS_VOTE',
      label: session.t('polls.filters.needsVote'),
      count: needsVoteCount.value,
      highlight: needsVoteCount.value > 0,
      icon: 'schedule',
    },
    { key: 'OPEN', label: session.t('polls.filters.open'), count: openCount.value },
    { key: 'VOTED', label: session.t('polls.filters.voted'), count: votedCount.value },
    { key: 'CLOSED', label: session.t('polls.filters.closed') },
    { key: 'CANCELLED', label: session.t('polls.filters.cancelled') },
  ]
  if (isBoardOrChairman.value) {
    base.splice(4, 0, {
      key: 'DRAFT',
      label: session.t('polls.filters.draft'),
      count: polls.value.filter((p) => p.status === 'DRAFT').length,
    })
  }
  return base
})

const filteredPolls = computed(() => {
  let list = polls.value
  if (statusFilter.value === 'NEEDS_VOTE') {
    list = list.filter((p) => p.can_answer && !p.answered && p.status === 'OPEN')
  } else if (statusFilter.value === 'VOTED') {
    list = list.filter((p) => p.answered)
  } else if (statusFilter.value !== 'ALL') {
    list = list.filter((p) => p.status === statusFilter.value)
  }

  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (p) =>
      String(p.title || '').toLowerCase().includes(q) ||
      String(p.description || '').toLowerCase().includes(q),
  )
})

let fetchPollsSeq = 0

async function fetchPolls() {
  const seq = ++fetchPollsSeq
  loading.value = true
  loadError.value = null
  try {
    const res = await listPolls()
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
  () => [session.actingUserId, session.sessionRevision],
  () => {
    fetchPolls()
  },
)

onMounted(() => {
  fetchPolls()
})
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <header class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-surface-container pb-5">
      <div>
        <p class="font-label-md text-xs font-semibold uppercase tracking-wider text-secondary">
          {{ session.t('polls.eyebrow') }}
        </p>
        <h1 class="mt-1 font-headline-xl text-2xl font-bold tracking-tight text-on-surface sm:text-3xl">
          {{ session.t('polls.title') }}
        </h1>
        <p class="mt-1.5 text-sm text-on-surface-variant">
          {{ session.t('polls.subtitle') }}
        </p>
      </div>

      <RouterLink
        v-if="isBoardOrChairman"
        :to="{ name: 'poll-new' }"
        data-testid="polls-new-poll-btn"
        class="inline-flex items-center gap-2 self-start rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-container sm:self-auto"
      >
        <span class="material-symbols-outlined text-[18px]">add</span>
        <span>{{ session.t('polls.board.newPollBtn') }}</span>
      </RouterLink>
    </header>

    <!-- Status Filter & Search Bar -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-surface-container pb-3">
      <!-- Status Filter Tabs -->
      <div
        class="flex flex-wrap items-center gap-1.5"
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
          class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer"
          :class="
            statusFilter === tab.key
              ? tab.key === 'NEEDS_VOTE'
                ? 'bg-amber-600 text-white shadow-2xs'
                : 'bg-primary text-on-primary shadow-2xs'
              : tab.highlight
                ? 'bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-700 hover:bg-amber-100'
                : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container hover:text-on-surface border border-surface-container'
          "
          @click="statusFilter = tab.key"
        >
          <span v-if="tab.icon" class="material-symbols-outlined text-[15px]">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
          <span
            v-if="tab.count !== undefined"
            class="px-1.5 py-0.2 rounded-full text-[10px] font-bold"
            :class="
              statusFilter === tab.key
                ? 'bg-white/20 text-white'
                : tab.highlight
                  ? 'bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-100'
                  : 'bg-surface-container-highest text-on-surface-variant'
            "
          >
            {{ tab.count }}
          </span>
        </button>
      </div>

      <!-- Quick Search -->
      <div class="relative w-full sm:w-64">
        <span class="material-symbols-outlined text-[17px] text-on-surface-variant absolute left-2.5 top-1/2 -translate-y-1/2">
          search
        </span>
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="session.t('messages.searchPlaceholder')"
          class="w-full rounded-lg border border-surface-container-high bg-surface-container-low pl-8 pr-3 py-1.5 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
        />
      </div>
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
      class="rounded-xl border border-surface-container bg-surface-container-lowest p-8 text-center text-sm text-on-surface-variant"
    >
      {{ session.t('polls.loading') }}
    </div>

    <!-- Empty State -->
    <div
      v-else-if="filteredPolls.length === 0"
      data-testid="polls-empty-state"
      class="rounded-xl border border-dashed border-surface-container-high bg-surface-container-lowest p-10 text-center"
    >
      <span class="material-symbols-outlined text-3xl text-on-surface-variant/60">
        how_to_vote
      </span>
      <h2 class="mt-2 text-base font-semibold text-on-surface">
        {{ session.t('polls.emptyTitle') }}
      </h2>
      <p class="mt-1 text-sm text-on-surface-variant">
        {{ session.t('polls.emptySubtitle') }}
      </p>
    </div>

    <!-- Polls List -->
    <div v-else class="space-y-4" data-testid="polls-list">
      <article
        v-for="poll in filteredPolls"
        :key="poll.id"
        :data-testid="`poll-card-${poll.id}`"
        class="group cursor-pointer rounded-xl border border-surface-container bg-surface-container-lowest p-5 transition-all hover:border-primary/40 hover:shadow-xs"
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
                class="inline-flex items-center gap-1 rounded-md bg-secondary-container/70 px-2.5 py-0.5 text-xs font-semibold text-on-secondary-container"
              >
                <span class="material-symbols-outlined text-[14px]">check_circle</span>
                {{
                  poll.unit === 'APARTMENT'
                    ? session.t('polls.yourApartmentAnsweredBadge')
                    : session.t('polls.youAnsweredBadge')
                }}
              </span>
            </div>

            <h2 class="text-lg font-semibold text-on-surface group-hover:text-primary transition-colors">
              <RouterLink
                :to="{ name: 'poll-detail', params: { pollId: poll.id } }"
                @click.stop
              >
                {{ poll.title }}
              </RouterLink>
            </h2>

            <p
              v-if="poll.description"
              class="line-clamp-2 text-sm text-on-surface-variant"
            >
              {{ poll.description }}
            </p>
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2 sm:self-center">
            <RouterLink
              v-if="poll.results_available"
              :to="{ name: 'poll-results', params: { pollId: poll.id } }"
              data-testid="poll-results-link"
              class="inline-flex items-center gap-1 rounded-lg bg-secondary-container/60 px-3 py-1.5 text-xs font-semibold text-on-secondary-container transition-colors hover:bg-secondary-container"
              @click.stop
            >
              <span class="material-symbols-outlined text-[15px]">bar_chart</span>
              <span>{{ session.t('polls.results.viewResultsBtn') }}</span>
            </RouterLink>

            <RouterLink
              :to="{ name: 'poll-detail', params: { pollId: poll.id } }"
              class="inline-flex items-center gap-1.5 text-xs font-semibold text-primary"
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
        <div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-surface-container pt-3 text-xs text-on-surface-variant">
          <span class="inline-flex items-center gap-1.5 font-mono">
            <span class="material-symbols-outlined text-[15px] text-on-surface-variant/80">event</span>
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
            <span class="material-symbols-outlined text-[15px] text-on-surface-variant/80">group</span>
            {{ session.t(`polls.eligibility.${poll.eligibility}`) }}
          </span>

          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px] text-on-surface-variant/80">ballot</span>
            {{ session.t(`polls.unit.${poll.unit}`) }}
          </span>

          <span class="inline-flex items-center gap-1">
            <span class="material-symbols-outlined text-[15px] text-on-surface-variant/80">domain</span>
            {{ formatTargetScope(poll) }}
          </span>
        </div>
      </article>
    </div>
  </div>
</template>
