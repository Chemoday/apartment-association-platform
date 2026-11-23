import { ref } from 'vue'

export interface OfflineDemoRequestOptions {
  method?: string
  body?: unknown
  contentType?: string
  headers?: Record<string, string>
  raw?: boolean
  signal?: AbortSignal
  actingUserId?: string
}

export interface OfflineDemoModule {
  enableOfflineDemo: () => void
  disableOfflineDemo?: () => void
  resolveOfflineDemoRequest: (path: string, options?: OfflineDemoRequestOptions) => Promise<unknown>
}

export type OfflineDemoImporter = () => Promise<OfflineDemoModule>

/** Shared reactive flag indicating whether browser offline demo mode is active. */
export const isOfflineDemoMode = ref<boolean>(false)

let cachedModulePromise: Promise<OfflineDemoModule> | null = null
let customModuleImporter: OfflineDemoImporter | null = null

/**
 * Returns false when built with VITE_DISABLE_OFFLINE_DEMO=true for strict production builds.
 */
export function isOfflineDemoAllowed(): boolean {
  if (
    typeof import.meta.env !== 'undefined' &&
    import.meta.env.VITE_DISABLE_OFFLINE_DEMO === 'true'
  ) {
    return false
  }
  return true
}

/**
 * Test-only hook to simulate transient dynamic import failures for offlineDemoData.js.
 */
export function setOfflineDemoImporterForTest(importer: OfflineDemoImporter | null = null): void {
  customModuleImporter = importer
  cachedModulePromise = null
}

/**
 * Lazily import the offline demo engine chunk only when offline demo mode is activated.
 * Resets `cachedModulePromise` on failure so a transient network drop never wedges the tab.
 */
export function loadOfflineDemoModule(): Promise<OfflineDemoModule> {
  if (
    typeof import.meta.env !== 'undefined' &&
    import.meta.env.VITE_DISABLE_OFFLINE_DEMO === 'true'
  ) {
    return Promise.reject(new Error('Offline demo mode is disabled in this build'))
  }
  if (!cachedModulePromise) {
    const loader: OfflineDemoImporter =
      customModuleImporter || (() => import('./offlineDemoData.js') as Promise<OfflineDemoModule>)
    cachedModulePromise = Promise.resolve()
      .then(() => loader())
      .catch((err) => {
        cachedModulePromise = null
        throw err
      })
  }
  return cachedModulePromise
}

export async function enableOfflineDemoAsync(): Promise<void> {
  const mod = await loadOfflineDemoModule()
  mod.enableOfflineDemo()
}

export function disableOfflineDemo(): void {
  isOfflineDemoMode.value = false
}

export async function resolveOfflineDemoRequestLazy(
  path: string,
  options?: OfflineDemoRequestOptions,
): Promise<unknown> {
  const mod = await loadOfflineDemoModule()
  return mod.resolveOfflineDemoRequest(path, options)
}
