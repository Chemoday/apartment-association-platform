import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getTodayDateInTallinn,
  isValidCalendarDate,
  addDays,
  diffDays,
  maxAllowedLeadDays,
  computeNextRecurrenceDate,
  computeNextOccurrenceAfterClose,
  computeOccurrenceState,
  validateTaskDraft,
  normalizeCostInput,
  toTwoDecimals,
  sumCosts,
  formatCost,
  publishMaintenanceTasksInStore,
} from './maintenance.js'

test('isValidCalendarDate correctly parses YYYY-MM-DD calendar dates', () => {
  assert.equal(isValidCalendarDate('2026-11-09'), true)
  assert.equal(isValidCalendarDate('2024-02-29'), true) // Leap year
  assert.equal(isValidCalendarDate('2025-02-29'), false) // Common year
  assert.equal(isValidCalendarDate('2026-04-31'), false) // 30 days in April
  assert.equal(isValidCalendarDate('not-a-date'), false)
  assert.equal(isValidCalendarDate(null as any), false)
})

test('addDays and diffDays compute accurate calendar spans', () => {
  assert.equal(addDays('2026-10-30', 2), '2026-11-01')
  assert.equal(addDays('2026-11-01', -2), '2026-10-30')
  assert.equal(diffDays('2026-10-30', '2026-11-01'), 2)
  assert.equal(diffDays('2026-11-01', '2026-10-30'), -2)
})

test('maxAllowedLeadDays respects unit bounds and caps at 90', () => {
  assert.equal(maxAllowedLeadDays('DAY', 7), 6)
  assert.equal(maxAllowedLeadDays('DAY', 100), 90)
  assert.equal(maxAllowedLeadDays('MONTH', 1), 27)
  assert.equal(maxAllowedLeadDays('MONTH', 6), 90)
  assert.equal(maxAllowedLeadDays('YEAR', 1), 90)
})

test('computeNextRecurrenceDate preserves day-of-month and clamps appropriately', () => {
  // Monthly from 31 Jan -> 28 Feb (common year)
  assert.equal(computeNextRecurrenceDate('2025-01-31', 'MONTH', 1), '2025-02-28')
  // Monthly from 31 Jan -> 29 Feb (leap year 2024)
  assert.equal(computeNextRecurrenceDate('2024-01-31', 'MONTH', 1), '2024-02-29')
  // Monthly from 31 Jan -> 31 Mar (2 months)
  assert.equal(computeNextRecurrenceDate('2025-01-31', 'MONTH', 2), '2025-03-31')
  // Yearly from 29 Feb 2024 -> 28 Feb 2025
  assert.equal(computeNextRecurrenceDate('2024-02-29', 'YEAR', 1), '2025-02-28')
  // Yearly from 29 Feb 2024 -> 29 Feb 2028 (4 years)
  assert.equal(computeNextRecurrenceDate('2024-02-29', 'YEAR', 4), '2028-02-29')
  // Daily
  assert.equal(computeNextRecurrenceDate('2026-10-25', 'DAY', 14), '2026-11-08')
})

test('computeOccurrenceState returns UPCOMING, DUE, OVERDUE, or PAUSED', () => {
  const today = '2026-11-10'
  // Due 2026-11-15, lead 7 days -> publish_on 2026-11-08. Today (Nov 10) is in [Nov 8..Nov 15] -> DUE
  assert.deepEqual(computeOccurrenceState('2026-11-15', 7, 'ACTIVE', today), {
    state: 'DUE',
    publish_on: '2026-11-08',
  })

  // Due 2026-11-20, lead 7 days -> publish_on 2026-11-13. Today (Nov 10) is before Nov 13 -> UPCOMING
  assert.deepEqual(computeOccurrenceState('2026-11-20', 7, 'ACTIVE', today), {
    state: 'UPCOMING',
    publish_on: '2026-11-13',
  })

  // Due 2026-11-05, lead 7 days. Today (Nov 10) is after due date -> OVERDUE
  assert.deepEqual(computeOccurrenceState('2026-11-05', 7, 'ACTIVE', today), {
    state: 'OVERDUE',
    publish_on: '2026-10-29',
  })

  // Paused status always yields PAUSED state
  assert.deepEqual(computeOccurrenceState('2026-11-05', 7, 'PAUSED', today), {
    state: 'PAUSED',
    publish_on: '2026-10-29',
  })
})

test('validateTaskDraft validates required fields and bounds', () => {
  const validDraft = {
    title: 'Inspect fire extinguishers',
    instructions: 'Every floor and basement',
    period_unit: 'MONTH',
    period_count: 12,
    lead_days: 14,
    first_due_date: '2027-04-15',
    has_notice: false,
  }
  const result = validateTaskDraft(validDraft, { today: '2026-11-10' })
  assert.equal(result.valid, true)
  assert.equal(result.payload.title, 'Inspect fire extinguishers')
  assert.equal(result.payload.notice, null)

  // Empty title
  const invalidResult = validateTaskDraft({ ...validDraft, title: '' }, { today: '2026-11-10' })
  assert.equal(invalidResult.valid, false)
  assert.equal(invalidResult.errors.title, 'REQUIRED')

  // Lead days exceeds max
  const badLead = validateTaskDraft({ ...validDraft, lead_days: 99 }, { today: '2026-11-10' })
  assert.equal(badLead.valid, false)
  assert.equal(badLead.errors.lead_days, 'OUT_OF_RANGE')
})

