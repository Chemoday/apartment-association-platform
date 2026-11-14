<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { localizeError } from '@/locales/index.js'
import {
  getIssueForm,
  listIssues,
  createIssue,
  editIssue,
  followIssue,
} from '@/api/endpoints/issues.js'
import {
  ISSUE_CATEGORIES,
  MAX_ISSUE_PHOTOS,
  findMatchingOpenIssues,
  validateIssueReportDraft,
} from '@/utils/issues.js'
import {
  MAX_CONCURRENT_PHOTO_UPLOADS,
  canQueuePhotoUploadsAfterCreate,
  createQueuedPhotoItem,
  drainPhotoUploadQueue,
  isUploadsEnabledInForm,
  resolvePostCreateAbortReason,
  revokeQueuedPhotoPreviews,
  safeRevokeObjectUrl,
  scaleQueuedPhotoItem,
  uploadQueuedPhotoItem,
} from '@/utils/issuePhotoQueue.js'

function createDefaultFormMeta() {
  return {
    urgent_enabled: false,
    uploads_enabled: true,
    apartment_ids: [],
    entrances: [1, 2],
  }
}

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String,
    default: 'create', // 'create' | 'edit'
  },
  issue: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['close', 'saved', 'followed'])

const session = useSessionStore()
const { isChairman, isBoard } = useRole()
const isBoardUser = computed(() => isChairman.value || isBoard.value)

const isLoadingMeta = ref(false)
const metaLoadFailed = ref(false)
const isSubmitting = ref(false)
const followingIssueId = ref('')
const formMeta = ref(createDefaultFormMeta())
const openIssuesForCheck = ref([])

const draft = ref({
  category: 'LIGHTING',
  entrance: '',
  place: '',
  title: '',
  description: '',
  urgent: false,
  apartment_id: '',
})

const fieldErrors = ref({})
const apiError = ref('')
const rateLimitSeconds = ref(0)

// #020 Photo upload queue state (create mode)
const cameraInputRef = ref(null)
const galleryInputRef = ref(null)
const queuedPhotos = ref([])
const photoPickError = ref('')
const createdIssue = ref(null)
const postCreateAbortReason = ref('') // '' | 'UPLOADS_DISABLED' | 'ISSUE_ENDED' | 'PHOTO_LIMIT_REACHED' | 'FORBIDDEN'

const isFormUploadsEnabled = computed(() => isUploadsEnabledInForm(formMeta.value))
const hasAnyUploadedPhoto = computed(() =>
  queuedPhotos.value.some((q) => q.status === 'uploaded'),
)
const hasScalingPhotos = computed(() =>
  queuedPhotos.value.some((q) => q.status === 'scaling'),
)
const uploadingPhotosCount = computed(
  () => queuedPhotos.value.filter((q) => q.status === 'uploading').length,
)
const hasUploadingPhotos = computed(() => uploadingPhotosCount.value > 0)
const remainingPhotoSlots = computed(() =>
  Math.max(
    0,
    MAX_ISSUE_PHOTOS - queuedPhotos.value.filter((q) => !q.unrecoverable && !q.removed).length,
  ),
)

let isUnmounted = false
let submissionEpoch = 0
let modalAbortController = null
const scalingControllers = new Map()

function abortScalingItem(localId) {
  const ctrl = scalingControllers.get(localId)
  if (ctrl) {
    try {
      ctrl.abort()
    } catch {
      /* ignore */
    }
    scalingControllers.delete(localId)
  }
}

function abortAllScaling() {
  for (const localId of Array.from(scalingControllers.keys())) {
    abortScalingItem(localId)
  }
}

function resetModalAbortController() {
  if (modalAbortController) {
    try {
      modalAbortController.abort()
    } catch {
      /* ignore */
    }
    modalAbortController = null
  }
}

const isCloseLocked = computed(
  () => isSubmitting.value || hasUploadingPhotos.value || hasScalingPhotos.value,
)

function clearQueuedPhotos() {
  abortAllScaling()
  revokeQueuedPhotoPreviews(queuedPhotos.value)
  queuedPhotos.value = []
  photoPickError.value = ''
}

function getQueuedPhoto(localId) {
  return queuedPhotos.value.find((q) => q.localId === localId)
}

function updateQueuedPhoto(localId, patch) {
  const idx = queuedPhotos.value.findIndex((q) => q.localId === localId)
  if (idx === -1) return
  const next = [...queuedPhotos.value]
  next[idx] = { ...next[idx], ...patch }
  queuedPhotos.value = next
}

function removeQueuedPhoto(localId) {
  abortScalingItem(localId)
  const target = queuedPhotos.value.find((q) => q.localId === localId)
  if (target?.previewUrl) {
    safeRevokeObjectUrl(target.previewUrl)
  }
  queuedPhotos.value = queuedPhotos.value.filter((q) => q.localId !== localId)
  photoPickError.value = ''
}

