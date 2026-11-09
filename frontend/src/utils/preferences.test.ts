import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChannelAvailability, PreferenceView } from '../api/schema.js'
import {
  changedPreferences,
  visibleNotificationEvents,
  canTogglePreference,
  clonePreferences,
} from './preferences.js'

test('changedPreferences returns only modified non-mandatory cells', () => {
  const original: PreferenceView[] = [
    { event_type: 'EMERGENCY_PUBLISHED', channel: 'in_app', enabled: true, mandatory: true },
    { event_type: 'EMERGENCY_RESOLVED', channel: 'in_app', enabled: true, mandatory: false },
    { event_type: 'READING_DEADLINE', channel: 'email', enabled: true, mandatory: false },
    { event_type: 'PERIOD_REVIEW', channel: 'in_app', enabled: true, mandatory: false },
  ]

  const edited = clonePreferences(original)
  // Attempt to flip mandatory cell (should be ignored by changedPreferences)
  edited[0].enabled = false
  // Flip READING_DEADLINE email from true -> false
  edited[2].enabled = false

  const diff = changedPreferences(original, edited)
  assert.deepEqual(diff, [
    { event_type: 'READING_DEADLINE', channel: 'email', enabled: false },
  ])
})

test('changedPreferences returns empty array when nothing changed', () => {
  const original: PreferenceView[] = [
    { event_type: 'READING_DEADLINE', channel: 'in_app', enabled: true, mandatory: false },
  ]
  const edited = clonePreferences(original)
  assert.deepEqual(changedPreferences(original, edited), [])
})

test('visibleNotificationEvents filters PERIOD_REVIEW, APARTMENT_MESSAGE, APARTMENT_MESSAGE_TO_BOARD, POLL_OPENED, and ISSUE_* by role and apartment membership', () => {
  // Resident with an apartment
  assert.deepEqual(visibleNotificationEvents('USER', true), [
    'EMERGENCY_PUBLISHED',
    'EMERGENCY_RESOLVED',
    'READING_DEADLINE',
    'APARTMENT_MESSAGE',
    'POLL_OPENED',
    'ISSUE_STATUS_CHANGED',
  ])
  // Board member with an apartment
  assert.deepEqual(visibleNotificationEvents('BOARD', true), [
    'EMERGENCY_PUBLISHED',
    'EMERGENCY_RESOLVED',
    'READING_DEADLINE',
    'APARTMENT_MESSAGE',
    'APARTMENT_MESSAGE_TO_BOARD',
    'POLL_OPENED',
    'ISSUE_REPORTED',
    'ISSUE_URGENT',
    'ISSUE_STATUS_CHANGED',
  ])
  // Chairman without an apartment
  assert.deepEqual(visibleNotificationEvents('CHAIRMAN', false), [
    'EMERGENCY_PUBLISHED',
    'EMERGENCY_RESOLVED',
    'READING_DEADLINE',
    'APARTMENT_MESSAGE_TO_BOARD',
    'ISSUE_REPORTED',
    'ISSUE_URGENT',
    'ISSUE_STATUS_CHANGED',
  ])
  // Accountant without an apartment
  assert.deepEqual(visibleNotificationEvents('ACCOUNTANT', false), [
    'EMERGENCY_PUBLISHED',
    'EMERGENCY_RESOLVED',
    'READING_DEADLINE',
    'PERIOD_REVIEW',
  ])
  // Admin with an apartment
  assert.deepEqual(visibleNotificationEvents('ADMIN', true), [
    'EMERGENCY_PUBLISHED',
    'EMERGENCY_RESOLVED',
    'READING_DEADLINE',
    'PERIOD_REVIEW',
    'APARTMENT_MESSAGE',
    'APARTMENT_MESSAGE_TO_BOARD',
    'POLL_OPENED',
    'ISSUE_REPORTED',
    'ISSUE_URGENT',
    'ISSUE_STATUS_CHANGED',
  ])
})

test('canTogglePreference respects mandatory and channel availability reasons', () => {
  const channels: ChannelAvailability[] = [
    { channel: 'in_app', available: true, reason: null },
    { channel: 'email', available: false, reason: 'DEMO_MODE' },
    { channel: 'telegram', available: false, reason: 'NOT_LINKED' },
    { channel: 'webpush', available: false, reason: 'CHANNEL_NOT_ENABLED' },
  ]

  assert.equal(
    canTogglePreference(
      { event_type: 'EMERGENCY_PUBLISHED', channel: 'in_app', enabled: true, mandatory: true },
      channels,
    ),
    false,
  )
  assert.equal(
    canTogglePreference(
      { event_type: 'ISSUE_URGENT', channel: 'in_app', enabled: true, mandatory: true },
      channels,
    ),
    false,
  )
  assert.equal(
    canTogglePreference(
      { event_type: 'READING_DEADLINE', channel: 'in_app', enabled: true, mandatory: false },
      channels,
    ),
    true,
  )
  assert.equal(
    canTogglePreference(
      { event_type: 'READING_DEADLINE', channel: 'email', enabled: true, mandatory: false },
      channels,
    ),
    false,
  )
  // NOT_LINKED can still be toggled ahead of linking
  assert.equal(
    canTogglePreference(
      { event_type: 'READING_DEADLINE', channel: 'telegram', enabled: true, mandatory: false },
      channels,
    ),
    true,
  )
  assert.equal(
    canTogglePreference(
      { event_type: 'READING_DEADLINE', channel: 'webpush', enabled: false, mandatory: false },
      channels,
    ),
    false,
  )
})
