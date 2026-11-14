<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import { formatDateTime } from '@/utils/dates.js'
import {
  COMMENT_BODY_MAX_LENGTH,
  canEditComment,
  formatHiddenByBoardBanner,
  isCommentHidden,
  isCommentHideableOnPost,
  isCommentRedacted,
  validateCommentEdit,
} from '@/utils/communication.js'

const props = defineProps({
  comment: {
    type: Object,
    required: true,
  },
  postType: {
    type: String,
    default: null,
  },
  postOrigin: {
    type: String,
    default: null,
  },
  postHidden: {
    type: Boolean,
    default: false,
  },
  nowMs: {
    type: Number,
    default: () => Date.now(),
  },
  moderating: {
    type: Boolean,
    default: false,
  },
  moderationDisabled: {
    type: Boolean,
    default: false,
  },
  editing: {
    type: Boolean,
    default: false,
  },
  savingEdit: {
    type: Boolean,
    default: false,
  },
  editError: {
    type: String,
    default: '',
  },
  editWindowClosed: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'hide-comment',
  'unhide-comment',
  'start-edit',
  'cancel-edit',
  'save-edit',
  'clear-edit-error',
])

const session = useSessionStore()
const { canModerateForum } = useRole()

const draftBody = ref('')
const localError = ref('')
const editTextareaRef = ref(null)

const avatarInitial = computed(() => {
  const label = props.comment.author_badge?.display_label || '?'
  return label.trim().charAt(0).toUpperCase()
})

const isBoardComment = computed(() => props.comment.author_badge?.role_badge === 'BOARD')
const hidden = computed(() => isCommentHidden(props.comment))
const redacted = computed(() => isCommentRedacted(props.comment))
const canModerateThisComment = computed(
  () => canModerateForum.value && isCommentHideableOnPost(props.postType),
)
const canEditThisComment = computed(() =>
  canEditComment(
    props.comment,
    {
      post_type: props.postType,
      origin: props.postOrigin,
      hidden_at: props.postHidden ? 'hidden' : null,
    },
    props.nowMs,
    { serverClosed: props.editWindowClosed },
  ),
)
const hiddenBannerText = computed(() =>
  formatHiddenByBoardBanner(props.comment, (key, params) => session.t(key, params)),
)
const editValidation = computed(() => validateCommentEdit(draftBody.value))
const draftLength = computed(() => draftBody.value.trim().length)

watch(
  () => [props.editing, props.comment?.id],
  async ([isEditing]) => {
    if (isEditing) {
      draftBody.value = props.comment?.body ?? ''
      localError.value = ''
      await nextTick()
      editTextareaRef.value?.focus?.()
    } else {
      draftBody.value = ''
      localError.value = ''
    }
  },
)

function resolveCommentValidationError(err) {
  if (err === 'BODY_TOO_LONG') {
    return session.t('forum.commentBodyTooLong', { max: COMMENT_BODY_MAX_LENGTH })
  }
  if (err === 'INVALID_CHARS') {
    return session.t('forum.editInvalidChars')
  }
  return session.t('forum.commentBodyRequired')
}

const liveEditValidationError = computed(() => {
  if (!props.editing || editValidation.value.valid) return ''
  const err = editValidation.value.error
  if (err === 'BODY_TOO_LONG' || err === 'INVALID_CHARS') {
    return resolveCommentValidationError(err)
  }
  return ''
})

const displayedEditError = computed(
  () => localError.value || liveEditValidationError.value || props.editError,
)

function handleEditInput() {
  localError.value = ''
  if (props.editError) {
    emit('clear-edit-error')
  }
}

function handleCancelEdit() {
  if (props.savingEdit) return
  draftBody.value = props.comment?.body ?? ''
  localError.value = ''
  emit('cancel-edit')
}

function handleSaveEdit() {
  if (props.savingEdit) return
  if (!editValidation.value.valid) {
    localError.value = resolveCommentValidationError(editValidation.value.error)
    return
  }
  if (editValidation.value.body === (props.comment?.body ?? '').trim()) {
    handleCancelEdit()
    return
  }
  localError.value = ''
  emit('save-edit', {
    comment: props.comment,
    body: editValidation.value.body,
  })
}
</script>

