/**
 * Shared notifications domain seed fixtures, preference matrix, and dispatch helpers (#041).
 * Used by both `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

import type { NotificationEventType, SubjectType } from '../../api/schema'
import { MOCK_BUILDING_ID } from './property.js'

export interface MockNotificationItem {
  id: string
  user_id?: string
  event_type: NotificationEventType
  subject_type: SubjectType
  subject_id: string
  params: Record<string, unknown>
  created_at: string
  read_at: string | null
}

export interface MockNotificationPreference {
  event_type: NotificationEventType
  channel: 'in_app' | 'email' | 'telegram' | 'webpush'
  enabled: boolean
  mandatory: boolean
}

export const MOCK_NOTIFICATION_EVENTS: NotificationEventType[] = [
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

export const MOCK_NOTIFICATION_CHANNELS: Array<'in_app' | 'email' | 'telegram' | 'webpush'> = [
  'in_app',
  'email',
  'telegram',
  'webpush',
]

export function createDefaultMockUserPreferences(): MockNotificationPreference[] {
  const list: MockNotificationPreference[] = []
  for (const event_type of MOCK_NOTIFICATION_EVENTS) {
    for (const channel of MOCK_NOTIFICATION_CHANNELS) {
      const mandatory = event_type === 'EMERGENCY_PUBLISHED' || event_type === 'ISSUE_URGENT'
      const enabled =
        event_type === 'APARTMENT_MESSAGE_TO_BOARD' ||
        event_type === 'ISSUE_REPORTED' ||
        event_type === 'MAINTENANCE_DUE'
          ? channel === 'in_app'
          : event_type === 'STORAGE_ALMOST_FULL' ||
              event_type === 'ENERGY_CERTIFICATE_EXPIRING'
            ? channel === 'in_app' || channel === 'email'
            : true
      list.push({
        event_type,
        channel,
        enabled,
        mandatory,
      })
    }
  }
  return list
}

export function createInitialMockNotificationsForUser(
  userId: string,
  { includeOfflineMaintenanceSeed = false }: { includeOfflineMaintenanceSeed?: boolean } = {},
): MockNotificationItem[] {
  const isBoardUser = [
    '018f0000-0000-7000-8000-000000000101',
    '018f0000-0000-7000-8000-000000000105',
  ].includes(userId)

  const base: MockNotificationItem[] = [
    {
      id: '018f0000-0000-7000-8000-000000009101',
      user_id: userId,
      event_type: 'EMERGENCY_PUBLISHED',
      subject_type: 'post',
      subject_id: '018f0000-0000-7000-8000-000000000701',
      params: {
        category: 'WATER_SHUTOFF',
        target_scope: 'ENTRANCE',
        target_entrance: 2,
      },
      created_at: '2026-10-25T10:00:00Z',
      read_at: null,
    },
    {
      id: '018f0000-0000-7000-8000-000000009102',
      user_id: userId,
      event_type: 'READING_DEADLINE',
      subject_type: 'period',
      subject_id: '018f0000-0000-7000-8000-000000000010',
      params: {
        period_code: '2026-10',
        due_date: '2026-11-04',
      },
      created_at: '2026-10-24T09:00:00Z',
      read_at: null,
    },
    {
      id: '018f0000-0000-7000-8000-000000009103',
      user_id: userId,
      event_type: 'PERIOD_REVIEW',
      subject_type: 'period',
      subject_id: '018f0000-0000-7000-8000-000000000009',
      params: {
        period_code: '2026-09',
      },
      created_at: '2026-10-05T12:00:00Z',
      read_at: '2026-10-05T14:30:00Z',
    },
  ]

  if (includeOfflineMaintenanceSeed) {
    base.splice(
      1,
      0,
      isBoardUser
        ? {
            id: '018f0000-0000-7000-8000-000000009105',
            user_id: userId,
            event_type: 'APARTMENT_MESSAGE_TO_BOARD',
            subject_type: 'post',
            subject_id: '018f0000-0000-7000-8000-000000000751',
            params: {
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              from_board: false,
            },
            created_at: '2026-10-24T12:40:00Z',
            read_at: null,
          }
        : {
            id: '018f0000-0000-7000-8000-000000009104',
            user_id: userId,
            event_type: 'APARTMENT_MESSAGE',
            subject_type: 'post',
            subject_id: '018f0000-0000-7000-8000-000000000751',
            params: {
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              from_board: true,
            },
            created_at: '2026-10-24T10:15:00Z',
            read_at: null,
          },
    )
  } else if (userId === '018f0000-0000-7000-8000-000000000102') {
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009104',
      user_id: userId,
      event_type: 'APARTMENT_MESSAGE',
      subject_type: 'post',
      subject_id: '018f0000-0000-7000-8000-000000000751',
      params: {
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        from_board: true,
      },
      created_at: '2026-10-24T10:15:00Z',
      read_at: null,
    })
  } else if (userId === '018f0000-0000-7000-8000-000000000101') {
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009105',
      user_id: userId,
      event_type: 'APARTMENT_MESSAGE_TO_BOARD',
      subject_type: 'post',
      subject_id: '018f0000-0000-7000-8000-000000000751',
      params: {
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        from_board: false,
      },
      created_at: '2026-10-24T12:40:00Z',
      read_at: null,
    })
  }

  if (
    userId !== '018f0000-0000-7000-8000-000000000101' &&
    userId !== '018f0000-0000-7000-8000-000000000103'
  ) {
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009106',
      user_id: userId,
      event_type: 'POLL_OPENED',
      subject_type: 'poll',
      subject_id: '018f0000-0000-7000-8000-000000000851',
      params: {
        closes_at:
          new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
      },
      created_at: '2026-10-24T09:05:00Z',
      read_at: null,
    })
  }

  if (isBoardUser) {
    if (includeOfflineMaintenanceSeed) {
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009109',
        user_id: userId,
        event_type: 'MAINTENANCE_DUE',
        subject_type: 'maintenance_task',
        subject_id: 'task-fire-extinguishers',
        params: {
          occurrence_id: 'occ-ext-2026',
          due_date: '2026-11-08',
          overdue: true,
          reminder_number: 1,
        },
        created_at: '2026-11-09T09:00:00Z',
        read_at: null,
      })
    }
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009107',
      user_id: userId,
      event_type: 'ISSUE_REPORTED',
      subject_type: 'issue',
      subject_id: '018f0000-0000-7000-8000-000000000901',
      params: {
        category: 'LIGHTING',
        entrance: 1,
      },
      created_at: '2026-10-25T08:15:00Z',
      read_at: null,
    })
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009111',
      user_id: userId,
      event_type: 'ENERGY_CERTIFICATE_EXPIRING',
      subject_type: 'building',
      subject_id: MOCK_BUILDING_ID,
      params: {
        valid_until: '2026-12-15',
        days_left: 30,
        threshold: 30,
      },
      created_at: '2026-11-15T08:00:00Z',
      read_at: null,
    })
  } else if (userId !== '018f0000-0000-7000-8000-000000000103') {
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009108',
      user_id: userId,
      event_type: 'ISSUE_STATUS_CHANGED',
      subject_type: 'issue',
      subject_id: '018f0000-0000-7000-8000-000000000902',
      params: {
        category: 'DOORS_AND_LOCKS',
        entrance: 2,
        status: 'IN_PROGRESS',
        merged: false,
      },
      created_at: '2026-10-25T09:30:00Z',
      read_at: null,
    })
  }

  if (includeOfflineMaintenanceSeed && userId !== '018f0000-0000-7000-8000-000000000103') {
    base.splice(1, 0, {
      id: '018f0000-0000-7000-8000-000000009110',
      user_id: userId,
      event_type: 'NOTICE_PUBLISHED',
      subject_type: 'post',
      subject_id: '018f0000-0000-7000-8000-000000000604',
      params: {},
      created_at: '2026-11-06T09:00:00Z',
      read_at: null,
    })
  }

  return base
}

export function getMockNoticeRecipientUserIds(
  notice: {
    target_scope?: string | null
    target_entrance?: number | null
    target_apartment_ids?: string[] | null
  },
  authorUserId?: string | null,
): string[] {
  const recipients = new Set([
    '018f0000-0000-7000-8000-000000000101',
    '018f0000-0000-7000-8000-000000000105',
  ])
  const userApts = [
    {
      userId: '018f0000-0000-7000-8000-000000000101',
      entrance: 1,
      aptId: '018f0000-0000-7000-8000-000000000301',
    },
    {
      userId: '018f0000-0000-7000-8000-000000000105',
      entrance: 1,
      aptId: '018f0000-0000-7000-8000-000000000302',
    },
    {
      userId: '018f0000-0000-7000-8000-000000000104',
      entrance: 1,
      aptId: '018f0000-0000-7000-8000-000000000302',
    },
    {
      userId: '018f0000-0000-7000-8000-000000000102',
      entrance: 2,
      aptId: '018f0000-0000-7000-8000-000000000314',
    },
  ]
  for (const u of userApts) {
    if (!notice.target_scope || notice.target_scope === 'ALL_BUILDING') {
      recipients.add(u.userId)
    } else if (
      notice.target_scope === 'ENTRANCE' &&
      Number(notice.target_entrance) === u.entrance
    ) {
      recipients.add(u.userId)
    } else if (
      notice.target_scope === 'APARTMENT_LIST' &&
      Array.isArray(notice.target_apartment_ids) &&
      notice.target_apartment_ids.includes(u.aptId)
    ) {
      recipients.add(u.userId)
    }
  }
  if (authorUserId) {
    recipients.delete(authorUserId)
  }
  return Array.from(recipients)
}
