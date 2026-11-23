import type { FileUsage } from '@/api/schema.js'

/**
 * Pure domain utilities for #024 (E11/F4): association file storage usage and threshold alerts.
 */

export const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024 // 2048 MB (2147483648 bytes)
export const PHOTOS_QUOTA_RATIO = 0.8
export const OFFICIAL_VOTES_RESERVE_RATIO = 0.05
export const STORAGE_ALERT_THRESHOLDS = [70, 90] as const
export const STORAGE_HYSTERESIS_POINTS = 10
export const KNOWN_STORAGE_CATEGORIES = ['photos', 'documents'] as const

/**
 * Formats byte size into human-readable units (B / KB / MB / GB).
 */
export function formatStorageBytes(
  bytes: number | string | null | undefined,
  lang: string = 'en',
): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  }
  const locale = lang === 'et' ? 'et-EE' : lang === 'ru' ? 'ru-RU' : 'en-US'
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024)
    try {
      return `${new Intl.NumberFormat(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(mb)} MB`
    } catch {
      return `${mb.toFixed(1)} MB`
    }
  }
  const gb = n / (1024 * 1024 * 1024)
  try {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    }).format(gb)} GB`
  } catch {
    return `${gb.toFixed(1)} GB`
  }
}

/**
 * Clamps and floors a percentage into 0..100 for display and progress bars.
 */
export function clampUsedPercent(percent: unknown): number {
  const n = Number(percent)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n >= 100) return 100
  return Math.floor(n)
}

/**
 * Resolves known storage category key ('photos' | 'documents') or returns null for unknown categories
 * so the UI displays unknown categories by their raw backend name.
 */
export function resolveStorageCategoryKey(category: unknown): 'photos' | 'documents' | null {
  const key = typeof category === 'string' ? category.trim() : ''
  if (key === 'photos' || key === 'documents') {
    return key
  }
  return null
}

/**
 * Computes storage category limits from total quota_bytes:
 * - photos: 80% of quota_bytes
 * - documents / files room: quota_bytes minus 5% official votes reserve
 */
export function computeCategoryLimits(
  quotaBytes: number | null | undefined = DEFAULT_STORAGE_QUOTA_BYTES,
): { quotaBytes: number; photosLimitBytes: number; filesRoomBytes: number } {
  const normalizedQuota =
    Number.isFinite(Number(quotaBytes)) && Number(quotaBytes) > 0
      ? Math.floor(Number(quotaBytes))
      : DEFAULT_STORAGE_QUOTA_BYTES
  const photosLimitBytes = Math.floor(normalizedQuota * PHOTOS_QUOTA_RATIO)
  const reserveBytes = Math.floor(normalizedQuota * OFFICIAL_VOTES_RESERVE_RATIO)
  const filesRoomBytes = Math.max(0, normalizedQuota - reserveBytes)
  return {
    quotaBytes: normalizedQuota,
    photosLimitBytes,
    filesRoomBytes,
  }
}

export interface StoragePhotoLike {
  size_bytes?: number | null
  bytes?: { byteLength?: number } | null
}

export interface StorageIssueLike {
  photos?: Array<StoragePhotoLike | null | undefined> | null
}

export interface StorageDocumentLike {
  expired?: boolean
  deleted?: boolean
  deleted_at?: string | null
  size_bytes?: number | null
  bytes?: { byteLength?: number } | null
}

export interface ComputeStorageUsageParams {
  issuesStore?: Array<StorageIssueLike | null | undefined>
  documentsStore?: Array<StorageDocumentLike | null | undefined>
  quotaBytes?: number
  extraPendingDeletionBytes?: number
  basePhotosBytes?: number
}

/**
 * Computes GET /api/v1/files/usage payload from mock issue & document stores.
 */
export function computeStorageUsage({
  issuesStore = [],
  documentsStore = [],
  quotaBytes = DEFAULT_STORAGE_QUOTA_BYTES,
  extraPendingDeletionBytes = 0,
  basePhotosBytes = 0,
}: ComputeStorageUsageParams = {}): FileUsage {
  const {
    quotaBytes: normalizedQuota,
    photosLimitBytes,
    filesRoomBytes,
  } = computeCategoryLimits(quotaBytes)

  let photosUsedBytes = Math.max(0, Math.floor(Number(basePhotosBytes) || 0))
  for (const issue of Array.isArray(issuesStore) ? issuesStore : []) {
    if (!issue || !Array.isArray(issue.photos)) continue
    for (const photo of issue.photos) {
      if (!photo) continue
      const sz = Number(photo.size_bytes ?? photo.bytes?.byteLength ?? 0)
      if (Number.isFinite(sz) && sz > 0) {
        photosUsedBytes += sz
      }
    }
  }

  let documentsUsedBytes = 0
  let deletedDocsBytes = 0
  for (const doc of Array.isArray(documentsStore) ? documentsStore : []) {
    if (!doc || doc.expired) continue
    const sz = Number(doc.size_bytes ?? doc.bytes?.byteLength ?? 0)
    if (!Number.isFinite(sz) || sz <= 0) continue
    if (doc.deleted) {
      deletedDocsBytes += sz
    } else {
      documentsUsedBytes += sz
    }
  }

  const pendingDeletionBytes =
    deletedDocsBytes + Math.max(0, Math.floor(Number(extraPendingDeletionBytes) || 0))
  const usedBytes = photosUsedBytes + documentsUsedBytes
  const usedPercent =
    normalizedQuota > 0 ? Math.min(100, Math.floor((usedBytes * 100) / normalizedQuota)) : 0

  return {
    quota_bytes: normalizedQuota,
    used_bytes: usedBytes,
    used_percent: usedPercent,
    pending_deletion_bytes: pendingDeletionBytes,
    categories: [
      {
        category: 'photos',
        used_bytes: photosUsedBytes,
        limit_bytes: photosLimitBytes,
      },
      {
        category: 'documents',
        used_bytes: documentsUsedBytes,
        limit_bytes: filesRoomBytes,
      },
    ],
  }
}

/**
 * Computes effective threshold pressure percentage (max of live files room % and photos room %).
 */
export function computeEffectiveStoragePressurePercent(
  usage?: Partial<FileUsage> | null,
): number {
  if (!usage || typeof usage !== 'object') return 0
  const categories = Array.isArray(usage.categories) ? usage.categories : []
  const docsCat = categories.find((c) => c?.category === 'documents')
  const photosCat = categories.find((c) => c?.category === 'photos')

  const filesRoomLimit =
    docsCat && Number(docsCat.limit_bytes) > 0
      ? Number(docsCat.limit_bytes)
      : computeCategoryLimits(usage.quota_bytes).filesRoomBytes
  const filesPct =
    filesRoomLimit > 0 ? Math.floor((Number(usage.used_bytes || 0) * 100) / filesRoomLimit) : 0

  const photosPct =
    photosCat && Number(photosCat.limit_bytes) > 0
      ? Math.floor((Number(photosCat.used_bytes || 0) * 100) / Number(photosCat.limit_bytes))
      : 0

  return Math.max(filesPct, photosPct)
}

export interface StorageAlertState {
  armed70: boolean
  armed90: boolean
}

/**
 * Re-arms 70% / 90% storage alert thresholds when usage drops at least 10 points below them
 * (<= 60% for 70, <= 80% for 90). Mutates `alertState` in place.
 */
export function syncStorageAlertHysteresis(
  usage: Partial<FileUsage> | null | undefined,
  alertState: StorageAlertState,
): number {
  const effectivePct = computeEffectiveStoragePressurePercent(usage)
  if (effectivePct <= 70 - STORAGE_HYSTERESIS_POINTS) {
    alertState.armed70 = true
  }
  if (effectivePct <= 90 - STORAGE_HYSTERESIS_POINTS) {
    alertState.armed90 = true
  }
  return effectivePct
}

/**
 * Evaluates whether a post-upload storage usage triggers `STORAGE_ALMOST_FULL`.
 * Emits at most ONE threshold notification per upload (the highest threshold newly crossed: 90 or 70),
 * and re-arms only after usage falls at least 10 points below that threshold.
 */
export function evaluateStorageThresholdNotification(
  usage: Partial<FileUsage> | null | undefined,
  alertState: StorageAlertState,
): { threshold: 70 | 90; used_percent: number } | null {
  const effectivePct = syncStorageAlertHysteresis(usage, alertState)
  const reportedUsedPercent = clampUsedPercent(usage?.used_percent)

  if (effectivePct >= 90 && alertState.armed90) {
    alertState.armed90 = false
    alertState.armed70 = false
    return {
      threshold: 90,
      used_percent: reportedUsedPercent,
    }
  }

  if (effectivePct >= 70 && alertState.armed70) {
    alertState.armed70 = false
    return {
      threshold: 70,
      used_percent: reportedUsedPercent,
    }
  }

  return null
}
