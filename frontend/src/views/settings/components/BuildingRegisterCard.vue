<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  acceptRegistry,
  getRegistryState,
  proposeRegistry,
  removeRegistry,
  searchRegistry,
} from '@/api/endpoints/property.js'
import { localizeError } from '@/locales/index.js'
import { formatDateTime } from '@/utils/dates.js'
import {
  isSupportedBuildingFacts,
  normalizeRegistrySearchQuery,
  validateRegistrySearchQuery,
} from '@/utils/buildingPassport.js'
import EeBuildingFacts from '@/views/building/countries/EeBuildingFacts.vue'
import BaseModal from '@/components/base/BaseModal.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const session = useSessionStore()
const { isChairman, canViewAssociationSettings } = useRole()

const sectionRef = ref(null)
const registryState = ref(null)
const notEnabled = ref(false)
const loadError = ref(null)

const searchQuery = ref('')
const searchValidationKey = ref('')
const candidates = ref([])
const hasSearched = ref(false)

const busyAction = ref('')
const activeCandidateCode = ref('')
const actionError = ref(null)
const actionSuccessKey = ref('')
const confirmRemoveOpen = ref(false)
const quotaBlockedUntilMs = ref(0)

let stateSeq = 0
let actionSeq = 0
let loadAbortController = null
let actionAbortController = null
let quotaResetTimer = null

const MAX_TIMEOUT_MS = 2_147_483_647

const isBusy = computed(() => busyAction.value !== '')
const isQuotaBlocked = computed(() => quotaBlockedUntilMs.value > 0)
const isVisible = computed(() => canViewAssociationSettings.value && !notEnabled.value)

const searchValidationError = computed(() =>
  searchValidationKey.value ? session.t(`associationSettings.registry.${searchValidationKey.value}`) : '',
)
const actionErrorBanner = computed(() =>
  actionError.value ? localizeError(actionError.value, {}, session.lang) : '',
)
const effectiveErrorBanner = computed(() => {
  if (actionErrorBanner.value) return actionErrorBanner.value
  if (isChairman.value && isQuotaBlocked.value) {
    return session.t('errors.REGISTRY_RATE_LIMITED')
  }
  return ''
})
const secondaryQuotaBanner = computed(() => {
  if (!isChairman.value || !isQuotaBlocked.value) return ''
  if (!actionErrorBanner.value || actionError.value?.errorCode === 'REGISTRY_RATE_LIMITED') {
    return ''
  }
  return session.t('errors.REGISTRY_RATE_LIMITED')
})
const actionSuccessBanner = computed(() =>
  actionSuccessKey.value ? session.t(`associationSettings.registry.${actionSuccessKey.value}`) : '',
)

const acceptedFacts = computed(() => registryState.value?.accepted || null)
const proposalFacts = computed(() => registryState.value?.proposal || null)
const isSupportedAccepted = computed(() => isSupportedBuildingFacts(acceptedFacts.value))
const isSupportedProposal = computed(() => isSupportedBuildingFacts(proposalFacts.value))
const proposalBuildingCode = computed(() => {
  const raw = proposalFacts.value?.source?.building_code
  return typeof raw === 'string' ? raw.trim() : ''
})

function isAbortErr(err) {
  return err?.name === 'AbortError' || err?.errorCode === 'REQUEST_ABORTED'
}

function isDailyQuotaErr(err) {
  const is429 =
    err?.status === 429 ||
    err?.errorCode === 'RATE_LIMITED' ||
    err?.errorCode === 'REGISTRY_RATE_LIMITED' ||
    err?.payload?.error_code === 'RATE_LIMITED'
  if (!is429) return false
  const reason = err?.payload?.reason
  return reason === undefined || reason === null || reason === '' || reason === 'DAILY_LIMIT'
}

function clearQuotaTimer() {
  if (quotaResetTimer !== null) {
    clearTimeout(quotaResetTimer)
    quotaResetTimer = null
  }
}

function secondsUntilUtcMidnight(nowMs = Date.now()) {
  const now = new Date(nowMs)
  const nextMidnightMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  )
  return Math.max(1, Math.ceil((nextMidnightMs - nowMs) / 1000))
}

