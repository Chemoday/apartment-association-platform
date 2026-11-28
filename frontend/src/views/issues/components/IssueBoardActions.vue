<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localizeError } from '@/locales/index.js'
import { listIssues, changeIssueStatus, clearIssueUrgent } from '@/api/endpoints/issues.js'
import {
  isIssueOpen,
  getAllowedBoardMoves,
  canBoardReopenIssue,
  rankDuplicateCandidates,
} from '@/utils/issues.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'

const props = defineProps({
  issue: {
    type: Object,
    required: true,
  },
  isOpenStatus: {
    type: Boolean,
    required: true,
  },
  statusBadgeClass: {
    type: Function,
    required: true,
  },
  formatLocation: {
    type: Function,
    required: true,
  },
})

const emit = defineEmits(['updated', 'action-error', 'conflict-reload', 'before-mutation'])

const session = useSessionStore()

const isBoardActionBusy = ref(false)
const pendingBoardMoveStatus = ref('') // 'IN_PROGRESS' | 'WAITING_FOR_CONTRACTOR' | 'RESOLVED' | 'REOPEN' | ''
const showDeclineModal = ref(false)
const showClearUrgentModal = ref(false)
const showDuplicateModal = ref(false)
const duplicateSearchQuery = ref('')
const duplicateCandidatesRaw = ref([])
const isLoadingDuplicates = ref(false)
const selectedOriginalId = ref('')
const duplicateModalError = ref('')

const allowedBoardMoves = computed(() =>
  props.issue ? getAllowedBoardMoves(props.issue) : [],
)

const isReopenMove = computed(() =>
  Boolean(props.issue && !isIssueOpen(props.issue.status) && canBoardReopenIssue(props.issue)),
)

const rankedDuplicateCandidates = computed(() =>
  props.issue
    ? rankDuplicateCandidates(
        duplicateCandidatesRaw.value,
        props.issue,
        duplicateSearchQuery.value,
      )
    : [],
)

function boardMoveButtonLabel(moveStatus) {
  if (isReopenMove.value && moveStatus === 'IN_PROGRESS') {
    return session.t('issues.board.actions.REOPEN')
  }
  return session.t(`issues.board.actions.${moveStatus}`)
}

function boardMoveButtonIcon(moveStatus) {
  if (isReopenMove.value && moveStatus === 'IN_PROGRESS') return 'restart_alt'
  if (moveStatus === 'IN_PROGRESS') return 'handyman'
  if (moveStatus === 'WAITING_FOR_CONTRACTOR') return 'engineering'
  if (moveStatus === 'RESOLVED') return 'task_alt'
  if (moveStatus === 'DUPLICATE') return 'content_copy'
  if (moveStatus === 'DECLINED') return 'block'
  return 'swap_horiz'
}

function handleClickBoardMove(targetStatus) {
  emit('action-error', '')
  if (targetStatus === 'DUPLICATE') {
    openDuplicateModal()
    return
  }
  if (targetStatus === 'DECLINED') {
    showDeclineModal.value = true
    return
  }
  pendingBoardMoveStatus.value =
    isReopenMove.value && targetStatus === 'IN_PROGRESS' ? 'REOPEN' : targetStatus
}

async function openDuplicateModal() {
  if (!props.issue) return
  duplicateSearchQuery.value = ''
  selectedOriginalId.value = ''
  duplicateModalError.value = ''
  showDuplicateModal.value = true
  isLoadingDuplicates.value = true
  try {
    const items = await listIssues()
    duplicateCandidatesRaw.value = Array.isArray(items) ? items : []
    const ranked = rankDuplicateCandidates(duplicateCandidatesRaw.value, props.issue, '')
    if (ranked.length > 0) {
      selectedOriginalId.value = ranked[0].id
    }
  } catch (err) {
    duplicateModalError.value = localizeError(err, session.lang)
  } finally {
    isLoadingDuplicates.value = false
  }
}

