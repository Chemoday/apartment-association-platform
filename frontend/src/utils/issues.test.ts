import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDefaultIssuesSeed,
  isIssueOpen,
  canUserAccessIssues,
  findMatchingOpenIssues,
  validateIssueReportDraft,
  isIssueVisibleToUser,
  queryIssuesStore,
  createIssueInStore,
  editIssueInStore,
  withdrawIssueInStore,
  updateIssueFollowInStore,
  changeIssueStatusInStore,
  clearIssueUrgentInStore,
  getAllowedBoardMoves,
  canBoardReopenIssue,
  rankDuplicateCandidates,
  toIssueView,
  checkIssuePhotoUploadPreflight,
  addIssuePhotoInStore,
  getIssuePhotoFromStore,
  deleteIssuePhotoInStore,
  MAX_ISSUE_PHOTOS,
  THIRTY_DAYS_MS,
} from './issues.js'
import { cloneDefaultAssociationSettings } from './associationSettings.js'

const RESIDENT_APT14 = {
  user_id: '018f0000-0000-7000-8000-000000000102',
  building_role: 'USER',
  label: 'Kati Kask (Apt 14)',
}

const RESIDENT_APT02 = {
  user_id: '018f0000-0000-7000-8000-000000000104',
  building_role: 'USER',
  label: 'M. T. (Apt 02)',
}

const CHAIRMAN_USER = {
  user_id: '018f0000-0000-7000-8000-000000000101',
  building_role: 'CHAIRMAN',
  label: 'Peeter Tamm (Apt 01)',
}

const BOARD_USER = {
  user_id: '018f0000-0000-7000-8000-000000000105',
  building_role: 'BOARD',
  label: 'Jüri Mets (Apt 03)',
}

const ACCOUNTANT_NO_APT = {
  user_id: '018f0000-0000-7000-8000-000000000103',
  building_role: 'ACCOUNTANT',
  label: 'Marika Rebane',
}

