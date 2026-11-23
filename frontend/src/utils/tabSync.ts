const CHANNEL_NAME = 'hoa_platform_tab_sync'
const STORAGE_KEY = 'hoa_platform_tab_sync_event'

export type TabSyncEventType = 'LOGOUT' | 'SESSION_CHANGED' | 'LOCALE_CHANGED' | 'THEME_CHANGED'

export interface TabSyncEvent {
  type: TabSyncEventType | string
  senderId: string
  ts: number
  lang?: string
  theme?: string
  [key: string]: unknown
}

const ALLOWED_EVENT_TYPES = new Set<string>([
  'LOGOUT',
  'SESSION_CHANGED',
  'LOCALE_CHANGED',
  'THEME_CHANGED',
])

const ALLOWED_PAYLOAD_KEYS: Record<string, string[]> = {
  LOGOUT: [],
  SESSION_CHANGED: [],
  LOCALE_CHANGED: ['lang'],
  THEME_CHANGED: ['theme'],
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Sanitize an outgoing or incoming tab-sync event.
 * Guarantees ONLY allowlisted event types and strictly non-secret fields are ever transmitted.
 * Never permits access tokens, refresh tokens, passwords, emails, or user PII.
 */
export function sanitizeTabSyncEvent(raw: unknown): TabSyncEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const type = String(obj.type || '')
  if (!ALLOWED_EVENT_TYPES.has(type)) return null

  const clean: TabSyncEvent = {
    type,
    senderId: typeof obj.senderId === 'string' ? obj.senderId : '',
    ts: typeof obj.ts === 'number' ? obj.ts : Date.now(),
  }

  for (const key of ALLOWED_PAYLOAD_KEYS[type] || []) {
    const val = obj[key]
    if (typeof val === 'string' && val.length <= 64) {
      clean[key] = val
    }
  }
  return clean
}

export interface TabSyncChannelLike {
  postMessage: (data: unknown) => void
  close: () => void
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null
  unref?: () => void
}

export interface CreateTabSyncOptions {
  tabId?: string
  channelName?: string
  storageKey?: string
  BroadcastChannelCtor?: (new (name: string) => TabSyncChannelLike) | null
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
  storage?: Pick<Storage, 'setItem' | 'getItem'> | null
}

/**
 * Create a PII/token-free cross-tab event bus using BroadcastChannel with localStorage fallback.
 */
export function createTabSync(options: CreateTabSyncOptions = {}) {
  const tabId = options.tabId || generateTabId()
  const channelName = options.channelName || CHANNEL_NAME
  const storageKey = options.storageKey || STORAGE_KEY
  const win = options.win !== undefined ? options.win : typeof window !== 'undefined' ? window : null
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null
  const ChannelCtor =
    options.BroadcastChannelCtor !== undefined
      ? options.BroadcastChannelCtor
      : typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
        ? (BroadcastChannel as unknown as new (name: string) => TabSyncChannelLike)
        : null

  const listeners = new Set<(event: TabSyncEvent) => void>()
  let channel: TabSyncChannelLike | null = null
  let attachedStorage = false

  function dispatchIncoming(raw: unknown): void {
    const clean = sanitizeTabSyncEvent(raw)
    if (!clean || clean.senderId === tabId) return
    for (const fn of listeners) {
      try {
        fn(clean)
      } catch {
        /* listener isolation */
      }
    }
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (!event || event.key !== storageKey || !event.newValue) return
    try {
      dispatchIncoming(JSON.parse(event.newValue))
    } catch {
      /* ignore malformed storage payloads */
    }
  }

  function ensureConnected(): void {
    if (ChannelCtor && !channel) {
      try {
        channel = new ChannelCtor(channelName)
        if (typeof channel.unref === 'function') {
          channel.unref()
        }
        channel.onmessage = (event) => {
          dispatchIncoming(event?.data)
        }
      } catch {
        channel = null
      }
    }
    if (!channel && win && !attachedStorage && typeof win.addEventListener === 'function') {
      win.addEventListener('storage', handleStorageEvent)
      attachedStorage = true
    }
  }

  function broadcast(type: string, payload: Record<string, unknown> = {}): TabSyncEvent | null {
    const clean = sanitizeTabSyncEvent({
      ...payload,
      type,
      senderId: tabId,
      ts: Date.now(),
    })
    if (!clean) return null

    ensureConnected()
    if (channel) {
      try {
        channel.postMessage(clean)
      } catch {
        /* ignore closed channel */
      }
    } else if (storage) {
      try {
        storage.setItem(storageKey, JSON.stringify(clean))
      } catch {
        /* private mode */
      }
    }
    return clean
  }

  function subscribe(listener: (event: TabSyncEvent) => void): () => void {
    if (typeof listener !== 'function') return () => {}
    ensureConnected()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function close(): void {
    listeners.clear()
    if (channel) {
      try {
        channel.close()
      } catch {
        /* ignore */
      }
      channel = null
    }
    if (attachedStorage && win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('storage', handleStorageEvent)
      attachedStorage = false
    }
  }

  return {
    tabId,
    broadcast,
    subscribe,
    close,
  }
}

export const appTabSync = createTabSync()
