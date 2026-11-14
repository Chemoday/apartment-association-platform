<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { deleteDocument, downloadDocumentFile } from '@/api/endpoints/documents.js'
import {
  DOCUMENT_CATEGORIES,
  MAX_DOCUMENT_BYTES,
  formatDocumentErrorMessage,
  formatDocumentSize,
  isStaffRole,
  parseContentDispositionFilename,
  resolveDocumentCategoryKey,
} from '@/utils/documents.js'
import { formatDate } from '@/utils/dates.js'
import BaseCard from '@/components/base/BaseCard.vue'
import BaseChip from '@/components/base/BaseChip.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseEmptyState from '@/components/base/BaseEmptyState.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const CATEGORY_ICONS = {
  ARTICLES: 'gavel',
  GENERAL_MEETING_MINUTES: 'assignment',
  BOARD_MINUTES: 'groups',
  CONTRACT: 'handshake',
  INVOICE: 'receipt_long',
  FINANCIAL_REPORT: 'account_balance',
  INSURANCE: 'verified_user',
  HOUSE_RULES: 'menu_book',
  OTHER: 'description',
}

const props = defineProps({
  documents: {
    type: Array,
    default: () => [],
  },
  uploadOptions: {
    type: Object,
    default: () => ({
      can_upload: false,
      audiences: [],
      categories: DOCUMENT_CATEGORIES,
      max_bytes: MAX_DOCUMENT_BYTES,
    }),
  },
  selectedCategory: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: Object,
    default: null,
  },
  page: {
    type: Number,
    default: 1,
  },
  canLoadPrev: {
    type: Boolean,
    default: false,
  },
  hasMore: {
    type: Boolean,
    default: false,
  },
  feedbackMessage: {
    type: String,
    default: '',
  },
})

const emit = defineEmits([
  'update:selectedCategory',
  'prev-page',
  'next-page',
  'retry',
  'open-upload',
  'open-edit',
  'deleted',
])

const session = useSessionStore()

const downloadingId = ref('')
const confirmingDeleteId = ref('')
const deletingId = ref('')
const actionErrors = ref({})

let isUnmounted = false
let roleEpoch = 0
const activeControllers = new Map()
const pendingRevokes = new Set()

const isStaff = computed(() => isStaffRole(session.buildingRole))
const canUpload = computed(() => Boolean(props.uploadOptions?.can_upload))
const categoryFilterOptions = computed(() => {
  const fromServer = Array.isArray(props.uploadOptions?.categories)
    ? props.uploadOptions.categories
    : []
  const merged = [...DOCUMENT_CATEGORIES]
  for (const c of fromServer) {
    if (c && !merged.includes(c)) merged.push(c)
  }
  return merged
})

const isForbiddenError = computed(() => {
  const err = props.error
  if (!err) return false
  return err.status === 403 || err.errorCode === 'FORBIDDEN' || err.payload?.error_code === 'FORBIDDEN'
})

function isAbortErr(err) {
  return (
    err?.name === 'AbortError' ||
    err?.errorCode === 'REQUEST_ABORTED' ||
    err?.errorCode === 'UPLOAD_ABORTED'
  )
}

function scheduleObjectUrlRevoke(url) {
  const entry = { timerId: null, url }
  entry.timerId = setTimeout(() => {
    pendingRevokes.delete(entry)
    try {
      URL.revokeObjectURL(entry.url)
    } catch {
      /* ignore */
    }
  }, 1000)
  pendingRevokes.add(entry)
}

function clearPendingRevokes() {
  for (const entry of pendingRevokes) {
    clearTimeout(entry.timerId)
    try {
      URL.revokeObjectURL(entry.url)
    } catch {
      /* ignore */
    }
  }
  pendingRevokes.clear()
}

function abortController(key) {
  const ctrl = activeControllers.get(key)
  if (ctrl) {
    try {
      ctrl.abort()
    } catch {
      /* ignore */
    }
    activeControllers.delete(key)
  }
}

function abortAllControllers() {
  for (const key of Array.from(activeControllers.keys())) {
    abortController(key)
  }
}