describe('issues utilities (#012)', () => {
  it('enforces access control: residents with apartments and board can access; accountant without apartment cannot', () => {
    assert.equal(canUserAccessIssues(RESIDENT_APT14, [{ apartment_id: 'apt-14' }]), true)
    assert.equal(canUserAccessIssues(CHAIRMAN_USER, []), true)
    assert.equal(canUserAccessIssues(ACCOUNTANT_NO_APT, []), false)
  })

  it('enforces visibility: open issues for everyone, WITHDRAWN only for reporter and board, ended hidden after 30 days unless includeOld or byLink for board', () => {
    const nowMs = Date.now()
    const seed = createDefaultIssuesSeed(nowMs)
    const openIssue = seed[0]
    const withdrawnIssue = seed[1]

    // Open issue is visible to all residents
    assert.equal(isIssueVisibleToUser(openIssue, RESIDENT_APT14, nowMs), true)
    assert.equal(isIssueVisibleToUser(openIssue, RESIDENT_APT02, nowMs), true)

    // Withdrawn issue (reported by Apt 02) is visible to Apt 02 and Chairman, but NOT to Apt 14
    assert.equal(isIssueVisibleToUser(withdrawnIssue, RESIDENT_APT02, nowMs), true)
    assert.equal(isIssueVisibleToUser(withdrawnIssue, CHAIRMAN_USER, nowMs), true)
    assert.equal(isIssueVisibleToUser(withdrawnIssue, RESIDENT_APT14, nowMs), false)

    // Ended issue older than 30 days is hidden in default lists, but visible to board with includeOld or byLink
    const expiredIssue = {
      ...withdrawnIssue,
      status: 'RESOLVED',
      ended_at: new Date(nowMs - THIRTY_DAYS_MS - 1000).toISOString(),
    }
    assert.equal(isIssueVisibleToUser(expiredIssue, CHAIRMAN_USER, nowMs), false)
    assert.equal(
      isIssueVisibleToUser(expiredIssue, CHAIRMAN_USER, nowMs, { includeOld: true }),
      true,
    )
    assert.equal(isIssueVisibleToUser(expiredIssue, CHAIRMAN_USER, nowMs, { byLink: true }), true)
    assert.equal(
      isIssueVisibleToUser(expiredIssue, RESIDENT_APT02, nowMs, { includeOld: true }),
      false,
    )
  })

  it('enforces privacy: residents never see reporter identity or changed_by on timeline', () => {
    const seed = createDefaultIssuesSeed()
    const openIssue = seed[0]

    const residentView = toIssueView(openIssue, RESIDENT_APT14)
    assert.equal(residentView.reporter, null)
    assert.equal(residentView.followers, 2)
    assert.equal(residentView.i_reported, true)
    assert.equal(residentView.i_follow, true)
    assert.equal(residentView.can_edit, true)
    assert.equal(residentView.timeline[0].changed_by, null)

    const chairmanView = toIssueView(openIssue, CHAIRMAN_USER)
    assert.ok(chairmanView.reporter)
    assert.equal(chairmanView.reporter.apartment_id, '018f0000-0000-7000-8000-000000000314')
    assert.ok(chairmanView.timeline[0].changed_by)
    assert.equal(chairmanView.timeline[0].changed_by.role_badge, 'RESIDENT')
  })

  it('filters issues by status, category, and entrance (including 0 for outside/whole building)', () => {
    const nowMs = Date.now()
    const store: any[] = createDefaultIssuesSeed(nowMs)
    store.push({
      id: '018f0000-0000-7000-8000-000000000903',
      category: 'YARD',
      entrance: null,
      place: 'Courtyard gate',
      title: 'Gate latch is sticking',
      description: '',
      status: 'REPORTED',
      urgent: false,
      reporter_user_id: RESIDENT_APT14.user_id,
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      follower_user_ids: [RESIDENT_APT14.user_id],
      duplicate_of: null,
      created_at: new Date(nowMs - 1000).toISOString(),
      updated_at: new Date(nowMs - 1000).toISOString(),
      ended_at: null,
      timeline: [],
    })

    // Filter entrance=0 (outside / whole building)
    const outsideRes = queryIssuesStore(store, RESIDENT_APT14, { entrance: 0 }, nowMs)
    assert.equal(outsideRes.ok, true)
    const outsideItems = outsideRes.items || []
    assert.equal(outsideItems.length, 1)
    assert.equal(outsideItems[0].category, 'YARD')

    // Filter entrance=2
    const ent2Res = queryIssuesStore(store, RESIDENT_APT14, { entrance: 2 }, nowMs)
    assert.equal(ent2Res.ok, true)
    const ent2Items = ent2Res.items || []
    assert.equal(ent2Items.length, 1)
    assert.equal(ent2Items[0].category, 'LIGHTING')

    // Find matching open issues for pre-submit duplicate suggestion
    const matches = findMatchingOpenIssues(outsideItems.concat(ent2Items), 'LIGHTING', 2)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].title, 'No light on the 3rd floor landing')
  })

  it('enforces urgent_enabled setting and per-apartment 24h rate limits from #011 settings', () => {
    const nowMs = Date.now()
    const store: any[] = []
    const settings = cloneDefaultAssociationSettings()
    const memberships = [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
      },
    ]

    // 1. Urgent is rejected when issues.urgent_enabled is false (default)
    const urgentRejected = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: {
        category: 'WATER_AND_SEWAGE',
        entrance: 2,
        title: 'Basement pipe leak',
        urgent: true,
      },
      nowMs,
    })
    assert.equal(urgentRejected.ok, false)
    assert.equal(urgentRejected.status, 422)
    assert.equal(urgentRejected.errorCode, 'VALIDATION_ERROR')

    // 2. Set reports_per_apartment_per_day = 2 and test rate limiting
    const limitSetting = settings.find((s) => s.key === 'issues.reports_per_apartment_per_day')
    assert.ok(limitSetting)
    limitSetting.value = 2

    const r1 = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'CLEANING', entrance: 2, title: 'First issue today' },
      nowMs: nowMs - 3600 * 1000,
    })
    assert.equal(r1.ok, true)

    const r2 = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'CLEANING', entrance: 2, title: 'Second issue today' },
      nowMs: nowMs - 1800 * 1000,
    })
    assert.equal(r2.ok, true)

    const r3 = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'CLEANING', entrance: 2, title: 'Third issue today (exceeds limit 2)' },
      nowMs,
    })
    assert.equal(r3.ok, false)
    assert.equal(r3.status, 429)
    assert.equal(r3.errorCode, 'RATE_LIMITED')
    assert.ok(r3.extra)
    assert.equal(typeof r3.extra.retry_after_seconds, 'number')
    assert.equal((r3.extra.retry_after_seconds || 0) > 0, true)
  })

  it('supports editing, following/unfollowing, and withdrawing a REPORTED issue', () => {
    const nowMs = Date.now()
    const seed = createDefaultIssuesSeed(nowMs)
    const openIssue = seed[0] // reported by RESIDENT_APT14

    // Non-reporter cannot edit
    const forbiddenEdit = editIssueInStore({
      issue: openIssue,
      user: RESIDENT_APT02,
      body: { title: 'Hacked title' },
    })
    assert.equal(forbiddenEdit.ok, false)
    assert.equal(forbiddenEdit.status, 403)

    // Reporter can edit while REPORTED
    const validEdit = editIssueInStore({
      issue: openIssue,
      user: RESIDENT_APT14,
      body: { title: 'No light on the 3rd floor landing (bulb burned out)', place: '3rd floor' },
    })
    assert.equal(validEdit.ok, true)
    assert.ok(validEdit.issue)
    assert.equal(validEdit.issue.title, 'No light on the 3rd floor landing (bulb burned out)')
    assert.equal(validEdit.issue.place, '3rd floor')

    // Chairman follows (+1)
    const followRes = updateIssueFollowInStore({
      issue: openIssue,
      user: CHAIRMAN_USER,
      follow: true,
    })
    assert.equal(followRes.ok, true)
    assert.ok(followRes.issue)
    assert.equal(followRes.issue.followers, 3)
    assert.equal(followRes.issue.i_follow, true)

    // Chairman unfollows
    const unfollowRes = updateIssueFollowInStore({
      issue: openIssue,
      user: CHAIRMAN_USER,
      follow: false,
    })
    assert.equal(unfollowRes.ok, true)
    assert.ok(unfollowRes.issue)
    assert.equal(unfollowRes.issue.followers, 2)
    assert.equal(unfollowRes.issue.i_follow, false)

    // Reporter withdraws the issue
    const withdrawRes = withdrawIssueInStore({
      issue: openIssue,
      user: RESIDENT_APT14,
      nowMs,
    })
    assert.equal(withdrawRes.ok, true)
    assert.ok(withdrawRes.issue)
    assert.equal(withdrawRes.issue.status, 'WITHDRAWN')
    assert.equal(isIssueOpen(withdrawRes.issue.status), false)

    // Cannot follow or edit an ended issue
    const followAfterEnd = updateIssueFollowInStore({
      issue: openIssue,
      user: CHAIRMAN_USER,
      follow: true,
    })
    assert.equal(followAfterEnd.ok, false)
    assert.equal(followAfterEnd.status, 409)
    assert.equal(followAfterEnd.errorCode, 'ISSUE_ENDED')
  })

  it('validates client-side report drafts cleanly', () => {
    const formMeta = {
      urgent_enabled: false,
      apartment_ids: ['apt-14'],
      entrances: [1, 2],
    }
    const bad = validateIssueReportDraft({ category: '', title: '' }, formMeta, false)
    assert.equal(bad.valid, false)
    assert.equal(bad.errors.category, 'CATEGORY_REQUIRED')
    assert.equal(bad.errors.title, 'TITLE_REQUIRED')

    const good = validateIssueReportDraft(
      {
        category: 'LIGHTING',
        entrance: 2,
        place: '2nd floor',
        title: 'Flickering lamp',
        description: 'Flickers every few seconds',
        urgent: false,
      },
      formMeta,
      false,
    )
    assert.equal(good.valid, true)
    assert.ok(good.payload)
    assert.equal(good.payload.apartment_id, 'apt-14')
    assert.equal(good.payload.entrance, 2)

    const atLimit = validateIssueReportDraft(
      {
        category: 'LIGHTING',
        entrance: 2,
        place: 'p'.repeat(200),
        title: 't'.repeat(120),
        description: '',
        urgent: false,
      },
      formMeta,
      false,
    )
    assert.equal(atLimit.valid, true)
    assert.equal(atLimit.payload?.place.length, 200)
    assert.equal(atLimit.payload?.title.length, 120)

    const overLimit = validateIssueReportDraft(
      {
        category: 'LIGHTING',
        entrance: 2,
        place: 'p'.repeat(201),
        title: 't'.repeat(121),
        description: '',
        urgent: false,
      },
      formMeta,
      false,
    )
    assert.equal(overLimit.valid, false)
    assert.equal(overLimit.errors.place, 'PLACE_TOO_LONG')
    assert.equal(overLimit.errors.title, 'TITLE_TOO_LONG')

    const store = createDefaultIssuesSeed()
    const settings = cloneDefaultAssociationSettings()
    const createOk = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      buildingEntrances: [1, 2],
      userMemberships: [{ apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' }],
      body: { category: 'LIGHTING', entrance: 2, place: 'p'.repeat(200), title: 't'.repeat(120) },
    })
    assert.equal(createOk.ok, true)

    const createTitleTooLong = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      buildingEntrances: [1, 2],
      userMemberships: [{ apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' }],
      body: { category: 'LIGHTING', entrance: 2, place: 'p'.repeat(200), title: 't'.repeat(121) },
    })
    assert.equal(createTitleTooLong.ok, false)
    assert.equal(createTitleTooLong.status, 422)

    const createPlaceTooLong = createIssueInStore({
      issuesStore: store,
      settingsStore: settings,
      user: RESIDENT_APT14,
      buildingEntrances: [1, 2],
      userMemberships: [{ apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' }],
      body: { category: 'LIGHTING', entrance: 2, place: 'p'.repeat(201), title: 'Valid title' },
    })
    assert.equal(createPlaceTooLong.ok, false)
    assert.equal(createPlaceTooLong.status, 422)

    const createdRecord = store.find((item) => item.id === createOk.issue?.id)
    assert.ok(createdRecord)
    const editTitleTooLong = editIssueInStore({
      issue: createdRecord,
      user: RESIDENT_APT14,
      buildingEntrances: [1, 2],
      body: { title: 't'.repeat(121) },
    })
    assert.equal(editTitleTooLong.ok, false)
    assert.equal(editTitleTooLong.status, 422)

    const editPlaceTooLong = editIssueInStore({
      issue: createdRecord,
      user: RESIDENT_APT14,
      buildingEntrances: [1, 2],
      body: { place: 'p'.repeat(201) },
    })
    assert.equal(editPlaceTooLong.ok, false)
    assert.equal(editPlaceTooLong.status, 422)
  })
})

