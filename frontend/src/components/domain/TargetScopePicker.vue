<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'

const props = defineProps({
  modelValue: {
    type: Object,
    required: true,
  },
  apartments: {
    type: Array,
    default: () => [],
  },
  availableEntrances: {
    type: Array,
    default: () => [1, 2],
  },
  errorMessage: {
    type: String,
    default: '',
  },
  testIdPrefix: {
    type: String,
    default: 'target-picker',
  },
})

const emit = defineEmits(['update:modelValue', 'change'])

const session = useSessionStore()

const currentScope = computed(() => props.modelValue?.target_scope || 'ALL_BUILDING')
const currentEntrance = computed(() => props.modelValue?.target_entrance ?? 1)
const currentApartmentIds = computed(() =>
  Array.isArray(props.modelValue?.target_apartment_ids) ? props.modelValue.target_apartment_ids : [],
)

function updateScope(newScope) {
  emit('update:modelValue', {
    ...props.modelValue,
    target_scope: newScope,
    target_entrance: newScope === 'ENTRANCE' ? (currentEntrance.value || 1) : null,
    target_apartment_ids: newScope === 'APARTMENT_LIST' ? currentApartmentIds.value : null,
  })
  emit('change')
}

function updateEntrance(newEntrance) {
  emit('update:modelValue', {
    ...props.modelValue,
    target_entrance: Number(newEntrance),
  })
  emit('change')
}

function toggleApartment(aptId, checked) {
  const current = [...currentApartmentIds.value]
  const updated = checked
    ? Array.from(new Set([...current, aptId]))
    : current.filter((id) => id !== aptId)

  emit('update:modelValue', {
    ...props.modelValue,
    target_apartment_ids: updated,
  })
  emit('change')
}
</script>

<template>
  <div class="space-y-3">
    <!-- Scope Selector -->
    <div>
      <label class="block text-sm font-semibold text-on-surface">
        {{ session.t('polls.editor.targetScopeLabel') }}
      </label>
      <select
        :value="currentScope"
        :data-testid="`${testIdPrefix}-scope-select`"
        class="mt-1 block w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3.5 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
        @change="updateScope($event.target.value)"
      >
        <option value="ALL_BUILDING">{{ session.t('polls.target.allBuilding') }}</option>
        <option value="ENTRANCE">{{ session.t('polls.editor.targetByEntrance') }}</option>
        <option value="APARTMENT_LIST">{{ session.t('polls.target.selectedApartments') }}</option>
      </select>
    </div>

    <!-- Entrance Selector when Scope === ENTRANCE -->
    <div v-if="currentScope === 'ENTRANCE'" class="pt-1">
      <label class="block text-xs font-semibold text-on-surface">
        {{ session.t('polls.editor.selectEntranceLabel') }}
      </label>
      <select
        :value="currentEntrance"
        :data-testid="`${testIdPrefix}-entrance-select`"
        class="mt-1 block w-48 rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
        @change="updateEntrance($event.target.value)"
      >
        <option v-for="ent in availableEntrances" :key="ent" :value="ent">
          {{ session.t('polls.target.entrance', { entrance: ent }) }}
        </option>
      </select>
    </div>

    <!-- Apartment Multi-Select when Scope === APARTMENT_LIST -->
    <div v-if="currentScope === 'APARTMENT_LIST'" class="pt-1">
      <span class="block text-xs font-semibold text-on-surface">
        {{ session.t('polls.editor.selectApartmentsLabel') }}
      </span>
      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-6 max-h-60 overflow-y-auto p-1">
        <label
          v-for="apt in apartments"
          :key="apt.apartment_id"
          class="flex cursor-pointer items-center gap-2 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-2 text-xs font-medium text-on-surface hover:border-primary/40 transition-colors"
        >
          <input
            type="checkbox"
            :checked="currentApartmentIds.includes(apt.apartment_id)"
            class="h-4 w-4 rounded accent-primary"
            @change="toggleApartment(apt.apartment_id, $event.target.checked)"
          />
          <span>{{ session.t('common.aptShort', { number: apt.apartment_number }) }}</span>
        </label>
      </div>
    </div>

    <p v-if="errorMessage" class="text-xs font-semibold text-error">
      {{ errorMessage }}
    </p>
  </div>
</template>
