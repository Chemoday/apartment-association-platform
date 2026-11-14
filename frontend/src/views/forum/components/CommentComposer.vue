<script setup>
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { addComment } from '@/api/endpoints/communication.js'
import { localizeError } from '@/locales/index.js'
import BaseButton from '@/components/base/BaseButton.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'

const props = defineProps({
  postId: {
    type: String,
    required: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  omitAuthorApartment: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['added'])
const session = useSessionStore()
const { buildingRole } = useRole()

const body = ref('')
const submitting = ref(false)
const errorMsg = ref('')
const sentSuccess = ref(false)
let successTimer = null

const previewBadge = computed(() => {
  if (session.activeMembership?.preview_badge) {
    return session.activeMembership.preview_badge
  }
  return {
    display_label: session.currentDemoUser?.label || 'Board',
    role_badge: buildingRole.value === 'ACCOUNTANT' ? 'ACCOUNTANT' : 'BOARD',
  }
})

function triggerSuccessFeedback() {
  sentSuccess.value = true
  if (successTimer) clearTimeout(successTimer)
  successTimer = setTimeout(() => {
    sentSuccess.value = false
  }, 3500)
}

watch(
  () => props.postId,
  () => {
    body.value = ''
    errorMsg.value = ''
    sentSuccess.value = false
    if (successTimer) {
      clearTimeout(successTimer)
      successTimer = null
    }
  },
)

onBeforeUnmount(() => {
  if (successTimer) clearTimeout(successTimer)
})

async function handleSubmit() {
  errorMsg.value = ''
  if (!body.value.trim() || props.disabled || submitting.value) return

  submitting.value = true
  try {
    const payload = props.omitAuthorApartment
      ? { body: body.value.trim() }
      : {
          body: body.value.trim(),
          author_apartment_id: session.activeMembership?.apartment_id || null,
        }
    const comment = await addComment(props.postId, payload)
    body.value = ''
    triggerSuccessFeedback()
    emit('added', comment)
  } catch (err) {
    errorMsg.value = localizeError(err.errorCode, err.payload, session.lang)
  } finally {
    submitting.value = false
  }
}

function handleKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    handleSubmit()
  }
}
</script>

<template>
  <form class="space-y-2.5" @submit.prevent="handleSubmit">
    <textarea
      v-model="body"
      rows="3"
      :disabled="disabled"
      class="w-full rounded-xl bg-surface-container-lowest px-3.5 py-2.5 text-sm text-on-surface border border-outline-variant/50 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 transition-shadow"
      :placeholder="
        disabled
          ? session.t('forum.commentsDisabledPlaceholder')
          : session.t('forum.writeCommentPlaceholder')
      "
      required
      @keydown="handleKeydown"
    />

    <p v-if="errorMsg" class="text-xs text-error font-medium">
      {{ errorMsg }}
    </p>

    <!-- Status & Action Bar right next to the Submit button -->
    <div class="flex flex-wrap items-center justify-between gap-3 pt-0.5">
      <div class="flex items-center gap-1.5 text-xs text-on-surface-variant">
        <template v-if="!disabled">
          <span>{{ session.t('forum.signingAsLabel') }}</span>
          <AuthorBadge :badge="previewBadge" />
        </template>
      </div>

      <div class="flex items-center gap-3 ml-auto">
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 translate-y-1"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition duration-150 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 translate-y-1"
        >
          <span
            v-if="sentSuccess"
            role="status"
            aria-live="polite"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-secondary-container/70 text-on-secondary-container text-xs font-semibold"
          >
            <span class="material-symbols-outlined text-[15px]">check_circle</span>
            <span>{{ session.t('forum.commentSentFeedback') }}</span>
          </span>
        </Transition>

        <BaseButton
          type="submit"
          variant="primary"
          size="sm"
          :loading="submitting"
          :disabled="disabled || !body.trim()"
        >
          <span class="material-symbols-outlined text-[16px]">send</span>
          <span>{{ session.t('forum.postCommentBtn') }}</span>
        </BaseButton>
      </div>
    </div>
  </form>
</template>
