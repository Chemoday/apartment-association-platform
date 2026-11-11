<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { listMaintenanceTasks } from '@/api/endpoints/maintenance.js'
import { formatDate } from '@/utils/dates.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()
const { canManageMaintenance } = useRole()

const tasks = ref([])
const loading = ref(true)
const loadError = ref(null)

const activeTab = ref('ACTIVE') // 'ACTIVE' | 'OVERDUE' | 'ARCHIVED'
const stateFilter = ref('') // '' | 'UPCOMING' | 'DUE' | 'OVERDUE' | 'PAUSED'

const filteredTasks = computed(() => {
  return tasks.value
})

const countOverdue = computed(() => {
  return tasks.value.filter((t) => t.current?.state === 'OVERDUE').length
})

function stateBadgeClass(state) {
  if (state === 'OVERDUE') {
    return 'bg-error-container text-on-error-container border-error/30'
  }
  if (state === 'DUE') {
    return 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-700'
  }
  if (state === 'PAUSED') {
    return 'bg-surface-container text-on-surface-variant border-surface-container-high'
  }
  return 'bg-secondary-container/60 text-secondary border-secondary/30'
}

function formatRhythm(unit, count) {
  const c = Number(count) || 1
  if (unit === 'DAY') {
    return c === 1 ? session.t('maintenance.rhythm.everyDay') : session.t('maintenance.rhythm.everyDays', { count: c })
  }
  if (unit === 'MONTH') {
    return c === 1 ? session.t('maintenance.rhythm.everyMonth') : session.t('maintenance.rhythm.everyMonths', { count: c })
  }
  if (unit === 'YEAR') {
    return c === 1 ? session.t('maintenance.rhythm.everyYear') : session.t('maintenance.rhythm.everyYears', { count: c })
  }
  return `${count} ${unit}`
}