test('cost decimal string helpers validate, sum, and format without float conversion (#016)', () => {
  assert.equal(normalizeCostInput(''), null)
  assert.equal(normalizeCostInput(null), null)
  assert.equal(normalizeCostInput('145'), '145')
  assert.equal(normalizeCostInput('145,50'), '145.50')
  assert.equal(normalizeCostInput('0.00'), '0.00')

  // Reject negative, 3 decimals, and letters
  assert.equal(normalizeCostInput('-10.00'), undefined)
  assert.equal(normalizeCostInput('145.123'), undefined)
  assert.equal(normalizeCostInput('145abc'), undefined)

  assert.equal(toTwoDecimals('145'), '145.00')
  assert.equal(toTwoDecimals('145,5'), '145.50')
  assert.equal(sumCosts(['95.50', '240.00', null, '145']), '480.50')

  assert.equal(formatCost('145.5', 'en'), '145.50')
  assert.equal(formatCost('145.5', 'et'), '145,50')
  assert.equal(formatCost('145.5', 'ru'), '145,50')
})

test('computeNextOccurrenceAfterClose advances to first schedule date after both plannedDate and closedOn (#016)', () => {
  // Done early: anchor 2027-01-31, monthly, planned 2027-01-31, done 2027-01-20 -> 2027-02-28
  assert.equal(
    computeNextOccurrenceAfterClose('2027-01-31', 'MONTH', 1, '2027-01-31', '2027-01-20'),
    '2027-02-28',
  )
  // Next month from 2027-02-28 returns to 31st in March (2027-03-31)
  assert.equal(
    computeNextOccurrenceAfterClose('2027-01-31', 'MONTH', 1, '2027-02-28', '2027-02-28'),
    '2027-03-31',
  )
  // Done very late (missed Feb 28): planned 2027-01-31, done 2027-03-05 -> skips 2027-02-28 and lands on 2027-03-31
  assert.equal(
    computeNextOccurrenceAfterClose('2027-01-31', 'MONTH', 1, '2027-01-31', '2027-03-05'),
    '2027-03-31',
  )
})

test('publishMaintenanceTasksInStore publishes board topic, notice, notice_failed flag, and overdue comments (#017)', () => {
  const today = '2026-11-10'
  const tasksStore = [
    // 1. Task that reached publish_on with valid notice
    {
      id: 'task-test-due',
      title: 'Inspect fire dampers',
      instructions: 'Check all dampers on staircases',
      status: 'ACTIVE',
      period_unit: 'YEAR',
      period_count: 1,
      lead_days: 7,
      anchor_date: '2026-11-12',
      notice: {
        title: 'Fire Damper Inspection',
        body: 'Technicians will test ventilation dampers.',
        category: 'MAINTENANCE',
        target_scope: 'ALL_BUILDING',
        target_entrance: null,
        target_apartment_ids: null,
        comments_enabled: true,
      },
      current: {
        occurrence_id: 'occ-damper-1',
        due_date: '2026-11-12',
        publish_on: '2026-11-05',
        state: 'DUE',
        published_at: null,
        board_post_id: null,
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 0,
      },
    },
    // 2. Task with invalid apartment list notice
    {
      id: 'task-test-invalid-notice',
      title: 'Balcony inspection',
      instructions: 'Inspect specific apartments',
      status: 'ACTIVE',
      period_unit: 'MONTH',
      period_count: 6,
      lead_days: 5,
      anchor_date: '2026-11-14',
      notice: {
        title: 'Balcony check',
        body: 'Check apartment balconies',
        category: 'MAINTENANCE',
        target_scope: 'APARTMENT_LIST',
        target_entrance: null,
        target_apartment_ids: [], // empty list -> fails
        comments_enabled: false,
      },
      current: {
        occurrence_id: 'occ-balcony-1',
        due_date: '2026-11-14',
        publish_on: '2026-11-09',
        state: 'DUE',
        published_at: null,
        board_post_id: null,
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 0,
      },
    },
    // 3. Overdue task already published, needs periodic reminder comments
    {
      id: 'task-test-overdue',
      title: 'Water meter verification',
      instructions: 'Certify baseline water meters',
      status: 'ACTIVE',
      period_unit: 'YEAR',
      period_count: 2,
      lead_days: 10,
      anchor_date: '2026-10-20',
      notice: null,
      current: {
        occurrence_id: 'occ-meter-1',
        due_date: '2026-10-20', // 21 days overdue
        publish_on: '2026-10-10',
        state: 'OVERDUE',
        published_at: '2026-10-10T09:00:00Z',
        board_post_id: 'post-meter-board',
        notice_post_id: null,
        notice_failed: false,
        reminder_count: 1, // 1 reminder already sent
      },
    },
  ]

  const postsStore = [
    {
      id: 'post-meter-board',
      post_type: 'BOARD_TOPIC',
      origin: 'MAINTENANCE',
      title: 'Maintenance: Water meter verification',
      comments: [
        { id: 'c1', body: 'First reminder' },
      ],
    },
  ]

  const result = publishMaintenanceTasksInStore({
    tasksStore,
    postsStore,
    today,
    overdueReminderDays: 7,
  })

  // Task 1 published board topic and notice
  assert.equal(result.publishedBoardTopics, 2)
  assert.equal(result.publishedNotices, 1)
  assert.ok(tasksStore[0].current.board_post_id)
  assert.ok(tasksStore[0].current.notice_post_id)
  assert.equal(tasksStore[0].current.notice_failed, false)

  const createdBoardTopic = postsStore.find((p) => p.id === tasksStore[0].current.board_post_id)
  assert.ok(createdBoardTopic)
  assert.equal(createdBoardTopic.origin, 'MAINTENANCE')
  assert.equal(createdBoardTopic.post_type, 'BOARD_TOPIC')

  const createdNotice = postsStore.find((p) => p.id === tasksStore[0].current.notice_post_id)
  assert.ok(createdNotice)
  assert.equal(createdNotice.origin, 'MAINTENANCE')
  assert.equal(createdNotice.post_type, 'OFFICIAL_NOTICE')

  // Task 2 notice failed
  assert.ok(tasksStore[1].current.board_post_id)
  assert.equal(tasksStore[1].current.notice_post_id, null)
  assert.equal(tasksStore[1].current.notice_failed, true)

  // Task 3: 21 days overdue with reminder_count: 1 and overdueReminderDays: 7
  // expectedReminders = 1 + floor((21-1)/7) = 1 + 2 = 3
  // Sent 2 more reminders (from 1 to 3)
  assert.equal(tasksStore[2].current.reminder_count, 3)
  assert.equal(result.remindersPosted, 2)
  const meterBoard = postsStore.find((p) => p.id === 'post-meter-board')
  assert.ok(meterBoard)
  assert.equal(meterBoard.comments.length, 3)
  assert.ok(meterBoard.comments[2].body.includes('reminder 3'))
})