watch(
  () => [session.actingUserId, session.sessionRevision],
  () => {
    roleEpoch += 1
    abortAllControllers()
    downloadingId.value = ''
    confirmingDeleteId.value = ''
    deletingId.value = ''
    actionErrors.value = {}
  },
)

onBeforeUnmount(() => {
  isUnmounted = true
  roleEpoch += 1
  abortAllControllers()
  clearPendingRevokes()
})

function categoryIcon(category) {
  return CATEGORY_ICONS[resolveDocumentCategoryKey(category)] || 'description'
}

function localizedCategory(category) {
  const key = resolveDocumentCategoryKey(category)
  return session.t(`documents.categories.${key}`)
}

function audienceTone(audience) {
  if (audience === 'BOARD') return 'warning'
  if (audience === 'BOARD_AND_ACCOUNTANT') return 'primary'
  return 'neutral'
}

function documentDateDisplay(doc) {
  return formatDate(doc.document_date || doc.created_at, session.lang)
}

function setDocActionError(docId, message) {
  actionErrors.value = { ...actionErrors.value, [docId]: message }
}

function clearDocActionError(docId) {
  if (!actionErrors.value[docId]) return
  const next = { ...actionErrors.value }
  delete next[docId]
  actionErrors.value = next
}

async function handleDownload(doc) {
  if (!doc || downloadingId.value) return
  clearDocActionError(doc.id)
  downloadingId.value = doc.id

  const myEpoch = roleEpoch
  const ctrlKey = `dl:${doc.id}`
  abortController(ctrlKey)
  const ctrl = new AbortController()
  activeControllers.set(ctrlKey, ctrl)

  try {
    const response = await downloadDocumentFile(doc.id, { signal: ctrl.signal })
    if (isUnmounted || myEpoch !== roleEpoch) return
    const blob = await response.blob()
    if (isUnmounted || myEpoch !== roleEpoch) return

    const disposition =
      response?.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-disposition')
        : ''
    const fileName = parseContentDispositionFilename(disposition, doc.title)
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    try {
      link.href = objectUrl
      link.download = fileName
      link.rel = 'noopener'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
    } finally {
      if (link.parentNode) {
        link.parentNode.removeChild(link)
      }
      scheduleObjectUrlRevoke(objectUrl)
    }
  } catch (err) {
    if (isUnmounted || myEpoch !== roleEpoch) return
    if (isAbortErr(err)) return
    setDocActionError(doc.id, formatDocumentErrorMessage(err, session.t, session.lang))
  } finally {
    if (activeControllers.get(ctrlKey) === ctrl) {
      activeControllers.delete(ctrlKey)
    }
    if (myEpoch === roleEpoch && downloadingId.value === doc.id) {
      downloadingId.value = ''
    }
  }
}

async function confirmDelete(doc) {
  if (!doc || !doc.can_delete || deletingId.value) return
  clearDocActionError(doc.id)
  deletingId.value = doc.id

  const myEpoch = roleEpoch
  const ctrlKey = `del:${doc.id}`
  abortController(ctrlKey)
  const ctrl = new AbortController()
  activeControllers.set(ctrlKey, ctrl)

  try {
    await deleteDocument(doc.id, { signal: ctrl.signal })
    if (isUnmounted || myEpoch !== roleEpoch) return
    confirmingDeleteId.value = ''
    emit('deleted', doc)
  } catch (err) {
    if (isUnmounted || myEpoch !== roleEpoch) return
    if (isAbortErr(err)) return
    confirmingDeleteId.value = ''
    setDocActionError(doc.id, formatDocumentErrorMessage(err, session.t, session.lang))
  } finally {
    if (activeControllers.get(ctrlKey) === ctrl) {
      activeControllers.delete(ctrlKey)
    }
    if (myEpoch === roleEpoch && deletingId.value === doc.id) {
      deletingId.value = ''
    }
  }
}
</script>

