<script setup lang="ts">
import { computed } from 'vue'

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    id: string
    label?: string
    placeholder?: string
    suffix?: string
    error?: string
    disabled?: boolean
    type?: string
  }>(),
  {
    label: '',
    placeholder: '',
    suffix: '',
    error: '',
    disabled: false,
    type: 'text',
  },
)

const errorId = computed(() => (props.error ? `${props.id}-error` : undefined))
</script>

<template>
  <div class="flex flex-col gap-1">
    <label
      v-if="label"
      :for="id"
      class="font-label-md text-label-md text-on-surface font-semibold"
    >
      {{ label }}
    </label>
    <div class="relative">
      <input
        :id="id"
        v-model="model"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="errorId"
        class="w-full h-11 px-3 bg-surface-container-lowest border rounded-[var(--radius-control)] font-body-sm text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 transition-colors disabled:bg-surface-container-low disabled:text-on-surface-variant"
        :class="[
          error
            ? 'border-error focus:border-error focus:ring-error/20'
            : 'border-outline-variant/80 focus:border-primary focus:ring-primary/20',
          suffix ? 'pr-14' : '',
        ]"
      />
      <span
        v-if="suffix"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant font-medium pointer-events-none"
      >
        {{ suffix }}
      </span>
    </div>
    <p v-if="error" :id="errorId" role="alert" class="text-xs text-error font-medium mt-0.5">{{ error }}</p>
  </div>
</template>
