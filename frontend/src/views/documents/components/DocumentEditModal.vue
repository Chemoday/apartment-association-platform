<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { editDocument } from '@/api/endpoints/documents.js'
import {
  DOCUMENT_AUDIENCES,
  DOCUMENT_CATEGORIES,
  MIN_DOCUMENT_DATE,
  buildDocumentEditPatch,
  extractDocumentFieldErrors,
  formatDocumentErrorMessage,
  getMaxDocumentDate,
  isSingleLineVisibleTitle,
  isValidDocumentDate,
  resolveDocumentCategoryKey,
} from '@/utils/documents.js'
import BaseModal from '@/components/base/BaseModal.vue'
import BaseButton from '@/components/base/BaseButton.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  document: {
    type: Object,
    default: null,
  },
  audiences: {
    type: Array,
    default: () => DOCUMENT_AUDIENCES,
  },
  categories: {
    type: Array,
    default: () => DOCUMENT_CATEGORIES,
  },
})

const emit = defineEmits(['close', 'saved'])

const session = useSessionStore()

const draft = ref({
  title: '',
  category: 'OTHER',
  audience: 'EVERYONE',
  document_date: '',
})
const fieldErrors = ref({})
const apiError = ref('')
const saving = ref(false)

let isUnmounted = false
let editAbortController = null

const maxDate = computed(() => getMaxDocumentDate())

const categoryChoices = computed(() => {
  const base = Array.isArray(props.categories) && props.categories.length > 0
    ? [...props.categories]
    : [...DOCUMENT_CATEGORIES]
  const current = props.document?.category
  if (current && !base.includes(current)) {
    base.push(current)
  }
  return base
})

const audienceChoices = computed(() =>
  Array.isArray(props.audiences) && props.audiences.length > 0
    ? props.audiences
    : DOCUMENT_AUDIENCES,
)

function abortEditRequest() {
  if (editAbortController) {
    try {
      editAbortController.abort()
    } catch {
      /* ignore */
    }
    editAbortController = null
  }
}

function hydrateFromDocument() {
  abortEditRequest()
  fieldErrors.value = {}
  apiError.value = ''
  saving.value = false
  if (!props.document) return
  draft.value = {
    title: props.document.title || '',
    category: props.document.category || 'OTHER',
    audience: props.document.audience || 'EVERYONE',
    document_date: props.document.document_date || '',
  }
}

