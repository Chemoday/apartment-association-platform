<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  editMaintenanceLogEntry,
  listMaintenanceLog,
  listMaintenanceTasks,
} from '@/api/endpoints/maintenance.js'
import {
  formatCost,
  normalizeCostInput,
  sumCosts,
} from '@/utils/maintenance.js'
import { formatDate } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const session = useSessionStore()
const { canManageMaintenance, canViewMaintenanceLog } = useRole()

const entries = ref([])
const knownTasksMap = ref(new Map()) // task_id -> task_title
const loading = ref(true)
const loadError = ref(null)

const taskFilter = ref(typeof route.query.task_id === 'string' ? route.query.task_id : '')
const fromFilter = ref('')
const toFilter = ref('')

// Edit log modal state (BOARD and CHAIRMAN only)
const showEditModal = ref(false)
const editingEntry = ref(null)
const editNote = ref('')
const editCost = ref('')
const editError = ref('')
const editPending = ref(false)

const taskOptions = computed(() => {
  return Array.from(knownTasksMap.value.entries()).map(([id, title]) => ({
    id,
    title,
  }))
})

const hasActiveFilters = computed(() => {
  return Boolean(taskFilter.value || fromFilter.value || toFilter.value)
})

const totalCostFormatted = computed(() => {
  const rawTotal = sumCosts(entries.value.map((e) => e.cost))
  return formatCost(rawTotal, session.lang)
})

function logKindBadgeClass(kind) {
  if (kind === 'DONE') {
    return 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-700'
  }
  return 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-700'
}

function recordKnownTasksFromEntries(list) {
  const next = new Map(knownTasksMap.value)
  for (const item of list) {
    if (item?.task_id && item?.task_title) {
      next.set(item.task_id, item.task_title)
    }
  }
  knownTasksMap.value = next
}

async function fetchKnownTasksForBoard() {
  if (!canManageMaintenance.value) return
  try {
    const [activeTasks, archivedTasks] = await Promise.all([
      listMaintenanceTasks(),
      listMaintenanceTasks({ status: 'ARCHIVED' }),
    ])
    const next = new Map(knownTasksMap.value)
    for (const t of [...(activeTasks || []), ...(archivedTasks || [])]) {
      if (t?.id && t?.title) {
        next.set(t.id, t.title)
      }
    }
    knownTasksMap.value = next
  } catch {
    // Non-blocking: task options also populate from log entries
  }
}

