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
  parseReportYear,
  buildMaintenanceYearReport,
  sanitizeCsvFormulaCell,
  escapeCsvCell,
  buildMaintenanceYearCsv,
  extractMaintenanceCsvFilename,
  getAvailableReportYears,
  fetchAllMaintenanceLogForYears,
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

test('parseReportYear validates integer 2000..2100 bounds (#029)', () => {
  assert.deepEqual(parseReportYear(2000), { ok: true, year: 2000 })
  assert.deepEqual(parseReportYear(' 2027 '), { ok: true, year: 2027 })
  assert.deepEqual(parseReportYear(2100), { ok: true, year: 2100 })

  for (const bad of [null, undefined, '', '2026.5', '1999', 2101, '2026a', '26']) {
    const res = parseReportYear(bad)
    assert.equal(res.ok, false)
    assert.equal(res.status, 422)
    assert.equal(res.errorCode, 'VALIDATION_ERROR')
  }
})

test('buildMaintenanceYearReport groups by closed_on year, sorts by task_title, preserves exact cents (#029)', () => {
  const sampleLog = [
    {
      id: 'log-cross-year',
      task_id: 'task-pump',
      task_title: 'Check sump pump',
      kind: 'DONE' as const,
      planned_date: '2026-12-28',
      closed_on: '2027-01-03',
      note: 'Technician came after New Year',
      cost: '120.55',
      recorded_by: { display_label: 'Peeter Tamm', role_badge: 'BOARD' as const },
      recorded_at: '2027-01-03T10:00:00Z',
      updated_at: '2027-01-03T10:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-zero-cost-archived',
      task_id: 'task-archived-fence',
      task_title: 'Abandoned fence repair',
      kind: 'SKIPPED' as const,
      planned_date: '2027-03-01',
      closed_on: '2027-03-02',
      note: 'Task later archived',
      cost: null,
      recorded_by: { display_label: 'Liina Vaher', role_badge: 'BOARD' as const },
      recorded_at: '2027-03-02T12:00:00Z',
      updated_at: '2027-03-02T12:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-pump-2',
      task_id: 'task-pump',
      task_title: 'Check sump pump',
      kind: 'DONE' as const,
      planned_date: '2027-06-28',
      closed_on: '2027-06-29',
      note: 'Summer check',
      cost: '0.45',
      recorded_by: { display_label: 'Peeter Tamm', role_badge: 'BOARD' as const },
      recorded_at: '2027-06-29T09:00:00Z',
      updated_at: '2027-06-29T09:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-pump-3',
      task_id: 'task-pump',
      task_title: 'Check sump pump',
      kind: 'SKIPPED' as const,
      planned_date: '2027-09-28',
      closed_on: '2027-09-30',
      note: 'Skipped while courtyard resurfaced',
      cost: null,
      recorded_by: { display_label: 'Liina Vaher', role_badge: 'BOARD' as const },
      recorded_at: '2027-09-30T16:00:00Z',
      updated_at: '2027-09-30T16:00:00Z',
      updated_by: null,
    },
  ]

  // Empty year returns zeros and empty list
  const emptyRes = buildMaintenanceYearReport(sampleLog, 2026)
  assert.equal(emptyRes.ok, true)
  assert.deepEqual(emptyRes.report, {
    year: 2026,
    done_count: 0,
    skipped_count: 0,
    total_cost: '0.00',
    tasks: [],
  })

  // 2027 report includes cross-year entry closed on 2027-01-03 + sorted by task_title
  const res2027 = buildMaintenanceYearReport(sampleLog, 2027)
  assert.equal(res2027.ok, true)
  assert.deepEqual(res2027.report, {
    year: 2027,
    done_count: 2,
    skipped_count: 2,
    total_cost: '121.00',
    tasks: [
      {
        task_id: 'task-archived-fence',
        task_title: 'Abandoned fence repair',
        done_count: 0,
        skipped_count: 1,
        total_cost: '0.00',
      },
      {
        task_id: 'task-pump',
        task_title: 'Check sump pump',
        done_count: 2,
        skipped_count: 1,
        total_cost: '121.00',
      },
    ],
  })
})

