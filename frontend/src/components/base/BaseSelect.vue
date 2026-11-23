<script setup lang="ts">
import { computed } from 'vue'

export interface BaseSelectOption {
  value: string
  label: string
  disabled?: boolean
}

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    id: string
    label?: string
    options?: BaseSelectOption[]
    placeholder?: string
    hint?: string
    error?: string
    disabled?: boolean
    required?: boolean
  }>(),
  {
    label: '',
    options: () => [],
    placeholder: '',
    hint: '',
    error: '',
    disabled: false,
    required: false,
  },
)

const errorId = computed(() => (props.error ? `${props.id}-error` : undefined))
const hintId = computed(() => (!props.error && props.hint ? `${props.id}-hint` : undefined))
const describedBy = computed(() => errorId.value || hintId.value || undefined)
</script>

<template>
  <div class="flex flex-col gap-1">
    <label
      v-if="label"
      :for="id"
      class="font-label-md text-label-md text-on-surface font-semibold"
    >
      {{ label }}
      <span v-if="required" class="text-error ml-0.5" aria-hidden="true">*</span>
    </label>
    <select
      :id="id"
      v-model="model"
      :disabled="disabled"
      :required="required"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      class="w-full h-11 px-3 bg-surface-container-lowest border rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition-colors disabled:bg-surface-container-low disabled:text-on-surface-variant"
      :class="error ? 'border-error focus:ring-error' : 'border-outline-variant'"
    >
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option
        v-for="opt in options"
        :key="opt.value"
        :value="opt.value"
        :disabled="opt.disabled"
      >
        {{ opt.label }}
      </option>
      <slot />
    </select>
    <p v-if="error" :id="errorId" role="alert" class="text-xs text-error font-medium mt-0.5">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="hintId" class="text-xs text-on-surface-variant mt-0.5">
      {{ hint }}
    </p>
  </div>
</template>
