<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { listPosts } from '@/api/endpoints/communication.js'
import { listPeriods } from '@/api/endpoints/meters.js'
import { getDocumentUploadOptions, listDocuments } from '@/api/endpoints/documents.js'
import { DOCUMENT_CATEGORIES, MAX_DOCUMENT_BYTES } from '@/utils/documents.js'
import NoticeList from './components/NoticeList.vue'
import ReadingReportList from './components/ReadingReportList.vue'
import AssociationFileGrid from './components/AssociationFileGrid.vue'
import DocumentUploadModal from './components/DocumentUploadModal.vue'
import DocumentEditModal from './components/DocumentEditModal.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const DOCUMENTS_PAGE_SIZE = 50

const session = useSessionStore()
const { canViewMatrix } = useRole()

const notices = ref([])
const periods = ref([
  { code: '2026-10', status: 'OPEN_FOR_RESIDENTS' },
  { code: '2026-09', status: 'LOCKED' },
  { code: '2026-08', status: 'LOCKED' },
])
const loading = ref(false)
const error = ref(null)

const documents = ref([])
const docsLoading = ref(false)
const docsError = ref(null)
const selectedCategory = ref('')
const docsOffset = ref(0)
function defaultUploadOptions() {
  return {
    can_upload: false,
    audiences: [],
    categories: DOCUMENT_CATEGORIES,
    max_bytes: MAX_DOCUMENT_BYTES,
  }
}

const uploadOptions = ref(defaultUploadOptions())

const uploadModalOpen = ref(false)
const editingDocument = ref(null)
const feedbackMessage = ref('')

let isUnmounted = false
let pageLoadSeq = 0
let docsLoadSeq = 0
let pageController = null
let docsController = null

const docsPage = computed(() => Math.floor(docsOffset.value / DOCUMENTS_PAGE_SIZE) + 1)
const canLoadPrevDocs = computed(() => docsOffset.value > 0)
const hasMoreDocs = computed(() => documents.value.length >= DOCUMENTS_PAGE_SIZE)

function abortController(ctrl) {
  if (ctrl) {
    try {
      ctrl.abort()
    } catch {
      /* ignore */
    }
  }
}

function isAbortErr(err) {
  return (
    err?.name === 'AbortError' ||
    err?.errorCode === 'REQUEST_ABORTED' ||
    err?.errorCode === 'UPLOAD_ABORTED'
  )
}

function resetDocumentsViewState() {
  pageLoadSeq += 1
  docsLoadSeq += 1
  abortController(pageController)
  abortController(docsController)
  pageController = null
  docsController = null
  uploadModalOpen.value = false
  editingDocument.value = null
  selectedCategory.value = ''
  docsOffset.value = 0
  feedbackMessage.value = ''
  documents.value = []
  notices.value = []
  uploadOptions.value = defaultUploadOptions()
  docsError.value = null
  error.value = null
  docsLoading.value = false
  loading.value = false
}

async function loadDocumentsOnly({ preserveFeedback = true } = {}) {
  if (!session.actingUserId || isUnmounted) return
  if (!preserveFeedback) {
    feedbackMessage.value = ''
  }

  const seq = ++docsLoadSeq
  abortController(docsController)
  const myController = new AbortController()
  docsController = myController
  const { signal } = myController

  docsLoading.value = true
  docsError.value = null

  try {
    const [docsData, optionsData] = await Promise.all([
      listDocuments(
        {
          category: selectedCategory.value || undefined,
          limit: DOCUMENTS_PAGE_SIZE,
          offset: docsOffset.value,
        },
        { signal },
      ),
      getDocumentUploadOptions({ signal }).catch(() => defaultUploadOptions()),
    ])
    if (isUnmounted || seq !== docsLoadSeq) return
    documents.value = Array.isArray(docsData) ? docsData : []
    if (optionsData && typeof optionsData === 'object') {
      uploadOptions.value = {
        can_upload: Boolean(optionsData.can_upload),
        audiences: Array.isArray(optionsData.audiences) ? optionsData.audiences : [],
        categories:
          Array.isArray(optionsData.categories) && optionsData.categories.length > 0
            ? optionsData.categories
            : DOCUMENT_CATEGORIES,
        max_bytes: Number(optionsData.max_bytes || MAX_DOCUMENT_BYTES),
      }
    }
  } catch (err) {
    if (isUnmounted || seq !== docsLoadSeq) return
    if (isAbortErr(err)) return
    documents.value = []
    uploadOptions.value = defaultUploadOptions()
    docsError.value = err
  } finally {
    if (seq === docsLoadSeq) {
      docsLoading.value = false
      if (docsController === myController) {
        docsController = null
      }
    }
  }
}

