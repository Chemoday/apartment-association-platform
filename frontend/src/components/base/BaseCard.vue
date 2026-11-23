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
    class="bg-surface-container-lowest rounded-xl border border-surface-container shadow-xs"
    :class="padding"
  >
    <slot />
  </div>
</template>
