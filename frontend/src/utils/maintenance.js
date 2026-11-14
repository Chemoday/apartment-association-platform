/**
 * Pure domain utilities and mock engine for #015 Maintenance Calendar (E10/M1).
 * Calendar date arithmetic, recurrence rules, occurrence calculations, and validation.
 */

export const PERIOD_UNITS = ['DAY', 'MONTH', 'YEAR']
export const TASK_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED']
export const OCCURRENCE_STATES = ['UPCOMING', 'DUE', 'OVERDUE', 'PAUSED']

export const POST_CATEGORIES = [
  'GENERAL',
  'WATER_SHUTOFF',
  'MAINTENANCE',
  'MARKETPLACE',
]

/**
 * Returns today's date formatted as YYYY-MM-DD in Europe/Tallinn.
 * @param {Date} [now]
 * @returns {string}
 */
export function getTodayDateInTallinn(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Tallinn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const d = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

/**
 * Validates whether a string is a valid calendar date YYYY-MM-DD.
 * @param {string} dateStr
 * @returns {boolean}
 */
export function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string') return false
  const match = dateStr.trim().match(/^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/)
  if (!match) return false
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Returns the number of days in month `m` (1-12) of year `y`.
 * @param {number} y
 * @param {number} m
 * @returns {number}
 */
export function getDaysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Parses YYYY-MM-DD to [year, month, day] numbers.
 * @param {string} dateStr
 * @returns {[number, number, number]}
 */
export function parseDateParts(dateStr) {
  const [y, m, d] = dateStr.trim().split('-').map(Number)
  return [y, m, d]
}

/**
 * Formats [year, month, day] to YYYY-MM-DD.
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @returns {string}
 */
export function formatDateParts(y, m, d) {
  const ys = String(y).padStart(4, '0')
  const ms = String(m).padStart(2, '0')
  const ds = String(d).padStart(2, '0')
  return `${ys}-${ms}-${ds}`
}

/**
 * Adds or subtracts days to a calendar date YYYY-MM-DD.
 * @param {string} dateStr
 * @param {number} days
 * @returns {string}
 */
export function addDays(dateStr, days) {
  const [y, m, d] = parseDateParts(dateStr)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return formatDateParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/**
 * Computes difference in calendar days: (dateB - dateA).
 * Positive if dateB is after dateA.
 * @param {string} dateA
 * @param {string} dateB
 * @returns {number}
 */
export function diffDays(dateA, dateB) {
  const [y1, m1, d1] = parseDateParts(dateA)
  const [y2, m2, d2] = parseDateParts(dateB)
  const ms1 = Date.UTC(y1, m1 - 1, d1)
  const ms2 = Date.UTC(y2, m2 - 1, d2)
  return Math.round((ms2 - ms1) / 86400000)
}

/**
 * Computes the maximum allowed lead_days for a given period:
 * - DAY: period_count - 1 (or 0 if count <= 1; but DAY count is 7..3650, capped at 90)
 * - MONTH: 28 * count (capped at 90)
 * - YEAR: 365 * count (capped at 90)
 * Overall range is 0..90 and strictly shorter than period.
 * @param {string} unit
 * @param {number} count
 * @returns {number}
 */
export function maxAllowedLeadDays(unit, count) {
  const c = Number(count) || 0
  let periodSpanDays = 0
  if (unit === 'DAY') periodSpanDays = c
  else if (unit === 'MONTH') periodSpanDays = 28 * c
  else if (unit === 'YEAR') periodSpanDays = 365 * c
  return Math.min(90, Math.max(0, periodSpanDays - 1))
}

/**
 * Computes next occurrence date from an anchorDate, keeping the day-of-month rhythm.
 * E.g.:
 * - DAY: anchor + period_count days
 * - MONTH: from anchor (y, m, dAnchor) + period_count months, day clamped to max days in target month.
 * - YEAR: from anchor (y, mAnchor, dAnchor) + period_count years, clamped (e.g. leap year 29 Feb -> 28 Feb).
 * @param {string} anchorDate - Anchor date (YYYY-MM-DD)
 * @param {string} unit - 'DAY' | 'MONTH' | 'YEAR'
 * @param {number} count - period count
 * @returns {string}
 */
export function computeNextRecurrenceDate(anchorDate, unit, count) {
  const [y, m, d] = parseDateParts(anchorDate)
  const c = Number(count) || 1

  if (unit === 'DAY') {
    return addDays(anchorDate, c)
  }

  if (unit === 'MONTH') {
    const totalMonths = (y * 12 + (m - 1)) + c
    const nextY = Math.floor(totalMonths / 12)
    const nextM = (totalMonths % 12) + 1
    const maxDays = getDaysInMonth(nextY, nextM)
    const nextD = Math.min(d, maxDays)
    return formatDateParts(nextY, nextM, nextD)
  }

  if (unit === 'YEAR') {
    const nextY = y + c
    const maxDays = getDaysInMonth(nextY, m)
    const nextD = Math.min(d, maxDays)
    return formatDateParts(nextY, m, nextD)
  }

  return anchorDate
}

/**
 * Computes occurrence state:
 * - If task status is PAUSED -> 'PAUSED'
 * - If today < publish_on -> 'UPCOMING'
 * - If today >= publish_on && today <= due_date -> 'DUE'
 * - If today > due_date -> 'OVERDUE'
 * @param {string} dueDate - YYYY-MM-DD
 * @param {number} leadDays - integer
 * @param {string} taskStatus - 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
 * @param {string} [today] - YYYY-MM-DD in Europe/Tallinn
 * @returns {{ state: string, publish_on: string }}
 */
export function computeOccurrenceState(dueDate, leadDays, taskStatus, today = getTodayDateInTallinn()) {
  const publishOn = addDays(dueDate, -leadDays)
  if (taskStatus === 'PAUSED') {
    return { state: 'PAUSED', publish_on: publishOn }
  }
  if (today < publishOn) {
    return { state: 'UPCOMING', publish_on: publishOn }
  }
  if (today <= dueDate) {
    return { state: 'DUE', publish_on: publishOn }
  }
  return { state: 'OVERDUE', publish_on: publishOn }
}

/**
 * Validates task create / edit draft constraints client-side.
 * Returns { valid: boolean, errors: Record<string, string>, payload?: any }
 * @param {any} draft
 * @param {Object} [options]
 * @param {boolean} [options.isEdit]
 * @param {string} [options.today]
 * @returns {{ valid: boolean, errors: Record<string, string>, payload?: any }}
 */
export function validateTaskDraft(draft, options = {}) {
  const errors = {}
  const isEdit = Boolean(options.isEdit)
  const today = options.today || getTodayDateInTallinn()

  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  if (!title) {
    errors.title = 'REQUIRED'
  } else if (title.length > 255) {
    errors.title = 'TOO_LONG'
  }

  const instructions = typeof draft.instructions === 'string' ? draft.instructions.trim() : ''
  if (instructions.length > 4000) {
    errors.instructions = 'TOO_LONG'
  }

  const unit = draft.period_unit
  if (!PERIOD_UNITS.includes(unit)) {
    errors.period_unit = 'INVALID_UNIT'
  }

  const count = Number(draft.period_count)
  if (!Number.isInteger(count)) {
    errors.period_count = 'INVALID_COUNT'
  } else {
    if (unit === 'DAY' && (count < 7 || count > 3650)) errors.period_count = 'OUT_OF_RANGE'
    if (unit === 'MONTH' && (count < 1 || count > 120)) errors.period_count = 'OUT_OF_RANGE'
    if (unit === 'YEAR' && (count < 1 || count > 10)) errors.period_count = 'OUT_OF_RANGE'
  }

  const maxLead = maxAllowedLeadDays(unit, count)
  const leadDays = Number(draft.lead_days)
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > maxLead) {
    errors.lead_days = 'OUT_OF_RANGE'
  }

  const dueDateKey = isEdit ? 'next_due_date' : 'first_due_date'
  const dueDateVal = draft[dueDateKey]
  if (!dueDateVal || !isValidCalendarDate(dueDateVal)) {
    errors[dueDateKey] = 'INVALID_DATE'
  } else {
    const daysFromToday = diffDays(today, dueDateVal)
    // first_due_date / next_due_date: at most 366 days in the past and at most 10 years (3660 days) ahead
    if (daysFromToday < -366 || daysFromToday > 3660) {
      errors[dueDateKey] = 'OUT_OF_RANGE'
    }
  }

  let cleanNotice = null
  if (draft.has_notice || draft.notice) {
    const n = draft.notice || {}
    const nTitle = typeof n.title === 'string' ? n.title.trim() : ''
    const nBody = typeof n.body === 'string' ? n.body.trim() : ''
    const nCategory = POST_CATEGORIES.includes(n.category) ? n.category : 'MAINTENANCE'
    const targetScope = ['ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST'].includes(n.target_scope)
      ? n.target_scope
      : 'ALL_BUILDING'

    if (!nTitle) {
      errors.notice_title = 'REQUIRED'
    } else if (nTitle.length > 255) {
      errors.notice_title = 'TOO_LONG'
    }

    if (!nBody) {
      errors.notice_body = 'REQUIRED'
    } else if (nBody.length > 9500) {
      errors.notice_body = 'TOO_LONG'
    }

    let targetEntrance = null
    let targetApartmentIds = null

    if (targetScope === 'ENTRANCE') {
      const ent = Number(n.target_entrance)
      if (!Number.isInteger(ent) || ent < 1) {
        errors.notice_target = 'INVALID_ENTRANCE'
      } else {
        targetEntrance = ent
      }
    } else if (targetScope === 'APARTMENT_LIST') {
      const aptIds = Array.isArray(n.target_apartment_ids)
        ? Array.from(new Set(n.target_apartment_ids.filter(Boolean)))
        : []
      if (aptIds.length < 1 || aptIds.length > 500) {
        errors.notice_target = 'INVALID_APARTMENT_LIST'
      } else {
        targetApartmentIds = aptIds
      }
    }

    cleanNotice = {
      title: nTitle,
      body: nBody,
      category: nCategory,
      target_scope: targetScope,
      target_entrance: targetEntrance,
      target_apartment_ids: targetApartmentIds,
      comments_enabled: Boolean(n.comments_enabled),
    }
  }

  const valid = Object.keys(errors).length === 0
  if (!valid) {
    return { valid: false, errors }
  }

  const payload = {
    title,
    instructions: instructions || '',
    period_unit: unit,
    period_count: count,
    lead_days: leadDays,
    notice: cleanNotice,
  }

  if (isEdit) {
    payload.next_due_date = dueDateVal
    if (draft.occurrence_id) {
      payload.occurrence_id = draft.occurrence_id
    }
  } else {
    payload.first_due_date = dueDateVal
  }

  return { valid: true, errors: {}, payload }
}

/**
 * Creates the initial seed for maintenance tasks in offline demo & Vite dev server.
 * Seeds 4 realistic tasks:
 * 1. OVERDUE task
 * 2. DUE task
 * 3. UPCOMING task
 * 4. PAUSED task
 * @param {string} [today] - YYYY-MM-DD
 * @returns {Array<import('../api/schema').TaskView>}
 */
export function createDefaultMaintenanceSeed(today = getTodayDateInTallinn()) {
  const overdueDue = addDays(today, -5)
  const dueDue = addDays(today, 3)
  const upcomingDue = addDays(today, 25)
  const pausedDue = addDays(today, 40)

  return [
    {
      id: 'task-fire-extinguishers',
      title: 'Inspect fire extinguishers',
      instructions: 'Basement, technical rooms, and all 4 landings in both entrances. Certified technician needed.',
      period_unit: 'YEAR',
      period_count: 1,
      lead_days: 14,
      anchor_date: overdueDue,
      status: 'ACTIVE',
      notice: {
        title: 'Annual Fire Extinguisher Inspection',
        body: 'Inspector will check all stairwell and common area fire safety equipment. No access to individual flats needed.',
        category: 'MAINTENANCE',
        target_scope: 'ALL_BUILDING',
        target_entrance: null,
        target_apartment_ids: null,
        comments_enabled: false,
      },
      current: {
        occurrence_id: 'occ-extinguishers-2026',
        due_date: overdueDue,
        publish_on: addDays(overdueDue, -14),
        state: 'OVERDUE',
        published_at: '2026-10-25T09:00:00Z',
        board_post_id: '018f0000-0000-7000-8000-000000000763',
        notice_post_id: '018f0000-0000-7000-8000-000000000604',
        notice_failed: false,
        reminder_count: 1,
      },
      last_closed_on: addDays(today, -365),
      created_at: '2025-11-04T10:00:00Z',
      updated_at: '2026-10-25T09:00:00Z',
      archived_at: null,
    },
    {
      id: 'task-heating-substation',
      title: 'Quarterly heating substation pressure & leak check',
      instructions: 'Calibrate circulation pump pressure and check heat exchanger filters with Utilitas technician.',
      period_unit: 'MONTH',
      period_count: 3,
      lead_days: 7,
      anchor_date: dueDue,
      status: 'ACTIVE',
      notice: {
        title: 'Heating Substation Periodic Maintenance',
        body: 'Routine quarterly check of the basement heating substation. Central heating may fluctuate slightly for 1 hour.',
        category: 'MAINTENANCE',
        target_scope: 'ALL_BUILDING',
        target_entrance: null,
        target_apartment_ids: null,
        comments_enabled: false,
      },
      current: {
        occurrence_id: 'occ-heating-2026-q4',
        due_date: dueDue,
        publish_on: addDays(dueDue, -7),
        state: 'DUE',
        published_at: '2026-11-05T09:00:00Z',
        board_post_id: null,
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 0,
      },
      last_closed_on: addDays(today, -88),
      created_at: '2026-08-10T12:00:00Z',
      updated_at: '2026-11-05T09:00:00Z',
      archived_at: null,
    },
    {
      id: 'task-gutters-cleaning',
      title: 'Clean roof gutters and downspouts',
      instructions: 'Contractor cherry picker crane arriving at courtyard. Move courtyard cars if requested.',
      period_unit: 'MONTH',
      period_count: 6,
      lead_days: 10,
      anchor_date: upcomingDue,
      status: 'ACTIVE',
      notice: {
        title: 'Roof and Downspout Cleaning Scheduled',
        body: 'Autumn leaf removal from roof gutters and drains. Work conducted on exterior roof.',
        category: 'MAINTENANCE',
        target_scope: 'ALL_BUILDING',
        target_entrance: null,
        target_apartment_ids: null,
        comments_enabled: false,
      },
      current: {
        occurrence_id: 'occ-gutters-2026',
        due_date: upcomingDue,
        publish_on: addDays(upcomingDue, -10),
        state: 'UPCOMING',
        published_at: null,
        board_post_id: null,
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 0,
      },
      last_closed_on: addDays(today, -175),
      created_at: '2026-05-15T08:00:00Z',
      updated_at: '2026-05-15T08:00:00Z',
      archived_at: null,
    },
    {
      id: 'task-staircase-window-paint',
      title: 'Repaint wooden frames of second entrance landings',
      instructions: 'Awaiting carpenter quote. Postponed until spring temperature rises above 10°C.',
      period_unit: 'YEAR',
      period_count: 2,
      lead_days: 14,
      anchor_date: pausedDue,
      status: 'PAUSED',
      notice: null,
      current: {
        occurrence_id: 'occ-paint-paused',
        due_date: pausedDue,
        publish_on: addDays(pausedDue, -14),
        state: 'PAUSED',
        published_at: null,
        board_post_id: null,
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 0,
      },
      last_closed_on: null,
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-10-01T10:00:00Z',
      archived_at: null,
    },
    {
      id: 'task-attic-ventilation',
      title: 'Inspect attic ventilation flap seals',
      instructions: 'Check isolation flap seals on the exhaust shafts above Entrance 1.',
      period_unit: 'YEAR',
      period_count: 1,
      lead_days: 7,
      anchor_date: dueDue,
      status: 'ACTIVE',
      notice: {
        title: 'Attic Ventilation Inspection',
        body: 'Technicians will inspect roof duct seals above Entrance 1.',
        category: 'MAINTENANCE',
        target_scope: 'ENTRANCE',
        target_entrance: 1,
        target_apartment_ids: null,
        comments_enabled: false,
      },
      current: {
        occurrence_id: 'occ-vent-2026',
        due_date: dueDue,
        publish_on: addDays(dueDue, -7),
        state: 'DUE',
        published_at: '2026-11-06T09:00:00Z',
        board_post_id: '018f0000-0000-7000-8000-000000000765',
        notice_post_id: null,
        notice_failed: true,
        reminder_count: 0,
      },
      last_closed_on: null,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-11-06T09:00:00Z',
      archived_at: null,
    },
  ]
}

/**
 * Returns a cloned TaskView with dynamically updated current.state based on current date.
 * @param {import('../api/schema').TaskView} task
 * @param {string} [today]
 * @returns {import('../api/schema').TaskView}
 */
export function toTaskView(task, today = getTodayDateInTallinn()) {
  const cloned = JSON.parse(JSON.stringify(task))
  if (cloned.status === 'ARCHIVED') {
    cloned.current = null
    return cloned
  }

  if (cloned.current) {
    const { state, publish_on } = computeOccurrenceState(
      cloned.current.due_date,
      cloned.lead_days,
      cloned.status,
      today,
    )
    cloned.current.state = state
    cloned.current.publish_on = publish_on
  }

  return cloned
}

/**
 * Filters and queries the maintenance tasks store.
 * @param {Array<import('../api/schema').TaskView>} tasksStore
 * @param {Object} [params]
 * @param {string} [params.status]
 * @param {string} [params.state]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {string} [today]
 * @returns {Array<import('../api/schema').TaskView>}
 */
export function queryTasksStore(tasksStore, params = {}, today = getTodayDateInTallinn()) {
  const statusFilter = params.status
  const stateFilter = params.state
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 50))
  const offset = Math.max(0, Number(params.offset) || 0)

  let list = tasksStore.map((t) => toTaskView(t, today))

  if (statusFilter === 'ARCHIVED') {
    list = list.filter((t) => t.status === 'ARCHIVED')
    list.sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')))
  } else if (statusFilter) {
    list = list.filter((t) => t.status === statusFilter)
    list.sort((a, b) => String(a.current?.due_date || '').localeCompare(String(b.current?.due_date || '')))
  } else {
    // Without status: active and paused tasks, ordered by current due date
    list = list.filter((t) => t.status === 'ACTIVE' || t.status === 'PAUSED')
    list.sort((a, b) => String(a.current?.due_date || '').localeCompare(String(b.current?.due_date || '')))
  }

  if (stateFilter) {
    list = list.filter((t) => t.current?.state === stateFilter)
  }

  return list.slice(offset, offset + limit)
}

