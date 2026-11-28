<script setup lang="ts">
import { computed } from 'vue'
import type { PeriodStatus, ReadingSource } from '@/api/schema.js'
import { useSessionStore } from '@/stores/session.js'
import { useTranslations } from '@/locales/index.js'
import AppIcon from '@/components/base/AppIcon.vue'

export type StatusChipValue =
  | PeriodStatus
  | ReadingSource
  | 'SUBMITTED'
  | 'MISSING'
  | 'ANOMALY_CONFIRMED'
  | 'AUTO_ESTIMATED'
  | 'ADMIN_OVERRIDE'

const props = defineProps<{
  status: StatusChipValue | string
}>()

const session = useSessionStore()
const t = computed(() => useTranslations(session.lang))

const label = computed<string>(() => {
  const statusMap = t.value.status as Record<string, string> | undefined
  return statusMap?.[props.status] || props.status
})

const classes = computed<string>(() => {
  switch (props.status) {
    case 'SUBMITTED':
    case 'OPEN_FOR_RESIDENTS':
      return 'bg-primary-fixed/80 text-on-primary-fixed border-primary/15'
    case 'ANOMALY_CONFIRMED':
    case 'MISSING':
      return 'bg-error-container text-on-error-container border-error/20'
    case 'ADMIN_OVERRIDE':
      return 'bg-primary text-on-primary border-transparent'
    case 'REVIEW_BY_BOARD':
      return 'bg-secondary-container/85 text-on-secondary-container border-secondary/20'
    default:
      return 'bg-surface-container text-on-surface-variant border-outline-variant/40'
  }
})

const icon = computed<string>(() => {
  switch (props.status) {
    case 'SUBMITTED':
    case 'OPEN_FOR_RESIDENTS':
      return 'check_circle'
    case 'ANOMALY_CONFIRMED':
      return 'priority_high'
    case 'MISSING':
      return 'schedule'
    case 'AUTO_ESTIMATED':
      return 'calculate'
    case 'ADMIN_OVERRIDE':
      return 'shield'
    case 'LOCKED':
      return 'lock'
    default:
      return 'verified'
  }
})
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border font-label-md text-label-md font-semibold whitespace-nowrap shrink-0"
    :class="classes"
  >
    <AppIcon :name="icon" :size="14" />
    <span>{{ label }}</span>
  </span>
</template>
