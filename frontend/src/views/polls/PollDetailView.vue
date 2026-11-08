<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  cancelPoll,
  closePoll,
  deletePollDraft,
  extendPollDeadline,
  getPoll,
  openPoll,
  submitBallot,
} from '@/api/endpoints/governance.js'
import {
  formatPollDateTime,
  formatPollValue,
  isoToLocalDateInput,
  localDateToEndOfDayIso,
  normalizeCanonicalNumber,
  validateBallotDraft,
} from '@/utils/pollValidation.js'
import { localizeError } from '@/locales/index.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import PollResults from '@/views/polls/components/PollResults.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const poll = ref(null)
const loading = ref(false)
const loadError = ref(null)
const notFound = ref(false)

const selectedApartmentId = ref('')
const draftByQuestion = reactive({})
const questionErrors = reactive({})
const submitting = ref(false)
const submitError = ref('')
const savedBanner = ref(false)
const closedNoticeBanner = ref('')

// Board lifecycle modal state (#008)
const activeBoardModal = ref(null) // 'open' | 'delete' | 'extend' | 'close' | 'cancel' | null
const extendDateInput = ref('')
const boardActionBusy = ref(false)
const boardActionError = ref('')
const boardSuccessBanner = ref('')

const pollId = computed(() => String(route.params.pollId || ''))
const isResultsTab = computed(
  () => route.name === 'poll-results' || route.query.tab === 'results',
)
const userMemberships = computed(() => session.memberships || [])
const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const answerableApartmentOptions = computed(() => {
  const ids = poll.value?.answerable_apartment_ids || []
  return ids.map((aptId) => {
    const found = userMemberships.value.find((m) => m.apartment_id === aptId)
    return {
      apartment_id: aptId,
      label: found?.apartment_number
        ? session.t('common.apartmentNumber', { number: found.apartment_number })
        : aptId,
      apartment_number: found?.apartment_number || null,
    }
  })
})

const needsApartmentSelector = computed(
  () =>
    poll.value?.unit === 'APARTMENT' &&
    Array.isArray(poll.value?.answerable_apartment_ids) &&
    poll.value.answerable_apartment_ids.length > 1,
)

const activeBallotForSelection = computed(() => {
  if (!poll.value || poll.value.status === 'CANCELLED') return null
  const ballots = poll.value.my_ballots || []
  if (poll.value.unit === 'PERSON') {
    return ballots[0] || null
  }
  const targetAptId =
    selectedApartmentId.value ||
    poll.value.answerable_apartment_ids?.[0] ||
    ballots[0]?.apartment_id ||
    null
  if (!targetAptId) return ballots[0] || null
  return ballots.find((b) => b.apartment_id === targetAptId) || null
})

const whyCannotAnswerText = computed(() => {
  if (!poll.value || poll.value.status !== 'OPEN' || poll.value.can_answer) {
    return ''
  }
  if (poll.value.eligibility === 'OWNERS') {
    const hasOwnerMembership = userMemberships.value.some((m) => m.relation_type === 'OWNER')
    if (!hasOwnerMembership) {
      return session.t('polls.onlyOwnersCanAnswer')
    }
  }
  return session.t('polls.notTargetedCanNotAnswer')
})

function questionPromptText(q) {
  return q?.text || q?.prompt || ''
}

function formatApartmentLabel(apartmentId) {
  if (!apartmentId) return ''
  const mem = userMemberships.value.find((m) => m.apartment_id === apartmentId)
  if (mem?.apartment_number) {
    return session.t('common.apartmentNumber', { number: mem.apartment_number })
  }
  return ''
}

