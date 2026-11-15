import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cloneDefaultAssociationSettings,
  groupSettingsByPrefix,
  buildInitialDraftState,
  computeSettingsDiff,
  extractSettingFieldErrors,
  validateAndApplySettingsUpdate,
  isDisablingChatSetting,
} from './associationSettings.js'

test('groupSettingsByPrefix groups settings by prefix and preserves alphabetical key order', () => {
  const raw = [
    ...cloneDefaultAssociationSettings(),
    {
      key: 'maintenance.overdue_reminder_days',
      type: 'INTEGER' as const,
      value: 7,
      default: 7,
      minimum: 1,
      maximum: 30,
      is_default: true,
      updated_at: null,
    },
    {
      key: 'custom_root_key',
      type: 'BOOLEAN' as const,
      value: true,
      default: false,
      minimum: null,
      maximum: null,
      is_default: false,
      updated_at: '2026-11-08T10:00:00Z',
    },
  ]

  const groups = groupSettingsByPrefix(raw)
  assert.deepEqual(
    groups.map((g) => g.prefix),
    ['chat', 'general', 'issues', 'maintenance'],
  )
  assert.deepEqual(
    groups.find((g) => g.prefix === 'chat')?.settings.map((s) => s.key),
    ['chat.enabled'],
  )
  assert.deepEqual(
    groups.find((g) => g.prefix === 'issues')?.settings.map((s) => s.key),
    [
      'issues.reports_per_apartment_per_day',
      'issues.urgent_enabled',
      'issues.urgent_per_apartment_per_day',
    ],
  )
})

test('computeSettingsDiff returns only changed keys and sends null for reset-to-default on non-default settings', () => {
  const settings = cloneDefaultAssociationSettings()
  // Mark issues.urgent_enabled as non-default on server
  const urgentIdx = settings.findIndex((s) => s.key === 'issues.urgent_enabled')
  settings[urgentIdx] = {
    ...settings[urgentIdx],
    value: true,
    is_default: false,
    updated_at: '2026-11-08T12:00:00Z',
  }

  const initial = buildInitialDraftState(settings)
  assert.deepEqual(computeSettingsDiff(settings, initial.values, initial.resets), {})

  // Change integer (as string from input) and mark urgent_enabled for reset
  const draftValues = {
    ...initial.values,
    'issues.reports_per_apartment_per_day': '10',
  }
  const draftResets = {
    ...initial.resets,
    'issues.urgent_enabled': true,
  }

  const diff = computeSettingsDiff(settings, draftValues, draftResets)
  assert.deepEqual(diff, {
    'issues.reports_per_apartment_per_day': 10,
    'issues.urgent_enabled': null,
  })
})

test('validateAndApplySettingsUpdate enforces all-or-nothing validation and resets on null', () => {
  const base = cloneDefaultAssociationSettings()
  const chatDefault = base.find((s) => s.key === 'chat.enabled')!
  assert.equal(chatDefault.type, 'BOOLEAN')
  assert.equal(chatDefault.value, false)
  assert.equal(chatDefault.default, false)
  assert.equal(chatDefault.is_default, true)

  // 1. Out of bounds + valid change together -> all or nothing (nothing changes, 422 errors returned)
  const invalidRes = validateAndApplySettingsUpdate(base, {
    values: {
      'issues.urgent_enabled': true,
      'issues.reports_per_apartment_per_day': 25, // max is 20
      'unknown.key': 1,
    },
  })
  assert.equal(invalidRes.ok, false)
  if (!invalidRes.ok) {
    const extracted = extractSettingFieldErrors({ fieldErrors: invalidRes.errors })
    assert.ok(extracted['issues.reports_per_apartment_per_day'])
    assert.ok(extracted['unknown.key'])
    assert.equal(extracted['issues.urgent_enabled'], undefined)
  }

  // 2. Valid update sets value, marks is_default=false, and sets updated_at
  const validRes = validateAndApplySettingsUpdate(
    base,
    {
      values: {
        'chat.enabled': true,
        'issues.urgent_enabled': true,
        'issues.urgent_per_apartment_per_day': 4,
      },
    },
    '2026-11-08T15:00:00Z',
  )
  assert.equal(validRes.ok, true)
  if (validRes.ok) {
    const chatEnabled = validRes.settings.find((s) => s.key === 'chat.enabled')!
    assert.equal(chatEnabled.value, true)
    assert.equal(chatEnabled.is_default, false)
    assert.equal(chatEnabled.updated_at, '2026-11-08T15:00:00Z')

    const urgentEnabled = validRes.settings.find((s) => s.key === 'issues.urgent_enabled')!
    assert.equal(urgentEnabled.value, true)
    assert.equal(urgentEnabled.is_default, false)
    assert.equal(urgentEnabled.updated_at, '2026-11-08T15:00:00Z')

    const reportsPerDay = validRes.settings.find(
      (s) => s.key === 'issues.reports_per_apartment_per_day',
    )!
    assert.equal(reportsPerDay.value, 3)
    assert.equal(reportsPerDay.is_default, true)
    assert.equal(reportsPerDay.updated_at, null)

    // 3. Resetting to default via null restores default value, is_default=true, updated_at=null
    const resetRes = validateAndApplySettingsUpdate(validRes.settings, {
      values: {
        'issues.urgent_enabled': null,
      },
    })
    assert.equal(resetRes.ok, true)
    if (resetRes.ok) {
      const afterReset = resetRes.settings.find((s) => s.key === 'issues.urgent_enabled')!
      assert.equal(afterReset.value, false)
      assert.equal(afterReset.is_default, true)
      assert.equal(afterReset.updated_at, null)
    }
  }
})

test('isDisablingChatSetting returns true only when active chat.enabled transitions to false or default-false', () => {
  const offSettings = cloneDefaultAssociationSettings()
  assert.equal(isDisablingChatSetting(offSettings, { 'chat.enabled': true }), false)
  assert.equal(isDisablingChatSetting(offSettings, { 'chat.enabled': false }), false)
  assert.equal(isDisablingChatSetting(offSettings, { 'issues.urgent_enabled': true }), false)

  const onSettings = offSettings.map((s) =>
    s.key === 'chat.enabled' ? { ...s, value: true, is_default: false } : s,
  )
  assert.equal(isDisablingChatSetting(onSettings, { 'issues.urgent_enabled': true }), false)
  assert.equal(isDisablingChatSetting(onSettings, { 'chat.enabled': true }), false)
  assert.equal(isDisablingChatSetting(onSettings, { 'chat.enabled': false }), true)
  assert.equal(isDisablingChatSetting(onSettings, { 'chat.enabled': null }), true)
})

test('cloneDefaultAssociationSettings sorts deterministically across keys', () => {
  const cloned = cloneDefaultAssociationSettings()
  const keys = cloned.map((s) => s.key)
  assert.deepEqual(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  assert.equal(keys[0], 'chat.enabled')
})
