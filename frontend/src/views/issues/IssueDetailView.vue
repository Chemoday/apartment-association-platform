<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localizeError } from '@/locales/index.js'
import {
  getIssue,
  listIssues,
  followIssue,
  unfollowIssue,
  withdrawIssue,
  changeIssueStatus,
  clearIssueUrgent,
} from '@/api/endpoints/issues.js'
import {
  MAX_ISSUE_PHOTOS,
  isIssueOpen,
  getAllowedBoardMoves,
  canBoardReopenIssue,
  rankDuplicateCandidates,
} from '@/utils/issues.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import IssuePhotos from '@/components/domain/IssuePhotos.vue'
import IssueFormModal from './components/IssueFormModal.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const issue = ref(null)
const isLoading = ref(true)
const notFound = ref(false)
const loadError = ref(null)
const actionError = ref('')
const conflictNotice = ref('')

const isFollowBusy = ref(false)
const isWithdrawing = ref(false)
const showEditModal = ref(false)
const showWithdrawConfirm = ref(false)

// Board actions (#013)
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

const issueId = computed(() => String(route.params.issueId || ''))
const isOpenStatus = computed(() => Boolean(issue.value && isIssueOpen(issue.value.status)))
const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const allowedBoardMoves = computed(() =>
  isBoardOrChairman.value && issue.value ? getAllowedBoardMoves(issue.value) : [],
)

const isReopenMove = computed(() =>
  Boolean(
    isBoardOrChairman.value &&
      issue.value &&
      !isIssueOpen(issue.value.status) &&
      canBoardReopenIssue(issue.value),
  ),
)

const rankedDuplicateCandidates = computed(() =>
  issue.value
    ? rankDuplicateCandidates(
        duplicateCandidatesRaw.value,
        issue.value,
        duplicateSearchQuery.value,
      )
    : [],
)

function statusBadgeClass(status) {
  if (status === 'REPORTED') {
    return 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800'
  }
  if (status === 'IN_PROGRESS' || status === 'WAITING_FOR_CONTRACTOR') {
    return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800'
  }
  if (status === 'RESOLVED') {
    return 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
  }
  return 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
}

function formatLocation(item) {
  if (!item) return ''
  const base =
    item.entrance === null || item.entrance === undefined
      ? session.t('issues.locationOutside')
      : session.t('issues.locationEntrance', { n: item.entrance })
  return item.place ? `${base} · ${item.place}` : base
}

function formatDateTime(isoStr) {
  if (!isoStr) return ''
  try {
    return new Intl.DateTimeFormat(session.lang || 'en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Tallinn',
    }).format(new Date(isoStr))
  } catch {
    return isoStr.replace('T', ' ').slice(0, 16)
  }
}

let detailLoadSeq = 0
let detailRefreshSeq = 0
let detailAbortController = null

function abortDetailFetch() {
  detailRefreshSeq += 1
  if (detailAbortController) {
    try {
      detailAbortController.abort()
    } catch {
      /* ignore */
    }
    detailAbortController = null
  }
}

onBeforeUnmount(() => {
  abortDetailFetch()
})

async function loadDetail({ preserveNotices = false } = {}) {
  const requestedId = issueId.value
  if (!requestedId) return
  const seq = ++detailLoadSeq
  const startActingUserId = session.actingUserId
  abortDetailFetch()
  detailAbortController = new AbortController()
  const signal = detailAbortController.signal

  isLoading.value = true
  notFound.value = false
  loadError.value = null
  if (!preserveNotices) {
    actionError.value = ''
    conflictNotice.value = ''
  }

  try {
    const loaded = await getIssue(requestedId, { signal })
    if (
      seq !== detailLoadSeq ||
      issueId.value !== requestedId ||
      session.actingUserId !== startActingUserId
    ) {
      return
    }
    issue.value = loaded
  } catch (err) {
    if (seq !== detailLoadSeq || err?.errorCode === 'REQUEST_ABORTED') return
    if (err?.status === 404 || err?.errorCode === 'ISSUE_NOT_FOUND') {
      notFound.value = true
      issue.value = null
    } else {
      loadError.value = err
    }
  } finally {
    if (seq === detailLoadSeq) {
      isLoading.value = false
    }
  }
}