describe('board issue workflow (#013)', () => {
  it('supports include_old=true for board and chairman while ignoring it for residents', () => {
    const nowMs = Date.now()
    const store = createDefaultIssuesSeed(nowMs)

    // Default board list (within 30 days): open + withdrawn (2 issues, excludes 45-day-old resolved issue)
    const defaultBoard = queryIssuesStore(store, CHAIRMAN_USER, {}, nowMs)
    assert.equal(defaultBoard.ok, true)
    assert.equal(defaultBoard.items?.length, 2)

    // Board with include_old=true: includes 45-day-old resolved issue (3 issues)
    const oldBoard = queryIssuesStore(store, CHAIRMAN_USER, { include_old: true }, nowMs)
    assert.equal(oldBoard.ok, true)
    assert.equal(oldBoard.items?.length, 3)

    // Resident passing include_old=true still only sees what resident can see within 30 days
    const residentWithOld = queryIssuesStore(store, RESIDENT_APT14, { include_old: true }, nowMs)
    assert.equal(residentWithOld.ok, true)
    assert.equal(residentWithOld.items?.length, 1)
  })

  it('enforces allowed status transitions, 30-day reopen window, and 409 INVALID_ISSUE_TRANSITION', () => {
    const nowMs = Date.now()
    const store = createDefaultIssuesSeed(nowMs)
    const openIssue = store[0] // REPORTED
    const withdrawnIssue = store[1] // WITHDRAWN
    const oldResolvedIssue = store[2] // RESOLVED 45 days ago

    // Allowed moves for REPORTED
    assert.deepEqual(getAllowedBoardMoves(openIssue, nowMs), [
      'IN_PROGRESS',
      'WAITING_FOR_CONTRACTOR',
      'RESOLVED',
      'DUPLICATE',
      'DECLINED',
    ])
    // WITHDRAWN and >30d ended have no allowed moves
    assert.deepEqual(getAllowedBoardMoves(withdrawnIssue, nowMs), [])
    assert.deepEqual(getAllowedBoardMoves(oldResolvedIssue, nowMs), [])

    // Resident gets 403 FORBIDDEN on status change
    const forbidden = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: RESIDENT_APT14,
      body: { status: 'IN_PROGRESS' },
      nowMs,
    })
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.status, 403)

    // Reporter-only status (REPORTED / WITHDRAWN) returns 422 VALIDATION_ERROR
    const reporterStatus = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: CHAIRMAN_USER,
      body: { status: 'REPORTED' },
      nowMs,
    })
    assert.equal(reporterStatus.ok, false)
    assert.equal(reporterStatus.status, 422)
    assert.equal(reporterStatus.errorCode, 'VALIDATION_ERROR')

    // Move REPORTED -> WAITING_FOR_CONTRACTOR -> RESOLVED
    const move1 = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: CHAIRMAN_USER,
      body: { status: 'WAITING_FOR_CONTRACTOR' },
      nowMs,
    })
    assert.equal(move1.ok, true)
    assert.equal(move1.issue?.status, 'WAITING_FOR_CONTRACTOR')
    assert.equal(move1.issue?.can_edit, false)
    const timelineLenBeforeNoop = move1.issue?.timeline.length

    // Current status again changes nothing (no extra timeline entry)
    const sameStatus = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: CHAIRMAN_USER,
      body: { status: 'WAITING_FOR_CONTRACTOR' },
      nowMs: nowMs + 500,
    })
    assert.equal(sameStatus.ok, true)
    assert.equal(sameStatus.issue?.timeline.length, timelineLenBeforeNoop)

    const move2 = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: BOARD_USER,
      body: { status: 'RESOLVED' },
      nowMs: nowMs + 1000,
    })
    assert.equal(move2.ok, true)
    assert.equal(move2.issue?.status, 'RESOLVED')
    assert.ok(move2.issue?.ended_at)
    assert.equal(canBoardReopenIssue(openIssue, nowMs + 2000), true)

    // Ended issue within 30 days can ONLY move to IN_PROGRESS (Reopen)
    const invalidFromResolved = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: CHAIRMAN_USER,
      body: { status: 'DECLINED' },
      nowMs: nowMs + 2000,
    })
    assert.equal(invalidFromResolved.ok, false)
    assert.equal(invalidFromResolved.status, 409)
    assert.equal(invalidFromResolved.errorCode, 'INVALID_ISSUE_TRANSITION')

    const reopenRes = changeIssueStatusInStore({
      issuesStore: store,
      issue: openIssue,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs: nowMs + 3000,
    })
    assert.equal(reopenRes.ok, true)
    assert.equal(reopenRes.issue?.status, 'IN_PROGRESS')
    assert.equal(reopenRes.issue?.ended_at, null)

    // Cannot reopen WITHDRAWN or >30 days ended issue
    const reopenWithdrawn = changeIssueStatusInStore({
      issuesStore: store,
      issue: withdrawnIssue,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs,
    })
    assert.equal(reopenWithdrawn.ok, false)
    assert.equal(reopenWithdrawn.status, 409)
    assert.equal(reopenWithdrawn.errorCode, 'INVALID_ISSUE_TRANSITION')

    const reopenExpired = changeIssueStatusInStore({
      issuesStore: store,
      issue: oldResolvedIssue,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs,
    })
    assert.equal(reopenExpired.ok, false)
    assert.equal(reopenExpired.status, 409)
    assert.equal(reopenExpired.errorCode, 'INVALID_ISSUE_TRANSITION')
  })

  it('merges followers on DUPLICATE, moves REPORTED original to IN_PROGRESS, and validates duplicate targets', () => {
    const nowMs = Date.now()
    const store = createDefaultIssuesSeed(nowMs)
    const originalIssue = store[0] // REPORTED, followers: [0102, 0104]

    // Create a second open issue reported by Apt 02 (0104) and followed by BOARD_USER (0105)
    const dupCandidate = {
      id: '018f0000-0000-7000-8000-000000000999',
      category: 'LIGHTING',
      entrance: 2,
      place: '3rd floor',
      title: 'Dark corridor on 3rd floor',
      description: 'Light is out',
      status: 'REPORTED',
      urgent: false,
      reporter_user_id: RESIDENT_APT02.user_id,
      apartment_id: '018f0000-0000-7000-8000-000000000302',
      follower_user_ids: [RESIDENT_APT02.user_id, BOARD_USER.user_id],
      duplicate_of: null,
      created_at: new Date(nowMs - 5000).toISOString(),
      updated_at: new Date(nowMs - 5000).toISOString(),
      ended_at: null,
      timeline: [
        {
          action: 'STATUS',
          status: 'REPORTED',
          at: new Date(nowMs - 5000).toISOString(),
          changed_by: { display_label: 'Apt 02 — M. T.', role_badge: 'RESIDENT' },
        },
      ],
    }
    store.push(dupCandidate)

    // Ranking puts same category + entrance open issue first
    const ranked = rankDuplicateCandidates(store, dupCandidate, '')
    assert.equal(ranked[0].id, originalIssue.id)

    // Self-duplicate or WITHDRAWN target returns 422 INVALID_DUPLICATE
    const selfDup = changeIssueStatusInStore({
      issuesStore: store,
      issue: dupCandidate,
      user: CHAIRMAN_USER,
      body: { status: 'DUPLICATE', duplicate_of: dupCandidate.id },
      nowMs,
    })
    assert.equal(selfDup.ok, false)
    assert.equal(selfDup.status, 422)
    assert.equal(selfDup.errorCode, 'INVALID_DUPLICATE')

    const withdrawnDup = changeIssueStatusInStore({
      issuesStore: store,
      issue: dupCandidate,
      user: CHAIRMAN_USER,
      body: { status: 'DUPLICATE', duplicate_of: store[1].id }, // WITHDRAWN
      nowMs,
    })
    assert.equal(withdrawnDup.ok, false)
    assert.equal(withdrawnDup.status, 422)
    assert.equal(withdrawnDup.errorCode, 'INVALID_DUPLICATE')

    // Valid duplicate merge into originalIssue
    const mergeRes = changeIssueStatusInStore({
      issuesStore: store,
      issue: dupCandidate,
      user: CHAIRMAN_USER,
      body: { status: 'DUPLICATE', duplicate_of: originalIssue.id },
      nowMs,
    })
    assert.equal(mergeRes.ok, true)
    assert.equal(mergeRes.issue?.status, 'DUPLICATE')
    assert.equal(mergeRes.issue?.duplicate_of, originalIssue.id)
    assert.ok(mergeRes.issue?.ended_at)

    // Original moved from REPORTED to IN_PROGRESS and gained BOARD_USER (0105) as a follower while deduplicating 0104 (2 -> 3)
    assert.equal(originalIssue.status, 'IN_PROGRESS')
    assert.equal(originalIssue.follower_user_ids.includes(BOARD_USER.user_id), true)
    assert.equal(originalIssue.follower_user_ids.length, 3)

    // Reopening the duplicate within 30 days clears duplicate_of and ended_at
    const reopenDup = changeIssueStatusInStore({
      issuesStore: store,
      issue: dupCandidate,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs: nowMs + 1000,
    })
    assert.equal(reopenDup.ok, true)
    assert.equal(reopenDup.issue?.status, 'IN_PROGRESS')
    assert.equal(reopenDup.issue?.duplicate_of, null)
    assert.equal(reopenDup.issue?.ended_at, null)
  })

  it('clears urgent flag and records URGENT_CLEARED in board action log while hiding it from residents', () => {
    const nowMs = Date.now()
    const store = createDefaultIssuesSeed(nowMs)
    const openIssue = store[0]
    openIssue.urgent = true

    const clearRes = clearIssueUrgentInStore({
      issue: openIssue,
      user: CHAIRMAN_USER,
      nowMs,
    })
    assert.equal(clearRes.ok, true)
    assert.equal(clearRes.issue?.urgent, false)

    // Board sees URGENT_CLEARED and changed_by in timeline
    const boardTimeline = clearRes.issue?.timeline || []
    assert.equal(boardTimeline.some((e: any) => e.action === 'URGENT_CLEARED'), true)
    const urgentEntry = boardTimeline.find((e: any) => e.action === 'URGENT_CLEARED')
    assert.equal(urgentEntry?.changed_by?.role_badge, 'BOARD')

    // Resident view omits URGENT_CLEARED and strips changed_by
    const residentView = toIssueView(openIssue, RESIDENT_APT14)
    assert.equal(residentView.timeline.some((e: any) => e.action === 'URGENT_CLEARED'), false)
    assert.equal(residentView.timeline.every((e: any) => e.changed_by === null), true)
  })
})

