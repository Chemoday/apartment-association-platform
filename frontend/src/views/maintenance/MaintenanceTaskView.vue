<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  archiveMaintenanceTask,
  editMaintenanceLogEntry,
  getMaintenanceTask,
  listMaintenanceLog,
  markMaintenanceTaskDone,
  pauseMaintenanceTask,
  resumeMaintenanceTask,
  skipMaintenanceTask,
} from '@/api/endpoints/maintenance.js'
import {
  addDays,
  formatCost,
  getTodayDateInTallinn,
  isValidCalendarDate,
  normalizeCostInput,
} from '@/utils/maintenance.js'
import { formatDate } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canManageMaintenance } = useRole()

const taskId = computed(() => String(route.params.taskId || ''))

const task = ref(null)
const taskLog = ref([])
const loading = ref(true)
const loadError = ref(null)
const actionError = ref('')
const actionPending = ref(false)

const showPauseModal = ref(false)
const showResumeModal = ref(false)
const showArchiveModal = ref(false)
const showDoneModal = ref(false)
const showSkipModal = ref(false)
const showEditLogModal = ref(false)

const resumeDueDate = ref('')

// Done modal fields
const doneOn = ref('')
const doneCost = ref('')
const doneNote = ref('')
const doneModalError = ref('')

// Skip modal fields
const skipNote = ref('')
const skipModalError = ref('')

// Edit log entry modal fields
const editingEntry = ref(null)
const editLogCost = ref('')
const editLogNote = ref('')
const editLogError = ref('')

const isArchived = computed(() => task.value?.status === 'ARCHIVED')
const isPaused = computed(() => task.value?.status === 'PAUSED')
const isActive = computed(() => task.value?.status === 'ACTIVE')

const todayDate = computed(() => getTodayDateInTallinn())

