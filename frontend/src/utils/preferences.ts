import type {
  Channel,
  ChannelAvailability,
  NotificationEventType,
  PreferenceChange,
  PreferenceView,
} from '@/api/schema.js'

export const NOTIFICATION_EVENTS: NotificationEventType[] = [
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
  'STORAGE_ALMOST_FULL',
  'ENERGY_CERTIFICATE_EXPIRING',
]

export const NOTIFICATION_CHANNELS: Channel[] = [
  'in_app',
  'email',
  'telegram',
  'webpush',
]

/**
 * Returns the visible notification event types for the current user's role and apartment membership.
 */
export function visibleNotificationEvents(
  buildingRole?: string | null,
  hasApartment?: boolean,
): NotificationEventType[] {
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
    if (ev === 'STORAGE_ALMOST_FULL') return isBoardOrChairman
    if (ev === 'ENERGY_CERTIFICATE_EXPIRING') return isBoardOrChairman
    return true
  })
}

/**
 * Deep-clone an array of PreferenceView cells.
 */
export function clonePreferences(prefs?: PreferenceView[] | null): PreferenceView[] {
  return (prefs || []).map((p) => ({
    event_type: p.event_type,
    channel: p.channel,
    enabled: Boolean(p.enabled),
    mandatory: Boolean(p.mandatory),
  }))
}

/**
 * Find a specific cell in the preferences array.
 */
export function findPreferenceCell(
  prefs: PreferenceView[] | null | undefined,
  eventType: string,
  channel: string,
): PreferenceView | undefined {
  return (prefs || []).find((p) => p.event_type === eventType && p.channel === channel)
}

/**
 * Find the channel availability status object for a given channel.
 */
export function findChannelStatus(
  channels: ChannelAvailability[] | null | undefined,
  channel: Channel | string,
): ChannelAvailability {
  const found = (channels || []).find((c) => c.channel === channel)
  return (
    found || {
      channel: channel as Channel,
      available: false,
      reason: 'CHANNEL_NOT_ENABLED',
    }
  )
}

/**
 * Determine whether a preference switch can be toggled by the user.
 */
export function canTogglePreference(
  cell: PreferenceView | undefined | null,
  channels: ChannelAvailability[] | null | undefined,
): boolean {
  if (!cell || cell.mandatory) return false
  const ch = findChannelStatus(channels, cell.channel)
  if (ch.reason === 'DEMO_MODE' || ch.reason === 'CHANNEL_NOT_ENABLED') {
    return false
  }
  return true
}

/**
 * Compute the minimal diff of changed non-mandatory notification preferences.
 */
export function changedPreferences(
  original: PreferenceView[] | null | undefined,
  edited: PreferenceView[] | null | undefined,
): PreferenceChange[] {
  const key = (p: PreferenceView) => `${p.event_type}|${p.channel}`
  const before = new Map((original || []).map((p) => [key(p), p.enabled]))
  return (edited || [])
    .filter((p) => !p.mandatory && before.get(key(p)) !== p.enabled)
    .map(({ event_type, channel, enabled }) => ({ event_type, channel, enabled }))
}
