<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

export type AlertBannerVariant = 'info' | 'success' | 'warning' | 'error'

const props = withDefaults(
  defineProps<{
    variant?: AlertBannerVariant
    title?: string
    message?: string
    dismissible?: boolean
    dismissLabel?: string
  }>(),
  {
    variant: 'info',
    title: '',
    message: '',
    dismissible: false,
    dismissLabel: 'Dismiss',
  },
)

defineEmits<{
  (e: 'dismiss'): void
}>()

const role = computed(() => (props.variant === 'error' || props.variant === 'warning' ? 'alert' : 'status'))

const iconName = computed(() => {
  switch (props.variant) {
    case 'success':
      return 'check_circle'
    case 'warning':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
})

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'success':
      return 'bg-primary-fixed/65 border-primary/25 text-on-primary-fixed'
    case 'warning':
      return 'bg-secondary-container/80 border-secondary/25 text-on-secondary-container'
    case 'error':
      return 'bg-error-container/70 border-error/30 text-on-error-container'
    default:
      return 'bg-surface-container-low border-outline-variant/60 text-on-surface'
  }
})
</script>

<template>
  <div
    :role="role"
    class="rounded-[var(--radius-card)] border px-4 py-3 flex items-start gap-3 text-sm"
    :class="variantClasses"
  >
    <AppIcon :name="iconName" :size="18" class="mt-0.5" />
    <div class="min-w-0 flex-1 space-y-0.5">
      <p v-if="title" class="font-semibold leading-snug">{{ title }}</p>
      <p v-if="message" class="leading-relaxed opacity-90">{{ message }}</p>
      <slot />
    </div>
    <button
      v-if="dismissible"
      type="button"
      :aria-label="dismissLabel"
      class="shrink-0 p-1 rounded-md opacity-70 hover:opacity-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      @click="$emit('dismiss')"
    >
      <AppIcon name="close" :size="16" />
    </button>
  </div>
</template>
