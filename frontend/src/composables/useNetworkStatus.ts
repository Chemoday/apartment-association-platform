import { onBeforeUnmount, onMounted, ref } from 'vue'

export interface NetworkStatusDeps {
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  nav?: { onLine?: boolean } | null
}

/**
 * Reactive browser connectivity status (`navigator.onLine` + `online`/`offline` listeners).
 * Distinct from BackendOfflineModal: signals local browser network drops cleanly.
 */
export function useNetworkStatus(deps: NetworkStatusDeps = {}) {
  const win = deps.win !== undefined ? deps.win : typeof window !== 'undefined' ? window : null
  const nav =
    deps.nav !== undefined ? deps.nav : typeof navigator !== 'undefined' ? navigator : null

  const isOnline = ref<boolean>(nav ? nav.onLine !== false : true)

  function handleOnline(): void {
    isOnline.value = true
  }

  function handleOffline(): void {
    isOnline.value = false
  }

  function attach(): void {
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('online', handleOnline)
      win.addEventListener('offline', handleOffline)
    }
  }

  function detach(): void {
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('online', handleOnline)
      win.removeEventListener('offline', handleOffline)
    }
  }

  onMounted(attach)
  onBeforeUnmount(detach)

  return {
    isOnline,
    attach,
    detach,
  }
}