const minDoneDate = computed(() => {
  if (!task.value?.current?.due_date) return ''
  const minFromPlanned = addDays(task.value.current.due_date, -366)
  const lastClosed = task.value.last_closed_on
  if (lastClosed && lastClosed > minFromPlanned) {
    return lastClosed
  }
  return minFromPlanned
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

function logKindBadgeClass(kind) {
  if (kind === 'DONE') {
    return 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-700'
  }
  return 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-700'
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

async function fetchTask() {
  if (!canManageMaintenance.value) return
  loading.value = true
  loadError.value = null
  actionError.value = ''

  try {
    const [taskData, logData] = await Promise.all([
      getMaintenanceTask(taskId.value),
      listMaintenanceLog({ task_id: taskId.value }),
    ])
    task.value = taskData
    taskLog.value = Array.isArray(logData) ? logData : []
    if (taskData.current?.due_date) {
      resumeDueDate.value = taskData.current.due_date
    }
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

function openDoneModal() {
  doneOn.value = getTodayDateInTallinn()
  doneCost.value = ''
  doneNote.value = ''
  doneModalError.value = ''
  showDoneModal.value = true
}

function openSkipModal() {
  skipNote.value = ''
  skipModalError.value = ''
  showSkipModal.value = true
}

async function handleDone() {
  doneModalError.value = ''
  const today = getTodayDateInTallinn()

  if (!doneOn.value || !isValidCalendarDate(doneOn.value)) {
    doneModalError.value = session.t('maintenance.validation.INVALID_DATE')
    return
  }
  if (doneOn.value > today) {
    doneModalError.value = session.t('maintenance.doneModal.invalidDoneDateFuture')
    return
  }
  if (task.value?.current?.due_date) {
    const minPlanned = addDays(task.value.current.due_date, -366)
    if (doneOn.value < minPlanned) {
      doneModalError.value = session.t('maintenance.doneModal.invalidDoneDateTooEarly')
      return
    }
  }
  if (task.value?.last_closed_on && doneOn.value < task.value.last_closed_on) {
    doneModalError.value = session.t('maintenance.doneModal.invalidDoneDateBeforeLast', {
      date: formatDate(task.value.last_closed_on, session.lang),
    })
    return
  }

  const normalizedCost = normalizeCostInput(doneCost.value)
  if (normalizedCost === undefined) {
    doneModalError.value = session.t('maintenance.doneModal.invalidCost')
    return
  }

  const trimmedNote = doneNote.value.trim()
  if (trimmedNote.length > 1000) {
    doneModalError.value = session.t('maintenance.doneModal.invalidNoteLength')
    return
  }

  actionPending.value = true
  actionError.value = ''
  try {
    const payload = {
      occurrence_id: task.value.current.occurrence_id,
      done_on: doneOn.value,
      note: trimmedNote,
    }
    if (normalizedCost !== null) {
      payload.cost = normalizedCost
    }
    const res = await markMaintenanceTaskDone(taskId.value, payload)
    task.value = res.task
    if (res.entry) {
      taskLog.value = [res.entry, ...taskLog.value.filter((e) => e.id !== res.entry.id)]
    }
    showDoneModal.value = false
  } catch (err) {
    if (err?.errorCode === 'OCCURRENCE_CLOSED') {
      showDoneModal.value = false
      await fetchTask()
      actionError.value = session.t('maintenance.editor.occurrenceClosedConflict')
    } else if (err?.errorCode === 'TASK_ARCHIVED') {
      showDoneModal.value = false
      await fetchTask()
      actionError.value = localizeError(err, {}, session.lang)
    } else {
      doneModalError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    actionPending.value = false
  }
}

async function handleSkip() {
  skipModalError.value = ''
  const trimmedNote = skipNote.value.trim()
  if (trimmedNote.length < 1 || trimmedNote.length > 1000) {
    skipModalError.value = session.t('maintenance.skipModal.noteRequired')
    return
  }

  actionPending.value = true
  actionError.value = ''
  try {
    const res = await skipMaintenanceTask(taskId.value, {
      occurrence_id: task.value.current.occurrence_id,
      note: trimmedNote,
    })
    task.value = res.task
    if (res.entry) {
      taskLog.value = [res.entry, ...taskLog.value.filter((e) => e.id !== res.entry.id)]
    }
    showSkipModal.value = false
  } catch (err) {
    if (err?.errorCode === 'OCCURRENCE_CLOSED') {
      showSkipModal.value = false
      await fetchTask()
      actionError.value = session.t('maintenance.editor.occurrenceClosedConflict')
    } else if (err?.errorCode === 'TASK_ARCHIVED') {
      showSkipModal.value = false
      await fetchTask()
      actionError.value = localizeError(err, {}, session.lang)
    } else {
      skipModalError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    actionPending.value = false
  }
}

function openEditLogEntryModal(entry) {
  editingEntry.value = entry
  editLogNote.value = entry.note || ''
  editLogCost.value = entry.cost ? formatCost(entry.cost, session.lang) : ''
  editLogError.value = ''
  showEditLogModal.value = true
}

async function handleSaveLogEdit() {
  if (!editingEntry.value) return
  editLogError.value = ''

  const trimmedNote = editLogNote.value.trim()
  if (editingEntry.value.kind === 'SKIPPED' && trimmedNote.length < 1) {
    editLogError.value = session.t('maintenance.skipModal.noteRequired')
    return
  }
  if (trimmedNote.length > 1000) {
    editLogError.value = session.t('maintenance.doneModal.invalidNoteLength')
    return
  }

  const payload = {
    note: trimmedNote,
  }

  if (editingEntry.value.kind === 'DONE') {
    const normalizedCost = normalizeCostInput(editLogCost.value)
    if (normalizedCost === undefined) {
      editLogError.value = session.t('maintenance.doneModal.invalidCost')
      return
    }
    payload.cost = normalizedCost
  }

  actionPending.value = true
  try {
    const updated = await editMaintenanceLogEntry(editingEntry.value.id, payload)
    taskLog.value = taskLog.value.map((item) => (item.id === updated.id ? updated : item))
    showEditLogModal.value = false
    editingEntry.value = null
  } catch (err) {
    editLogError.value = localizeError(err, {}, session.lang)
  } finally {
    actionPending.value = false
  }
}

async function handlePause() {
  actionPending.value = true
  actionError.value = ''
  try {
    task.value = await pauseMaintenanceTask(taskId.value)
    showPauseModal.value = false
  } catch (err) {
    actionError.value = localizeError(err, {}, session.lang)
  } finally {
    actionPending.value = false
  }
}

async function handleResume() {
  actionPending.value = true
  actionError.value = ''
  try {
    const payload = {}
    if (resumeDueDate.value && resumeDueDate.value !== task.value?.current?.due_date) {
      payload.next_due_date = resumeDueDate.value
      payload.occurrence_id = task.value?.current?.occurrence_id
    }
    task.value = await resumeMaintenanceTask(taskId.value, payload)
    showResumeModal.value = false
  } catch (err) {
    if (err?.errorCode === 'OCCURRENCE_CLOSED') {
      showResumeModal.value = false
      await fetchTask()
      actionError.value = session.t('maintenance.editor.occurrenceClosedConflict')
    } else {
      actionError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    actionPending.value = false
  }
}

async function handleArchive() {
  actionPending.value = true
  actionError.value = ''
  try {
    task.value = await archiveMaintenanceTask(taskId.value)
    showArchiveModal.value = false
  } catch (err) {
    actionError.value = localizeError(err, {}, session.lang)
  } finally {
    actionPending.value = false
  }
}

watch(
  () => [taskId.value, session.actingUserId],
  () => {
    fetchTask()
  },
)

onMounted(() => {
  fetchTask()
})
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Back Link -->
    <div>
      <RouterLink
        to="/maintenance"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        <span>{{ session.t('maintenance.editor.backToList') }}</span>
      </RouterLink>
    </div>

    <!-- Role Guard -->
    <div
      v-if="!canManageMaintenance"
      data-testid="maintenance-task-forbidden"
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
      <ErrorCard v-if="loadError" :error="loadError" @retry="fetchTask" />

      <div v-else-if="loading" class="p-8 text-center text-sm text-on-surface-variant">
        {{ session.t('common.loading') }}
      </div>

      <div v-else-if="task" class="space-y-6">
        <!-- Action Error Alert -->
        <div
          v-if="actionError"
          data-testid="maintenance-action-error"
          class="p-4 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold"
        >
          {{ actionError }}
        </div>

        <!-- Task Header Card -->
        <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 sm:p-8 space-y-4 shadow-xs">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span
                v-if="task.current?.state"
                class="px-3 py-1 rounded-full border text-xs font-bold uppercase tracking-wider"
                :class="stateBadgeClass(task.current.state)"
              >
                {{ session.t(`maintenance.states.${task.current.state}`) }}
              </span>
              <span
                v-else-if="isArchived"
                class="px-3 py-1 rounded-full border border-surface-container text-on-surface-variant text-xs font-bold uppercase"
              >
                {{ session.t('maintenance.states.ARCHIVED') }}
              </span>

              <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant font-medium">
                <span class="material-symbols-outlined text-[15px]">repeat</span>
                {{ formatRhythm(task.period_unit, task.period_count) }}
              </span>
            </div>

            <!-- Action buttons for active / paused tasks (archived is read-only) -->
            <div v-if="!isArchived" class="flex flex-wrap items-center gap-2">
              <!-- Mark Done Button -->
              <button
                v-if="task.current"
                type="button"
                data-testid="mark-done-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors cursor-pointer"
                @click="openDoneModal"
              >
                <span class="material-symbols-outlined text-[15px]">task_alt</span>
                <span>{{ session.t('maintenance.actions.markDone') }}</span>
              </button>

              <!-- Skip Occurrence Button -->
              <button
                v-if="task.current"
                type="button"
                data-testid="skip-occurrence-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-surface-container bg-surface-container-low hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors cursor-pointer"
                @click="openSkipModal"
              >
                <span class="material-symbols-outlined text-[15px]">fast_forward</span>
                <span>{{ session.t('maintenance.actions.skip') }}</span>
              </button>

              <!-- Edit Button -->
              <button
                type="button"
                data-testid="edit-maintenance-task-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-surface-container bg-surface-container-low hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors cursor-pointer"
                @click="router.push(`/maintenance/${task.id}/edit`)"
              >
                <span class="material-symbols-outlined text-[15px]">edit</span>
                <span>{{ session.t('maintenance.actions.edit') }}</span>
              </button>

              <!-- Pause Button (ACTIVE only) -->
              <button
                v-if="isActive"
                type="button"
                data-testid="pause-maintenance-task-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-surface-container bg-surface-container-low hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors cursor-pointer"
                @click="showPauseModal = true"
              >
                <span class="material-symbols-outlined text-[15px]">pause</span>
                <span>{{ session.t('maintenance.actions.pause') }}</span>
              </button>

              <!-- Resume Button (PAUSED only) -->
              <button
                v-if="isPaused"
                type="button"
                data-testid="resume-maintenance-task-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-primary/40 bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors cursor-pointer"
                @click="showResumeModal = true"
              >
                <span class="material-symbols-outlined text-[15px]">play_arrow</span>
                <span>{{ session.t('maintenance.actions.resume') }}</span>
              </button>

              <!-- Archive Button -->
              <button
                type="button"
                data-testid="archive-maintenance-task-btn"
                class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-error/30 text-error hover:bg-error-container/20 text-xs font-semibold transition-colors cursor-pointer"
                @click="showArchiveModal = true"
              >
                <span class="material-symbols-outlined text-[15px]">archive</span>
                <span>{{ session.t('maintenance.actions.archive') }}</span>
              </button>
            </div>
          </div>

          <h1 class="font-headline-md font-bold text-on-surface">
            {{ task.title }}
          </h1>

          <!-- Internal Instructions -->
          <div v-if="task.instructions" class="p-4 rounded-xl bg-surface-container-low border border-surface-container space-y-1">
            <div class="flex items-center gap-1.5 text-xs font-bold text-on-surface uppercase tracking-wider">
              <span class="material-symbols-outlined text-[16px] text-primary">security</span>
              <span>{{ session.t('maintenance.internalInstructionsHeading') }}</span>
            </div>
            <p class="text-sm text-on-surface leading-relaxed whitespace-pre-wrap">
              {{ task.instructions }}
            </p>
          </div>
        </div>

        <!-- Notice Failed Warning Banner (#017) -->
        <div
          v-if="task.current?.notice_failed"
          data-testid="task-notice-failed-warning"
          class="rounded-xl bg-error-container/20 border border-error/40 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-on-error-container"
          role="alert"
        >
          <div class="flex items-start gap-2.5">
            <span class="material-symbols-outlined text-[20px] text-error shrink-0 mt-0.5">warning</span>
            <p class="text-xs sm:text-sm font-medium text-on-surface">
              {{ session.t('maintenance.publishing.noticeFailedWarning') }}
            </p>
          </div>
          <RouterLink
            :to="`/maintenance/${task.id}/edit`"
            data-testid="task-notice-failed-edit-link"
            class="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors"
          >
            <span>{{ session.t('maintenance.publishing.editTaskTarget') }}</span>
            <span class="material-symbols-outlined text-[15px]">arrow_forward</span>
          </RouterLink>
        </div>

        <!-- Current Occurrence & Schedule Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Occurrence Details Card -->
          <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 space-y-4 shadow-xs">
            <h2 class="text-sm font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-primary">schedule</span>
              <span>{{ session.t('maintenance.occurrenceHeading') }}</span>
            </h2>

            <div v-if="task.current" class="divide-y divide-surface-container">
              <div class="py-2.5 flex items-center justify-between">
                <span class="text-xs text-on-surface-variant">{{ session.t('maintenance.dueDateLabel') }}</span>
                <span data-testid="task-current-due-date" class="font-mono text-sm font-bold text-on-surface">{{ formatDate(task.current.due_date, session.lang) }}</span>
              </div>
              <div class="py-2.5 flex items-center justify-between">
                <span class="text-xs text-on-surface-variant">{{ session.t('maintenance.publishOnLabel') }}</span>
                <span class="font-mono text-xs text-on-surface">{{ formatDate(task.current.publish_on, session.lang) }}</span>
              </div>
              <div class="py-2.5 flex items-center justify-between">
                <span class="text-xs text-on-surface-variant">{{ session.t('maintenance.leadDaysLabel') }}</span>
                <span class="text-xs font-semibold text-on-surface">{{ task.lead_days }} {{ session.t('maintenance.daysUnit') }}</span>
              </div>
              <div v-if="task.last_closed_on" class="py-2.5 flex items-center justify-between">
                <span class="text-xs text-on-surface-variant">{{ session.t('maintenance.lastClosedOn') }}</span>
                <span class="font-mono text-xs text-on-surface">{{ formatDate(task.last_closed_on, session.lang) }}</span>
              </div>

              <!-- Occurrence Publishing Status (#017) -->
              <div
                v-if="task.current.published_at || task.current.reminder_count > 0 || task.current.notice_post_id"
                data-testid="task-publishing-status"
                class="pt-3 space-y-2.5"
              >
                <span class="text-[11px] font-bold text-on-surface uppercase tracking-wider block">
                  {{ session.t('maintenance.publishing.statusHeading') }}
                </span>

                <!-- Reminder sent on {date} with link to board topic -->
                <div
                  v-if="task.current.published_at"
                  data-testid="task-published-reminder-row"
                  class="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span class="text-on-surface-variant flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[16px] text-primary">event_repeat</span>
                    <span>
                      {{ session.t('maintenance.publishing.reminderSent', { date: formatDate(task.current.published_at, session.lang) }) }}
                    </span>
                  </span>
                  <RouterLink
                    v-if="task.current.board_post_id"
                    :to="`/board-room/${task.current.board_post_id}`"
                    data-testid="task-board-topic-link"
                    class="font-semibold text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <span>{{ session.t('maintenance.publishing.viewBoardTopic') }}</span>
                    <span class="material-symbols-outlined text-[14px]">open_in_new</span>
                  </RouterLink>
                </div>

                <!-- Notice for residents published with link to notice -->
                <div
                  v-if="task.current.notice_post_id"
                  data-testid="task-notice-published-row"
                  class="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span class="text-on-surface-variant flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[16px] text-secondary">campaign</span>
                    <span>{{ session.t('maintenance.publishing.noticePublished') }}</span>
                  </span>
                  <RouterLink
                    :to="`/forum/${task.current.notice_post_id}`"
                    data-testid="task-notice-post-link"
                    class="font-semibold text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <span>{{ session.t('maintenance.publishing.viewNotice') }}</span>
                    <span class="material-symbols-outlined text-[14px]">open_in_new</span>
                  </RouterLink>
                </div>

                <!-- Number of overdue reminders -->
                <div
                  v-if="task.current.reminder_count > 0"
                  data-testid="task-overdue-reminders-row"
                  class="flex items-center justify-between gap-2 text-xs"
                >
                  <span class="text-on-surface-variant flex items-center gap-1.5">
                    <span class="material-symbols-outlined text-[16px] text-warning">notifications_active</span>
                    <span>{{ session.t('maintenance.publishing.overdueRemindersCount', { count: task.current.reminder_count }) }}</span>
                  </span>
                  <span data-testid="task-overdue-reminder-count" class="font-mono font-bold text-on-surface">
                    {{ task.current.reminder_count }}
                  </span>
                </div>
              </div>
            </div>

            <div v-else-if="isArchived" class="py-4 text-center text-xs text-on-surface-variant">
              {{ session.t('maintenance.taskArchivedReadonlyNotice') }}
            </div>
          </div>

          <!-- Official Notice for Residents Card -->
          <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 space-y-4 shadow-xs">
            <h2 class="text-sm font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-primary">campaign</span>
              <span>{{ session.t('maintenance.noticeHeading') }}</span>
            </h2>

            <div v-if="task.notice" class="space-y-3">
              <div>
                <span class="block text-[11px] text-on-surface-variant uppercase tracking-wider font-semibold">
                  {{ session.t('maintenance.noticeTitle') }}
                </span>
                <p class="text-sm font-bold text-on-surface mt-0.5">
                  {{ task.notice.title }}
                </p>
              </div>

              <div>
                <span class="block text-[11px] text-on-surface-variant uppercase tracking-wider font-semibold">
                  {{ session.t('maintenance.noticeBody') }}
                </span>
                <p class="text-xs text-on-surface mt-0.5 whitespace-pre-wrap leading-relaxed">
                  {{ task.notice.body }}
                </p>
              </div>

              <div class="flex items-center gap-2 pt-2 border-t border-surface-container text-xs text-on-surface-variant">
                <span>{{ session.t('maintenance.targetScopeLabel') }}:</span>
                <span class="font-semibold text-on-surface">{{ session.t(`polls.target.${task.notice.target_scope === 'ALL_BUILDING' ? 'allBuilding' : task.notice.target_scope}`) }}</span>
              </div>
            </div>

            <div v-else class="py-6 text-center text-xs text-on-surface-variant">
              {{ session.t('maintenance.noNoticeAttached') }}
            </div>
          </div>
        </div>

        <!-- Task Maintenance Log History Section (#016) -->
        <div
          data-testid="task-maintenance-log-section"
          class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 space-y-4 shadow-xs"
        >
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-primary">history_edu</span>
              <span>{{ session.t('maintenance.log.taskHistoryHeading') }}</span>
            </h2>
            <RouterLink
              :to="{ path: '/maintenance/log', query: { task_id: task.id } }"
              data-testid="view-full-task-log-link"
              class="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <span>{{ session.t('maintenance.log.viewFullLog') }}</span>
              <span class="material-symbols-outlined text-[15px]">open_in_new</span>
            </RouterLink>
          </div>

          <div
            v-if="taskLog.length === 0"
            data-testid="task-log-empty"
            class="py-8 text-center text-xs text-on-surface-variant"
          >
            {{ session.t('maintenance.log.taskHistoryEmpty') }}
          </div>

          <div v-else class="divide-y divide-surface-container">
            <div
              v-for="entry in taskLog"
              :key="entry.id"
              :data-testid="`task-log-entry-${entry.id}`"
              class="py-4 first:pt-1 last:pb-1 space-y-2"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="px-2.5 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider"
                    :class="logKindBadgeClass(entry.kind)"
                  >
                    {{ session.t(`maintenance.log.kind.${entry.kind}`) }}
                  </span>

                  <span class="text-xs text-on-surface-variant">
                    {{ session.t('maintenance.log.closedOn') }}:
                    <strong class="font-mono text-on-surface">{{ formatDate(entry.closed_on, session.lang) }}</strong>
                  </span>

                  <span class="text-xs text-on-surface-variant">
                    ({{ session.t('maintenance.log.plannedDate') }}:
                    <span class="font-mono">{{ formatDate(entry.planned_date, session.lang) }}</span>)
                  </span>
                </div>

                <div class="flex items-center gap-3">
                  <span
                    v-if="entry.cost !== null"
                    :data-testid="`task-log-cost-${entry.id}`"
                    class="font-mono text-sm font-bold text-on-surface px-2.5 py-0.5 rounded-lg bg-surface-container-low border border-surface-container"
                  >
                    {{ formatCost(entry.cost, session.lang) }}
                  </span>

                  <button
                    type="button"
                    :data-testid="`edit-task-log-btn-${entry.id}`"
                    class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-surface-container bg-surface-container-low hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors cursor-pointer"
                    @click="openEditLogEntryModal(entry)"
                  >
                    <span class="material-symbols-outlined text-[14px]">edit</span>
                    <span>{{ session.t('maintenance.log.editBtn') }}</span>
                  </button>
                </div>
              </div>

              <p v-if="entry.note" class="text-xs text-on-surface whitespace-pre-wrap leading-relaxed">
                {{ entry.note }}
              </p>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
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
        </div>
      </div>
    </template>

    <!-- Modal: Mark Done (#016) -->
    <div
      v-if="showDoneModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div
        data-testid="mark-done-modal"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl"
      >
        <h3 class="font-bold text-base text-on-surface">
          {{ session.t('maintenance.doneModal.title') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.doneModal.desc') }}
        </p>

        <div
          v-if="doneModalError"
          data-testid="done-modal-error"
          class="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold"
        >
          {{ doneModalError }}
        </div>

        <div class="space-y-3">
          <div>
            <label for="done-on-input" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.doneModal.doneOnLabel') }} *
            </label>
            <input
              id="done-on-input"
              v-model="doneOn"
              type="date"
              :min="minDoneDate"
              :max="todayDate"
              data-testid="done-on-input"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
            <p class="text-[11px] text-on-surface-variant mt-1">
              {{ session.t('maintenance.doneModal.doneOnHint') }}
            </p>
          </div>

          <div>
            <label for="done-cost-input" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.doneModal.costLabel') }}
            </label>
            <input
              id="done-cost-input"
              v-model="doneCost"
              type="text"
              inputmode="decimal"
              data-testid="done-cost-input"
              :placeholder="session.t('maintenance.doneModal.costPlaceholder')"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
            <p class="text-[11px] text-on-surface-variant mt-1">
              {{ session.t('maintenance.doneModal.costHint') }}
            </p>
          </div>

          <div>
            <label for="done-note-input" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.doneModal.noteLabel') }}
            </label>
            <textarea
              id="done-note-input"
              v-model="doneNote"
              rows="3"
              maxlength="1000"
              data-testid="done-note-input"
              :placeholder="session.t('maintenance.doneModal.notePlaceholder')"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-xs text-on-surface focus:border-primary focus:outline-none"
            ></textarea>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container cursor-pointer"
            @click="showDoneModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-done-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container cursor-pointer"
            @click="handleDone"
          >
            {{ session.t('maintenance.doneModal.submitBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Skip Occurrence (#016) -->
    <div
      v-if="showSkipModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div
        data-testid="skip-occurrence-modal"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl"
      >
        <h3 class="font-bold text-base text-on-surface">
          {{ session.t('maintenance.skipModal.title') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.skipModal.desc') }}
        </p>

        <div
          v-if="skipModalError"
          data-testid="skip-modal-error"
          class="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold"
        >
          {{ skipModalError }}
        </div>

        <div>
          <label for="skip-note-input" class="block text-xs font-semibold text-on-surface">
            {{ session.t('maintenance.skipModal.noteLabel') }} *
          </label>
          <textarea
            id="skip-note-input"
            v-model="skipNote"
            rows="3"
            maxlength="1000"
            data-testid="skip-note-input"
            :placeholder="session.t('maintenance.skipModal.notePlaceholder')"
            class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-xs text-on-surface focus:border-primary focus:outline-none"
          ></textarea>
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container cursor-pointer"
            @click="showSkipModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-skip-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container cursor-pointer"
            @click="handleSkip"
          >
            {{ session.t('maintenance.skipModal.submitBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Modal: Edit Log Entry (#016) -->
    <div
      v-if="showEditLogModal && editingEntry"
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
          v-if="editLogError"
          data-testid="edit-log-modal-error"
          class="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold"
        >
          {{ editLogError }}
        </div>

        <div class="space-y-3">
          <div v-if="editingEntry.kind === 'DONE'">
            <label for="edit-log-cost-input" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.doneModal.costLabel') }}
            </label>
            <input
              id="edit-log-cost-input"
              v-model="editLogCost"
              type="text"
              inputmode="decimal"
              data-testid="edit-log-cost-input"
              :placeholder="session.t('maintenance.doneModal.costPlaceholder')"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label for="edit-log-note-input" class="block text-xs font-semibold text-on-surface">
              {{ editingEntry.kind === 'SKIPPED' ? `${session.t('maintenance.skipModal.noteLabel')} *` : session.t('maintenance.doneModal.noteLabel') }}
            </label>
            <textarea
              id="edit-log-note-input"
              v-model="editLogNote"
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
            @click="showEditLogModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-edit-log-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container cursor-pointer"
            @click="handleSaveLogEdit"
          >
            {{ session.t('maintenance.log.saveBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal: Pause Task -->
    <div
      v-if="showPauseModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl">
        <h3 class="font-bold text-base text-on-surface">
          {{ session.t('maintenance.pauseModalTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.pauseModalDesc') }}
        </p>
        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container"
            @click="showPauseModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-pause-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container"
            @click="handlePause"
          >
            {{ session.t('maintenance.confirmPause') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal: Resume Task -->
    <div
      v-if="showResumeModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl">
        <h3 class="font-bold text-base text-on-surface">
          {{ session.t('maintenance.resumeModalTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.resumeModalDesc') }}
        </p>

        <!-- Optional new next due date -->
        <div>
          <label for="resume-due-date" class="block text-xs font-semibold text-on-surface">
            {{ session.t('maintenance.resumeDueDateLabel') }}
          </label>
          <input
            id="resume-due-date"
            v-model="resumeDueDate"
            type="date"
            data-testid="resume-due-date-input"
            class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3 py-2 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
          />
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container"
            @click="showResumeModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-resume-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container"
            @click="handleResume"
          >
            {{ session.t('maintenance.confirmResume') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal: Archive Task -->
    <div
      v-if="showArchiveModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs"
    >
      <div class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 max-w-md w-full space-y-4 shadow-xl">
        <h3 class="font-bold text-base text-error">
          {{ session.t('maintenance.archiveModalTitle') }}
        </h3>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('maintenance.archiveModalDesc') }}
        </p>
        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container"
            @click="showArchiveModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="confirm-archive-btn"
            :disabled="actionPending"
            class="px-4 py-2 rounded-xl bg-error text-on-error text-xs font-semibold hover:bg-error/90"
            @click="handleArchive"
          >
            {{ session.t('maintenance.confirmArchive') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
