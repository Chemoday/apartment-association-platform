<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'

const props = defineProps({
  allMetersSubmitted: {
    type: Boolean,
    default: false,
  },
  periodLabel: {
    type: String,
    default: '',
  },
})

const router = useRouter()
const session = useSessionStore()

const isBoard = computed(() => ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''))
const hasApartment = computed(() => (session.memberships?.length || 0) > 0)
</script>

<template>
  <div data-testid="dashboard-quick-actions" class="w-full mb-space-lg">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
      <!-- Action 1: Submit Readings -->
      <button
        type="button"
        data-testid="quick-action-readings"
        class="group p-3.5 sm:p-4 rounded-2xl bg-surface-container-lowest border border-surface-container hover:border-primary/40 hover:shadow-md transition-all text-left flex flex-col justify-between gap-3 cursor-pointer"
        @click="router.push(hasApartment ? '/readings' : '/accounting')"
      >
        <div class="flex items-start justify-between gap-2">
          <div
            class="w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
            :class="
              allMetersSubmitted
                ? 'bg-secondary-container text-on-secondary-container'
                : 'bg-primary-container text-on-primary'
            "
          >
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
              {{ allMetersSubmitted ? 'check_circle' : 'speed' }}
            </span>
          </div>
          <span
            class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            :class="
              allMetersSubmitted
                ? 'bg-secondary-container/60 text-secondary'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
            "
          >
            {{ allMetersSubmitted ? 'OK' : 'DUE' }}
          </span>
        </div>
        <div>
          <div class="font-title-sm text-xs sm:text-sm font-bold text-on-surface group-hover:text-primary transition-colors">
            {{ session.t('dashboard.quickActionSubmitReadings') }}
          </div>
          <p class="text-[11px] text-on-surface-variant truncate mt-0.5">
            {{ session.t('dashboard.quickActionSubmitReadingsSub') }}
          </p>
        </div>
      </button>

      <!-- Action 2: Report an Issue -->
      <button
        type="button"
        data-testid="quick-action-issue"
        class="group p-3.5 sm:p-4 rounded-2xl bg-surface-container-lowest border border-surface-container hover:border-primary/40 hover:shadow-md transition-all text-left flex flex-col justify-between gap-3 cursor-pointer"
        @click="router.push({ path: '/issues', query: { report: '1' } })"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="w-10 h-10 rounded-xl bg-surface-container-high text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-on-primary transition-colors">
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">build</span>
          </div>
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
            arrow_forward
          </span>
        </div>
        <div>
          <div class="font-title-sm text-xs sm:text-sm font-bold text-on-surface group-hover:text-primary transition-colors">
            {{ session.t('dashboard.quickActionReportIssue') }}
          </div>
          <p class="text-[11px] text-on-surface-variant truncate mt-0.5">
            {{ session.t('dashboard.quickActionReportIssueSub') }}
          </p>
        </div>
      </button>

      <!-- Action 3: Ask on Forum -->
      <button
        type="button"
        data-testid="quick-action-forum"
        class="group p-3.5 sm:p-4 rounded-2xl bg-surface-container-lowest border border-surface-container hover:border-primary/40 hover:shadow-md transition-all text-left flex flex-col justify-between gap-3 cursor-pointer"
        @click="router.push({ path: '/forum', query: { compose: '1' } })"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="w-10 h-10 rounded-xl bg-surface-container-high text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-on-primary transition-colors">
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">forum</span>
          </div>
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
            arrow_forward
          </span>
        </div>
        <div>
          <div class="font-title-sm text-xs sm:text-sm font-bold text-on-surface group-hover:text-primary transition-colors">
            {{ session.t('dashboard.quickActionNewForumTopic') }}
          </div>
          <p class="text-[11px] text-on-surface-variant truncate mt-0.5">
            {{ session.t('dashboard.quickActionNewForumTopicSub') }}
          </p>
        </div>
      </button>

      <!-- Action 4: Write to Board / Apartments -->
      <button
        type="button"
        data-testid="quick-action-message"
        class="group p-3.5 sm:p-4 rounded-2xl bg-surface-container-lowest border border-surface-container hover:border-primary/40 hover:shadow-md transition-all text-left flex flex-col justify-between gap-3 cursor-pointer"
        @click="router.push(isBoard && !hasApartment ? '/apartments' : { path: '/messages', query: { write: '1' } })"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="w-10 h-10 rounded-xl bg-surface-container-high text-primary flex items-center justify-center group-hover:bg-primary group-hover:text-on-primary transition-colors">
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">mail</span>
          </div>
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
            arrow_forward
          </span>
        </div>
        <div>
          <div class="font-title-sm text-xs sm:text-sm font-bold text-on-surface group-hover:text-primary transition-colors">
            {{ session.t('dashboard.quickActionMessageBoard') }}
          </div>
          <p class="text-[11px] text-on-surface-variant truncate mt-0.5">
            {{ session.t('dashboard.quickActionMessageBoardSub') }}
          </p>
        </div>
      </button>
    </div>
  </div>
</template>