// ============================================================================
// #016 [E10/M1] Money / Cost Decimal String Helpers (zero Number / parseFloat)
// ============================================================================

const COST_VALUE = /^[0-9]{1,9}(\.[0-9]{1,2})?$/

/**
 * Normalizes a user-entered cost string into canonical decimal string (using dot),
 * `null` when empty/omitted, or `undefined` when invalid (e.g. negative, letters, 3 decimals).
 * Never uses Number or parseFloat.
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function normalizeCostInput(text) {
  if (text === null || text === undefined) return null
  if (typeof text !== 'string') return undefined
  const cleaned = text.trim().replace(/\s+/g, '').replace(',', '.')
  if (cleaned === '') return null
  return COST_VALUE.test(cleaned) ? cleaned : undefined
}

/**
 * Checks whether a cost input string is valid (either empty/null or a non-negative decimal with <= 2 decimals).
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isValidCostInput(text) {
  return normalizeCostInput(text) !== undefined
}

/**
 * Converts a valid decimal cost string (up to 2 decimal places) to scaled BigInt cents (× 100n).
 * Never uses Number or parseFloat.
 * @param {string | null | undefined} costStr
 * @returns {bigint | null}
 */
export function toScaledCents(costStr) {
  const normalized = normalizeCostInput(costStr)
  if (!normalized) return null
  const [intPart, fracPart = ''] = normalized.split('.')
  const paddedFrac = (fracPart + '00').slice(0, 2)
  return BigInt(intPart) * 100n + BigInt(paddedFrac)
}

