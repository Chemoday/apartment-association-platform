<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { localizeError } from '@/locales/index.js'
import { formatDate } from '@/utils/dates.js'
import {
  MAX_CONCURRENT_PHOTO_UPLOADS,
  createQueuedPhotoItem,
  drainPhotoUploadQueue,
  formatPhotoErrorMessage,
  resolveCanAddPhotoFalseReason,
  revokeQueuedPhotoPreviews,
  safeRevokeObjectUrl,
  scaleQueuedPhotoItem,
  shouldShowIssuePhotosSection,
  uploadQueuedPhotoItem,
} from '@/utils/issuePhotoQueue.js'
import {
  fetchIssuePhotoBlob,
  deleteIssuePhoto,
} from '@/api/endpoints/issues.js'

const MAX_PHOTOS = 3

const props = defineProps({
  issueId: {
    type: String,
    required: true,
  },
  photos: {
    type: Array,
    default: () => [],
  },
  canAddPhoto: {
    type: Boolean,
    default: false,
  },
  issueOpen: {
    type: Boolean,
    default: undefined,
  },
  photosDeleteAt: {
    type: String,
    default: null,
  },
})

const emit = defineEmits(['uploaded', 'deleted', 'photo-gone', 'sync-needed'])

const session = useSessionStore()

const cameraInputRef = ref(null)
const galleryInputRef = ref(null)

// Cached blob URLs per photo id, revoked when photo leaves or component unmounts
const thumbUrls = ref({})
const displayUrls = ref({})
const thumbLoading = ref({})
const thumbErrors = ref({})

// Active upload queue for photos picked on the detail page
const uploadQueue = ref([])

// Delete confirmation & in-flight tracking
const confirmDeletePhotoId = ref('')
const deletingPhotoId = ref('')
const actionError = ref('')

// Lightbox viewer state
const viewerPhotoId = ref('')
const viewerLoading = ref(false)
const viewerError = ref('')

const hasAnythingToShow = computed(() =>
  shouldShowIssuePhotosSection({
    photosCount: props.photos ? props.photos.length : 0,
    canAddPhoto: props.canAddPhoto,
    photosDeleteAt: props.photosDeleteAt,
    uploadQueueCount: uploadQueue.value.length,
    actionError: actionError.value,
  }),
)

const remainingSlots = computed(() => {
  const existing = Array.isArray(props.photos) ? props.photos.length : 0
  const pending = uploadQueue.value.filter((q) => !q.unrecoverable).length
  return Math.max(0, MAX_PHOTOS - existing - pending)
})

const formattedDeleteDate = computed(() => {
  if (!props.photosDeleteAt) return ''
  return formatDate(props.photosDeleteAt, session.lang || 'en')
})

const viewerPhotoIndex = computed(() => {
  if (!viewerPhotoId.value || !Array.isArray(props.photos)) return -1
  return props.photos.findIndex((p) => p.id === viewerPhotoId.value)
})

const viewerSrc = computed(() => {
  if (!viewerPhotoId.value) return ''
  if (displayUrls.value[viewerPhotoId.value]) {
    return displayUrls.value[viewerPhotoId.value]
  }
  if (viewerError.value) {
    return ''
  }
  return thumbUrls.value[viewerPhotoId.value] || ''
})

let isUnmounted = false
let issueAbortController = new AbortController()
let uploadAbortController = new AbortController()
const displayInFlight = new Map()
const pendingQueueTasks = []
let drainQueuePromise = null
let lastSyncAbortReason = ''
let lastPickLimitBanner = false

function resetUploadAbortController() {
  pendingQueueTasks.length = 0
  try {
    uploadAbortController.abort()
  } catch {
    /* ignore */
  }
  uploadAbortController = new AbortController()
}

function resetIssueAbortController() {
  try {
    issueAbortController.abort()
  } catch {
    /* ignore */
  }
  issueAbortController = new AbortController()
  displayInFlight.clear()
  resetUploadAbortController()
}

