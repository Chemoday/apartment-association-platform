/**
 * Pure domain utilities and mock state engine for #012 Issue Tracker (E9/I1),
 * extended with photos (#020) and retention notices (#021).
 */

import { parseJpegDimensions } from './photoScaling.js'

export const ISSUE_CATEGORIES = [
  'LIGHTING',
  'DOORS_AND_LOCKS',
  'LIFT',
  'HEATING',
  'WATER_AND_SEWAGE',
  'ELECTRICITY',
  'CLEANING',
  'WASTE',
  'YARD',
  'ROOF_AND_FACADE',
  'OTHER',
]

export const OPEN_ISSUE_STATUSES = [
  'REPORTED',
  'IN_PROGRESS',
  'WAITING_FOR_CONTRACTOR',
]

export const ENDED_ISSUE_STATUSES = [
  'RESOLVED',
  'DUPLICATE',
  'DECLINED',
  'WITHDRAWN',
]

export const ALL_ISSUE_STATUSES = [
  ...OPEN_ISSUE_STATUSES,
  ...ENDED_ISSUE_STATUSES,
]

export const STATUS_FILTERS = [
  'OPEN',
  'ENDED',
  ...ALL_ISSUE_STATUSES,
]

export const BOARD_ISSUE_STATUSES = [
  'IN_PROGRESS',
  'WAITING_FOR_CONTRACTOR',
  'RESOLVED',
  'DUPLICATE',
  'DECLINED',
]

export const REOPENABLE_ENDED_STATUSES = [
  'RESOLVED',
  'DUPLICATE',
  'DECLINED',
]

export const MAX_ISSUE_PHOTOS = 3
export const MAX_ISSUE_PHOTO_BYTES = 4_000_000
export const FILES_USER_BYTES_PER_DAY = 20 * 1024 * 1024
export const HARD_PHOTO_MAX_EDGE = 2560
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
export const ONE_DAY_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

// Minimal 1x1 lossless WebP fallback for unit/demo mocks when raw photo bytes are omitted
export const DEFAULT_SAMPLE_WEBP_BYTES = Uint8Array.from(
  atob('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='),
  (c) => c.charCodeAt(0),
)

/**
 * Returns true if the issue status is an open status.
 * @param {string} status
 * @returns {boolean}
 */
export function isIssueOpen(status) {
  return OPEN_ISSUE_STATUSES.includes(status)
}

/**
 * Returns true if the board can reopen an ended issue (RESOLVED, DUPLICATE, DECLINED within 30 days of ended_at).
 * WITHDRAWN issues can never be reopened.
 * @param {any} issue
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function canBoardReopenIssue(issue, nowMs = Date.now()) {
  if (!issue || !REOPENABLE_ENDED_STATUSES.includes(issue.status)) return false
  if (!issue.ended_at) return false
  const endedMs = new Date(issue.ended_at).getTime()
  if (Number.isNaN(endedMs)) return false
  return nowMs - endedMs <= THIRTY_DAYS_MS
}

/**
 * Returns the list of board status transitions offered in the UI for the current issue state.
 * - From an open status: any BoardStatus except the current status.
 * - From RESOLVED, DUPLICATE, or DECLINED within 30 days: ['IN_PROGRESS'] (Reopen).
 * - From WITHDRAWN or ended > 30 days ago: [].
 * @param {any} issue
 * @param {number} [nowMs]
 * @returns {string[]}
 */
export function getAllowedBoardMoves(issue, nowMs = Date.now()) {
  if (!issue || issue.status === 'WITHDRAWN') return []
  if (isIssueOpen(issue.status)) {
    return BOARD_ISSUE_STATUSES.filter((st) => st !== issue.status)
  }
  if (canBoardReopenIssue(issue, nowMs)) {
    return ['IN_PROGRESS']
  }
  return []
}

/**
 * Checks whether `candidate` can be chosen as `duplicate_of` for `currentIssueId`:
 * Must be another issue of the building that residents still see (open, or ended within 30 days)
 * and that is not itself DUPLICATE or WITHDRAWN.
 * @param {any} candidate
 * @param {string} currentIssueId
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isValidDuplicateTarget(candidate, currentIssueId, nowMs = Date.now()) {
  if (!candidate || !candidate.id) return false
  if (String(candidate.id) === String(currentIssueId)) return false
  if (candidate.status === 'DUPLICATE' || candidate.status === 'WITHDRAWN') return false
  if (isIssueOpen(candidate.status)) return true
  if (!candidate.ended_at) return false
  const endedMs = new Date(candidate.ended_at).getTime()
  if (Number.isNaN(endedMs)) return false
  return nowMs - endedMs <= THIRTY_DAYS_MS
}

/**
 * Ranks valid duplicate targets with open issues of the same category & entrance first,
 * followed by remaining open and recently ended issues, optionally filtered by a search query.
 * @param {any[]} candidates
 * @param {any} currentIssue
 * @param {string} [searchQuery]
 * @param {number} [nowMs]
 * @returns {any[]}
 */
export function rankDuplicateCandidates(
  candidates,
  currentIssue,
  searchQuery = '',
  nowMs = Date.now(),
) {
  if (!Array.isArray(candidates) || !currentIssue) {
    return []
  }
  const needle = String(searchQuery || '').trim().toLowerCase()
  const targetCategory = currentIssue.category
  const targetEntrance = currentIssue.entrance ?? null

  const valid = candidates.filter((item) => {
    if (!isValidDuplicateTarget(item, currentIssue.id, nowMs)) return false
    if (!needle) return true
    const hay = `${item.title || ''} ${item.place || ''} ${item.category || ''}`.toLowerCase()
    return hay.includes(needle)
  })

  /** @type {any[]} */
  const recommended = []
  /** @type {any[]} */
  const others = []

  for (const item of valid) {
    const itemEntrance = item.entrance ?? null
    if (
      isIssueOpen(item.status) &&
      item.category === targetCategory &&
      itemEntrance === targetEntrance
    ) {
      recommended.push(item)
    } else {
      others.push(item)
    }
  }

  recommended.sort(compareIssuesOrder)
  others.sort(compareIssuesOrder)

  return [...recommended, ...others]
}

/**
 * Returns true if the user can access the issue tracker at all:
 * anyone with at least one apartment membership OR Chairman / Board.
 * Accountants without an apartment receive 403 FORBIDDEN.
 * @param {Object} user
 * @param {Array} memberships
 * @returns {boolean}
 */
export function canUserAccessIssues(user, memberships = /** @type {any[]} */ ([])) {
  if (!user) return false
  if (['CHAIRMAN', 'BOARD'].includes(user.building_role)) return true
  return Array.isArray(memberships) && memberships.length > 0
}

/**
 * Finds open issues that match the selected category and entrance in the report form
 * so the resident can click "+1" instead of filing a duplicate report.
 * @param {any[]} issues
 * @param {string} category
 * @param {number|null|string} entrance - null or '' means outside/whole building
 * @returns {any[]}
 */
export function findMatchingOpenIssues(issues, category, entrance) {
  if (!Array.isArray(issues) || !category) return []
  const normalizedEntrance =
    entrance === null || entrance === undefined || entrance === '' || Number(entrance) === 0
      ? null
      : Number(entrance)

  return issues.filter((issue) => {
    if (!isIssueOpen(issue.status)) return false
    if (issue.category !== category) return false
    if (normalizedEntrance === null) {
      return issue.entrance === null
    }
    return issue.entrance === normalizedEntrance
  })
}

/**
 * Client-side validation for the Report an Issue form.
 * @param {any} draft
 * @param {any} formMeta - { urgent_enabled, apartment_ids, entrances }
 * @param {boolean} isBoardUser
 * @returns {{ valid: boolean, errors: Record<string, string>, payload: Record<string, any>|null }}
 */