/**
 * Formats scaled BigInt cents (× 100n) into canonical 2-decimal string ("145.50").
 * @param {bigint | null | undefined} cents
 * @returns {string}
 */
export function fromScaledCents(cents) {
  if (cents === null || cents === undefined) return '0.00'
  const isNegative = cents < 0n
  const abs = isNegative ? -cents : cents
  const intPart = (abs / 100n).toString()
  const fracPart = (abs % 100n).toString().padStart(2, '0')
  return `${isNegative ? '-' : ''}${intPart}.${fracPart}`
}

/**
 * Formats a valid cost string into canonical 2-decimal string ("145" -> "145.00", "145,5" -> "145.50").
 * Returns null if empty or invalid.
 * @param {string | null | undefined} costStr
 * @returns {string | null}
 */
export function toTwoDecimals(costStr) {
  const cents = toScaledCents(costStr)
  if (cents === null) return null
  return fromScaledCents(cents)
}

/**
 * Sums an array of cost decimal strings via scaled BigInt cents and returns a 2-decimal string.
 * Never uses Number or parseFloat.
 * @param {Array<string | null | undefined>} values
 * @returns {string}
 */
export function sumCosts(values) {
  let total = 0n
  if (Array.isArray(values)) {
    for (const val of values) {
      const cents = toScaledCents(val)
      if (cents !== null) {
        total += cents
      }
    }
  }
  return fromScaledCents(total)
}