async function loadDocumentsData() {
  if (!session.actingUserId || isUnmounted) return
  const seq = ++pageLoadSeq
  abortController(pageController)
  const myController = new AbortController()
  pageController = myController
  const { signal } = myController

  loading.value = true
  error.value = null

  const docsPromise = loadDocumentsOnly({ preserveFeedback: false })
  try {
    const [noticeData, periodsData] = await Promise.all([
      listPosts({ post_type: 'OFFICIAL_NOTICE', limit: 20 }, { signal }),
      listPeriods({ signal }).catch(() => []),
    ])
    if (isUnmounted || seq !== pageLoadSeq) return
    notices.value = Array.isArray(noticeData) ? noticeData : []
    if (Array.isArray(periodsData) && periodsData.length > 0) {
      periods.value = periodsData.map((p) => ({
        code: p.period_code,
        status: p.status,
        due_date: p.due_date,
      }))
    }
  } catch (err) {
    if (isUnmounted || seq !== pageLoadSeq) return
    if (isAbortErr(err)) return
    notices.value = []
    error.value = err
  } finally {
    if (seq === pageLoadSeq) {
      loading.value = false
      if (pageController === myController) {
        pageController = null
      }
    }
  }
  await docsPromise
}

function handleCategoryChange(nextCategory) {
  selectedCategory.value = nextCategory || ''
  docsOffset.value = 0
  loadDocumentsOnly({ preserveFeedback: false })
}

function handlePrevDocsPage() {
  if (docsOffset.value <= 0) return
  docsOffset.value = Math.max(0, docsOffset.value - DOCUMENTS_PAGE_SIZE)
  loadDocumentsOnly({ preserveFeedback: false })
}

function handleNextDocsPage() {
  if (!hasMoreDocs.value) return
  docsOffset.value += DOCUMENTS_PAGE_SIZE
  loadDocumentsOnly({ preserveFeedback: false })
}

function handleDocumentUploaded() {
  feedbackMessage.value = session.t('documents.uploadedToast')
  docsOffset.value = 0
  loadDocumentsOnly({ preserveFeedback: true })
}

function handleDocumentSaved() {
  feedbackMessage.value = session.t('documents.updatedToast')
  loadDocumentsOnly({ preserveFeedback: true })
}

function handleDocumentDeleted() {
  feedbackMessage.value = session.t('documents.deletedToast')
  if (documents.value.length <= 1 && docsOffset.value > 0) {
    docsOffset.value = Math.max(0, docsOffset.value - DOCUMENTS_PAGE_SIZE)
  }
  loadDocumentsOnly({ preserveFeedback: true })
}

watch(
  () => [session.actingUserId, session.sessionRevision],
  () => {
    resetDocumentsViewState()
    if (session.actingUserId && !isUnmounted) {
      loadDocumentsData()
    }
  },
)

onMounted(() => {
  if (session.actingUserId) {
    loadDocumentsData()
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
  abortController(pageController)
  abortController(docsController)
})
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-gutter py-space-lg space-y-6">
    <div>
      <span class="text-[11px] font-bold uppercase tracking-widest text-primary block mb-1">
        {{ session.buildingName }} • Reg {{ session.buildingRegistryCode }}
      </span>
      <h1 class="text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
        {{ session.t('documents.title') }}
      </h1>
      <p class="text-sm text-on-surface-variant mt-1">
        {{ session.t('documents.subtitle') }}
      </p>
    </div>

    <BaseSkeleton v-if="loading" :lines="3" />

    <ErrorCard
      v-else-if="error"
      :error="error"
      @retry="loadDocumentsData"
    />

    <template v-else>
      <!-- CSV Accounting Exports (Board / Chairman / Accountant only) -->
      <ReadingReportList
        v-if="canViewMatrix"
        :periods="periods"
      />

      <!-- Association Bylaws, Minutes, Contracts & Reports -->
      <AssociationFileGrid
        :documents="documents"
        :upload-options="uploadOptions"
        :selected-category="selectedCategory"
        :loading="docsLoading"
        :error="docsError"
        :page="docsPage"
        :can-load-prev="canLoadPrevDocs"
        :has-more="hasMoreDocs"
        :feedback-message="feedbackMessage"
        @update:selected-category="handleCategoryChange"
        @prev-page="handlePrevDocsPage"
        @next-page="handleNextDocsPage"
        @retry="loadDocumentsOnly({ preserveFeedback: false })"
        @open-upload="uploadModalOpen = true"
        @open-edit="editingDocument = $event"
        @deleted="handleDocumentDeleted"
      />

      <!-- Official Notices Archive from GET /communication/posts?post_type=OFFICIAL_NOTICE -->
      <NoticeList :notices="notices" />
    </template>

    <DocumentUploadModal
      :open="uploadModalOpen"
      :upload-options="uploadOptions"
      @close="uploadModalOpen = false"
      @uploaded="handleDocumentUploaded"
    />

    <DocumentEditModal
      :open="Boolean(editingDocument)"
      :document="editingDocument"
      :audiences="uploadOptions.audiences"
      :categories="uploadOptions.categories"
      @close="editingDocument = null"
      @saved="handleDocumentSaved"
    />
  </div>
</template>
