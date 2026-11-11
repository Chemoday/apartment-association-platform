<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import PostOriginBadge from '@/components/domain/PostOriginBadge.vue'
import BaseChip from '@/components/base/BaseChip.vue'
import { formatDateTime } from '@/utils/dates.js'

const props = defineProps({
  post: {
    type: Object,
    required: true,
  },
  selected: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['select', 'open-detail', 'delete-post'])
const session = useSessionStore()
const { canDeleteForumTopic } = useRole()

const isPinnedNotice = computed(() => props.post.post_type === 'OFFICIAL_NOTICE')

const categoryLabel = computed(() => {
  if (props.post.post_type === 'OFFICIAL_NOTICE') {
    return session.t('forum.officialNoticeBadge')
  }
  switch (props.post.category) {
    case 'MAINTENANCE':
      return session.t('forum.filterMaintenance')
    case 'WATER_SHUTOFF':
      return session.t('forum.waterShutoffCategory')
    case 'MARKETPLACE':
      return session.t('forum.filterMarketplace')
    default:
      return session.t('forum.filterGeneral')
  }
})

const categoryTone = computed(() => {
  if (props.post.post_type === 'OFFICIAL_NOTICE') return 'primary'
  if (props.post.category === 'MAINTENANCE' || props.post.category === 'WATER_SHUTOFF') return 'warning'
  return 'neutral'
})

const displayTimestamp = computed(() => {
  return formatDateTime(props.post.last_activity_at || props.post.created_at, session.lang)
})
</script>

<template>
  <article
    class="rounded-xl p-4 transition-all cursor-pointer relative overflow-hidden group border"
    :class="[
      selected
        ? 'bg-surface-container-lowest border-primary ring-2 ring-primary/20 shadow-sm'
        : isPinnedNotice
          ? 'bg-primary/5 border-primary/25 hover:border-primary/60 shadow-2xs'
          : 'bg-surface-container-lowest/90 border-surface-container-high hover:bg-surface-container-lowest hover:border-primary/40 shadow-2xs',
    ]"
    @click="emit('select', post)"
  >
    <div class="flex items-center justify-between gap-2 mb-1.5">
      <div class="flex items-center gap-1.5 flex-wrap min-w-0">
        <BaseChip :tone="categoryTone">
          <span v-if="isPinnedNotice" class="material-symbols-outlined text-[13px] mr-0.5">campaign</span>
          <span>{{ categoryLabel }}</span>
        </BaseChip>
        <PostOriginBadge
          :origin="post.origin"
          :post-type="post.post_type"
        />
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <span class="text-[11px] font-mono text-on-surface-variant">
          {{ displayTimestamp }}
        </span>

        <button
          v-if="canDeleteForumTopic && post.post_type === 'FORUM_TOPIC'"
          type="button"
          class="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error-container/30 transition-colors"
          :title="session.t('common.delete')"
          @click.stop="emit('delete-post', post)"
        >
          <span class="material-symbols-outlined text-[15px]">delete</span>
        </button>

        <button
          type="button"
          class="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors"
          :title="session.t('forum.fullThreadBtn')"
          @click.stop="emit('open-detail', post)"
        >
          <span class="material-symbols-outlined text-[15px]">open_in_new</span>
        </button>
      </div>
    </div>

    <h3
      class="text-sm sm:text-base font-bold mb-1 leading-snug line-clamp-1 transition-colors"
      :class="selected ? 'text-primary' : 'text-on-surface group-hover:text-primary'"
    >
      {{ post.title }}
    </h3>

    <p class="text-xs text-on-surface-variant leading-relaxed mb-2.5 line-clamp-2 whitespace-pre-line">
      {{ post.body }}
    </p>

    <div class="flex items-center justify-between gap-2 pt-2 border-t border-surface-container-high/80 text-xs">
      <div class="min-w-0 truncate">
        <AuthorBadge
          v-if="post.author_badge"
          :badge="post.author_badge"
          :is-mine="post.is_mine"
        />
      </div>

      <div
        class="inline-flex items-center gap-1 font-mono text-xs shrink-0 px-2 py-0.5 rounded-md"
        :class="
          (post.comments_count ?? 0) > 0
            ? 'bg-primary/10 text-primary font-semibold'
            : 'text-on-surface-variant'
        "
      >
        <span class="material-symbols-outlined text-[14px]">chat_bubble</span>
        <span class="tabular-nums">{{ post.comments_count ?? 0 }}</span>
      </div>
    </div>
  </article>
</template>