function formatTargetScope(p) {
  if (!p) return ''
  if (p.target_scope === 'ENTRANCE' && p.target_entrance != null) {
    return session.t('polls.target.entrance', { entrance: p.target_entrance })
  }
  if (p.target_scope === 'APARTMENT_LIST') {
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

function clearQuestionErrors() {
  for (const key of Object.keys(questionErrors)) {
    delete questionErrors[key]
  }
}

function syncDraftFromBallot() {
  if (!poll.value) return
  clearQuestionErrors()
  const ballot = activeBallotForSelection.value
  const answersByQuestion = {}
  if (ballot && Array.isArray(ballot.answers)) {
    for (const ans of ballot.answers) {
      answersByQuestion[ans.question_id] = ans
    }
  }

  for (const q of poll.value.questions || []) {
    const existing = answersByQuestion[q.id]
    draftByQuestion[q.id] = {
      option_ids: existing && Array.isArray(existing.option_ids) ? [...existing.option_ids] : [],
      value: existing && existing.value != null ? String(existing.value) : '',
    }
  }
}

function selectSingleChoice(questionId, optionId) {
  draftByQuestion[questionId] = {
    option_ids: optionId ? [optionId] : [],
    value: '',
  }
  delete questionErrors[questionId]
  savedBanner.value = false
}

function toggleMultipleChoice(questionId, optionId, checked) {
  const current = draftByQuestion[questionId]?.option_ids || []
  const next = checked
    ? Array.from(new Set([...current, optionId]))
    : current.filter((id) => id !== optionId)
  draftByQuestion[questionId] = {
    option_ids: next,
    value: '',
  }
  delete questionErrors[questionId]
  savedBanner.value = false
}

function updateOwnValue(questionId, val) {
  draftByQuestion[questionId] = {
    option_ids: [],
    value: val,
  }
  delete questionErrors[questionId]
  savedBanner.value = false
}

function resolveSavedAnswerDisplay(question, ballot) {
  if (!ballot || !Array.isArray(ballot.answers)) return []
  const ans = ballot.answers.find((a) => a.question_id === question.id)
  if (!ans) return []

  if (question.answer_mode === 'SINGLE_CHOICE' || question.answer_mode === 'MULTIPLE_CHOICE') {
    const ids = ans.option_ids || []
    return ids
      .map((optId) => {
        const opt = (question.options || []).find((o) => o.id === optId)
        return opt ? formatPollValue(opt.value, question.value_type, session.lang) : null
      })
      .filter(Boolean)
  }

  if (ans.value != null && String(ans.value).trim() !== '') {
    return [formatPollValue(ans.value, question.value_type, session.lang)]
  }
  return []
}

function formatQuestionConstraintHint(q) {
  const parts = []
  if (q.answer_mode === 'MULTIPLE_CHOICE') {
    const min = q.min_choices ?? 1
    const max = q.max_choices ?? (q.options ? q.options.length : 1)
    if (min === max) {
      parts.push(session.t('polls.constraints.exactChoices', { count: min }))
    } else {
      parts.push(session.t('polls.constraints.minMaxChoices', { min, max }))
    }
  }
  if (q.answer_mode === 'OWN_VALUE' && (q.value_type === 'NUMBER' || q.value_type === 'DATE')) {
    if (q.min_value != null && q.max_value != null) {
      parts.push(
        session.t('polls.constraints.rangeBetween', {
          min: formatPollValue(q.min_value, q.value_type, session.lang),
          max: formatPollValue(q.max_value, q.value_type, session.lang),
        }),
      )
    } else if (q.min_value != null) {
      parts.push(
        session.t('polls.constraints.minOnly', {
          min: formatPollValue(q.min_value, q.value_type, session.lang),
        }),
      )
    } else if (q.max_value != null) {
      parts.push(
        session.t('polls.constraints.maxOnly', {
          max: formatPollValue(q.max_value, q.value_type, session.lang),
        }),
      )
    }
  }
  return parts.join(' · ')
}

function formatValidationReason(reason, question) {
  const key = `polls.validation.${reason}`
  const minChoices = question?.min_choices ?? 1
  const maxChoices = question?.max_choices ?? (question?.options?.length || 1)
  return session.t(key, {
    min:
      question?.min_value != null
        ? formatPollValue(question.min_value, question.value_type, session.lang)
        : minChoices,
    max:
      question?.max_value != null
        ? formatPollValue(question.max_value, question.value_type, session.lang)
        : maxChoices,
  })
}

let fetchPollDetailSeq = 0

async function fetchPollDetail(preserveBanner = false) {
  if (!pollId.value) return
  const seq = ++fetchPollDetailSeq
  loading.value = true
  loadError.value = null
  notFound.value = false
  if (!preserveBanner) {
    savedBanner.value = false
    closedNoticeBanner.value = ''
    boardSuccessBanner.value = ''
  }

  try {
    const res = await getPoll(pollId.value)
    if (seq !== fetchPollDetailSeq) return
    poll.value = res
    const aptIds = res.answerable_apartment_ids || []
    if (
      aptIds.length > 0 &&
      (!selectedApartmentId.value || !aptIds.includes(selectedApartmentId.value))
    ) {
      const activeAptId = session.activeMembership?.apartment_id
      selectedApartmentId.value =
        activeAptId && aptIds.includes(activeAptId) ? activeAptId : aptIds[0]
    }
    syncDraftFromBallot()
  } catch (err) {
    if (seq !== fetchPollDetailSeq) return
    if (err?.status === 404 || err?.errorCode === 'POLL_NOT_FOUND') {
      notFound.value = true
    } else {
      loadError.value = err
    }
  } finally {
    if (seq === fetchPollDetailSeq) {
      loading.value = false
    }
  }
}

function openBoardActionModal(actionType) {
  boardActionError.value = ''
  boardSuccessBanner.value = ''
  if (actionType === 'extend' && poll.value?.closes_at) {
    const currentLocal = isoToLocalDateInput(poll.value.closes_at)
    if (currentLocal) {
      const dt = new Date(`${currentLocal}T12:00:00Z`)
      dt.setUTCDate(dt.getUTCDate() + 7)
      extendDateInput.value = dt.toISOString().slice(0, 10)
    } else {
      extendDateInput.value = ''
    }
  }
  activeBoardModal.value = actionType
}

function closeBoardActionModal() {
  if (boardActionBusy.value) return
  activeBoardModal.value = null
  boardActionError.value = ''
}

async function confirmBoardAction() {
  if (!poll.value || !activeBoardModal.value || boardActionBusy.value) return
  boardActionBusy.value = true
  boardActionError.value = ''
  const action = activeBoardModal.value

  try {
    if (action === 'open') {
      const updated = await openPoll(poll.value.id)
      poll.value = updated
      syncDraftFromBallot()
      activeBoardModal.value = null
      boardSuccessBanner.value = session.t('polls.board.openedBanner')
    } else if (action === 'delete') {
      await deletePollDraft(poll.value.id)
      activeBoardModal.value = null
      router.push({ name: 'polls' })
    } else if (action === 'extend') {
      const closesAtIso = localDateToEndOfDayIso(extendDateInput.value)
      if (!closesAtIso) {
        boardActionError.value = session.t('errors.INVALID_DEADLINE')
        boardActionBusy.value = false
        return
      }
      const updated = await extendPollDeadline(poll.value.id, { closes_at: closesAtIso })
      poll.value = updated
      activeBoardModal.value = null
      boardSuccessBanner.value = session.t('polls.board.deadlineExtendedBanner')
    } else if (action === 'close') {
      const updated = await closePoll(poll.value.id)
      poll.value = updated
      activeBoardModal.value = null
      boardSuccessBanner.value = session.t('polls.board.closedBanner')
    } else if (action === 'cancel') {
      const updated = await cancelPoll(poll.value.id)
      poll.value = updated
      activeBoardModal.value = null
      boardSuccessBanner.value = session.t('polls.board.cancelledBanner')
    }
  } catch (err) {
    const errorCode = err?.errorCode || err?.payload?.error_code
    if (err?.status === 409 && errorCode === 'POLL_NOT_OPEN') {
      activeBoardModal.value = null
      closedNoticeBanner.value = session.t('errors.POLL_NOT_OPEN')
      await fetchPollDetail(true)
    } else if (err?.status === 409 && errorCode === 'POLL_NOT_DRAFT') {
      activeBoardModal.value = null
      await fetchPollDetail(true)
    } else if (errorCode === 'INVALID_DEADLINE') {
      boardActionError.value =
        action === 'extend'
          ? session.t('polls.board.extendDeadlineInvalid')
          : session.t('errors.INVALID_DEADLINE')
    } else if (errorCode === 'POLL_HAS_NO_ELECTORATE') {
      boardActionError.value = session.t('errors.POLL_HAS_NO_ELECTORATE')
    } else {
      boardActionError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    boardActionBusy.value = false
  }
}

async function handleSaveBallot() {
  if (!poll.value || !poll.value.can_answer || submitting.value) return
  clearQuestionErrors()
  submitError.value = ''
  savedBanner.value = false
  closedNoticeBanner.value = ''

  const validation = validateBallotDraft(poll.value.questions || [], draftByQuestion)
  if (!validation.valid) {
    const offendingQuestion = (poll.value.questions || []).find(
      (q) => q.id === validation.questionId,
    )
    questionErrors[validation.questionId] = formatValidationReason(
      validation.reason,
      offendingQuestion,
    )
    return
  }

  const answersPayload = []
  for (const q of poll.value.questions || []) {
    const entry = draftByQuestion[q.id]
    if (!entry) continue
    if (q.answer_mode === 'SINGLE_CHOICE' || q.answer_mode === 'MULTIPLE_CHOICE') {
      if (Array.isArray(entry.option_ids) && entry.option_ids.length > 0) {
        answersPayload.push({
          question_id: q.id,
          option_ids: [...entry.option_ids],
        })
      }
    } else if (q.answer_mode === 'OWN_VALUE') {
      const rawVal = entry.value != null ? String(entry.value).trim() : ''
      if (rawVal !== '') {
        const valueToSend =
          q.value_type === 'NUMBER' ? normalizeCanonicalNumber(rawVal) : rawVal
        answersPayload.push({
          question_id: q.id,
          value: valueToSend,
        })
      }
    }
  }

  const payload = {
    answers: answersPayload,
  }
  if (needsApartmentSelector.value && selectedApartmentId.value) {
    payload.apartment_id = selectedApartmentId.value
  }

  submitting.value = true
  try {
    const updated = await submitBallot(poll.value.id, payload)
    poll.value = updated
    syncDraftFromBallot()
    savedBanner.value = true
  } catch (err) {
    const errorCode = err?.errorCode || err?.payload?.error_code
    if (err?.status === 422 && errorCode === 'INVALID_ANSWER') {
      const qId = err?.payload?.question_id
      const reason = err?.payload?.reason || 'VALUE'
      const offendingQuestion = (poll.value.questions || []).find((q) => q.id === qId)
      if (qId) {
        questionErrors[qId] = formatValidationReason(reason, offendingQuestion)
      } else {
        submitError.value = formatValidationReason(reason, null)
      }
    } else if (err?.status === 409 && errorCode === 'POLL_NOT_OPEN') {
      closedNoticeBanner.value = session.t('errors.POLL_NOT_OPEN')
      await fetchPollDetail(true)
    } else {
      submitError.value = localizeError(err, {}, session.lang)
    }
  } finally {
    submitting.value = false
  }
}

watch(selectedApartmentId, () => {
  syncDraftFromBallot()
})

watch(
  () => [pollId.value, session.actingUserId],
  () => {
    fetchPollDetail()
  },
)

onMounted(() => {
  fetchPollDetail()
})
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
    <!-- Back Navigation -->
    <div>
      <RouterLink
        :to="{ name: 'polls' }"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        {{ session.t('polls.backToPolls') }}
      </RouterLink>
    </div>

    <!-- 404 Not Found State -->
    <div
      v-if="notFound"
      data-testid="poll-not-found"
      class="rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
    >
      <span class="material-symbols-outlined text-3xl text-slate-400">block</span>
      <h1 class="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
        {{ session.t('polls.notFoundTitle') }}
      </h1>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {{ session.t('polls.notFoundBody') }}
      </p>
    </div>

    <!-- Error State -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="fetchPollDetail"
    />

    <!-- Loading State -->
    <div
      v-else-if="loading && !poll"
      class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
    >
      {{ session.t('polls.loadingDetail') }}
    </div>

    <!-- Poll Content -->
    <template v-else-if="poll">
      <!-- Poll Header Card -->
      <section class="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold tracking-wide"
              :class="statusBadgeClass(poll.status)"
            >
              {{ session.t(`polls.status.${poll.status}`) }}
            </span>

            <span
              class="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              {{ session.t(`polls.kind.${poll.kind}`) }}
            </span>

            <span
              v-if="poll.can_answer && (!poll.my_ballots || poll.my_ballots.length === 0)"
              data-testid="detail-please-answer-badge"
              class="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
            >
              <span class="material-symbols-outlined text-[14px]">schedule</span>
              {{ session.t('polls.pleaseAnswerBadge') }}
            </span>
          </div>

          <!-- Board Lifecycle Actions (#008) -->
          <div
            v-if="isBoardOrChairman && (poll.status === 'DRAFT' || poll.status === 'OPEN')"
            data-testid="poll-board-actions"
            class="flex flex-wrap items-center gap-2"
          >
            <template v-if="poll.status === 'DRAFT'">
              <RouterLink
                :to="{ name: 'poll-edit', params: { pollId: poll.id } }"
                data-testid="poll-board-edit-btn"
                class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <span class="material-symbols-outlined text-[15px]">edit</span>
                <span>{{ session.t('polls.board.editDraftBtn') }}</span>
              </RouterLink>

              <button
                type="button"
                data-testid="poll-board-open-btn"
                class="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-600"
                @click="openBoardActionModal('open')"
              >
                <span class="material-symbols-outlined text-[15px]">publish</span>
                <span>{{ session.t('polls.board.openPollBtn') }}</span>
              </button>

              <button
                type="button"
                data-testid="poll-board-delete-btn"
                class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800/70 dark:bg-slate-900 dark:text-rose-300"
                @click="openBoardActionModal('delete')"
              >
                <span class="material-symbols-outlined text-[15px]">delete</span>
                <span>{{ session.t('polls.board.deleteDraftBtn') }}</span>
              </button>
            </template>

            <template v-else-if="poll.status === 'OPEN'">
              <button
                type="button"
                data-testid="poll-board-extend-btn"
                class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                @click="openBoardActionModal('extend')"
              >
                <span class="material-symbols-outlined text-[15px]">event_upcoming</span>
                <span>{{ session.t('polls.board.extendDeadlineBtn') }}</span>
              </button>

              <button
                type="button"
                data-testid="poll-board-close-btn"
                class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                @click="openBoardActionModal('close')"
              >
                <span class="material-symbols-outlined text-[15px]">lock</span>
                <span>{{ session.t('polls.board.closeNowBtn') }}</span>
              </button>

              <button
                type="button"
                data-testid="poll-board-cancel-btn"
                class="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800/70 dark:bg-slate-900 dark:text-rose-300"
                @click="openBoardActionModal('cancel')"
              >
                <span class="material-symbols-outlined text-[15px]">cancel</span>
                <span>{{ session.t('polls.board.cancelPollBtn') }}</span>
              </button>
            </template>
          </div>
        </div>

        <h1 class="mt-3 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {{ poll.title }}
        </h1>

        <p
          v-if="poll.description"
          class="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-300"
        >
          {{ poll.description }}
        </p>

        <!-- Poll Metadata Grid -->
        <dl class="mt-5 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 text-xs sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800">
          <div class="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <dt class="font-medium text-slate-500 dark:text-slate-400">
              {{ session.t('polls.meta.deadline') }}
            </dt>
            <dd class="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100">
              {{ formatPollDateTime(poll.closes_at, session.lang) }}
            </dd>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <dt class="font-medium text-slate-500 dark:text-slate-400">
              {{ session.t('polls.meta.whoAnswers') }}
            </dt>
            <dd class="mt-1 font-semibold text-slate-900 dark:text-slate-100">
              {{ session.t(`polls.eligibility.${poll.eligibility}`) }}
            </dd>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <dt class="font-medium text-slate-500 dark:text-slate-400">
              {{ session.t('polls.meta.countingUnit') }}
            </dt>
            <dd class="mt-1 font-semibold text-slate-900 dark:text-slate-100">
              {{ session.t(`polls.unit.${poll.unit}`) }}
            </dd>
          </div>

          <div class="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <dt class="font-medium text-slate-500 dark:text-slate-400">
              {{ session.t('polls.meta.scope') }}
            </dt>
            <dd class="mt-1 font-semibold text-slate-900 dark:text-slate-100">
              {{ formatTargetScope(poll) }}
            </dd>
          </div>
        </dl>
      </section>

      <!-- Board Action Success Banner -->
      <div
        v-if="boardSuccessBanner"
        role="status"
        data-testid="poll-board-success-banner"
        class="flex items-center gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200"
      >
        <span class="material-symbols-outlined text-[20px]">check_circle</span>
        <span>{{ boardSuccessBanner }}</span>
      </div>

      <!-- Poll Closed Reload Notice -->
      <div
        v-if="closedNoticeBanner"
        role="alert"
        data-testid="poll-closed-reload-banner"
        class="flex items-center gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
      >
        <span class="material-symbols-outlined text-[20px]">lock_clock</span>
        <span>{{ closedNoticeBanner }}</span>
      </div>

      <!-- Ballot Saved Confirmation Banner -->
      <div
        v-if="savedBanner"
        role="status"
        data-testid="poll-saved-banner"
        class="flex items-center gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200"
      >
        <span class="material-symbols-outlined text-[20px]">check_circle</span>
        <span>{{ session.t('polls.ballotSavedBanner') }}</span>
      </div>

      <!-- Cancelled Poll Notice (No form, no answers) -->
      <section
        v-if="poll.status === 'CANCELLED'"
        data-testid="poll-cancelled-notice"
        class="rounded-xl border border-rose-200 bg-rose-50/70 p-6 text-sm text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200"
      >
        <div class="flex items-start gap-3">
          <span class="material-symbols-outlined text-[22px] text-rose-600 dark:text-rose-400">
            cancel
          </span>
          <div>
            <h2 class="font-semibold">
              {{ session.t('polls.cancelledNoticeTitle') }}
            </h2>
            <p class="mt-1 text-rose-800 dark:text-rose-300">
              {{ session.t('polls.cancelledNoticeBody') }}
            </p>
          </div>
        </div>
      </section>

      <!-- Non-Cancelled Content -->
      <template v-else>
        <!-- Questions / Results Tab Switcher (Results link shown only when results_available is true) -->
        <div
          v-if="poll.results_available || isResultsTab"
          class="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3 dark:border-slate-800"
          role="tablist"
        >
          <RouterLink
            :to="{ name: 'poll-detail', params: { pollId: poll.id } }"
            role="tab"
            :aria-selected="!isResultsTab"
            data-testid="poll-detail-questions-tab"
            class="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
            :class="
              !isResultsTab
                ? 'bg-slate-900 text-white dark:bg-teal-600 dark:text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
            "
          >
            <span class="material-symbols-outlined text-[17px]">ballot</span>
            <span>{{ session.t('polls.results.tabQuestions') }}</span>
          </RouterLink>

          <RouterLink
            v-if="poll.results_available"
            :to="{ name: 'poll-results', params: { pollId: poll.id } }"
            role="tab"
            :aria-selected="isResultsTab"
            data-testid="poll-detail-results-tab"
            class="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
            :class="
              isResultsTab
                ? 'bg-slate-900 text-white dark:bg-teal-600 dark:text-white'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
            "
          >
            <span class="material-symbols-outlined text-[17px]">bar_chart</span>
            <span>{{ session.t('polls.results.tabResults') }}</span>
          </RouterLink>
        </div>

        <!-- Poll Results Tab View (#009) -->
        <PollResults
          v-if="isResultsTab"
          :poll-id="poll.id"
          :poll="poll"
        />

        <template v-else>
          <!-- Explanation when an open poll is not answerable by the caller (e.g. Tenant on OWNERS poll) -->
          <section
            v-if="poll.status === 'OPEN' && !poll.can_answer && whyCannotAnswerText"
          data-testid="poll-cannot-answer-notice"
          class="rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <div class="flex items-center gap-2.5">
            <span class="material-symbols-outlined text-[20px] text-amber-700 dark:text-amber-400">
              info
            </span>
            <span class="font-medium">{{ whyCannotAnswerText }}</span>
          </div>
        </section>

        <!-- Saved Ballots Summary ("Your apartment answered" / "You answered") -->
        <section
          v-if="poll.my_ballots && poll.my_ballots.length > 0"
          data-testid="poll-my-ballots-section"
          class="rounded-xl border border-teal-200 bg-teal-50/40 p-5 dark:border-teal-900/60 dark:bg-teal-950/20"
        >
          <div
            v-for="(ballot, bIdx) in poll.my_ballots"
            :key="ballot.apartment_id || bIdx"
            :class="bIdx > 0 ? 'mt-5 border-t border-teal-200/70 pt-5 dark:border-teal-900/50' : ''"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="material-symbols-outlined text-[20px] text-teal-700 dark:text-teal-400">
                  verified
                </span>
                <h2 class="text-sm font-semibold text-teal-950 dark:text-teal-200">
                  <template v-if="poll.unit === 'APARTMENT'">
                    <template v-if="formatApartmentLabel(ballot.apartment_id) && poll.my_ballots.length > 1">
                      {{
                        session.t('polls.apartmentSpecificAnsweredTitle', {
                          apartment: formatApartmentLabel(ballot.apartment_id),
                        })
                      }}
                    </template>
                    <template v-else>
                      {{ session.t('polls.yourApartmentAnsweredTitle') }}
                    </template>
                  </template>
                  <template v-else>
                    {{ session.t('polls.youAnsweredTitle') }}
                  </template>
                </h2>
              </div>

              <span class="font-mono text-xs text-teal-800 dark:text-teal-300">
                {{
                  session.t('polls.savedAtLabel', {
                    date: formatPollDateTime(ballot.updated_at || ballot.submitted_at, session.lang),
                  })
                }}
              </span>
            </div>

            <dl class="mt-3 space-y-2.5 text-sm">
              <div
                v-for="(q, qIdx) in poll.questions"
                :key="`${ballot.apartment_id || 'me'}-${q.id}`"
                class="rounded-lg border border-teal-200/70 bg-white/90 px-3.5 py-2.5 dark:border-teal-900/50 dark:bg-slate-900/80"
              >
                <dt class="text-xs font-medium text-slate-600 dark:text-slate-400">
                  {{ qIdx + 1 }}. {{ questionPromptText(q) }}
                </dt>
                <dd class="mt-1 font-medium text-slate-900 dark:text-slate-100">
                  <template v-if="resolveSavedAnswerDisplay(q, ballot).length > 0">
                    <span
                      v-for="(valText, vIdx) in resolveSavedAnswerDisplay(q, ballot)"
                      :key="vIdx"
                      class="inline-block"
                    >
                      {{ valText }}<template v-if="vIdx < resolveSavedAnswerDisplay(q, ballot).length - 1">, </template>
                    </span>
                  </template>
                  <span v-else class="italic text-slate-400 dark:text-slate-500">
                    {{ session.t('polls.noAnswerGiven') }}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <!-- Ballot Answering Form (when can_answer === true) -->
        <form
          v-if="poll.can_answer"
          data-testid="poll-ballot-form"
          class="space-y-5 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
          @submit.prevent="handleSaveBallot"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4 dark:border-slate-800">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
                {{
                  activeBallotForSelection
                    ? session.t('polls.updateAnswersHeading')
                    : session.t('polls.answerFormHeading')
                }}
              </h2>
              <p class="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                {{
                  poll.unit === 'APARTMENT'
                    ? session.t('polls.apartmentBallotHint')
                    : session.t('polls.personBallotHint')
                }}
              </p>
            </div>

            <!-- Multi-apartment Selector when unit === 'APARTMENT' and answerable_apartment_ids.length > 1 -->
            <div v-if="needsApartmentSelector" class="sm:w-64">
              <label
                for="poll-apartment-select"
                class="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {{ session.t('polls.selectApartmentLabel') }}
              </label>
              <select
                id="poll-apartment-select"
                v-model="selectedApartmentId"
                data-testid="poll-apartment-selector"
                class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option
                  v-for="apt in answerableApartmentOptions"
                  :key="apt.apartment_id"
                  :value="apt.apartment_id"
                >
                  {{ apt.label }}
                </option>
              </select>
            </div>
          </div>

          <!-- Questions List -->
          <div class="space-y-6">
            <div
              v-for="(q, qIdx) in poll.questions"
              :key="q.id"
              :data-testid="`poll-question-${q.id}`"
              class="rounded-xl border p-4 transition-colors"
              :class="
                questionErrors[q.id]
                  ? 'border-rose-400 bg-rose-50/30 dark:border-rose-700 dark:bg-rose-950/20'
                  : 'border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-800/40'
              "
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <label class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {{ qIdx + 1 }}. {{ questionPromptText(q) }}
                  <span
                    v-if="q.required"
                    class="ml-1 text-rose-600 dark:text-rose-400"
                    :title="session.t('polls.requiredLabel')"
                  >*</span>
                </label>

                <span
                  class="rounded-md px-2 py-0.5 text-[11px] font-medium"
                  :class="
                    q.required
                      ? 'bg-slate-200/80 text-slate-700 dark:bg-slate-700 dark:text-slate-300'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  "
                >
                  {{ q.required ? session.t('polls.requiredLabel') : session.t('polls.optionalLabel') }}
                </span>
              </div>

              <p
                v-if="formatQuestionConstraintHint(q)"
                class="mt-1 text-xs text-slate-500 dark:text-slate-400"
              >
                {{ formatQuestionConstraintHint(q) }}
              </p>

              <!-- SINGLE_CHOICE -->
              <div
                v-if="q.answer_mode === 'SINGLE_CHOICE'"
                class="mt-3 space-y-2"
              >
                <label
                  v-for="opt in q.options"
                  :key="opt.id"
                  class="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm transition-colors hover:border-teal-600/60 dark:border-slate-700 dark:bg-slate-900"
                  :class="
                    draftByQuestion[q.id]?.option_ids?.[0] === opt.id
                      ? 'border-teal-600 ring-1 ring-teal-600 dark:border-teal-500 dark:ring-teal-500'
                      : ''
                  "
                >
                  <input
                    type="radio"
                    :name="`question-${q.id}`"
                    :value="opt.id"
                    :checked="draftByQuestion[q.id]?.option_ids?.[0] === opt.id"
                    class="h-4 w-4 text-teal-600 focus:ring-teal-500"
                    @change="selectSingleChoice(q.id, opt.id)"
                  />
                  <span class="font-medium text-slate-900 dark:text-slate-100">
                    {{ formatPollValue(opt.value, q.value_type, session.lang) }}
                  </span>
                </label>

                <button
                  v-if="!q.required && draftByQuestion[q.id]?.option_ids?.length > 0"
                  type="button"
                  class="mt-1 text-xs font-medium text-slate-500 underline hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  @click="selectSingleChoice(q.id, null)"
                >
                  {{ session.t('polls.clearSelection') }}
                </button>
              </div>

              <!-- MULTIPLE_CHOICE -->
              <div
                v-else-if="q.answer_mode === 'MULTIPLE_CHOICE'"
                class="mt-3 space-y-2"
              >
                <label
                  v-for="opt in q.options"
                  :key="opt.id"
                  class="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm transition-colors hover:border-teal-600/60 dark:border-slate-700 dark:bg-slate-900"
                  :class="
                    draftByQuestion[q.id]?.option_ids?.includes(opt.id)
                      ? 'border-teal-600 ring-1 ring-teal-600 dark:border-teal-500 dark:ring-teal-500'
                      : ''
                  "
                >
                  <input
                    type="checkbox"
                    :value="opt.id"
                    :checked="draftByQuestion[q.id]?.option_ids?.includes(opt.id)"
                    class="h-4 w-4 rounded text-teal-600 focus:ring-teal-500"
                    @change="toggleMultipleChoice(q.id, opt.id, $event.target.checked)"
                  />
                  <span class="font-medium text-slate-900 dark:text-slate-100">
                    {{ formatPollValue(opt.value, q.value_type, session.lang) }}
                  </span>
                </label>
              </div>

              <!-- OWN_VALUE: TEXT -->
              <div
                v-else-if="q.answer_mode === 'OWN_VALUE' && q.value_type === 'TEXT'"
                class="mt-3"
              >
                <textarea
                  :value="draftByQuestion[q.id]?.value || ''"
                  rows="3"
                  maxlength="2000"
                  :placeholder="session.t('polls.textPlaceholder')"
                  class="block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  @input="updateOwnValue(q.id, $event.target.value)"
                />
              </div>

              <!-- OWN_VALUE: NUMBER -->
              <div
                v-else-if="q.answer_mode === 'OWN_VALUE' && q.value_type === 'NUMBER'"
                class="mt-3 max-w-xs"
              >
                <input
                  type="text"
                  inputmode="decimal"
                  :value="draftByQuestion[q.id]?.value || ''"
                  :placeholder="session.t('polls.numberPlaceholder')"
                  class="block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  @input="updateOwnValue(q.id, $event.target.value)"
                />
              </div>

              <!-- OWN_VALUE: DATE -->
              <div
                v-else-if="q.answer_mode === 'OWN_VALUE' && q.value_type === 'DATE'"
                class="mt-3 max-w-xs"
              >
                <input
                  type="date"
                  :min="q.min_value || undefined"
                  :max="q.max_value || undefined"
                  :value="draftByQuestion[q.id]?.value || ''"
                  class="block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  @input="updateOwnValue(q.id, $event.target.value)"
                />
              </div>

              <!-- Per-Question Validation Error -->
              <p
                v-if="questionErrors[q.id]"
                :data-testid="`poll-question-error-${q.id}`"
                class="mt-2 flex items-center gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400"
              >
                <span class="material-symbols-outlined text-[15px]">error</span>
                <span>{{ questionErrors[q.id] }}</span>
              </p>
            </div>
          </div>

          <!-- Form-level Submit Error -->
          <div
            v-if="submitError"
            role="alert"
            class="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
          >
            {{ submitError }}
          </div>

          <div class="flex items-center justify-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
            <button
              type="submit"
              data-testid="poll-submit-ballot-btn"
              :disabled="submitting"
              class="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 dark:bg-teal-600 dark:hover:bg-teal-500"
            >
              <span class="material-symbols-outlined text-[18px]">check</span>
              <span>
                {{
                  submitting
                    ? session.t('common.saving')
                    : activeBallotForSelection
                      ? session.t('polls.updateBallotBtn')
                      : session.t('polls.submitBallotBtn')
                }}
              </span>
            </button>
          </div>
        </form>

        <!-- Read-only Questions Preview (when can_answer === false and status !== 'CANCELLED') -->
        <section
          v-else
          data-testid="poll-questions-readonly"
          class="space-y-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
        >
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
            {{ session.t('polls.questionsReadonlyHeading') }}
          </h2>

          <div class="space-y-4">
            <div
              v-for="(q, qIdx) in poll.questions"
              :key="q.id"
              class="rounded-xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-800/40"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <p class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {{ qIdx + 1 }}. {{ questionPromptText(q) }}
                </p>
                <span class="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                  {{ q.required ? session.t('polls.requiredLabel') : session.t('polls.optionalLabel') }}
                </span>
              </div>

              <p
                v-if="formatQuestionConstraintHint(q)"
                class="mt-1 text-xs text-slate-500 dark:text-slate-400"
              >
                {{ formatQuestionConstraintHint(q) }}
              </p>

              <ul
                v-if="q.options && q.options.length > 0"
                class="mt-3 space-y-1.5 text-sm text-slate-700 dark:text-slate-300"
              >
                <li
                  v-for="opt in q.options"
                  :key="opt.id"
                  class="flex items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3 py-2 dark:border-slate-700/80 dark:bg-slate-900"
                >
                  <span class="material-symbols-outlined text-[16px] text-slate-400">
                    {{ q.answer_mode === 'SINGLE_CHOICE' ? 'radio_button_unchecked' : 'check_box_outline_blank' }}
                  </span>
                  <span>{{ formatPollValue(opt.value, q.value_type, session.locale) }}</span>
                </li>
              </ul>
            </div>
          </div>
        </section>
        </template>
      </template>

      <!-- Board Lifecycle Confirmation Modal (#008) -->
      <div
        v-if="activeBoardModal"
        data-testid="poll-board-modal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        @click.self="closeBoardActionModal"
      >
        <div class="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
          <!-- Open Poll Confirmation -->
          <template v-if="activeBoardModal === 'open'">
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">
              {{ session.t('polls.board.openModalTitle') }}
            </h2>
            <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {{ session.t('polls.board.openModalBody') }}
            </p>
          </template>

          <!-- Delete Draft Confirmation -->
          <template v-else-if="activeBoardModal === 'delete'">
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">
              {{ session.t('polls.board.deleteModalTitle') }}
            </h2>
            <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {{ session.t('polls.board.deleteModalBody') }}
            </p>
          </template>

          <!-- Extend Deadline Modal -->
          <template v-else-if="activeBoardModal === 'extend'">
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">
              {{ session.t('polls.board.extendModalTitle') }}
            </h2>
            <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {{ session.t('polls.board.extendModalBody') }}
            </p>
            <div class="mt-4">
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                {{ session.t('polls.board.newDeadlineLabel') }}
              </label>
              <input
                v-model="extendDateInput"
                type="date"
                data-testid="poll-extend-date-input"
                class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {{ session.t('polls.editor.deadlineEndOfDayHint') }}
              </p>
            </div>
          </template>

          <!-- Close Poll Early Confirmation -->
          <template v-else-if="activeBoardModal === 'close'">
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">
              {{ session.t('polls.board.closeModalTitle') }}
            </h2>
            <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {{ session.t('polls.board.closeModalBody') }}
            </p>
          </template>

          <!-- Cancel Poll Confirmation -->
          <template v-else-if="activeBoardModal === 'cancel'">
            <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">
              {{ session.t('polls.board.cancelModalTitle') }}
            </h2>
            <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
              {{ session.t('polls.board.cancelModalBody') }}
            </p>
          </template>

          <p
            v-if="boardActionError"
            data-testid="poll-board-modal-error"
            class="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
          >
            {{ boardActionError }}
          </p>

          <div class="mt-6 flex items-center justify-end gap-2.5">
            <button
              type="button"
              :disabled="boardActionBusy"
              class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              @click="closeBoardActionModal"
            >
              {{ session.t('common.cancel') }}
            </button>

            <button
              type="button"
              data-testid="poll-board-modal-confirm-btn"
              :disabled="boardActionBusy"
              class="rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
              :class="
                activeBoardModal === 'delete' || activeBoardModal === 'cancel'
                  ? 'bg-rose-600 hover:bg-rose-500'
                  : 'bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500'
              "
              @click="confirmBoardAction"
            >
              <template v-if="boardActionBusy">{{ session.t('common.saving') }}</template>
              <template v-else-if="activeBoardModal === 'open'">{{ session.t('polls.board.openPollBtn') }}</template>
              <template v-else-if="activeBoardModal === 'delete'">{{ session.t('polls.board.deleteDraftBtn') }}</template>
              <template v-else-if="activeBoardModal === 'extend'">{{ session.t('polls.board.saveDeadlineBtn') }}</template>
              <template v-else-if="activeBoardModal === 'close'">{{ session.t('polls.board.closeNowBtn') }}</template>
              <template v-else-if="activeBoardModal === 'cancel'">{{ session.t('polls.board.cancelPollBtn') }}</template>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
