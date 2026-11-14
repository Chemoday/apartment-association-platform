<script setup>
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { formatDateTime, formatRelativeTime } from '@/utils/dates.js'
import BaseChip from '@/components/base/BaseChip.vue'

defineProps({
  topics: {
    type: Array,
    default: () => [],
  },
})

const router = useRouter()
const session = useSessionStore()
</script>

<template>
  <div
    data-testid="dashboard-community-pulse"
    class="bg-surface-container-lowest rounded-2xl p-space-md sm:p-space-lg shadow-xs border border-surface-container flex flex-col justify-between gap-space-md"
  >
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 pb-space-xs border-b border-surface-container">
      <div class="flex items-center gap-2">
        <div class="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[20px]" aria-hidden="true">forum</span>
        </div>
        <div>
          <h2 class="font-title-md text-base font-bold text-on-surface">
            {{ session.t('dashboard.communityPulseTitle') }}
          </h2>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('dashboard.communityPulseSub') }}
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          type="button"
          data-testid="community-pulse-new-topic-btn"
          class="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors cursor-pointer"
          @click="router.push({ path: '/forum', query: { compose: '1' } })"
        >
          <span class="material-symbols-outlined text-[15px]" aria-hidden="true">add</span>
          <span>{{ session.t('dashboard.newTopicBtn') }}</span>
        </button>

        <button
          type="button"
          class="text-xs font-semibold text-primary hover:underline cursor-pointer"
          @click="router.push('/forum')"
        >
          {{ session.t('dashboard.viewAllForum') }}
        </button>
      </div>
    </div>

    <!-- Topics List -->
    <div v-if="topics.length > 0" class="divide-y divide-surface-container">
      <div
        v-for="topic in topics"
        :key="topic.id"
        class="group py-3 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2 cursor-pointer hover:bg-surface-container-low/50 -mx-2 px-2 rounded-xl transition-colors"
        @click="router.push(`/forum/${topic.id}`)"
      >
        <div class="space-y-1 min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span
              v-if="topic.category"
              class="px-2 py-0.5 rounded-md bg-surface-container text-on-surface-variant font-label-md text-[10px] uppercase font-bold"
            >
              {{ session.t(`forum.categories.${topic.category}`) }}
            </span>
            <BaseChip v-if="topic.hidden_at" tone="warning">
              <span class="material-symbols-outlined text-[12px] mr-0.5" aria-hidden="true">visibility_off</span>
              <span>{{ session.t('forum.hiddenTopicBadge') }}</span>
            </BaseChip>
            <span class="text-xs text-on-surface-variant">
              {{ topic.author_badge?.display_label || 'Neighbor' }}
            </span>
            <span aria-hidden="true" class="text-on-surface-variant/40">•</span>
            <span class="text-xs text-on-surface-variant">
              {{ formatRelativeTime(topic.created_at, session.lang) }}
            </span>
            <span
              v-if="topic.edited_at"
              class="text-xs text-on-surface-variant italic underline decoration-dotted cursor-help"
              :title="
                session.t('forum.editedAtTooltip', {
                  time: formatDateTime(topic.edited_at, session.lang),
                })
              "
            >
              {{ session.t('forum.editedLabel') }}
            </span>
          </div>

          <h3
            class="text-sm font-semibold group-hover:text-primary transition-colors truncate"
            :class="topic.hidden_at ? 'text-on-surface-variant' : 'text-on-surface'"
          >
            {{ topic.title }}
          </h3>
        </div>

        <div class="flex items-center gap-2 shrink-0 self-end sm:self-center">
          <span
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container-high text-on-surface font-label-md text-xs font-semibold"
          >
            <span class="material-symbols-outlined text-[14px]" aria-hidden="true">chat_bubble</span>
            <span>{{ session.t('dashboard.commentsCount', { count: topic.comments_count ?? topic.comments?.length ?? 0 }) }}</span>
          </span>
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
            chevron_right
          </span>
        </div>
      </div>
    </div>

    <div
      v-else
      class="py-8 text-center text-xs text-on-surface-variant"
    >
      {{ session.t('dashboard.noForumTopics') }}
    </div>
  </div>
</template>