<template>
  <div
    class="p-3.5 rounded-xl border transition-colors space-y-1.5"
    :class="
      hidden
        ? 'bg-surface-container-low/40 border-outline-variant/40'
        : comment.is_mine
          ? 'bg-primary/5 border-primary/25'
          : 'bg-surface-container-low/70 border-surface-container-high'
    "
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
          :class="
            hidden
              ? 'bg-surface-container-high text-on-surface-variant'
              : isBoardComment
                ? 'bg-secondary-container text-on-secondary-container'
                : 'bg-primary/15 text-primary'
          "
        >
          {{ avatarInitial }}
        </div>
        <AuthorBadge
          v-if="comment.author_badge"
          :badge="comment.author_badge"
          :is-mine="comment.is_mine"
        />
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <span class="text-[11px] font-mono text-on-surface-variant">
          {{ formatDateTime(comment.created_at, session.lang) }}
        </span>
        <span
          v-if="comment.edited_at"
          class="text-[11px] text-on-surface-variant italic underline decoration-dotted cursor-help"
          :title="
            session.t('forum.editedAtTooltip', {
              time: formatDateTime(comment.edited_at, session.lang),
            })
          "
        >
          {{ session.t('forum.editedLabel') }}
        </span>
        <button
          v-if="canEditThisComment && !editing"
          type="button"
          :disabled="moderating || moderationDisabled || savingEdit"
          class="px-1.5 py-0.5 rounded-md text-[11px] font-semibold inline-flex items-center gap-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer disabled:opacity-50"
          :title="session.t('forum.editBtn')"
          @click="emit('start-edit', comment)"
        >
          <span class="material-symbols-outlined text-[14px]" aria-hidden="true">edit</span>
          <span>{{ session.t('forum.editBtn') }}</span>
        </button>
        <button
          v-if="canModerateThisComment && !editing"
          type="button"
          :disabled="moderating || moderationDisabled"
          class="px-1.5 py-0.5 rounded-md text-[11px] font-semibold inline-flex items-center gap-1 text-on-surface-variant hover:text-warning hover:bg-warning-container/30 transition-colors cursor-pointer disabled:opacity-50"
          :title="hidden ? session.t('forum.unhideBtn') : session.t('forum.hideBtn')"
          @click="emit(hidden ? 'unhide-comment' : 'hide-comment', comment)"
        >
          <span class="material-symbols-outlined text-[14px]" aria-hidden="true">
            {{ hidden ? 'visibility' : 'visibility_off' }}
          </span>
          <span>{{ hidden ? session.t('forum.unhideBtn') : session.t('forum.hideBtn') }}</span>
        </button>
      </div>
    </div>

    <div
      v-if="redacted"
      class="pl-8 py-0.5 text-xs italic text-on-surface-variant flex items-center gap-1.5"
    >
      <span class="material-symbols-outlined text-[15px]" aria-hidden="true">visibility_off</span>
      <span>{{ session.t('forum.hiddenByBoard') }}</span>
    </div>

    <template v-else-if="hidden">
      <div class="pl-8 space-y-1.5">
        <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container text-on-surface-variant text-xs font-medium">
          <span class="material-symbols-outlined text-[14px]" aria-hidden="true">visibility_off</span>
          <span>{{ hiddenBannerText }}</span>
        </div>
        <p class="text-sm text-on-surface-variant/80 leading-relaxed whitespace-pre-line">
          {{ comment.body ?? '' }}
        </p>
      </div>
    </template>

    <div v-else-if="editing" class="pl-8 pt-1 space-y-2">
      <label :for="`edit-comment-${comment.id}`" class="sr-only">
        {{ session.t('forum.editCommentLabel') }}
      </label>
      <textarea
        :id="`edit-comment-${comment.id}`"
        ref="editTextareaRef"
        v-model="draftBody"
        rows="3"
        :disabled="savingEdit"
        class="w-full px-3 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 resize-y"
        @input="handleEditInput"
        @keydown.esc.stop.prevent="handleCancelEdit"
      />
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span
          class="text-[11px] font-mono tabular-nums"
          :class="draftLength > COMMENT_BODY_MAX_LENGTH ? 'text-error font-semibold' : 'text-on-surface-variant'"
        >
          {{ session.t('forum.charsCounter', { count: draftLength, max: COMMENT_BODY_MAX_LENGTH }) }}
        </span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            :disabled="savingEdit"
            class="px-2.5 py-1 rounded-lg bg-surface-container text-on-surface text-xs font-semibold hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-50"
            @click="handleCancelEdit"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="savingEdit"
            class="px-3 py-1 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
            @click="handleSaveEdit"
          >
            {{ savingEdit ? session.t('common.saving') : session.t('forum.saveEditBtn') }}
          </button>
        </div>
      </div>
      <p v-if="displayedEditError" class="text-xs text-error font-medium" role="alert">
        {{ displayedEditError }}
      </p>
    </div>

    <p v-else class="text-sm text-on-surface leading-relaxed whitespace-pre-line pl-8">
      {{ comment.body ?? '' }}
    </p>
  </div>
</template>
