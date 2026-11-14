<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { uploadDocument } from '@/api/endpoints/documents.js'
import {
  DOCUMENT_CATEGORIES,
  MAX_DOCUMENT_BYTES,
  MIN_DOCUMENT_DATE,
  extractDocumentFieldErrors,
  formatDocumentErrorMessage,
  formatDocumentSize,
  generateDocumentIdempotencyKey,
  getMaxDocumentDate,
  inspectPdfBlob,
  isDocumentUploadErrorRetryable,
  prefillDocumentTitleFromFilename,
  resolveDocumentCategoryKey,
  validateDocumentDraft,
} from '@/utils/documents.js'
import BaseModal from '@/components/base/BaseModal.vue'
import BaseButton from '@/components/base/BaseButton.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
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
})

const emit = defineEmits(['close', 'uploaded'])

const session = useSessionStore()

const fileInputRef = ref(null)
const selectedFile = ref(null)
const idempotencyKey = ref('')
const titleEditedManually = ref(false)
const draft = ref({
  title: '',
  category: 'GENERAL_MEETING_MINUTES',
  audience: '',
  document_date: '',
})
const fieldErrors = ref({})
const apiError = ref('')
const canRetry = ref(false)
const uploadRemovedTerminal = ref(false)
const inspectingFile = ref(false)
const uploading = ref(false)
const uploadPercent = ref(0)

let isUnmounted = false
let pickEpoch = 0
let uploadAbortController = null

const maxBytes = computed(() => Number(props.uploadOptions?.max_bytes || MAX_DOCUMENT_BYTES))
const maxMb = computed(() => Math.max(1, Math.round(maxBytes.value / 1_000_000)))
const allowedAudiences = computed(() =>
  Array.isArray(props.uploadOptions?.audiences) ? props.uploadOptions.audiences : [],
)
const allowedCategories = computed(() =>
  Array.isArray(props.uploadOptions?.categories) && props.uploadOptions.categories.length > 0
    ? props.uploadOptions.categories
    : DOCUMENT_CATEGORIES,
)
const maxDate = computed(() => getMaxDocumentDate())

function defaultCategoryForOptions() {
  const cats = allowedCategories.value
  if (allowedAudiences.value.length === 1 && cats.includes('INVOICE')) {
    return 'INVOICE'
  }
  return cats[0] || 'OTHER'
}

function abortActiveUpload() {
  if (uploadAbortController) {
    try {
      uploadAbortController.abort()
    } catch {
      /* ignore */
    }
    uploadAbortController = null
  }
}

function resetModalState() {
  pickEpoch += 1
  abortActiveUpload()
  selectedFile.value = null
  idempotencyKey.value = ''
  titleEditedManually.value = false
  draft.value = {
    title: '',
    category: defaultCategoryForOptions(),
    audience: allowedAudiences.value[0] || '',
    document_date: '',
  }
  fieldErrors.value = {}
  apiError.value = ''
  canRetry.value = false
  uploadRemovedTerminal.value = false
  inspectingFile.value = false
  uploading.value = false
  uploadPercent.value = 0
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetModalState()
    } else {
      pickEpoch += 1
      inspectingFile.value = false
      uploading.value = false
      abortActiveUpload()
    }
  },
)

onBeforeUnmount(() => {
  isUnmounted = true
  pickEpoch += 1
  abortActiveUpload()
})

function handleClose() {
  pickEpoch += 1
  abortActiveUpload()
  emit('close')
}

function handleTitleInput(event) {
  titleEditedManually.value = true
  draft.value.title = event?.target?.value ?? ''
  if (fieldErrors.value.title) {
    fieldErrors.value = { ...fieldErrors.value, title: '' }
  }
}

