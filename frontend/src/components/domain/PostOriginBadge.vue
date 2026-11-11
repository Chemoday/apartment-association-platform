<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'

const props = defineProps({
  origin: {
    type: String,
    default: null,
  },
  postType: {
    type: String,
    default: '',
  },
  isNotice: {
    type: Boolean,
    default: false,
  },
  tone: {
    type: String,
    default: 'default', // 'default' | 'on-primary'
  },
})

const session = useSessionStore()

const isAutomaticNotice = computed(() => {
  return props.isNotice || props.postType === 'OFFICIAL_NOTICE'
})

const label = computed(() => {
  return isAutomaticNotice.value
    ? session.t('postOrigin.notice')
    : session.t('postOrigin.reminder')
})

const iconName = computed(() => {
  return isAutomaticNotice.value ? 'campaign' : 'event_repeat'
})
</script>

<template>
  <span
    v-if="origin === 'MAINTENANCE'"
    data-testid="post-origin-badge"
    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide border select-none transition-colors"
    :class="[
      tone === 'on-primary'
        ? 'bg-white/15 text-white/95 border-white/25 shadow-xs'
        : 'bg-secondary-container/40 text-secondary border-secondary/25',
    ]"
    :title="session.t('postOrigin.fromMaintenanceCalendar')"
  >
    <span class="material-symbols-outlined text-[13px] leading-none shrink-0" aria-hidden="true">
      {{ iconName }}
    </span>
    <span class="capitalize-first">{{ label }}</span>
  </span>
</template>

<style scoped>
.capitalize-first {
  display: inline-block;
}
.capitalize-first::first-letter {
  text-transform: uppercase;
}
</style>