function revokePhotoUrls(photoId) {
  if (thumbUrls.value[photoId]) {
    safeRevokeObjectUrl(thumbUrls.value[photoId])
    const next = { ...thumbUrls.value }
    delete next[photoId]
    thumbUrls.value = next
  }
  if (displayUrls.value[photoId]) {
    safeRevokeObjectUrl(displayUrls.value[photoId])
    const next = { ...displayUrls.value }
    delete next[photoId]
    displayUrls.value = next
  }
}

function revokeAllCachedPhotoUrls() {
  const allIds = new Set([
    ...Object.keys(thumbUrls.value),
    ...Object.keys(displayUrls.value),
  ])
  for (const id of allIds) {
    revokePhotoUrls(id)
  }
}

function setCachedThumbUrl(photoId, blob) {
  const prev = thumbUrls.value[photoId]
  const nextUrl = URL.createObjectURL(blob)
  if (prev) safeRevokeObjectUrl(prev)
  thumbUrls.value = { ...thumbUrls.value, [photoId]: nextUrl }
}

function setCachedDisplayUrl(photoId, blob) {
  const prev = displayUrls.value[photoId]
  const nextUrl = URL.createObjectURL(blob)
  if (prev) safeRevokeObjectUrl(prev)
  displayUrls.value = { ...displayUrls.value, [photoId]: nextUrl }
}

function formatPhotoError(err) {
  return formatPhotoErrorMessage(err, session.t, session.lang)
}

async function ensureThumbnailLoaded(photo) {
  if (isUnmounted || !photo?.id || !props.issueId) return
  if (thumbUrls.value[photo.id] || thumbLoading.value[photo.id]) return

  const targetIssueId = props.issueId
  const signal = issueAbortController.signal
  thumbLoading.value = { ...thumbLoading.value, [photo.id]: true }
  const nextErrors = { ...thumbErrors.value }
  delete nextErrors[photo.id]
  thumbErrors.value = nextErrors

  try {
    const blob = await fetchIssuePhotoBlob(targetIssueId, photo.id, 'thumb', { signal })
    const stillExists =
      !isUnmounted &&
      !signal.aborted &&
      props.issueId === targetIssueId &&
      (props.photos || []).some((p) => p.id === photo.id)
    if (!stillExists) return
    setCachedThumbUrl(photo.id, blob)
  } catch (err) {
    if (
      isUnmounted ||
      signal.aborted ||
      props.issueId !== targetIssueId ||
      err?.errorCode === 'REQUEST_ABORTED'
    ) {
      return
    }
    if (err?.status === 404 || err?.errorCode === 'PHOTO_NOT_FOUND') {
      emit('photo-gone', photo.id)
    } else {
      thumbErrors.value = { ...thumbErrors.value, [photo.id]: true }
    }
  } finally {
    const nextLoading = { ...thumbLoading.value }
    delete nextLoading[photo.id]
    thumbLoading.value = nextLoading
  }
}

function handleThumbImgError(photoId) {
  if (thumbUrls.value[photoId]) {
    safeRevokeObjectUrl(thumbUrls.value[photoId])
    const next = { ...thumbUrls.value }
    delete next[photoId]
    thumbUrls.value = next
  }
  thumbErrors.value = { ...thumbErrors.value, [photoId]: true }
}

function handleViewerImgError() {
  const photoId = viewerPhotoId.value
  if (photoId && displayUrls.value[photoId]) {
    safeRevokeObjectUrl(displayUrls.value[photoId])
    const next = { ...displayUrls.value }
    delete next[photoId]
    displayUrls.value = next
  }
  viewerError.value = session.t('issues.photos.loadFailed')
}

