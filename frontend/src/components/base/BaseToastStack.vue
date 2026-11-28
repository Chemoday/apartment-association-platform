<script setup lang="ts">
import AppIcon from './AppIcon.vue'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  message: string
  variant?: ToastVariant
}

withDefaults(
  defineProps<{
    toasts: ToastItem[]
    dismissLabel?: string
  }>(),
  {
    dismissLabel: 'Dismiss notification',
  },
)

defineEmits<{
  (e: 'dismiss', id: string): void
}>()
</script>

<template>
  <div
    class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      :role="toast.variant === 'error' ? 'alert' : 'status'"
      class="pointer-events-auto rounded-[var(--radius-card)] border px-4 py-3 shadow-popover flex items-center justify-between gap-3 text-sm"
      :class="
        toast.variant === 'error'
          ? 'bg-error text-on-error border-error'
          : toast.variant === 'success'
            ? 'bg-primary text-on-primary border-primary-container'
            : toast.variant === 'warning'
              ? 'bg-secondary text-on-secondary border-secondary'
              : 'bg-inverse-surface text-inverse-on-surface border-outline-variant/30'
      "
    >
      <span class="leading-snug">{{ toast.message }}</span>
      <button
        type="button"
        :aria-label="dismissLabel"
        class="shrink-0 opacity-80 hover:opacity-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white rounded"
        @click="$emit('dismiss', toast.id)"
      >
        <AppIcon name="close" :size="16" />
      </button>
    </div>
  </div>
</template>
