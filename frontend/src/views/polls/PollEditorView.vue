<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { createPollDraft, getPoll, replacePollDraft } from '@/api/endpoints/governance.js'
import { listApartments } from '@/api/endpoints/property.js'
import { isoToLocalDateInput, validatePollDraft } from '@/utils/pollValidation.js'
import { localizeError } from '@/locales/index.js'
import QuestionEditor from './components/QuestionEditor.vue'
import TargetScopePicker from '@/components/domain/TargetScopePicker.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)
const isEditMode = computed(() => Boolean(route.params.pollId))
const pollId = computed(() => String(route.params.pollId || ''))

const loading = ref(false)
const loadError = ref(null)
const notEditableError = ref(false)
const apartments = ref([])

function defaultDeadlineDate() {
  const dt = new Date(Date.now() + 14 * 86400 * 1000)
  return dt.toISOString().slice(0, 10)
}

function makeEmptyQuestion() {
  return {
    text: '',
    answer_mode: 'SINGLE_CHOICE',
    value_type: 'TEXT',
    required: true,
    min_choices: null,
    max_choices: null,
    min_value: '',
    max_value: '',
    options: ['', ''],
  }
}

const form = reactive({
  title: '',
  description: '',
  target_scope: 'ALL_BUILDING',
  target_entrance: 1,
  target_apartment_ids: [],
  eligibility: 'RESIDENTS',
  unit: 'APARTMENT',
  closes_date: defaultDeadlineDate(),
  questions: [makeEmptyQuestion()],
})

const fieldErrors = reactive({})
const questionErrors = reactive({})
const serverValidationDetails = ref([])
const submitError = ref('')
const saving = ref(false)

const availableEntrances = computed(() => {
  const count = session.building?.entrances_count || session.building?.total_entrances || 2
  const set = new Set()
  for (let i = 1; i <= count; i += 1) set.add(i)
  for (const a of apartments.value) {
    if (a.entrance) set.add(a.entrance)
  }
  return Array.from(set).sort((a, b) => a - b)
})

const targetModel = computed({
  get() {
    return {
      target_scope: form.target_scope,
      target_entrance: form.target_entrance,
      target_apartment_ids: form.target_apartment_ids,
    }
  },
  set(val) {
    if (!val) return
    form.target_scope = val.target_scope || 'ALL_BUILDING'
    form.target_entrance = val.target_entrance ?? 1
    form.target_apartment_ids = Array.isArray(val.target_apartment_ids) ? val.target_apartment_ids : []
    delete fieldErrors.target
  },
})

function clearErrors() {
  for (const k of Object.keys(fieldErrors)) delete fieldErrors[k]
  for (const k of Object.keys(questionErrors)) delete questionErrors[k]
  serverValidationDetails.value = []
  submitError.value = ''
}

function resolveFieldError(code) {
  if (!code) return ''
  return session.t(`polls.editor.validation.${code}`)
}

function toggleTargetApartment(aptId, checked) {
  const current = Array.isArray(form.target_apartment_ids) ? [...form.target_apartment_ids] : []
  form.target_apartment_ids = checked
    ? Array.from(new Set([...current, aptId]))
    : current.filter((id) => id !== aptId)
  delete fieldErrors.target
}

function updateQuestion(idx, nextQuestion) {
  form.questions.splice(idx, 1, nextQuestion)
  delete questionErrors[idx]
}

function addQuestion() {
  if (form.questions.length >= 20) return
  form.questions.push(makeEmptyQuestion())
}

function removeQuestion(idx) {
  if (form.questions.length <= 1) return
  form.questions.splice(idx, 1)
  clearErrors()
}

function moveQuestion(idx, delta) {
  const targetIdx = idx + delta
  if (targetIdx < 0 || targetIdx >= form.questions.length) return
  const copy = [...form.questions]
  const [moved] = copy.splice(idx, 1)
  copy.splice(targetIdx, 0, moved)
  form.questions = copy
  clearErrors()
}