/**
 * Formats a cost decimal string in the reader's language ("145,50" in et/ru, "145.50" in en).
 * Never uses Number or parseFloat.
 * @param {string | null | undefined} costStr
 * @param {string} [lang]
 * @returns {string}
 */
export function formatCost(costStr, lang = 'en') {
  const twoDec = toTwoDecimals(costStr)
  if (!twoDec) return ''
  if (lang === 'et' || lang === 'ru') {
    return twoDec.replace('.', ',')
  }
  return twoDec
}

// ============================================================================
// #016 [E10/M1] Schedule Advancement & Maintenance Log Store Operations
// ============================================================================

/**
 * Computes the k-th recurrence date from `anchorDate`, preserving the anchor's day-of-month
 * (clamping on shorter months or non-leap years).
 * @param {string} anchorDate - YYYY-MM-DD
 * @param {string} unit - 'DAY' | 'MONTH' | 'YEAR'
 * @param {number} count - period_count
 * @param {number} stepK - integer >= 0
 * @returns {string}
 */
export function computeNthRecurrenceDate(anchorDate, unit, count, stepK) {
  const k = Math.max(0, Math.trunc(Number(stepK) || 0))
  if (k === 0) return anchorDate
  const c = (Number(count) || 1) * k
  return computeNextRecurrenceDate(anchorDate, unit, c)
}

/**
 * Computes the next due date after closing an occurrence:
 * the first date on the schedule (counted from `anchorDate` in multiples of `period_count`)
 * that is strictly after BOTH `plannedDate` and `closedOn`.
 * @param {string} anchorDate - YYYY-MM-DD
 * @param {string} unit - 'DAY' | 'MONTH' | 'YEAR'
 * @param {number} count - period_count
 * @param {string} plannedDate - YYYY-MM-DD
 * @param {string} closedOn - YYYY-MM-DD
 * @returns {string}
 */
export function computeNextOccurrenceAfterClose(anchorDate, unit, count, plannedDate, closedOn) {
  const threshold = plannedDate >= closedOn ? plannedDate : closedOn
  for (let k = 1; k <= 10000; k += 1) {
    const candidate = computeNthRecurrenceDate(anchorDate, unit, count, k)
    if (candidate > threshold) {
      return candidate
    }
  }
  return computeNextRecurrenceDate(threshold, unit, count)
}

/**
 * Builds the board author badge for `recorded_by` / `updated_by` (full name + BOARD role badge).
 * @param {any} user
 * @returns {import('../api/schema').AuthorBadgeDTO}
 */
export function buildBoardAuthorBadge(user) {
  return {
    display_label: user?.full_name || user?.label || 'Board Member',
    role_badge: 'BOARD',
  }
}

/**
 * Creates the initial seed of maintenance log entries in offline demo & Vite dev server.
 * @param {string} [today] - YYYY-MM-DD
 * @returns {Array<import('../api/schema').LogEntryView>}
 */
export function createDefaultMaintenanceLogSeed(today = getTodayDateInTallinn()) {
  const dHeatingClosed = addDays(today, -88)
  const dHeatingPlanned = addDays(today, -90)
  const dGuttersClosed = addDays(today, -175)
  const dGuttersPlanned = addDays(today, -178)
  const dWindowSkip = addDays(today, -210)
  const dFireClosed = addDays(today, -365)

  return [
    {
      id: 'log-heating-2026-q3',
      task_id: 'task-heating-substation',
      task_title: 'Quarterly heating substation pressure & leak check',
      kind: 'DONE',
      planned_date: dHeatingPlanned,
      closed_on: dHeatingClosed,
      note: 'Circulation pump pressure calibrated to 1.8 bar; mud filter flushed and gasket replaced.',
      cost: '95.50',
      recorded_by: {
        display_label: 'Peeter Tamm',
        role_badge: 'BOARD',
      },
      recorded_at: `${dHeatingClosed}T14:20:00Z`,
      updated_at: `${dHeatingClosed}T14:20:00Z`,
      updated_by: null,
    },
    {
      id: 'log-gutters-spring',
      task_id: 'task-gutters-cleaning',
      task_title: 'Clean roof gutters and downspouts',
      kind: 'DONE',
      planned_date: dGuttersPlanned,
      closed_on: dGuttersClosed,
      note: 'Spring cleaning completed on both entrances; north downspout bracket tightened.',
      cost: '240.00',
      recorded_by: {
        display_label: 'Liina Vaher',
        role_badge: 'BOARD',
      },
      recorded_at: `${dGuttersClosed}T11:10:00Z`,
      updated_at: `${dGuttersClosed}T16:05:00Z`,
      updated_by: {
        display_label: 'Peeter Tamm',
        role_badge: 'BOARD',
      },
    },
    {
      id: 'log-window-paint-skip',
      task_id: 'task-staircase-window-paint',
      task_title: 'Repaint wooden frames of second entrance landings',
      kind: 'SKIPPED',
      planned_date: dWindowSkip,
      closed_on: dWindowSkip,
      note: 'Facade scaffolding blocked second entrance windows during brickwork repairs.',
      cost: null,
      recorded_by: {
        display_label: 'Liina Vaher',
        role_badge: 'BOARD',
      },
      recorded_at: `${dWindowSkip}T09:45:00Z`,
      updated_at: `${dWindowSkip}T09:45:00Z`,
      updated_by: null,
    },
    {
      id: 'log-extinguishers-prev',
      task_id: 'task-fire-extinguishers',
      task_title: 'Inspect fire extinguishers',
      kind: 'DONE',
      planned_date: dFireClosed,
      closed_on: dFireClosed,
      note: 'All 14 fire extinguishers inspected and tagged; 2 basement CO2 units refilled.',
      cost: '145.00',
      recorded_by: {
        display_label: 'Peeter Tamm',
        role_badge: 'BOARD',
      },
      recorded_at: `${dFireClosed}T15:00:00Z`,
      updated_at: `${dFireClosed}T15:00:00Z`,
      updated_by: null,
    },
  ]
}

/**
 * Validates and applies `POST /api/v1/maintenance/tasks/{task_id}/done` in store.
 * @param {Object} params
 * @param {Array<any>} params.tasksStore
 * @param {Array<any>} params.logStore
 * @param {string} params.taskId
 * @param {any} params.body
 * @param {any} params.user
 * @param {string} [params.today]
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, extra?: any, result?: import('../api/schema').ClosedOccurrence }}
 */