async function handleFileChange(event) {
  const input = event?.target
  const file = input?.files?.[0] || null
  if (input) input.value = ''
  if (!file || uploading.value || isUnmounted || !props.open) return

  const currentPickEpoch = ++pickEpoch
  inspectingFile.value = true
  fieldErrors.value = { ...fieldErrors.value, file: '' }
  apiError.value = ''
  canRetry.value = false
  uploadRemovedTerminal.value = false
  uploadPercent.value = 0

  let inspection
  try {
    inspection = await inspectPdfBlob(file, maxBytes.value)
  } catch {
    inspection = { ok: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE' }
  } finally {
    if (currentPickEpoch === pickEpoch) {
      inspectingFile.value = false
    }
  }

  if (uploading.value || isUnmounted || !props.open || currentPickEpoch !== pickEpoch) return

  if (!inspection.ok) {
    selectedFile.value = null
    idempotencyKey.value = ''
    fieldErrors.value = {
      ...fieldErrors.value,
      file:
        inspection.errorCode === 'FILE_TOO_LARGE'
          ? session.t('documents.validation.FILE_TOO_LARGE', { max_mb: maxMb.value })
          : session.t('documents.validation.UNSUPPORTED_MEDIA_TYPE'),
    }
    return
  }

  selectedFile.value = file
  idempotencyKey.value = generateDocumentIdempotencyKey()
  if (!titleEditedManually.value || !draft.value.title.trim()) {
    draft.value.title = prefillDocumentTitleFromFilename(file.name)
    titleEditedManually.value = false
    if (fieldErrors.value.title) {
      fieldErrors.value = { ...fieldErrors.value, title: '' }
    }
  }
}

function localizedValidationError(field, code) {
  if (code === 'FILE_TOO_LARGE') {
    return session.t('documents.validation.FILE_TOO_LARGE', { max_mb: maxMb.value })
  }
  return session.t(`documents.validation.${code}`)
}

async function submitUpload() {
  if (uploading.value || inspectingFile.value || uploadRemovedTerminal.value) return

  const check = validateDocumentDraft(draft.value, {
    requireFile: true,
    file: selectedFile.value,
    fileIsPdf: true,
    maxBytes: maxBytes.value,
    allowedAudiences: allowedAudiences.value,
    allowedCategories: allowedCategories.value,
  })

  if (!check.valid) {
    const mapped = {}
    for (const [k, code] of Object.entries(check.fieldErrors)) {
      mapped[k] = localizedValidationError(k, code)
    }
    fieldErrors.value = mapped
    return
  }

  if (!idempotencyKey.value) {
    idempotencyKey.value = generateDocumentIdempotencyKey()
  }

  fieldErrors.value = {}
  apiError.value = ''
  canRetry.value = false
  uploading.value = true
  uploadPercent.value = 0

  const submitEpoch = pickEpoch
  abortActiveUpload()
  const myController = new AbortController()
  uploadAbortController = myController

  try {
    const createdDoc = await uploadDocument(selectedFile.value, check.payload, {
      idempotencyKey: idempotencyKey.value,
      signal: myController.signal,
      onProgress: (loaded, total) => {
        if (isUnmounted || !props.open || submitEpoch !== pickEpoch) return
        if (total > 0) {
          uploadPercent.value = Math.min(100, Math.round((loaded / total) * 100))
        }
      },
    })
    if (isUnmounted || !props.open || submitEpoch !== pickEpoch) return
    emit('uploaded', createdDoc)
    emit('close')
  } catch (err) {
    if (isUnmounted || !props.open || submitEpoch !== pickEpoch) return
    if (err?.name === 'AbortError' || err?.errorCode === 'UPLOAD_ABORTED' || err?.errorCode === 'REQUEST_ABORTED') {
      return
    }

    const code = err?.errorCode || err?.payload?.error_code || ''
    const srvFields = extractDocumentFieldErrors(err, session.t, session.lang)
    if (Object.keys(srvFields).length > 0) {
      fieldErrors.value = { ...fieldErrors.value, ...srvFields }
    }
    apiError.value = formatDocumentErrorMessage(err, session.t, session.lang)

    if (code === 'UPLOAD_REMOVED') {
      // Never resend an upload whose draft was already removed (#023)
      uploadRemovedTerminal.value = true
      canRetry.value = false
      selectedFile.value = null
      idempotencyKey.value = ''
    } else if (code === 'IDEMPOTENCY_KEY_REUSED') {
      // Require user to re-pick cleanly rather than blindly retrying a collided key
      canRetry.value = false
      selectedFile.value = null
      idempotencyKey.value = ''
    } else {
      canRetry.value = isDocumentUploadErrorRetryable(err)
    }
  } finally {
    if (uploadAbortController === myController) {
      uploading.value = false
      uploadAbortController = null
    }
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="session.t('documents.uploadModalTitle')"
    :subtitle="session.t('documents.uploadModalSub', { max_mb: maxMb })"
    max-width="max-w-lg"
    @close="handleClose"
  >
    <template #icon>
      <span class="w-9 h-9 rounded-lg bg-primary/10 text-primary inline-flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[20px]">upload_file</span>
      </span>
    </template>

    <form class="space-y-4" @submit.prevent="submitUpload">
      <div
        v-if="apiError"
        role="alert"
        class="p-3 rounded-lg bg-error-container/60 border border-error/30 text-sm text-on-error-container flex items-start justify-between gap-3"
      >
        <div class="flex items-start gap-2 min-w-0">
          <span class="material-symbols-outlined text-[18px] shrink-0 mt-0.5 text-error">error</span>
          <span>{{ apiError }}</span>
        </div>
        <button
          v-if="canRetry && !uploading && selectedFile && !uploadRemovedTerminal"
          type="button"
          class="text-xs font-bold underline shrink-0 hover:opacity-80"
          @click="submitUpload"
        >
          {{ session.t('documents.retryUpload') }}
        </button>
      </div>

      <!-- PDF picker -->
      <div>
        <label class="block text-xs font-bold text-on-surface mb-1.5">
          {{ session.t('documents.pickPdfLabel') }} *
        </label>
        <input
          ref="fileInputRef"
          type="file"
          accept="application/pdf"
          class="hidden"
          :disabled="uploading"
          @change="handleFileChange"
        />
        <div
          class="rounded-xl border border-dashed p-3.5 flex items-center justify-between gap-3 transition-colors"
          :class="
            fieldErrors.file
              ? 'border-error bg-error-container/20'
              : 'border-surface-container-highest bg-surface-container-low/50'
          "
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="material-symbols-outlined text-[20px] text-primary shrink-0">picture_as_pdf</span>
            <span v-if="selectedFile" class="text-xs font-medium text-on-surface truncate">
              {{
                session.t('documents.selectedFileLabel', {
                  name: selectedFile.name,
                  size: formatDocumentSize(selectedFile.size, session.lang),
                })
              }}
            </span>
            <span v-else class="text-xs text-on-surface-variant">
              {{ session.t('documents.pickPdfHint', { max_mb: maxMb }) }}
            </span>
          </div>

          <BaseButton
            type="button"
            variant="secondary"
            size="sm"
            :disabled="uploading || inspectingFile"
            @click="fileInputRef?.click()"
          >
            {{
              selectedFile
                ? session.t('documents.replacePdfHint')
                : session.t('documents.pickPdfLabel')
            }}
          </BaseButton>
        </div>
        <p v-if="fieldErrors.file" class="text-xs text-error font-medium mt-1">
          {{ fieldErrors.file }}
        </p>
        <p v-else class="text-[11px] text-on-surface-variant mt-1">
          {{ session.t('documents.pdfSizeHint', { max_mb: maxMb }) }}
        </p>
      </div>

      <!-- Title -->
      <div>
        <label for="doc-upload-title" class="block text-xs font-bold text-on-surface mb-1.5">
          {{ session.t('documents.titleLabel') }} *
        </label>
        <input
          id="doc-upload-title"
          :value="draft.title"
          type="text"
          maxlength="200"
          :placeholder="session.t('documents.titlePlaceholder')"
          :disabled="uploading"
          class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          :class="fieldErrors.title ? 'border-error' : 'border-surface-container-highest'"
          @input="handleTitleInput"
        />
        <p v-if="fieldErrors.title" class="text-xs text-error font-medium mt-1">
          {{ fieldErrors.title }}
        </p>
      </div>

      <!-- Category & Audience -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label for="doc-upload-category" class="block text-xs font-bold text-on-surface mb-1.5">
            {{ session.t('documents.categoryLabel') }} *
          </label>
          <select
            id="doc-upload-category"
            v-model="draft.category"
            :disabled="uploading"
            class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            :class="fieldErrors.category ? 'border-error' : 'border-surface-container-highest'"
          >
            <option
              v-for="cat in allowedCategories"
              :key="cat"
              :value="cat"
            >
              {{ session.t(`documents.categories.${resolveDocumentCategoryKey(cat)}`) }}
            </option>
          </select>
          <p v-if="fieldErrors.category" class="text-xs text-error font-medium mt-1">
            {{ fieldErrors.category }}
          </p>
        </div>

        <div>
          <label for="doc-upload-audience" class="block text-xs font-bold text-on-surface mb-1.5">
            {{ session.t('documents.audienceLabel') }} *
          </label>
          <select
            id="doc-upload-audience"
            v-model="draft.audience"
            :disabled="uploading || allowedAudiences.length <= 1"
            class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-75"
            :class="fieldErrors.audience ? 'border-error' : 'border-surface-container-highest'"
          >
            <option
              v-for="aud in allowedAudiences"
              :key="aud"
              :value="aud"
            >
              {{ session.t(`documents.audiences.${aud}`) }}
            </option>
          </select>
          <p v-if="fieldErrors.audience" class="text-xs text-error font-medium mt-1">
            {{ fieldErrors.audience }}
          </p>
        </div>
      </div>

      <!-- Optional Document Date -->
      <div>
        <label for="doc-upload-date" class="block text-xs font-bold text-on-surface mb-1.5">
          {{ session.t('documents.dateLabel') }}
        </label>
        <div class="flex items-center gap-2">
          <input
            id="doc-upload-date"
            v-model="draft.document_date"
            type="date"
            :min="MIN_DOCUMENT_DATE"
            :max="maxDate"
            :disabled="uploading"
            class="flex-1 rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            :class="fieldErrors.document_date ? 'border-error' : 'border-surface-container-highest'"
          />
          <BaseButton
            v-if="draft.document_date"
            type="button"
            variant="secondary"
            size="sm"
            :disabled="uploading"
            @click="draft.document_date = ''"
          >
            {{ session.t('documents.clearDateBtn') }}
          </BaseButton>
        </div>
        <p v-if="fieldErrors.document_date" class="text-xs text-error font-medium mt-1">
          {{ fieldErrors.document_date }}
        </p>
      </div>

      <!-- Progress bar -->
      <div v-if="uploading" class="space-y-1.5 pt-1">
        <div class="flex items-center justify-between text-xs font-medium text-on-surface-variant">
          <span>{{ session.t('documents.uploadProgress', { percent: uploadPercent }) }}</span>
          <span class="font-mono">{{ uploadPercent }}%</span>
        </div>
        <div class="w-full h-2 rounded-full bg-surface-container-high overflow-hidden">
          <div
            class="h-full bg-primary transition-all duration-150"
            :style="{ width: `${uploadPercent}%` }"
          />
        </div>
      </div>
    </form>

    <template #footer>
      <BaseButton variant="secondary" @click="handleClose">
        {{ session.t('documents.cancelBtn') }}
      </BaseButton>
      <BaseButton
        variant="primary"
        :disabled="uploading || inspectingFile || uploadRemovedTerminal"
        @click="submitUpload"
      >
        <span class="material-symbols-outlined text-[16px]">cloud_upload</span>
        <span>
          {{
            uploading
              ? session.t('documents.uploadingBtn', { percent: uploadPercent })
              : session.t('documents.uploadSubmit')
          }}
        </span>
      </BaseButton>
    </template>
  </BaseModal>
</template>
