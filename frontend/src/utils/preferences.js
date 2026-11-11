export const NOTIFICATION_EVENTS = [
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
  'MAINTENANCE_DUE',
  'NOTICE_PUBLISHED',
]

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram', 'webpush']

/**
 * Returns the visible notification event types for the current user's role and apartment membership.
 * - PERIOD_REVIEW is shown to ACCOUNTANT and ADMIN.
 * - APARTMENT_MESSAGE is shown to everyone with an apartment.
 * - APARTMENT_MESSAGE_TO_BOARD is shown only to CHAIRMAN and BOARD (and ADMIN).
 * - POLL_OPENED is shown to everyone with an apartment (including board members who live in the building).
 * - ISSUE_REPORTED and ISSUE_URGENT are shown only to CHAIRMAN and BOARD (and ADMIN).
 * - ISSUE_STATUS_CHANGED is shown to everyone who can use the issue tracker (residents with an apartment, CHAIRMAN, BOARD, and ADMIN).
 * - MAINTENANCE_DUE is shown only to CHAIRMAN and BOARD (and ADMIN).
 * - NOTICE_PUBLISHED is shown to everyone with an apartment, and to CHAIRMAN and BOARD (and ADMIN).
 * @param {string} [buildingRole]
 * @param {boolean} [hasApartment]
 * @returns {import('../api/schema').NotificationEventType[]}
 */
export function visibleNotificationEvents(buildingRole, hasApartment) {
  const effectiveHasApartment =
    typeof hasApartment === 'boolean' ? hasApartment : buildingRole !== 'ACCOUNTANT'
  const isBoardOrChairman =
    buildingRole === 'CHAIRMAN' || buildingRole === 'BOARD' || buildingRole === 'ADMIN'
  const isAccountantOrAdmin = buildingRole === 'ACCOUNTANT' || buildingRole === 'ADMIN'

  return NOTIFICATION_EVENTS.filter((ev) => {
    if (ev === 'PERIOD_REVIEW') return isAccountantOrAdmin
    if (ev === 'APARTMENT_MESSAGE') return effectiveHasApartment
    if (ev === 'APARTMENT_MESSAGE_TO_BOARD') return isBoardOrChairman
    if (ev === 'POLL_OPENED') return effectiveHasApartment
    if (ev === 'ISSUE_REPORTED' || ev === 'ISSUE_URGENT') return isBoardOrChairman
    if (ev === 'ISSUE_STATUS_CHANGED') return isBoardOrChairman || effectiveHasApartment
    if (ev === 'MAINTENANCE_DUE') return isBoardOrChairman
    if (ev === 'NOTICE_PUBLISHED') return isBoardOrChairman || effectiveHasApartment
    return true
  })
}

/**
 * Deep-clone an array of PreferenceView cells.
 * @param {import('../api/schema').PreferenceView[]} prefs
 * @returns {import('../api/schema').PreferenceView[]}
 */
export function clonePreferences(prefs) {
  return (prefs || []).map((p) => ({
    event_type: p.event_type,
    channel: p.channel,
    enabled: Boolean(p.enabled),
    mandatory: Boolean(p.mandatory),
  }))
}

/**
 * Find a specific cell in the preferences array.
 * @param {import('../api/schema').PreferenceView[]} prefs
 * @param {string} eventType
 * @param {string} channel
 * @returns {import('../api/schema').PreferenceView | undefined}
 */
export function findPreferenceCell(prefs, eventType, channel) {
  return (prefs || []).find((p) => p.event_type === eventType && p.channel === channel)
}

/**
 * Find the channel availability status object for a given channel.
 * @param {import('../api/schema').ChannelAvailability[]} channels
 * @param {string} channel
 * @returns {import('../api/schema').ChannelAvailability}
 */
export function findChannelStatus(channels, channel) {
  const found = (channels || []).find((c) => c.channel === channel)
  return found || { channel, available: false, reason: 'CHANNEL_NOT_ENABLED' }
}

/**
 * Determine whether a preference switch can be toggled by the user.
 * Mandatory switches cannot be turned off.
 * Channels with DEMO_MODE or CHANNEL_NOT_ENABLED are disabled in the matrix.
 * Channels with NOT_LINKED or NO_EMAIL_ON_FILE can still be configured ahead of linking.
 * @param {import('../api/schema').PreferenceView | undefined} cell
 * @param {import('../api/schema').ChannelAvailability[]} channels
 * @returns {boolean}
 */
export function canTogglePreference(cell, channels) {
  if (!cell || cell.mandatory) return false
  const ch = findChannelStatus(channels, cell.channel)
  if (ch.reason === 'DEMO_MODE' || ch.reason === 'CHANNEL_NOT_ENABLED') {
    return false
  }
  return true
}

/**
 * Compute the minimal diff of changed non-mandatory notification preferences.
 * @param {import('../api/schema').PreferenceView[]} original
 * @param {import('../api/schema').PreferenceView[]} edited
 * @returns {import('../api/schema').PreferenceChange[]}
 */
export function changedPreferences(original, edited) {
  const key = (p) => `${p.event_type}|${p.channel}`
  const before = new Map((original || []).map((p) => [key(p), p.enabled]))
  return (edited || [])
    .filter((p) => !p.mandatory && before.get(key(p)) !== p.enabled)
    .map(({ event_type, channel, enabled }) => ({ event_type, channel, enabled }))
}
