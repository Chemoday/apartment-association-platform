import type { NotificationView } from '@/api/schema.js'
import { formatCalendarDate, formatDate, formatPeriodLabel, formatShortDate } from './dates.js'
import { formatTargetKindsList, normalizeObjectKind } from './objectName.js'

export type NotificationDescriptorVariant =
  | 'emergency'
  | 'resolved'
  | 'deadline'
  | 'review'
  | 'neutral'

export interface NotificationDescriptor {
  key: string
  values: Record<string, string | number | boolean | null | undefined | string[]>
  icon: string
  variant: NotificationDescriptorVariant
  route: string | null
}

/**
 * Maps a NotificationView item to a translation key, interpolation parameters, icon, visual variant, and target route.
 * Never crashes on unknown event types.
 */
export function buildNotificationDescriptor(
  item: Partial<NotificationView> | Record<string, unknown> | null | undefined,
  lang: string = 'en',
): NotificationDescriptor {
  const eventType = String(item?.event_type || '')
  const params: Record<string, unknown> =
    item?.params && typeof item.params === 'object'
      ? (item.params as Record<string, unknown>)
      : {}
  const subjectId = typeof item?.subject_id === 'string' ? item.subject_id : ''

  if (eventType === 'EMERGENCY_PUBLISHED') {
    const entranceVal = params.target_entrance
    const rawKinds = Array.isArray(params.target_kinds)
      ? params.target_kinds.map((k) => String(k))
      : []
    return {
      key: 'notifications.events.EMERGENCY_PUBLISHED',
      values: {
        category: String(params.category || 'GENERAL'),
        target_scope: String(params.target_scope || 'ALL_BUILDING'),
        target_entrance:
          typeof entranceVal === 'number' || typeof entranceVal === 'string' ? entranceVal : '',
        target_kinds: rawKinds,
      },
      icon: 'warning',
      variant: 'emergency',
      route: subjectId ? `/forum/${subjectId}` : '/forum',
    }
  }

  if (eventType === 'EMERGENCY_RESOLVED') {
    const entranceVal = params.target_entrance
    const rawKinds = Array.isArray(params.target_kinds)
      ? params.target_kinds.map((k) => String(k))
      : []
    return {
      key: 'notifications.events.EMERGENCY_RESOLVED',
      values: {
        category: String(params.category || 'GENERAL'),
        target_scope: String(params.target_scope || 'ALL_BUILDING'),
        target_entrance:
          typeof entranceVal === 'number' || typeof entranceVal === 'string' ? entranceVal : '',
        target_kinds: rawKinds,
      },
      icon: 'check_circle',
      variant: 'resolved',
      route: subjectId ? `/forum/${subjectId}` : '/forum',
    }
  }

  if (eventType === 'READING_DEADLINE') {
    const periodCode = String(params.period_code || '')
    return {
      key: 'notifications.events.READING_DEADLINE',
      values: {
        period_code: periodCode,
        period: formatPeriodLabel(periodCode, lang),
        due_date: formatShortDate(String(params.due_date || ''), lang),
      },
      icon: 'speed',
      variant: 'deadline',
      route: periodCode ? `/readings?period=${encodeURIComponent(periodCode)}` : '/readings',
    }
  }

  if (eventType === 'PERIOD_REVIEW') {
    const periodCode = String(params.period_code || '')
    return {
      key: 'notifications.events.PERIOD_REVIEW',
      values: {
        period_code: periodCode,
        period: formatPeriodLabel(periodCode, lang),
      },
      icon: 'assignment_turned_in',
      variant: 'review',
      route: periodCode ? `/readings?period=${encodeURIComponent(periodCode)}` : '/readings',
    }
  }

  if (eventType === 'APARTMENT_MESSAGE') {
    const fromBoard = Boolean(params.from_board)
    const kind = normalizeObjectKind(params.apartment_kind)
    const peerKey =
      kind === 'PARKING'
        ? 'notifications.events.APARTMENT_MESSAGE_PEER_PARKING'
        : kind === 'GARAGE'
          ? 'notifications.events.APARTMENT_MESSAGE_PEER_GARAGE'
          : 'notifications.events.APARTMENT_MESSAGE_PEER'
    return {
      key: fromBoard ? 'notifications.events.APARTMENT_MESSAGE_FROM_BOARD' : peerKey,
      values: {
        apartment_id: String(params.apartment_id || ''),
        apartment_number: String(params.apartment_number || ''),
        apartment_kind: kind,
        from_board: fromBoard,
      },
      icon: 'mail',
      variant: 'neutral',
      route: subjectId ? `/messages/${subjectId}` : '/messages',
    }
  }

  if (eventType === 'APARTMENT_MESSAGE_TO_BOARD') {
    const kind = normalizeObjectKind(params.apartment_kind)
    const key =
      kind === 'PARKING'
        ? 'notifications.events.APARTMENT_MESSAGE_TO_BOARD_PARKING'
        : kind === 'GARAGE'
          ? 'notifications.events.APARTMENT_MESSAGE_TO_BOARD_GARAGE'
          : 'notifications.events.APARTMENT_MESSAGE_TO_BOARD'
    return {
      key,
      values: {
        apartment_id: String(params.apartment_id || ''),
        apartment_number: String(params.apartment_number || ''),
        apartment_kind: kind,
      },
      icon: 'mark_email_unread',
      variant: 'neutral',
      route: subjectId ? `/messages/${subjectId}` : '/messages',
    }
  }

  if (eventType === 'JOIN_REQUEST_SUBMITTED') {
    const kind = normalizeObjectKind(params.apartment_kind)
    const key =
      kind === 'PARKING'
        ? 'notifications.events.JOIN_REQUEST_SUBMITTED_PARKING'
        : kind === 'GARAGE'
          ? 'notifications.events.JOIN_REQUEST_SUBMITTED_GARAGE'
          : 'notifications.events.JOIN_REQUEST_SUBMITTED'
    return {
      key,
      values: {
        apartment_number: String(params.apartment_number || ''),
        apartment_kind: kind,
      },
      icon: 'person_add',
      variant: 'neutral',
      route: '/people',
    }
  }

  if (eventType === 'POLL_OPENED') {
    const closesAt = String(params.closes_at || '')
    return {
      key: 'notifications.events.POLL_OPENED',
      values: {
        closes_at: closesAt,
        date: formatDate(closesAt, lang),
      },
      icon: 'how_to_vote',
      variant: 'deadline',
      route: subjectId ? `/polls/${subjectId}` : '/polls',
    }
  }

  if (eventType === 'ISSUE_REPORTED' || eventType === 'ISSUE_URGENT') {
    const rawCategory = String(params.category || 'OTHER')
    const rawEntrance =
      params.entrance !== undefined && params.entrance !== null && params.entrance !== ''
        ? Number(params.entrance)
        : null
    const isUrgent = eventType === 'ISSUE_URGENT'
    return {
      key: isUrgent
        ? 'notifications.events.ISSUE_URGENT'
        : 'notifications.events.ISSUE_REPORTED',
      values: {
        category: rawCategory,
        entrance: Number.isInteger(rawEntrance) ? rawEntrance : null,
      },
      icon: isUrgent ? 'warning' : 'report_problem',
      variant: isUrgent ? 'emergency' : 'neutral',
      route: subjectId ? `/issues/${subjectId}` : '/issues',
    }
  }

  if (eventType === 'ISSUE_STATUS_CHANGED') {
    const rawCategory = String(params.category || 'OTHER')
    const rawEntrance =
      params.entrance !== undefined && params.entrance !== null && params.entrance !== ''
        ? Number(params.entrance)
        : null
    const rawStatus = String(params.status || 'IN_PROGRESS')
    const merged = Boolean(params.merged)
    return {
      key: merged
        ? 'notifications.events.ISSUE_STATUS_MERGED'
        : 'notifications.events.ISSUE_STATUS_CHANGED',
      values: {
        category: rawCategory,
        entrance: Number.isInteger(rawEntrance) ? rawEntrance : null,
        status: rawStatus,
        merged,
      },
      icon: merged ? 'merge_type' : rawStatus === 'RESOLVED' ? 'task_alt' : 'sync_saved_locally',
      variant: rawStatus === 'RESOLVED' ? 'resolved' : 'neutral',
      route: subjectId ? `/issues/${subjectId}` : '/issues',
    }
  }

  if (eventType === 'MAINTENANCE_DUE') {
    const rawDueDate = String(params.due_date || '')
    const formattedDueDate = rawDueDate
      ? formatDate(rawDueDate.includes('T') ? rawDueDate : `${rawDueDate}T12:00:00Z`, lang)
      : ''
    const isOverdue = Boolean(params.overdue)
    const reminderNumber = Number(params.reminder_number) || 0
    const taskTitle =
      typeof params.title === 'string' && params.title.trim()
        ? params.title.trim()
        : typeof params.task_title === 'string' && params.task_title.trim()
          ? params.task_title.trim()
          : ''

    const key = isOverdue
      ? taskTitle
        ? 'notifications.events.MAINTENANCE_OVERDUE_WITH_TITLE'
        : 'notifications.events.MAINTENANCE_OVERDUE'
      : taskTitle
        ? 'notifications.events.MAINTENANCE_DUE_WITH_TITLE'
        : 'notifications.events.MAINTENANCE_DUE'

    return {
      key,
      values: {
        due_date: formattedDueDate,
        reminder_number: reminderNumber,
        title: taskTitle,
      },
      icon: isOverdue ? 'warning' : 'event_repeat',
      variant: isOverdue ? 'emergency' : 'deadline',
      route: subjectId ? `/maintenance/${subjectId}` : '/maintenance',
    }
  }

  if (eventType === 'NOTICE_PUBLISHED') {
    return {
      key: 'notifications.events.NOTICE_PUBLISHED',
      values: {},
      icon: 'campaign',
      variant: 'neutral',
      route: subjectId ? `/forum/${subjectId}` : '/forum',
    }
  }

  if (eventType === 'STORAGE_ALMOST_FULL') {
    const rawPercent = Number(params.used_percent)
    const usedPercent = Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, Math.floor(rawPercent)))
      : 0
    const threshold = Number(params.threshold) || 70
    return {
      key: 'notifications.events.STORAGE_ALMOST_FULL',
      values: {
        used_percent: usedPercent,
        threshold,
      },
      icon: 'hard_drive',
      variant: threshold >= 90 ? 'emergency' : 'deadline',
      route: '/settings/association#storage',
    }
  }

  if (eventType === 'ENERGY_CERTIFICATE_EXPIRING') {
    const rawValidUntil = typeof params.valid_until === 'string' ? params.valid_until.trim() : ''
    const validUntil = rawValidUntil ? formatCalendarDate(rawValidUntil, lang) : '-'
    const hasValidUntil = Boolean(rawValidUntil) && validUntil !== '-'
    const parsedDays =
      typeof params.days_left !== 'boolean' &&
      params.days_left !== undefined &&
      params.days_left !== null &&
      params.days_left !== ''
        ? Number(params.days_left)
        : NaN
    const hasDays = Number.isFinite(parsedDays)
    const daysLeft = hasDays ? Math.trunc(parsedDays) : null
    let key = 'notifications.events.ENERGY_CERTIFICATE_EXPIRING_GENERIC'
    if (daysLeft !== null) {
      if (daysLeft === 0) {
        key = 'notifications.events.ENERGY_CERTIFICATE_EXPIRING_TODAY'
      } else if (hasValidUntil && daysLeft > 0) {
        key = 'notifications.events.ENERGY_CERTIFICATE_EXPIRING'
      } else if (hasValidUntil && daysLeft < 0) {
        key = 'notifications.events.ENERGY_CERTIFICATE_EXPIRING_EXPIRED'
      }
    }
    return {
      key,
      values: {
        valid_until: validUntil,
        days_left: daysLeft ?? 0,
      },
      icon: daysLeft !== null && daysLeft <= 0 ? 'warning' : 'energy_savings_leaf',
      variant: daysLeft !== null && daysLeft <= 0 ? 'emergency' : 'deadline',
      route: '/building',
    }
  }

  return {
    key: 'notifications.events.UNKNOWN',
    values: {},
    icon: 'notifications',
    variant: 'neutral',
    route: null,
  }
}

