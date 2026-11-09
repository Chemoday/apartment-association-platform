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