watch(
  () => [props.open, props.document?.id],
  ([isOpen]) => {
    if (isOpen) {
      hydrateFromDocument()
    } else {
      abortEditRequest()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  isUnmounted = true
  abortEditRequest()
})

function handleClose() {
  abortEditRequest()
  emit('close')
}

async function submitEdit() {
  if (saving.value || !props.document) return

  const { patch, hasChanges } = buildDocumentEditPatch(props.document, draft.value)
  if (!hasChanges) {
    emit('close')
    return
  }

  const nextErrors = {}
  if (Object.prototype.hasOwnProperty.call(patch, 'title') && !isSingleLineVisibleTitle(draft.value.title)) {
    const trimmed = String(draft.value.title || '').trim()
    nextErrors.title = !trimmed
      ? session.t('documents.validation.TITLE_REQUIRED')
      : trimmed.length > 200
        ? session.t('documents.validation.TITLE_TOO_LONG')
        : session.t('documents.validation.TITLE_INVALID')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'category') && !categoryChoices.value.includes(patch.category)) {
    nextErrors.category = session.t('documents.validation.CATEGORY_REQUIRED')
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'audience') && !audienceChoices.value.includes(patch.audience)) {
    nextErrors.audience = session.t('documents.validation.AUDIENCE_INVALID')
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'document_date') &&
    !isValidDocumentDate(patch.document_date)
  ) {
    nextErrors.document_date = session.t('documents.validation.DATE_INVALID')
  }

  if (Object.keys(nextErrors).length > 0) {
    fieldErrors.value = nextErrors
    return
  }

  fieldErrors.value = {}
  apiError.value = ''
  saving.value = true
  abortEditRequest()
  const myController = new AbortController()
  editAbortController = myController
  const targetDocId = props.document.id

  try {
    const updated = await editDocument(targetDocId, patch, {
      signal: myController.signal,
    })
    if (isUnmounted || !props.open) return
    emit('saved', updated)
    emit('close')
  } catch (err) {
    if (isUnmounted || !props.open) return
    if (
      err?.name === 'AbortError' ||
      err?.errorCode === 'REQUEST_ABORTED' ||
      err?.errorCode === 'UPLOAD_ABORTED'
    ) {
      return
    }
    const srvFields = extractDocumentFieldErrors(err, session.t, session.lang)
    if (Object.keys(srvFields).length > 0) {
      fieldErrors.value = srvFields
    }
    apiError.value = formatDocumentErrorMessage(err, session.t, session.lang)
  } finally {
    if (editAbortController === myController) {
      saving.value = false
      editAbortController = null
    }
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="session.t('documents.editModalTitle')"
    :subtitle="session.t('documents.editModalSub')"
    max-width="max-w-lg"
    @close="handleClose"
  >
    <template #icon>
      <span class="w-9 h-9 rounded-lg bg-primary/10 text-primary inline-flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[20px]">edit_document</span>
      </span>
    </template>

    <form v-if="document" class="space-y-4" @submit.prevent="submitEdit">
      <div
        v-if="apiError"
        role="alert"
        class="p-3 rounded-lg bg-error-container/60 border border-error/30 text-sm text-on-error-container flex items-start gap-2"
      >
        <span class="material-symbols-outlined text-[18px] shrink-0 mt-0.5 text-error">error</span>
        <span>{{ apiError }}</span>
      </div>

      <div>
        <label for="doc-edit-title" class="block text-xs font-bold text-on-surface mb-1.5">
          {{ session.t('documents.titleLabel') }} *
        </label>
        <input
          id="doc-edit-title"
          v-model="draft.title"
          type="text"
          maxlength="200"
          :disabled="saving"
          class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
          :class="fieldErrors.title ? 'border-error' : 'border-surface-container-highest'"
        />
        <p v-if="fieldErrors.title" class="text-xs text-error font-medium mt-1">
          {{ fieldErrors.title }}
        </p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label for="doc-edit-category" class="block text-xs font-bold text-on-surface mb-1.5">
            {{ session.t('documents.categoryLabel') }} *
          </label>
          <select
            id="doc-edit-category"
            v-model="draft.category"
            :disabled="saving"
            class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            :class="fieldErrors.category ? 'border-error' : 'border-surface-container-highest'"
          >
            <option
              v-for="cat in categoryChoices"
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
          <label for="doc-edit-audience" class="block text-xs font-bold text-on-surface mb-1.5">
            {{ session.t('documents.audienceLabel') }} *
          </label>
          <select
            id="doc-edit-audience"
            v-model="draft.audience"
            :disabled="saving"
            class="w-full rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            :class="fieldErrors.audience ? 'border-error' : 'border-surface-container-highest'"
          >
            <option
              v-for="aud in audienceChoices"
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

      <div>
        <label for="doc-edit-date" class="block text-xs font-bold text-on-surface mb-1.5">
          {{ session.t('documents.dateLabel') }}
        </label>
        <div class="flex items-center gap-2">
          <input
            id="doc-edit-date"
            v-model="draft.document_date"
            type="date"
            :min="MIN_DOCUMENT_DATE"
            :max="maxDate"
            :disabled="saving"
            class="flex-1 rounded-lg border px-3 py-2 text-sm bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            :class="fieldErrors.document_date ? 'border-error' : 'border-surface-container-highest'"
          />
          <BaseButton
            v-if="draft.document_date"
            type="button"
            variant="secondary"
            size="sm"
            :disabled="saving"
            @click="draft.document_date = ''"
          >
            {{ session.t('documents.clearDateBtn') }}
          </BaseButton>
        </div>
        <p v-if="fieldErrors.document_date" class="text-xs text-error font-medium mt-1">
          {{ fieldErrors.document_date }}
        </p>
      </div>
    </form>

    <template #footer>
      <BaseButton variant="secondary" @click="handleClose">
        {{ session.t('documents.cancelBtn') }}
      </BaseButton>
      <BaseButton variant="primary" :disabled="saving" @click="submitEdit">
        <span class="material-symbols-outlined text-[16px]">save</span>
        <span>
          {{ saving ? session.t('documents.savingBtn') : session.t('documents.saveChangesBtn') }}
        </span>
      </BaseButton>
    </template>
  </BaseModal>
</template>