async function refreshIssueQuietly() {
  const requestedId = issue.value?.id
  if (!requestedId) return
  if (!detailAbortController || detailAbortController.signal.aborted) {
    detailAbortController = new AbortController()
  }
  const signal = detailAbortController.signal
  const seq = ++detailRefreshSeq
  const expectedLoadSeq = detailLoadSeq
  const startActingUserId = session.actingUserId
  try {
    const refreshed = await getIssue(requestedId, { signal })
    if (
      signal.aborted ||
      seq !== detailRefreshSeq ||
      expectedLoadSeq !== detailLoadSeq ||
      session.actingUserId !== startActingUserId ||
      issue.value?.id !== requestedId
    ) {
      return
    }
    issue.value = refreshed
  } catch {
    // Keep existing issue view if background refresh fails or is aborted
  }
}

function handlePhotoUploaded(photo) {
  if (!issue.value || !photo?.id) {
    refreshIssueQuietly()
    return
  }
  const existing = issue.value.photos || []
  const nextPhotos = existing.some((p) => p.id === photo.id) ? existing : [...existing, photo]
  issue.value = {
    ...issue.value,
    photos: nextPhotos,
    can_add_photo:
      nextPhotos.length < MAX_ISSUE_PHOTOS ? Boolean(issue.value.can_add_photo) : false,
  }
  refreshIssueQuietly()
}

function handlePhotoDeleted(photoId) {
  if (!issue.value) return
  const nextPhotos = (issue.value.photos || []).filter((p) => p.id !== photoId)
  issue.value = {
    ...issue.value,
    photos: nextPhotos,
    photos_delete_at: nextPhotos.length > 0 ? issue.value.photos_delete_at : null,
  }
  refreshIssueQuietly()
}

function handlePhotoGone(photoId) {
  if (!issue.value) return
  const nextPhotos = (issue.value.photos || []).filter((p) => p.id !== photoId)
  issue.value = {
    ...issue.value,
    photos: nextPhotos,
    photos_delete_at: nextPhotos.length > 0 ? issue.value.photos_delete_at : null,
  }
}

function invalidateBackgroundRefreshes() {
  detailRefreshSeq += 1
}

async function handleToggleFollow(shouldFollow) {
  if (!issue.value || isFollowBusy.value) return
  isFollowBusy.value = true
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  try {
    const updated = shouldFollow
      ? await followIssue(issue.value.id)
      : await unfollowIssue(issue.value.id)
    invalidateBackgroundRefreshes()
    issue.value = updated
  } catch (err) {
    actionError.value = localizeError(err, session.lang)
  } finally {
    isFollowBusy.value = false
  }
}

async function handleConfirmWithdraw() {
  if (!issue.value || isWithdrawing.value) return
  isWithdrawing.value = true
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  try {
    const updated = await withdrawIssue(issue.value.id)
    invalidateBackgroundRefreshes()
    issue.value = updated
    showWithdrawConfirm.value = false
  } catch (err) {
    actionError.value = localizeError(err, session.lang)
    showWithdrawConfirm.value = false
  } finally {
    isWithdrawing.value = false
  }
}

function handleEdited(updated) {
  showEditModal.value = false
  invalidateBackgroundRefreshes()
  if (updated) {
    issue.value = updated
  } else {
    loadDetail()
  }
}

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
  actionError.value = ''
  conflictNotice.value = ''
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
  if (!issue.value) return
  duplicateSearchQuery.value = ''
  selectedOriginalId.value = ''
  duplicateModalError.value = ''
  showDuplicateModal.value = true
  isLoadingDuplicates.value = true
  try {
    const items = await listIssues()
    duplicateCandidatesRaw.value = Array.isArray(items) ? items : []
    const ranked = rankDuplicateCandidates(duplicateCandidatesRaw.value, issue.value, '')
    if (ranked.length > 0) {
      selectedOriginalId.value = ranked[0].id
    }
  } catch (err) {
    duplicateModalError.value = localizeError(err, session.lang)
  } finally {
    isLoadingDuplicates.value = false
  }
}

