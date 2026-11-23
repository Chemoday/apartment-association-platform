<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    id: string
    label?: string
    hint?: string
    error?: string
    required?: boolean
  }>(),
  {
    label: '',
    hint: '',
    error: '',
    required: false,
  },
)

const hintId = computed(() => (!props.error && props.hint ? `${props.id}-hint` : undefined))
const errorId = computed(() => (props.error ? `${props.id}-error` : undefined))
const describedBy = computed(() => errorId.value || hintId.value || undefined)
</script>

<template>
  <div class="flex flex-col gap-1">
    <label
      v-if="label"
      :for="id"
      class="font-label-md text-label-md text-on-surface font-semibold flex items-center justify-between gap-2"
    >
      <span>
        {{ label }}
        <span v-if="required" class="text-error ml-0.5" aria-hidden="true">*</span>
      </span>
      <slot name="label-extra" />
    </label>

    <slot
      :id="id"
      :error-id="errorId"
      :hint-id="hintId"
      :described-by="describedBy"
      :invalid="Boolean(error)"
    />

    <p v-if="error" :id="errorId" role="alert" class="text-xs text-error font-medium mt-0.5">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="hintId" class="text-xs text-on-surface-variant mt-0.5">
      {{ hint }}
    </p>
  </div>
</template>
