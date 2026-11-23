import { onBeforeUnmount, onMounted, ref, unref, type Ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

export type DirtySource = Ref<boolean> | (() => boolean)

export interface UnsavedChangesGuardOptions {
  registerRouteGuard?: boolean
}

/**
 * Protect forms with unsaved edits against accidental browser reload/close
 * (`beforeunload`) and in-app SPA route navigation (`onBeforeRouteLeave`).
 *
 * Returns reactive modal state (`showLeaveModal`, `confirmLeave`, `cancelLeave`)
 * so views can render a localized `BaseConfirmDialog` without calling native `window.confirm`.
 */
export function useUnsavedChangesGuard(
  dirtySource: DirtySource,
  options: UnsavedChangesGuardOptions = {},
) {
  const { registerRouteGuard = true } = options
  const showLeaveModal = ref<boolean>(false)
  let pendingResolver: ((allowLeave: boolean) => void) | null = null

  function isDirty(): boolean {
    try {
      return Boolean(typeof dirtySource === 'function' ? dirtySource() : unref(dirtySource))
    } catch {
      return false
    }
  }

  function handleBeforeUnload(
    event: Pick<BeforeUnloadEvent, 'preventDefault'> & { returnValue?: unknown },
  ): void {
    if (!isDirty()) return
    event.preventDefault()
    // Standard cross-browser trigger for browser unsaved-changes confirmation prompt
    event.returnValue = ''
  }

  function requestLeaveDecision(): boolean | Promise<boolean> {
    if (!isDirty()) return true
    if (pendingResolver) {
      pendingResolver(false)
      pendingResolver = null
    }
    showLeaveModal.value = true
    return new Promise<boolean>((resolve) => {
      pendingResolver = resolve
    })
  }

  function confirmLeave(): void {
    showLeaveModal.value = false
    const resolve = pendingResolver
    pendingResolver = null
    if (resolve) resolve(true)
  }

  function cancelLeave(): void {
    showLeaveModal.value = false
    const resolve = pendingResolver
    pendingResolver = null
    if (resolve) resolve(false)
  }

  if (registerRouteGuard) {
    try {
      onBeforeRouteLeave(() => requestLeaveDecision())
    } catch {
      // Safe no-op when component is mounted outside a Vue Router context (e.g. isolated unit tests)
    }
  }

  onMounted(() => {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', handleBeforeUnload)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
    if (pendingResolver) {
      pendingResolver(true)
      pendingResolver = null
    }
    showLeaveModal.value = false
  })

  return {
    showLeaveModal,
    confirmLeave,
    cancelLeave,
    requestLeaveDecision,
    handleBeforeUnload,
  }
}