export function applyTaskDoneInStore({
  tasksStore,
  logStore,
  taskId,
  body,
  user,
  today = getTodayDateInTallinn(),
}) {
  if (!['CHAIRMAN', 'BOARD'].includes(user?.building_role)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the chairman and board members can mark maintenance tasks done.',
    }
  }

  const found = tasksStore.find((t) => t.id === taskId)
  if (!found) {
    return {
      ok: false,
      status: 404,
      errorCode: 'MAINTENANCE_TASK_NOT_FOUND',
      message: 'Maintenance task not found.',
    }
  }

  if (found.status === 'ARCHIVED' || !found.current) {
    return {
      ok: false,
      status: 409,
      errorCode: 'TASK_ARCHIVED',
      message: 'Task is archived.',
    }
  }

  const reqBody = body && typeof body === 'object' ? body : {}
  const occurrenceId = reqBody.occurrence_id
  if (!occurrenceId || typeof occurrenceId !== 'string') {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'occurrence_id is required.',
    }
  }

  if (occurrenceId !== found.current.occurrence_id) {
    return {
      ok: false,
      status: 409,
      errorCode: 'OCCURRENCE_CLOSED',
      message: 'This occurrence has already been closed.',
      extra: { current_occurrence_id: found.current.occurrence_id },
    }
  }

  const doneOn = reqBody.done_on
  if (!doneOn || !isValidCalendarDate(doneOn)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Valid done_on date is required.',
    }
  }

  const plannedDate = found.current.due_date
  // done_on: not in the future, at most 366 days before plannedDate, not before last_closed_on
  if (doneOn > today) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'done_on cannot be in the future.',
    }
  }

  const minAllowedFromPlanned = addDays(plannedDate, -366)
  if (doneOn < minAllowedFromPlanned) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'done_on cannot be more than 366 days before the planned due date.',
    }
  }

  if (found.last_closed_on && doneOn < found.last_closed_on) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'done_on cannot be earlier than last_closed_on.',
    }
  }

  const rawNote = reqBody.note === null || reqBody.note === undefined ? '' : reqBody.note
  if (typeof rawNote !== 'string' || rawNote.trim().length > 1000) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'note must be at most 1000 characters.',
    }
  }
  const cleanNote = rawNote.trim()

  const normalizedCost = normalizeCostInput(reqBody.cost)
  if (normalizedCost === undefined) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'cost must be a valid non-negative decimal string with up to 2 decimal places.',
    }
  }
  const canonicalCost = normalizedCost !== null ? toTwoDecimals(normalizedCost) : null

  const nowIso = new Date().toISOString()
  const entry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task_id: found.id,
    task_title: found.title,
    kind: 'DONE',
    planned_date: plannedDate,
    closed_on: doneOn,
    note: cleanNote,
    cost: canonicalCost,
    recorded_by: buildBoardAuthorBadge(user),
    recorded_at: nowIso,
    updated_at: nowIso,
    updated_by: null,
  }

  logStore.unshift(entry)

  const nextDueDate = computeNextOccurrenceAfterClose(
    found.anchor_date,
    found.period_unit,
    found.period_count,
    plannedDate,
    doneOn,
  )
  const nextOccState = computeOccurrenceState(nextDueDate, found.lead_days, found.status, today)

  found.last_closed_on = doneOn
  found.current = {
    occurrence_id: `occ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    due_date: nextDueDate,
    publish_on: nextOccState.publish_on,
    state: nextOccState.state,
    published_at: null,
    board_post_id: null,
    notice_post_id: null,
    notice_failed: false,
    reminder_count: 0,
  }
  found.updated_at = nowIso

  return {
    ok: true,
    result: {
      entry: JSON.parse(JSON.stringify(entry)),
      task: toTaskView(found, today),
    },
  }
}

/**
 * Validates and applies `POST /api/v1/maintenance/tasks/{task_id}/skip` in store.
 * @param {Object} params
 * @param {Array<any>} params.tasksStore
 * @param {Array<any>} params.logStore
 * @param {string} params.taskId
 * @param {any} params.body
 * @param {any} params.user
 * @param {string} [params.today]
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, extra?: any, result?: import('../api/schema').ClosedOccurrence }}
 */
export function applyTaskSkipInStore({
  tasksStore,
  logStore,
  taskId,
  body,
  user,
  today = getTodayDateInTallinn(),
}) {
  if (!['CHAIRMAN', 'BOARD'].includes(user?.building_role)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the chairman and board members can skip maintenance tasks.',
    }
  }

  const found = tasksStore.find((t) => t.id === taskId)
  if (!found) {
    return {
      ok: false,
      status: 404,
      errorCode: 'MAINTENANCE_TASK_NOT_FOUND',
      message: 'Maintenance task not found.',
    }
  }

  if (found.status === 'ARCHIVED' || !found.current) {
    return {
      ok: false,
      status: 409,
      errorCode: 'TASK_ARCHIVED',
      message: 'Task is archived.',
    }
  }

  const reqBody = body && typeof body === 'object' ? body : {}
  const occurrenceId = reqBody.occurrence_id
  if (!occurrenceId || typeof occurrenceId !== 'string') {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'occurrence_id is required.',
    }
  }

  if (occurrenceId !== found.current.occurrence_id) {
    return {
      ok: false,
      status: 409,
      errorCode: 'OCCURRENCE_CLOSED',
      message: 'This occurrence has already been closed.',
      extra: { current_occurrence_id: found.current.occurrence_id },
    }
  }

  const cleanNote = typeof reqBody.note === 'string' ? reqBody.note.trim() : ''
  if (cleanNote.length < 1 || cleanNote.length > 1000) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'A note (1..1000 characters) is required when skipping an occurrence.',
    }
  }

  const plannedDate = found.current.due_date
  const nowIso = new Date().toISOString()

  const entry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task_id: found.id,
    task_title: found.title,
    kind: 'SKIPPED',
    planned_date: plannedDate,
    closed_on: today,
    note: cleanNote,
    cost: null,
    recorded_by: buildBoardAuthorBadge(user),
    recorded_at: nowIso,
    updated_at: nowIso,
    updated_by: null,
  }

  logStore.unshift(entry)

  const nextDueDate = computeNextOccurrenceAfterClose(
    found.anchor_date,
    found.period_unit,
    found.period_count,
    plannedDate,
    today,
  )
  const nextOccState = computeOccurrenceState(nextDueDate, found.lead_days, found.status, today)

  found.last_closed_on = today
  found.current = {
    occurrence_id: `occ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    due_date: nextDueDate,
    publish_on: nextOccState.publish_on,
    state: nextOccState.state,
    published_at: null,
    board_post_id: null,
    notice_post_id: null,
    notice_failed: false,
    reminder_count: 0,
  }
  found.updated_at = nowIso

  return {
    ok: true,
    result: {
      entry: JSON.parse(JSON.stringify(entry)),
      task: toTaskView(found, today),
    },
  }
}

/**
 * Queries `GET /api/v1/maintenance/log` with filters and ordering (newest `closed_on` first).
 * @param {Array<import('../api/schema').LogEntryView>} logStore
 * @param {Object} [params]
 * @param {string | null} [params.task_id]
 * @param {string | null} [params.from]
 * @param {string | null} [params.to]
 * @param {number | string | null} [params.limit]
 * @param {number | string | null} [params.offset]
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, items?: Array<import('../api/schema').LogEntryView> }}
 */