export function validateIssueReportDraft(draft, formMeta, isBoardUser = false) {
  /** @type {Record<string, string>} */
  const errors = {}
  const category = String(draft?.category || '').trim()
  if (!ISSUE_CATEGORIES.includes(category)) {
    errors.category = 'CATEGORY_REQUIRED'
  }

  const rawEntrance = draft?.entrance
  /** @type {number|null} */
  let entrance = null
  if (rawEntrance !== null && rawEntrance !== undefined && rawEntrance !== '' && Number(rawEntrance) !== 0) {
    const parsedEnt = Number(rawEntrance)
    const allowedEntrances = Array.isArray(formMeta?.entrances) ? formMeta.entrances : [1, 2]
    if (!Number.isInteger(parsedEnt) || !allowedEntrances.includes(parsedEnt)) {
      errors.entrance = 'INVALID_LOCATION'
    } else {
      entrance = parsedEnt
    }
  }

  const rawPlace = draft?.place != null ? String(draft.place).trim() : ''
  /** @type {string|null} */
  let place = null
  if (rawPlace.length > 200) {
    errors.place = 'PLACE_TOO_LONG'
  } else if (rawPlace.length > 0) {
    place = rawPlace
  }

  const title = String(draft?.title || '').trim()
  if (title.length < 1) {
    errors.title = 'TITLE_REQUIRED'
  } else if (title.length > 120) {
    errors.title = 'TITLE_TOO_LONG'
  }

  const description = String(draft?.description || '').trim()
  if (description.length > 2000) {
    errors.description = 'DESCRIPTION_TOO_LONG'
  }

  const urgent = Boolean(draft?.urgent)
  if (urgent && !formMeta?.urgent_enabled) {
    errors.urgent = 'URGENT_DISABLED'
  }

  const aptIds = Array.isArray(formMeta?.apartment_ids) ? formMeta.apartment_ids : []
  /** @type {string|null} */
  let apartmentId = draft?.apartment_id ? String(draft.apartment_id).trim() : null
  if (aptIds.length === 1 && !apartmentId) {
    apartmentId = aptIds[0]
  } else if (aptIds.length > 1) {
    if (!apartmentId || !aptIds.includes(apartmentId)) {
      errors.apartment_id = 'APARTMENT_REQUIRED'
    }
  } else if (aptIds.length === 0 && !isBoardUser) {
    errors.apartment_id = 'APARTMENT_REQUIRED'
  } else if (apartmentId && !aptIds.includes(apartmentId)) {
    errors.apartment_id = 'INVALID_AUTHOR_APARTMENT'
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors, payload: null }
  }

  /** @type {Record<string, any>} */
  const payload = {
    category,
    entrance,
    place,
    title,
    description,
    urgent,
  }
  if (apartmentId) {
    payload.apartment_id = apartmentId
  }

  return { valid: true, errors: {}, payload }
}

/**
 * Builds the privacy badge for `changed_by` in the board's action log (without apartment context).
 * Per API.md section 10: a resident who reported or withdrew shows `role_badge: 'RESIDENT'` (even if owner);
 * a board member / chairman shows `role_badge: 'BOARD'`.
 * @param {any} user
 * @returns {{ display_label: string, role_badge: string }}
 */
export function buildActionLogBadge(user) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  const rawLabel = String(user?.full_name || user?.label || 'Resident')
    .replace(/\s*\(Apt\.?\s*[^)]+\)\s*/i, '')
    .trim()
  return {
    display_label: rawLabel || (isBoard ? 'Board' : 'Resident'),
    role_badge: isBoard ? 'BOARD' : 'RESIDENT',
  }
}

/**
 * Creates the canonical seed issues described in docs/backlog/012-issue-tracker.md and 013-board-works-issues.md:
 * 1. Open issue: "No light on the 3rd floor landing", LIGHTING, entrance 2, place "3rd floor landing",
 *    reported by apartment 14 two days ago, with a "+1" from apartment 2 (2 followers).
 * 2. Withdrawn issue: "The front door slams", DOORS_AND_LOCKS, entrance 1, place "Front door",
 *    reported by apartment 2, seen only by its reporter and the board.
 * 3. Old resolved issue (> 30 days ago): "Basement bicycle room lock sticking", DOORS_AND_LOCKS, entrance 1,
 *    resolved 45 days ago, visible in list only when board enables `include_old=true` (or opened by link by board).
 * @param {number} [nowMs]
 * @returns {any[]}
 */
export function createDefaultIssuesSeed(nowMs = Date.now()) {
  const twoDaysAgoIso = new Date(nowMs - 2 * ONE_DAY_MS).toISOString()
  const oneDayAgoIso = new Date(nowMs - 1 * ONE_DAY_MS).toISOString()
  const threeDaysAgoIso = new Date(nowMs - 3 * ONE_DAY_MS).toISOString()
  const twoDaysAgoWithdrawIso = new Date(nowMs - 2 * ONE_DAY_MS - 3600 * 1000).toISOString()
  const fortySixDaysAgoIso = new Date(nowMs - 46 * ONE_DAY_MS).toISOString()
  const fortyFiveDaysAgoIso = new Date(nowMs - 45 * ONE_DAY_MS).toISOString()

  return [
    {
      id: '018f0000-0000-7000-8000-000000000901',
      category: 'LIGHTING',
      entrance: 2,
      place: '3rd floor landing',
      title: 'No light on the 3rd floor landing',
      description:
        'The ceiling lamp above the 3rd floor stairwell landing in entrance 2 went dark yesterday evening. The step edge is hard to see after sunset.',
      status: 'REPORTED',
      urgent: false,
      was_urgent_at_creation: false,
      reporter_user_id: '018f0000-0000-7000-8000-000000000102',
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      reporter_badge: {
        display_label: 'Kati Kask (Apt 14)',
        role_badge: 'OWNER',
      },
      follower_user_ids: [
        '018f0000-0000-7000-8000-000000000102',
        '018f0000-0000-7000-8000-000000000104',
      ],
      duplicate_of: null,
      created_at: twoDaysAgoIso,
      updated_at: oneDayAgoIso,
      ended_at: null,
      timeline: [
        {
          status: 'REPORTED',
          at: twoDaysAgoIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'Kati Kask',
            role_badge: 'RESIDENT',
          },
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000902',
      category: 'DOORS_AND_LOCKS',
      entrance: 1,
      place: 'Front door',
      title: 'The front door slams',
      description:
        'The hydraulic door closer on entrance 1 was loose in the morning, but the hinge screw was tightened by a neighbour.',
      status: 'WITHDRAWN',
      urgent: false,
      was_urgent_at_creation: false,
      reporter_user_id: '018f0000-0000-7000-8000-000000000104',
      apartment_id: '018f0000-0000-7000-8000-000000000302',
      reporter_badge: {
        display_label: 'M. T. (Apt 02)',
        role_badge: 'RESIDENT',
      },
      follower_user_ids: ['018f0000-0000-7000-8000-000000000104'],
      duplicate_of: null,
      created_at: threeDaysAgoIso,
      updated_at: twoDaysAgoWithdrawIso,
      ended_at: twoDaysAgoWithdrawIso,
      timeline: [
        {
          status: 'REPORTED',
          at: threeDaysAgoIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'M. T.',
            role_badge: 'RESIDENT',
          },
        },
        {
          status: 'WITHDRAWN',
          at: twoDaysAgoWithdrawIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'M. T.',
            role_badge: 'RESIDENT',
          },
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000900',
      category: 'DOORS_AND_LOCKS',
      entrance: 1,
      place: 'Basement bicycle room',
      title: 'Basement bicycle room lock sticking',
      description:
        'The cylinder lock on the shared bicycle storage door in entrance 1 needed graphite lubrication and latch alignment.',
      status: 'RESOLVED',
      urgent: false,
      was_urgent_at_creation: false,
      reporter_user_id: '018f0000-0000-7000-8000-000000000101',
      apartment_id: '018f0000-0000-7000-8000-000000000301',
      reporter_badge: {
        display_label: 'Oleg Sidorov (Apt 01)',
        role_badge: 'OWNER',
      },
      follower_user_ids: ['018f0000-0000-7000-8000-000000000101'],
      duplicate_of: null,
      created_at: fortySixDaysAgoIso,
      updated_at: fortyFiveDaysAgoIso,
      ended_at: fortyFiveDaysAgoIso,
      timeline: [
        {
          status: 'REPORTED',
          at: fortySixDaysAgoIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'Oleg Sidorov',
            role_badge: 'RESIDENT',
          },
        },
        {
          status: 'IN_PROGRESS',
          at: fortySixDaysAgoIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'Oleg Sidorov',
            role_badge: 'BOARD',
          },
        },
        {
          status: 'RESOLVED',
          at: fortyFiveDaysAgoIso,
          action: 'STATUS',
          changed_by: {
            display_label: 'Oleg Sidorov',
            role_badge: 'BOARD',
          },
        },
      ],
    },
  ]
}