function handleBoardTransitionError(err) {
  if (err?.status === 409 && err?.errorCode === 'INVALID_ISSUE_TRANSITION') {
    emit('conflict-reload', session.t('issues.board.transitionConflictReloaded'))
  } else {
    emit('action-error', localizeError(err, session.lang))
  }
}

async function handleConfirmStandardMove() {
  if (!props.issue || !pendingBoardMoveStatus.value || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  emit('action-error', '')
  emit('before-mutation')
  const targetStatus =
    pendingBoardMoveStatus.value === 'REOPEN' ? 'IN_PROGRESS' : pendingBoardMoveStatus.value
  try {
    const updated = await changeIssueStatus(props.issue.id, { status: targetStatus })
    emit('before-mutation')
    emit('updated', updated)
    pendingBoardMoveStatus.value = ''
  } catch (err) {
    pendingBoardMoveStatus.value = ''
    handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmDecline() {
  if (!props.issue || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  emit('action-error', '')
  emit('before-mutation')
  try {
    const updated = await changeIssueStatus(props.issue.id, { status: 'DECLINED' })
    emit('before-mutation')
    emit('updated', updated)
    showDeclineModal.value = false
  } catch (err) {
    showDeclineModal.value = false
    handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmDuplicate() {
  if (!props.issue || isBoardActionBusy.value) return
  if (!selectedOriginalId.value) {
    duplicateModalError.value = session.t('issues.board.duplicateNoCandidates')
    return
  }
  isBoardActionBusy.value = true
  duplicateModalError.value = ''
  emit('action-error', '')
  emit('before-mutation')
  try {
    const updated = await changeIssueStatus(props.issue.id, {
      status: 'DUPLICATE',
      duplicate_of: selectedOriginalId.value,
    })
    emit('before-mutation')
    emit('updated', updated)
    showDuplicateModal.value = false
  } catch (err) {
    if (err?.status === 409 && err?.errorCode === 'INVALID_ISSUE_TRANSITION') {
      showDuplicateModal.value = false
      handleBoardTransitionError(err)
    } else {
      duplicateModalError.value = localizeError(err, session.lang)
    }
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmClearUrgent() {
  if (!props.issue || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  emit('action-error', '')
  emit('before-mutation')
  try {
    const updated = await clearIssueUrgent(props.issue.id)
    emit('before-mutation')
    emit('updated', updated)
    showClearUrgentModal.value = false
  } catch (err) {
    showClearUrgentModal.value = false
    handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}
</script>

<template>
  <!-- Board Panel (#013): visible only to CHAIRMAN and BOARD -->
  <section
    data-testid="issue-board-panel"
    class="rounded-2xl border border-primary/30 bg-primary-container/10 p-5 sm:p-6 space-y-5"
  >
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div>
        <h2
          class="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-1.5"
        >
          <span class="material-symbols-outlined text-[18px]">admin_panel_settings</span>
          {{ session.t('issues.board.panelTitle') }}
        </h2>
        <p class="mt-0.5 text-xs text-on-surface-variant">
          {{ session.t('issues.board.panelSubtitle') }}
        </p>
      </div>
    </div>

    <!-- Reporter privacy badge + Apartment card & Messages links -->
    <div
      v-if="issue.reporter?.badge"
      data-testid="issue-board-reporter"
      class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-surface-container bg-surface-container-lowest p-4"
    >
      <div class="flex flex-wrap items-center gap-2.5">
        <span class="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          {{ session.t('issues.board.reporterLabel') }}:
        </span>
        <AuthorBadge
          :badge="issue.reporter.badge"
          :is-mine="Boolean(issue.i_reported)"
        />
      </div>

      <div
        v-if="issue.reporter.apartment_id"
        class="flex flex-wrap items-center gap-2"
      >
        <RouterLink
          :to="{ name: 'apartment-card', params: { apartmentId: issue.reporter.apartment_id } }"
          data-testid="issue-reporter-apartment-link"
          class="inline-flex items-center gap-1.5 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">apartment</span>
          {{ session.t('issues.board.openApartmentCard') }}
        </RouterLink>

        <RouterLink
          :to="{ name: 'messages' }"
          data-testid="issue-reporter-messages-link"
          class="inline-flex items-center gap-1.5 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">mail</span>
          {{ session.t('issues.board.writeToApartment') }}
        </RouterLink>
      </div>
      <span
        v-else
        class="text-xs text-on-surface-variant italic"
      >
        {{ session.t('issues.board.reporterNoApartment') }}
      </span>
    </div>

    <!-- Status transitions & Clear urgent action -->
    <div class="space-y-2.5">
      <p class="text-xs font-semibold uppercase tracking-wider text-on-surface">
        {{ session.t('issues.board.moveStatusLabel') }}
      </p>

      <div
        v-if="allowedBoardMoves.length > 0 || (isOpenStatus && issue.urgent)"
        class="flex flex-wrap items-center gap-2"
      >
        <button
          v-for="moveStatus in allowedBoardMoves"
          :key="moveStatus"
          type="button"
          :data-testid="`board-move-${isReopenMove && moveStatus === 'IN_PROGRESS' ? 'REOPEN' : moveStatus}`"
          :disabled="isBoardActionBusy"
          class="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-60"
          :class="
            moveStatus === 'RESOLVED'
              ? 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'
              : moveStatus === 'DECLINED'
                ? 'border-error/30 bg-surface-container-lowest text-error hover:bg-error-container/30'
                : 'border-surface-container-high bg-surface-container-lowest text-on-surface hover:bg-surface-container'
          "
          @click="handleClickBoardMove(moveStatus)"
        >
          <span class="material-symbols-outlined text-[16px]">
            {{ boardMoveButtonIcon(moveStatus) }}
          </span>
          <span>{{ boardMoveButtonLabel(moveStatus) }}</span>
        </button>

        <!-- Clear urgent ("Not urgent") button for urgent open issues -->
        <button
          v-if="isOpenStatus && issue.urgent"
          type="button"
          data-testid="board-clear-urgent-button"
          :disabled="isBoardActionBusy"
          class="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3.5 py-2 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-500/25 cursor-pointer disabled:opacity-60 transition-colors"
          @click="showClearUrgentModal = true"
        >
          <span class="material-symbols-outlined text-[16px]">notifications_off</span>
          <span>{{ session.t('issues.board.actions.CLEAR_URGENT') }}</span>
        </button>
      </div>

      <p
        v-else
        data-testid="board-no-moves-hint"
        class="text-xs text-on-surface-variant italic"
      >
        {{
          issue.status === 'WITHDRAWN'
            ? session.t('issues.board.withdrawnCannotMove')
            : session.t('issues.board.closedCannotMove')
        }}
      </p>
    </div>

    <!-- Board Standard Status Move / Reopen Confirmation Modal (#013) -->
    <Teleport to="body">
      <div
        v-if="pendingBoardMoveStatus"
        data-testid="board-move-confirm-modal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="pendingBoardMoveStatus = ''"
      >
        <div
          class="w-full max-w-md rounded-2xl border border-surface-container bg-surface-container-lowest p-5 shadow-xl space-y-4"
        >
          <h3 class="text-base font-bold text-on-surface">
            {{
              pendingBoardMoveStatus === 'REOPEN'
                ? session.t('issues.board.confirmReopenTitle')
                : session.t('issues.board.confirmMoveTitle', {
                    status: session.t(`issues.statuses.${pendingBoardMoveStatus}`),
                  })
            }}
          </h3>
          <p class="text-sm text-on-surface-variant">
            {{
              pendingBoardMoveStatus === 'REOPEN'
                ? session.t('issues.board.confirmReopenBody')
                : session.t('issues.board.confirmMoveBody', {
                    status: session.t(`issues.statuses.${pendingBoardMoveStatus}`),
                  })
            }}
          </p>
          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="pendingBoardMoveStatus = ''"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              data-testid="confirm-board-move-button"
              :disabled="isBoardActionBusy"
              class="rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleConfirmStandardMove"
            >
              {{
                pendingBoardMoveStatus === 'REOPEN'
                  ? session.t('issues.board.actions.REOPEN')
                  : session.t('issues.board.confirmButton')
              }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Board Decline Confirmation Modal (#013) -->
    <Teleport to="body">
      <div
        v-if="showDeclineModal && issue"
        data-testid="board-decline-modal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="showDeclineModal = false"
      >
        <div
          class="w-full max-w-md rounded-2xl border border-surface-container bg-surface-container-lowest p-5 shadow-xl space-y-4"
        >
          <h3 class="text-base font-bold text-on-surface">
            {{ session.t('issues.board.confirmDeclineTitle') }}
          </h3>
          <p class="text-sm text-on-surface-variant">
            {{ session.t('issues.board.confirmDeclineBody') }}
          </p>
          <p
            v-if="(issue?.photos?.length || 0) > 0"
            data-testid="decline-photos-warning"
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 flex items-center gap-2"
          >
            <span class="material-symbols-outlined text-[16px] text-amber-600 dark:text-amber-400 shrink-0">
              photo_library
            </span>
            <span>{{ session.t('issues.photos.confirmPhotosDeletedWarning') }}</span>
          </p>

          <!-- Suggestion to write to the apartment when the problem is inside a flat -->
          <div
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 space-y-2.5"
          >
            <p class="text-xs text-amber-900 dark:text-amber-200">
              {{ session.t('issues.board.declineWriteHint') }}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <RouterLink
                :to="{ name: 'messages' }"
                data-testid="decline-modal-messages-link"
                class="inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-secondary px-3 py-1.5 text-xs font-semibold text-on-secondary hover:opacity-90"
              >
                <span class="material-symbols-outlined text-[15px]">mail</span>
                {{ session.t('issues.board.writeToApartment') }}
              </RouterLink>
              <RouterLink
                v-if="issue.reporter?.apartment_id"
                :to="{ name: 'apartment-card', params: { apartmentId: issue.reporter.apartment_id } }"
                data-testid="decline-modal-apartment-link"
                class="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-surface-container-lowest px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-500/15"
              >
                <span class="material-symbols-outlined text-[15px]">apartment</span>
                {{ session.t('issues.board.openApartmentCard') }}
              </RouterLink>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="showDeclineModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              data-testid="confirm-decline-button"
              :disabled="isBoardActionBusy"
              class="rounded-xl bg-error px-3.5 py-2 text-xs font-semibold text-on-error hover:bg-error/90 cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleConfirmDecline"
            >
              {{ session.t('issues.board.confirmDeclineButton') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Board Clear Urgent Confirmation Modal (#013) -->
    <Teleport to="body">
      <div
        v-if="showClearUrgentModal && issue"
        data-testid="board-clear-urgent-modal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="showClearUrgentModal = false"
      >
        <div
          class="w-full max-w-md rounded-2xl border border-surface-container bg-surface-container-lowest p-5 shadow-xl space-y-4"
        >
          <h3 class="text-base font-bold text-on-surface">
            {{ session.t('issues.board.confirmClearUrgentTitle') }}
          </h3>
          <p class="text-sm text-on-surface-variant">
            {{ session.t('issues.board.confirmClearUrgentBody') }}
          </p>
          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="showClearUrgentModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              data-testid="confirm-clear-urgent-button"
              :disabled="isBoardActionBusy"
              class="rounded-[var(--radius-control)] bg-secondary px-3.5 py-2 text-xs font-semibold text-on-secondary hover:opacity-90 cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleConfirmClearUrgent"
            >
              {{ session.t('issues.board.confirmClearUrgentButton') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Board Duplicate Picker Modal (#013) -->
    <Teleport to="body">
      <div
        v-if="showDuplicateModal && issue"
        data-testid="duplicate-modal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="showDuplicateModal = false"
      >
        <div
          class="w-full max-w-lg rounded-2xl border border-surface-container bg-surface-container-lowest p-5 shadow-xl space-y-4 max-h-[90vh] flex flex-col"
        >
          <div>
            <h3 class="text-base font-bold text-on-surface">
              {{ session.t('issues.board.duplicateModalTitle') }}
            </h3>
            <p class="mt-1 text-xs text-on-surface-variant">
              {{ session.t('issues.board.duplicateModalSubtitle') }}
            </p>
            <p
              v-if="(issue?.photos?.length || 0) > 0"
              data-testid="duplicate-photos-warning"
              class="mt-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 flex items-center gap-2"
            >
              <span class="material-symbols-outlined text-[16px] text-amber-600 dark:text-amber-400 shrink-0">
                photo_library
              </span>
              <span>{{ session.t('issues.photos.confirmPhotosDeletedWarning') }}</span>
            </p>
          </div>

          <div
            v-if="duplicateModalError"
            class="rounded-xl border border-error/30 bg-error-container/30 p-3 text-xs text-on-error-container"
          >
            {{ duplicateModalError }}
          </div>

          <div>
            <label for="duplicate-search-input" class="sr-only">
              {{ session.t('issues.board.duplicateSearchPlaceholder') }}
            </label>
            <input
              id="duplicate-search-input"
              v-model="duplicateSearchQuery"
              type="search"
              data-testid="duplicate-search-input"
              :placeholder="session.t('issues.board.duplicateSearchPlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
            />
          </div>

          <!-- Candidate list -->
          <div class="overflow-y-auto max-h-64 space-y-2 pr-1">
            <div
              v-if="isLoadingDuplicates"
              class="py-6 text-center text-xs text-on-surface-variant"
            >
              {{ session.t('common.loading') }}
            </div>

            <div
              v-else-if="rankedDuplicateCandidates.length === 0"
              data-testid="duplicate-no-candidates"
              class="rounded-xl border border-dashed border-surface-container-high p-6 text-center text-xs text-on-surface-variant"
            >
              {{ session.t('issues.board.duplicateNoCandidates') }}
            </div>

            <label
              v-for="cand in rankedDuplicateCandidates"
              :key="cand.id"
              :data-testid="`duplicate-candidate-${cand.id}`"
              class="flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition"
              :class="
                selectedOriginalId === cand.id
                  ? 'border-primary bg-primary-container/15'
                  : 'border-surface-container hover:border-surface-container-high'
              "
            >
              <input
                v-model="selectedOriginalId"
                type="radio"
                name="duplicate-original"
                :value="cand.id"
                class="mt-1 h-4 w-4 accent-primary focus:ring-primary"
              />
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span
                    class="inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                    :class="statusBadgeClass(cand.status)"
                  >
                    {{ session.t(`issues.statuses.${cand.status}`) }}
                  </span>
                  <span
                    v-if="
                      isIssueOpen(cand.status) &&
                      cand.category === issue.category &&
                      (cand.entrance ?? null) === (issue.entrance ?? null)
                    "
                    class="inline-flex items-center rounded bg-primary-container/20 px-1.5 py-0.5 text-[11px] font-semibold text-primary"
                  >
                    {{ session.t('issues.board.duplicateRecommendedGroup', { count: 1 }) }}
                  </span>
                  <span class="text-[11px] text-on-surface-variant">
                    {{ session.t(`issues.categories.${cand.category}`) }} · {{ formatLocation(cand) }}
                  </span>
                </div>
                <p class="text-sm font-semibold text-on-surface truncate">
                  {{ cand.title }}
                </p>
                <p class="text-xs text-on-surface-variant">
                  {{ session.t('issues.followersCount', { count: cand.followers }) }}
                </p>
              </div>
            </label>
          </div>

          <div class="flex items-center justify-end gap-3 pt-2 border-t border-surface-container">
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="showDuplicateModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              data-testid="confirm-duplicate-button"
              :disabled="isBoardActionBusy || !selectedOriginalId"
              class="rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleConfirmDuplicate"
            >
              {{ session.t('issues.board.confirmDuplicateButton') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