async function loadInitialData() {
  if (!isBoardOrChairman.value) return
  loading.value = true
  loadError.value = null
  notEditableError.value = false

  try {
    const promises = [listApartments().catch(() => ({ apartments: [] }))]
    if (isEditMode.value) {
      promises.push(getPoll(pollId.value))
    }
    const [aptsRes, existingPoll] = await Promise.all(promises)
    apartments.value = Array.isArray(aptsRes?.apartments) ? aptsRes.apartments : []

    if (isEditMode.value && existingPoll) {
      if (existingPoll.status !== 'DRAFT') {
        notEditableError.value = true
        return
      }
      form.title = existingPoll.title || ''
      form.description = existingPoll.description || ''
      form.target_scope = existingPoll.target_scope || 'ALL_BUILDING'
      form.target_entrance = existingPoll.target_entrance || 1
      form.target_apartment_ids = Array.isArray(existingPoll.target_apartment_ids)
        ? [...existingPoll.target_apartment_ids]
        : []
      form.eligibility = existingPoll.eligibility || 'RESIDENTS'
      form.unit = existingPoll.unit || 'APARTMENT'
      form.closes_date = isoToLocalDateInput(existingPoll.closes_at) || defaultDeadlineDate()
      form.questions =
        Array.isArray(existingPoll.questions) && existingPoll.questions.length > 0
          ? existingPoll.questions.map((q) => ({
              text: q.text || q.prompt || '',
              answer_mode: q.answer_mode || 'SINGLE_CHOICE',
              value_type: q.value_type || 'TEXT',
              required: q.required !== false,
              min_choices: q.min_choices ?? null,
              max_choices: q.max_choices ?? null,
              min_value: q.min_value ?? '',
              max_value: q.max_value ?? '',
              options:
                Array.isArray(q.options) && q.options.length > 0
                  ? q.options.map((o) => String(o.value ?? o))
                  : q.answer_mode === 'OWN_VALUE'
                    ? []
                    : ['', ''],
            }))
          : [makeEmptyQuestion()]
    }
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

async function handleSaveDraft() {
  if (saving.value) return
  clearErrors()

  const check = validatePollDraft(form)
  if (!check.valid || !check.payload) {
    for (const [k, v] of Object.entries(check.fieldErrors)) {
      fieldErrors[k] = v
    }
    for (const [qIdx, qErrObj] of Object.entries(check.questionErrors)) {
      questionErrors[Number(qIdx)] = qErrObj
    }
    return
  }

  saving.value = true
  try {
    const saved = isEditMode.value
      ? await replacePollDraft(pollId.value, check.payload)
      : await createPollDraft(check.payload)

    router.push({ name: 'poll-detail', params: { pollId: saved.id } })
  } catch (err) {
    const errorCode = err?.errorCode || err?.payload?.error_code
    if (err?.status === 422 && errorCode === 'INVALID_TARGET') {
      fieldErrors.target = 'INVALID_TARGET'
    } else if (err?.status === 422 && errorCode === 'INVALID_DEADLINE') {
      fieldErrors.closes_at = 'INVALID_DEADLINE'
    } else if (err?.status === 422 && errorCode === 'VALIDATION_ERROR') {
      if (Array.isArray(err?.payload?.errors)) {
        serverValidationDetails.value = err.payload.errors.map(
          (item) => `${item.field || 'poll'}: ${item.message || item.type || 'invalid'}`,
        )
      }
      submitError.value = localizeError(err, {}, session.lang)
    } else if (err?.status === 409 && errorCode === 'POLL_NOT_DRAFT') {
      notEditableError.value = true
    } else {
      submitError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => [route.params.pollId, session.actingUserId],
  () => {
    loadInitialData()
  },
)

onMounted(() => {
  loadInitialData()
})
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Back Link -->
    <div>
      <RouterLink
        :to="isEditMode ? { name: 'poll-detail', params: { pollId } } : { name: 'polls' }"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-on-surface-variant hover:text-primary transition-colors"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        {{ isEditMode ? session.t('polls.editor.backToPoll') : session.t('polls.backToPolls') }}
      </RouterLink>
    </div>

    <!-- Role Guard -->
    <div
      v-if="!isBoardOrChairman"
      data-testid="poll-editor-no-access"
      class="rounded-2xl border border-surface-container bg-surface-container-lowest p-8 text-center"
    >
      <span class="material-symbols-outlined text-3xl text-on-surface-variant">lock</span>
      <h1 class="mt-2 text-lg font-semibold text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h1>
    </div>

    <!-- Not Draft Error -->
    <div
      v-else-if="notEditableError"
      class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-900 dark:text-amber-200"
    >
      <p class="font-semibold">{{ session.t('errors.POLL_NOT_EDITABLE') }}</p>
    </div>

    <!-- Error Card -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="loadInitialData"
    />

    <!-- Loading -->
    <div
      v-else-if="loading"
      class="rounded-2xl border border-surface-container bg-surface-container-lowest p-8 text-center text-sm text-on-surface-variant"
    >
      {{ session.t('common.loading') }}
    </div>

    <!-- Draft Editor Form -->
    <form
      v-else
      data-testid="poll-editor-form"
      class="space-y-6 rounded-2xl border border-surface-container bg-surface-container-lowest p-6"
      @submit.prevent="handleSaveDraft"
    >
      <header class="border-b border-surface-container pb-4">
        <p class="text-xs font-semibold uppercase tracking-wider text-primary">
          {{ session.t('polls.eyebrow') }}
        </p>
        <h1 class="mt-1 font-headline-md text-2xl font-bold tracking-tight text-on-surface">
          {{ isEditMode ? session.t('polls.editor.editTitle') : session.t('polls.editor.createTitle') }}
        </h1>
        <p class="mt-1 text-sm text-on-surface-variant">
          {{ session.t('polls.editor.subtitle') }}
        </p>
      </header>

      <!-- Title & Description -->
      <div class="space-y-4">
        <div>
          <label
            for="poll-draft-title"
            class="block text-sm font-semibold text-on-surface"
          >
            {{ session.t('polls.editor.titleLabel') }} *
          </label>
          <input
            id="poll-draft-title"
            v-model="form.title"
            type="text"
            maxlength="255"
            data-testid="poll-draft-title-input"
            :placeholder="session.t('polls.editor.titlePlaceholder')"
            class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
            @input="delete fieldErrors.title"
          />
          <p
            v-if="fieldErrors.title"
            class="mt-1 text-xs font-semibold text-error"
          >
            {{ resolveFieldError(fieldErrors.title) }}
          </p>
        </div>

        <div>
          <label
            for="poll-draft-desc"
            class="block text-sm font-semibold text-on-surface"
          >
            {{ session.t('polls.editor.descriptionLabel') }}
          </label>
          <textarea
            id="poll-draft-desc"
            v-model="form.description"
            rows="3"
            maxlength="5000"
            data-testid="poll-draft-description-input"
            :placeholder="session.t('polls.editor.descriptionPlaceholder')"
            class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
            @input="delete fieldErrors.description"
          />
          <p
            v-if="fieldErrors.description"
            class="mt-1 text-xs font-semibold text-error"
          >
            {{ resolveFieldError(fieldErrors.description) }}
          </p>
        </div>
      </div>

      <!-- Audience, Eligibility, Unit & Deadline -->
      <div class="grid grid-cols-1 gap-4 border-t border-surface-container pt-5 sm:grid-cols-2">
        <!-- Target Scope -->
        <div class="sm:col-span-2">
          <TargetScopePicker
            v-model="targetModel"
            :apartments="apartments"
            :available-entrances="availableEntrances"
            :error-message="fieldErrors.target ? resolveFieldError(fieldErrors.target) : ''"
            test-id-prefix="poll-draft"
            @change="delete fieldErrors.target"
          />
        </div>

        <!-- Deadline Date Picker (sent as end-of-day 23:59:59 local time) -->
        <div class="sm:col-span-2">
          <label
            for="poll-draft-deadline"
            class="block text-sm font-semibold text-on-surface"
          >
            {{ session.t('polls.editor.deadlineDateLabel') }} *
          </label>
          <input
            id="poll-draft-deadline"
            v-model="form.closes_date"
            type="date"
            data-testid="poll-draft-deadline-input"
            class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 font-mono text-sm text-on-surface focus:border-primary focus:outline-none"
            @input="delete fieldErrors.closes_at"
          />
          <p class="mt-1 text-xs text-on-surface-variant">
            {{ session.t('polls.editor.deadlineEndOfDayHint') }}
          </p>
          <p
            v-if="fieldErrors.closes_at"
            class="mt-1 text-xs font-semibold text-error"
          >
            {{ resolveFieldError(fieldErrors.closes_at) }}
          </p>
        </div>

        <!-- Eligibility -->
        <div>
          <label class="block text-sm font-semibold text-on-surface">
            {{ session.t('polls.meta.whoAnswers') }}
          </label>
          <select
            v-model="form.eligibility"
            data-testid="poll-draft-eligibility"
            class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="RESIDENTS">{{ session.t('polls.eligibility.RESIDENTS') }}</option>
            <option value="OWNERS">{{ session.t('polls.eligibility.OWNERS') }}</option>
          </select>
          <p class="mt-1 text-xs text-on-surface-variant">
            {{
              form.eligibility === 'OWNERS'
                ? session.t('polls.editor.eligibilityOwnersExplain')
                : session.t('polls.editor.eligibilityResidentsExplain')
            }}
          </p>
        </div>

        <!-- Counting Unit -->
        <div>
          <label class="block text-sm font-semibold text-on-surface">
            {{ session.t('polls.meta.countingUnit') }}
          </label>
          <select
            v-model="form.unit"
            data-testid="poll-draft-unit"
            class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="APARTMENT">{{ session.t('polls.unit.APARTMENT') }}</option>
            <option value="PERSON">{{ session.t('polls.unit.PERSON') }}</option>
          </select>
          <p class="mt-1 text-xs text-on-surface-variant">
            {{
              form.unit === 'APARTMENT'
                ? session.t('polls.editor.unitApartmentExplain')
                : session.t('polls.editor.unitPersonExplain')
            }}
          </p>
        </div>
      </div>

      <!-- Small-group Privacy Warning -->
      <div
        data-testid="poll-editor-privacy-note"
        class="flex items-start gap-2.5 rounded-xl border px-4 py-3 text-xs"
        :class="
          form.target_scope !== 'ALL_BUILDING'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
            : 'border-surface-container bg-surface-container-low text-on-surface-variant'
        "
      >
        <span class="material-symbols-outlined text-[18px] shrink-0">privacy_tip</span>
        <span>{{ session.t('polls.editor.smallGroupPrivacyWarning') }}</span>
      </div>

      <!-- Questions Editor Section -->
      <section class="space-y-4 border-t border-surface-container pt-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-on-surface">
              {{ session.t('polls.editor.questionsSectionTitle') }}
            </h2>
            <p class="text-xs text-on-surface-variant">
              {{ session.t('polls.editor.questionsSectionSubtitle') }}
            </p>
          </div>

          <button
            v-if="form.questions.length < 20"
            type="button"
            data-testid="poll-editor-add-question-btn"
            class="inline-flex items-center gap-1.5 rounded-lg border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container transition-colors"
            @click="addQuestion"
          >
            <span class="material-symbols-outlined text-[16px]">add</span>
            <span>{{ session.t('polls.editor.addQuestionBtn') }}</span>
          </button>
        </div>

        <div class="space-y-4">
          <QuestionEditor
            v-for="(q, idx) in form.questions"
            :key="idx"
            :index="idx"
            :question="q"
            :errors="questionErrors[idx] || {}"
            :can-remove="form.questions.length > 1"
            :can-move-up="idx > 0"
            :can-move-down="idx < form.questions.length - 1"
            @update="updateQuestion(idx, $event)"
            @remove="removeQuestion(idx)"
            @move-up="moveQuestion(idx, -1)"
            @move-down="moveQuestion(idx, 1)"
          />
        </div>
      </section>

      <!-- Server Validation Details -->
      <div
        v-if="submitError || serverValidationDetails.length > 0"
        role="alert"
        class="rounded-xl border border-error/30 bg-error-container/30 p-4 text-sm text-on-error-container"
      >
        <p v-if="submitError" class="font-semibold">{{ submitError }}</p>
        <ul v-if="serverValidationDetails.length > 0" class="mt-1 list-disc pl-5 text-xs">
          <li v-for="(msg, i) in serverValidationDetails" :key="i">{{ msg }}</li>
        </ul>
      </div>

      <!-- Form Actions -->
      <div class="flex items-center justify-end gap-3 border-t border-surface-container pt-4">
        <RouterLink
          :to="isEditMode ? { name: 'poll-detail', params: { pollId } } : { name: 'polls' }"
          class="rounded-xl border border-surface-container-high bg-surface-container-low px-4 py-2.5 text-sm font-medium text-on-surface hover:bg-surface-container transition-colors"
        >
          {{ session.t('common.cancel') }}
        </RouterLink>

        <button
          type="submit"
          data-testid="poll-draft-save-btn"
          :disabled="saving"
          class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-container transition-colors disabled:opacity-50"
        >
          <span class="material-symbols-outlined text-[18px]">save</span>
          <span>
            {{ saving ? session.t('common.saving') : session.t('polls.editor.saveDraftBtn') }}
          </span>
        </button>
      </div>
    </form>
  </div>
</template>
