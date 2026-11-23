<script setup lang="ts">
import { computed } from 'vue'

const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    id: string
    label?: string
    placeholder?: string
    hint?: string
    error?: string
    rows?: number
    maxlength?: number
    disabled?: boolean
    required?: boolean
  }>(),
  {
    label: '',
    placeholder: '',
    hint: '',
    error: '',
    rows: 4,
    maxlength: undefined,
    disabled: false,
    required: false,
  },
)

const errorId = computed(() => (props.error ? `${props.id}-error` : undefined))
const hintId = computed(() => (!props.error && props.hint ? `${props.id}-hint` : undefined))
const describedBy = computed(() => errorId.value || hintId.value || undefined)
const charCount = computed(() => (model.value || '').length)
</script>

<template>
  <div class="flex flex-col gap-1">
    <div
      v-if="label || maxlength"
      class="font-label-md text-label-md text-on-surface font-semibold flex items-center justify-between gap-2"
    >
      <label v-if="label" :for="id">
        {{ label }}
        <span v-if="required" class="text-error ml-0.5" aria-hidden="true">*</span>
      </label>
      <span v-else />
      <span
        v-if="maxlength"
        data-testid="textarea-counter"
        class="text-[11px] font-normal tabular-nums"
        :class="charCount > maxlength ? 'text-error font-semibold' : 'text-on-surface-variant'"
      >
        {{ charCount }} / {{ maxlength }}
      </span>
    </div>
    <textarea
      :id="id"
      v-model="model"
      :rows="rows"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="describedBy"
      class="w-full px-3 py-2.5 bg-surface-container-lowest border rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition-colors resize-y disabled:bg-surface-container-low disabled:text-on-surface-variant"
      :class="error ? 'border-error focus:ring-error' : 'border-outline-variant'"
    />
    <p v-if="error" :id="errorId" role="alert" class="text-xs text-error font-medium mt-0.5">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="hintId" class="text-xs text-on-surface-variant mt-0.5">
      {{ hint }}
    </p>
  </div>
</template>
