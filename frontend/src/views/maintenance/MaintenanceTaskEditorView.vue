<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  createMaintenanceTask,
  editMaintenanceTask,
  getMaintenanceTask,
} from '@/api/endpoints/maintenance.js'
import { listApartments } from '@/api/endpoints/property.js'
import {
  getTodayDateInTallinn,
  maxAllowedLeadDays,
  validateTaskDraft,
} from '@/utils/maintenance.js'
import { localizeError } from '@/locales/index.js'
import TargetScopePicker from '@/components/domain/TargetScopePicker.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canManageMaintenance } = useRole()

const taskId = computed(() => String(route.params.taskId || ''))
const isEditMode = computed(() => Boolean(taskId.value))

const loading = ref(false)
const loadError = ref(null)
const saving = ref(false)
const submitError = ref('')
const serverErrors = ref({})
const occurrenceClosedConflict = ref(false)

const existingTask = ref(null)
const apartments = ref([])

const form = reactive({
  title: '',
  instructions: '',
  period_unit: 'MONTH',
  period_count: 12,
  lead_days: 14,
  due_date: getTodayDateInTallinn(),
  has_notice: false,
  notice: {
    title: '',
    body: '',
    category: 'MAINTENANCE',
    target_scope: 'ALL_BUILDING',
    target_entrance: 1,
    target_apartment_ids: [],
    comments_enabled: false,
  },
})

const clientErrors = reactive({})

const availableEntrances = computed(() => {
  const count = session.building?.entrances_count || session.building?.total_entrances || 2
  const set = new Set()
  for (let i = 1; i <= count; i += 1) set.add(i)
  for (const a of apartments.value) {
    if (a.entrance) set.add(a.entrance)
  }
  return Array.from(set).sort((a, b) => a - b)
})

const currentMaxLead = computed(() =>
  maxAllowedLeadDays(form.period_unit, form.period_count),
)

const targetModel = computed({
  get() {
    return {
      target_scope: form.notice.target_scope,
      target_entrance: form.notice.target_entrance,
      target_apartment_ids: form.notice.target_apartment_ids,
    }
  },
  set(val) {
    if (!val) return
    form.notice.target_scope = val.target_scope || 'ALL_BUILDING'
    form.notice.target_entrance = val.target_entrance ?? 1
    form.notice.target_apartment_ids = Array.isArray(val.target_apartment_ids)
      ? val.target_apartment_ids
      : []
    delete clientErrors.notice_target
  },
})

function clearErrors() {
  for (const k of Object.keys(clientErrors)) delete clientErrors[k]
  serverErrors.value = {}
  submitError.value = ''
  occurrenceClosedConflict.value = false
}

function resolveFieldError(fieldKey) {
  const code = clientErrors[fieldKey] || serverErrors.value[fieldKey]
  if (!code) return ''
  return session.t(`maintenance.validation.${code}`) || code
}