// Reset transient upload/viewer state and abort in-flight requests when navigating between issues
watch(
  () => props.issueId,
  (nextId, prevId) => {
    if (nextId === prevId) return
    resetIssueAbortController()
    revokeAllCachedPhotoUrls()
    revokeQueuedPhotoPreviews(uploadQueue.value)
    uploadQueue.value = []
    confirmDeletePhotoId.value = ''
    deletingPhotoId.value = ''
    actionError.value = ''
    lastSyncAbortReason = ''
    lastPickLimitBanner = false
    viewerPhotoId.value = ''
    viewerError.value = ''
    viewerLoading.value = false
    thumbErrors.value = {}
    thumbLoading.value = {}
  },
)

// Abort active uploads and cancel unstarted items if canAddPhoto becomes false (#021),
// while keeping already-failed error cards visible so the user sees what failed
watch(
  () => props.canAddPhoto,
  (canAdd) => {
    if (canAdd) {
      actionError.value = ''
      lastSyncAbortReason = ''
      lastPickLimitBanner = false
      return
    }
    const abortReason = lastSyncAbortReason
    lastSyncAbortReason = ''
    resetUploadAbortController()
    if (uploadQueue.value.length > 0) {
      lastPickLimitBanner = false
      const existingCount = Array.isArray(props.photos) ? props.photos.length : 0
      const cancelled = uploadQueue.value.filter((q) => q.status !== 'error')
      const hadRetryableErrors = uploadQueue.value.some((q) => !q.unrecoverable)
      if (cancelled.length > 0) {
        revokeQueuedPhotoPreviews(cancelled)
      }
      uploadQueue.value = uploadQueue.value
        .filter((q) => q.status === 'error')
        .map((q) => (q.unrecoverable ? q : { ...q, unrecoverable: true }))
      if (cancelled.length > 0 || (hadRetryableErrors && !actionError.value)) {
        const resolvedReason = resolveCanAddPhotoFalseReason({
          abortReason,
          existingCount,
          issueOpen: props.issueOpen,
          maxPhotos: MAX_PHOTOS,
        })
        actionError.value = localizeError(resolvedReason, {}, session.lang)
      }
    } else if (!abortReason && lastPickLimitBanner) {
      lastPickLimitBanner = false
      actionError.value = ''
    }
  },
)

watch(
  () => [props.issueId, (props.photos || []).map((p) => `${p.id}:${p.can_delete ? 1 : 0}`).join(',')],
  () => {
    const activeIds = new Set((props.photos || []).map((p) => p.id))
    const allCachedIds = new Set([
      ...Object.keys(thumbUrls.value),
      ...Object.keys(displayUrls.value),
    ])
    for (const cachedId of allCachedIds) {
      if (!activeIds.has(cachedId)) {
        revokePhotoUrls(cachedId)
      }
    }
    if (viewerPhotoId.value && !activeIds.has(viewerPhotoId.value)) {
      viewerPhotoId.value = ''
    }
    if (confirmDeletePhotoId.value) {
      const target = (props.photos || []).find((p) => p.id === confirmDeletePhotoId.value)
      if (!target?.can_delete) {
        confirmDeletePhotoId.value = ''
      }
    }
    for (const photo of props.photos || []) {
      ensureThumbnailLoaded(photo)
    }
  },
  { immediate: true },
)

