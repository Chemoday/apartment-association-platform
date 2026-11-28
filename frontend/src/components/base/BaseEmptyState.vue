<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    icon?: string
    title: string
    description?: string
  }>(),
  {
    icon: 'inbox',
    description: '',
  },
)
</script>

<template>
  <div class="p-space-xl rounded-[var(--radius-card)] bg-surface-container-lowest border border-outline-variant/45 shadow-card text-center flex flex-col items-center justify-center gap-2">
    <div class="w-11 h-11 rounded-full bg-surface-container-low border border-outline-variant/35 text-on-surface-variant flex items-center justify-center">
      <AppIcon :name="icon" :size="22" />
    </div>
    <h3 class="font-headline-md text-headline-md text-on-surface font-semibold">{{ title }}</h3>
    <p v-if="description" class="font-body-sm text-body-sm text-on-surface-variant max-w-md">
      {{ description }}
    </p>
    <div v-if="$slots.default" class="mt-2">
      <slot />
    </div>
  </div>
</template>