<template>
  <BaseCard>
    <!-- Header + Controls -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="w-8 h-8 rounded-lg bg-surface-container-high text-primary inline-flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[18px]">folder_open</span>
        </span>
        <div class="min-w-0">
          <h2 class="text-base font-bold text-on-surface">
            {{ session.t('documents.filesTitle') }}
          </h2>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('documents.filesSub') }}
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5 shrink-0">
        <select
          v-if="!isForbiddenError"
          :value="selectedCategory"
          :aria-label="session.t('documents.categoryLabel')"
          class="rounded-lg border border-surface-container-highest bg-surface-container-lowest px-3 py-1.5 text-xs font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          @change="$emit('update:selectedCategory', $event.target.value)"
        >
          <option value="">{{ session.t('documents.allCategories') }}</option>
          <option
            v-for="cat in categoryFilterOptions"
            :key="cat"
            :value="cat"
          >
            {{ session.t(`documents.categories.${resolveDocumentCategoryKey(cat)}`) }}
          </option>
        </select>

        <BaseButton
          v-if="canUpload && !error"
          variant="primary"
          size="sm"
          @click="$emit('open-upload')"
        >
          <span class="material-symbols-outlined text-[16px]">upload_file</span>
          <span>{{ session.t('documents.uploadButton') }}</span>
        </BaseButton>
      </div>
    </div>

    <!-- Brief feedback toast/banner -->
    <div
      v-if="feedbackMessage"
      role="status"
      class="mb-4 px-3.5 py-2.5 rounded-lg bg-primary/10 border border-primary/25 text-xs font-semibold text-primary flex items-center gap-2"
    >
      <span class="material-symbols-outlined text-[16px]">check_circle</span>
      <span>{{ feedbackMessage }}</span>
    </div>

    <!-- Loading -->
    <BaseSkeleton v-if="loading" :lines="3" />

    <!-- 403 Forbidden -->
    <BaseEmptyState
      v-else-if="isForbiddenError"
      icon="lock"
      :title="session.t('documents.forbiddenTitle')"
      :subtitle="session.t('documents.forbiddenSub')"
    />

    <!-- Other API Error -->
    <ErrorCard
      v-else-if="error"
      :error="error"
      @retry="$emit('retry')"
    />

    <!-- Empty State -->
    <BaseEmptyState
      v-else-if="!documents.length"
      icon="folder_off"
      :title="
        selectedCategory
          ? session.t('documents.emptyFilteredTitle')
          : session.t('documents.emptyTitle')
      "
      :subtitle="
        selectedCategory
          ? session.t('documents.emptyFilteredSub')
          : session.t('documents.emptySub')
      "
    >
      <template v-if="selectedCategory" #action>
        <BaseButton variant="secondary" size="sm" @click="$emit('update:selectedCategory', '')">
          {{ session.t('documents.allCategories') }}
        </BaseButton>
      </template>
    </BaseEmptyState>

    <!-- Document List -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <article
        v-for="doc in documents"
        :key="doc.id"
        class="p-4 rounded-xl bg-surface-container-low/60 border border-surface-container-high flex flex-col justify-between gap-3"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-3 min-w-0">
            <div class="w-10 h-10 rounded-lg bg-surface-container-lowest border border-surface-container-high flex items-center justify-center text-primary shrink-0">
              <span class="material-symbols-outlined text-[20px]">
                {{ categoryIcon(doc.category) }}
              </span>
            </div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5 mb-1">
                <BaseChip tone="neutral">
                  {{ localizedCategory(doc.category) }}
                </BaseChip>
                <BaseChip
                  v-if="isStaff && doc.audience"
                  :tone="audienceTone(doc.audience)"
                >
                  {{ session.t(`documents.audiences.${doc.audience}`) }}
                </BaseChip>
                <span class="text-[11px] font-mono text-on-surface-variant">
                  {{ documentDateDisplay(doc) }}
                </span>
              </div>

              <h3 class="text-sm font-bold text-on-surface leading-snug break-words">
                {{ doc.title }}
              </h3>

              <div
                v-if="isStaff && doc.uploaded_by"
                class="mt-1.5 flex items-center gap-1.5 text-xs text-on-surface-variant"
              >
                <span>{{ session.t('documents.uploadedByLabel') }}:</span>
                <AuthorBadge :badge="doc.uploaded_by" :is-mine="Boolean(doc.mine)" />
              </div>
            </div>
          </div>

          <span class="px-2 py-0.5 rounded bg-surface-container-high text-[10px] font-mono font-bold text-on-surface-variant shrink-0">
            PDF • {{ formatDocumentSize(doc.size_bytes, session.lang) }}
          </span>
        </div>

        <!-- Inline error on this document -->
        <div
          v-if="actionErrors[doc.id]"
          role="alert"
          class="px-3 py-2 rounded-lg bg-error-container/60 border border-error/30 text-xs text-on-error-container flex items-center gap-1.5"
        >
          <span class="material-symbols-outlined text-[15px] text-error shrink-0">error</span>
          <span>{{ actionErrors[doc.id] }}</span>
        </div>

        <!-- Delete confirmation prompt (Chairman only) -->
        <div
          v-if="doc.can_delete && confirmingDeleteId === doc.id"
          class="p-2.5 rounded-lg bg-error-container/40 border border-error/30 flex flex-wrap items-center justify-between gap-2"
        >
          <span class="text-xs font-semibold text-on-surface">
            {{ session.t('documents.confirmDeletePrompt') }}
          </span>
          <div class="flex items-center gap-2 shrink-0">
            <BaseButton
              variant="secondary"
              size="sm"
              :disabled="deletingId === doc.id"
              @click="confirmingDeleteId = ''"
            >
              {{ session.t('documents.cancelBtn') }}
            </BaseButton>
            <BaseButton
              variant="danger"
              size="sm"
              :disabled="deletingId === doc.id"
              @click="confirmDelete(doc)"
            >
              {{
                deletingId === doc.id
                  ? session.t('documents.deletingBtn')
                  : session.t('documents.confirmDeleteBtn')
              }}
            </BaseButton>
          </div>
        </div>

        <!-- Card actions -->
        <div
          v-else
          class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-surface-container-high/80"
        >
          <div class="flex items-center gap-1.5">
            <BaseButton
              v-if="doc.can_edit"
              variant="secondary"
              size="sm"
              @click="$emit('open-edit', doc)"
            >
              <span class="material-symbols-outlined text-[15px]">edit</span>
              <span>{{ session.t('documents.editBtn') }}</span>
            </BaseButton>

            <BaseButton
              v-if="doc.can_delete"
              variant="secondary"
              size="sm"
              @click="confirmingDeleteId = doc.id"
            >
              <span class="material-symbols-outlined text-[15px] text-error">delete</span>
              <span class="text-error">{{ session.t('documents.deleteBtn') }}</span>
            </BaseButton>
          </div>

          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="downloadingId === doc.id"
            @click="handleDownload(doc)"
          >
            <span class="material-symbols-outlined text-[16px]">download</span>
            <span>
              {{
                downloadingId === doc.id
                  ? session.t('documents.downloadingBtn')
                  : session.t('documents.downloadBtn')
              }}
            </span>
          </BaseButton>
        </div>
      </article>
    </div>

    <!-- Pagination (rendered outside list/empty states so Previous remains reachable on empty page >= 2) -->
    <div
      v-if="!loading && !error && (canLoadPrev || hasMore)"
      class="mt-4 pt-3 flex items-center justify-between border-t border-surface-container-high"
    >
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!canLoadPrev || loading"
        @click="$emit('prev-page')"
      >
        <span class="material-symbols-outlined text-[16px]">chevron_left</span>
        <span>{{ session.t('documents.prevPageBtn') }}</span>
      </BaseButton>

      <span class="text-xs font-mono text-on-surface-variant">
        {{ session.t('documents.pageIndicator', { page }) }}
      </span>

      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="!hasMore || loading"
        @click="$emit('next-page')"
      >
        <span>{{ session.t('documents.nextPageBtn') }}</span>
        <span class="material-symbols-outlined text-[16px]">chevron_right</span>
      </BaseButton>
    </div>
  </BaseCard>
</template>