test('sanitizeCsvFormulaCell, escapeCsvCell, and buildMaintenanceYearCsv enforce BOM, CRLF, oldest first, and formula guard (#029)', () => {
  // Formula guard cases from API.md
  assert.equal(sanitizeCsvFormulaCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(sanitizeCsvFormulaCell('+1+1'), "'+1+1")
  assert.equal(sanitizeCsvFormulaCell('-10'), "'-10")
  assert.equal(sanitizeCsvFormulaCell('@cmd'), "'@cmd")
  assert.equal(sanitizeCsvFormulaCell('  \n  =1+1'), "'  \n  =1+1")
  assert.equal(sanitizeCsvFormulaCell('\uFF1DSUM(A1)'), "'\uFF1DSUM(A1)")
  assert.equal(sanitizeCsvFormulaCell('\uFF0B1'), "'\uFF0B1")
  assert.equal(sanitizeCsvFormulaCell('\tcell'), "'\tcell")
  assert.equal(sanitizeCsvFormulaCell('\rcell'), "'\rcell")
  assert.equal(sanitizeCsvFormulaCell('\ncell'), "'\ncell")
  assert.equal(sanitizeCsvFormulaCell('Regular note'), 'Regular note')

  // RFC 4180 quoting with formula guard
  assert.equal(escapeCsvCell('=foo, "bar"'), '"\'=foo, ""bar"""')

  const entries = [
    {
      id: 'log-newer',
      task_id: 't1',
      task_title: '+Roof Work',
      kind: 'DONE' as const,
      planned_date: '2027-05-10',
      closed_on: '2027-05-12',
      note: 'Checked, "repaired"',
      cost: '150',
      recorded_by: { display_label: 'Peeter Tamm', role_badge: 'BOARD' as const },
      recorded_at: '2027-05-12T10:00:00Z',
      updated_at: '2027-05-12T10:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-older',
      task_id: 't2',
      task_title: 'Drainage',
      kind: 'SKIPPED' as const,
      planned_date: '2027-01-15',
      closed_on: '2027-01-20',
      note: '  =IMPORTXML("x")',
      cost: null,
      recorded_by: { display_label: '@admin', role_badge: 'BOARD' as const },
      recorded_at: '2027-01-20T09:00:00Z',
      updated_at: '2027-01-20T09:00:00Z',
      updated_by: null,
    },
  ]

  const csvOutcome = buildMaintenanceYearCsv(entries, 2027)
  assert.equal(csvOutcome.ok, true)
  assert.equal(csvOutcome.filename, 'maintenance-log-2027.csv')
  assert.equal(csvOutcome.csv?.startsWith('\uFEFF'), true)

  const lines = csvOutcome.csv!.slice(1).split('\r\n')
  assert.equal(lines[0], 'closed_on,task_title,kind,planned_date,cost,note,recorded_by')
  // Oldest closed_on first (2027-01-20 before 2027-05-12)
  assert.equal(
    lines[1],
    '2027-01-20,Drainage,SKIPPED,2027-01-15,,"  \'\x3dIMPORTXML(""x"")",\'@admin'.replace(
      '  \'\x3d',
      '\'  =',
    ),
  )
  assert.equal(
    lines[2],
    '2027-05-12,\'+Roof Work,DONE,2027-05-10,150.00,"Checked, ""repaired""",Peeter Tamm',
  )
})

test('extractMaintenanceCsvFilename and getAvailableReportYears handle headers and year spans (#029)', () => {
  assert.equal(
    extractMaintenanceCsvFilename('attachment; filename="maintenance-log-2027.csv"', 2027),
    'maintenance-log-2027.csv',
  )
  assert.equal(
    extractMaintenanceCsvFilename("attachment; filename*=UTF-8''custom%20report-2027.csv", 2027),
    'custom report-2027.csv',
  )
  assert.equal(
    extractMaintenanceCsvFilename("attachment; filename*=UTF-8'en'report-2027.csv", 2027),
    'report-2027.csv',
  )
  assert.equal(
    extractMaintenanceCsvFilename("attachment; filename*=UTF-8''%E0%A4%A.csv", 2027),
    '%E0%A4%A.csv',
  )
  assert.equal(
    extractMaintenanceCsvFilename('attachment; filename=""', 2027),
    'maintenance-log-2027.csv',
  )
  assert.equal(
    extractMaintenanceCsvFilename('attachment; filename=../../evil.csv', 2027),
    'evil.csv',
  )
  assert.equal(extractMaintenanceCsvFilename('', 2027), 'maintenance-log-2027.csv')

  assert.deepEqual(
    getAvailableReportYears([{ closed_on: '2024-02-01' }, { closed_on: '2026-06-01' }], 2026),
    [2026, 2025, 2024],
  )
  assert.deepEqual(getAvailableReportYears([], 2026), [2026, 2025])
})

test('report and CSV edge cases: task rename, tie-breakers, 0.00 cost, malformed cost formula guard, empty CSV, and pagination (#029)', async () => {
  const renamedAndTiedLog = [
    {
      id: 'log-b',
      task_id: 'task-2',
      task_title: 'Alpha Task',
      kind: 'DONE' as const,
      planned_date: '2027-02-01',
      closed_on: '2027-02-01',
      note: 'Same day later record',
      cost: '0.10',
      recorded_by: { display_label: 'Board A', role_badge: 'BOARD' as const },
      recorded_at: '2027-02-01T12:00:00Z',
      updated_at: '2027-02-01T12:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-a',
      task_id: 'task-1',
      task_title: 'Alpha Task',
      kind: 'DONE' as const,
      planned_date: '2027-02-01',
      closed_on: '2027-02-01',
      note: 'Same day earlier record',
      cost: '0.20',
      recorded_by: { display_label: 'Board A', role_badge: 'BOARD' as const },
      recorded_at: '2027-02-01T08:00:00Z',
      updated_at: '2027-02-01T08:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-zero',
      task_id: 'task-renamed',
      task_title: 'Old Gutter Name',
      kind: 'DONE' as const,
      planned_date: '2027-01-10',
      closed_on: '2027-01-10',
      note: 'Zero euro check',
      cost: '0.00',
      recorded_by: { display_label: 'Board A', role_badge: 'BOARD' as const },
      recorded_at: '2027-01-10T09:00:00Z',
      updated_at: '2027-01-10T09:00:00Z',
      updated_by: null,
    },
    {
      id: 'log-renamed-later',
      task_id: 'task-renamed',
      task_title: 'Zebra Gutter Check',
      kind: 'SKIPPED' as const,
      planned_date: '2027-05-01',
      closed_on: '2027-05-02',
      note: 'Renamed task',
      cost: null,
      recorded_by: { display_label: 'Board A', role_badge: 'BOARD' as const },
      recorded_at: '2027-05-02T09:00:00Z',
      updated_at: '2027-05-02T09:00:00Z',
      updated_by: null,
    },
  ]

  const report = buildMaintenanceYearReport(renamedAndTiedLog, 2027)
  assert.equal(report.ok, true)
  assert.equal(report.report?.total_cost, '0.30')
  assert.deepEqual(report.report?.tasks, [
    { task_id: 'task-1', task_title: 'Alpha Task', done_count: 1, skipped_count: 0, total_cost: '0.20' },
    { task_id: 'task-2', task_title: 'Alpha Task', done_count: 1, skipped_count: 0, total_cost: '0.10' },
    { task_id: 'task-renamed', task_title: 'Zebra Gutter Check', done_count: 1, skipped_count: 1, total_cost: '0.00' },
  ])

  const csvEmpty = buildMaintenanceYearCsv(renamedAndTiedLog, 2025)
  assert.equal(csvEmpty.ok, true)
  assert.equal(csvEmpty.csv, '\uFEFFclosed_on,task_title,kind,planned_date,cost,note,recorded_by\r\n')

  const csv2027 = buildMaintenanceYearCsv(renamedAndTiedLog, 2027)
  const lines = csv2027.csv!.slice(1).trimEnd().split('\r\n')
  // Row 1 is 2027-01-10 (0.00 cost), Row 2 is log-a (08:00), Row 3 is log-b (12:00)
  assert.equal(lines[1].includes(',0.00,Zero euro check,'), true)
  assert.equal(lines[2].includes('Same day earlier record'), true)
  assert.equal(lines[3].includes('Same day later record'), true)

  // Malformed cost must still be formula-guarded
  const malformedCsv = buildMaintenanceYearCsv(
    [
      {
        ...renamedAndTiedLog[0],
        cost: '=1+1',
      },
    ],
    2027,
  )
  assert.equal(malformedCsv.csv!.includes(",'=1+1,"), true)

  // Multi-page log discovery beyond 100 entries
  const allRows = [
    { id: '1', closed_on: '2026-05-01' },
    { id: '2', closed_on: '2025-05-01' },
    { id: '3', closed_on: '2024-05-01' },
    { id: '4', closed_on: '2023-05-01' },
    { id: '5', closed_on: '2022-05-01' },
  ]
  const offsets: number[] = []
  const fetched = await fetchAllMaintenanceLogForYears(
    async ({ limit, offset }) => {
      offsets.push(offset)
      return allRows.slice(offset, offset + limit)
    },
    { pageSize: 2, maxPages: 10 },
  )
  assert.equal(fetched.stale, false)
  assert.deepEqual(offsets, [0, 2, 4])
  assert.deepEqual(getAvailableReportYears(fetched.entries, 2026), [2026, 2025, 2024, 2023, 2022])
})