function scheduleQuotaReset(remainingMs) {
  clearQuotaTimer()
  if (remainingMs <= 0) {
    quotaBlockedUntilMs.value = 0
    return
  }
  const chunkMs = Math.min(remainingMs, MAX_TIMEOUT_MS)
  quotaResetTimer = setTimeout(() => {
    quotaResetTimer = null
    const left = quotaBlockedUntilMs.value - Date.now()
    if (left <= 0) {
      quotaBlockedUntilMs.value = 0
      if (actionError.value?.errorCode === 'REGISTRY_RATE_LIMITED') {
        actionError.value = null
      }
    } else {
      scheduleQuotaReset(left)
    }
  }, chunkMs)
}

function applyQuotaCooldown(err) {
  const rawRetry = Number(err?.payload?.retry_after_seconds)
  const nowMs = Date.now()
  const retrySeconds =
    Number.isFinite(rawRetry) && rawRetry > 0
      ? Math.ceil(rawRetry)
      : secondsUntilUtcMidnight(nowMs)
  const delayMs = retrySeconds * 1000
  quotaBlockedUntilMs.value = nowMs + delayMs
  scheduleQuotaReset(delayMs)
}

function normalizeRegistryError(err, { allowDailyQuota = false } = {}) {
  if (allowDailyQuota && isDailyQuotaErr(err)) {
    return {
      ...err,
      errorCode: 'REGISTRY_RATE_LIMITED',
      status: 429,
      payload: {
        ...(err?.payload || {}),
        error_code: 'REGISTRY_RATE_LIMITED',
      },
      traceId: err?.traceId || null,
    }
  }
  if (
    err?.status === 503 &&
    (!err?.errorCode || err.errorCode === 'HTTP_503' || err.errorCode === 'BACKEND_UNAVAILABLE')
  ) {
    return {
      errorCode: 'REGISTRY_UNAVAILABLE',
      status: 503,
      traceId: err?.traceId || null,
    }
  }
  return err
}

function scrollToRegisterHashIfNeeded() {
  if (route.hash === '#building-register' && isVisible.value) {
    nextTick(() => {
      sectionRef.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    })
  }
}

function abortActiveRequests() {
  if (loadAbortController) {
    loadAbortController.abort()
    loadAbortController = null
  }
  if (actionAbortController) {
    actionAbortController.abort()
    actionAbortController = null
  }
}

function clearChairmanDraftUi() {
  confirmRemoveOpen.value = false
  candidates.value = []
  hasSearched.value = false
  searchValidationKey.value = ''
  activeCandidateCode.value = ''
}

function resetLocalUiForRoleOrUserChange() {
  ++stateSeq
  ++actionSeq
  abortActiveRequests()
  clearQuotaTimer()
  quotaBlockedUntilMs.value = 0
  registryState.value = null
  notEnabled.value = false
  loadError.value = null
  searchQuery.value = ''
  searchValidationKey.value = ''
  candidates.value = []
  hasSearched.value = false
  busyAction.value = ''
  activeCandidateCode.value = ''
  actionError.value = null
  actionSuccessKey.value = ''
  confirmRemoveOpen.value = false
}

async function fetchRegistryState({ preserveBanner = false } = {}) {
  if (loadAbortController) {
    loadAbortController.abort()
    loadAbortController = null
  }
  if (!canViewAssociationSettings.value) {
    resetLocalUiForRoleOrUserChange()
    return
  }

  const seq = ++stateSeq
  const expectedUserId = session.activeUserId
  const controller = new AbortController()
  loadAbortController = controller
  if (!preserveBanner) {
    busyAction.value = 'loading'
  }
  loadError.value = null

  try {
    const res = await getRegistryState({ signal: controller.signal })
    if (seq !== stateSeq || session.activeUserId !== expectedUserId || !canViewAssociationSettings.value) {
      return
    }
    notEnabled.value = false
    registryState.value = res
    scrollToRegisterHashIfNeeded()
  } catch (err) {
    if (seq !== stateSeq || session.activeUserId !== expectedUserId || isAbortErr(err)) {
      return
    }
    if (err?.errorCode === 'REGISTRY_NOT_ENABLED' || err?.status === 404) {
      notEnabled.value = true
      registryState.value = null
      loadError.value = null
      return
    }
    if (err?.status === 403 || err?.errorCode === 'FORBIDDEN') {
      registryState.value = null
      loadError.value = err
      return
    }
    const normalizedErr = normalizeRegistryError(err)
    if (registryState.value) {
      // Preserve screen state on transient reload errors (e.g. 503)
      actionError.value = normalizedErr
    } else {
      loadError.value = normalizedErr
    }
  } finally {
    if (seq === stateSeq) {
      if (busyAction.value === 'loading') {
        busyAction.value = ''
      }
      if (loadAbortController === controller) {
        loadAbortController = null
      }
    }
  }
}