async function handleModalPhotoChange(event) {
  const input = event.target
  const files = Array.from(input?.files || [])
  if (input) input.value = ''
  if (
    files.length === 0 ||
    isUnmounted ||
    !props.open ||
    !isFormUploadsEnabled.value ||
    isLoadingMeta.value ||
    metaLoadFailed.value ||
    isSubmitting.value ||
    Boolean(createdIssue.value)
  ) {
    return
  }

  const available = remainingPhotoSlots.value
  photoPickError.value =
    files.length > available ? localizeError('PHOTO_LIMIT_REACHED', {}, session.lang) : ''
  const selected = files.slice(0, available)
  if (selected.length === 0) return

  const pickEpoch = submissionEpoch
  const entries = selected.map((file) => createQueuedPhotoItem(file, { idPrefix: 'draft-photo' }))
  queuedPhotos.value = [...queuedPhotos.value, ...entries]

  for (let i = 0; i < entries.length; i += 1) {
    if (isUnmounted || !props.open || pickEpoch !== submissionEpoch || !isFormUploadsEnabled.value) break
    const entry = entries[i]
    const file = selected[i]
    if (!getQueuedPhoto(entry.localId)) continue
    const ctrl = new AbortController()
    scalingControllers.set(entry.localId, ctrl)
    try {
      await scaleQueuedPhotoItem(entry.localId, file, {
        updateItem: updateQueuedPhoto,
        signal: ctrl.signal,
        lang: session.lang,
      })
    } finally {
      if (scalingControllers.get(entry.localId) === ctrl) {
        scalingControllers.delete(entry.localId)
      }
    }
  }
}

async function uploadSingleQueuedPhoto(issueId, localId, signal) {
  const result = await uploadQueuedPhotoItem(issueId, localId, {
    getItem: getQueuedPhoto,
    updateItem: updateQueuedPhoto,
    signal,
    tFn: session.t,
    lang: session.lang,
  })
  if (result.ok && result.photo && createdIssue.value?.id === issueId) {
    const existing = Array.isArray(createdIssue.value.photos) ? createdIssue.value.photos : []
    if (!existing.some((p) => p.id === result.photo.id)) {
      createdIssue.value = {
        ...createdIssue.value,
        photos: [...existing, result.photo],
      }
    }
  } else if (result.removed) {
    const removedMsg = formatPhotoErrorMessage(result.error, session.t, session.lang)
    removeQueuedPhoto(localId)
    photoPickError.value = removedMsg
  }
  return result
}

async function handleRetryModalPhoto(localId) {
  if (
    !createdIssue.value?.id ||
    postCreateAbortReason.value !== '' ||
    uploadingPhotosCount.value >= MAX_CONCURRENT_PHOTO_UPLOADS ||
    hasScalingPhotos.value ||
    isUnmounted
  ) {
    return
  }
  const target = getQueuedPhoto(localId)
  if (!target || target.unrecoverable || target.removed || target.status === 'uploaded' || target.status === 'uploading') {
    return
  }

  if (!modalAbortController || modalAbortController.signal.aborted) {
    modalAbortController = new AbortController()
  }
  const signal = modalAbortController.signal
  const retryEpoch = submissionEpoch

  const result = await uploadSingleQueuedPhoto(createdIssue.value.id, localId, signal)
  if (result.aborted || isUnmounted || !props.open || retryEpoch !== submissionEpoch) return
  const abortReason = resolvePostCreateAbortReason(result.error)
  if (abortReason) {
    postCreateAbortReason.value = abortReason
    resetModalAbortController()
    return
  }
  if (result.ok) {
    const anyLeft = queuedPhotos.value.some((q) => !q.unrecoverable && q.status !== 'uploaded')
    if (!anyLeft) {
      finishAfterPartialUpload()
    }
  }
}

function finishAfterPartialUpload() {
  if (isCloseLocked.value) return
  resetModalAbortController()
  const saved = createdIssue.value
  clearQueuedPhotos()
  createdIssue.value = null
  postCreateAbortReason.value = ''
  if (saved) {
    emit('saved', saved)
  } else {
    emit('close')
  }
}

const apartmentLabelById = computed(() => {
  const map = {}
  for (const m of session.memberships || []) {
    map[m.apartment_id] = m.apartment_number
  }
  return map
})

const matchingOpenIssues = computed(() => {
  if (props.mode !== 'create') return []
  return findMatchingOpenIssues(
    openIssuesForCheck.value,
    draft.value.category,
    draft.value.entrance,
  )
})

const rateLimitTimeText = computed(() => {
  if (!rateLimitSeconds.value || rateLimitSeconds.value <= 0) return ''
  const hours = Math.floor(rateLimitSeconds.value / 3600)
  const minutes = Math.max(1, Math.ceil((rateLimitSeconds.value % 3600) / 60))
  if (hours > 0) {
    return session.t('issues.form.rateLimitRetryHoursMinutes', { hours, minutes })
  }
  return session.t('issues.form.rateLimitRetryMinutes', { minutes })
})

