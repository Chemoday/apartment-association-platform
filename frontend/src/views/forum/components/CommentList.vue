<script setup>
import { useSessionStore } from '@/stores/session.js'
import CommentListItem from './CommentListItem.vue'

defineProps({
  comments: {
    type: Array,
    default: () => [],
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
  moderatingCommentId: {
    type: String,
    default: null,
  },
  moderationDisabled: {
    type: Boolean,
    default: false,
  },
  editingCommentId: {
    type: String,
    default: null,
  },
  savingEditCommentId: {
    type: String,
    default: null,
  },
  editCommentError: {
    type: String,
    default: '',
  },
  closedEditCommentIds: {
    type: Object,
    default: () => new Set(),
  },
})

const emit = defineEmits([
  'hide-comment',
  'unhide-comment',
  'start-edit-comment',
  'cancel-edit-comment',
  'save-edit-comment',
  'clear-comment-edit-error',
])

const session = useSessionStore()
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="!comments.length"
      class="py-6 text-center text-xs text-on-surface-variant bg-surface-container-low/40 rounded-lg border border-dashed border-outline-variant/30"
    >
      {{ session.t('forum.noCommentsYet') }}
    </div>

    <CommentListItem
      v-for="comment in comments"
      :key="comment.id"
      :comment="comment"
      :post-type="postType"
      :post-origin="postOrigin"
      :post-hidden="postHidden"
      :now-ms="nowMs"
      :moderating="moderatingCommentId === comment.id"
      :moderation-disabled="moderationDisabled"
      :editing="editingCommentId === comment.id"
      :saving-edit="savingEditCommentId === comment.id"
      :edit-error="editingCommentId === comment.id ? editCommentError : ''"
      :edit-window-closed="Boolean(closedEditCommentIds?.has?.(comment.id))"
      @hide-comment="emit('hide-comment', $event)"
      @unhide-comment="emit('unhide-comment', $event)"
      @start-edit="emit('start-edit-comment', $event)"
      @cancel-edit="emit('cancel-edit-comment', $event)"
      @save-edit="emit('save-edit-comment', $event)"
      @clear-edit-error="emit('clear-comment-edit-error')"
    />
  </div>
</template>