async function openViewer(photoId) {
  if (isUnmounted || !photoId) return
  const targetIssueId = props.issueId
  const signal = issueAbortController.signal
  viewerPhotoId.value = photoId
  viewerError.value = ''
  if (displayUrls.value[photoId]) {
    viewerLoading.value = false
    return
  }

  viewerLoading.value = true
  let pending = displayInFlight.get(photoId)
  if (!pending) {
    pending = (async () => {
      try {
        const blob = await fetchIssuePhotoBlob(targetIssueId, photoId, 'display', { signal })
        const stillExists =
          !isUnmounted &&
          !signal.aborted &&
          props.issueId === targetIssueId &&
          (props.photos || []).some((p) => p.id === photoId)
        if (!stillExists) return
        setCachedDisplayUrl(photoId, blob)
      } catch (err) {
        if (
          isUnmounted ||
          signal.aborted ||
          props.issueId !== targetIssueId ||
          err?.errorCode === 'REQUEST_ABORTED'
        ) {
          return
        }
        if (err?.status === 404 || err?.errorCode === 'PHOTO_NOT_FOUND') {
          if (viewerPhotoId.value === photoId) {
            viewerPhotoId.value = ''
          }
          emit('photo-gone', photoId)
        } else if (viewerPhotoId.value === photoId) {
          viewerError.value = formatPhotoError(err)
        }
      } finally {
        displayInFlight.delete(photoId)
        if (viewerPhotoId.value === photoId || props.issueId !== targetIssueId) {
          viewerLoading.value = false
        }
      }
    })()
    displayInFlight.set(photoId, pending)
  }
  await pending
}

function closeViewer() {
  viewerPhotoId.value = ''
  viewerError.value = ''
  viewerLoading.value = false
}

function stepViewer(delta) {
  const list = props.photos || []
  if (list.length <= 1 || viewerPhotoIndex.value === -1) return
  const nextIndex = (viewerPhotoIndex.value + delta + list.length) % list.length
  openViewer(list[nextIndex].id)
}

function getQueueItem(localId) {
  return uploadQueue.value.find((q) => q.localId === localId)
}

function updateQueueItem(localId, patch) {
  const idx = uploadQueue.value.findIndex((q) => q.localId === localId)
  if (idx === -1) return
  const updated = [...uploadQueue.value]
  updated[idx] = { ...updated[idx], ...patch }
  uploadQueue.value = updated
}

function removeQueueItem(localId) {
  for (let i = pendingQueueTasks.length - 1; i >= 0; i -= 1) {
    if (pendingQueueTasks[i].localId === localId) {
      pendingQueueTasks.splice(i, 1)
    }
  }
  const item = uploadQueue.value.find((q) => q.localId === localId)
  if (item?.previewUrl) {
    safeRevokeObjectUrl(item.previewUrl)
  }
  uploadQueue.value = uploadQueue.value.filter((q) => q.localId !== localId)
}

function handleWholeIssueUploadAbort(err) {
  lastSyncAbortReason = err?.errorCode || ''
  lastPickLimitBanner = false
  resetUploadAbortController()
  const cancelled = uploadQueue.value.filter((q) => q.status !== 'error')
  if (cancelled.length > 0) {
    revokeQueuedPhotoPreviews(cancelled)
  }
  uploadQueue.value = uploadQueue.value
    .filter((q) => q.status === 'error')
    .map((q) => (q.unrecoverable ? q : { ...q, unrecoverable: true }))
  actionError.value = formatPhotoError(err)
  emit('sync-needed')
}

async function performUpload(localId, signal) {
  if (isUnmounted || signal?.aborted || !props.canAddPhoto) {
    return { ok: false, aborted: true }
  }
  const targetIssueId = props.issueId
  const result = await uploadQueuedPhotoItem(targetIssueId, localId, {
    getItem: getQueueItem,
    updateItem: updateQueueItem,
    signal,
    tFn: session.t,
    lang: session.lang,
  })
  if (result.aborted || signal?.aborted || isUnmounted || props.issueId !== targetIssueId) {
    return { ok: false, aborted: true }
  }
  if (result.ok) {
    removeQueueItem(localId)
    emit('uploaded', result.photo)
    if (uploadQueue.value.length === 0 && lastPickLimitBanner) {
      lastPickLimitBanner = false
      actionError.value = ''
    }
    return { ok: true, photo: result.photo }
  }
  if (result.removed) {
    lastPickLimitBanner = false
    actionError.value = formatPhotoError(result.error)
    removeQueueItem(localId)
    emit('sync-needed')
    return { ok: false, removed: true, error: result.error }
  }
  return { ok: false, error: result.error }
}