async function initializeForm({ preserveDraft = false } = {}) {
  submissionEpoch += 1
  resetModalAbortController()
  isSubmitting.value = false
  followingIssueId.value = ''
  fieldErrors.value = {}
  apiError.value = ''
  rateLimitSeconds.value = 0
  createdIssue.value = null
  postCreateAbortReason.value = ''
  formMeta.value = createDefaultFormMeta()
  openIssuesForCheck.value = []
  metaLoadFailed.value = false
  clearQueuedPhotos()

  if (!preserveDraft) {
    if (props.mode === 'edit' && props.issue) {
      draft.value = {
        category: props.issue.category || 'LIGHTING',
        entrance:
          props.issue.entrance === null || props.issue.entrance === undefined
            ? ''
            : String(props.issue.entrance),
        place: props.issue.place || '',
        title: props.issue.title || '',
        description: props.issue.description || '',
        urgent: Boolean(props.issue.urgent),
        apartment_id: '',
      }
    } else {
      const defaultEntrance = session.activeMembership?.entrance
        ? String(session.activeMembership.entrance)
        : ''
      draft.value = {
        category: 'LIGHTING',
        entrance: defaultEntrance,
        place: '',
        title: '',
        description: '',
        urgent: false,
        apartment_id: session.activeMembership?.apartment_id || '',
      }
    }
  }

  isLoadingMeta.value = true
  const initEpoch = submissionEpoch
  try {
    const [meta, openList] = await Promise.all([
      getIssueForm(),
      props.mode === 'create'
        ? listIssues({ status: 'OPEN', limit: 100 }).catch(() => [])
        : Promise.resolve([]),
    ])
    if (isUnmounted || !props.open || initEpoch !== submissionEpoch) return
    formMeta.value = {
      urgent_enabled: Boolean(meta?.urgent_enabled),
      uploads_enabled: isUploadsEnabledInForm(meta),
      apartment_ids: Array.isArray(meta?.apartment_ids) ? meta.apartment_ids : [],
      entrances:
        Array.isArray(meta?.entrances) && meta.entrances.length > 0 ? meta.entrances : [1, 2],
    }
    if (!formMeta.value.uploads_enabled) {
      clearQueuedPhotos()
    }
    openIssuesForCheck.value = Array.isArray(openList) ? openList : []

    if (
      props.mode === 'create' &&
      formMeta.value.apartment_ids.length > 0 &&
      !formMeta.value.apartment_ids.includes(draft.value.apartment_id)
    ) {
      draft.value.apartment_id = formMeta.value.apartment_ids[0]
    }
  } catch (err) {
    if (isUnmounted || !props.open || initEpoch !== submissionEpoch) return
    metaLoadFailed.value = true
    apiError.value = localizeError(err, session.lang)
  } finally {
    if (initEpoch === submissionEpoch) {
      isLoadingMeta.value = false
    }
  }
}