function buildMinimalJpegBytes(width = 800, height = 600): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // segment length 11
    0x08, // 8-bit precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01,
    0x01, 0x11, 0x00,
    0xff, 0xd9, // EOI
  ])
}

describe('issue photos (#020) and retention notices (#021)', () => {
  it('enforces photo upload validation, 3-photo limit, idempotency, privacy, and delete permissions', () => {
    const nowMs = Date.now()
    const store = createDefaultIssuesSeed(nowMs)
    const issue = store[0] // Reported by RESIDENT_APT14
    const idem = new Map()
    const jpeg = buildMinimalJpegBytes(2400, 1800)

    // Non-reporter neighbor cannot upload
    const forbidden = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT02,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(forbidden.ok, false)
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.errorCode, 'FORBIDDEN')

    // Simulated uploadsDisabled rejects with 403 UPLOADS_DISABLED
    const disabled = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
      uploadsDisabled: true,
    })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.status, 403)
    assert.equal(disabled.errorCode, 'UPLOADS_DISABLED')
    assert.equal(toIssueView(issue, RESIDENT_APT14, { uploadsDisabled: true }).can_add_photo, false)

    // Missing Content-Length -> 411 LENGTH_REQUIRED
    const missingLen = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: null,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(missingLen.status, 411)
    assert.equal(missingLen.errorCode, 'LENGTH_REQUIRED')

    // > 4 MB -> 413 FILE_TOO_LARGE
    const tooLarge = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: 4 * 1024 * 1024 + 1,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(tooLarge.status, 413)
    assert.equal(tooLarge.errorCode, 'FILE_TOO_LARGE')

    // Non-JPEG mime or bytes -> 415 UNSUPPORTED_MEDIA_TYPE
    const wrongMime = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentType: 'image/png',
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(wrongMime.status, 415)
    assert.equal(wrongMime.errorCode, 'UNSUPPORTED_MEDIA_TYPE')

    // Invalid JPEG structure -> 422 INVALID_IMAGE
    const corrupt = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      contentLength: 4,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(corrupt.status, 422)
    assert.equal(corrupt.errorCode, 'INVALID_IMAGE')

    // > 2560 px -> 422 IMAGE_TOO_LARGE
    const overDim = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: buildMinimalJpegBytes(3000, 2000),
      contentLength: 17,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(overDim.status, 422)
    assert.equal(overDim.errorCode, 'IMAGE_TOO_LARGE')

    // Upload 1 with UUID Idempotency-Key succeeds (201) and clamps display dims <= 1920
    const key1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const up1 = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: key1,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(up1.ok, true)
    assert.equal(up1.status, 201)
    assert.equal(up1.photo?.width, 1920)
    assert.equal(up1.photo?.height, 1440)
    assert.equal('uploader_user_id' in (up1.photo || {}), false)

    // Replay with same key returns 200 with existing photo
    const replay = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: key1,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(replay.ok, true)
    assert.equal(replay.status, 200)
    assert.equal(replay.photo?.id, up1.photo?.id)
    assert.equal(issue.photos.length, 1)

    // Same key on another issue -> 409 IDEMPOTENCY_KEY_REUSED
    const otherIssue = store[2]
    const reusedOther = addIssuePhotoInStore({
      issue: otherIssue,
      user: CHAIRMAN_USER,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: key1,
      idempotencyStore: idem,
      nowMs,
    })
    // Different user scopes idempotency per user, so test same user (RESIDENT_APT14)
    const ownSecond = createIssueInStore({
      issuesStore: store,
      settingsStore: cloneDefaultAssociationSettings(),
      user: RESIDENT_APT14,
      userMemberships: [{ apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' }],
      body: { category: 'CLEANING', entrance: 2, title: 'Another issue by Apt 14' },
      nowMs,
    })
    assert.equal(ownSecond.ok, true)
    const reusedSameUser = addIssuePhotoInStore({
      issue: ownSecond.rawIssue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: key1,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(reusedSameUser.status, 409)
    assert.equal(reusedSameUser.errorCode, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(reusedOther.status, 409) // otherIssue is RESOLVED -> ISSUE_ENDED

    // Fill up to MAX_ISSUE_PHOTOS (3); 4th returns 409 PHOTO_LIMIT_REACHED
    const up2 = addIssuePhotoInStore({
      issue,
      user: CHAIRMAN_USER,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
    })
    const up3 = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(up2.ok, true)
    assert.equal(up3.ok, true)
    assert.equal(issue.photos.length, MAX_ISSUE_PHOTOS)
    assert.equal(toIssueView(issue, RESIDENT_APT14).can_add_photo, false)

    const overLimit = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(overLimit.status, 409)
    assert.equal(overLimit.errorCode, 'PHOTO_LIMIT_REACHED')

    // Check mine/can_delete flags per viewer
    const neighborView = toIssueView(issue, RESIDENT_APT02)
    assert.equal(neighborView.photos.every((p: any) => !p.mine && !p.can_delete), true)

    const chairmanView = toIssueView(issue, CHAIRMAN_USER)
    assert.equal(chairmanView.photos[0].mine, false)
    assert.equal(chairmanView.photos[0].can_delete, true)
    assert.equal(chairmanView.photos[1].mine, true)
    assert.equal(chairmanView.photos[1].can_delete, true)

    // Delete & fetch 404 + reusing deleted idempotency key -> 409 IDEMPOTENCY_KEY_REUSED
    const neighborDel = deleteIssuePhotoInStore({
      issue,
      user: RESIDENT_APT02,
      photoId: up1.photo!.id,
      idempotencyStore: idem,
    })
    assert.equal(neighborDel.status, 403)

    const reporterDel = deleteIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      photoId: up1.photo!.id,
      idempotencyStore: idem,
    })
    assert.equal(reporterDel.ok, true)

    const missingGet = getIssuePhotoFromStore({ issue, photoId: up1.photo!.id, variant: 'thumb' })
    assert.equal(missingGet.status, 404)
    assert.equal(missingGet.errorCode, 'PHOTO_NOT_FOUND')

    const reuseAfterDelete = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: key1,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(reuseAfterDelete.status, 409)
    assert.equal(reuseAfterDelete.errorCode, 'UPLOAD_REMOVED')
  })

  it('computes photos_delete_at on RESOLVED issues and immediately deletes photos on WITHDRAWN/DECLINED/DUPLICATE (#021)', () => {
    const nowMs = Date.UTC(2026, 10, 1, 12, 0, 0)
    const store = createDefaultIssuesSeed(nowMs)
    const jpeg = buildMinimalJpegBytes(800, 600)

    const memberships = [
      { apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' },
    ]
    const created1 = createIssueInStore({
      issuesStore: store,
      settingsStore: cloneDefaultAssociationSettings(),
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'LIFT', entrance: 1, title: 'Lift button stuck' },
      nowMs,
    })
    const issue1 = created1.rawIssue
    addIssuePhotoInStore({ issue: issue1, user: RESIDENT_APT14, bytes: jpeg, contentLength: jpeg.byteLength, nowMs })
    assert.equal(toIssueView(issue1, RESIDENT_APT14).photos_delete_at, null)

    // Resolving sets photos_delete_at to ended_at + 30 days
    const resolved = changeIssueStatusInStore({
      issuesStore: store,
      issue: issue1,
      user: CHAIRMAN_USER,
      body: { status: 'RESOLVED' },
      nowMs: nowMs + 1000,
    })
    assert.equal(resolved.ok, true)
    assert.equal(
      resolved.issue?.photos_delete_at,
      new Date(nowMs + 1000 + THIRTY_DAYS_MS).toISOString(),
    )
    // Uploader can no longer delete on resolved issue, board still can
    assert.equal(resolved.issue?.photos[0].can_delete, true)
    assert.equal(toIssueView(issue1, RESIDENT_APT14).photos[0].can_delete, false)

    // Reopen clears photos_delete_at and preserves photo
    const reopened = changeIssueStatusInStore({
      issuesStore: store,
      issue: issue1,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs: nowMs + 2000,
    })
    assert.equal(reopened.issue?.photos.length, 1)
    assert.equal(reopened.issue?.photos_delete_at, null)

    // Declining immediately deletes photos, never restored on reopen
    const declined = changeIssueStatusInStore({
      issuesStore: store,
      issue: issue1,
      user: CHAIRMAN_USER,
      body: { status: 'DECLINED' },
      nowMs: nowMs + 3000,
    })
    assert.deepEqual(declined.issue?.photos, [])
    assert.equal(declined.issue?.photos_delete_at, null)

    const reopenedDeclined = changeIssueStatusInStore({
      issuesStore: store,
      issue: issue1,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs: nowMs + 4000,
    })
    assert.deepEqual(reopenedDeclined.issue?.photos, [])

    // Resolving an issue WITHOUT photos leaves photos_delete_at as null
    const emptyResolved = changeIssueStatusInStore({
      issuesStore: store,
      issue: issue1,
      user: CHAIRMAN_USER,
      body: { status: 'RESOLVED' },
      nowMs: nowMs + 5000,
    })
    assert.equal(emptyResolved.issue?.photos_delete_at, null)

    // Withdrawing immediately deletes photos
    const created2 = createIssueInStore({
      issuesStore: store,
      settingsStore: cloneDefaultAssociationSettings(),
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'YARD', entrance: null, title: 'Broken bench' },
      nowMs: nowMs + 6000,
    })
    addIssuePhotoInStore({ issue: created2.rawIssue, user: RESIDENT_APT14, bytes: jpeg, contentLength: jpeg.byteLength, nowMs })
    const withdrawn = withdrawIssueInStore({
      issue: created2.rawIssue,
      user: RESIDENT_APT14,
      nowMs: nowMs + 7000,
    })
    assert.deepEqual(withdrawn.issue?.photos, [])
    assert.equal(withdrawn.issue?.photos_delete_at, null)

    // Marking DUPLICATE immediately deletes duplicate's photos (never copied to original)
    const created3 = createIssueInStore({
      issuesStore: store,
      settingsStore: cloneDefaultAssociationSettings(),
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'CLEANING', entrance: 2, title: 'Dirty stairwell' },
      nowMs: nowMs + 8000,
    })
    const rawIssue3 = created3.rawIssue!
    assert.ok(rawIssue3)
    addIssuePhotoInStore({ issue: rawIssue3, user: RESIDENT_APT14, bytes: jpeg, contentLength: jpeg.byteLength, nowMs })
    const dupTarget = store.find((item) => item.id !== rawIssue3.id && isIssueOpen(item.status))!
    assert.ok(dupTarget)
    const dupTargetPhotosBefore = dupTarget.photos?.length || 0
    const duplicated = changeIssueStatusInStore({
      issuesStore: store,
      issue: rawIssue3,
      user: CHAIRMAN_USER,
      body: { status: 'DUPLICATE', duplicate_of: dupTarget.id },
      nowMs: nowMs + 9000,
    })
    assert.equal(duplicated.ok, true)
    assert.deepEqual(duplicated.issue?.photos, [])
    assert.equal(duplicated.issue?.photos_delete_at, null)
    assert.equal(dupTarget.photos?.length || 0, dupTargetPhotosBefore)
  })

  it('tracks can_add_photo matrix, restores slot after deletion, enforces 30-day reopen window, accepts JPEG charset param, and strips private uploader fields', () => {
    const nowMs = Date.UTC(2026, 10, 1, 10, 0, 0)
    const store = createDefaultIssuesSeed(nowMs)
    const memberships = [
      { apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' },
    ]
    const created = createIssueInStore({
      issuesStore: store,
      settingsStore: cloneDefaultAssociationSettings(),
      user: RESIDENT_APT14,
      userMemberships: memberships,
      body: { category: 'DOORS_AND_LOCKS', entrance: 1, title: 'Entrance door closer broken' },
      nowMs,
    })
    const issue = created.rawIssue!
    const jpeg = buildMinimalJpegBytes(1024, 768)

    // Reporter and Board/Chairman have can_add_photo=true when open & <3; neighbor has false
    assert.equal(toIssueView(issue, RESIDENT_APT14).can_add_photo, true)
    assert.equal(toIssueView(issue, CHAIRMAN_USER).can_add_photo, true)
    assert.equal(toIssueView(issue, BOARD_USER).can_add_photo, true)
    assert.equal(toIssueView(issue, RESIDENT_APT02).can_add_photo, false)

    // Content-Type with charset parameter accepted cleanly
    const p1 = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentType: 'image/jpeg; charset=binary',
      contentLength: jpeg.byteLength,
      nowMs,
    })
    const p2 = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      nowMs: nowMs + 1000,
    })
    const p3 = addIssuePhotoInStore({
      issue,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      nowMs: nowMs + 2000,
    })
    assert.equal(p1.ok && p2.ok && p3.ok, true)
    assert.equal(toIssueView(issue, RESIDENT_APT14).can_add_photo, false)

    // Deleting 1 of 3 restores can_add_photo=true
    const del = deleteIssuePhotoInStore({ issue, user: RESIDENT_APT14, photoId: p2.photo!.id })
    assert.equal(del.ok, true)
    assert.equal(toIssueView(issue, RESIDENT_APT14).can_add_photo, true)

    // Summary & Detail views strip uploader_user_id and raw bytes across all roles
    const queryRes = queryIssuesStore(store, RESIDENT_APT02, {}, nowMs)
    const listedIssue = (queryRes.items || []).find((it: any) => it.id === issue.id)
    assert.ok(listedIssue)
    assert.equal(listedIssue.photos.length, 2)
    for (const ph of listedIssue.photos) {
      assert.equal('uploader_user_id' in ph, false)
      assert.equal('bytes' in ph, false)
      assert.equal(ph.mine, false)
      assert.equal(ph.can_delete, false)
    }

    // Resolve issue -> 29 days later canBoardReopenIssue is still true and keeps photos
    changeIssueStatusInStore({
      issuesStore: store,
      issue,
      user: CHAIRMAN_USER,
      body: { status: 'RESOLVED' },
      nowMs: nowMs + 5000,
    })
    assert.equal(toIssueView(issue, CHAIRMAN_USER).can_add_photo, false)
    assert.equal(canBoardReopenIssue(issue, nowMs + 5000 + 29 * 24 * 3600 * 1000), true)
    assert.equal(canBoardReopenIssue(issue, nowMs + 5000 + 31 * 24 * 3600 * 1000), false)

    const reopenedDay29 = changeIssueStatusInStore({
      issuesStore: store,
      issue,
      user: CHAIRMAN_USER,
      body: { status: 'IN_PROGRESS' },
      nowMs: nowMs + 5000 + 29 * 24 * 3600 * 1000,
    })
    assert.equal(reopenedDay29.ok, true)
    assert.equal(reopenedDay29.issue?.photos.length, 2)
    assert.equal(reopenedDay29.issue?.photos_delete_at, null)
  })

  it('enforces #025 server answers: UPLOAD_REMOVED on ended/discarded issues, contentLength collision IDEMPOTENCY_KEY_REUSED, 24h daily limit (board exempt), and 507 quota reasons', () => {
    const nowMs = Date.UTC(2026, 10, 10, 9, 0, 0)
    const store = createDefaultIssuesSeed(nowMs)
    const memberships = [
      { apartment_id: '018f0000-0000-7000-8000-000000000314', apartment_number: '14' },
    ]
    const jpeg = buildMinimalJpegBytes(800, 600)
    const idem = new Map()
    const dailyStore: Array<{ userId: string; bytes: number; atMs: number }> = []

    const settingsStore = cloneDefaultAssociationSettings()
    const limitSetting = settingsStore.find((s) => s.key === 'issues.reports_per_apartment_per_day')
    if (limitSetting) limitSetting.value = 20

    const createForResident = (title: string) =>
      createIssueInStore({
        issuesStore: store,
        settingsStore,
        user: RESIDENT_APT14,
        userMemberships: memberships,
        body: { category: 'LIGHTING', entrance: 1, title },
        nowMs,
      }).rawIssue!

    // 1) Resolved keeps photo -> replay returns 200; mismatched contentLength returns 409 IDEMPOTENCY_KEY_REUSED
    const issueResolved = createForResident('Hallway lamp out')
    const keyResolved = '11111111-1111-4111-8111-111111111111'
    const upRes = addIssuePhotoInStore({
      issue: issueResolved,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentType: 'image/pjpeg',
      contentLength: jpeg.byteLength,
      idempotencyKey: keyResolved,
      idempotencyStore: idem,
      dailyUploadsStore: dailyStore,
      nowMs,
    })
    assert.equal(upRes.ok, true)

    const mismatchReplay = addIssuePhotoInStore({
      issue: issueResolved,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength + 10,
      idempotencyKey: keyResolved,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(mismatchReplay.status, 409)
    assert.equal(mismatchReplay.errorCode, 'IDEMPOTENCY_KEY_REUSED')

    changeIssueStatusInStore({
      issuesStore: store,
      issue: issueResolved,
      user: CHAIRMAN_USER,
      body: { status: 'RESOLVED' },
      nowMs: nowMs + 1000,
    })
    const replayAfterResolve = addIssuePhotoInStore({
      issue: issueResolved,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: keyResolved,
      idempotencyStore: idem,
      nowMs: nowMs + 2000,
    })
    assert.equal(replayAfterResolve.ok, true)
    assert.equal(replayAfterResolve.status, 200)

    // 2) Declined, Duplicate, and Withdrawn destroy photos -> replay returns 409 UPLOAD_REMOVED
    for (const mode of ['DECLINED', 'DUPLICATE', 'WITHDRAWN'] as const) {
      const targetIssue = createForResident(`Issue for ${mode}`)
      const key = `22222222-2222-4222-8222-00000000000${mode === 'DECLINED' ? '1' : mode === 'DUPLICATE' ? '2' : '3'}`
      const uploaded = addIssuePhotoInStore({
        issue: targetIssue,
        user: RESIDENT_APT14,
        bytes: jpeg,
        contentLength: jpeg.byteLength,
        idempotencyKey: key,
        idempotencyStore: idem,
        nowMs,
      })
      assert.equal(uploaded.ok, true)
      if (mode === 'WITHDRAWN') {
        withdrawIssueInStore({ issue: targetIssue, user: RESIDENT_APT14, nowMs: nowMs + 500 })
      } else if (mode === 'DUPLICATE') {
        const dupOrig = store.find((it) => it.id !== targetIssue.id && isIssueOpen(it.status))!
        const dupRes = changeIssueStatusInStore({
          issuesStore: store,
          issue: targetIssue,
          user: CHAIRMAN_USER,
          body: { status: 'DUPLICATE', duplicate_of: dupOrig.id },
          nowMs: nowMs + 500,
        })
        assert.equal(dupRes.ok, true)
      } else {
        changeIssueStatusInStore({
          issuesStore: store,
          issue: targetIssue,
          user: CHAIRMAN_USER,
          body: { status: 'DECLINED' },
          nowMs: nowMs + 500,
        })
      }
      const replayRemoved = addIssuePhotoInStore({
        issue: targetIssue,
        user: RESIDENT_APT14,
        bytes: jpeg,
        contentLength: jpeg.byteLength,
        idempotencyKey: key,
        idempotencyStore: idem,
        nowMs: nowMs + 1000,
      })
      assert.equal(replayRemoved.status, 409)
      assert.equal(replayRemoved.errorCode, 'UPLOAD_REMOVED')
    }

    // 3) Daily limit blocks resident once threshold exceeded, resets after 24h, exempts CHAIRMAN/BOARD
    const issueDaily = createForResident('Daily quota issue')
    const isolatedDailyStore: Array<{ userId: string; bytes: number; atMs: number }> = []
    const smallLimit = jpeg.byteLength * 2 - 1
    const r1 = addIssuePhotoInStore({
      issue: issueDaily,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      dailyUploadsStore: isolatedDailyStore,
      dailyUserLimitBytes: smallLimit,
      nowMs,
    })
    assert.equal(r1.ok, true)

    const rBlocked = addIssuePhotoInStore({
      issue: issueDaily,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      dailyUploadsStore: isolatedDailyStore,
      dailyUserLimitBytes: smallLimit,
      nowMs: nowMs + 10_000,
    })
    assert.equal(rBlocked.status, 429)
    assert.equal(rBlocked.errorCode, 'RATE_LIMITED')
    assert.equal(rBlocked.extra?.reason, 'DAILY_LIMIT')
    assert.ok((rBlocked.extra?.retry_after_seconds || 0) > 86000)

    const rAfter24h = addIssuePhotoInStore({
      issue: issueDaily,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      dailyUploadsStore: isolatedDailyStore,
      dailyUserLimitBytes: smallLimit,
      nowMs: nowMs + 24 * 60 * 60 * 1000 + 1000,
    })
    assert.equal(rAfter24h.ok, true)

    const boardExempt = addIssuePhotoInStore({
      issue: issueDaily,
      user: BOARD_USER,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      dailyUploadsStore: [{ userId: BOARD_USER.user_id, bytes: 50_000_000, atMs: nowMs }],
      dailyUserLimitBytes: 100,
      nowMs: nowMs + 10_000,
    })
    assert.equal(boardExempt.ok, true)

    // 4) 507 STORAGE_QUOTA_EXCEEDED with QUOTA and DELETIONS_PENDING
    const issueQuota = createForResident('Quota check issue')
    const quotaFail = addIssuePhotoInStore({
      issue: issueQuota,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      storageStats: { photosUsedBytes: 90, photosLimitBytes: 100, pendingDeletionBytes: 0, quotaBytes: 200 },
      nowMs,
    })
    assert.equal(quotaFail.status, 507)
    assert.equal(quotaFail.errorCode, 'STORAGE_QUOTA_EXCEEDED')
    assert.equal(quotaFail.extra?.reason, 'QUOTA')
    assert.equal(quotaFail.extra?.category, 'photos')

    const pendingFail = addIssuePhotoInStore({
      issue: issueQuota,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      storageStats: { photosUsedBytes: 0, photosLimitBytes: 100, pendingDeletionBytes: 190, quotaBytes: 200 },
      nowMs,
    })
    assert.equal(pendingFail.status, 507)
    assert.equal(pendingFail.errorCode, 'STORAGE_QUOTA_EXCEEDED')
    assert.equal(pendingFail.extra?.reason, 'DELETIONS_PENDING')

    // 5) Strict API.md check order: route rules (403, 409) -> Content-Type/Length -> demo mode -> quota
    const issuePreflight = createForResident('Preflight order issue')
    const keyPre = '22222222-2222-4222-8222-222222222222'
    const firstPre = addIssuePhotoInStore({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength,
      idempotencyKey: keyPre,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(firstPre.ok, true)

    // Missing Content-Length on a NEW upload -> 411 LENGTH_REQUIRED
    const missingLenNew = checkIssuePhotoUploadPreflight({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      contentType: 'image/jpeg',
      contentLength: null,
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(missingLenNew.ok, false)
    assert.equal(missingLenNew.status, 411)
    assert.equal(missingLenNew.errorCode, 'LENGTH_REQUIRED')

    // Bad MIME overrides 411/413/UPLOADS_DISABLED
    const badMimePreflight = checkIssuePhotoUploadPreflight({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      contentType: 'image/png',
      contentLength: null,
      uploadsDisabled: true,
      nowMs,
    })
    assert.equal(badMimePreflight.status, 415)
    assert.equal(badMimePreflight.errorCode, 'UNSUPPORTED_MEDIA_TYPE')

    // Closed issue overrides UPLOADS_DISABLED and Content-Length/Type (route rules first)
    const closedIssue = createForResident('Closed order issue')
    closedIssue.status = 'RESOLVED'
    const closedFirst = checkIssuePhotoUploadPreflight({
      issue: closedIssue,
      user: RESIDENT_APT14,
      contentType: 'image/png',
      contentLength: null,
      uploadsDisabled: true,
      nowMs,
    })
    assert.equal(closedFirst.status, 409)
    assert.equal(closedFirst.errorCode, 'ISSUE_ENDED')

    // Whitespace-only Idempotency-Key -> 422 VALIDATION_ERROR
    const whitespaceKey = checkIssuePhotoUploadPreflight({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      contentType: 'image/jpeg',
      contentLength: jpeg.byteLength,
      idempotencyKey: '   ',
      nowMs,
    })
    assert.equal(whitespaceKey.status, 422)
    assert.equal(whitespaceKey.errorCode, 'VALIDATION_ERROR')

    // Same length + same key + different payload bytes -> 409 IDEMPOTENCY_KEY_REUSED
    const altSameLenJpeg = new Uint8Array(jpeg)
    altSameLenJpeg[altSameLenJpeg.length - 3] ^= 0x01
    const digestCollision = addIssuePhotoInStore({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      bytes: altSameLenJpeg,
      contentLength: altSameLenJpeg.byteLength,
      idempotencyKey: keyPre,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(digestCollision.ok, false)
    assert.equal(digestCollision.status, 409)
    assert.equal(digestCollision.errorCode, 'IDEMPOTENCY_KEY_REUSED')

    // Actual body longer or shorter than declared Content-Length
    const bodyLonger = addIssuePhotoInStore({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength - 2,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(bodyLonger.status, 413)
    assert.equal(bodyLonger.errorCode, 'FILE_TOO_LARGE')

    const bodyShorter = addIssuePhotoInStore({
      issue: issuePreflight,
      user: RESIDENT_APT14,
      bytes: jpeg,
      contentLength: jpeg.byteLength + 10,
      idempotencyStore: idem,
      nowMs,
    })
    assert.equal(bodyShorter.status, 400)
    assert.equal(bodyShorter.errorCode, 'UPLOAD_INTERRUPTED')
  })
})




