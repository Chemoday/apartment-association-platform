<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'dark'
  }>(),
  {
    tone: 'neutral',
  },
)
</script>

<template>
  <span
    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border font-label-md text-label-md whitespace-nowrap shrink-0"
    :class="[
      tone === 'success'
        ? 'bg-primary-fixed/80 text-on-primary-fixed border-primary/15'
        : tone === 'danger'
          ? 'bg-error-container text-on-error-container border-error/20'
          : tone === 'warning'
            ? 'bg-secondary-container/85 text-on-secondary-container border-secondary/20'
            : tone === 'dark'
              ? 'bg-inverse-surface text-inverse-on-surface border-transparent'
              : 'bg-surface-container text-on-surface-variant border-outline-variant/40',
    ]"
  >
    <slot />
  </span>
</template>