/**
 * Visibility rules from API.md Section 10:
 * - Open issues are visible to all eligible users.
 * - Ended issues remain visible in lists for 30 days after ended_at.
 * - WITHDRAWN issues are visible ONLY to their reporter and the board (CHAIRMAN, BOARD);
 *   in lists for 30 days, or at any age when opened by link (`byLink: true`) or when board sets `includeOld: true`.
 * - The board also lists older ended issues with `includeOld: true`, and opens any issue by its link (`byLink: true`).
 * @param {any} issue
 * @param {any} user
 * @param {number} [nowMs]
 * @param {{ byLink?: boolean, includeOld?: boolean }} [options]
 * @returns {boolean}
 */
export function isIssueVisibleToUser(issue, user, nowMs = Date.now(), options = {}) {
  if (!issue || !user) return false
  if (isIssueOpen(issue.status)) return true

  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  const isReporter = issue.reporter_user_id === user.user_id
  const byLink = Boolean(options?.byLink)
  const includeOld = Boolean(options?.includeOld) && isBoard

  if (issue.status === 'WITHDRAWN') {
    if (!isBoard && !isReporter) return false
    if (byLink || includeOld) return true
  } else if (byLink && isBoard) {
    return true
  } else if (includeOld) {
    return true
  }

  if (!issue.ended_at) return false
  const endedMs = new Date(issue.ended_at).getTime()
  if (Number.isNaN(endedMs) || nowMs - endedMs > THIRTY_DAYS_MS) {
    return false
  }

  return true
}

/**
 * Sorting order from API.md Section 10:
 * Open issues first (newest created_at first), then ended issues (newest ended_at first).
 */
export function compareIssuesOrder(a, b) {
  const aOpen = isIssueOpen(a.status) ? 0 : 1
  const bOpen = isIssueOpen(b.status) ? 0 : 1
  if (aOpen !== bOpen) return aOpen - bOpen

  if (aOpen === 0) {
    const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (diff !== 0) return diff
    return String(b.id).localeCompare(String(a.id))
  }

  const aEnded = new Date(a.ended_at || a.updated_at || a.created_at).getTime()
  const bEnded = new Date(b.ended_at || b.updated_at || b.created_at).getTime()
  if (bEnded !== aEnded) return bEnded - aEnded
  return String(b.id).localeCompare(String(a.id))
}

/**
 * Maps an internal stored photo record to the public privacy-safe IssuePhoto view.
 * Never exposes uploader identity (`uploader_user_id`), only `mine` and `can_delete`.
 */
export function toIssuePhotoView(photo, issue, user) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  const mine = Boolean(photo.uploader_user_id && user?.user_id && photo.uploader_user_id === user.user_id)
  const canDelete = isBoard || (mine && isIssueOpen(issue?.status))
  return {
    id: photo.id,
    width: photo.width,
    height: photo.height,
    created_at: photo.created_at,
    mine,
    can_delete: canDelete,
  }
}

/**
 * Computes `photos_delete_at` (#021 Retention):
 * `ended_at + 30 days` ONLY when `status === 'RESOLVED'` and the issue has >= 1 photo; `null` otherwise.
 * @param {any} issue
 * @returns {string | null}
 */
export function computePhotosDeleteAt(issue) {
  if (!issue || issue.status !== 'RESOLVED' || !issue.ended_at) return null
  const photos = Array.isArray(issue.photos) ? issue.photos : []
  if (photos.length === 0) return null
  const endedMs = new Date(issue.ended_at).getTime()
  if (Number.isNaN(endedMs)) return null
  return new Date(endedMs + THIRTY_DAYS_MS).toISOString()
}

/**
 * Converts an internal mock issue record into an OpenAPI IssueSummary.
 */
export function toIssueSummary(issue, user, options = {}) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  const open = isIssueOpen(issue.status)
  const iReported = issue.reporter_user_id === user.user_id
  const followerIds = Array.isArray(issue.follower_user_ids) ? issue.follower_user_ids : []
  const iFollow = followerIds.includes(user.user_id)
  const uploadsDisabled = Boolean(options?.uploadsDisabled)

  const rawPhotos = Array.isArray(issue.photos) ? issue.photos : []
  const photos = rawPhotos
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((photo) => toIssuePhotoView(photo, issue, user))

  return {
    id: issue.id,
    category: issue.category,
    entrance: issue.entrance ?? null,
    place: issue.place ?? null,
    title: issue.title,
    status: issue.status,
    urgent: Boolean(issue.urgent),
    followers: followerIds.length,
    i_follow: iFollow,
    i_reported: iReported,
    can_follow: open && !iFollow,
    can_edit: issue.status === 'REPORTED' && iReported,
    can_manage: isBoard,
    duplicate_of: issue.duplicate_of ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    ended_at: issue.ended_at ?? null,
    photos,
    can_add_photo:
      !uploadsDisabled &&
      open &&
      (isBoard || iReported) &&
      photos.length < MAX_ISSUE_PHOTOS,
    photos_delete_at: computePhotosDeleteAt(issue),
  }
}

/**
 * Converts an internal mock issue record into an OpenAPI IssueView.
 * Enforces privacy rules:
 * - Residents never see `reporter` (`null`), never see `changed_by` on timeline entries (`null`),
 *   and `URGENT_CLEARED` entries are omitted for residents.
 * - Board and Chairman see `reporter` (`{ badge, apartment_id }`) and full action log (`action`, `changed_by`).
 */
export function toIssueView(issue, user, options = {}) {
  const summary = toIssueSummary(issue, user, options)
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user.building_role)

  const reporter = isBoard && issue.reporter_badge
    ? {
        badge: { ...issue.reporter_badge },
        apartment_id: issue.apartment_id ?? null,
      }
    : null

  const rawTimeline = Array.isArray(issue.timeline) ? issue.timeline : []
  const timeline = rawTimeline
    .filter((entry) => isBoard || (entry.action || 'STATUS') !== 'URGENT_CLEARED')
    .map((entry) => ({
      status: entry.status,
      at: entry.at,
      action: isBoard ? entry.action || 'STATUS' : 'STATUS',
      changed_by: isBoard && entry.changed_by ? { ...entry.changed_by } : null,
    }))

  return {
    ...summary,
    description: issue.description || '',
    reporter,
    timeline,
  }
}