async function runSingleQueueTask(task, signal) {
  if (!task || isUnmounted || props.issueId !== task.issueId || !props.canAddPhoto || signal?.aborted) {
    return { ok: false, aborted: true }
  }
  if (!getQueueItem(task.localId)) {
    return { ok: false, aborted: true }
  }
  if (task.kind === 'scale-and-upload') {
    const scaledOk = await scaleQueuedPhotoItem(task.localId, task.file, {
      updateItem: updateQueueItem,
      signal,
      lang: session.lang,
    })
    if (
      isUnmounted ||
      props.issueId !== task.issueId ||
      signal?.aborted ||
      !props.canAddPhoto
    ) {
      return { ok: false, aborted: true }
    }
    if (scaledOk && getQueueItem(task.localId)) {
      return performUpload(task.localId, signal)
    }
    return { ok: false }
  }
  if (task.kind === 'upload') {
    return performUpload(task.localId, signal)
  }
  return { ok: false }
}

function processUploadQueue() {
  if (drainQueuePromise) {
    return drainQueuePromise
  }
  if (pendingQueueTasks.length === 0 || isUnmounted || !props.canAddPhoto) {
    return Promise.resolve()
  }
  const signal = uploadAbortController.signal
  drainQueuePromise = drainPhotoUploadQueue(pendingQueueTasks, {
    concurrency: MAX_CONCURRENT_PHOTO_UPLOADS,
    signal,
    shouldContinue: () => !isUnmounted && props.canAddPhoto,
    worker: (task, workerSignal) => runSingleQueueTask(task, workerSignal),
    onWholeIssueAbort: (err) => {
      handleWholeIssueUploadAbort(err)
    },
  }).finally(() => {
    drainQueuePromise = null
    if (
      pendingQueueTasks.length > 0 &&
      !isUnmounted &&
      props.canAddPhoto &&
      !uploadAbortController.signal.aborted
    ) {
      processUploadQueue()
    }
  })
  return drainQueuePromise
}

async function handleFileInputChange(event) {
  const input = event.target
  const files = Array.from(input?.files || [])
  if (input) input.value = ''
  if (files.length === 0 || isUnmounted || !props.canAddPhoto) return

  lastSyncAbortReason = ''
  const available = remainingSlots.value
  const hitPickLimit = files.length > available
  lastPickLimitBanner = hitPickLimit
  actionError.value = hitPickLimit ? localizeError('PHOTO_LIMIT_REACHED', {}, session.lang) : ''
  const selected = files.slice(0, available)
  if (selected.length === 0) return

  const targetIssueId = props.issueId
  const createdEntries = selected.map((file) =>
    createQueuedPhotoItem(file, { idPrefix: 'q', initialStatus: 'queued' }),
  )
  uploadQueue.value = [...uploadQueue.value, ...createdEntries]

  for (let idx = 0; idx < createdEntries.length; idx += 1) {
    pendingQueueTasks.push({
      kind: 'scale-and-upload',
      localId: createdEntries[idx].localId,
      file: selected[idx],
      issueId: targetIssueId,
    })
  }
  await processUploadQueue()
}

async function handleRetryItem(item) {
  if (
    !item ||
    item.unrecoverable ||
    item.status === 'uploading' ||
    item.status === 'scaling' ||
    isUnmounted ||
    !props.canAddPhoto
  ) {
    return
  }
  if (pendingQueueTasks.some((t) => t.localId === item.localId)) {
    return
  }
  lastSyncAbortReason = ''
  actionError.value = ''
  updateQueueItem(item.localId, { status: 'queued', progress: 0, error: '' })
  pendingQueueTasks.push({
    kind: 'upload',
    localId: item.localId,
    issueId: props.issueId,
  })
  await processUploadQueue()
}

