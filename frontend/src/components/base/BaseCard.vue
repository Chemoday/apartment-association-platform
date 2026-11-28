<script setup lang="ts">
withDefaults(
  defineProps<{
    padding?: string
  }>(),
  {
    padding: 'p-space-lg',
  },
)
</script>

<template>
  <div
    class="bg-surface-container-lowest rounded-[var(--radius-card)] border border-outline-variant/45 shadow-card"
    :class="padding"
  >
    <slot />
  </div>
</template>
