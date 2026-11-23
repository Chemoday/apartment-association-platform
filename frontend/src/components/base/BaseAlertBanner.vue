<script setup lang="ts">
import { computed } from 'vue'

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
      return 'bg-emerald-50/90 border-emerald-200 text-emerald-900'
    case 'warning':
      return 'bg-amber-50/90 border-amber-200 text-amber-900'
    case 'error':
      return 'bg-error-container/50 border-error/30 text-on-error-container'
    default:
      return 'bg-surface-container-low border-outline-variant/60 text-on-surface'
  }
})
</script>

<template>
  <div
    :role="role"
    class="rounded-xl border px-4 py-3 flex items-start gap-3 text-sm"
    :class="variantClasses"
  >
    <span class="material-symbols-outlined text-[18px] shrink-0 mt-0.5" aria-hidden="true">
      {{ iconName }}
    </span>
    <div class="min-w-0 flex-1 space-y-0.5">
      <p v-if="title" class="font-semibold leading-snug">{{ title }}</p>
      <p v-if="message" class="leading-relaxed opacity-90">{{ message }}</p>
      <slot />
    </div>
    <button
      v-if="dismissible"
      type="button"
      :aria-label="dismissLabel"
      class="shrink-0 p-1 rounded-md opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      @click="$emit('dismiss')"
    >
      <span class="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
    </button>
  </div>
</template>
