<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { asApiErrorLike } from '@/api/client.js'
import { useSessionStore } from '@/stores/session.js'
import { localizeError } from '@/locales/index.js'
import { buildDiagnosticReport } from '@/utils/telemetry.js'
import AppIcon from '@/components/base/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    error: unknown
    title?: string
  }>(),
  {
    title: '',
  },
)

defineEmits<{
  retry: []
}>()

const session = useSessionStore()
let activeRoute: RouteLocationNormalizedLoaded | null = null
try {
  activeRoute = useRoute()
} catch {
  activeRoute = null
}

const copied = ref<boolean>(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function clearCopyTimer(): void {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
}

watch(
  () => props.error,
  () => {
    copied.value = false
    clearCopyTimer()
  },
)

onBeforeUnmount(() => {
  clearCopyTimer()
})

const normalizedError = computed(() => {
  const errLike = asApiErrorLike(props.error)
  const rawTraceId =
    props.error && typeof props.error === 'object' && 'traceId' in props.error
      ? String((props.error as { traceId?: unknown }).traceId || '')
      : ''
  return {
    errorCode: errLike.errorCode || 'INTERNAL_SERVER_ERROR',
    traceId: rawTraceId || errLike.payload?.trace_id || '',
    payload: errLike.payload || {},
  }
})

const errorCode = computed<string>(() => normalizedError.value.errorCode)
const traceId = computed<string>(() => normalizedError.value.traceId)

const localizedMessage = computed<string>(() =>
  localizeError(
    errorCode.value,
    { ...normalizedError.value.payload, trace_id: traceId.value },
    session.lang,
  ),
)

async function copyDiagnostics(): Promise<void> {
  const report = buildDiagnosticReport({
    traceId: traceId.value,
    errorCode: errorCode.value,
    routeName: String(activeRoute?.name || ''),
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
  <div
    class="bg-surface-container-lowest border border-error/30 rounded-[var(--radius-card)] p-space-md shadow-card"
    role="alert"
  >
    <div class="flex items-start gap-3">
      <div class="w-8 h-8 rounded-full bg-error-container text-on-error-container flex items-center justify-center shrink-0">
        <AppIcon name="error" :size="18" />
      </div>
      <div class="flex-1 min-w-0">
        <h4 class="font-label-lg text-label-lg font-bold text-error">
          {{ title || session.t('common.couldNotCompleteRequest') }}
        </h4>
        <p class="font-body-sm text-body-sm text-on-surface-variant mt-1 leading-relaxed">
          {{ localizedMessage }}
        </p>
        <p v-if="traceId" class="mt-1 font-mono text-[11px] text-on-surface-variant">
          Trace ID: <code class="bg-error-container/50 text-on-error-container px-1.5 py-0.5 rounded">{{ traceId }}</code>
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="bg-primary text-on-primary hover:bg-primary-container text-xs font-semibold px-3 py-1.5 rounded-[var(--radius-control)] transition-colors cursor-pointer shadow-xs"
            @click="$emit('retry')"
          >
            {{ session.t('common.tryAgain') }}
          </button>
          <button
            v-if="traceId || errorCode"
            type="button"
            class="inline-flex items-center gap-1 border border-outline-variant/75 text-on-surface-variant hover:bg-surface-container-low text-xs font-semibold px-3 py-1.5 rounded-[var(--radius-control)] transition-colors cursor-pointer"
            @click="copyDiagnostics"
          >
            <AppIcon :name="copied ? 'check' : 'content_copy'" :size="14" />
            <span>
              {{ copied ? session.t('common.copied') : session.t('common.copyDiagnostics') }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