async function loadData() {
  if (!canManageMaintenance.value) return
  loading.value = true
  loadError.value = null
  clearErrors()

  try {
    const promises = [listApartments().catch(() => ({ apartments: [] }))]
    if (isEditMode.value) {
      promises.push(getMaintenanceTask(taskId.value))
    }
    const [aptsRes, taskRes] = await Promise.all(promises)
    apartments.value = Array.isArray(aptsRes?.apartments) ? aptsRes.apartments : []

    if (isEditMode.value && taskRes) {
      existingTask.value = taskRes
      if (taskRes.status === 'ARCHIVED') {
        router.replace(`/maintenance/${taskId.value}`)
        return
      }

      form.title = taskRes.title || ''
      form.instructions = taskRes.instructions || ''
      form.period_unit = taskRes.period_unit || 'MONTH'
      form.period_count = taskRes.period_count || 12
      form.lead_days = taskRes.lead_days || 14
      form.due_date = taskRes.current?.due_date || getTodayDateInTallinn()

      if (taskRes.notice) {
        form.has_notice = true
        form.notice = {
          title: taskRes.notice.title || '',
          body: taskRes.notice.body || '',
          category: taskRes.notice.category || 'MAINTENANCE',
          target_scope: taskRes.notice.target_scope || 'ALL_BUILDING',
          target_entrance: taskRes.notice.target_entrance ?? 1,
          target_apartment_ids: taskRes.notice.target_apartment_ids || [],
          comments_enabled: Boolean(taskRes.notice.comments_enabled),
        }
      } else {
        form.has_notice = false
      }
    }
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  clearErrors()

  // Validate draft with domain rules
  const draftToValidate = {
    title: form.title,
    instructions: form.instructions,
    period_unit: form.period_unit,
    period_count: form.period_count,
    lead_days: form.lead_days,
    has_notice: form.has_notice,
    notice: form.has_notice ? form.notice : null,
  }

  if (isEditMode.value) {
    draftToValidate.next_due_date = form.due_date
    draftToValidate.occurrence_id = existingTask.value?.current?.occurrence_id
  } else {
    draftToValidate.first_due_date = form.due_date
  }

  const check = validateTaskDraft(draftToValidate, { isEdit: isEditMode.value })
  if (!check.valid) {
    Object.assign(clientErrors, check.errors)
    return
  }

  saving.value = true
  try {
    if (isEditMode.value) {
      // Build PATCH payload with only changed fields
      const patch = {}
      if (form.title.trim() !== (existingTask.value?.title || '')) {
        patch.title = form.title.trim()
      }
      if (form.instructions.trim() !== (existingTask.value?.instructions || '')) {
        patch.instructions = form.instructions.trim()
      }
      if (
        form.period_unit !== existingTask.value?.period_unit ||
        form.period_count !== existingTask.value?.period_count
      ) {
        patch.period_unit = form.period_unit
        patch.period_count = form.period_count
      }
      if (form.lead_days !== existingTask.value?.lead_days) {
        patch.lead_days = form.lead_days
      }
      if (form.due_date !== existingTask.value?.current?.due_date) {
        patch.next_due_date = form.due_date
        patch.occurrence_id = existingTask.value?.current?.occurrence_id
      }

      const noticePayload = form.has_notice ? check.payload.notice : null
      patch.notice = noticePayload

      const saved = await editMaintenanceTask(taskId.value, patch)
      router.push(`/maintenance/${saved.id}`)
    } else {
      const saved = await createMaintenanceTask(check.payload)
      router.push(`/maintenance/${saved.id}`)
    }
  } catch (err) {
    const errorCode = err?.errorCode || err?.payload?.error_code
    if (err?.status === 409 && errorCode === 'OCCURRENCE_CLOSED') {
      occurrenceClosedConflict.value = true
      // reload task
      loadData()
    } else if (err?.status === 422 && err?.payload?.errors) {
      serverErrors.value = err.payload.errors
      submitError.value = localizeError(err, {}, session.lang)
    } else {
      submitError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => [taskId.value, session.actingUserId],
  () => {
    loadData()
  },
)

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Back Link -->
    <div>
      <RouterLink
        :to="isEditMode ? `/maintenance/${taskId}` : '/maintenance'"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        <span>{{ isEditMode ? session.t('maintenance.editor.backToTask') : session.t('maintenance.editor.backToList') }}</span>
      </RouterLink>
    </div>

    <!-- Role Guard -->
    <div
      v-if="!canManageMaintenance"
      data-testid="maintenance-editor-forbidden"
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
      <ErrorCard v-if="loadError" :error="loadError" @retry="loadData" />

      <div v-else-if="loading" class="p-8 text-center text-sm text-on-surface-variant">
        {{ session.t('common.loading') }}
      </div>

      <!-- Main Form -->
      <form
        v-else
        data-testid="maintenance-task-form"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 sm:p-8 space-y-6 shadow-xs"
        @submit.prevent="handleSubmit"
      >
        <div>
          <h1 class="font-headline-md font-bold text-on-surface">
            {{ isEditMode ? session.t('maintenance.editor.editTitle') : session.t('maintenance.editor.newTitle') }}
          </h1>
          <p class="text-sm text-on-surface-variant mt-0.5">
            {{ isEditMode ? session.t('maintenance.editor.editSubtitle') : session.t('maintenance.editor.newSubtitle') }}
          </p>
        </div>

        <!-- 409 Occurrence Closed Conflict Banner -->
        <div
          v-if="occurrenceClosedConflict"
          data-testid="occurrence-closed-banner"
          class="p-4 rounded-xl bg-amber-50 border border-amber-300 dark:bg-amber-950/50 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs flex items-center gap-2"
        >
          <span class="material-symbols-outlined text-[18px]">info</span>
          <span>{{ session.t('maintenance.editor.occurrenceClosedConflict') }}</span>
        </div>

        <div v-if="submitError" class="p-4 rounded-xl bg-error/10 border border-error/30 text-error text-xs font-semibold">
          {{ submitError }}
        </div>

        <!-- Section 1: Task Core Details -->
        <div class="space-y-4">
          <!-- Title -->
          <div>
            <label for="task-title" class="block text-sm font-semibold text-on-surface">
              {{ session.t('maintenance.editor.taskTitleLabel') }} *
            </label>
            <input
              id="task-title"
              v-model="form.title"
              type="text"
              data-testid="maintenance-task-title-input"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-none"
              :placeholder="session.t('maintenance.editor.taskTitlePlaceholder')"
              @input="delete clientErrors.title"
            />
            <p v-if="clientErrors.title" class="mt-1 text-xs font-semibold text-error">
              {{ resolveFieldError('title') }}
            </p>
          </div>

          <!-- Internal Instructions -->
          <div>
            <div class="flex items-center justify-between">
              <label for="task-instructions" class="block text-sm font-semibold text-on-surface">
                {{ session.t('maintenance.editor.instructionsLabel') }}
              </label>
              <span class="text-[11px] text-on-surface-variant font-medium">
                {{ session.t('maintenance.editor.boardOnlyHint') }}
              </span>
            </div>
            <textarea
              id="task-instructions"
              v-model="form.instructions"
              rows="3"
              data-testid="maintenance-task-instructions-input"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2.5 text-sm text-on-surface focus:border-primary focus:outline-none"
              :placeholder="session.t('maintenance.editor.instructionsPlaceholder')"
              @input="delete clientErrors.instructions"
            />
            <p v-if="clientErrors.instructions" class="mt-1 text-xs font-semibold text-error">
              {{ resolveFieldError('instructions') }}
            </p>
          </div>
        </div>

        <!-- Section 2: Recurrence Rhythm & Dates -->
        <div class="border-t border-surface-container pt-5 space-y-4">
          <h2 class="text-sm font-bold text-on-surface uppercase tracking-wider">
            {{ session.t('maintenance.editor.rhythmHeading') }}
          </h2>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <!-- Period Count -->
            <div>
              <label for="task-period-count" class="block text-xs font-semibold text-on-surface">
                {{ session.t('maintenance.editor.repeatEvery') }} *
              </label>
              <input
                id="task-period-count"
                v-model.number="form.period_count"
                type="number"
                min="1"
                data-testid="maintenance-task-period-count"
                class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                @input="delete clientErrors.period_count"
              />
              <p v-if="clientErrors.period_count" class="mt-1 text-xs font-semibold text-error">
                {{ resolveFieldError('period_count') }}
              </p>
            </div>

            <!-- Period Unit -->
            <div>
              <label for="task-period-unit" class="block text-xs font-semibold text-on-surface">
                {{ session.t('maintenance.editor.periodUnit') }} *
              </label>
              <select
                id="task-period-unit"
                v-model="form.period_unit"
                data-testid="maintenance-task-period-unit"
                class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                @change="delete clientErrors.period_unit"
              >
                <option value="DAY">{{ session.t('maintenance.units.DAY') }}</option>
                <option value="MONTH">{{ session.t('maintenance.units.MONTH') }}</option>
                <option value="YEAR">{{ session.t('maintenance.units.YEAR') }}</option>
              </select>
              <p v-if="clientErrors.period_unit" class="mt-1 text-xs font-semibold text-error">
                {{ resolveFieldError('period_unit') }}
              </p>
            </div>

            <!-- Due Date (first_due_date / next_due_date) -->
            <div>
              <label for="task-due-date" class="block text-xs font-semibold text-on-surface">
                {{ isEditMode ? session.t('maintenance.editor.nextDueDateLabel') : session.t('maintenance.editor.firstDueDateLabel') }} *
              </label>
              <input
                id="task-due-date"
                v-model="form.due_date"
                type="date"
                data-testid="maintenance-task-due-date"
                class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm font-mono text-on-surface focus:border-primary focus:outline-none"
                @input="delete clientErrors.first_due_date; delete clientErrors.next_due_date"
              />
              <p v-if="clientErrors.first_due_date || clientErrors.next_due_date" class="mt-1 text-xs font-semibold text-error">
                {{ resolveFieldError(isEditMode ? 'next_due_date' : 'first_due_date') }}
              </p>
            </div>
          </div>

          <!-- Rhythm Hint regarding day-of-month and calendar calculation -->
          <div class="p-3 rounded-xl bg-surface-container-low text-xs text-on-surface-variant flex items-start gap-2">
            <span class="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">tips_and_updates</span>
            <span>{{ session.t('maintenance.editor.rhythmMonthEndHint') }}</span>
          </div>

          <!-- Lead Days -->
          <div class="max-w-xs">
            <label for="task-lead-days" class="block text-xs font-semibold text-on-surface">
              {{ session.t('maintenance.editor.leadDaysLabel') }} (0–{{ currentMaxLead }})
            </label>
            <input
              id="task-lead-days"
              v-model.number="form.lead_days"
              type="number"
              min="0"
              :max="currentMaxLead"
              data-testid="maintenance-task-lead-days"
              class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              @input="delete clientErrors.lead_days"
            />
            <p class="mt-1 text-[11px] text-on-surface-variant">
              {{ session.t('maintenance.editor.leadDaysHint') }}
            </p>
            <p v-if="clientErrors.lead_days" class="mt-1 text-xs font-semibold text-error">
              {{ resolveFieldError('lead_days') }}
            </p>
          </div>
        </div>

        <!-- Section 3: Official Notice for Residents (Optional) -->
        <div class="border-t border-surface-container pt-5 space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-sm font-bold text-on-surface uppercase tracking-wider">
                {{ session.t('maintenance.editor.noticeHeading') }}
              </h2>
              <p class="text-xs text-on-surface-variant">
                {{ session.t('maintenance.editor.noticeSub') }}
              </p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                v-model="form.has_notice"
                type="checkbox"
                data-testid="maintenance-task-has-notice-toggle"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-surface-container-high peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>

          <div v-if="form.has_notice" class="p-4 sm:p-5 rounded-2xl bg-surface-container-low/50 border border-surface-container space-y-4">
            <!-- Notice Title -->
            <div>
              <label for="notice-title" class="block text-xs font-semibold text-on-surface">
                {{ session.t('maintenance.editor.noticeTitleLabel') }} *
              </label>
              <input
                id="notice-title"
                v-model="form.notice.title"
                type="text"
                data-testid="maintenance-notice-title"
                class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                :placeholder="session.t('maintenance.editor.noticeTitlePlaceholder')"
                @input="delete clientErrors.notice_title"
              />
              <p v-if="clientErrors.notice_title" class="mt-1 text-xs font-semibold text-error">
                {{ resolveFieldError('notice_title') }}
              </p>
            </div>

            <!-- Notice Body -->
            <div>
              <label for="notice-body" class="block text-xs font-semibold text-on-surface">
                {{ session.t('maintenance.editor.noticeBodyLabel') }} *
              </label>
              <textarea
                id="notice-body"
                v-model="form.notice.body"
                rows="3"
                data-testid="maintenance-notice-body"
                class="mt-1 block w-full rounded-xl border border-surface-container-high bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                :placeholder="session.t('maintenance.editor.noticeBodyPlaceholder')"
                @input="delete clientErrors.notice_body"
              />
              <p class="mt-0.5 text-[11px] text-on-surface-variant">
                {{ session.t('maintenance.editor.noticeAutoDateHint') }}
              </p>
              <p v-if="clientErrors.notice_body" class="mt-1 text-xs font-semibold text-error">
                {{ resolveFieldError('notice_body') }}
              </p>
            </div>

            <!-- Shared Target Scope Picker -->
            <TargetScopePicker
              v-model="targetModel"
              :apartments="apartments"
              :available-entrances="availableEntrances"
              :error-message="clientErrors.notice_target ? resolveFieldError('notice_target') : ''"
              test-id-prefix="maintenance-notice"
            />

            <!-- Comments Enabled Toggle -->
            <div class="flex items-center gap-2 pt-2">
              <input
                id="notice-comments"
                v-model="form.notice.comments_enabled"
                type="checkbox"
                data-testid="maintenance-notice-comments-toggle"
                class="h-4 w-4 rounded accent-primary cursor-pointer"
              />
              <label for="notice-comments" class="text-xs font-medium text-on-surface cursor-pointer">
                {{ session.t('maintenance.editor.enableComments') }}
              </label>
            </div>
          </div>
        </div>

        <!-- Form Actions -->
        <div class="border-t border-surface-container pt-5 flex items-center justify-end gap-3">
          <RouterLink
            :to="isEditMode ? `/maintenance/${taskId}` : '/maintenance'"
            class="px-4 py-2.5 rounded-xl text-sm font-semibold text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
          >
            {{ session.t('common.cancel') }}
          </RouterLink>

          <button
            type="submit"
            :disabled="saving"
            data-testid="maintenance-submit-btn"
            class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary font-semibold text-sm hover:bg-primary-container transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
          >
            <span v-if="saving" class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            <span>{{ isEditMode ? session.t('common.saveChanges') : session.t('maintenance.editor.createSubmitBtn') }}</span>
          </button>
        </div>
      </form>
    </template>
  </div>
</template>