async function handleSearch() {
  if (!isChairman.value || !canViewAssociationSettings.value || isBusy.value || isQuotaBlocked.value) {
    return
  }

  searchValidationKey.value = ''
  actionError.value = null
  actionSuccessKey.value = ''

  const status = validateRegistrySearchQuery(searchQuery.value)
  if (status === 'TOO_SHORT') {
    searchValidationKey.value = 'validationQueryTooShort'
    return
  }
  if (status === 'TOO_LONG') {
    searchValidationKey.value = 'validationQueryTooLong'
    return
  }

  const queryArg = status === 'EMPTY' ? null : normalizeRegistrySearchQuery(searchQuery.value)
  const seq = ++actionSeq
  const expectedUserId = session.activeUserId
  const controller = new AbortController()
  actionAbortController = controller
  busyAction.value = 'searching'

  try {
    const res = await searchRegistry(queryArg, { signal: controller.signal })
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      !canViewAssociationSettings.value
    ) {
      return
    }
    candidates.value = Array.isArray(res?.candidates) ? res.candidates : []
    hasSearched.value = true
  } catch (err) {
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      isAbortErr(err)
    ) {
      return
    }
    if (err?.errorCode === 'REGISTRY_NOT_ENABLED') {
      notEnabled.value = true
      return
    }
    if (isDailyQuotaErr(err)) {
      applyQuotaCooldown(err)
    }
    actionError.value = normalizeRegistryError(err, { allowDailyQuota: true })
  } finally {
    if (seq === actionSeq) {
      if (busyAction.value === 'searching') {
        busyAction.value = ''
      }
      if (actionAbortController === controller) {
        actionAbortController = null
      }
    }
  }
}

async function fetchProposalByCode(code) {
  if (!isChairman.value || !canViewAssociationSettings.value || isBusy.value || isQuotaBlocked.value) {
    return
  }
  const trimmedCode = typeof code === 'string' ? code.trim() : ''
  if (!trimmedCode) return

  const seq = ++actionSeq
  const expectedUserId = session.activeUserId
  const controller = new AbortController()
  actionAbortController = controller
  busyAction.value = 'proposing'
  activeCandidateCode.value = trimmedCode
  actionError.value = null
  actionSuccessKey.value = ''

  try {
    const res = await proposeRegistry(trimmedCode, { signal: controller.signal })
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      !canViewAssociationSettings.value
    ) {
      return
    }
    registryState.value = res
  } catch (err) {
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      isAbortErr(err)
    ) {
      return
    }
    if (err?.errorCode === 'REGISTRY_NOT_ENABLED') {
      notEnabled.value = true
      return
    }
    if (isDailyQuotaErr(err)) {
      applyQuotaCooldown(err)
    }
    // Note: preserves existing registryState, candidates, and search on 503, 404, or 429
    actionError.value = normalizeRegistryError(err, { allowDailyQuota: true })
  } finally {
    if (seq === actionSeq) {
      if (busyAction.value === 'proposing') {
        busyAction.value = ''
      }
      activeCandidateCode.value = ''
      if (actionAbortController === controller) {
        actionAbortController = null
      }
    }
  }
}