watch(
  () => [props.open, props.mode, props.issue?.id, session.actingUserId],
  ([isOpen]) => {
    if (isOpen) {
      initializeForm()
    } else {
      submissionEpoch += 1
      resetModalAbortController()
      clearQueuedPhotos()
      createdIssue.value = null
      postCreateAbortReason.value = ''
      formMeta.value = createDefaultFormMeta()
      openIssuesForCheck.value = []
      metaLoadFailed.value = false
      isSubmitting.value = false
      followingIssueId.value = ''
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  isUnmounted = true
  submissionEpoch += 1
  resetModalAbortController()
  clearQueuedPhotos()
})

async function handleFollowExisting(existingIssue) {
  if (!existingIssue?.id || followingIssueId.value || isCloseLocked.value) return
  followingIssueId.value = existingIssue.id
  apiError.value = ''
  const followEpoch = submissionEpoch
  try {
    const updated = await followIssue(existingIssue.id)
    if (isUnmounted || !props.open || followEpoch !== submissionEpoch) return
    emit('followed', updated)
  } catch (err) {
    if (isUnmounted || !props.open || followEpoch !== submissionEpoch) return
    apiError.value = localizeError(err, session.lang)
  } finally {
    if (followEpoch === submissionEpoch) {
      followingIssueId.value = ''
    }
  }
}

async function handleSubmit() {
  if (
    isSubmitting.value ||
    isLoadingMeta.value ||
    (props.mode === 'create' && metaLoadFailed.value) ||
    hasScalingPhotos.value ||
    hasUploadingPhotos.value
  ) {
    return
  }

  fieldErrors.value = {}
  apiError.value = ''
  rateLimitSeconds.value = 0

  if (props.mode === 'edit' && props.issue) {
    const title = String(draft.value.title || '').trim()
    const place = String(draft.value.place || '').trim()
    const description = String(draft.value.description || '').trim()

    if (!title) {
      fieldErrors.value = { title: 'TITLE_REQUIRED' }
      return
    }
    if (title.length > 120) {
      fieldErrors.value = { title: 'TITLE_TOO_LONG' }
      return
    }
    if (place.length > 200) {
      fieldErrors.value = { place: 'PLACE_TOO_LONG' }
      return
    }
    if (description.length > 2000) {
      fieldErrors.value = { description: 'DESCRIPTION_TOO_LONG' }
      return
    }

    isSubmitting.value = true
    const editEpoch = submissionEpoch
    try {
      const entranceVal =
        draft.value.entrance === '' ||
        draft.value.entrance === null ||
        Number(draft.value.entrance) === 0
          ? null
          : Number(draft.value.entrance)

      const updated = await editIssue(props.issue.id, {
        category: draft.value.category,
        entrance: entranceVal,
        place: place || null,
        title,
        description,
      })
      if (isUnmounted || !props.open || editEpoch !== submissionEpoch) return
      emit('saved', updated)
    } catch (err) {
      if (isUnmounted || !props.open || editEpoch !== submissionEpoch) return
      apiError.value = localizeError(err, session.lang)
    } finally {
      if (editEpoch === submissionEpoch) {
        isSubmitting.value = false
      }
    }
    return
  }

  // If issue text was already created during partial photo failure, never recreate the issue
  if (createdIssue.value) return

  const validation = validateIssueReportDraft(
    draft.value,
    formMeta.value,
    isBoardUser.value,
  )
  if (!validation.valid) {
    fieldErrors.value = validation.errors
    return
  }

  isSubmitting.value = true
  const submitEpoch = submissionEpoch
  resetModalAbortController()
  modalAbortController = new AbortController()
  const signal = modalAbortController.signal

  try {
    const created = await createIssue(validation.payload, { signal })
    if (isUnmounted || !props.open || submitEpoch !== submissionEpoch || signal.aborted) {
      return
    }
    const uploadableIds = isFormUploadsEnabled.value
      ? queuedPhotos.value
          .filter((q) => q.scaledBlob && !q.unrecoverable && q.status !== 'uploaded')
          .map((q) => q.localId)
      : []

    if (uploadableIds.length === 0) {
      clearQueuedPhotos()
      emit('saved', created)
      return
    }

    if (!canQueuePhotoUploadsAfterCreate(created, uploadableIds.length)) {
      postCreateAbortReason.value = 'UPLOADS_DISABLED'
      createdIssue.value = created
      return
    }

    createdIssue.value = created
    const drainResult = await drainPhotoUploadQueue([...uploadableIds], {
      concurrency: MAX_CONCURRENT_PHOTO_UPLOADS,
      signal,
      shouldContinue: () => !isUnmounted && props.open && submitEpoch === submissionEpoch,
      worker: (localId, s) => uploadSingleQueuedPhoto(created.id, localId, s),
      onWholeIssueAbort: (err) => {
        const abortReason = resolvePostCreateAbortReason(err)
        if (abortReason) {
          postCreateAbortReason.value = abortReason
          resetModalAbortController()
        }
      },
    })

    if (
      isUnmounted ||
      !props.open ||
      submitEpoch !== submissionEpoch ||
      (signal.aborted && !postCreateAbortReason.value)
    ) {
      return
    }
    const allSucceeded =
      !drainResult.aborted &&
      !drainResult.wholeIssueError &&
      drainResult.failed === 0 &&
      drainResult.completed === uploadableIds.length
    if (allSucceeded) {
      const savedWithPhotos = createdIssue.value || created
      clearQueuedPhotos()
      createdIssue.value = null
      emit('saved', savedWithPhotos)
    }
  } catch (err) {
    if (
      isUnmounted ||
      !props.open ||
      submitEpoch !== submissionEpoch ||
      err?.errorCode === 'REQUEST_ABORTED'
    ) {
      return
    }
    if (err?.errorCode === 'RATE_LIMITED') {
      const rawSec = Number(err?.payload?.retry_after_seconds)
      rateLimitSeconds.value =
        Number.isFinite(rawSec) && rawSec > 0 ? Math.ceil(rawSec) : 3600
      apiError.value = session.t('issues.form.rateLimitReached')
    } else {
      apiError.value = localizeError(err, session.lang)
    }
  } finally {
    if (submitEpoch === submissionEpoch) {
      isSubmitting.value = false
    }
  }
}

function handleModalClose() {
  if (isCloseLocked.value) return
  if (createdIssue.value) {
    finishAfterPartialUpload()
    return
  }
  emit('close')
}

function formatLocationLabel(entrance, place) {
  const base =
    entrance === null || entrance === undefined
      ? session.t('issues.locationOutside')
      : session.t('issues.locationEntrance', { n: entrance })
  return place ? `${base} · ${place}` : base
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-label="
        mode === 'edit' ? session.t('issues.form.editTitle') : session.t('issues.form.reportTitle')
      "
      @click.self="handleModalClose"
    >
      <div
        class="w-full max-w-2xl rounded-2xl border border-surface-container bg-surface-container-lowest shadow-xl overflow-hidden my-8"
      >
        <!-- Modal Header -->
        <div
          class="flex items-center justify-between gap-4 border-b border-surface-container px-5 py-4"
        >
          <h2 class="text-lg font-bold text-on-surface">
            {{
              mode === 'edit'
                ? session.t('issues.form.editTitle')
                : session.t('issues.form.reportTitle')
            }}
          </h2>
          <button
            type="button"
            :disabled="isCloseLocked"
            class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface cursor-pointer disabled:opacity-40 transition-colors"
            :aria-label="session.t('common.close')"
            @click="handleModalClose"
          >
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <!-- Post-create photo outcome view: report itself is already saved -->
        <div v-if="createdIssue" data-testid="issue-partial-photo-step" class="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
          <div
            v-if="postCreateAbortReason"
            data-testid="issue-uploads-disabled-saved-banner"
            class="rounded-xl p-4 flex items-start gap-3 border"
            :class="
              postCreateAbortReason === 'UPLOADS_DISABLED'
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-amber-500/30 bg-amber-500/10'
            "
          >
            <span
              class="material-symbols-outlined text-[20px] shrink-0 mt-0.5"
              :class="
                postCreateAbortReason === 'UPLOADS_DISABLED'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400'
              "
            >
              {{ postCreateAbortReason === 'UPLOADS_DISABLED' ? 'check_circle' : 'info' }}
            </span>
            <div>
              <h3 class="text-sm font-bold text-on-surface">
                {{
                  postCreateAbortReason === 'UPLOADS_DISABLED' && !hasAnyUploadedPhoto
                    ? session.t('issues.photos.uploadsDisabledSavedTitle')
                    : session.t('issues.photos.partialUploadTitle')
                }}
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                {{
                  postCreateAbortReason === 'UPLOADS_DISABLED'
                    ? hasAnyUploadedPhoto
                      ? session.t('issues.photos.uploadsDisabledPartialSavedBody')
                      : session.t('issues.photos.uploadsDisabledSavedBody')
                    : localizeError(postCreateAbortReason, {}, session.lang)
                }}
              </p>
            </div>
          </div>

          <div
            v-else
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3"
          >
            <span class="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              cloud_upload
            </span>
            <div>
              <h3 class="text-sm font-bold text-on-surface">
                {{ session.t('issues.photos.partialUploadTitle') }}
              </h3>
              <p class="mt-1 text-xs text-on-surface-variant">
                {{ session.t('issues.photos.partialUploadBody') }}
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-3">
            <div
              v-for="(item, qIdx) in queuedPhotos"
              :key="item.localId"
              :data-testid="`modal-photo-retry-card-${item.localId}`"
              class="relative rounded-xl border border-surface-container bg-surface-container-low overflow-hidden aspect-[4/3] flex flex-col items-center justify-center"
            >
              <img
                v-if="item.previewUrl"
                :src="item.previewUrl"
                :alt="session.t('issues.photos.photoAlt', { index: qIdx + 1 })"
                class="w-full h-full object-cover opacity-75"
              />
              <div
                class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center"
                :class="item.status === 'uploaded' ? 'bg-emerald-950/65 text-white' : 'bg-black/60 text-white'"
              >
                <template v-if="item.status === 'uploaded'">
                  <span class="material-symbols-outlined text-[24px] text-emerald-300">check_circle</span>
                </template>
                <template v-else-if="postCreateAbortReason">
                  <span class="material-symbols-outlined text-[22px] text-white/80">no_photography</span>
                  <span class="text-[11px] font-medium text-white/85">
                    {{ session.t('issues.photos.photoNotAttached') }}
                  </span>
                </template>
                <template v-else-if="item.status === 'scaling'">
                  <span class="text-xs font-semibold">{{ session.t('issues.photos.scaling') }}</span>
                </template>
                <template v-else-if="item.status === 'ready'">
                  <div class="flex flex-wrap items-center justify-center gap-1.5">
                    <button
                      type="button"
                      :data-testid="`modal-retry-photo-${item.localId}`"
                      :disabled="uploadingPhotosCount >= MAX_CONCURRENT_PHOTO_UPLOADS || hasScalingPhotos"
                      class="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60"
                      @click="handleRetryModalPhoto(item.localId)"
                    >
                      {{ session.t('issues.photos.retryPhoto') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/25 cursor-pointer"
                      @click="removeQueuedPhoto(item.localId)"
                    >
                      {{ session.t('issues.photos.removeQueued') }}
                    </button>
                  </div>
                </template>
                <template v-else-if="item.status === 'uploading'">
                  <span class="text-xs font-semibold">
                    {{ session.t('issues.photos.uploading', { percent: item.progress }) }}
                  </span>
                  <div class="w-4/5 h-1.5 rounded-full bg-white/25 overflow-hidden">
                    <div
                      class="h-full bg-primary transition-all duration-150"
                      :style="{ width: `${item.progress}%` }"
                    />
                  </div>
                </template>
                <template v-else-if="item.status === 'error'">
                  <p
                    :title="item.error"
                    class="text-[11px] font-medium leading-snug text-rose-200 line-clamp-3"
                  >
                    {{ item.error }}
                  </p>
                  <div class="flex flex-wrap items-center justify-center gap-1.5 mt-1">
                    <button
                      v-if="!item.unrecoverable"
                      type="button"
                      :data-testid="`modal-retry-photo-${item.localId}`"
                      :disabled="uploadingPhotosCount >= MAX_CONCURRENT_PHOTO_UPLOADS || hasScalingPhotos"
                      class="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60"
                      @click="handleRetryModalPhoto(item.localId)"
                    >
                      {{ session.t('issues.photos.retryPhoto') }}
                    </button>
                    <button
                      type="button"
                      class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/25 cursor-pointer"
                      @click="removeQueuedPhoto(item.localId)"
                    >
                      {{ session.t('issues.photos.removeQueued') }}
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-3 border-t border-surface-container">
            <button
              type="button"
              data-testid="modal-open-created-issue-btn"
              :disabled="hasUploadingPhotos || hasScalingPhotos"
              class="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
              @click="finishAfterPartialUpload"
            >
              <span>{{ session.t('issues.photos.openCreatedIssue') }}</span>
            </button>
          </div>
        </div>

        <!-- Modal Form Body -->
        <form v-else class="p-5 space-y-5 max-h-[80vh] overflow-y-auto" @submit.prevent="handleSubmit">
          <!-- Common-areas scope notice with link to /messages (#004) -->
          <div
            data-testid="issues-common-area-notice"
            class="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary-container/15 p-3.5 text-sm text-on-surface"
          >
            <span
              class="material-symbols-outlined text-[20px] text-primary shrink-0 mt-0.5"
            >
              info
            </span>
            <div>
              <p class="font-medium">
                {{ session.t('issues.form.commonAreasNotice') }}
              </p>
              <RouterLink
                to="/messages"
                class="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary underline hover:no-underline"
                @click="emit('close')"
              >
                {{ session.t('issues.form.writeToBoardLink') }}
                <span class="material-symbols-outlined text-[15px]">arrow_forward</span>
              </RouterLink>
            </div>
          </div>

          <!-- 429 Rate limit or API error banner -->
          <div
            v-if="apiError"
            data-testid="issue-form-error"
            class="rounded-xl border border-error/30 bg-error-container/30 p-3.5 text-sm text-on-error-container"
          >
            <div class="flex items-start justify-between gap-2.5">
              <div class="flex items-start gap-2.5">
                <span
                  class="material-symbols-outlined text-[20px] text-error shrink-0"
                >
                  error
                </span>
                <div>
                  <p class="font-semibold">{{ apiError }}</p>
                  <p
                    v-if="rateLimitTimeText"
                    class="mt-1 text-xs text-on-error-container/80"
                  >
                    {{ rateLimitTimeText }}
                  </p>
                </div>
              </div>
              <button
                v-if="metaLoadFailed"
                type="button"
                data-testid="issue-form-meta-retry-btn"
                class="shrink-0 rounded-lg border border-error/40 bg-surface-container-lowest px-2.5 py-1 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
                @click="initializeForm({ preserveDraft: true })"
              >
                {{ session.t('common.retry') }}
              </button>
            </div>
          </div>

          <!-- Apartment selector when user has multiple apartments -->
          <div
            v-if="mode === 'create' && formMeta.apartment_ids.length > 1"
            class="space-y-1.5"
          >
            <label
              for="issue-apartment-select"
              class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
            >
              {{ session.t('issues.form.apartmentLabel') }}
            </label>
            <select
              id="issue-apartment-select"
              v-model="draft.apartment_id"
              data-testid="issue-apartment-select"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option
                v-for="aptId in formMeta.apartment_ids"
                :key="aptId"
                :value="aptId"
              >
                {{
                  apartmentLabelById[aptId]
                    ? session.t('issues.form.apartmentOption', {
                        number: apartmentLabelById[aptId],
                      })
                    : aptId
                }}
              </option>
            </select>
            <p
              v-if="fieldErrors.apartment_id"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.apartment_id}`) }}
            </p>
          </div>

          <!-- Category & Entrance row -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label
                for="issue-category-select"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.categoryLabel') }}
              </label>
              <select
                id="issue-category-select"
                v-model="draft.category"
                data-testid="issue-category-select"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option
                  v-for="cat in ISSUE_CATEGORIES"
                  :key="cat"
                  :value="cat"
                >
                  {{ session.t(`issues.categories.${cat}`) }}
                </option>
              </select>
            </div>

            <div class="space-y-1.5">
              <label
                for="issue-entrance-select"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.locationLabel') }}
              </label>
              <select
                id="issue-entrance-select"
                v-model="draft.entrance"
                data-testid="issue-entrance-select"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">
                  {{ session.t('issues.locationOutside') }}
                </option>
                <option
                  v-for="ent in formMeta.entrances"
                  :key="ent"
                  :value="String(ent)"
                >
                  {{ session.t('issues.locationEntrance', { n: ent }) }}
                </option>
              </select>
            </div>
          </div>

          <!-- Pre-submit matching open issues suggestion (+1 instead of filing duplicate) -->
          <div
            v-if="mode === 'create' && matchingOpenIssues.length > 0"
            data-testid="issue-duplicate-suggestions"
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3"
          >
            <div class="flex items-start gap-2.5">
              <span
                class="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
              >
                lightbulb
              </span>
              <div>
                <h4
                  class="text-xs font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200"
                >
                  {{ session.t('issues.form.matchingIssuesTitle') }}
                </h4>
                <p class="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                  {{ session.t('issues.form.matchingIssuesHint') }}
                </p>
              </div>
            </div>

            <ul class="space-y-2">
              <li
                v-for="existing in matchingOpenIssues"
                :key="existing.id"
                class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border border-amber-500/25 bg-surface-container-lowest p-3"
              >
                <div class="min-w-0">
                  <RouterLink
                    :to="{ name: 'issue-detail', params: { issueId: existing.id } }"
                    class="text-sm font-semibold text-on-surface hover:text-primary transition-colors"
                    @click="emit('close')"
                  >
                    {{ existing.title }}
                  </RouterLink>
                  <div
                    class="mt-1 flex flex-wrap items-center gap-2 text-xs text-on-surface-variant"
                  >
                    <span>{{ formatLocationLabel(existing.entrance, existing.place) }}</span>
                    <span>·</span>
                    <span class="font-medium text-primary">
                      {{ session.t(`issues.statuses.${existing.status}`) }}
                    </span>
                    <span>·</span>
                    <span>{{ session.t('issues.followersCount', { count: existing.followers }) }}</span>
                  </div>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <button
                    v-if="existing.can_follow"
                    type="button"
                    :data-testid="`follow-suggestion-${existing.id}`"
                    :disabled="followingIssueId === existing.id"
                    class="inline-flex items-center gap-1 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-60 transition-colors"
                    @click="handleFollowExisting(existing)"
                  >
                    <span class="material-symbols-outlined text-[15px]">thumb_up</span>
                    <span>{{ session.t('issues.followAction') }}</span>
                  </button>
                  <span
                    v-else-if="existing.i_follow"
                    class="inline-flex items-center gap-1 rounded-md bg-primary-container/20 px-2.5 py-1 text-xs font-semibold text-primary"
                  >
                    <span class="material-symbols-outlined text-[15px]">check_circle</span>
                    {{ session.t('issues.youFollowBadge') }}
                  </span>
                </div>
              </li>
            </ul>
          </div>

          <!-- Place within location (optional) -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-place-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.placeLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.place || '').length }} / 200
              </span>
            </div>
            <input
              id="issue-place-input"
              v-model="draft.place"
              type="text"
              maxlength="200"
              data-testid="issue-place-input"
              :placeholder="session.t('issues.form.placePlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.place"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.place}`) }}
            </p>
          </div>

          <!-- Title -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-title-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.titleLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.title || '').length }} / 120
              </span>
            </div>
            <input
              id="issue-title-input"
              v-model="draft.title"
              type="text"
              maxlength="120"
              data-testid="issue-title-input"
              :placeholder="session.t('issues.form.titlePlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.title"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.title}`) }}
            </p>
          </div>

          <!-- Description -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-description-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.descriptionLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.description || '').length }} / 2000
              </span>
            </div>
            <textarea
              id="issue-description-input"
              v-model="draft.description"
              rows="4"
              maxlength="2000"
              data-testid="issue-description-input"
              :placeholder="session.t('issues.form.descriptionPlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.description"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.description}`) }}
            </p>
          </div>

          <!-- Photos section (#020 / #021): available in create mode -->
          <div
            v-if="mode === 'create'"
            data-testid="issue-form-photos-section"
            class="space-y-3 rounded-xl border border-surface-container bg-surface-container-low/40 p-3.5"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                {{ session.t('issues.photos.title') }}
              </span>
              <span v-if="!isLoadingMeta && !metaLoadFailed && isFormUploadsEnabled" class="text-xs text-on-surface-variant">
                {{ queuedPhotos.length }} / {{ MAX_ISSUE_PHOTOS }}
              </span>
            </div>

            <div
              v-if="isLoadingMeta"
              data-testid="issue-form-photos-loading"
              class="text-xs text-on-surface-variant py-1"
            >
              {{ session.t('common.loading') }}
            </div>

            <div
              v-else-if="!isFormUploadsEnabled"
              data-testid="issue-form-uploads-disabled-notice"
              class="flex items-center gap-2.5 rounded-lg border border-surface-container bg-surface-container-lowest/70 px-3 py-2.5 text-xs text-on-surface-variant"
            >
              <span class="material-symbols-outlined text-[18px] text-on-surface-variant shrink-0">
                no_photography
              </span>
              <span>{{ localizeError('UPLOADS_DISABLED', {}, session.lang) }}</span>
            </div>

            <template v-else-if="!metaLoadFailed">
              <div
                v-if="photoPickError"
                class="text-xs font-medium text-error"
              >
                {{ photoPickError }}
              </div>

              <!-- Selected photo previews -->
              <div
                v-if="queuedPhotos.length > 0"
                class="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-2.5"
              >
                <div
                  v-for="(item, qIdx) in queuedPhotos"
                  :key="item.localId"
                  class="relative rounded-lg border border-surface-container bg-surface-container-lowest overflow-hidden aspect-[4/3] flex items-center justify-center"
                >
                  <img
                    v-if="item.previewUrl"
                    :src="item.previewUrl"
                    :alt="session.t('issues.photos.photoAlt', { index: qIdx + 1 })"
                    class="w-full h-full object-cover"
                  />

                  <div
                    v-if="item.status === 'scaling' || item.status === 'uploading' || item.status === 'error'"
                    class="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1.5 p-2 text-center text-white"
                  >
                    <template v-if="item.status === 'scaling'">
                      <span class="text-[11px] font-semibold">{{ session.t('issues.photos.scaling') }}</span>
                    </template>
                    <template v-else-if="item.status === 'uploading'">
                      <span class="text-[11px] font-semibold">
                        {{ session.t('issues.photos.uploading', { percent: item.progress }) }}
                      </span>
                      <div class="w-4/5 h-1.5 rounded-full bg-white/25 overflow-hidden">
                        <div
                          class="h-full bg-primary transition-all duration-150"
                          :style="{ width: `${item.progress}%` }"
                        />
                      </div>
                    </template>
                    <template v-else-if="item.status === 'error'">
                      <p
                        :title="item.error"
                        class="text-[11px] font-medium leading-snug text-rose-200 line-clamp-3"
                      >
                        {{ item.error }}
                      </p>
                    </template>
                  </div>

                  <button
                    type="button"
                    :title="session.t('issues.photos.removeQueued')"
                    :aria-label="session.t('issues.photos.removeQueued')"
                    :disabled="isSubmitting"
                    class="absolute top-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white hover:bg-error cursor-pointer disabled:opacity-50"
                    @click="removeQueuedPhoto(item.localId)"
                  >
                    <span class="material-symbols-outlined text-[15px]">close</span>
                  </button>
                </div>
              </div>

              <!-- Two picking buttons -->
              <div class="flex flex-wrap items-center gap-2">
                <input
                  ref="cameraInputRef"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  data-testid="issue-form-camera-input"
                  class="hidden"
                  @change="handleModalPhotoChange"
                />
                <input
                  ref="galleryInputRef"
                  type="file"
                  accept="image/*"
                  multiple
                  data-testid="issue-form-gallery-input"
                  class="hidden"
                  @change="handleModalPhotoChange"
                />

                <button
                  type="button"
                  data-testid="issue-form-take-photo-btn"
                  :disabled="remainingPhotoSlots <= 0 || isSubmitting || isLoadingMeta || metaLoadFailed"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-surface-container-high bg-surface-container-lowest px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-50 transition-colors"
                  @click="cameraInputRef?.click()"
                >
                  <span class="material-symbols-outlined text-[16px]">photo_camera</span>
                  <span>{{ session.t('issues.photos.takePhoto') }}</span>
                </button>

                <button
                  type="button"
                  data-testid="issue-form-choose-gallery-btn"
                  :disabled="remainingPhotoSlots <= 0 || isSubmitting || isLoadingMeta || metaLoadFailed"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-surface-container-high bg-surface-container-lowest px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-50 transition-colors"
                  @click="galleryInputRef?.click()"
                >
                  <span class="material-symbols-outlined text-[16px]">photo_library</span>
                  <span>{{ session.t('issues.photos.chooseFromGallery') }}</span>
                </button>
              </div>

              <!-- #021 Static retention notice next to photo buttons -->
              <p
                data-testid="issue-form-photos-retention-hint"
                class="text-xs text-on-surface-variant leading-relaxed"
              >
                {{ session.t('issues.photos.retentionHint') }}
              </p>
            </template>
          </div>

          <!-- Urgent switch: shown ONLY when urgent_enabled is true in GET /issues/form -->
          <div
            v-if="mode === 'create' && formMeta.urgent_enabled"
            data-testid="issue-urgent-toggle-section"
            class="flex items-start justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5"
          >
            <div>
              <label
                for="issue-urgent-checkbox"
                class="text-sm font-semibold text-on-surface cursor-pointer"
              >
                {{ session.t('issues.form.urgentLabel') }}
              </label>
              <p class="mt-0.5 text-xs text-on-surface-variant">
                {{ session.t('issues.form.urgentHint') }}
              </p>
            </div>
            <input
              id="issue-urgent-checkbox"
              v-model="draft.urgent"
              type="checkbox"
              data-testid="issue-urgent-checkbox"
              class="mt-1 h-4 w-4 rounded border-surface-container-high accent-amber-600 focus:ring-amber-500"
            />
          </div>

          <!-- Footer Actions -->
          <div
            class="flex items-center justify-end gap-3 pt-3 border-t border-surface-container"
          >
            <button
              type="button"
              :disabled="isCloseLocked"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-40 transition-colors"
              @click="handleModalClose"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="submit"
              data-testid="issue-submit-button"
              :disabled="isSubmitting || isLoadingMeta || (mode === 'create' && metaLoadFailed) || hasScalingPhotos || hasUploadingPhotos"
              class="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
            >
              <span>
                {{
                  mode === 'edit'
                    ? session.t('issues.form.saveChanges')
                    : session.t('issues.form.submitReport')
                }}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