export function queryMaintenanceLogStore(logStore, params = {}) {
  const taskId = params.task_id ? String(params.task_id).trim() : ''
  const fromDate = params.from ? String(params.from).trim() : ''
  const toDate = params.to ? String(params.to).trim() : ''

  if (fromDate && !isValidCalendarDate(fromDate)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid from date.',
    }
  }

  if (toDate && !isValidCalendarDate(toDate)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invalid to date.',
    }
  }

  const limit = Math.min(100, Math.max(1, Number(params.limit) || 50))
  const offset = Math.max(0, Number(params.offset) || 0)

  let list = logStore.map((item) => JSON.parse(JSON.stringify(item)))

  if (taskId) {
    list = list.filter((item) => item.task_id === taskId)
  }

  if (fromDate) {
    list = list.filter((item) => item.closed_on >= fromDate)
  }

  if (toDate) {
    list = list.filter((item) => item.closed_on <= toDate)
  }

  list.sort((a, b) => {
    const cmp = String(b.closed_on || '').localeCompare(String(a.closed_on || ''))
    if (cmp !== 0) return cmp
    return String(b.recorded_at || '').localeCompare(String(a.recorded_at || ''))
  })

  return {
    ok: true,
    items: list.slice(offset, offset + limit),
  }
}

/**
 * Validates and applies `PATCH /api/v1/maintenance/log/{entry_id}` in store.
 * @param {Object} params
 * @param {Array<any>} params.logStore
 * @param {string} params.entryId
 * @param {any} params.body
 * @param {any} params.user
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, entry?: import('../api/schema').LogEntryView }}
 */