async function fetchTasks() {
  if (!canManageMaintenance.value) return
  loading.value = true
  loadError.value = null

  try {
    const params = {}
    if (activeTab.value === 'ARCHIVED') {
      params.status = 'ARCHIVED'
    } else if (activeTab.value === 'OVERDUE') {
      params.state = 'OVERDUE'
    }

    if (stateFilter.value && activeTab.value === 'ACTIVE') {
      params.state = stateFilter.value
    }

    const data = await listMaintenanceTasks(params)
    tasks.value = Array.isArray(data) ? data : []
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

watch(
  () => [activeTab.value, stateFilter.value, session.actingUserId],
  () => {
    fetchTasks()
  },
)

onMounted(() => {
  fetchTasks()
})
</script>

<template>
  <div class="w-full max-w-6xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 text-xs">
          <span class="font-bold uppercase tracking-wider text-primary">
            {{ session.t('maintenance.pageBadge') }}
          </span>
          <span aria-hidden="true" class="text-on-surface-variant/40">•</span>
          <span class="text-on-surface-variant">
            {{ session.t('maintenance.boardOnly') }}
          </span>
        </div>
        <h1 class="font-headline-md sm:font-headline-lg font-bold text-on-surface mt-1">
          {{ session.t('maintenance.pageTitle') }}
        </h1>
        <p class="text-sm text-on-surface-variant mt-0.5">
          {{ session.t('maintenance.pageSubtitle') }}
        </p>
      </div>

      <div v-if="canManageMaintenance" class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="open-maintenance-log-btn"
          class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-surface-container-high bg-surface-container-lowest text-on-surface font-semibold text-sm hover:bg-surface-container transition-colors shadow-2xs cursor-pointer"
          @click="router.push('/maintenance/log')"
        >
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">history_edu</span>
          <span>{{ session.t('maintenance.openLogBtn') }}</span>
        </button>

        <button
          type="button"
          data-testid="create-maintenance-task-btn"
          class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-on-primary font-semibold text-sm hover:bg-primary-container transition-colors shadow-xs cursor-pointer"
          @click="router.push('/maintenance/new')"
        >
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">add</span>
          <span>{{ session.t('maintenance.createTaskBtn') }}</span>
        </button>
      </div>
    </div>

    <!-- Permission Guard for Non-Board Users -->
    <div
      v-if="!canManageMaintenance"
      data-testid="maintenance-forbidden"
      class="p-8 rounded-2xl bg-surface-container-lowest border border-surface-container text-center space-y-3"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant">
        <span class="material-symbols-outlined text-[24px]">lock</span>
      </div>
      <h3 class="font-bold text-base text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h3>
      <p class="text-sm text-on-surface-variant max-w-md mx-auto">
        {{ session.t('maintenance.forbiddenDesc') }}
      </p>
    </div>

    <template v-else>
      <!-- Navigation Tabs -->
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-surface-container pb-2">
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-testid="tab-active-tasks"
            class="px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            :class="
              activeTab === 'ACTIVE'
                ? 'bg-primary text-on-primary shadow-xs'
                : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
            "
            @click="activeTab = 'ACTIVE'; stateFilter = ''"
          >
            {{ session.t('maintenance.tabs.active') }}
          </button>

          <button
            type="button"
            data-testid="tab-overdue-tasks"
            class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            :class="
              activeTab === 'OVERDUE'
                ? 'bg-error text-on-error shadow-xs'
                : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
            "
            @click="activeTab = 'OVERDUE'; stateFilter = ''"
          >
            <span>{{ session.t('maintenance.tabs.overdue') }}</span>
            <span
              v-if="countOverdue > 0"
              class="px-1.5 py-0.2 rounded-full text-[10px] font-bold"
              :class="activeTab === 'OVERDUE' ? 'bg-error-container text-on-error-container' : 'bg-error/20 text-error'"
            >
              {{ countOverdue }}
            </span>
          </button>

          <button
            type="button"
            data-testid="tab-archived-tasks"
            class="px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            :class="
              activeTab === 'ARCHIVED'
                ? 'bg-surface-container-highest text-on-surface shadow-xs'
                : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
            "
            @click="activeTab = 'ARCHIVED'; stateFilter = ''"
          >
            {{ session.t('maintenance.tabs.archived') }}
          </button>
        </div>

        <!-- State sub-filter for Active tab -->
        <div v-if="activeTab === 'ACTIVE'" class="flex items-center gap-2 text-xs">
          <span class="text-on-surface-variant font-medium">{{ session.t('maintenance.filterState') }}:</span>
          <select
            v-model="stateFilter"
            data-testid="maintenance-state-filter"
            class="rounded-lg border border-surface-container bg-surface-container-lowest px-2.5 py-1 text-xs text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="">{{ session.t('maintenance.states.ALL') }}</option>
            <option value="UPCOMING">{{ session.t('maintenance.states.UPCOMING') }}</option>
            <option value="DUE">{{ session.t('maintenance.states.DUE') }}</option>
            <option value="OVERDUE">{{ session.t('maintenance.states.OVERDUE') }}</option>
            <option value="PAUSED">{{ session.t('maintenance.states.PAUSED') }}</option>
          </select>
        </div>
      </div>

      <ErrorCard v-if="loadError" :error="loadError" @retry="fetchTasks" />

      <!-- Loading State -->
      <div v-else-if="loading" class="space-y-3">
        <div v-for="i in 3" :key="i" class="p-6 rounded-2xl bg-surface-container-lowest border border-surface-container animate-pulse space-y-3">
          <div class="h-4 bg-surface-container-high rounded w-1/3"></div>
          <div class="h-3 bg-surface-container rounded w-1/2"></div>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-else-if="filteredTasks.length === 0"
        data-testid="maintenance-tasks-empty"
        class="py-16 text-center rounded-2xl bg-surface-container-lowest border border-surface-container space-y-3"
      >
        <div class="w-12 h-12 rounded-full bg-surface-container-low mx-auto flex items-center justify-center text-on-surface-variant">
          <span class="material-symbols-outlined text-[24px]">event_repeat</span>
        </div>
        <h3 class="font-bold text-sm text-on-surface">
          {{ session.t('maintenance.emptyTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant max-w-sm mx-auto">
          {{ session.t('maintenance.emptyDesc') }}
        </p>
      </div>

      <!-- Tasks List -->
      <div v-else class="space-y-3">
        <div
          v-for="task in filteredTasks"
          :key="task.id"
          :data-testid="`maintenance-task-card-${task.id}`"
          class="group p-4 sm:p-5 rounded-2xl bg-surface-container-lowest border border-surface-container hover:border-primary/40 hover:shadow-sm transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer"
          @click="router.push(`/maintenance/${task.id}`)"
        >
          <div class="space-y-1.5 min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <!-- State Badge -->
              <span
                v-if="task.current?.state"
                class="px-2.5 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider"
                :class="stateBadgeClass(task.current.state)"
              >
                {{ session.t(`maintenance.states.${task.current.state}`) }}
              </span>
              <span
                v-else-if="task.status === 'ARCHIVED'"
                class="px-2.5 py-0.5 rounded-full border border-surface-container text-on-surface-variant text-[11px] font-bold uppercase"
              >
                {{ session.t('maintenance.states.ARCHIVED') }}
              </span>

              <!-- Rhythm Badge -->
              <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant font-medium">
                <span class="material-symbols-outlined text-[14px]">repeat</span>
                {{ formatRhythm(task.period_unit, task.period_count) }}
              </span>

              <span aria-hidden="true" class="text-on-surface-variant/40">•</span>

              <!-- Notice Badge -->
              <span
                v-if="task.notice"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-container text-on-surface-variant text-[10px] font-bold"
              >
                <span class="material-symbols-outlined text-[12px]">campaign</span>
                {{ session.t('maintenance.hasNoticeBadge') }}
              </span>
            </div>

            <h3 class="font-bold text-base text-on-surface group-hover:text-primary transition-colors">
              {{ task.title }}
            </h3>

            <!-- Internal instructions snippet (board only) -->
            <p v-if="task.instructions" class="text-xs text-on-surface-variant line-clamp-1 italic">
              {{ task.instructions }}
            </p>
          </div>

          <!-- Right column: Next Due Date & Action -->
          <div class="flex items-center justify-between sm:justify-end gap-4 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-surface-container">
            <div class="text-left sm:text-right">
              <span class="block text-[11px] font-medium text-on-surface-variant uppercase tracking-wider">
                {{ task.status === 'ARCHIVED' ? session.t('maintenance.archivedOn') : session.t('maintenance.nextDueDate') }}
              </span>
              <span class="font-mono text-sm font-bold text-on-surface">
                {{ task.status === 'ARCHIVED' ? formatDate(task.archived_at, session.lang) : formatDate(task.current?.due_date, session.lang) }}
              </span>
            </div>

            <span class="material-symbols-outlined text-[20px] text-on-surface-variant group-hover:text-primary group-hover:translate-x-0.5 transition-all">
              chevron_right
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
