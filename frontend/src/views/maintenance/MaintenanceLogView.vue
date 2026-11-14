<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { ApiError } from '@/api/client.js'
import {
  editMaintenanceLogEntry,
  exportMaintenanceReportCsv,
  getMaintenanceReport,
  listMaintenanceLog,
  listMaintenanceTasks,
} from '@/api/endpoints/maintenance.js'
import {
  extractMaintenanceCsvFilename,
  fetchAllMaintenanceLogForYears,
  formatCost,
  getAvailableReportYears,
  getTodayDateInTallinn,
  normalizeCostInput,
  sumCosts,
} from '@/utils/maintenance.js'
import { formatDate } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canManageMaintenance, canViewMaintenanceLog } = useRole()

const activeTab = ref(route.query.tab === 'report' ? 'report' : 'log')

const entries = ref([])
const knownTasksMap = ref(new Map()) // task_id -> task_title
const knownLogEntriesForYears = ref([]) // baseline unfiltered entries for year discovery
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

// Yearly report state (#029)
const currentYear = Number(getTodayDateInTallinn().slice(0, 4))
const selectedYear = ref(currentYear)
const reportData = ref(null)
const reportLoading = ref(false)
const reportError = ref(null)
const reportDirty = ref(false)
const csvDownloading = ref(false)
const csvBanner = ref(null) // { tone: 'success' | 'error', text: string }

let logRequestSeq = 0
let reportRequestSeq = 0
let csvRequestSeq = 0
let yearDiscoverySeq = 0
let tasksRequestSeq = 0
let editRequestSeq = 0
let isUnmounted = false
const revokeTimers = new Set()

const availableReportYears = computed(() => {
  return getAvailableReportYears(knownLogEntriesForYears.value, currentYear)
})

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

function formatMoneyEur(costStr) {
  const formatted = formatCost(costStr, session.lang)
  return formatted ? `${formatted} €` : '—'
}

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

function setActiveTab(tab) {
  const normalized = tab === 'report' ? 'report' : 'log'
  if (activeTab.value === normalized) return
  activeTab.value = normalized
  const nextQuery = { ...route.query }
  if (normalized === 'report') {
    nextQuery.tab = 'report'
  } else {
    delete nextQuery.tab
  }
  router.replace({ query: nextQuery }).catch(() => {})
}

