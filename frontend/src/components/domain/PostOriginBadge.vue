<script setup lang="ts">
import { computed } from 'vue'
import type { PostOrigin, PostType } from '@/api/schema.js'
import { useSessionStore } from '@/stores/session.js'
import AppIcon from '@/components/base/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    origin?: PostOrigin | null
    postType?: PostType | ''
    isNotice?: boolean
    tone?: 'default' | 'on-primary'
  }>(),
  {
    origin: null,
    postType: '',
    isNotice: false,
    tone: 'default',
  },
)

const session = useSessionStore()

const isAutomaticNotice = computed<boolean>(() => {
  return props.isNotice || props.postType === 'OFFICIAL_NOTICE'
})

const label = computed<string>(() => {
  return isAutomaticNotice.value
    ? session.t('postOrigin.notice')
    : session.t('postOrigin.reminder')
})

const iconName = computed<string>(() => {
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
    <AppIcon :name="iconName" :size="13" />
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