/**
 * Reads a setting value from the #011 settings array with fallback default.
 */
export function readSettingFromStore(settingsStore, key, fallbackValue) {
  if (!Array.isArray(settingsStore)) return fallbackValue
  const found = settingsStore.find((s) => s.key === key)
  return found !== undefined ? found.value : fallbackValue
}

/**
 * Filters and sorts issues for GET /api/v1/issues.
 */
export function queryIssuesStore(issuesStore, user, query = {}, nowMs = Date.now(), options = {}) {
  const statusFilter = query.status ? String(query.status) : null
  const categoryFilter = query.category ? String(query.category) : null
  const rawEntrance = query.entrance
  const includeOld = query.include_old === true || query.include_old === 'true'

  if (statusFilter && !STATUS_FILTERS.includes(statusFilter)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid status filter.',
    }
  }

  if (categoryFilter && !ISSUE_CATEGORIES.includes(categoryFilter)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid category filter.',
    }
  }

  let entranceFilter = undefined
  if (rawEntrance !== undefined && rawEntrance !== null && rawEntrance !== '') {
    const parsed = Number(rawEntrance)
    if (!Number.isInteger(parsed) || parsed < 0) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Invalid entrance filter.',
      }
    }
    entranceFilter = parsed
  }

  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 100)
  const offset = Math.max(Number(query.offset || 0), 0)

  const filtered = issuesStore.filter((issue) => {
    if (!isIssueVisibleToUser(issue, user, nowMs, { includeOld, byLink: false })) return false

    if (statusFilter === 'OPEN') {
      if (!isIssueOpen(issue.status)) return false
    } else if (statusFilter === 'ENDED') {
      if (isIssueOpen(issue.status)) return false
    } else if (statusFilter) {
      if (issue.status !== statusFilter) return false
    }

    if (categoryFilter && issue.category !== categoryFilter) {
      return false
    }

    if (entranceFilter !== undefined) {
      if (entranceFilter === 0) {
        if (issue.entrance !== null) return false
      } else if (issue.entrance !== entranceFilter) {
        return false
      }
    }

    return true
  })

  filtered.sort(compareIssuesOrder)
  const items = filtered.slice(offset, offset + limit).map((i) => toIssueSummary(i, user, options))
  return { ok: true, items }
}

/**
 * Validates and creates a new issue in the mock store for POST /api/v1/issues.
 * @param {Object} opts
 * @param {any[]} opts.issuesStore
 * @param {any[]} opts.settingsStore
 * @param {any} opts.user
 * @param {any[]} [opts.userMemberships]
 * @param {any} [opts.reporterBadge]
 * @param {any} [opts.body]
 * @param {number[]} [opts.buildingEntrances]
 * @param {number} [opts.nowMs]
 */
export function createIssueInStore({
  issuesStore,
  settingsStore,
  user,
  userMemberships = /** @type {any[]} */ ([]),
  reporterBadge = undefined,
  body = {},
  buildingEntrances = [1, 2],
  nowMs = Date.now(),
}) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  const urgentEnabled = Boolean(
    readSettingFromStore(settingsStore, 'issues.urgent_enabled', false),
  )
  const reportsPerDay = Number(
    readSettingFromStore(settingsStore, 'issues.reports_per_apartment_per_day', 3),
  )
  const urgentPerDay = Number(
    readSettingFromStore(settingsStore, 'issues.urgent_per_apartment_per_day', 1),
  )

  const category = typeof body?.category === 'string' ? body.category.trim() : ''
  if (!ISSUE_CATEGORIES.includes(category)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid issue category.',
      extra: {
        errors: [{ loc: ['body', 'category'], msg: 'Invalid issue category.', type: 'value_error' }],
      },
    }
  }

  let entrance = null
  if (body?.entrance !== undefined && body?.entrance !== null) {
    const parsedEnt = Number(body.entrance)
    if (!Number.isInteger(parsedEnt) || !buildingEntrances.includes(parsedEnt)) {
      return {
        ok: false,
        status: 422,
        errorCode: 'INVALID_LOCATION',
        message: 'That entrance does not exist in this building.',
      }
    }
    entrance = parsedEnt
  }

  let place = null
  if (body?.place !== undefined && body?.place !== null) {
    const trimmedPlace = String(body.place).trim()
    if (trimmedPlace.length > 200) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Place must be at most 200 characters.',
        extra: {
          errors: [{ loc: ['body', 'place'], msg: 'Place must be at most 200 characters.', type: 'value_error' }],
        },
      }
    }
    place = trimmedPlace.length > 0 ? trimmedPlace : null
  }

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (title.length < 1 || title.length > 120) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Title must be between 1 and 120 characters.',
      extra: {
        errors: [{ loc: ['body', 'title'], msg: 'Title must be 1..120 characters.', type: 'value_error' }],
      },
    }
  }

  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  if (description.length > 2000) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Description must be at most 2000 characters.',
      extra: {
        errors: [
          {
            loc: ['body', 'description'],
            msg: 'Description must be at most 2000 characters.',
            type: 'value_error',
          },
        ],
      },
    }
  }

  const urgent = Boolean(body?.urgent)
  if (urgent && !urgentEnabled) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Urgent reporting is disabled for this building.',
      extra: {
        errors: [
          {
            loc: ['body', 'urgent'],
            msg: 'Urgent reporting is disabled for this building.',
            type: 'value_error',
          },
        ],
      },
    }
  }

  const aptIds = userMemberships
    .slice()
    .sort((a, b) => String(a.apartment_number).localeCompare(String(b.apartment_number)))
    .map((m) => m.apartment_id)

  let targetApartmentId = null
  if (body?.apartment_id !== undefined && body?.apartment_id !== null && body?.apartment_id !== '') {
    const requestedAptId = String(body.apartment_id)
    if (!aptIds.includes(requestedAptId)) {
      return {
        ok: false,
        status: 422,
        errorCode: 'INVALID_AUTHOR_APARTMENT',
        message: 'Select one of your apartments to report the issue.',
      }
    }
    targetApartmentId = requestedAptId
  } else if (aptIds.length === 1 && body?.apartment_id !== null) {
    targetApartmentId = aptIds[0]
  } else if (aptIds.length > 1 && body?.apartment_id !== null) {
    return {
      ok: false,
      status: 422,
      errorCode: 'INVALID_AUTHOR_APARTMENT',
      message: 'Select which of your apartments is reporting this issue.',
    }
  } else if (!isBoard) {
    return {
      ok: false,
      status: 422,
      errorCode: 'INVALID_AUTHOR_APARTMENT',
      message: 'An apartment membership is required to report an issue.',
    }
  }

  // Per-apartment 24-hour rate limit check (Board/Chairman are never rate-limited)
  if (!isBoard && targetApartmentId) {
    const windowStartMs = nowMs - ONE_DAY_MS
    const recentAptIssues = issuesStore
      .filter((item) => {
        if (item.apartment_id !== targetApartmentId) return false
        const createdMs = new Date(item.created_at).getTime()
        return !Number.isNaN(createdMs) && createdMs > windowStartMs
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

    if (recentAptIssues.length >= reportsPerDay) {
      const oldestMs = new Date(recentAptIssues[0].created_at).getTime()
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + ONE_DAY_MS - nowMs) / 1000))
      return {
        ok: false,
        status: 429,
        errorCode: 'RATE_LIMITED',
        message: "Your apartment has reached today's limit of reports.",
        extra: { retry_after_seconds: retryAfterSeconds },
      }
    }

    if (urgent) {
      const recentUrgentIssues = recentAptIssues.filter(
        (item) => item.was_urgent_at_creation || item.urgent,
      )
      if (recentUrgentIssues.length >= urgentPerDay) {
        const oldestUrgentMs = new Date(recentUrgentIssues[0].created_at).getTime()
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((oldestUrgentMs + ONE_DAY_MS - nowMs) / 1000),
        )
        return {
          ok: false,
          status: 429,
          errorCode: 'RATE_LIMITED',
          message: "Your apartment has reached today's limit of urgent reports.",
          extra: { retry_after_seconds: retryAfterSeconds },
        }
      }
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  const newIssue = {
    id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
    category,
    entrance,
    place,
    title,
    description,
    status: 'REPORTED',
    urgent,
    was_urgent_at_creation: urgent,
    reporter_user_id: user.user_id,
    apartment_id: targetApartmentId,
    reporter_badge: reporterBadge || {
      display_label: user.label || 'Resident',
      role_badge: ['CHAIRMAN', 'BOARD'].includes(user.building_role) ? 'BOARD' : 'OWNER',
    },
    follower_user_ids: [user.user_id],
    duplicate_of: null,
    photos: [],
    created_at: nowIso,
    updated_at: nowIso,
    ended_at: null,
    timeline: [
      {
        status: 'REPORTED',
        at: nowIso,
        action: 'STATUS',
        changed_by: {
          display_label: buildActionLogBadge(user).display_label,
          role_badge: 'RESIDENT',
        },
      },
    ],
  }

  issuesStore.unshift(newIssue)
  return { ok: true, issue: toIssueView(newIssue, user), rawIssue: newIssue }
}