async function handleBoardTransitionError(err) {
  if (err?.status === 409 && err?.errorCode === 'INVALID_ISSUE_TRANSITION') {
    conflictNotice.value = session.t('issues.board.transitionConflictReloaded')
    await loadDetail({ preserveNotices: true })
  } else {
    actionError.value = localizeError(err, session.lang)
  }
}

async function handleConfirmStandardMove() {
  if (!issue.value || !pendingBoardMoveStatus.value || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  const targetStatus =
    pendingBoardMoveStatus.value === 'REOPEN' ? 'IN_PROGRESS' : pendingBoardMoveStatus.value
  try {
    const updated = await changeIssueStatus(issue.value.id, { status: targetStatus })
    invalidateBackgroundRefreshes()
    issue.value = updated
    pendingBoardMoveStatus.value = ''
  } catch (err) {
    pendingBoardMoveStatus.value = ''
    await handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmDecline() {
  if (!issue.value || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  try {
    const updated = await changeIssueStatus(issue.value.id, { status: 'DECLINED' })
    invalidateBackgroundRefreshes()
    issue.value = updated
    showDeclineModal.value = false
  } catch (err) {
    showDeclineModal.value = false
    await handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmDuplicate() {
  if (!issue.value || isBoardActionBusy.value) return
  if (!selectedOriginalId.value) {
    duplicateModalError.value = session.t('issues.board.duplicateNoCandidates')
    return
  }
  isBoardActionBusy.value = true
  duplicateModalError.value = ''
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  try {
    const updated = await changeIssueStatus(issue.value.id, {
      status: 'DUPLICATE',
      duplicate_of: selectedOriginalId.value,
    })
    invalidateBackgroundRefreshes()
    issue.value = updated
    showDuplicateModal.value = false
  } catch (err) {
    if (err?.status === 409 && err?.errorCode === 'INVALID_ISSUE_TRANSITION') {
      showDuplicateModal.value = false
      await handleBoardTransitionError(err)
    } else {
      duplicateModalError.value = localizeError(err, session.lang)
    }
  } finally {
    isBoardActionBusy.value = false
  }
}

async function handleConfirmClearUrgent() {
  if (!issue.value || isBoardActionBusy.value) return
  isBoardActionBusy.value = true
  actionError.value = ''
  conflictNotice.value = ''
  invalidateBackgroundRefreshes()
  try {
    const updated = await clearIssueUrgent(issue.value.id)
    invalidateBackgroundRefreshes()
    issue.value = updated
    showClearUrgentModal.value = false
  } catch (err) {
    showClearUrgentModal.value = false
    await handleBoardTransitionError(err)
  } finally {
    isBoardActionBusy.value = false
  }
}

watch(issueId, () => {
  loadDetail()
})

watch(
  () => session.actingUserId,
  () => {
    loadDetail()
  },
)

onMounted(() => {
  loadDetail()
})
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-gutter py-space-lg space-y-6">
    <!-- Back navigation -->
    <div>
      <RouterLink
        :to="{ name: 'issues' }"
        class="inline-flex items-center gap-1.5 text-sm font-semibold text-on-surface-variant hover:text-primary transition-colors"
      >
        <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        {{ session.t('issues.backToList') }}
      </RouterLink>
    </div>

    <!-- Loading state -->
    <div
      v-if="isLoading"
      class="rounded-2xl border border-surface-container bg-surface-container-lowest p-8 text-center text-sm text-on-surface-variant"
    >
      {{ session.t('common.loading') }}
    </div>

    <!-- 404 ISSUE_NOT_FOUND: "This issue is not available" -->
    <div
      v-else-if="notFound"
      data-testid="issue-not-available"
      class="rounded-2xl border border-dashed border-surface-container-high bg-surface-container-lowest p-10 text-center"
    >
      <span class="material-symbols-outlined text-3xl text-on-surface-variant">
        search_off
      </span>
      <h1 class="mt-2 text-base font-semibold text-on-surface">
        {{ session.t('issues.notAvailableTitle') }}
      </h1>
      <p class="mt-1 text-sm text-on-surface-variant">
        {{ session.t('issues.notAvailableBody') }}
      </p>
      <div class="mt-4">
        <button
          type="button"
          class="rounded-xl border border-surface-container-high bg-surface-container-low px-4 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
          @click="router.push({ name: 'issues' })"
        >
          {{ session.t('issues.backToList') }}
        </button>
      </div>
    </div>

    <!-- Other errors -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="loadDetail"
    />

    <!-- Issue Detail Content -->
    <template v-else-if="issue">
      <!-- 409 INVALID_ISSUE_TRANSITION reload notice -->
      <div
        v-if="conflictNotice"
        data-testid="issue-conflict-notice"
        class="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm text-amber-900 dark:text-amber-200"
      >
        <span class="material-symbols-outlined text-[18px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
          sync_problem
        </span>
        <span>{{ conflictNotice }}</span>
      </div>

      <!-- Action error banner -->
      <div
        v-if="actionError"
        data-testid="issue-action-error"
        class="rounded-xl border border-error/30 bg-error-container/30 p-3.5 text-sm text-on-error-container"
      >
        {{ actionError }}
      </div>

      <!-- Duplicate notice banner when duplicate_of is set -->
      <div
        v-if="issue.status === 'DUPLICATE' && issue.duplicate_of"
        data-testid="issue-duplicate-banner"
        class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
      >
        <div class="flex items-start gap-3">
          <span
            class="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
          >
            content_copy
          </span>
          <div>
            <p class="text-sm font-semibold text-amber-950 dark:text-amber-100">
              {{ session.t('issues.detail.duplicateBannerTitle') }}
            </p>
            <p class="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              {{ session.t('issues.detail.duplicateBannerBody') }}
            </p>
          </div>
        </div>

        <RouterLink
          :to="{ name: 'issue-detail', params: { issueId: issue.duplicate_of } }"
          data-testid="issue-duplicate-link"
          class="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-700 shrink-0"
        >
          {{ session.t('issues.detail.viewOriginalIssue') }}
          <span class="material-symbols-outlined text-[16px]">open_in_new</span>
        </RouterLink>
      </div>

      <!-- Main Issue Card -->
      <section
        class="rounded-2xl border border-surface-container bg-surface-container-lowest p-5 sm:p-6 space-y-5"
      >
        <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div class="space-y-2 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span
                data-testid="issue-detail-status-badge"
                class="inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold"
                :class="statusBadgeClass(issue.status)"
              >
                {{ session.t(`issues.statuses.${issue.status}`) }}
              </span>
              <span
                v-if="issue.urgent"
                data-testid="issue-detail-urgent-badge"
                class="inline-flex items-center gap-1 rounded-md bg-error-container px-2.5 py-0.5 text-xs font-bold text-on-error-container"
              >
                <span class="material-symbols-outlined text-[15px]">priority_high</span>
                {{ session.t('issues.urgentBadge') }}
              </span>
              <span
                class="text-xs font-semibold uppercase tracking-wider text-primary"
              >
                {{ session.t(`issues.categories.${issue.category}`) }}
              </span>
              <span class="text-xs text-on-surface-variant">·</span>
              <span class="text-xs font-medium text-on-surface-variant">
                {{ formatLocation(issue) }}
              </span>
            </div>

            <h1
              data-testid="issue-detail-title"
              class="font-headline-md text-xl sm:text-2xl font-bold text-on-surface"
            >
              {{ issue.title }}
            </h1>

            <div
              class="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant"
            >
              <span>{{
                session.t('issues.reportedOn', { date: formatDateTime(issue.created_at) })
              }}</span>
              <template v-if="issue.i_reported">
                <span>·</span>
                <span class="font-semibold text-primary">
                  {{ session.t('issues.reportedByYou') }}
                </span>
              </template>
            </div>
          </div>

          <!-- Reporter actions while status is REPORTED (can_edit === true) -->
          <div
            v-if="issue.can_edit"
            data-testid="issue-reporter-actions"
            class="flex flex-wrap items-center gap-2 shrink-0"
          >
            <button
              type="button"
              data-testid="issue-edit-button"
              class="inline-flex items-center gap-1 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="showEditModal = true"
            >
              <span class="material-symbols-outlined text-[16px]">edit</span>
              <span>{{ session.t('issues.detail.editButton') }}</span>
            </button>
            <button
              type="button"
              data-testid="issue-withdraw-button"
              class="inline-flex items-center gap-1 rounded-lg border border-error/30 bg-error-container/20 px-3 py-1.5 text-xs font-semibold text-error hover:bg-error-container/40 cursor-pointer transition-colors"
              @click="showWithdrawConfirm = true"
            >
              <span class="material-symbols-outlined text-[16px]">cancel</span>
              <span>{{ session.t('issues.detail.withdrawButton') }}</span>
            </button>
          </div>
        </div>

        <!-- Lifecycle Progress Pipeline -->
        <div
          data-testid="issue-lifecycle-pipeline"
          class="rounded-xl border border-surface-container bg-surface-container-low/70 p-4"
        >
          <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant mb-3">
            <span class="inline-flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[16px] text-primary">timeline</span>
              <span>{{ session.t('issues.detail.lifecycleTitle') }}</span>
            </span>
            <span class="font-normal">{{ session.t(`issues.statuses.${issue.status}`) }}</span>
          </div>

          <!-- Terminal state: DECLINED, DUPLICATE, WITHDRAWN -->
          <div
            v-if="['DECLINED', 'DUPLICATE', 'WITHDRAWN'].includes(issue.status)"
            class="flex items-center gap-3 p-3 rounded-lg bg-surface-container text-xs"
          >
            <span class="material-symbols-outlined text-[20px] text-on-surface-variant">
              {{ issue.status === 'DUPLICATE' ? 'content_copy' : issue.status === 'WITHDRAWN' ? 'undo' : 'block' }}
            </span>
            <div>
              <span class="font-semibold text-on-surface">{{ session.t(`issues.statuses.${issue.status}`) }}</span>
              <span v-if="issue.ended_at" class="text-on-surface-variant ml-2">({{ formatDateTime(issue.ended_at) }})</span>
            </div>
          </div>

          <!-- Standard progression: Reported -> In Progress / Waiting -> Resolved -->
          <div v-else class="grid grid-cols-3 gap-2 relative pt-1">
            <!-- Step 1: Reported -->
            <div class="flex flex-col items-center sm:items-start text-center sm:text-left gap-1">
              <div class="flex items-center w-full">
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shrink-0"
                  :class="
                    ['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR', 'RESOLVED'].includes(issue.status)
                      ? 'bg-emerald-600 text-white'
                      : 'bg-primary text-on-primary ring-4 ring-primary/20'
                  "
                >
                  <span v-if="['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR', 'RESOLVED'].includes(issue.status)" class="material-symbols-outlined text-[16px]">check</span>
                  <span v-else>1</span>
                </div>
                <div
                  class="hidden sm:block flex-1 h-0.5 ml-2 mr-2 rounded"
                  :class="['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR', 'RESOLVED'].includes(issue.status) ? 'bg-emerald-600' : 'bg-surface-container-high'"
                ></div>
              </div>
              <span class="text-xs font-semibold mt-1 text-on-surface">
                {{ session.t('issues.detail.lifecycleReported') }}
              </span>
            </div>

            <!-- Step 2: In Progress / Waiting -->
            <div class="flex flex-col items-center sm:items-start text-center sm:text-left gap-1">
              <div class="flex items-center w-full">
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shrink-0"
                  :class="
                    issue.status === 'RESOLVED'
                      ? 'bg-emerald-600 text-white'
                      : ['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR'].includes(issue.status)
                        ? 'bg-amber-500 text-white ring-4 ring-amber-500/20'
                        : 'bg-surface-container-high text-on-surface-variant'
                  "
                >
                  <span v-if="issue.status === 'RESOLVED'" class="material-symbols-outlined text-[16px]">check</span>
                  <span v-else-if="['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR'].includes(issue.status)" class="material-symbols-outlined text-[16px]">handyman</span>
                  <span v-else>2</span>
                </div>
                <div
                  class="hidden sm:block flex-1 h-0.5 ml-2 mr-2 rounded"
                  :class="issue.status === 'RESOLVED' ? 'bg-emerald-600' : 'bg-surface-container-high'"
                ></div>
              </div>
              <span
                class="text-xs font-semibold mt-1"
                :class="['IN_PROGRESS', 'WAITING_FOR_CONTRACTOR', 'RESOLVED'].includes(issue.status) ? 'text-on-surface' : 'text-on-surface-variant'"
              >
                {{ issue.status === 'WAITING_FOR_CONTRACTOR' ? session.t('issues.statuses.WAITING_FOR_CONTRACTOR') : session.t('issues.detail.lifecycleInProgress') }}
              </span>
            </div>

            <!-- Step 3: Resolved -->
            <div class="flex flex-col items-center sm:items-start text-center sm:text-left gap-1">
              <div class="flex items-center w-full">
                <div
                  class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all shrink-0"
                  :class="
                    issue.status === 'RESOLVED'
                      ? 'bg-emerald-600 text-white ring-4 ring-emerald-600/20'
                      : 'bg-surface-container-high text-on-surface-variant'
                  "
                >
                  <span v-if="issue.status === 'RESOLVED'" class="material-symbols-outlined text-[16px]">check</span>
                  <span v-else>3</span>
                </div>
              </div>
              <span
                class="text-xs font-semibold mt-1"
                :class="issue.status === 'RESOLVED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-on-surface-variant'"
              >
                {{ session.t('issues.detail.lifecycleResolved') }}
              </span>
            </div>
          </div>
        </div>

        <!-- Description -->
        <div
          class="rounded-xl border border-surface-container bg-surface-container-low/60 p-4 text-sm text-on-surface whitespace-pre-line"
        >
          <p v-if="issue.description" data-testid="issue-detail-description">
            {{ issue.description }}
          </p>
          <p v-else class="italic text-on-surface-variant">
            {{ session.t('issues.detail.noDescription') }}
          </p>
        </div>

        <!-- Follow ("+1 / I see it too") & Followers bar -->
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-3 border-t border-surface-container"
        >
          <div class="flex items-center gap-2.5">
            <div
              class="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant"
            >
              <span class="material-symbols-outlined text-[18px]">group</span>
            </div>
            <div>
              <p
                data-testid="issue-detail-followers"
                class="text-sm font-semibold text-on-surface"
              >
                {{ session.t('issues.followersCount', { count: issue.followers }) }}
              </p>
              <p class="text-xs text-on-surface-variant">
                {{ session.t('issues.detail.followersPrivacyHint') }}
              </p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <!-- Can follow ("+1 / I see it too") -->
            <button
              v-if="issue.can_follow"
              type="button"
              data-testid="issue-detail-follow-button"
              :disabled="isFollowBusy"
              class="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleToggleFollow(true)"
            >
              <span class="material-symbols-outlined text-[16px]">thumb_up</span>
              <span>{{ session.t('issues.followAction') }}</span>
            </button>

            <!-- Already following -->
            <template v-else-if="issue.i_follow">
              <span
                data-testid="issue-detail-following-label"
                class="inline-flex items-center gap-1.5 rounded-lg bg-primary-container/20 px-3 py-1.5 text-xs font-semibold text-primary"
              >
                <span class="material-symbols-outlined text-[16px]">check_circle</span>
                {{ session.t('issues.detail.youFollowThisIssue') }}
              </span>

              <button
                v-if="isOpenStatus"
                type="button"
                data-testid="issue-detail-unfollow-button"
                :disabled="isFollowBusy"
                class="inline-flex items-center gap-1 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-60 transition-colors"
                @click="handleToggleFollow(false)"
              >
                {{ session.t('issues.detail.stopFollowing') }}
              </button>
            </template>
          </div>
        </div>
      </section>

      <!-- Photos Section (#020 / #021) -->
      <IssuePhotos
        :issue-id="issue.id"
        :photos="issue.photos || []"
        :can-add-photo="Boolean(issue.can_add_photo)"
        :issue-open="isOpenStatus"
        :photos-delete-at="issue.photos_delete_at || null"
        @uploaded="handlePhotoUploaded"
        @deleted="handlePhotoDeleted"
        @photo-gone="handlePhotoGone"
        @sync-needed="refreshIssueQuietly"
      />

      <!-- Board Panel (#013): visible only to CHAIRMAN and BOARD -->
      <section
        v-if="isBoardOrChairman"
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
      </section>

      <!-- Status Timeline / Action Log Card -->
      <section
        class="rounded-2xl border border-surface-container bg-surface-container-lowest p-5 sm:p-6 space-y-4"
      >
        <div>
          <h2
            class="text-sm font-bold uppercase tracking-wider text-on-surface-variant"
          >
            {{
              isBoardOrChairman
                ? session.t('issues.board.actionLogTitle')
                : session.t('issues.detail.timelineTitle')
            }}
          </h2>
          <p
            v-if="isBoardOrChairman"
            class="mt-0.5 text-xs text-on-surface-variant"
          >
            {{ session.t('issues.board.actionLogSubtitle') }}
          </p>
        </div>

        <ol
          data-testid="issue-status-timeline"
          class="relative border-s border-surface-container-high ms-3 space-y-5"
        >
          <li
            v-for="(entry, idx) in issue.timeline"
            :key="`${entry.action}-${entry.status}-${entry.at}-${idx}`"
            class="ms-5"
          >
            <span
              class="absolute -start-2.5 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-surface-container-lowest"
              :class="
                idx === issue.timeline.length - 1
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-high text-on-surface-variant'
              "
            />
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
              <div class="flex flex-wrap items-center gap-2.5">
                <span
                  class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold"
                  :class="statusBadgeClass(entry.status)"
                >
                  {{
                    entry.action === 'URGENT_CLEARED'
                      ? session.t('issues.detail.urgentClearedAction')
                      : session.t(`issues.statuses.${entry.status}`)
                  }}
                </span>

                <AuthorBadge
                  v-if="isBoardOrChairman && entry.changed_by"
                  :badge="entry.changed_by"
                />
              </div>
              <time class="text-xs text-on-surface-variant">
                {{ formatDateTime(entry.at) }}
              </time>
            </div>
          </li>
        </ol>
      </section>
    </template>

    <!-- Edit Issue Modal -->
    <IssueFormModal
      v-if="issue"
      :open="showEditModal"
      mode="edit"
      :issue="issue"
      @close="showEditModal = false"
      @saved="handleEdited"
    />

    <!-- Withdraw Confirmation Modal -->
    <Teleport to="body">
      <div
        v-if="showWithdrawConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="showWithdrawConfirm = false"
      >
        <div
          class="w-full max-w-md rounded-2xl border border-surface-container bg-surface-container-lowest p-5 shadow-xl space-y-4"
        >
          <h3 class="text-base font-bold text-on-surface">
            {{ session.t('issues.detail.withdrawConfirmTitle') }}
          </h3>
          <p class="text-sm text-on-surface-variant">
            {{ session.t('issues.detail.withdrawConfirmBody') }}
          </p>
          <p
            v-if="(issue?.photos?.length || 0) > 0"
            data-testid="withdraw-photos-warning"
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 flex items-center gap-2"
          >
            <span class="material-symbols-outlined text-[16px] text-amber-600 dark:text-amber-400 shrink-0">
              photo_library
            </span>
            <span>{{ session.t('issues.photos.confirmPhotosDeletedWarning') }}</span>
          </p>
          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="showWithdrawConfirm = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              data-testid="confirm-withdraw-button"
              :disabled="isWithdrawing"
              class="rounded-xl bg-error px-3.5 py-2 text-xs font-semibold text-on-error hover:bg-error/90 cursor-pointer disabled:opacity-60 transition-colors"
              @click="handleConfirmWithdraw"
            >
              {{ session.t('issues.detail.withdrawButton') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

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
                class="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
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
              class="rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-700 cursor-pointer disabled:opacity-60 transition-colors"
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
  </div>
</template>
