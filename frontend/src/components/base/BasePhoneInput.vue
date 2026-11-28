<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { composePhoneNumber, getSortedPhoneCountries } from '@/utils/phone.js'

const props = withDefaults(
  defineProps<{
    modelValue: string | null
    defaultCountry?: string | null
    id?: string
    required?: boolean
    disabled?: boolean
    placeholder?: string
    error?: string
  }>(),
  {
    defaultCountry: 'EE',
    id: 'phone-input',
    required: false,
    disabled: false,
    placeholder: '5765 4321',
    error: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const countries = computed(() => getSortedPhoneCountries(props.defaultCountry))
const selectedCountry = ref<string>(countries.value[0]?.code || 'EE')
const nationalNumber = ref<string>('')

watch(
  () => props.defaultCountry,
  () => {
    if (!nationalNumber.value) {
      selectedCountry.value = countries.value[0]?.code || 'EE'
    }
  },
)

watch(
  () => props.modelValue,
  (val) => {
    if (!val && nationalNumber.value) {
      nationalNumber.value = ''
    }
  },
)

function emitComposed() {
  emit('update:modelValue', composePhoneNumber(selectedCountry.value, nationalNumber.value))
}

function handleCountryChange(event: Event) {
  const target = event.target as HTMLSelectElement
  selectedCountry.value = target.value
  emitComposed()
}

function handleNumberInput(event: Event) {
  const target = event.target as HTMLInputElement
  nationalNumber.value = target.value
  emitComposed()
}
</script>

<template>
  <div class="space-y-1">
    <div class="flex gap-2">
      <select
        :value="selectedCountry"
        :disabled="disabled"
        aria-label="Country calling code"
        class="px-2.5 py-2 rounded-[var(--radius-control)] bg-surface-container-lowest border border-outline-variant/80 text-xs text-on-surface focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 shrink-0 transition-colors"
        @change="handleCountryChange"
      >
        <option v-for="c in countries" :key="c.code" :value="c.code">
          {{ c.flag }} {{ c.code }} {{ c.dialCode }}
        </option>
      </select>

      <input
        :id="id"
        :value="nationalNumber"
        type="tel"
        inputmode="tel"
        autocomplete="tel-national"
        :required="required"
        :disabled="disabled"
        :placeholder="placeholder"
        class="flex-1 min-w-0 px-3 py-2 rounded-[var(--radius-control)] bg-surface-container-lowest border text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 transition-colors"
        :class="
          error
            ? 'border-error focus:border-error focus:ring-error/20'
            : 'border-outline-variant/80 focus:border-primary focus:ring-primary/20'
        "
        @input="handleNumberInput"
      />
    </div>
    <p v-if="error" class="text-xs text-error font-medium">
      {{ error }}
    </p>
  </div>
</template>
