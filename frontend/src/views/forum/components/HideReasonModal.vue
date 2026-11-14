<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import BaseModal from '@/components/base/BaseModal.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import { HIDE_REASON_MAX_LENGTH, validateHideReason } from '@/utils/communication.js'

const props = defineProps({
  open: {
    type: Boolean,
    required: true,
  },
  targetType: {
    type: String,
    default: 'post', // 'post' | 'comment'
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

const reason = ref('')
const localError = ref('')
const reasonInputRef = ref(null)

const modalTitle = computed(() =>
  props.targetType === 'comment'
    ? session.t('forum.hideCommentModalTitle')
    : session.t('forum.hideTopicModalTitle'),
)

const trimmedLength = computed(() => reason.value.trim().length)
const validation = computed(() => validateHideReason(reason.value))

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      reason.value = ''
      localError.value = ''
      await nextTick()
      reasonInputRef.value?.focus?.()
    }
  },
)

function handleInput() {
  localError.value = ''
  if (props.errorMsg) {
    emit('clear-error')
  }
}

function handleSubmit() {
  if (props.saving) return
  if (!validation.value.valid) {
    if (validation.value.error === 'REASON_TOO_LONG') {
      localError.value = session.t('forum.hideReasonTooLong')
    } else if (validation.value.error === 'INVALID_CHARS') {
      localError.value = session.t('forum.hideReasonInvalidChars')
    } else {
      localError.value = session.t('forum.hideReasonRequired')
    }
    return
  }
  localError.value = ''
  emit('submit', validation.value.reason)
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="modalTitle"
    max-width="max-w-md"
    @close="!saving && emit('close')"
  >
    <template #icon>
      <span class="w-8 h-8 rounded-lg bg-warning-container/40 text-warning inline-flex items-center justify-center shrink-0">
        <span class="material-symbols-outlined text-[18px]" aria-hidden="true">visibility_off</span>
      </span>
    </template>

    <form id="hide-reason-form" class="space-y-4" @submit.prevent="handleSubmit">
      <div class="rounded-xl border border-warning/35 bg-warning-container/20 px-3.5 py-2.5 text-xs text-on-surface-variant flex items-start gap-2">
        <span class="material-symbols-outlined text-[16px] text-warning shrink-0 mt-0.5" aria-hidden="true">
          info
        </span>
        <span>{{ session.t('forum.hideModalAuthorHint') }}</span>
      </div>

      <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <label for="hide-reason-textarea" class="text-xs font-bold text-on-surface">
            {{ session.t('forum.hideReasonLabel') }}
          </label>
          <span
            class="text-[11px] font-mono tabular-nums"
            :class="trimmedLength > HIDE_REASON_MAX_LENGTH ? 'text-error font-semibold' : 'text-on-surface-variant'"
          >
            {{ trimmedLength }} / {{ HIDE_REASON_MAX_LENGTH }}
          </span>
        </div>

        <textarea
          id="hide-reason-textarea"
          ref="reasonInputRef"
          v-model="reason"
          rows="3"
          :disabled="saving"
          :placeholder="session.t('forum.hideReasonPlaceholder')"
          class="w-full px-3 py-2.5 rounded-xl bg-surface-container-low/60 border border-outline-variant/50 text-sm text-on-surface placeholder-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 resize-y"
          @input="handleInput"
        />

        <p v-if="localError || errorMsg" class="text-xs text-error font-medium" role="alert">
          {{ localError || errorMsg }}
        </p>
      </div>
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
        form="hide-reason-form"
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="saving || !validation.valid"
      >
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">visibility_off</span>
        <span>{{ session.t('forum.hideConfirmBtn') }}</span>
      </BaseButton>
    </template>
  </BaseModal>
</template>