async function handleConfirmDelete(photoId) {
  if (!photoId || deletingPhotoId.value || isUnmounted) return
  const targetIssueId = props.issueId
  deletingPhotoId.value = photoId
  actionError.value = ''
  try {
    await deleteIssuePhoto(targetIssueId, photoId)
    if (isUnmounted || props.issueId !== targetIssueId) return
    confirmDeletePhotoId.value = ''
    revokePhotoUrls(photoId)
    emit('deleted', photoId)
  } catch (err) {
    if (isUnmounted || props.issueId !== targetIssueId) return
    confirmDeletePhotoId.value = ''
    if (err?.status === 404 || err?.errorCode === 'PHOTO_NOT_FOUND') {
      revokePhotoUrls(photoId)
      emit('photo-gone', photoId)
    } else {
      actionError.value = formatPhotoError(err)
    }
  } finally {
    deletingPhotoId.value = ''
  }
}

function handleWindowKeydown(ev) {
  if (!viewerPhotoId.value) return
  if (ev.key === 'Escape') {
    closeViewer()
  } else if (ev.key === 'ArrowLeft') {
    stepViewer(-1)
  } else if (ev.key === 'ArrowRight') {
    stepViewer(1)
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleWindowKeydown)
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
  resetUploadAbortController()
  try {
    issueAbortController.abort()
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleWindowKeydown)
  }
  revokeAllCachedPhotoUrls()
  revokeQueuedPhotoPreviews(uploadQueue.value)
})
</script>