/**
 * Validates and applies PATCH /api/v1/issues/{issue_id}.
 */
export function editIssueInStore({
  issue,
  user,
  body = {},
  buildingEntrances = [1, 2],
  nowMs = Date.now(),
}) {
  if (issue.reporter_user_id !== user.user_id) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the reporter can edit this issue.',
    }
  }

  if (issue.status !== 'REPORTED') {
    return {
      ok: false,
      status: 409,
      errorCode: 'ISSUE_NOT_EDITABLE',
      message: 'The board is already handling this issue, so it can no longer be edited.',
    }
  }

  const allowedKeys = ['category', 'entrance', 'place', 'title', 'description']
  const providedKeys = allowedKeys.filter((k) => Object.prototype.hasOwnProperty.call(body || {}, k))
  if (providedKeys.length === 0) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Provide at least one field to update.',
    }
  }

  let nextCategory = issue.category
  if (Object.prototype.hasOwnProperty.call(body, 'category') && body.category !== null) {
    const cat = String(body.category || '').trim()
    if (!ISSUE_CATEGORIES.includes(cat)) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Invalid category.',
      }
    }
    nextCategory = cat
  }

  let nextEntrance = issue.entrance
  if (Object.prototype.hasOwnProperty.call(body, 'entrance')) {
    if (body.entrance === null || body.entrance === '') {
      nextEntrance = null
    } else {
      const parsedEnt = Number(body.entrance)
      if (!Number.isInteger(parsedEnt) || !buildingEntrances.includes(parsedEnt)) {
        return {
          ok: false,
          status: 422,
          errorCode: 'INVALID_LOCATION',
          message: 'That entrance does not exist in this building.',
        }
      }
      nextEntrance = parsedEnt
    }
  }

  let nextPlace = issue.place
  if (Object.prototype.hasOwnProperty.call(body, 'place')) {
    if (body.place === null) {
      nextPlace = null
    } else {
      const trimmedPlace = String(body.place).trim()
      if (trimmedPlace.length > 200) {
        return {
          ok: false,
          status: 422,
          errorCode: 'VALIDATION_ERROR',
          message: 'Place must be at most 200 characters.',
        }
      }
      nextPlace = trimmedPlace.length > 0 ? trimmedPlace : null
    }
  }

  let nextTitle = issue.title
  if (Object.prototype.hasOwnProperty.call(body, 'title') && body.title !== null) {
    const trimmedTitle = String(body.title).trim()
    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Title must be between 1 and 120 characters.',
      }
    }
    nextTitle = trimmedTitle
  }

  let nextDescription = issue.description
  if (Object.prototype.hasOwnProperty.call(body, 'description') && body.description !== null) {
    const trimmedDesc = String(body.description).trim()
    if (trimmedDesc.length > 2000) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Description must be at most 2000 characters.',
      }
    }
    nextDescription = trimmedDesc
  }

  issue.category = nextCategory
  issue.entrance = nextEntrance
  issue.place = nextPlace
  issue.title = nextTitle
  issue.description = nextDescription
  issue.updated_at = new Date(nowMs).toISOString()

  return { ok: true, issue: toIssueView(issue, user) }
}

/**
 * Applies POST /api/v1/issues/{issue_id}/withdraw.
 */
