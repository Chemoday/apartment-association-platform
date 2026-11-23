<script setup>
import { useSessionStore } from '@/stores/session.js'
import { formatDateTime } from '@/utils/dates.js'
import BaseChip from '@/components/base/BaseChip.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import PostOriginBadge from '@/components/domain/PostOriginBadge.vue'

defineProps({
  notices: {
    type: Array,
    required: true,
  },
  collapsed: {
    type: Boolean,
    required: true,
  },
  selectedPostId: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['toggle-collapse', 'select', 'open-detail'])

const session = useSessionStore()
</script>

<template>
  <section aria-label="Official Board Notices">
    <!-- Collapsed Single Horizontal Bar Button -->
    <button
      v-if="collapsed"
      type="button"
      class="w-full px-4 py-2.5 rounded-xl bg-primary/8 hover:bg-primary/12 border border-primary/25 transition-colors flex items-center justify-between gap-3 text-left cursor-pointer"
      @click="emit('toggle-collapse')"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="material-symbols-outlined text-[18px] text-primary">campaign</span>
        <span class="text-xs font-bold text-on-surface">
          {{ session.t('forum.pinnedNoticesHeading') }}
        </span>
        <span class="px-2 py-0.5 rounded-full bg-primary text-on-primary text-[11px] font-mono font-bold">
          {{ notices.length }}
        </span>
        <span class="text-xs text-on-surface-variant truncate hidden md:inline">
          — {{ notices[0]?.title }}
        </span>
      </div>
      <span class="inline-flex items-center gap-1 text-xs font-semibold text-primary shrink-0">
        <span>{{ session.t('forum.expandNoticesBtn') }}</span>
        <span class="material-symbols-outlined text-[16px]">expand_more</span>
      </span>
    </button>

    <!-- Expanded Official Notices Grid -->
    <div
      v-else
      class="rounded-2xl bg-primary/5 border border-primary/20 p-4 space-y-3"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px] text-primary">campaign</span>
          <h2 class="text-xs font-bold uppercase tracking-wider text-on-surface">
            {{ session.t('forum.pinnedNoticesHeading') }} ({{ notices.length }})
          </h2>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg hover:bg-primary/10 text-xs font-semibold text-primary transition-colors cursor-pointer"
          @click="emit('toggle-collapse')"
        >
          <span>{{ session.t('forum.collapseNoticesBtn') }}</span>
          <span class="material-symbols-outlined text-[16px]">expand_less</span>
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <article
          v-for="notice in notices"
          :key="notice.id"
          class="p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-2.5"
          :class="
            selectedPostId === notice.id
              ? 'bg-surface-container-lowest border-primary ring-2 ring-primary/20 shadow-xs'
              : 'bg-surface-container-lowest/90 border-surface-container-high hover:border-primary/50'
          "
          @click="emit('select', notice)"
        >
          <div>
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <div class="flex items-center gap-1.5 flex-wrap">
                <BaseChip tone="primary">
                  <span class="material-symbols-outlined text-[13px] mr-0.5">campaign</span>
                  <span>{{ session.t('forum.officialNoticeBadge') }}</span>
                </BaseChip>
                <PostOriginBadge
                  :origin="notice.origin"
                  :post-type="notice.post_type"
                />
              </div>
              <div class="flex items-center gap-1">
                <span class="text-[11px] font-mono text-on-surface-variant">
                  {{ formatDateTime(notice.created_at, session.lang) }}
                </span>
                <span
                  v-if="notice.edited_at"
                  class="text-[11px] text-on-surface-variant italic underline decoration-dotted cursor-help"
                  :title="
                    session.t('forum.editedAtTooltip', {
                      time: formatDateTime(notice.edited_at, session.lang),
                    })
                  "
                >
                  {{ session.t('forum.editedLabel') }}
                </span>
                <button
                  type="button"
                  class="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors"
                  :title="session.t('forum.fullThreadBtn')"
                  @click.stop="emit('open-detail', notice)"
                >
                  <span class="material-symbols-outlined text-[15px]">open_in_new</span>
                </button>
              </div>
            </div>

            <h3 class="text-sm font-bold text-on-surface line-clamp-1 mb-1">
              {{ notice.title }}
            </h3>
            <p class="text-xs text-on-surface-variant line-clamp-2 whitespace-pre-line">
              {{ notice.body ?? '' }}
            </p>
          </div>

          <div class="flex items-center justify-between gap-2 pt-2 border-t border-surface-container-high text-xs">
            <AuthorBadge
              v-if="notice.author_badge"
              :badge="notice.author_badge"
              :is-mine="notice.is_mine"
            />
            <span class="inline-flex items-center gap-1 font-mono text-on-surface-variant">
              <span class="material-symbols-outlined text-[14px]">chat_bubble</span>
              <span>{{ notice.comments_count ?? 0 }}</span>
            </span>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
