<script setup lang="ts">
import { nextTick, onBeforeUnmount, onErrorCaptured, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { asApiErrorLike, lastTraceId } from '@/api/client.js'
import { buildDiagnosticReport, reportError } from '@/utils/telemetry.js'

const route = useRoute()
const session = useSessionStore()

const capturedError = ref<unknown>(null)
const copied = ref(false)
const retryKey = ref(0)
const errorSectionRef = ref<HTMLElement | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function clearCopyTimer() {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
}

onErrorCaptured((err, _instance, info) => {
  capturedError.value = err || new Error('Unexpected render error')
  copied.value = false
  clearCopyTimer()
  reportError(err, {
    source: 'errorBoundary',
    routeName: String(route?.name || ''),
    traceId: lastTraceId.value || '',
    extra: { lifecycleHook: String(info || '') },
  })
  nextTick(() => {
    if (errorSectionRef.value && typeof errorSectionRef.value.focus === 'function') {
      errorSectionRef.value.focus()
    }
  })
  return false
})

watch(
  () => route?.fullPath,
  () => {
    if (capturedError.value) {
      capturedError.value = null
      copied.value = false
      clearCopyTimer()
    }
  },
)

onBeforeUnmount(() => {
  clearCopyTimer()
})

function resetBoundary() {
  capturedError.value = null
  copied.value = false
  clearCopyTimer()
  retryKey.value += 1
}

function reloadPage() {
  if (typeof window !== 'undefined' && window.location?.reload) {
    window.location.reload()
  }
}

async function copyDiagnostics() {
  const report = buildDiagnosticReport({
    traceId: lastTraceId.value || '',
    errorCode: asApiErrorLike(capturedError.value).errorCode || 'UI_RENDER_ERROR',
    routeName: String(route?.name || ''),
  })
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(report)
      copied.value = true
      clearCopyTimer()
      copyTimer = setTimeout(() => {
        copied.value = false
      }, 2500)
    }
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <div v-if="!capturedError" :key="retryKey" class="contents">
    <slot />
  </div>
  <div v-else class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-xl">
    <section
      ref="errorSectionRef"
      tabindex="-1"
      class="bg-surface-container-lowest border border-error/30 rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-4 shadow-xs focus:outline-none"
      role="alert"
      aria-labelledby="error-boundary-title"
    >
      <div
        class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto"
      >
        <span class="material-symbols-outlined text-[24px]" aria-hidden="true">error</span>
      </div>
      <h1 id="error-boundary-title" class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('errorBoundary.title') }}
      </h1>
      <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
        {{ session.t('errorBoundary.description') }}
      </p>
      <p v-if="lastTraceId" class="font-mono text-[11px] text-on-surface-variant">
        Trace ID:
        <code class="bg-error-container/50 text-on-error-container px-1.5 py-0.5 rounded">
          {{ lastTraceId }}
        </code>
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2 pt-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
          @click="resetBoundary"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>
          <span>{{ session.t('errorBoundary.tryAgain') }}</span>
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface hover:bg-surface-container-low transition-colors"
          @click="reloadPage"
        >
          <span>{{ session.t('errorBoundary.reloadPage') }}</span>
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface-variant hover:bg-surface-container-low transition-colors"
          @click="copyDiagnostics"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">
            {{ copied ? 'check' : 'content_copy' }}
          </span>
          <span>
            {{
              copied
                ? session.t('errorBoundary.copiedDiagnostics')
                : session.t('errorBoundary.copyDiagnostics')
            }}
          </span>
        </button>
      </div>
    </section>
  </div>
</template>
