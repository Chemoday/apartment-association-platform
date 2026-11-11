<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import { formatDateTime } from '@/utils/dates.js'

const props = defineProps({
  comment: {
    type: Object,
    required: true,
  },
})

const session = useSessionStore()

const avatarInitial = computed(() => {
  const label = props.comment.author_badge?.display_label || '?'
  return label.trim().charAt(0).toUpperCase()
})

const isBoardComment = computed(() => props.comment.author_badge?.role_badge === 'BOARD')
</script>

<template>
  <div
    class="p-3.5 rounded-xl border transition-colors space-y-1.5"
    :class="
      comment.is_mine
        ? 'bg-primary/5 border-primary/25'
        : 'bg-surface-container-low/70 border-surface-container-high'
    "
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <div
          class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
          :class="
            isBoardComment
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
      <span class="text-[11px] font-mono text-on-surface-variant shrink-0">
        {{ formatDateTime(comment.created_at, session.lang) }}
      </span>
    </div>
    <p class="text-sm text-on-surface leading-relaxed whitespace-pre-line pl-8">
      {{ comment.body }}
    </p>
  </div>
</template>
