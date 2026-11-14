import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampUsedPercent,
  formatStorageBytes,
  resolveStorageCategoryKey,
  computeCategoryLimits,
  computeStorageUsage,
  computeEffectiveStoragePressurePercent,
  syncStorageAlertHysteresis,
  evaluateStorageThresholdNotification,
  DEFAULT_STORAGE_QUOTA_BYTES,
} from './storage.js'

test('formatStorageBytes formats bytes into B, KB, MB, and GB across locales', () => {
  assert.equal(formatStorageBytes(0, 'en'), '0 B')
  assert.equal(formatStorageBytes(512, 'en'), '512 B')
  assert.equal(formatStorageBytes(1024, 'en'), '1.0 KB')
  assert.equal(formatStorageBytes(100 * 1024, 'en'), '100 KB')
  assert.equal(formatStorageBytes(1024 * 1024, 'en'), '1.0 MB')
  assert.equal(formatStorageBytes(412_000_000, 'en'), '392.9 MB')
  assert.equal(formatStorageBytes(2 * 1024 * 1024 * 1024, 'en'), '2.0 GB')
  assert.equal(formatStorageBytes(null, 'en'), '0 B')
  assert.equal(formatStorageBytes(-100, 'en'), '0 B')
})

test('clampUsedPercent clamps and floors percentage into 0..100', () => {
  assert.equal(clampUsedPercent(-5), 0)
  assert.equal(clampUsedPercent(0), 0)
  assert.equal(clampUsedPercent(19.9), 19)
  assert.equal(clampUsedPercent(70.2), 70)
  assert.equal(clampUsedPercent(100), 100)
  assert.equal(clampUsedPercent(120), 100)
  assert.equal(clampUsedPercent('abc'), 0)
})

test('resolveStorageCategoryKey recognizes photos and documents and returns null for unknown', () => {
  assert.equal(resolveStorageCategoryKey('photos'), 'photos')
  assert.equal(resolveStorageCategoryKey('documents'), 'documents')
  assert.equal(resolveStorageCategoryKey('backups'), null)
  assert.equal(resolveStorageCategoryKey(''), null)
  assert.equal(resolveStorageCategoryKey(null), null)
})

test('computeCategoryLimits calculates 80% photos cap and 95% files room', () => {
  const limits = computeCategoryLimits(DEFAULT_STORAGE_QUOTA_BYTES)
  assert.equal(limits.quotaBytes, 2147483648)
  assert.equal(limits.photosLimitBytes, 1717986918) // 80%
  assert.equal(limits.filesRoomBytes, 2040109466) // 95%
})

test('computeStorageUsage aggregates photos and documents correctly without counting pending deletion in used_bytes', () => {
  const mockIssues = [
    {
      photos: [
        { size_bytes: 300_000 },
        { size_bytes: 200_000 },
      ],
    },
  ]
  const mockDocs = [
    { deleted: false, size_bytes: 500_000 },
    { deleted: true, size_bytes: 120_000 }, // pending deletion within 14 days
  ]

  const usage = computeStorageUsage({
    issuesStore: mockIssues,
    documentsStore: mockDocs,
    quotaBytes: 10_000_000,
    extraPendingDeletionBytes: 80_000,
  })

  assert.equal(usage.quota_bytes, 10_000_000)
  assert.equal(usage.used_bytes, 1_000_000) // 500k photos + 500k docs
  assert.equal(usage.used_percent, 10) // 1M / 10M = 10%
  assert.equal(usage.pending_deletion_bytes, 200_000) // 120k deleted doc + 80k extra
  assert.equal(usage.categories.length, 2)
  assert.equal(usage.categories[0].category, 'photos')
  assert.equal(usage.categories[0].used_bytes, 500_000)
  assert.equal(usage.categories[0].limit_bytes, 8_000_000)
  assert.equal(usage.categories[1].category, 'documents')
  assert.equal(usage.categories[1].used_bytes, 500_000)
  assert.equal(usage.categories[1].limit_bytes, 9_500_000)
})

test('evaluateStorageThresholdNotification emits 70 and 90 alerts and enforces 10-point hysteresis re-arm', () => {
  const state = { armed70: true, armed90: true }

  // 1. Initial 19% usage -> no alert
  const usageLow = {
    quota_bytes: 100_000,
    used_bytes: 19_000,
    used_percent: 19,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 10_000, limit_bytes: 80_000 },
      { category: 'documents', used_bytes: 9_000, limit_bytes: 95_000 },
    ],
  }
  assert.equal(evaluateStorageThresholdNotification(usageLow, state), null)
  assert.equal(state.armed70, true)
  assert.equal(state.armed90, true)

  // 2. Photos reach 70% of photos limit (56,000 / 80,000 = 70%) -> triggers threshold 70
  const usage70Photos = {
    quota_bytes: 100_000,
    used_bytes: 65_000,
    used_percent: 65,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 56_000, limit_bytes: 80_000 },
      { category: 'documents', used_bytes: 9_000, limit_bytes: 95_000 },
    ],
  }
  const alert70 = evaluateStorageThresholdNotification(usage70Photos, state)
  assert.deepEqual(alert70, { threshold: 70, used_percent: 65 })
  assert.equal(state.armed70, false)
  assert.equal(state.armed90, true)

  // 3. Subsequent check at same level -> no duplicate alert
  assert.equal(evaluateStorageThresholdNotification(usage70Photos, state), null)

  // 4. Usage surges straight to 92% of photos limit -> triggers threshold 90
  const usage90Photos = {
    quota_bytes: 100_000,
    used_bytes: 75_000,
    used_percent: 75,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 74_000, limit_bytes: 80_000 }, // 74k / 80k = 92.5%
      { category: 'documents', used_bytes: 1_000, limit_bytes: 95_000 },
    ],
  }
  const alert90 = evaluateStorageThresholdNotification(usage90Photos, state)
  assert.deepEqual(alert90, { threshold: 90, used_percent: 75 })
  assert.equal(state.armed90, false)
  assert.equal(state.armed70, false)

  // 5. Usage drops to 85% (> 80%) -> 90% is NOT re-armed yet
  const usage85Photos = {
    quota_bytes: 100_000,
    used_bytes: 69_000,
    used_percent: 69,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 68_000, limit_bytes: 80_000 }, // 85%
      { category: 'documents', used_bytes: 1_000, limit_bytes: 95_000 },
    ],
  }
  syncStorageAlertHysteresis(usage85Photos, state)
  assert.equal(state.armed90, false)

  // 6. Usage drops to 78% (<= 80%) -> 90% is re-armed!
  const usage78Photos = {
    quota_bytes: 100_000,
    used_bytes: 63_000,
    used_percent: 63,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 62_000, limit_bytes: 80_000 }, // 77.5% <= 80%
      { category: 'documents', used_bytes: 1_000, limit_bytes: 95_000 },
    ],
  }
  syncStorageAlertHysteresis(usage78Photos, state)
  assert.equal(state.armed90, true)
  assert.equal(state.armed70, false) // 70% not re-armed yet (> 60%)

  // 7. Usage drops to 55% (<= 60%) -> 70% is re-armed!
  const usage55Photos = {
    quota_bytes: 100_000,
    used_bytes: 45_000,
    used_percent: 45,
    pending_deletion_bytes: 0,
    categories: [
      { category: 'photos', used_bytes: 44_000, limit_bytes: 80_000 }, // 55% <= 60%
      { category: 'documents', used_bytes: 1_000, limit_bytes: 95_000 },
    ],
  }
  syncStorageAlertHysteresis(usage55Photos, state)
  assert.equal(state.armed70, true)
  assert.equal(state.armed90, true)
})