test('publishMaintenanceTasksInStore invokes onNotification callback with MAINTENANCE_DUE and NOTICE_PUBLISHED (#018)', () => {
  const today = '2026-11-10'
  const tasksStore = [
    {
      id: 'task-notif-1',
      title: 'Elevator Maintenance',
      status: 'ACTIVE',
      lead_days: 5,
      current: {
        occurrence_id: 'occ-1',
        due_date: '2026-11-15',
        board_post_id: null,
        notice_post_id: null,
        reminder_count: 0,
      },
      notice: {
        category: 'MAINTENANCE',
        title: 'Elevator Maintenance',
        body: 'Elevator will be inspected.',
        target_scope: 'ALL_BUILDING',
      },
      recurring: null,
    },
    {
      id: 'task-notif-overdue',
      title: 'Chimney Sweep',
      status: 'ACTIVE',
      lead_days: 7,
      current: {
        occurrence_id: 'occ-overdue',
        due_date: '2026-11-01',
        board_post_id: 'post-chimney-board',
        published_at: '2026-10-25T10:00:00.000Z',
        notice_post_id: null,
        reminder_count: 1,
      },
      recurring: null,
    },
  ]
  const postsStore = [
    {
      id: 'post-chimney-board',
      post_type: 'BOARD_TOPIC',
      comments: [],
    },
  ]

  const emitted: any[] = []
  publishMaintenanceTasksInStore({
    tasksStore,
    postsStore,
    today,
    overdueReminderDays: 7,
    onNotification: (notif: any) => emitted.push(notif),
  })

  // Task 1: published board topic -> MAINTENANCE_DUE (reminder_number: 0, overdue: false)
  //         published notice -> NOTICE_PUBLISHED
  // Task 2: 9 days overdue -> 1 reminder posted -> MAINTENANCE_DUE (reminder_number: 1, overdue: true)
  assert.equal(emitted.length, 3)

  const firstMaint = emitted.find(
    (n) => n.event_type === 'MAINTENANCE_DUE' && n.subject_id === 'task-notif-1',
  )
  assert.ok(firstMaint)
  assert.equal(firstMaint.params.occurrence_id, 'occ-1')
  assert.equal(firstMaint.params.due_date, '2026-11-15')
  assert.equal(firstMaint.params.overdue, false)
  assert.equal(firstMaint.params.reminder_number, 0)

  const notice = emitted.find((n) => n.event_type === 'NOTICE_PUBLISHED')
  assert.ok(notice)
  assert.equal(notice.subject_type, 'post')
  assert.equal(notice.target_scope, 'ALL_BUILDING')

  const overdueMaint = emitted.find(
    (n) => n.event_type === 'MAINTENANCE_DUE' && n.subject_id === 'task-notif-overdue',
  )
  assert.ok(overdueMaint)
  assert.equal(overdueMaint.params.overdue, true)
  assert.equal(overdueMaint.params.reminder_number, 2)
})