async function fetchLog() {
  if (!canViewMaintenanceLog.value) return
  loading.value = true
  loadError.value = null

  try {
    const params = {}
    if (taskFilter.value) params.task_id = taskFilter.value
    if (fromFilter.value) params.from = fromFilter.value
    if (toFilter.value) params.to = toFilter.value

    const data = await listMaintenanceLog(params)
    const list = Array.isArray(data) ? data : []
    entries.value = list
    recordKnownTasksFromEntries(list)
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

function clearFilters() {
  taskFilter.value = ''
  fromFilter.value = ''
  toFilter.value = ''
}

function openEditModal(entry) {
  if (!canManageMaintenance.value) return
  editingEntry.value = entry
  editNote.value = entry.note || ''
  editCost.value = entry.cost ? formatCost(entry.cost, session.lang) : ''
  editError.value = ''
  showEditModal.value = true
}

async function handleSaveEdit() {
  if (!editingEntry.value || !canManageMaintenance.value) return
  editError.value = ''

  const trimmedNote = editNote.value.trim()
  if (editingEntry.value.kind === 'SKIPPED' && trimmedNote.length < 1) {
    editError.value = session.t('maintenance.skipModal.noteRequired')
    return
  }
  if (trimmedNote.length > 1000) {
    editError.value = session.t('maintenance.doneModal.invalidNoteLength')
    return
  }

  const payload = {
    note: trimmedNote,
  }

  if (editingEntry.value.kind === 'DONE') {
    const normalizedCost = normalizeCostInput(editCost.value)
    if (normalizedCost === undefined) {
      editError.value = session.t('maintenance.doneModal.invalidCost')
      return
    }
    payload.cost = normalizedCost
  }

  editPending.value = true
  try {
    const updated = await editMaintenanceLogEntry(editingEntry.value.id, payload)
    entries.value = entries.value.map((item) => (item.id === updated.id ? updated : item))
    showEditModal.value = false
    editingEntry.value = null
  } catch (err) {
    editError.value = localizeError(err, {}, session.lang)
  } finally {
    editPending.value = false
  }
}

watch(
  () => [taskFilter.value, fromFilter.value, toFilter.value, session.actingUserId],
  () => {
    fetchLog()
  },
)

watch(
  () => session.actingUserId,
  () => {
    if (canManageMaintenance.value) {
      fetchKnownTasksForBoard()
    }
  },
)

onMounted(async () => {
  if (canManageMaintenance.value) {
    fetchKnownTasksForBoard()
  }
  await fetchLog()
})
</script>

<template>
  <div class="w-full max-w-6xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Back Link (only for Chairman and Board, who reach the log from the Maintenance Calendar) -->
    <div v-if="canManageMaintenance">
      <RouterLink
        to="/maintenance"
        data-testid="back-to-maintenance-calendar-link"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        <span>{{ session.t('maintenance.log.backToCalendar') }}</span>
      </RouterLink>
    </div>

    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 text-xs">
          <span class="font-bold uppercase tracking-wider text-primary">
            {{ session.t('maintenance.log.pageBadge') }}
          </span>
          <span aria-hidden="true" class="text-on-surface-variant/40">•</span>
          <span class="text-on-surface-variant">
            {{ session.t('maintenance.log.boardAndAccountantOnly') }}
          </span>
        </div>
        <h1 class="font-headline-md sm:font-headline-lg font-bold text-on-surface mt-1">
          {{ session.t('maintenance.log.pageTitle') }}
        </h1>
        <p class="text-sm text-on-surface-variant mt-0.5">
          {{ session.t('maintenance.log.pageSubtitle') }}
        </p>
      </div>
    </div>

    <!-- Role Guard -->
    <div
      v-if="!canViewMaintenanceLog"
      data-testid="maintenance-log-forbidden"
      class="p-8 rounded-2xl bg-surface-container-lowest border border-surface-container text-center space-y-3"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant">
        <span class="material-symbols-outlined text-[24px]">lock</span>
      </div>
      <h3 class="font-bold text-base text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h3>
      <p class="text-sm text-on-surface-variant max-w-md mx-auto">
        {{ session.t('maintenance.log.forbiddenDesc') }}
      </p>
    </div>

    <template v-else>
      <!-- Filters & Total Cost Bar -->
      <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xs">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <!-- Task Filter -->
          <div>
            <label for="log-task-filter" class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1">
              {{ session.t('maintenance.log.filterTask') }}
            </label>
            <select
              id="log-task-filter"
              v-model="taskFilter"
              data-testid="log-task-filter"
              class="w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-xs text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="">{{ session.t('maintenance.log.allTasks') }}</option>
              <option v-for="t in taskOptions" :key="t.id" :value="t.id">
                {{ t.title }}
              </option>
            </select>
          </div>

          <!-- From Date Filter -->
          <div>
            <label for="log-from-filter" class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1">
              {{ session.t('maintenance.log.filterFrom') }}
            </label>
            <input
              id="log-from-filter"
              v-model="fromFilter"
              type="date"
              data-testid="log-from-filter"
              class="w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
          </div>

          <!-- To Date Filter -->
          <div>
            <label for="log-to-filter" class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1">
              {{ session.t('maintenance.log.filterTo') }}
            </label>
            <input
              id="log-to-filter"
              v-model="toFilter"
              type="date"
              data-testid="log-to-filter"
              class="w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        <!-- Summary & Clear Filters Row -->
        <div class="pt-3 border-t border-surface-container flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3 text-xs">
            <span class="text-on-surface-variant font-medium">
              {{ session.t('maintenance.log.entriesCount', { count: entries.length }) }}
            </span>

            <button
              v-if="hasActiveFilters"
              type="button"
              data-testid="log-clear-filters-btn"
              class="text-xs font-semibold text-primary hover:underline cursor-pointer"
              @click="clearFilters"
            >
              {{ session.t('maintenance.log.clearFilters') }}
            </button>
          </div>

          <div class="flex items-center gap-2 bg-surface-container-low px-3.5 py-1.5 rounded-xl border border-surface-container">
            <span class="text-xs font-medium text-on-surface-variant">
              {{ session.t('maintenance.log.totalCostLabel') }}:
            </span>
            <span
              data-testid="maintenance-log-total-cost"
              class="font-mono text-sm font-bold text-on-surface"
            >
              {{ totalCostFormatted }}
            </span>
          </div>
        </div>
      </div>

      <ErrorCard v-if="loadError" :error="loadError" @retry="fetchLog" />

      <!-- Loading State -->
      <div v-else-if="loading" class="space-y-3">
        <div v-for="i in 3" :key="i" class="p-6 rounded-2xl bg-surface-container-lowest border border-surface-container animate-pulse space-y-3">
          <div class="h-4 bg-surface-container-high rounded w-1/3"></div>
          <div class="h-3 bg-surface-container rounded w-1/2"></div>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-else-if="entries.length === 0"
        data-testid="maintenance-log-empty"
        class="py-16 text-center rounded-2xl bg-surface-container-lowest border border-surface-container space-y-3"
      >
        <div class="w-12 h-12 rounded-full bg-surface-container-low mx-auto flex items-center justify-center text-on-surface-variant">
          <span class="material-symbols-outlined text-[24px]">history_edu</span>
        </div>
        <h3 class="font-bold text-sm text-on-surface">
          {{ session.t('maintenance.log.emptyTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant max-w-sm mx-auto">
          {{ session.t('maintenance.log.emptyDesc') }}
        </p>
      </div>

      <!-- Log Entries List -->
      <div v-else class="space-y-3">
        <div
          v-for="entry in entries"
          :key="entry.id"
          :data-testid="`maintenance-log-entry-${entry.id}`"
          class="p-5 rounded-2xl bg-surface-container-lowest border border-surface-container space-y-3 shadow-2xs"
        >
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div class="space-y-1.5 min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <!-- Kind Badge -->
                <span
                  class="px-2.5 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider"
                  :class="logKindBadgeClass(entry.kind)"
                >
                  {{ session.t(`maintenance.log.kind.${entry.kind}`) }}
                </span>

                <!-- Closed Date -->
                <span class="text-xs text-on-surface-variant">
                  {{ session.t('maintenance.log.closedOn') }}:
                  <strong class="font-mono text-on-surface">{{ formatDate(entry.closed_on, session.lang) }}</strong>
                </span>

                <!-- Planned Date -->
                <span class="text-xs text-on-surface-variant">
                  ({{ session.t('maintenance.log.plannedDate') }}:
                  <span class="font-mono">{{ formatDate(entry.planned_date, session.lang) }}</span>)
                </span>
              </div>

              <!-- Task Title: Link for Board/Chairman, plain text for Accountant -->
              <h3 class="font-bold text-base text-on-surface">
                <RouterLink
                  v-if="canManageMaintenance"
                  :to="`/maintenance/${entry.task_id}`"
                  :data-testid="`log-entry-task-link-${entry.id}`"
                  class="hover:text-primary transition-colors"
                >
                  {{ entry.task_title }}
                </RouterLink>
                <span v-else :data-testid="`log-entry-task-text-${entry.id}`">
                  {{ entry.task_title }}
                </span>
              </h3>
            </div>

            <!-- Right column: Cost & Edit Action (Board/Chairman only) -->
            <div class="flex items-center justify-between sm:justify-end gap-3 shrink-0">
              <div class="text-left sm:text-right">
                <span class="block text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
                  {{ session.t('maintenance.log.costLabel') }}
                </span>
                <span
                  :data-testid="`log-entry-cost-${entry.id}`"
                  class="font-mono text-sm font-bold text-on-surface"
                >
                  {{ entry.cost !== null ? formatCost(entry.cost, session.lang) : session.t('maintenance.log.noCost') }}
                </span>
              </div>

              <button
                v-if="canManageMaintenance"
                type="button"
                :data-testid="`edit-log-entry-btn-${entry.id}`"
                class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-surface-container bg-surface-container-low hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors cursor-pointer"
                @click="openEditModal(entry)"
              >
                <span class="material-symbols-outlined text-[15px]">edit</span>
                <span>{{ session.t('maintenance.log.editBtn') }}</span>
              </button>
            </div>
          </div>

          <!-- Note -->
          <p v-if="entry.note" class="text-xs text-on-surface whitespace-pre-wrap leading-relaxed bg-surface-container-low/50 p-3 rounded-xl border border-surface-container">
            {{ entry.note }}
          </p>

          <!-- Recorded By / Updated By Badges -->
          <div class="flex flex-wrap items-center gap-x-5 gap-y-1 pt-1 text-[11px] text-on-surface-variant">
            <div class="inline-flex items-center gap-1.5">
              <span>{{ session.t('maintenance.log.recordedBy') }}:</span>
              <AuthorBadge :badge="entry.recorded_by" />
            </div>

            <div v-if="entry.updated_by" class="inline-flex items-center gap-1.5">
              <span>{{ session.t('maintenance.log.updatedBy') }}:</span>
              <AuthorBadge :badge="entry.updated_by" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Edit Log Entry Modal (Board & Chairman only) -->
    <div
      v-if="showEditModal && editingEntry && canManageMaintenance"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div
        data-testid="edit-log-entry-modal"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl"
      >
        <h3 class="font-bold text-base text-on-surface">
          {{ session.t('maintenance.log.editModalTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.log.editModalDesc') }}
        </p>

        <div
          v-if="editError"
          data-testid="edit-log-modal-error"
          class="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold"
        >
          {{ editError }}
        </div>

        <div class="space-y-3">
          <div v-if="editingEntry.kind === 'DONE'">
            <label for="log-edit-cost" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.doneModal.costLabel') }}
            </label>
            <input
              id="log-edit-cost"
              v-model="editCost"
              type="text"
              inputmode="decimal"
              data-testid="edit-log-cost-input"
              :placeholder="session.t('maintenance.doneModal.costPlaceholder')"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
            <p class="text-[11px] text-on-surface-variant mt-1">
              {{ session.t('maintenance.doneModal.costHint') }}
            </p>
          </div>

          <div>
            <label for="log-edit-note" class="block text-xs font-semibold text-on-surface">
              {{ editingEntry.kind === 'SKIPPED' ? `${session.t('maintenance.skipModal.noteLabel')} *` : session.t('maintenance.doneModal.noteLabel') }}
            </label>
            <textarea
              id="log-edit-note"
              v-model="editNote"
              rows="3"
              maxlength="1000"
              data-testid="edit-log-note-input"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-xs text-on-surface focus:border-primary focus:outline-none"
            ></textarea>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container cursor-pointer"
            @click="showEditModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-edit-log-btn"
            :disabled="editPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container cursor-pointer"
            @click="handleSaveEdit"
          >
            {{ session.t('maintenance.log.saveBtn') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