export function withdrawIssueInStore({ issue, user, nowMs = Date.now() }) {
  if (issue.reporter_user_id !== user.user_id) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the reporter can withdraw this issue.',
    }
  }

  if (issue.status !== 'REPORTED') {
    return {
      ok: false,
      status: 409,
      errorCode: 'ISSUE_NOT_EDITABLE',
      message: 'The board is already handling this issue, so it can no longer be withdrawn.',
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  issue.status = 'WITHDRAWN'
  issue.urgent = false
  issue.photos = []
  issue.updated_at = nowIso
  issue.ended_at = nowIso
  issue.timeline.push({
    status: 'WITHDRAWN',
    at: nowIso,
    action: 'STATUS',
    changed_by: {
      display_label: buildActionLogBadge(user).display_label,
      role_badge: 'RESIDENT',
    },
  })

  return { ok: true, issue: toIssueView(issue, user) }
}

/**
 * Applies PUT / DELETE /api/v1/issues/{issue_id}/follow.
 * Per API.md section 10: PUT on an ended issue returns 409 ISSUE_ENDED; DELETE always works.
 */
export function updateIssueFollowInStore({ issue, user, follow }) {
  if (follow && !isIssueOpen(issue.status)) {
    return {
      ok: false,
      status: 409,
      errorCode: 'ISSUE_ENDED',
      message: 'This issue is already closed.',
    }
  }

  if (!Array.isArray(issue.follower_user_ids)) {
    issue.follower_user_ids = []
  }

  if (follow) {
    if (!issue.follower_user_ids.includes(user.user_id)) {
      issue.follower_user_ids.push(user.user_id)
    }
  } else {
    issue.follower_user_ids = issue.follower_user_ids.filter((id) => id !== user.user_id)
  }

  return { ok: true, issue: toIssueView(issue, user) }
}

/**
 * Applies POST /api/v1/issues/{issue_id}/status (Board & Chairman workflow, #013 E9/I2).
 * @param {Object} opts
 * @param {any[]} opts.issuesStore
 * @param {any} opts.issue
 * @param {any} opts.user
 * @param {any} [opts.actorBadge]
 * @param {any} [opts.body]
 * @param {number} [opts.nowMs]
 */
export function changeIssueStatusInStore({
  issuesStore,
  issue,
  user,
  actorBadge = undefined,
  body = {},
  nowMs = Date.now(),
}) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  if (!isBoard) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only board members and the chairman can change issue status.',
    }
  }

  const nextStatus = typeof body?.status === 'string' ? body.status.trim() : ''
  if (!BOARD_ISSUE_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid board status.',
    }
  }

  const rawDuplicateOf =
    body?.duplicate_of !== undefined && body?.duplicate_of !== null
      ? String(body.duplicate_of).trim()
      : null

  if (nextStatus === 'DUPLICATE' && !rawDuplicateOf) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'duplicate_of is required when marking an issue as DUPLICATE.',
    }
  }

  if (nextStatus !== 'DUPLICATE' && rawDuplicateOf !== null) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'duplicate_of is only allowed when status is DUPLICATE.',
    }
  }

  // Transition check comes FIRST (before looking at duplicate_of original)
  if (issue.status === 'WITHDRAWN') {
    return {
      ok: false,
      status: 409,
      errorCode: 'INVALID_ISSUE_TRANSITION',
      message: 'A withdrawn issue cannot be changed.',
      extra: { status: issue.status },
    }
  }

  // Current status again changes nothing (no timeline entry, does not inspect original)
  if (nextStatus === issue.status) {
    return { ok: true, issue: toIssueView(issue, user), notifications: [] }
  }

  if (!isIssueOpen(issue.status)) {
    // Ended issue (RESOLVED, DUPLICATE, DECLINED): only IN_PROGRESS (reopen) within 30 days
    if (nextStatus !== 'IN_PROGRESS' || !canBoardReopenIssue(issue, nowMs)) {
      return {
        ok: false,
        status: 409,
        errorCode: 'INVALID_ISSUE_TRANSITION',
        message: 'This status transition is not allowed for the current issue state.',
        extra: { status: issue.status },
      }
    }
  }

  const nowIso = new Date(nowMs).toISOString()
  const effectiveBadge = actorBadge || buildActionLogBadge(user)

  if (nextStatus === 'DUPLICATE') {
    const original = (issuesStore || []).find((item) => item.id === rawDuplicateOf)
    if (!isValidDuplicateTarget(original, issue.id, nowMs)) {
      return {
        ok: false,
        status: 422,
        errorCode: 'INVALID_DUPLICATE',
        message:
          'Select another active or recently closed issue that is not itself a duplicate or withdrawn.',
      }
    }

    const duplicateFollowerIds = (issue.follower_user_ids || []).filter(
      (uid) => uid !== user.user_id,
    )

    // Merge followers from the duplicate into the original (once)
    if (!Array.isArray(original.follower_user_ids)) {
      original.follower_user_ids = []
    }
    for (const uid of issue.follower_user_ids || []) {
      if (!original.follower_user_ids.includes(uid)) {
        original.follower_user_ids.push(uid)
      }
    }

    const notifications = [
      {
        recipientUserIds: duplicateFollowerIds,
        event_type: 'ISSUE_STATUS_CHANGED',
        subject_type: 'issue',
        subject_id: original.id,
        params: {
          category: issue.category,
          entrance: issue.entrance ?? null,
          status: 'DUPLICATE',
          merged: true,
        },
        created_at: nowIso,
      },
    ]

    // A REPORTED original moves to IN_PROGRESS with the merge
    if (original.status === 'REPORTED') {
      original.status = 'IN_PROGRESS'
      original.updated_at = nowIso
      if (!Array.isArray(original.timeline)) {
        original.timeline = []
      }
      original.timeline.push({
        status: 'IN_PROGRESS',
        at: nowIso,
        action: 'STATUS',
        changed_by: { ...effectiveBadge },
      })

      const originalFollowerIds = (original.follower_user_ids || []).filter(
        (uid) => uid !== user.user_id,
      )
      notifications.push({
        recipientUserIds: originalFollowerIds,
        event_type: 'ISSUE_STATUS_CHANGED',
        subject_type: 'issue',
        subject_id: original.id,
        params: {
          category: original.category,
          entrance: original.entrance ?? null,
          status: 'IN_PROGRESS',
          merged: false,
        },
        created_at: nowIso,
      })
    }

    issue.status = 'DUPLICATE'
    issue.duplicate_of = original.id
    issue.photos = []
    issue.ended_at = nowIso
    issue.updated_at = nowIso
    if (!Array.isArray(issue.timeline)) {
      issue.timeline = []
    }
    issue.timeline.push({
      status: 'DUPLICATE',
      at: nowIso,
      action: 'STATUS',
      changed_by: { ...effectiveBadge },
    })

    return { ok: true, issue: toIssueView(issue, user), notifications }
  }

  issue.status = nextStatus
  issue.duplicate_of = null
  if (nextStatus === 'DECLINED') {
    issue.photos = []
  }
  issue.updated_at = nowIso
  issue.ended_at = isIssueOpen(nextStatus) ? null : nowIso
  if (!Array.isArray(issue.timeline)) {
    issue.timeline = []
  }
  issue.timeline.push({
    status: nextStatus,
    at: nowIso,
    action: 'STATUS',
    changed_by: { ...effectiveBadge },
  })

  const followerIds = (issue.follower_user_ids || []).filter((uid) => uid !== user.user_id)
  const notifications = [
    {
      recipientUserIds: followerIds,
      event_type: 'ISSUE_STATUS_CHANGED',
      subject_type: 'issue',
      subject_id: issue.id,
      params: {
        category: issue.category,
        entrance: issue.entrance ?? null,
        status: nextStatus,
        merged: false,
      },
      created_at: nowIso,
    },
  ]

  return { ok: true, issue: toIssueView(issue, user), notifications }
}

/**
 * Builds the notification batch for a newly reported issue (#014 E9/I3).
 * Sent to CHAIRMAN and BOARD members of the building, never to the reporter.
 * @param {any} rawIssue
 * @param {any[]} allUsers
 * @param {any} reporterUser
 */
export function buildIssueReportedNotification(rawIssue, allUsers, reporterUser) {
  const recipientUserIds = (allUsers || [])
    .filter(
      (u) =>
        ['CHAIRMAN', 'BOARD'].includes(u.building_role) &&
        u.user_id !== reporterUser?.user_id,
    )
    .map((u) => u.user_id)

  return {
    recipientUserIds,
    event_type: rawIssue.urgent ? 'ISSUE_URGENT' : 'ISSUE_REPORTED',
    subject_type: 'issue',
    subject_id: rawIssue.id,
    params: {
      category: rawIssue.category,
      entrance: rawIssue.entrance ?? null,
    },
    created_at: rawIssue.created_at || new Date().toISOString(),
  }
}

/**
 * Applies POST /api/v1/issues/{issue_id}/urgent/clear (Board & Chairman workflow, #013 E9/I2).
 * @param {Object} opts
 * @param {any} opts.issue
 * @param {any} opts.user
 * @param {any} [opts.actorBadge]
 * @param {number} [opts.nowMs]
 */
export function clearIssueUrgentInStore({
  issue,
  user,
  actorBadge = undefined,
  nowMs = Date.now(),
}) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  if (!isBoard) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only board members and the chairman can clear the urgent flag.',
    }
  }

  if (!isIssueOpen(issue.status)) {
    return {
      ok: false,
      status: 409,
      errorCode: 'ISSUE_ENDED',
      message: 'This issue is already closed.',
    }
  }

  // Already not urgent: changes nothing
  if (!issue.urgent) {
    return { ok: true, issue: toIssueView(issue, user) }
  }

  const nowIso = new Date(nowMs).toISOString()
  const effectiveBadge = actorBadge || buildActionLogBadge(user)

  issue.urgent = false
  issue.updated_at = nowIso
  if (!Array.isArray(issue.timeline)) {
    issue.timeline = []
  }
  issue.timeline.push({
    status: issue.status,
    at: nowIso,
    action: 'URGENT_CLEARED',
    changed_by: { ...effectiveBadge },
  })

  return { ok: true, issue: toIssueView(issue, user) }
}

/**
 * Scales natural dimensions to the display cap (at most 1920 px on long edge).
 */