async function handleAccept() {
  if (!isChairman.value || !canViewAssociationSettings.value || isBusy.value || !proposalFacts.value) {
    return
  }

  const seq = ++actionSeq
  const expectedUserId = session.activeUserId
  const controller = new AbortController()
  actionAbortController = controller
  busyAction.value = 'accepting'
  actionError.value = null
  actionSuccessKey.value = ''

  try {
    const res = await acceptRegistry({ signal: controller.signal })
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      !canViewAssociationSettings.value
    ) {
      return
    }
    registryState.value = res
    hasSearched.value = false
    candidates.value = []
    actionSuccessKey.value = 'acceptedSuccess'
    if (busyAction.value === 'accepting') {
      busyAction.value = ''
    }
    await session.refreshBuilding()
  } catch (err) {
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      isAbortErr(err)
    ) {
      return
    }
    if (err?.errorCode === 'REGISTRY_NOT_ENABLED') {
      notEnabled.value = true
      return
    }
    actionError.value = normalizeRegistryError(err)
    if (err?.errorCode === 'NO_REGISTRY_PROPOSAL') {
      if (registryState.value) {
        registryState.value = {
          ...registryState.value,
          proposal: null,
          proposal_fetched_at: null,
        }
      }
      void fetchRegistryState({ preserveBanner: true })
    }
  } finally {
    if (seq === actionSeq) {
      if (busyAction.value === 'accepting') {
        busyAction.value = ''
      }
      if (actionAbortController === controller) {
        actionAbortController = null
      }
    }
  }
}

function openRemoveModal() {
  if (!isChairman.value || isBusy.value) return
  actionError.value = null
  confirmRemoveOpen.value = true
}

function cancelRemoveModal() {
  if (isBusy.value) return
  confirmRemoveOpen.value = false
}

async function confirmRemove() {
  if (!isChairman.value || !canViewAssociationSettings.value || isBusy.value) return

  const seq = ++actionSeq
  const expectedUserId = session.activeUserId
  const controller = new AbortController()
  actionAbortController = controller
  busyAction.value = 'removing'
  actionError.value = null
  actionSuccessKey.value = ''

  try {
    await removeRegistry({ signal: controller.signal })
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      !canViewAssociationSettings.value
    ) {
      return
    }
    confirmRemoveOpen.value = false
    registryState.value = {
      accepted: null,
      accepted_at: null,
      proposal: null,
      proposal_fetched_at: null,
    }
    hasSearched.value = false
    candidates.value = []
    actionSuccessKey.value = 'removedSuccess'
    if (busyAction.value === 'removing') {
      busyAction.value = ''
    }
    await session.refreshBuilding()
  } catch (err) {
    if (
      seq !== actionSeq ||
      session.activeUserId !== expectedUserId ||
      !isChairman.value ||
      isAbortErr(err)
    ) {
      return
    }
    confirmRemoveOpen.value = false
    actionError.value = normalizeRegistryError(err)
  } finally {
    if (seq === actionSeq) {
      if (busyAction.value === 'removing') {
        busyAction.value = ''
      }
      if (actionAbortController === controller) {
        actionAbortController = null
      }
    }
  }
}

watch(
  [() => session.activeUserId, () => session.sessionRevision],
  () => {
    resetLocalUiForRoleOrUserChange()
    fetchRegistryState()
  },
)

watch(isChairman, (chairmanNow) => {
  if (!chairmanNow) {
    ++actionSeq
    if (actionAbortController) {
      actionAbortController.abort()
      actionAbortController = null
    }
    if (busyAction.value && busyAction.value !== 'loading') {
      busyAction.value = ''
    }
    clearQuotaTimer()
    quotaBlockedUntilMs.value = 0
    actionError.value = null
    actionSuccessKey.value = ''
    clearChairmanDraftUi()
  }
})

watch(
  () => route.hash,
  (newHash) => {
    if (newHash === '#building-register') {
      scrollToRegisterHashIfNeeded()
    }
  },
)

onMounted(() => {
  fetchRegistryState()
  scrollToRegisterHashIfNeeded()
})

onBeforeUnmount(() => {
  ++stateSeq
  ++actionSeq
  abortActiveRequests()
  clearQuotaTimer()
})

const isDirty = computed(
  () =>
    isChairman.value &&
    !isBusy.value &&
    (Boolean(searchQuery.value.trim()) || candidates.value.length > 0 || Boolean(proposalFacts.value)),
)

defineExpose({
  scrollIntoViewIfHash: scrollToRegisterHashIfNeeded,
  isDirty,
})
</script>

