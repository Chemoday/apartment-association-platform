<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import BaseModal from '@/components/base/BaseModal.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import {
  POST_TITLE_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  buildPostEditPayload,
  validatePostEdit,
} from '@/utils/communication.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  post: {
    type: Object,
    default: null,
  },
  saving: {
    type: Boolean,
    default: false,
  },
  errorMsg: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['close', 'submit', 'clear-error'])
const session = useSessionStore()

const titleDraft = ref('')
const bodyDraft = ref('')
const localError = ref('')
const titleInputRef = ref(null)

const titleTrimmedLen = computed(() => titleDraft.value.trim().length)
const bodyTrimmedLen = computed(() => bodyDraft.value.trim().length)
const validation = computed(() => validatePostEdit(titleDraft.value, bodyDraft.value))

function resetFromPost() {
  titleDraft.value = props.post?.title ?? ''
  bodyDraft.value = props.post?.body ?? ''
  localError.value = ''
}

watch(
  () => [props.open, props.post?.id],
  async ([isOpen]) => {
    if (isOpen) {
      resetFromPost()
      await nextTick()
      titleInputRef.value?.focus?.()
    }
  },
)

function handleInput() {
  localError.value = ''
  if (props.errorMsg) {
    emit('clear-error')
  }
}

function resolveValidationMessage(err) {
  switch (err) {
    case 'TITLE_REQUIRED':
      return session.t('forum.editPostTitleRequired')
    case 'TITLE_TOO_LONG':
      return session.t('forum.editPostTitleTooLong', { max: POST_TITLE_MAX_LENGTH })
    case 'TITLE_INVALID_CHARS':
    case 'BODY_INVALID_CHARS':
      return session.t('forum.editInvalidChars')
    case 'BODY_TOO_LONG':
      return session.t('forum.editPostBodyTooLong', { max: POST_BODY_MAX_LENGTH })
    case 'BODY_REQUIRED':
    default:
      return session.t('forum.editPostBodyRequired')
  }
}

const liveValidationError = computed(() => {
  if (validation.value.valid) return ''
  const err = validation.value.error
  if (
    err === 'TITLE_TOO_LONG' ||
    err === 'BODY_TOO_LONG' ||
    err === 'TITLE_INVALID_CHARS' ||
    err === 'BODY_INVALID_CHARS'
  ) {
    return resolveValidationMessage(err)
  }
  return ''
})

const displayedError = computed(
  () => localError.value || liveValidationError.value || props.errorMsg,
)

function handleSubmit() {
  if (props.saving) return
  if (!validation.value.valid) {
    localError.value = resolveValidationMessage(validation.value.error)
    return
  }
  const payload = buildPostEditPayload(props.post, validation.value.title, validation.value.body)
  if (Object.keys(payload).length === 0) {
    emit('close')
    return
  }
  localError.value = ''
  emit('submit', payload)
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="session.t('forum.editPostModalTitle')"
    max-width="max-w-xl"
    @close="!saving && emit('close')"
  >
    <template #icon>
      <span class="w-8 h-8 rounded-lg bg-primary/15 text-primary inline-flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[18px]" aria-hidden="true">edit</span>
      </span>
    </template>

    <form id="post-edit-form" class="space-y-4" @submit.prevent="handleSubmit">
      <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <label for="post-edit-title" class="text-xs font-bold text-on-surface">
            {{ session.t('forum.editPostTitleLabel') }} *
          </label>
          <span
            class="text-[11px] font-mono tabular-nums"
            :class="titleTrimmedLen > POST_TITLE_MAX_LENGTH ? 'text-error font-semibold' : 'text-on-surface-variant'"
          >
            {{ session.t('forum.charsCounter', { count: titleTrimmedLen, max: POST_TITLE_MAX_LENGTH }) }}
          </span>
        </div>
        <input
          id="post-edit-title"
          ref="titleInputRef"
          v-model="titleDraft"
          type="text"
          :disabled="saving"
          class="w-full px-3 py-2 rounded-xl bg-surface-container-low/60 border border-outline-variant/50 text-sm text-on-surface placeholder-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          @input="handleInput"
        />
      </div>

      <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <label for="post-edit-body" class="text-xs font-bold text-on-surface">
            {{ session.t('forum.editPostBodyLabel') }} *
          </label>
          <span
            class="text-[11px] font-mono tabular-nums"
            :class="bodyTrimmedLen > POST_BODY_MAX_LENGTH ? 'text-error font-semibold' : 'text-on-surface-variant'"
          >
            {{ session.t('forum.charsCounter', { count: bodyTrimmedLen, max: POST_BODY_MAX_LENGTH }) }}
          </span>
        </div>
        <textarea
          id="post-edit-body"
          v-model="bodyDraft"
          rows="6"
          :disabled="saving"
          class="w-full px-3 py-2.5 rounded-xl bg-surface-container-low/60 border border-outline-variant/50 text-sm text-on-surface placeholder-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 resize-y"
          @input="handleInput"
        />
      </div>

      <p v-if="displayedError" class="text-xs text-error font-medium" role="alert">
        {{ displayedError }}
      </p>
    </form>

    <template #footer>
      <BaseButton
        variant="secondary"
        size="sm"
        :disabled="saving"
        @click="emit('close')"
      >
        {{ session.t('common.cancel') }}
      </BaseButton>
      <BaseButton
        type="submit"
        form="post-edit-form"
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="saving"
      >
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">check</span>
        <span>{{ session.t('forum.saveEditBtn') }}</span>
      </BaseButton>
    </template>
  </BaseModal>
</template>