function toDisplayDimensions(width, height) {
  const maxEdge = 1920
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return { width, height }
  const ratio = maxEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

/**
 * Runs pre-body validation & limit checks for POST /api/v1/issues/{issue_id}/photos (#020, #025).
 * @param {Object} opts
 * @param {any} opts.issue
 * @param {any} opts.user
 * @param {string} [opts.contentType]
 * @param {number | null | undefined} [opts.contentLength]
 * @param {string} [opts.idempotencyKey]
 * @param {Map<string, any> | null} [opts.idempotencyStore]
 * @param {Array<{ userId: string, bytes: number, atMs: number }> | null} [opts.dailyUploadsStore]
 * @param {number} [opts.dailyUserLimitBytes]
 * @param {number} [opts.nowMs]
 * @param {boolean} [opts.uploadsDisabled]
 * @param {'QUOTA' | 'DELETIONS_PENDING' | ''} [opts.quotaExceededReason]
 * @param {boolean} [opts.lowDisk]
 * @param {{ photosUsedBytes?: number, photosLimitBytes?: number, pendingDeletionBytes?: number, quotaBytes?: number } | null} [opts.storageStats]
 * @param {number | undefined} [opts.byteLengthFallback]
 * @returns {any}
 */
export function checkIssuePhotoUploadPreflight({
  issue,
  user,
  contentType = 'image/jpeg',
  contentLength = undefined,
  idempotencyKey = '',
  idempotencyStore = null,
  dailyUploadsStore = null,
  dailyUserLimitBytes = FILES_USER_BYTES_PER_DAY,
  nowMs = Date.now(),
  uploadsDisabled = false,
  quotaExceededReason = '',
  lowDisk = false,
  storageStats = null,
  byteLengthFallback = undefined,
}) {
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  const iReporter = issue?.reporter_user_id === user?.user_id
  if (!(isBoard || iReporter)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the reporter and the board can add photos to this issue.',
    }
  }

  const rawKey = idempotencyKey == null ? '' : String(idempotencyKey)
  if (rawKey.length > 0 && !IDEMPOTENCY_KEY_RE.test(rawKey)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Malformed Idempotency-Key header.',
    }
  }

  const resolvedLength =
    contentLength === undefined
      ? Number(byteLengthFallback ?? NaN)
      : contentLength === null
        ? NaN
        : Number(contentLength)

  const normalizedMime = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const canonicalMime = ['image/jpeg', 'image/jpg', 'image/pjpeg'].includes(normalizedMime)
    ? 'image/jpeg'
    : normalizedMime

  const scopedKey = rawKey ? `${user?.user_id || 'anon'}:${rawKey}` : ''
  if (scopedKey && idempotencyStore instanceof Map && idempotencyStore.has(scopedKey)) {
    const entry = idempotencyStore.get(scopedKey)
    if (entry.issueId !== issue.id) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another upload.',
      }
    }
    if (
      entry.contentLength !== undefined &&
      Number.isFinite(resolvedLength) &&
      resolvedLength !== entry.contentLength
    ) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another file.',
      }
    }
    if (entry.contentType && canonicalMime && canonicalMime !== entry.contentType) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another file.',
      }
    }
    const existing = (issue.photos || []).find((p) => p.id === entry.photoId)
    if (existing) {
      return {
        ok: true,
        status: 200,
        replay: true,
        idempotencyDigest: entry.contentDigest || '',
        photo: toIssuePhotoView(existing, issue, user),
        issue: toIssueView(issue, user, { uploadsDisabled }),
      }
    }
    return {
      ok: false,
      status: 409,
      errorCode: 'UPLOAD_REMOVED',
      message: 'This photo was removed.',
    }
  }

  if (!isIssueOpen(issue.status)) {
    return {
      ok: false,
      status: 409,
      errorCode: 'ISSUE_ENDED',
      message: 'This issue is closed.',
    }
  }

  const photosList = Array.isArray(issue.photos) ? issue.photos : []
  if (photosList.length >= MAX_ISSUE_PHOTOS) {
    return {
      ok: false,
      status: 409,
      errorCode: 'PHOTO_LIMIT_REACHED',
      message: 'At most 3 photos.',
    }
  }

  if (!['image/jpeg', 'image/jpg', 'image/pjpeg'].includes(normalizedMime)) {
    return {
      ok: false,
      status: 415,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only JPEG photos are accepted.',
    }
  }

  if (!Number.isFinite(resolvedLength) || resolvedLength < 0) {
    return {
      ok: false,
      status: 411,
      errorCode: 'LENGTH_REQUIRED',
      message: 'Content-Length header is required.',
    }
  }

  if (resolvedLength > MAX_ISSUE_PHOTO_BYTES) {
    return {
      ok: false,
      status: 413,
      errorCode: 'FILE_TOO_LARGE',
      message: 'Photo exceeds the 4 MB limit.',
      extra: { max_bytes: MAX_ISSUE_PHOTO_BYTES },
    }
  }

  if (uploadsDisabled) {
    return {
      ok: false,
      status: 403,
      errorCode: 'UPLOADS_DISABLED',
      message: 'Photos are switched off in this demo.',
    }
  }

  if (lowDisk) {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_LOW_DISK',
      message: 'Server disk is nearly full.',
    }
  }

  if (quotaExceededReason === 'DELETIONS_PENDING') {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_QUOTA_EXCEEDED',
      message: 'Deleted files waiting to be erased.',
      extra: { reason: 'DELETIONS_PENDING' },
    }
  }
  if (quotaExceededReason === 'QUOTA') {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_QUOTA_EXCEEDED',
      message: 'Photo storage quota exceeded.',
      extra: { reason: 'QUOTA', category: 'photos' },
    }
  }
  if (storageStats) {
    const usedPhotos = Number(storageStats.photosUsedBytes || 0)
    const limitPhotos = Number(storageStats.photosLimitBytes || Infinity)
    const pendingDel = Number(storageStats.pendingDeletionBytes || 0)
    const totalQuota = Number(storageStats.quotaBytes || Infinity)
    if (pendingDel + resolvedLength > totalQuota) {
      return {
        ok: false,
        status: 507,
        errorCode: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Deleted files waiting to be erased.',
        extra: { reason: 'DELETIONS_PENDING' },
      }
    }
    if (usedPhotos + resolvedLength > limitPhotos) {
      return {
        ok: false,
        status: 507,
        errorCode: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Photo storage quota exceeded.',
        extra: { reason: 'QUOTA', category: 'photos' },
      }
    }
  }

  if (!isBoard && Array.isArray(dailyUploadsStore)) {
    const cutoff = nowMs - ONE_DAY_MS
    let usedToday = 0
    let oldestAtMs = Infinity
    for (let i = dailyUploadsStore.length - 1; i >= 0; i -= 1) {
      const rec = dailyUploadsStore[i]
      if (!rec || rec.atMs <= cutoff) {
        dailyUploadsStore.splice(i, 1)
        continue
      }
      if (rec.userId === user.user_id) {
        usedToday += Number(rec.bytes || 0)
        if (rec.atMs < oldestAtMs) {
          oldestAtMs = rec.atMs
        }
      }
    }
    if (usedToday + resolvedLength > dailyUserLimitBytes) {
      const retryAfterSeconds = Number.isFinite(oldestAtMs)
        ? Math.max(1, Math.ceil((oldestAtMs + ONE_DAY_MS - nowMs) / 1000))
        : 86400
      return {
        ok: false,
        status: 429,
        errorCode: 'RATE_LIMITED',
        message: 'You have stored the photos allowed for today.',
        extra: {
          reason: 'DAILY_LIMIT',
          retry_after_seconds: retryAfterSeconds,
        },
      }
    }
  }

  return {
    ok: true,
    preflightOnly: true,
    resolvedLength,
    scopedKey,
    normalizedMime: canonicalMime,
  }
}