<template>
  <section
    v-if="hasAnythingToShow"
    data-testid="issue-photos-section"
    class="rounded-2xl border border-surface-container bg-surface-container-lowest p-5 sm:p-6 space-y-4"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[18px] text-primary">photo_library</span>
        <span>{{ session.t('issues.photos.title') }}</span>
        <span
          v-if="photos.length > 0"
          class="text-xs font-semibold text-on-surface-variant/80"
        >
          ({{ photos.length }}/3)
        </span>
      </h2>
    </div>

    <!-- #021 Resolved retention notice: shown when issue is RESOLVED and still has photos -->
    <div
      v-if="photosDeleteAt && photos.length > 0"
      data-testid="issue-photos-delete-at-notice"
      class="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
    >
      <span class="material-symbols-outlined text-[17px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
        schedule_send
      </span>
      <span>{{
        session.t('issues.photos.photosWillBeDeletedOn', { date: formattedDeleteDate })
      }}</span>
    </div>

    <!-- Error banner -->
    <div
      v-if="actionError"
      data-testid="issue-photos-error"
      class="rounded-xl border border-error/30 bg-error-container/30 p-3 text-xs text-on-error-container"
    >
      {{ actionError }}
    </div>

    <!-- Thumbnails grid (existing uploaded photos + queued uploads) -->
    <div
      v-if="photos.length > 0 || uploadQueue.length > 0"
      class="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-3"
    >
      <!-- Stored server photos -->
      <div
        v-for="(photo, idx) in photos"
        :key="photo.id"
        :data-testid="`issue-photo-card-${photo.id}`"
        class="group relative rounded-xl border border-surface-container bg-surface-container-low overflow-hidden aspect-[4/3] flex items-center justify-center"
      >
        <button
          v-if="!thumbErrors[photo.id]"
          type="button"
          :data-testid="`issue-photo-thumb-${photo.id}`"
          class="w-full h-full flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
          :aria-label="session.t('issues.photos.openViewer')"
          @click="openViewer(photo.id)"
        >
          <img
            v-if="thumbUrls[photo.id]"
            :src="thumbUrls[photo.id]"
            :alt="session.t('issues.photos.photoAlt', { index: idx + 1 })"
            class="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            @error="handleThumbImgError(photo.id)"
          />
          <span
            v-else
            class="text-xs text-on-surface-variant px-2 text-center"
          >
            {{ session.t('issues.photos.loadingPhoto') }}
          </span>
        </button>
        <div
          v-else
          class="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center"
        >
          <span class="text-xs text-on-surface-variant">
            {{ session.t('issues.photos.loadFailed') }}
          </span>
          <button
            type="button"
            :data-testid="`retry-thumb-${photo.id}`"
            class="rounded-lg bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface hover:bg-surface-container cursor-pointer"
            @click="ensureThumbnailLoaded(photo)"
          >
            {{ session.t('issues.photos.retryLoad') }}
          </button>
        </div>

        <!-- Delete bin icon (visible ONLY when can_delete is true) -->
        <button
          v-if="photo.can_delete && confirmDeletePhotoId !== photo.id"
          type="button"
          :data-testid="`issue-photo-delete-${photo.id}`"
          :title="session.t('issues.photos.deletePhoto')"
          :aria-label="session.t('issues.photos.deletePhoto')"
          class="absolute top-2 right-2 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-black/65 text-white hover:bg-error cursor-pointer transition-colors"
          @click.stop="confirmDeletePhotoId = photo.id"
        >
          <span class="material-symbols-outlined text-[18px]">delete</span>
        </button>

        <!-- Inline delete confirmation overlay -->
        <div
          v-if="photo.can_delete && confirmDeletePhotoId === photo.id"
          class="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-2 p-3 text-center"
        >
          <p class="text-xs font-semibold text-white">
            {{ session.t('issues.photos.deleteConfirm') }}
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/25 cursor-pointer"
              @click.stop="confirmDeletePhotoId = ''"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :data-testid="`confirm-delete-photo-${photo.id}`"
              :disabled="deletingPhotoId === photo.id"
              class="rounded-lg bg-error px-2.5 py-1 text-xs font-semibold text-on-error hover:bg-error/90 cursor-pointer disabled:opacity-60"
              @click.stop="handleConfirmDelete(photo.id)"
            >
              {{ session.t('issues.photos.deletePhoto') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Queued / uploading local previews -->
      <div
        v-for="(item, qIdx) in uploadQueue"
        :key="item.localId"
        :data-testid="`issue-photo-queue-${item.localId}`"
        class="relative rounded-xl border border-surface-container bg-surface-container-low overflow-hidden aspect-[4/3] flex flex-col items-center justify-center"
      >
        <img
          v-if="item.previewUrl"
          :src="item.previewUrl"
          :alt="session.t('issues.photos.photoAlt', { index: photos.length + qIdx + 1 })"
          class="w-full h-full object-cover opacity-70"
        />

        <div class="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-2 p-3 text-center text-white">
          <template v-if="item.status === 'scaling'">
            <span class="text-xs font-semibold">{{ session.t('issues.photos.scaling') }}</span>
          </template>
          <template v-else-if="item.status === 'queued' || item.status === 'ready'">
            <span class="text-xs font-semibold">{{ session.t('issues.photos.queued') }}</span>
            <button
              type="button"
              class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/25 cursor-pointer"
              @click="removeQueueItem(item.localId)"
            >
              {{ session.t('issues.photos.removeQueued') }}
            </button>
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
                v-if="!item.unrecoverable && canAddPhoto"
                type="button"
                :data-testid="`retry-upload-${item.localId}`"
                class="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary hover:bg-primary-container cursor-pointer"
                @click="handleRetryItem(item)"
              >
                {{ session.t('issues.photos.retryPhoto') }}
              </button>
              <button
                type="button"
                class="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/25 cursor-pointer"
                @click="removeQueueItem(item.localId)"
              >
                {{ session.t('issues.photos.removeQueued') }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Pick buttons (shown ONLY while canAddPhoto) + #021 static retention hint -->
    <div v-if="canAddPhoto" class="space-y-2.5 pt-1">
      <div class="flex flex-wrap items-center gap-2.5">
        <input
          ref="cameraInputRef"
          type="file"
          accept="image/*"
          capture="environment"
          data-testid="issue-photo-camera-input"
          class="hidden"
          @change="handleFileInputChange"
        />
        <input
          ref="galleryInputRef"
          type="file"
          accept="image/*"
          multiple
          data-testid="issue-photo-gallery-input"
          class="hidden"
          @change="handleFileInputChange"
        />

        <button
          type="button"
          data-testid="issue-take-photo-btn"
          :disabled="remainingSlots <= 0"
          class="inline-flex items-center gap-1.5 rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-50 transition-colors"
          @click="cameraInputRef?.click()"
        >
          <span class="material-symbols-outlined text-[17px]">photo_camera</span>
          <span>{{ session.t('issues.photos.takePhoto') }}</span>
        </button>

        <button
          type="button"
          data-testid="issue-choose-gallery-btn"
          :disabled="remainingSlots <= 0"
          class="inline-flex items-center gap-1.5 rounded-xl border border-surface-container-high bg-surface-container-low px-3.5 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-50 transition-colors"
          @click="galleryInputRef?.click()"
        >
          <span class="material-symbols-outlined text-[17px]">photo_library</span>
          <span>{{ session.t('issues.photos.chooseFromGallery') }}</span>
        </button>
      </div>

      <p
        data-testid="issue-photos-retention-hint"
        class="text-xs text-on-surface-variant leading-relaxed"
      >
        {{ session.t('issues.photos.retentionHint') }}
      </p>
    </div>

    <!-- Lightbox Modal for full display photo -->
    <Teleport to="body">
      <div
        v-if="viewerPhotoId"
        data-testid="issue-photo-viewer-modal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
        @click.self="closeViewer"
      >
        <div class="relative max-w-4xl w-full flex flex-col items-center gap-3">
          <div class="w-full flex items-center justify-between text-white">
            <span class="text-xs font-semibold opacity-80">
              {{ viewerPhotoIndex >= 0 ? `${viewerPhotoIndex + 1} / ${photos.length}` : '' }}
            </span>
            <button
              type="button"
              data-testid="issue-photo-viewer-close"
              class="inline-flex items-center gap-1 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25 cursor-pointer"
              @click="closeViewer"
            >
              <span class="material-symbols-outlined text-[18px]">close</span>
              <span>{{ session.t('issues.photos.closeViewer') }}</span>
            </button>
          </div>

          <div class="relative w-full flex items-center justify-center min-h-[40vh] max-h-[80vh]">
            <img
              v-if="viewerSrc"
              :src="viewerSrc"
              :alt="session.t('issues.photos.photoAlt', { index: viewerPhotoIndex + 1 })"
              class="max-w-full max-h-[80vh] rounded-xl object-contain shadow-2xl"
              @error="handleViewerImgError"
            />
            <p v-else-if="viewerLoading" class="text-sm text-white/80">
              {{ session.t('issues.photos.loadingPhoto') }}
            </p>
            <div v-else-if="viewerError" class="flex flex-col items-center gap-3 text-center">
              <p class="text-sm text-rose-300">
                {{ viewerError }}
              </p>
              <button
                type="button"
                data-testid="retry-viewer-photo"
                class="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25 cursor-pointer"
                @click="openViewer(viewerPhotoId)"
              >
                {{ session.t('issues.photos.retryLoad') }}
              </button>
            </div>

            <button
              v-if="photos.length > 1"
              type="button"
              :aria-label="session.t('issues.photos.prevPhoto')"
              class="absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 cursor-pointer"
              @click.stop="stepViewer(-1)"
            >
              <span class="material-symbols-outlined text-[22px]">chevron_left</span>
            </button>
            <button
              v-if="photos.length > 1"
              type="button"
              :aria-label="session.t('issues.photos.nextPhoto')"
              class="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 cursor-pointer"
              @click.stop="stepViewer(1)"
            >
              <span class="material-symbols-outlined text-[22px]">chevron_right</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
