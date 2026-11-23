<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localizeError } from '@/locales/index.js'
import {
  getIssue,
  followIssue,
  unfollowIssue,
  withdrawIssue,
} from '@/api/endpoints/issues.js'
import {
  MAX_ISSUE_PHOTOS,
  isIssueOpen,
} from '@/utils/issues.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import IssuePhotos from '@/components/domain/IssuePhotos.vue'
import IssueFormModal from './components/IssueFormModal.vue'
import IssueBoardActions from './components/IssueBoardActions.vue'

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

const issueId = computed(() => String(route.params.issueId || ''))
const isOpenStatus = computed(() => Boolean(issue.value && isIssueOpen(issue.value.status)))
const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
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

function handleBoardUpdated(updated) {
  issue.value = updated
}

async function handleBoardConflictReload(message) {
  conflictNotice.value = message
  await loadDetail({ preserveNotices: true })
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
      <IssueBoardActions
        v-if="isBoardOrChairman"
        :issue="issue"
        :is-open-status="isOpenStatus"
        :status-badge-class="statusBadgeClass"
        :format-location="formatLocation"
        @updated="handleBoardUpdated"
        @action-error="actionError = $event; conflictNotice = ''"
        @conflict-reload="handleBoardConflictReload"
        @before-mutation="invalidateBackgroundRefreshes"
      />

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
  </div>
</template>