function computeByteDigest(byteArr) {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b1
  for (let i = 0; i < byteArr.byteLength; i += 1) {
    const b = byteArr[i]
    h1 ^= b
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= (b + (i & 0xff)) & 0xff
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return `${byteArr.byteLength}:${h1.toString(16)}:${h2.toString(16)}`
}

/**
 * Applies POST /api/v1/issues/{issue_id}/photos (#020, updated for #025).
 * Enforces permission, open status, uploadsDisabled simulation, idempotency
 * (including 409 UPLOAD_REMOVED for deleted or discarded uploads and 409 IDEMPOTENCY_KEY_REUSED for key collisions),
 * 3-photo cap, Content-Length / 4 MB cap, quota / pending deletions, 24h per-user daily limit,
 * JPEG Content-Type & magic bytes, valid SOF dimensions, and 2560 px hard edge cap.
 * @param {Object} opts
 * @param {any} opts.issue
 * @param {any} opts.user
 * @param {any} opts.bytes
 * @param {string} [opts.contentType]
 * @param {number | null | undefined} [opts.contentLength]
 * @param {string} [opts.idempotencyKey]
 * @param {Map<string, any> | null} [opts.idempotencyStore]
 * @param {Array<{ userId: string, bytes: number, atMs: number }> | null} [opts.dailyUploadsStore]
 * @param {number} [opts.dailyUserLimitBytes]
 * @param {number} [opts.nowMs]
 * @param {boolean} [opts.uploadsDisabled]
 * @param {'QUOTA' | 'DELETIONS_PENDING' | ''} [opts.quotaExceededReason]
 * @param {boolean} [opts.lowDisk]
 * @param {{ photosUsedBytes?: number, photosLimitBytes?: number, pendingDeletionBytes?: number, quotaBytes?: number } | null} [opts.storageStats]
 * @returns {any}
 */
export function addIssuePhotoInStore({
  issue,
  user,
  bytes,
  contentType = 'image/jpeg',
  contentLength = undefined,
  idempotencyKey = '',
  idempotencyStore = null,
  dailyUploadsStore = null,
  dailyUserLimitBytes = FILES_USER_BYTES_PER_DAY,
  nowMs = Date.now(),
  uploadsDisabled = false,
  quotaExceededReason = '',
  lowDisk = false,
  storageStats = null,
}) {
  const byteArr =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(0)

  const preflight = checkIssuePhotoUploadPreflight({
    issue,
    user,
    contentType,
    contentLength,
    idempotencyKey,
    idempotencyStore,
    dailyUploadsStore,
    dailyUserLimitBytes,
    nowMs,
    uploadsDisabled,
    quotaExceededReason,
    lowDisk,
    storageStats,
    byteLengthFallback: byteArr.byteLength,
  })
  if (!preflight.ok) {
    return preflight
  }
  if (preflight.replay) {
    if (
      byteArr.byteLength > 0 &&
      preflight.idempotencyDigest &&
      computeByteDigest(byteArr) !== preflight.idempotencyDigest
    ) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another file.',
      }
    }
    return preflight
  }

  const { resolvedLength, scopedKey, normalizedMime } = preflight
  if (!Array.isArray(issue.photos)) {
    issue.photos = []
  }
  if (byteArr.byteLength > MAX_ISSUE_PHOTO_BYTES || byteArr.byteLength > resolvedLength) {
    return {
      ok: false,
      status: 413,
      errorCode: 'FILE_TOO_LARGE',
      message: 'Photo exceeds the 4 MB limit.',
      extra: { max_bytes: MAX_ISSUE_PHOTO_BYTES },
    }
  }
  if (byteArr.byteLength < resolvedLength) {
    return {
      ok: false,
      status: 400,
      errorCode: 'UPLOAD_INTERRUPTED',
      message: 'Upload interrupted; please retry.',
    }
  }

  if (byteArr.byteLength < 4 || byteArr[0] !== 0xff || byteArr[1] !== 0xd8) {
    return {
      ok: false,
      status: 415,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Uploaded bytes are not a JPEG image.',
    }
  }

  const dims = parseJpegDimensions(byteArr)
  if (!dims || dims.width < 1 || dims.height < 1) {
    return {
      ok: false,
      status: 422,
      errorCode: 'INVALID_IMAGE',
      message: 'This photo cannot be used.',
    }
  }

  if (dims.width > HARD_PHOTO_MAX_EDGE || dims.height > HARD_PHOTO_MAX_EDGE) {
    return {
      ok: false,
      status: 422,
      errorCode: 'IMAGE_TOO_LARGE',
      message: 'Image exceeds 2560 px limit.',
      extra: { max_edge_px: HARD_PHOTO_MAX_EDGE },
    }
  }

  const displayDims = toDisplayDimensions(dims.width, dims.height)
  const photoId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `018f0000-0000-7000-9000-${Math.floor(100000000000 + Math.random() * 899999999999)}`

  const newPhoto = {
    id: photoId,
    width: displayDims.width,
    height: displayDims.height,
    created_at: new Date(nowMs).toISOString(),
    uploader_user_id: user.user_id,
    bytes: byteArr,
    mime: 'image/jpeg',
    size_bytes: byteArr.byteLength,
  }

  issue.photos.push(newPhoto)
  if (Array.isArray(dailyUploadsStore)) {
    dailyUploadsStore.push({
      userId: user.user_id,
      bytes: byteArr.byteLength,
      atMs: nowMs,
    })
  }
  if (scopedKey && idempotencyStore instanceof Map) {
    idempotencyStore.set(scopedKey, {
      issueId: issue.id,
      photoId,
      deletedByUser: false,
      contentLength: resolvedLength,
      contentType: normalizedMime,
      contentDigest: computeByteDigest(byteArr),
    })
  }

  return {
    ok: true,
    status: 201,
    photo: toIssuePhotoView(newPhoto, issue, user),
    issue: toIssueView(issue, user, { uploadsDisabled }),
  }
}

/**
 * Resolves GET /api/v1/issues/{issue_id}/photos/{photo_id}?variant=display|thumb (#020).
 */
export function getIssuePhotoFromStore({ issue, photoId, variant = 'display' }) {
  const normalizedVariant = variant === 'thumb' ? 'thumb' : 'display'
  const photo = (issue?.photos || []).find((p) => p.id === photoId)
  if (!photo) {
    return {
      ok: false,
      status: 404,
      errorCode: 'PHOTO_NOT_FOUND',
      message: 'Photo not found.',
    }
  }
  return {
    ok: true,
    variant: normalizedVariant,
    bytes: photo.bytes || DEFAULT_SAMPLE_WEBP_BYTES,
    mime: photo.mime || 'image/webp',
    photo,
  }
}

/**
 * Applies DELETE /api/v1/issues/{issue_id}/photos/{photo_id} (#020).
 * @param {Object} opts
 * @param {any} opts.issue
 * @param {any} opts.user
 * @param {string} opts.photoId
 * @param {Map<string, any> | null} [opts.idempotencyStore]
 */
export function deleteIssuePhotoInStore({ issue, user, photoId, idempotencyStore = null }) {
  const photos = Array.isArray(issue?.photos) ? issue.photos : []
  const idx = photos.findIndex((p) => p.id === photoId)
  if (idx === -1) {
    return {
      ok: false,
      status: 404,
      errorCode: 'PHOTO_NOT_FOUND',
      message: 'Photo not found.',
    }
  }

  const photo = photos[idx]
  const isBoard = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
  const isMineOpen = photo.uploader_user_id === user?.user_id && isIssueOpen(issue.status)
  if (!(isBoard || isMineOpen)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'You cannot delete this photo.',
    }
  }

  photos.splice(idx, 1)
  if (idempotencyStore instanceof Map) {
    for (const entry of idempotencyStore.values()) {
      if (entry.photoId === photoId) {
        entry.deletedByUser = true
      }
    }
  }

  return { ok: true, status: 204 }
}