export function applyLogEditInStore({ logStore, entryId, body, user }) {
  if (!['CHAIRMAN', 'BOARD'].includes(user?.building_role)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the chairman and board members can edit maintenance log entries.',
    }
  }

  const found = logStore.find((item) => item.id === entryId)
  if (!found) {
    return {
      ok: false,
      status: 404,
      errorCode: 'LOG_ENTRY_NOT_FOUND',
      message: 'Maintenance log entry not found.',
    }
  }

  const reqBody = body && typeof body === 'object' ? body : {}

  // Reject unknown fields (such as closed_on)
  const allowedKeys = new Set(['note', 'cost'])
  for (const key of Object.keys(reqBody)) {
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Field '${key}' cannot be modified on a log entry.`,
      }
    }
  }

  let changed = false

  if ('cost' in reqBody) {
    if (found.kind === 'SKIPPED' && reqBody.cost !== null && reqBody.cost !== '') {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Cost cannot be set on a skipped maintenance entry.',
      }
    }

    if (found.kind === 'DONE') {
      const normalizedCost = normalizeCostInput(reqBody.cost)
      if (normalizedCost === undefined) {
        return {
          ok: false,
          status: 422,
          errorCode: 'VALIDATION_ERROR',
          message: 'cost must be a valid non-negative decimal string with up to 2 decimal places.',
        }
      }
      const nextCost = normalizedCost !== null ? toTwoDecimals(normalizedCost) : null
      if (nextCost !== found.cost) {
        found.cost = nextCost
        changed = true
      }
    }
  }

  if ('note' in reqBody) {
    const rawNote = reqBody.note === null || reqBody.note === undefined ? '' : reqBody.note
    if (typeof rawNote !== 'string' || rawNote.trim().length > 1000) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'note must be at most 1000 characters.',
      }
    }
    const cleanNote = rawNote.trim()
    if (found.kind === 'SKIPPED' && cleanNote.length < 1) {
      return {
        ok: false,
        status: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Skipped entry note cannot be empty.',
      }
    }
    if (cleanNote !== found.note) {
      found.note = cleanNote
      changed = true
    }
  }

  if (changed) {
    found.updated_by = buildBoardAuthorBadge(user)
    found.updated_at = new Date().toISOString()
  }

  return {
    ok: true,
    entry: JSON.parse(JSON.stringify(found)),
  }
}

/**
 * Automatically publishes board topics and resident notices for tasks that reached publish_on,
 * and posts overdue reminder comments for tasks past due date (#017, Task M2).
 * @param {Object} params
 * @param {Array<any>} params.tasksStore
 * @param {Array<any>} params.postsStore
 * @param {string} [params.today]
 * @param {number} [params.overdueReminderDays]
 * @param {string} [params.authorUserId]
 * @param {Object} [params.authorBadge]
 * @param {Function} [params.onNotification]
 * @returns {{ publishedBoardTopics: number, publishedNotices: number, remindersPosted: number }}
 */
export function publishMaintenanceTasksInStore({
  tasksStore,
  postsStore,
  today = getTodayDateInTallinn(),
  overdueReminderDays = 7,
  authorUserId = '018f0000-0000-7000-8000-000000000101',
  authorBadge = { display_label: 'Oleg Sidorov', role_badge: 'BOARD' },
  onNotification,
}) {
  let publishedBoardTopics = 0
  let publishedNotices = 0
  let remindersPosted = 0
  const nowIso = new Date().toISOString()

  for (const task of tasksStore) {
    if (task.status !== 'ACTIVE' || !task.current) continue

    const { state, publish_on } = computeOccurrenceState(
      task.current.due_date,
      task.lead_days,
      task.status,
      today,
    )
    task.current.state = state
    task.current.publish_on = publish_on

    // Check if reached or passed publish_on
    if (publish_on <= today) {
      // 1. Board topic
      if (!task.current.published_at) {
        const isLate = task.current.due_date < today
        const topicTitle = isLate
          ? `Maintenance: ${task.title}, overdue since ${task.current.due_date}`
          : `Maintenance: ${task.title}, due ${task.current.due_date}`

        const boardPostId = `018f0000-0000-7000-8000-${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`
        const boardTopic = {
          id: boardPostId,
          post_type: 'BOARD_TOPIC',
          origin: 'MAINTENANCE',
          category: 'MAINTENANCE',
          title: topicTitle,
          body: task.instructions || task.title,
          author_user_id: authorUserId,
          author_badge: { ...authorBadge },
          target_scope: 'ALL_BUILDING',
          target_entrance: null,
          target_apartment_ids: null,
          is_active: true,
          comments_enabled: true,
          created_at: nowIso,
          comments: [],
        }
        postsStore.unshift(boardTopic)
        task.current.board_post_id = boardPostId
        task.current.published_at = nowIso
        publishedBoardTopics++

        if (typeof onNotification === 'function') {
          onNotification({
            event_type: 'MAINTENANCE_DUE',
            subject_type: 'maintenance_task',
            subject_id: task.id,
            params: {
              occurrence_id: task.current.occurrence_id,
              due_date: task.current.due_date,
              overdue: isLate,
              reminder_number: 0,
            },
            created_at: nowIso,
          })
        }

        // 2. Official notice (if attached to task)
        if (task.notice) {
          if (
            task.notice.target_scope === 'APARTMENT_LIST' &&
            (!Array.isArray(task.notice.target_apartment_ids) || task.notice.target_apartment_ids.length === 0)
          ) {
            task.current.notice_failed = true
            task.current.notice_post_id = null
          } else {
            const noticePostId = `018f0000-0000-7000-8000-${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`
            const noticePost = {
              id: noticePostId,
              post_type: 'OFFICIAL_NOTICE',
              origin: 'MAINTENANCE',
              category: task.notice.category || 'MAINTENANCE',
              title: task.notice.title,
              body: `${task.notice.body}\n\nPlanned date: ${task.current.due_date}`,
              author_user_id: authorUserId,
              author_badge: { ...authorBadge },
              target_scope: task.notice.target_scope,
              target_entrance: task.notice.target_entrance,
              target_apartment_ids: task.notice.target_apartment_ids ? [...task.notice.target_apartment_ids] : null,
              is_active: true,
              comments_enabled: task.notice.comments_enabled !== false,
              created_at: nowIso,
              comments: [],
            }
            postsStore.unshift(noticePost)
            task.current.notice_post_id = noticePostId
            task.current.notice_failed = false
            publishedNotices++

            if (typeof onNotification === 'function') {
              onNotification({
                event_type: 'NOTICE_PUBLISHED',
                subject_type: 'post',
                subject_id: noticePostId,
                params: {},
                target_scope: task.notice.target_scope,
                target_entrance: task.notice.target_entrance,
                target_apartment_ids: task.notice.target_apartment_ids,
                author_user_id: authorUserId,
                created_at: nowIso,
              })
            }
          }
        }
      }

      // 3. Overdue reminders
      if (task.current.due_date < today && task.current.board_post_id) {
        const daysOverdue = diffDays(task.current.due_date, today)
        if (daysOverdue >= 1) {
          const expectedReminders = 1 + Math.floor((daysOverdue - 1) / overdueReminderDays)
          const currentCount = task.current.reminder_count || 0
          if (expectedReminders > currentCount) {
            const boardTopic = postsStore.find((p) => p.id === task.current.board_post_id)
            if (boardTopic) {
              for (let r = currentCount + 1; r <= expectedReminders; r++) {
                boardTopic.comments.push({
                  id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  post_id: boardTopic.id,
                  body: `Still not done: overdue since ${task.current.due_date} (reminder ${r})`,
                  author_user_id: authorUserId,
                  author_badge: { ...authorBadge },
                  created_at: nowIso,
                })
                remindersPosted++

                if (typeof onNotification === 'function') {
                  onNotification({
                    event_type: 'MAINTENANCE_DUE',
                    subject_type: 'maintenance_task',
                    subject_id: task.id,
                    params: {
                      occurrence_id: task.current.occurrence_id,
                      due_date: task.current.due_date,
                      overdue: true,
                      reminder_number: r,
                    },
                    created_at: nowIso,
                  })
                }
              }
            }
            task.current.reminder_count = expectedReminders
          }
        }
      }
    }
  }

  return { publishedBoardTopics, publishedNotices, remindersPosted }
}

// ============================================================================
// #029 [E10/#132] Yearly Maintenance Report & CSV Export Helpers
// ============================================================================

export const MIN_REPORT_YEAR = 2000
export const MAX_REPORT_YEAR = 2100

/**
 * Validates and parses a yearly report `year` parameter (integer 2000..2100).
 * @param {number | string | null | undefined} rawYear
 * @returns {{ ok: boolean, year?: number, status?: number, errorCode?: string, message?: string }}
 */
export function parseReportYear(rawYear) {
  const str = rawYear === null || rawYear === undefined ? '' : String(rawYear).trim()
  if (!/^[0-9]{4}$/.test(str)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'year must be a 4-digit integer between 2000 and 2100.',
    }
  }
  const year = Number(str)
  if (!Number.isInteger(year) || year < MIN_REPORT_YEAR || year > MAX_REPORT_YEAR) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'year must be between 2000 and 2100.',
    }
  }
  return { ok: true, year }
}

/**
 * Extracts entries belonging to `year` based on `closed_on` year (`YYYY-...`),
 * matching backend contract ("by closed_on, not planned_date").
 * @param {Array<import('../api/schema').LogEntryView>} logStore
 * @param {number} year
 * @returns {Array<import('../api/schema').LogEntryView>}
 */
function getEntriesForClosedYear(logStore, year) {
  const yearPrefix = `${year}-`
  if (!Array.isArray(logStore)) return []
  return logStore.filter(
    (entry) => typeof entry?.closed_on === 'string' && entry.closed_on.startsWith(yearPrefix),
  )
}

/**
 * Aggregates `GET /api/v1/maintenance/report?year=YYYY` from the maintenance log store.
 * Uses exact BigInt cents via `sumCosts` (zero float math).
 * @param {Array<import('../api/schema').LogEntryView>} logStore
 * @param {number | string | null | undefined} rawYear
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, report?: import('../api/schema').YearReport }}
 */
export function buildMaintenanceYearReport(logStore, rawYear) {
  const parsed = parseReportYear(rawYear)
  if (!parsed.ok) return parsed
  const year = parsed.year

  const yearEntries = getEntriesForClosedYear(logStore, year)

  let doneCount = 0
  let skippedCount = 0
  const allCosts = []
  /** @type {Map<string, { task_id: string, task_title: string, latest_closed_on: string, latest_recorded_at: string, done_count: number, skipped_count: number, costs: Array<string | null> }>} */
  const byTask = new Map()

  for (const entry of yearEntries) {
    if (entry.kind === 'DONE') {
      doneCount += 1
    } else if (entry.kind === 'SKIPPED') {
      skippedCount += 1
    }
    allCosts.push(entry.cost)

    const taskId = String(entry.task_id || '')
    let bucket = byTask.get(taskId)
    const closedOn = String(entry.closed_on || '')
    const recordedAt = String(entry.recorded_at || '')

    if (!bucket) {
      bucket = {
        task_id: taskId,
        task_title: String(entry.task_title || ''),
        latest_closed_on: closedOn,
        latest_recorded_at: recordedAt,
        done_count: 0,
        skipped_count: 0,
        costs: [],
      }
      byTask.set(taskId, bucket)
    } else if (
      entry.task_title &&
      (closedOn > bucket.latest_closed_on ||
        (closedOn === bucket.latest_closed_on && recordedAt >= bucket.latest_recorded_at))
    ) {
      bucket.task_title = String(entry.task_title)
      bucket.latest_closed_on = closedOn
      bucket.latest_recorded_at = recordedAt
    }

    if (entry.kind === 'DONE') {
      bucket.done_count += 1
    } else if (entry.kind === 'SKIPPED') {
      bucket.skipped_count += 1
    }
    bucket.costs.push(entry.cost)
  }

  const tasks = Array.from(byTask.values())
    .map((bucket) => ({
      task_id: bucket.task_id,
      task_title: bucket.task_title,
      done_count: bucket.done_count,
      skipped_count: bucket.skipped_count,
      total_cost: sumCosts(bucket.costs),
    }))
    .sort((a, b) => {
      const titleCmp = a.task_title.localeCompare(b.task_title, 'en')
      if (titleCmp !== 0) return titleCmp
      return a.task_id.localeCompare(b.task_id, 'en')
    })

  return {
    ok: true,
    report: {
      year,
      done_count: doneCount,
      skipped_count: skippedCount,
      total_cost: sumCosts(allCosts),
      tasks,
    },
  }
}

/**
 * Prefixes text cells that a spreadsheet could interpret as a formula with `'`:
 * covers `=`, `+`, `-`, `@` including after leading whitespace/line breaks or NFKC full-width
 * equivalents, and any leading tab, CR, or LF (API contract section 3 & section 11).
 * @param {string | number | null | undefined} value
 * @returns {string}
 */
export function sanitizeCsvFormulaCell(value) {
  const str = value === null || value === undefined ? '' : String(value)
  if (!str) return ''
  if (/^[\t\r\n]/.test(str)) {
    return `'${str}`
  }
  const normalizedLeading = str.normalize('NFKC').replace(/^[\s\u00A0]+/, '')
  if (/^[=+\-@]/.test(normalizedLeading)) {
    return `'${str}`
  }
  return str
}

/**
 * Formats and quotes a CSV cell (RFC 4180), optionally applying the formula-injection guard.
 * @param {string | number | null | undefined} value
 * @param {{ guardFormula?: boolean }} [options]
 * @returns {string}
 */
export function escapeCsvCell(value, options = {}) {
  const { guardFormula = true } = options
  const raw = value === null || value === undefined ? '' : String(value)
  const safe = guardFormula ? sanitizeCsvFormulaCell(raw) : raw
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}

/**
 * Builds the UTF-8 BOM, CRLF, comma-delimited CSV attachment for `GET /api/v1/maintenance/report/export-csv`.
 * Ordered oldest `closed_on` first.
 * Columns: closed_on,task_title,kind,planned_date,cost,note,recorded_by
 * @param {Array<import('../api/schema').LogEntryView>} logStore
 * @param {number | string | null | undefined} rawYear
 * @returns {{ ok: boolean, status?: number, errorCode?: string, message?: string, year?: number, filename?: string, csv?: string }}
 */
export function buildMaintenanceYearCsv(logStore, rawYear) {
  const parsed = parseReportYear(rawYear)
  if (!parsed.ok) return parsed
  const year = parsed.year

  const yearEntries = getEntriesForClosedYear(logStore, year).slice().sort((a, b) => {
    const closedCmp = String(a.closed_on || '').localeCompare(String(b.closed_on || ''))
    if (closedCmp !== 0) return closedCmp
    const recCmp = String(a.recorded_at || '').localeCompare(String(b.recorded_at || ''))
    if (recCmp !== 0) return recCmp
    return String(a.id || '').localeCompare(String(b.id || ''))
  })

  const lines = ['closed_on,task_title,kind,planned_date,cost,note,recorded_by']
  for (const entry of yearEntries) {
    let costStr = ''
    let guardCost = false
    if (entry.cost !== null && entry.cost !== undefined && entry.cost !== '') {
      const canonical = toTwoDecimals(entry.cost)
      if (canonical !== null) {
        costStr = canonical
      } else {
        costStr = String(entry.cost)
        guardCost = true
      }
    }
    const recordedByName = entry.recorded_by?.display_label || ''
    lines.push(
      [
        escapeCsvCell(entry.closed_on || '', { guardFormula: false }),
        escapeCsvCell(entry.task_title || '', { guardFormula: true }),
        escapeCsvCell(entry.kind || '', { guardFormula: false }),
        escapeCsvCell(entry.planned_date || '', { guardFormula: false }),
        escapeCsvCell(costStr, { guardFormula: guardCost }),
        escapeCsvCell(entry.note || '', { guardFormula: true }),
        escapeCsvCell(recordedByName, { guardFormula: true }),
      ].join(','),
    )
  }

  return {
    ok: true,
    year,
    filename: `maintenance-log-${year}.csv`,
    csv: `\uFEFF${lines.join('\r\n')}\r\n`,
  }
}

/**
 * Extracts a safe download filename from a Content-Disposition header,
 * falling back to `maintenance-log-<year>.csv`.
 * @param {string | null | undefined} contentDisposition
 * @param {number} year
 * @returns {string}
 */
export function extractMaintenanceCsvFilename(contentDisposition, year) {
  const fallback = `maintenance-log-${year}.csv`
  if (typeof contentDisposition !== 'string' || !contentDisposition.trim()) {
    return fallback
  }

  const extMatch = contentDisposition.match(/filename\*\s*=\s*utf-8'[^']*'([^;\s]+)/i)
  let rawName = ''
  if (extMatch && extMatch[1]) {
    try {
      rawName = decodeURIComponent(extMatch[1])
    } catch {
      rawName = extMatch[1]
    }
  } else {
    const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]*)"/i)
    if (quotedMatch) {
      rawName = quotedMatch[1]
    } else {
      const bareMatch = contentDisposition.match(/filename\s*=\s*([^;\s]+)/i)
      rawName = bareMatch?.[1] || ''
    }
  }

  const sanitized = rawName.replace(/^.*[/\\]/, '').trim()
  return sanitized || fallback
}

/**
 * Computes descending selectable years covering at least `currentYear` down to the
 * earliest valid year found in log entries (clamped to MIN_REPORT_YEAR..MAX_REPORT_YEAR).
 * @param {Array<{ closed_on?: string | null }>} entries
 * @param {number} currentYear
 * @returns {number[]}
 */
export function getAvailableReportYears(entries, currentYear) {
  const safeCurrent = Math.min(
    MAX_REPORT_YEAR,
    Math.max(MIN_REPORT_YEAR, Number.isInteger(currentYear) ? currentYear : Number(getTodayDateInTallinn().slice(0, 4))),
  )
  let minYear = safeCurrent
  let maxYear = safeCurrent

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry?.closed_on === 'string' && /^[0-9]{4}-/.test(entry.closed_on)) {
        const y = Number(entry.closed_on.slice(0, 4))
        if (Number.isInteger(y) && y >= MIN_REPORT_YEAR && y <= MAX_REPORT_YEAR) {
          if (y < minYear) minYear = y
          if (y > maxYear) maxYear = y
        }
      }
    }
  }

  // Ensure at least one previous year is easily reachable even if log only has current-year entries
  if (minYear === maxYear && minYear > MIN_REPORT_YEAR) {
    minYear -= 1
  }

  const years = []
  for (let y = maxYear; y >= minYear; y -= 1) {
    years.push(y)
  }
  return years
}

/**
 * Paginates through `GET /maintenance/log` to discover all historical years without truncating at 100 rows.
 * Stops early if stale, when a page has fewer than `pageSize` items, or after `maxPages` safety cap.
 * @param {(params: { limit: number, offset: number }) => Promise<Array<any>>} fetchPage
 * @param {{ pageSize?: number, maxPages?: number, isStale?: () => boolean }} [options]
 * @returns {Promise<{ entries: Array<any>, stale: boolean }>}
 */
export async function fetchAllMaintenanceLogForYears(fetchPage, options = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 100))
  const maxPages = Math.max(1, Number(options.maxPages) || 50)
  const isStale = options.isStale || (() => false)

  const collected = []
  for (let page = 0; page < maxPages; page += 1) {
    if (isStale()) {
      return { entries: collected, stale: true }
    }
    const items = await fetchPage({ limit: pageSize, offset: page * pageSize })
    if (isStale()) {
      return { entries: collected, stale: true }
    }
    if (!Array.isArray(items) || items.length === 0) {
      break
    }
    collected.push(...items)
    if (items.length < pageSize) {
      break
    }
  }
  return { entries: collected, stale: false }
}