/**
 * Formats a notification item into a localized human-readable string using the session translator `t`.
 */
export function formatNotificationText(
  item: Partial<NotificationView> | Record<string, unknown> | null | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  lang: string = 'en',
): string {
  const desc = buildNotificationDescriptor(item, lang)
  if (
    desc.key === 'notifications.events.EMERGENCY_PUBLISHED' ||
    desc.key === 'notifications.events.EMERGENCY_RESOLVED'
  ) {
    const categoryStr = String(desc.values.category || '')
    const catKey = `forum.categories.${categoryStr}`
    const categoryLabel =
      t(catKey) !== catKey ? t(catKey).toLowerCase() : categoryStr.toLowerCase()
    let targetLabel = t('notifications.targets.ALL_BUILDING')
    if (desc.values.target_scope === 'ALL_OBJECTS') {
      targetLabel = t('notifications.targets.ALL_OBJECTS')
    } else if (desc.values.target_scope === 'KINDS') {
      const kindsList = formatTargetKindsList(
        Array.isArray(desc.values.target_kinds) ? desc.values.target_kinds : [],
        t,
        { lowercase: true },
      )
      targetLabel = kindsList
        ? t('notifications.targets.KINDS', { kinds: kindsList })
        : t('notifications.targets.KINDS_FALLBACK')
    } else if (desc.values.target_scope === 'ENTRANCE') {
      targetLabel = t('notifications.targets.ENTRANCE', {
        entrance: desc.values.target_entrance,
      })
    } else if (desc.values.target_scope === 'APARTMENT_LIST') {
      targetLabel = t('notifications.targets.APARTMENT_LIST')
    }
    return t(desc.key, {
      category: categoryLabel,
      target: targetLabel,
    })
  }

  if (
    desc.key === 'notifications.events.ISSUE_REPORTED' ||
    desc.key === 'notifications.events.ISSUE_URGENT' ||
    desc.key === 'notifications.events.ISSUE_STATUS_CHANGED' ||
    desc.key === 'notifications.events.ISSUE_STATUS_MERGED'
  ) {
    const categoryStr = String(desc.values.category || '')
    const catKey = `issues.categories.${categoryStr}`
    const categoryLabel =
      t(catKey) !== catKey ? t(catKey).toLowerCase() : categoryStr.toLowerCase()

    const locationLabel =
      desc.values.entrance !== null && desc.values.entrance !== undefined
        ? t('notifications.issueLocations.entrance', { entrance: desc.values.entrance })
        : t('notifications.issueLocations.outside')

    if (desc.key === 'notifications.events.ISSUE_STATUS_CHANGED') {
      const statusStr = String(desc.values.status || '')
      const statusKey = `issues.statuses.${statusStr}`
      const statusLabel =
        t(statusKey) !== statusKey
          ? t(statusKey).toLowerCase()
          : statusStr.toLowerCase()
      return t(desc.key, {
        category: categoryLabel,
        location: locationLabel,
        status: statusLabel,
      })
    }

    return t(desc.key, {
      category: categoryLabel,
      location: locationLabel,
    })
  }

  return t(desc.key, desc.values)
}
