<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from './BaseButton.vue'

const props = withDefaults(
  defineProps<{
    page: number
    pageSize: number
    total: number
    ariaLabel?: string
    prevLabel?: string
    nextLabel?: string
  }>(),
  {
    ariaLabel: 'Pagination',
    prevLabel: 'Previous',
    nextLabel: 'Next',
  },
)

const emit = defineEmits<{
  (e: 'update:page', nextPage: number): void
}>()

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))))
const safePage = computed(() => Math.min(Math.max(1, props.page), totalPages.value))
const canPrev = computed(() => props.page > 1)
const canNext = computed(() => safePage.value < totalPages.value)
const shouldRender = computed(() => totalPages.value > 1 || props.page > totalPages.value)

function goPrev(): void {
  if (canPrev.value) {
    emit('update:page', Math.min(props.page - 1, totalPages.value))
  }
}

function goNext(): void {
  if (canNext.value) {
    emit('update:page', safePage.value + 1)
  }
}
</script>

<template>
  <nav
    v-if="shouldRender"
    :aria-label="ariaLabel"
    class="flex items-center justify-between gap-3 pt-2"
  >
    <BaseButton
      data-testid="pagination-prev"
      variant="secondary"
      size="sm"
      :disabled="!canPrev"
      @click="goPrev"
    >
      {{ prevLabel }}
    </BaseButton>
    <span class="text-xs font-medium text-on-surface-variant tabular-nums" data-testid="pagination-status">
      {{ safePage }} / {{ totalPages }}
    </span>
    <BaseButton
      data-testid="pagination-next"
      variant="secondary"
      size="sm"
      :disabled="!canNext"
      @click="goNext"
    >
      {{ nextLabel }}
    </BaseButton>
  </nav>
</template>
