<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    icon?: string
    disabled?: boolean
    loading?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    icon: '',
    disabled: false,
    loading: false,
  },
)

defineEmits<{
  (e: 'click', event: MouseEvent): void
}>()
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-label-md text-label-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 disabled:cursor-not-allowed"
    :class="[
      size === 'sm' ? 'px-3 py-1.5 text-xs' : size === 'lg' ? 'px-5 py-3 text-sm font-semibold' : 'px-4 py-2 text-xs font-semibold',
      variant === 'primary'
        ? 'bg-primary text-on-primary hover:bg-primary-container shadow-xs'
        : variant === 'danger'
          ? 'bg-error text-on-error hover:opacity-90 shadow-xs'
          : variant === 'ghost'
            ? 'bg-transparent text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
            : 'bg-surface-container-lowest border border-outline-variant/75 text-on-surface hover:bg-surface-container-low shadow-2xs',
    ]"
    @click="$emit('click', $event)"
  >
    <AppIcon v-if="loading" name="sync" :size="15" class="animate-spin" />
    <AppIcon v-else-if="icon" :name="icon" :size="size === 'lg' ? 17 : 15" />
    <slot />
  </button>
</template>
