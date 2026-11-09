<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStore } from '@/stores/session.js'

const session = useSessionStore()
const isOpen = ref(false)
const rootRef = ref(null)

const localeNames = {
  en: 'English (EN)',
  et: 'Eesti (ET)',
  ru: 'Русский (RU)',
}

const currentLocaleLabel = computed(() => {
  const current = session.supportedLocales.find((l) => l.code === session.lang)
  return current ? current.label : session.lang.toUpperCase()
})

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function closeDropdown() {
  isOpen.value = false
}

function selectLocale(code) {
  session.setLang(code)
  isOpen.value = false
}

function handleDocumentClick(event) {
  if (rootRef.value && !rootRef.value.contains(event.target)) {
    isOpen.value = false
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div ref="rootRef" class="relative shrink-0">
    <!-- Trigger Button -->
    <button
      type="button"
      data-testid="language-dropdown-btn"
      :aria-expanded="isOpen"
      aria-haspopup="true"
      aria-label="Select Language"
      class="h-9 px-2.5 rounded-xl border border-surface-container bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
      :class="isOpen ? 'bg-surface-container ring-2 ring-primary/20' : ''"
      @click="toggleDropdown"
    >
      <span class="material-symbols-outlined text-[17px] text-primary" aria-hidden="true">
        language
      </span>
      <span class="uppercase tracking-wide">{{ currentLocaleLabel }}</span>
      <span
        class="material-symbols-outlined text-[16px] text-on-surface-variant transition-transform duration-150"
        :class="isOpen ? 'rotate-180' : ''"
        aria-hidden="true"
      >
        expand_more
      </span>
    </button>

    <!-- Dropdown Popover Menu -->
    <div
      v-if="isOpen"
      data-testid="language-dropdown-menu"
      role="menu"
      class="absolute right-0 top-full mt-1.5 w-44 bg-surface-container-lowest border border-surface-container rounded-2xl p-1.5 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100 space-y-0.5"
    >
      <button
        v-for="loc in session.supportedLocales"
        :key="loc.code"
        type="button"
        role="menuitem"
        :data-testid="`language-option-${loc.code}`"
        class="w-full px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 transition-colors cursor-pointer text-left"
        :class="
          session.lang === loc.code
            ? 'bg-primary text-on-primary shadow-2xs'
            : 'text-on-surface hover:bg-surface-container'
        "
        @click="selectLocale(loc.code)"
      >
        <span>{{ localeNames[loc.code] || loc.label }}</span>
        <span
          v-if="session.lang === loc.code"
          class="material-symbols-outlined text-[16px]"
          aria-hidden="true"
        >
          check
        </span>
      </button>
    </div>
  </div>
</template>