async function fetchKnownTasksForBoard() {
  if (!canManageMaintenance.value || isUnmounted) return
  const seq = ++tasksRequestSeq
  const expectedUserId = session.actingUserId
  try {
    const [activeTasks, archivedTasks] = await Promise.all([
      listMaintenanceTasks(),
      listMaintenanceTasks({ status: 'ARCHIVED' }),
    ])
    if (isUnmounted || seq !== tasksRequestSeq || session.actingUserId !== expectedUserId) return
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

async function fetchLogBaselineYears() {
  if (!canViewMaintenanceLog.value || isUnmounted) return
  const seq = ++yearDiscoverySeq
  const expectedUserId = session.actingUserId
  const isStale = () =>
    isUnmounted || seq !== yearDiscoverySeq || session.actingUserId !== expectedUserId
  try {
    const { entries: collected, stale } = await fetchAllMaintenanceLogForYears(
      (params) => listMaintenanceLog(params),
      { pageSize: 100, maxPages: 50, isStale },
    )
    if (stale || isStale()) return
    knownLogEntriesForYears.value = collected
    recordKnownTasksFromEntries(collected)
  } catch {
    // Non-blocking: dropdown still offers currentYear and prior year
  }
}

async function fetchLog() {
  if (!canViewMaintenanceLog.value || isUnmounted) return
  const seq = ++logRequestSeq
  const expectedUserId = session.actingUserId
  loading.value = true
  loadError.value = null

  try {
    const params = {}
    if (taskFilter.value) params.task_id = taskFilter.value
    if (fromFilter.value) params.from = fromFilter.value
    if (toFilter.value) params.to = toFilter.value

    const data = await listMaintenanceLog(params)
    if (isUnmounted || seq !== logRequestSeq || session.actingUserId !== expectedUserId) return
    const list = Array.isArray(data) ? data : []
    entries.value = list
    recordKnownTasksFromEntries(list)
    if (!hasActiveFilters.value && list.length > knownLogEntriesForYears.value.length) {
      knownLogEntriesForYears.value = list
    }
  } catch (err) {
    if (isUnmounted || seq !== logRequestSeq || session.actingUserId !== expectedUserId) return
    loadError.value = err
  } finally {
    if (!isUnmounted && seq === logRequestSeq) {
      loading.value = false
    }
  }
}

async function fetchReport() {
  if (!canViewMaintenanceLog.value || isUnmounted) return
  const seq = ++reportRequestSeq
  const expectedUserId = session.actingUserId
  reportLoading.value = true
  reportError.value = null

  try {
    const data = await getMaintenanceReport(selectedYear.value)
    if (isUnmounted || seq !== reportRequestSeq || session.actingUserId !== expectedUserId) return
    reportData.value = data
    reportDirty.value = false
  } catch (err) {
    if (isUnmounted || seq !== reportRequestSeq || session.actingUserId !== expectedUserId) return
    reportError.value = err
    reportData.value = null
  } finally {
    if (!isUnmounted && seq === reportRequestSeq) {
      reportLoading.value = false
    }
  }
}

async function handleDownloadCsv() {
  if (csvDownloading.value || !canViewMaintenanceLog.value || isUnmounted) return
  const seq = ++csvRequestSeq
  const expectedUserId = session.actingUserId
  const targetYear = selectedYear.value
  const isStale = () =>
    isUnmounted ||
    seq !== csvRequestSeq ||
    session.actingUserId !== expectedUserId ||
    selectedYear.value !== targetYear

  csvDownloading.value = true
  csvBanner.value = null

  try {
    const response = await exportMaintenanceReportCsv(targetYear)
    if (isStale()) return

    if (response && 'ok' in response && !response.ok) {
      let errorBody = null
      try {
        errorBody = await response.json()
      } catch {
        /* ignore non-JSON error body */
      }
      if (isStale()) return
      throw new ApiError(
        response.status || 500,
        errorBody,
        response.headers?.get?.('X-Trace-Id') || '',
      )
    }

    const blob = await response.blob()
    if (isStale()) return

    const disposition = response.headers?.get?.('Content-Disposition') || ''
    const filename = extractMaintenanceCsvFilename(disposition, targetYear)

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    try {
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link)
      }
      const timerEntry = {
        url,
        timer: setTimeout(() => {
          revokeTimers.delete(timerEntry)
          URL.revokeObjectURL(url)
        }, 1000),
      }
      revokeTimers.add(timerEntry)
    }

    csvBanner.value = {
      tone: 'success',
      text: session.t('maintenance.report.csvDownloaded', { filename }),
    }
  } catch (err) {
    if (isStale()) return
    csvBanner.value = {
      tone: 'error',
      text: localizeError(err, {}, session.lang),
    }
  } finally {
    if (!isUnmounted && seq === csvRequestSeq) {
      csvDownloading.value = false
    }
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
  if (!editingEntry.value || !canManageMaintenance.value || editPending.value || isUnmounted) return
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

  const seq = ++editRequestSeq
  const expectedUserId = session.actingUserId
  editPending.value = true
  try {
    const updated = await editMaintenanceLogEntry(editingEntry.value.id, payload)
    if (isUnmounted || seq !== editRequestSeq || session.actingUserId !== expectedUserId) return
    entries.value = entries.value.map((item) => (item.id === updated.id ? updated : item))
    showEditModal.value = false
    editingEntry.value = null
    reportDirty.value = true
    if (activeTab.value === 'report') {
      fetchReport()
    }
  } catch (err) {
    if (isUnmounted || seq !== editRequestSeq || session.actingUserId !== expectedUserId) return
    editError.value = localizeError(err, {}, session.lang)
  } finally {
    if (!isUnmounted && seq === editRequestSeq) {
      editPending.value = false
    }
  }
}

watch(
  () => route.query.tab,
  (tab) => {
    activeTab.value = tab === 'report' ? 'report' : 'log'
  },
)

watch(
  () => [taskFilter.value, fromFilter.value, toFilter.value, session.actingUserId],
  () => {
    fetchLog()
  },
)

watch(
  () => selectedYear.value,
  () => {
    csvRequestSeq += 1
    csvDownloading.value = false
    csvBanner.value = null
    if (activeTab.value === 'report' && canViewMaintenanceLog.value) {
      fetchReport()
    } else {
      reportDirty.value = true
    }
  },
)

watch(
  () => activeTab.value,
  (tab) => {
    if (
      tab === 'report' &&
      canViewMaintenanceLog.value &&
      !reportLoading.value &&
      (!reportData.value || reportDirty.value)
    ) {
      fetchReport()
    }
  },
)

watch(
  () => session.actingUserId,
  () => {
    logRequestSeq += 1
    reportRequestSeq += 1
    csvRequestSeq += 1
    yearDiscoverySeq += 1
    tasksRequestSeq += 1
    editRequestSeq += 1
    entries.value = []
    knownLogEntriesForYears.value = []
    knownTasksMap.value = new Map()
    showEditModal.value = false
    editingEntry.value = null
    editError.value = ''
    editPending.value = false
    csvBanner.value = null
    reportError.value = null
    reportData.value = null
    reportDirty.value = false
    csvDownloading.value = false

    if (canManageMaintenance.value) {
      fetchKnownTasksForBoard()
    }
    if (canViewMaintenanceLog.value) {
      fetchLogBaselineYears()
      if (activeTab.value === 'report') {
        fetchReport()
      }
    }
  },
)

onMounted(async () => {
  await Promise.allSettled([
    canManageMaintenance.value ? fetchKnownTasksForBoard() : Promise.resolve(),
    canViewMaintenanceLog.value ? fetchLogBaselineYears() : Promise.resolve(),
    fetchLog(),
    activeTab.value === 'report' && canViewMaintenanceLog.value ? fetchReport() : Promise.resolve(),
  ])
})

onBeforeUnmount(() => {
  isUnmounted = true
  logRequestSeq += 1
  reportRequestSeq += 1
  csvRequestSeq += 1
  yearDiscoverySeq += 1
  tasksRequestSeq += 1
  editRequestSeq += 1
  for (const entry of revokeTimers) {
    clearTimeout(entry.timer)
    URL.revokeObjectURL(entry.url)
  }
  revokeTimers.clear()
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
      <!-- Log / Yearly Report Tab Switcher -->
      <div
        role="tablist"
        :aria-label="session.t('maintenance.report.tabsAriaLabel')"
        class="inline-flex p-1 rounded-xl bg-surface-container border border-surface-container-high gap-1"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'log'"
          data-testid="maintenance-tab-log"
          class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          :class="
            activeTab === 'log'
              ? 'bg-surface-container-lowest text-on-surface shadow-2xs'
              : 'text-on-surface-variant hover:text-on-surface'
          "
          @click="setActiveTab('log')"
        >
          <span class="material-symbols-outlined text-[16px]">history_edu</span>
          <span>{{ session.t('maintenance.report.tabLog') }}</span>
        </button>

        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'report'"
          data-testid="maintenance-tab-report"
          class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          :class="
            activeTab === 'report'
              ? 'bg-surface-container-lowest text-on-surface shadow-2xs'
              : 'text-on-surface-variant hover:text-on-surface'
          "
          @click="setActiveTab('report')"
        >
          <span class="material-symbols-outlined text-[16px]">summarize</span>
          <span>{{ session.t('maintenance.report.tabReport') }}</span>
        </button>
      </div>

      <!-- Yearly Report Tab Panel (#029) -->
      <section v-if="activeTab === 'report'" data-testid="maintenance-yearly-report-panel" class="space-y-5">
        <!-- Toolbar: Year Picker + Download CSV -->
        <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4 shadow-2xs">
          <div class="space-y-1">
            <h2 class="font-bold text-base text-on-surface">
              {{ session.t('maintenance.report.heading') }}
            </h2>
            <p class="text-xs text-on-surface-variant max-w-2xl">
              {{ session.t('maintenance.report.subtitle') }}
            </p>
          </div>

          <div class="flex flex-wrap items-end gap-3 shrink-0">
            <div>
              <label
                for="report-year-select"
                class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1"
              >
                {{ session.t('maintenance.report.yearLabel') }}
              </label>
              <select
                id="report-year-select"
                v-model.number="selectedYear"
                data-testid="report-year-select"
                class="rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs font-semibold text-on-surface focus:border-primary focus:outline-none"
              >
                <option v-for="y in availableReportYears" :key="y" :value="y">
                  {{ y }}
                </option>
              </select>
            </div>

            <button
              type="button"
              data-testid="download-maintenance-csv-btn"
              :disabled="csvDownloading"
              class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container disabled:opacity-60 transition-colors cursor-pointer"
              @click="handleDownloadCsv"
            >
              <span class="material-symbols-outlined text-[17px]">download</span>
              <span>
                {{
                  csvDownloading
                    ? session.t('maintenance.report.downloadingCsv')
                    : session.t('maintenance.report.downloadCsv')
                }}
              </span>
            </button>
          </div>
        </div>

        <!-- CSV Export Feedback Banner (success or visible error) -->
        <div
          v-if="csvBanner"
          data-testid="report-csv-banner"
          role="alert"
          class="p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between gap-3"
          :class="
            csvBanner.tone === 'error'
              ? 'bg-error/10 border-error/30 text-error'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
          "
        >
          <span>{{ csvBanner.text }}</span>
          <button
            type="button"
            :aria-label="session.t('maintenance.report.dismissBanner')"
            class="text-current opacity-70 hover:opacity-100 cursor-pointer"
            @click="csvBanner = null"
          >
            <span class="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>

        <ErrorCard
          v-if="reportError"
          data-testid="report-load-error"
          :error="reportError"
          @retry="fetchReport"
        />

        <!-- Loading Skeleton -->
        <div v-else-if="reportLoading" class="space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div v-for="i in 3" :key="i" class="p-5 rounded-2xl bg-surface-container-lowest border border-surface-container animate-pulse space-y-2">
              <div class="h-3 bg-surface-container rounded w-1/2"></div>
              <div class="h-6 bg-surface-container-high rounded w-1/3"></div>
            </div>
          </div>
        </div>

        <template v-else-if="reportData">
          <!-- KPI Totals -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="p-4 sm:p-5 rounded-2xl bg-surface-container-lowest border border-surface-container space-y-1 shadow-2xs">
              <span class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                {{ session.t('maintenance.report.totalDone') }}
              </span>
              <span data-testid="report-total-done" class="block font-mono text-2xl font-bold text-on-surface tabular-nums">
                {{ reportData.done_count }}
              </span>
            </div>

            <div class="p-4 sm:p-5 rounded-2xl bg-surface-container-lowest border border-surface-container space-y-1 shadow-2xs">
              <span class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                {{ session.t('maintenance.report.totalSkipped') }}
              </span>
              <span data-testid="report-total-skipped" class="block font-mono text-2xl font-bold text-on-surface tabular-nums">
                {{ reportData.skipped_count }}
              </span>
            </div>

            <div class="p-4 sm:p-5 rounded-2xl bg-surface-container-lowest border border-surface-container space-y-1 shadow-2xs">
              <span class="block text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                {{ session.t('maintenance.report.totalCost') }}
              </span>
              <span data-testid="report-total-cost" class="block font-mono text-2xl font-bold text-on-surface tabular-nums">
                {{ formatMoneyEur(reportData.total_cost) }}
              </span>
            </div>
          </div>

          <!-- Empty State for Year with No Entries -->
          <div
            v-if="!reportData.tasks || reportData.tasks.length === 0"
            data-testid="maintenance-report-empty"
            class="py-16 text-center rounded-2xl bg-surface-container-lowest border border-surface-container space-y-3"
          >
            <div class="w-12 h-12 rounded-full bg-surface-container-low mx-auto flex items-center justify-center text-on-surface-variant">
              <span class="material-symbols-outlined text-[24px]">event_busy</span>
            </div>
            <h3 class="font-bold text-sm text-on-surface">
              {{ session.t('maintenance.report.emptyTitle', { year: reportData.year }) }}
            </h3>
            <p class="text-xs text-on-surface-variant max-w-sm mx-auto">
              {{ session.t('maintenance.report.emptyDesc') }}
            </p>
          </div>

          <!-- Per-Task Breakdown Table -->
          <div
            v-else
            data-testid="maintenance-report-table"
            class="bg-surface-container-lowest border border-surface-container rounded-2xl overflow-hidden shadow-2xs"
          >
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b border-surface-container bg-surface-container-low/60 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                    <th class="px-4 py-3">{{ session.t('maintenance.report.tableTask') }}</th>
                    <th class="px-4 py-3 text-right">{{ session.t('maintenance.report.tableDone') }}</th>
                    <th class="px-4 py-3 text-right">{{ session.t('maintenance.report.tableSkipped') }}</th>
                    <th class="px-4 py-3 text-right">{{ session.t('maintenance.report.tableCost') }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-surface-container text-sm">
                  <tr
                    v-for="task in reportData.tasks"
                    :key="task.task_id"
                    :data-testid="`report-task-row-${task.task_id}`"
                    class="hover:bg-surface-container-low/40 transition-colors"
                  >
                    <td class="px-4 py-3 font-semibold text-on-surface">
                      <RouterLink
                        v-if="canManageMaintenance"
                        :to="`/maintenance/${task.task_id}`"
                        :data-testid="`report-task-link-${task.task_id}`"
                        class="hover:text-primary transition-colors"
                      >
                        {{ task.task_title }}
                      </RouterLink>
                      <span v-else :data-testid="`report-task-text-${task.task_id}`">
                        {{ task.task_title }}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums text-on-surface">
                      {{ task.done_count }}
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums text-on-surface">
                      {{ task.skipped_count }}
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums font-semibold text-on-surface">
                      {{ formatMoneyEur(task.total_cost) }}
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr class="border-t border-surface-container-high bg-surface-container-low/70 text-sm font-bold text-on-surface">
                    <td class="px-4 py-3">
                      {{ session.t('maintenance.report.totalsRow', { year: reportData.year }) }}
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums">
                      {{ reportData.done_count }}
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums">
                      {{ reportData.skipped_count }}
                    </td>
                    <td class="px-4 py-3 text-right font-mono tabular-nums">
                      {{ formatMoneyEur(reportData.total_cost) }}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </template>
      </section>

      <!-- Log Entries Tab Panel -->
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
