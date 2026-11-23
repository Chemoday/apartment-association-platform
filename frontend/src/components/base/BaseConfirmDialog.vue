<script setup lang="ts">
import BaseModal from './BaseModal.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'primary' | 'danger'
    busy?: boolean
  }>(),
  {
    message: '',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    tone: 'danger',
    busy: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <BaseModal :open="open" :title="title" max-width="max-w-md" @close="!busy && emit('cancel')">
    <p v-if="message" class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
      {{ message }}
    </p>
    <slot />
    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="px-4 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          :disabled="busy"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="px-4 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
          :class="
            tone === 'danger'
              ? 'bg-error text-on-error hover:opacity-90'
              : 'bg-primary text-on-primary hover:bg-primary-container'
          "
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>
