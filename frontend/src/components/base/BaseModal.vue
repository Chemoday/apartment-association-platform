<script lang="ts">
let nextModalId = 0
const openModalStack: number[] = []
const handledEscapeEvents = new WeakSet<object>()
</script>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    subtitle?: string
    maxWidth?: string
    closeAriaLabel?: string
  }>(),
  {
    subtitle: '',
    maxWidth: 'max-w-lg',
    closeAriaLabel: 'Close modal',
  },
)

const emit = defineEmits<{
  (e: 'close'): void
}>()
const modalId = ++nextModalId
const dialogPanelRef = ref<HTMLElement | null>(null)
let previousFocusedElement: Element | null = null

function pushToStack(): void {
  removeFromStack()
  openModalStack.push(modalId)
}

function removeFromStack(): void {
  const idx = openModalStack.indexOf(modalId)
  if (idx !== -1) {
    openModalStack.splice(idx, 1)
  }
}

function isTopModal(): boolean {
  return openModalStack.length > 0 && openModalStack[openModalStack.length - 1] === modalId
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(): HTMLElement[] {
  const panel = dialogPanelRef.value
  if (!panel || typeof panel.querySelectorAll !== 'function') return []
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute?.('hidden') && el.offsetParent !== null,
  )
}

function restorePreviousFocus(): void {
  const prev = previousFocusedElement as HTMLElement | null
  previousFocusedElement = null
  if (prev && typeof prev.focus === 'function') {
    prev.focus()
  }
}

watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen && !wasOpen) {
      pushToStack()
      if (typeof document !== 'undefined' && document.activeElement) {
        previousFocusedElement = document.activeElement
      }
      await nextTick()
      if (!props.open || !isTopModal()) return
      const focusables = getFocusableElements()
      if (focusables.length > 0 && typeof focusables[0].focus === 'function') {
        focusables[0].focus()
      } else if (typeof dialogPanelRef.value?.focus === 'function') {
        dialogPanelRef.value.focus()
      }
    } else if (!isOpen && wasOpen) {
      removeFromStack()
      restorePreviousFocus()
    }
  },
  { immediate: true },
)

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open || !isTopModal()) return
  if (event.key === 'Escape') {
    if (event && typeof event === 'object') {
      if (handledEscapeEvents.has(event)) return
      handledEscapeEvents.add(event)
    }
    event.stopImmediatePropagation?.()
    emit('close')
    return
  }
  if (event.key === 'Tab') {
    const focusables = getFocusableElements()
    if (focusables.length === 0) {
      event.preventDefault?.()
      dialogPanelRef.value?.focus?.()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (event.shiftKey) {
      if (active === first || !dialogPanelRef.value?.contains?.(active)) {
        event.preventDefault?.()
        last.focus?.()
      }
    } else if (active === last || !dialogPanelRef.value?.contains?.(active)) {
      event.preventDefault?.()
      first.focus?.()
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  removeFromStack()
  window.removeEventListener('keydown', handleKeydown)
  if (props.open) {
    restorePreviousFocus()
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 bg-on-surface/40 backdrop-blur-xs flex items-center justify-center p-space-md"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      @click.self="$emit('close')"
    >
      <div
        ref="dialogPanelRef"
        tabindex="-1"
        class="w-full rounded-[var(--radius-card)] bg-surface-container-lowest shadow-popover border border-outline-variant/50 overflow-hidden flex flex-col max-h-[90vh] focus:outline-none"
        :class="maxWidth"
      >
        <div class="px-space-lg py-space-md bg-surface-container-low flex items-center justify-between gap-space-sm border-b border-outline-variant/40">
          <div class="flex items-center gap-space-sm min-w-0">
            <slot name="icon" />
            <div class="min-w-0">
              <h3 class="font-headline-md text-headline-md text-on-surface font-semibold truncate">
                {{ title }}
              </h3>
              <p v-if="subtitle" class="font-body-sm text-body-sm text-on-surface-variant truncate">
                {{ subtitle }}
              </p>
            </div>
          </div>
          <button
            type="button"
            :aria-label="closeAriaLabel || 'Close modal'"
            class="p-1.5 rounded-[var(--radius-control)] hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
            @click="$emit('close')"
          >
            <AppIcon name="close" :size="19" />
          </button>
        </div>

        <div class="p-space-lg overflow-y-auto flex-1">
          <slot />
        </div>

        <div
          v-if="$slots.footer"
          class="px-space-lg py-space-md bg-surface-container-low border-t border-outline-variant/40 flex items-center justify-end gap-space-sm"
        >
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