<template>
  <section
    v-if="isVisible"
    id="building-register"
    ref="sectionRef"
    data-testid="building-register-section"
    class="bg-surface-container-lowest border border-surface-container rounded-2xl p-5 sm:p-6 space-y-5 scroll-mt-20"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h2 class="font-title-md text-base font-semibold text-on-surface flex items-center gap-2">
          <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            apartment
          </span>
          <span>{{ session.t('associationSettings.registry.title') }}</span>
        </h2>
        <p class="text-xs text-on-surface-variant max-w-2xl">
          {{ session.t('associationSettings.registry.subtitle') }}
        </p>
      </div>

      <span
        v-if="!isChairman"
        class="text-xs font-medium text-on-surface-variant bg-surface-container-low px-2.5 py-1 rounded-full"
      >
        {{ session.t('associationSettings.registry.boardReadOnlyHint') }}
      </span>
    </div>

    <!-- Action Error Banner (preserves screen state on 503 / 404 / 409 / 422 / 429) -->
    <div
      v-if="effectiveErrorBanner"
      data-testid="registry-action-error"
      class="bg-error-container/80 border border-error/30 text-on-error-container rounded-xl px-4 py-3 flex items-start gap-3 text-sm"
      role="alert"
    >
      <span class="material-symbols-outlined text-[20px] shrink-0 mt-0.5" aria-hidden="true">error</span>
      <p class="font-medium">{{ effectiveErrorBanner }}</p>
    </div>

    <!-- Persistent Daily Quota Notice when another action error supersedes the primary slot -->
    <div
      v-if="secondaryQuotaBanner"
      data-testid="registry-quota-notice"
      class="bg-error-container/80 border border-error/30 text-on-error-container rounded-xl px-4 py-3 flex items-start gap-3 text-sm"
      role="status"
    >
      <span class="material-symbols-outlined text-[20px] shrink-0 mt-0.5" aria-hidden="true">schedule</span>
      <p class="font-medium">{{ secondaryQuotaBanner }}</p>
    </div>

    <!-- Action Success Banner -->
    <div
      v-if="actionSuccessBanner"
      data-testid="registry-action-success"
      class="bg-secondary-fixed/60 border border-secondary/30 text-on-secondary-fixed rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
      role="status"
    >
      <span class="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">check_circle</span>
      <p class="font-medium">{{ actionSuccessBanner }}</p>
    </div>

    <!-- Initial Loading Skeleton (only when no state is loaded yet) -->
    <div v-if="busyAction === 'loading' && !registryState" data-testid="registry-loading" class="space-y-3">
      <div class="h-10 w-full bg-surface-container animate-pulse rounded-xl" />
      <div class="h-24 w-full bg-surface-container animate-pulse rounded-xl" />
    </div>

    <!-- Initial Load Error -->
    <ErrorCard
      v-else-if="loadError && !registryState"
      data-testid="registry-load-error"
      :error="loadError"
      @retry="fetchRegistryState"
    />

    <template v-else-if="registryState">
      <!-- 1. Currently Accepted Building Passport -->
      <div
        v-if="acceptedFacts"
        data-testid="registry-accepted-block"
        class="rounded-xl border border-surface-container bg-surface-container-low/40 p-4 sm:p-5 space-y-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="space-y-0.5">
            <h3 class="text-sm font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-secondary" aria-hidden="true">verified</span>
              <span>{{ session.t('associationSettings.registry.acceptedTitle') }}</span>
            </h3>
            <p v-if="registryState.accepted_at" class="text-xs text-on-surface-variant tabular-nums">
              {{
                session.t('associationSettings.registry.acceptedAt', {
                  date: formatDateTime(registryState.accepted_at, session.lang),
                })
              }}
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <RouterLink
              data-testid="registry-open-passport-link"
              to="/building"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface hover:bg-surface-container transition-colors whitespace-nowrap"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span>
              <span>{{ session.t('associationSettings.registry.viewPassportBtn') }}</span>
            </RouterLink>

            <button
              v-if="isChairman"
              type="button"
              data-testid="registry-remove-btn"
              :disabled="isBusy"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-error/40 text-xs font-semibold text-error hover:bg-error-container/40 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              @click="openRemoveModal"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">delete</span>
              <span>
                {{
                  busyAction === 'removing'
                    ? session.t('associationSettings.registry.removingBtn')
                    : session.t('associationSettings.registry.removeBtn')
                }}
              </span>
            </button>
          </div>
        </div>

        <EeBuildingFacts
          v-if="isSupportedAccepted"
          :facts="acceptedFacts"
          :compact="true"
        />
        <p v-else class="text-xs text-on-surface-variant">
          {{
            session.t('associationSettings.registry.unsupportedSchemaHint', {
              schema: acceptedFacts?.schema || '-',
            })
          }}
        </p>
      </div>

      <!-- 2. Waiting Proposal Preview -->
      <div
        v-if="proposalFacts"
        data-testid="registry-proposal-block"
        class="rounded-xl border border-primary/30 bg-primary-fixed/10 p-4 sm:p-5 space-y-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="space-y-1">
            <h3 class="text-sm font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-primary" aria-hidden="true">fact_check</span>
              <span>{{ session.t('associationSettings.registry.proposalTitle') }}</span>
            </h3>
            <p v-if="registryState.proposal_fetched_at" class="text-xs text-on-surface-variant tabular-nums">
              {{
                session.t('associationSettings.registry.proposalFetchedAt', {
                  date: formatDateTime(registryState.proposal_fetched_at, session.lang),
                })
              }}
            </p>
            <p class="text-xs text-on-surface-variant">
              {{
                !isChairman
                  ? session.t('associationSettings.registry.proposalBoardHint')
                  : acceptedFacts
                    ? session.t('associationSettings.registry.proposalReplacesHint')
                    : session.t('associationSettings.registry.proposalHint')
              }}
            </p>
          </div>

          <div v-if="isChairman" class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="registry-refetch-btn"
              :disabled="isBusy || !proposalBuildingCode || isQuotaBlocked"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-xs font-semibold text-on-surface hover:bg-surface-container transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              @click="fetchProposalByCode(proposalBuildingCode)"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>
              <span>
                {{
                  busyAction === 'proposing' && activeCandidateCode === proposalBuildingCode
                    ? session.t('associationSettings.registry.fetchingProposalBtn')
                    : session.t('associationSettings.registry.fetchAgainBtn')
                }}
              </span>
            </button>

            <button
              type="button"
              data-testid="registry-accept-btn"
              :disabled="isBusy"
              class="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              @click="handleAccept"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">check</span>
              <span>
                {{
                  busyAction === 'accepting'
                    ? session.t('associationSettings.registry.acceptingBtn')
                    : session.t('associationSettings.registry.acceptBtn')
                }}
              </span>
            </button>
          </div>
        </div>

        <EeBuildingFacts
          v-if="isSupportedProposal"
          :facts="proposalFacts"
          :compact="true"
        />
        <p v-else class="text-xs text-on-surface-variant">
          {{
            session.t('associationSettings.registry.unsupportedSchemaHint', {
              schema: proposalFacts?.schema || '-',
            })
          }}
        </p>
      </div>

      <!-- Read-Only Empty State (Board only when neither accepted nor proposal exists) -->
      <div
        v-if="!isChairman && !acceptedFacts && !proposalFacts"
        data-testid="registry-readonly-empty"
        class="rounded-xl border border-surface-container bg-surface-container-low/40 px-4 py-5 text-sm text-on-surface-variant text-center"
      >
        {{ session.t('associationSettings.registry.emptyReadOnly') }}
      </div>

      <!-- 3. Search & Candidates (Chairman only) -->
      <div v-if="isChairman" class="space-y-4 pt-1 border-t border-surface-container">
        <form data-testid="registry-search-form" class="space-y-3" novalidate @submit.prevent="handleSearch">
          <div class="space-y-1">
            <label for="registry-search-input" class="block text-sm font-semibold text-on-surface">
              {{ session.t('associationSettings.registry.searchTitle') }}
            </label>
            <p class="text-xs text-on-surface-variant">
              {{
                session.t('associationSettings.registry.searchHint', {
                  address: session.buildingAddress,
                })
              }}
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-start">
            <div class="flex-1 min-w-0 space-y-1">
              <input
                id="registry-search-input"
                v-model="searchQuery"
                data-testid="registry-search-input"
                type="text"
                maxlength="220"
                :aria-label="session.t('associationSettings.registry.searchLabel')"
                :placeholder="
                  session.t('associationSettings.registry.searchPlaceholder', {
                    address: session.buildingAddress,
                  })
                "
                :disabled="isBusy"
                :aria-invalid="Boolean(searchValidationError)"
                class="w-full px-3 py-2 rounded-lg border text-sm bg-surface-container-lowest text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                :class="searchValidationError ? 'border-error focus:ring-error' : 'border-outline-variant'"
                @input="searchValidationKey = ''"
              />
              <p
                v-if="searchValidationError"
                data-testid="registry-search-validation-error"
                class="text-xs font-medium text-error"
                role="alert"
              >
                {{ searchValidationError }}
              </p>
            </div>

            <button
              type="submit"
              data-testid="registry-search-btn"
              :disabled="isBusy || isQuotaBlocked"
              class="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">search</span>
              <span>
                {{
                  busyAction === 'searching'
                    ? session.t('associationSettings.registry.searchingBtn')
                    : session.t('associationSettings.registry.findBtn')
                }}
              </span>
            </button>
          </div>
        </form>

        <!-- Candidate Results List -->
        <div v-if="hasSearched" data-testid="registry-candidates-panel" class="space-y-2.5">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
            {{
              session.t('associationSettings.registry.candidatesTitle', {
                count: candidates.length,
              })
            }}
          </h3>

          <p
            v-if="candidates.length === 0"
            data-testid="registry-candidates-empty"
            class="rounded-xl border border-surface-container bg-surface-container-low/40 px-4 py-3 text-xs text-on-surface-variant"
          >
            {{ session.t('associationSettings.registry.candidatesEmpty') }}
          </p>

          <ul v-else data-testid="registry-candidates-list" class="divide-y divide-surface-container rounded-xl border border-surface-container overflow-hidden">
            <li
              v-for="cand in candidates"
              :key="cand.code"
              :data-testid="`registry-candidate-row-${cand.code}`"
              class="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-container-lowest hover:bg-surface-container-low/50 transition-colors"
            >
              <div class="min-w-0 space-y-0.5">
                <p class="text-sm font-medium text-on-surface truncate">
                  {{ cand.address }}
                </p>
                <div class="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
                  <span class="font-mono">{{ cand.code }}</span>
                  <span v-if="cand.kind_label" class="px-1.5 py-0.5 rounded bg-surface-container text-[11px]">
                    {{ cand.kind_label }}
                  </span>
                </div>
              </div>

              <button
                type="button"
                :data-testid="`registry-candidate-btn-${cand.code}`"
                :disabled="isBusy || isQuotaBlocked"
                class="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/40 text-xs font-semibold text-primary hover:bg-primary-fixed/30 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                @click="fetchProposalByCode(cand.code)"
              >
                <span>
                  {{
                    busyAction === 'proposing' && activeCandidateCode === cand.code
                      ? session.t('associationSettings.registry.fetchingProposalBtn')
                      : session.t('associationSettings.registry.selectCandidateBtn')
                  }}
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <!-- Confirm Remove Modal -->
    <BaseModal
      :open="isChairman && confirmRemoveOpen"
      :title="session.t('associationSettings.registry.removeConfirmTitle')"
      max-width="max-w-md"
      @close="cancelRemoveModal"
    >
      <template #icon>
        <span class="material-symbols-outlined text-[22px] text-error shrink-0" aria-hidden="true">
          warning
        </span>
      </template>

      <div data-testid="registry-remove-confirm-modal" class="space-y-2 text-sm text-on-surface-variant">
        <p>{{ session.t('associationSettings.registry.removeConfirmBody') }}</p>
      </div>

      <template #footer>
        <button
          type="button"
          data-testid="registry-remove-cancel-btn"
          :disabled="isBusy"
          class="px-4 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          @click="cancelRemoveModal"
        >
          {{ session.t('associationSettings.registry.removeConfirmCancel') }}
        </button>
        <button
          type="button"
          data-testid="registry-remove-confirm-btn"
          :disabled="isBusy"
          class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:bg-error/90 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          @click="confirmRemove"
        >
          {{
            busyAction === 'removing'
              ? session.t('associationSettings.registry.removingBtn')
              : session.t('associationSettings.registry.removeConfirmSubmit')
          }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>
