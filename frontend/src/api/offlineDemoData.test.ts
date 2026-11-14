import test from 'node:test'
import assert from 'node:assert/strict'
import { apiRequest, setDemoUser } from './client.js'
import {
  disableOfflineDemo,
  enableOfflineDemo,
  isOfflineDemoMode,
  resolveOfflineDemoRequest,
} from './offlineDemoData.js'

test('offline demo responder serves demo users, building metadata, dashboard, matrix, and posts without network calls', async () => {
  enableOfflineDemo()
  assert.equal(isOfflineDemoMode.value, true)

  const users = await apiRequest('/demo/users')
  assert.ok(Array.isArray(users))
  assert.equal(users.length, 5)

  // Switch to Owner Apt 14
  setDemoUser('018f0000-0000-7000-8000-000000000102')
  const me = await apiRequest('/property/me')
  assert.equal(me.building_role, 'USER')
  assert.equal(me.memberships[0].apartment_number, '14')

  const building = await apiRequest('/property/building')
  assert.equal(building.name, 'KÜ Sõpruse 12')

  const dashboard = await apiRequest('/meters/my-dashboard')
  assert.equal(dashboard.period.period_code, '2026-10')
  assert.equal(dashboard.apartments.length, 1)
  assert.equal(dashboard.apartments[0].apartment_number, '14')
  assert.equal(dashboard.apartments[0].can_submit_readings, true)

  // Switch to Chairman role and inspect matrix
  setDemoUser('018f0000-0000-7000-8000-000000000101')
  const chairmanMe = await apiRequest('/property/me')
  assert.equal(chairmanMe.building_role, 'CHAIRMAN')

  const matrix = await apiRequest('/meters/periods/2026-10/matrix')
  assert.equal(matrix.period.period_code, '2026-10')
  assert.equal(matrix.apartments.length, 5)
  assert.equal(matrix.balances.length, 2)

  const notices = await resolveOfflineDemoRequest(
    '/communication/posts?post_type=OFFICIAL_NOTICE',
    { method: 'GET' },
  )
  assert.ok(Array.isArray(notices))
  assert.ok(notices.length >= 2)

  // Normal forum feed never contains BOARD_TOPIC or APARTMENT_THREAD
  const forumFeed = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(
    forumFeed.some((p: any) => p.post_type === 'BOARD_TOPIC' || p.post_type === 'APARTMENT_THREAD'),
    false,
  )

  // Chairman and Board see the seeded BOARD_TOPIC by full name (Oleg Sidorov -> Peeter Saar)
  const boardTopics = await resolveOfflineDemoRequest(
    '/communication/posts?post_type=BOARD_TOPIC',
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
    },
  )
  assert.equal(boardTopics.length >= 2, true)
  const manualTopic = boardTopics.find(
    (t: any) => t.title === 'Where the keys to the basement and the roof are',
  )
  assert.ok(manualTopic)
  assert.equal(manualTopic.author_badge.display_label, 'Oleg Sidorov')
  assert.equal(manualTopic.origin, null)

  const automaticTopic = boardTopics.find((t: any) => t.origin === 'MAINTENANCE')
  assert.ok(automaticTopic)
  assert.equal(automaticTopic.post_type, 'BOARD_TOPIC')
  assert.equal(automaticTopic.origin, 'MAINTENANCE')

  const boardTopicDetail = await resolveOfflineDemoRequest(
    `/communication/posts/${manualTopic.id}`,
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000105',
    },
  )
  assert.equal(boardTopicDetail.comments.length, 1)
  assert.equal(boardTopicDetail.comments[0].author_badge.display_label, 'Peeter Saar')

  // Resident cannot access BOARD_TOPIC (gets 404 POST_NOT_FOUND)
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${boardTopics[0].id}`, {
        method: 'GET',
        actingUserId: '018f0000-0000-7000-8000-000000000102',
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )

  // Governance Polls (#007): Owner Apt 14 sees "Spring clean-up in the yard" as can_answer=true, answered=false
  const ownerPolls = await resolveOfflineDemoRequest('/governance/polls', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.ok(Array.isArray(ownerPolls))
  const springPoll = ownerPolls.find((p: any) => p.title === 'Spring clean-up in the yard')
  assert.ok(springPoll)
  assert.equal(springPoll.status, 'OPEN')
  assert.equal(springPoll.can_answer, true)
  assert.equal(springPoll.answered, false)

  // Tenant Apt 02 sees owners-only poll with can_answer=false
  const tenantPolls = await resolveOfflineDemoRequest('/governance/polls', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000104',
  })
  const ownersOnlyPoll = tenantPolls.find((p: any) => p.eligibility === 'OWNERS')
  assert.ok(ownersOnlyPoll)
  assert.equal(ownersOnlyPoll.can_answer, false)

  // Owner Apt 14 submits a ballot on "Spring clean-up in the yard" and updates it
  const springDetailBefore = await resolveOfflineDemoRequest(
    `/governance/polls/${springPoll.id}`,
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
    },
  )
  assert.equal(springDetailBefore.questions.length, 2)
  assert.equal(springDetailBefore.my_ballots.length, 0)

  const firstOptionId = springDetailBefore.questions[0].options[0].id
  const afterBallot = await resolveOfflineDemoRequest(
    `/governance/polls/${springPoll.id}/ballot`,
    {
      method: 'PUT',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
      body: {
        answers: [
          {
            question_id: springDetailBefore.questions[0].id,
            option_ids: [firstOptionId],
          },
          {
            question_id: springDetailBefore.questions[1].id,
            value: 'Happy to help with hedge trimming!',
          },
        ],
      },
    },
  )
  assert.equal(afterBallot.my_ballots.length, 1)
  assert.equal(afterBallot.my_ballots[0].apartment_id, '018f0000-0000-7000-8000-000000000314')
  assert.equal(afterBallot.my_ballots[0].answers.length, 2)

  // #008 Board poll draft & lifecycle:
  // Resident never sees DRAFT polls
  assert.equal(
    ownerPolls.some((p: any) => p.status === 'DRAFT'),
    false,
  )

  // Board sees the seeded DRAFT poll
  const boardPolls = await resolveOfflineDemoRequest('/governance/polls', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(
    boardPolls.some((p: any) => p.status === 'DRAFT'),
    true,
  )

  // Board creates a draft targeted to empty Apartment 05 -> opening fails with 422 POLL_HAS_NO_ELECTORATE
  const emptyAptDraft = await resolveOfflineDemoRequest('/governance/polls', {
    method: 'POST',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
    body: {
      title: 'Empty apt test poll',
      description: '',
      target_scope: 'APARTMENT_LIST',
      target_apartment_ids: ['018f0000-0000-7000-8000-000000000305'],
      eligibility: 'RESIDENTS',
      unit: 'APARTMENT',
      closes_at: '2027-05-10T20:59:59Z',
      questions: [
        {
          text: 'Yes or no?',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'TEXT',
          required: true,
          options: ['Yes', 'No'],
        },
      ],
    },
  })
  assert.equal(emptyAptDraft.status, 'DRAFT')

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/governance/polls/${emptyAptDraft.id}/open`, {
        method: 'POST',
        actingUserId: '018f0000-0000-7000-8000-000000000101',
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'POLL_HAS_NO_ELECTORATE',
  )

  // Board updates the draft to ALL_BUILDING, opens it, extends its deadline, and closes it
  const updatedDraft = await resolveOfflineDemoRequest(
    `/governance/polls/${emptyAptDraft.id}`,
    {
      method: 'PUT',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
      body: {
        title: 'Building-wide test poll',
        description: 'Updated description',
        target_scope: 'ALL_BUILDING',
        eligibility: 'RESIDENTS',
        unit: 'APARTMENT',
        closes_at: '2027-05-10T20:59:59Z',
        questions: [
          {
            text: 'Yes or no?',
            answer_mode: 'SINGLE_CHOICE',
            value_type: 'TEXT',
            required: true,
            options: ['Yes', 'No'],
          },
        ],
      },
    },
  )
  assert.equal(updatedDraft.title, 'Building-wide test poll')
  assert.equal(updatedDraft.target_scope, 'ALL_BUILDING')

  const openedPoll = await resolveOfflineDemoRequest(
    `/governance/polls/${emptyAptDraft.id}/open`,
    {
      method: 'POST',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
    },
  )
  assert.equal(openedPoll.status, 'OPEN')

  const extendedPoll = await resolveOfflineDemoRequest(
    `/governance/polls/${emptyAptDraft.id}`,
    {
      method: 'PATCH',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
      body: { closes_at: '2027-06-15T20:59:59Z' },
    },
  )
  assert.equal(extendedPoll.closes_at, '2027-06-15T20:59:59Z')

  const closedPoll = await resolveOfflineDemoRequest(
    `/governance/polls/${emptyAptDraft.id}/close`,
    {
      method: 'POST',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
    },
  )
  assert.equal(closedPoll.status, 'CLOSED')
  assert.equal(closedPoll.results_available, true)

  // #009 Poll results:
  // 1. Open poll ("Spring clean-up in the yard"): results_available is false for resident, true for board
  const springForResident = await resolveOfflineDemoRequest(
    `/governance/polls/${springPoll.id}`,
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
    },
  )
  assert.equal(springForResident.results_available, false)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/governance/polls/${springPoll.id}/results`, {
        method: 'GET',
        actingUserId: '018f0000-0000-7000-8000-000000000102',
      }),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'RESULTS_NOT_AVAILABLE' &&
      err?.payload?.status === 'OPEN',
  )

  const springResultsForBoard = await resolveOfflineDemoRequest(
    `/governance/polls/${springPoll.id}/results`,
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
    },
  )
  assert.equal(springResultsForBoard.status, 'OPEN')
  assert.equal(springResultsForBoard.participation.answered, 2)
  assert.equal(springResultsForBoard.participation.electorate, 5)
  assert.equal(springResultsForBoard.questions[0].answered, 2)
  assert.equal(springResultsForBoard.questions[0].options[0].count, 2)
  // Board sees free-text answers in alphabetical order without authors
  assert.deepEqual(springResultsForBoard.questions[1].texts, [
    { value: 'Happy to help with hedge trimming!', count: 1 },
    { value: 'We can bring two rakes and heavy-duty garden waste bags.', count: 1 },
  ])

  // 2. Closed poll ("Stairwell LED lighting & motion sensor schedule"): resident can view results
  const closedLedResults = await resolveOfflineDemoRequest(
    '/governance/polls/018f0000-0000-7000-8000-000000000853/results',
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
    },
  )
  assert.equal(closedLedResults.status, 'CLOSED')
  assert.equal(closedLedResults.participation.answered, 2)
  assert.equal(closedLedResults.questions[0].options[0].count, 2)
  assert.equal(closedLedResults.questions[0].options[1].count, 0)

  // 3. Cancelled poll returns 409 RESULTS_NOT_AVAILABLE with status CANCELLED even for board
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/governance/polls/018f0000-0000-7000-8000-000000000854/results',
        {
          method: 'GET',
          actingUserId: '018f0000-0000-7000-8000-000000000101',
        },
      ),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'RESULTS_NOT_AVAILABLE' &&
      err?.payload?.status === 'CANCELLED',
  )

  // #010, #014, #018 & #024 Poll, Issue, Maintenance & Storage Notifications & Preferences:
  // 1. Preferences matrix returns 52 cells (13 event types x 4 channels) with POLL_OPENED enabled by default and non-mandatory
  const prefsResp = await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(prefsResp.preferences.length, 52)
  const pollOpenedPrefs = prefsResp.preferences.filter((p: any) => p.event_type === 'POLL_OPENED')
  assert.equal(pollOpenedPrefs.length, 4)
  assert.equal(
    pollOpenedPrefs.every((p: any) => p.enabled === true && p.mandatory === false),
    true,
  )

  // 2. When Chairman (0101) opened `emptyAptDraft` above (as ALL_BUILDING, RESIDENTS),
  //    eligible voters (Owner Apt 14 [0102], Tenant Apt 02 [0104], Board Member Apt 09 [0105])
  //    received a POLL_OPENED notification with subject_id === emptyAptDraft.id,
  //    while the opener (Chairman [0101]) and Accountant ([0103]) did NOT!
  const chairmanFeed = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(
    chairmanFeed.some(
      (n: any) => n.event_type === 'POLL_OPENED' && n.subject_id === emptyAptDraft.id,
    ),
    false,
  )

  const accountantFeed = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000103',
  })
  assert.equal(
    accountantFeed.some(
      (n: any) => n.event_type === 'POLL_OPENED' && n.subject_id === emptyAptDraft.id,
    ),
    false,
  )

  for (const voterId of [
    '018f0000-0000-7000-8000-000000000102', // Owner Apt 14
    '018f0000-0000-7000-8000-000000000104', // Tenant Apt 02
    '018f0000-0000-7000-8000-000000000105', // Board Member Apt 09
  ]) {
    const voterFeed = await resolveOfflineDemoRequest('/notifications/feed', {
      method: 'GET',
      actingUserId: voterId,
    })
    const notif = voterFeed.find(
      (n: any) => n.event_type === 'POLL_OPENED' && n.subject_id === emptyAptDraft.id,
    )
    assert.ok(notif, `Expected POLL_OPENED notification for eligible voter ${voterId}`)
    assert.equal(notif.subject_type, 'poll')
    assert.equal(notif.params.closes_at, '2027-05-10T20:59:59Z')
    // Privacy rule: notification params never include title, questions, or opener identity
    assert.equal('title' in notif.params, false)
    assert.equal('questions' in notif.params, false)
  }

  // 3. Server-grade ballot validation & number canonicalization in offlineDemoData:
  //    On EV charging poll (0852, OWNERS), Question 2 is NUMBER with min_value='0', max_value='1500'
  const evPoll = await resolveOfflineDemoRequest(
    '/governance/polls/018f0000-0000-7000-8000-000000000852',
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
    },
  )
  const evQ1 = evPoll.questions[0]
  const evQ2 = evPoll.questions[1]

  // Submitting out-of-range number (2500 > 1500) rejects with 422 INVALID_ANSWER and reason OUT_OF_RANGE
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/governance/polls/${evPoll.id}/ballot`,
        {
          method: 'PUT',
          actingUserId: '018f0000-0000-7000-8000-000000000102',
          body: {
            answers: [
              { question_id: evQ1.id, option_ids: [evQ1.options[0].id] },
              { question_id: evQ2.id, value: '2500' },
            ],
          },
        },
      ),
    (err: any) =>
      err?.status === 422 &&
      err?.errorCode === 'INVALID_ANSWER' &&
      err?.payload?.question_id === evQ2.id &&
      err?.payload?.reason === 'OUT_OF_RANGE',
  )

  // Submitting non-canonical number ('00450.500') canonicalizes to '450.5'
  const evAfterBallot = await resolveOfflineDemoRequest(
    `/governance/polls/${evPoll.id}/ballot`,
    {
      method: 'PUT',
      actingUserId: '018f0000-0000-7000-8000-000000000102',
      body: {
        answers: [
          { question_id: evQ1.id, option_ids: [evQ1.options[0].id] },
          { question_id: evQ2.id, value: '00450.500' },
        ],
      },
    },
  )
  const savedNumAns = evAfterBallot.my_ballots[0].answers.find(
    (a: any) => a.question_id === evQ2.id,
  )
  assert.equal(savedNumAns.value, '450.5')

  disableOfflineDemo()
  assert.equal(isOfflineDemoMode.value, false)
})

test('offlineDemoData supports GET and PUT /settings with role checks and all-or-nothing validation (#011)', async () => {
  enableOfflineDemo()

  // 1. Residents and accountant get 403 FORBIDDEN on GET /settings
  for (const forbiddenUserId of [
    '018f0000-0000-7000-8000-000000000102', // USER (Owner)
    '018f0000-0000-7000-8000-000000000103', // ACCOUNTANT
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest('/settings', {
          method: 'GET',
          actingUserId: forbiddenUserId,
        }),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
  }

  // 2. Board member can GET /settings, ordered by key, but gets 403 on PUT /settings
  const boardGet = await resolveOfflineDemoRequest('/settings', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000105', // BOARD
  })
  assert.equal(boardGet.settings.length, 4)
  assert.deepEqual(
    boardGet.settings.map((s: any) => s.key),
    [
      'issues.reports_per_apartment_per_day',
      'issues.urgent_enabled',
      'issues.urgent_per_apartment_per_day',
      'maintenance.overdue_reminder_days',
    ],
  )

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/settings', {
        method: 'PUT',
        actingUserId: '018f0000-0000-7000-8000-000000000105', // BOARD
        body: { values: { 'issues.urgent_enabled': true } },
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // 3. Chairman validation error (422) is all-or-nothing and exposes errors[].loc[2]
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/settings', {
        method: 'PUT',
        actingUserId: '018f0000-0000-7000-8000-000000000101', // CHAIRMAN
        body: {
          values: {
            'issues.urgent_enabled': true,
            'issues.urgent_per_apartment_per_day': 99, // max is 5
          },
        },
      }),
    (err: any) =>
      err?.status === 422 &&
      err?.errorCode === 'VALIDATION_ERROR' &&
      Array.isArray(err?.fieldErrors) &&
      err.fieldErrors.some(
        (e: any) =>
          e.loc?.[0] === 'body' &&
          e.loc?.[1] === 'values' &&
          e.loc?.[2] === 'issues.urgent_per_apartment_per_day',
      ),
  )

  // Verify urgent_enabled was NOT changed after the failed 422 request
  const afterFailedPut = await resolveOfflineDemoRequest('/settings', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(
    afterFailedPut.settings.find((s: any) => s.key === 'issues.urgent_enabled').value,
    false,
  )

  // 4. Chairman updates and then resets a setting with null
  const updated = await resolveOfflineDemoRequest('/settings', {
    method: 'PUT',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
    body: {
      values: {
        'issues.urgent_enabled': true,
        'issues.reports_per_apartment_per_day': 5,
      },
    },
  })
  const urgentSetting = updated.settings.find((s: any) => s.key === 'issues.urgent_enabled')
  assert.equal(urgentSetting.value, true)
  assert.equal(urgentSetting.is_default, false)
  assert.ok(urgentSetting.updated_at)

  const afterReset = await resolveOfflineDemoRequest('/settings', {
    method: 'PUT',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
    body: {
      values: {
        'issues.urgent_enabled': null,
      },
    },
  })
  const resetUrgent = afterReset.settings.find((s: any) => s.key === 'issues.urgent_enabled')
  assert.equal(resetUrgent.value, false)
  disableOfflineDemo()
})

test('offlineDemoData supports #012 /issues endpoints, privacy rules, and settings integration', async () => {
  enableOfflineDemo()

  // 1. Accountant without apartment gets 403 FORBIDDEN on /issues
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/issues', {
        method: 'GET',
        actingUserId: '018f0000-0000-7000-8000-000000000103', // ACCOUNTANT
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // 2. Owner Apt 14 (0102) sees only the open issue, NOT Apt 02's withdrawn issue
  const apt14Issues = await resolveOfflineDemoRequest('/issues', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(apt14Issues.length, 1)
  assert.equal(apt14Issues[0].title, 'No light on the 3rd floor landing')
  assert.equal(apt14Issues[0].followers, 2)
  assert.equal(apt14Issues[0].i_reported, true)
  assert.equal(apt14Issues[0].can_edit, true)

  // 3. Tenant Apt 02 (0104) sees both the open issue AND their own withdrawn issue
  const apt02Issues = await resolveOfflineDemoRequest('/issues', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000104',
  })
  assert.equal(apt02Issues.length, 2)
  assert.equal(apt02Issues[1].status, 'WITHDRAWN')

  // 4. GET /issues/form reflects issues.urgent_enabled from #011 /settings
  const formBefore = await resolveOfflineDemoRequest('/issues/form', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(formBefore.urgent_enabled, false)
  assert.deepEqual(formBefore.entrances, [1, 2])

  await resolveOfflineDemoRequest('/settings', {
    method: 'PUT',
    actingUserId: '018f0000-0000-7000-8000-000000000101', // CHAIRMAN enables urgent
    body: { values: { 'issues.urgent_enabled': true } },
  })

  const formAfter = await resolveOfflineDemoRequest('/issues/form', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(formAfter.urgent_enabled, true)

  // 5. Resident reports an issue, edits it, and another user follows it
  const created = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
    body: {
      category: 'CLEANING',
      entrance: null,
      place: 'Bicycle room',
      title: 'Sand on the floor in the bicycle room',
      description: 'Needs sweeping',
      urgent: true,
    },
  })
  assert.equal(created.status, 'REPORTED')
  assert.equal(created.urgent, true)
  assert.equal(created.reporter, null) // Resident never sees reporter object

  const detailForBoard = await resolveOfflineDemoRequest(`/issues/${created.id}`, {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101', // CHAIRMAN sees reporter
  })
  assert.notEqual(detailForBoard.reporter, null)

  // 6. (#013) Board clears urgent flag -> logs URGENT_CLEARED in board timeline, hidden from residents
  const afterClearUrgent = await resolveOfflineDemoRequest(`/issues/${created.id}/urgent/clear`, {
    method: 'POST',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(afterClearUrgent.urgent, false)
  assert.equal(
    afterClearUrgent.timeline.some((e: any) => e.action === 'URGENT_CLEARED'),
    true,
  )

  const detailForResident = await resolveOfflineDemoRequest(`/issues/${created.id}`, {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(
    detailForResident.timeline.some((e: any) => e.action === 'URGENT_CLEARED'),
    false,
  )

  // 7. (#013) Board marks created issue as DUPLICATE of seed open issue (0901) -> merges followers & moves 0901 to IN_PROGRESS
  const markedDup = await resolveOfflineDemoRequest(`/issues/${created.id}/status`, {
    method: 'POST',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
    body: {
      status: 'DUPLICATE',
      duplicate_of: '018f0000-0000-7000-8000-000000000901',
    },
  })
  assert.equal(markedDup.status, 'DUPLICATE')
  assert.equal(markedDup.duplicate_of, '018f0000-0000-7000-8000-000000000901')

  const originalAfterMerge = await resolveOfflineDemoRequest(
    '/issues/018f0000-0000-7000-8000-000000000901',
    {
      method: 'GET',
      actingUserId: '018f0000-0000-7000-8000-000000000101',
    },
  )
  assert.equal(originalAfterMerge.status, 'IN_PROGRESS')

  // 8. (#013) Board include_old=true returns 45-day-old ended issue (0900)
  const boardWithOld = await resolveOfflineDemoRequest('/issues?include_old=true', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  assert.equal(
    boardWithOld.some((i: any) => i.id === '018f0000-0000-7000-8000-000000000900'),
    true,
  )

  // 9. (#014) Issue notifications:
  //    - When resident (0102) created urgent issue `created` above, CHAIRMAN (0101) and BOARD (0105) received ISSUE_URGENT,
  //      while reporter (0102) did NOT receive ISSUE_URGENT.
  const chairmanNotifs = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000101',
  })
  const urgentNotif = chairmanNotifs.find(
    (n: any) => n.event_type === 'ISSUE_URGENT' && n.subject_id === created.id,
  )
  assert.ok(urgentNotif, 'Expected CHAIRMAN to receive ISSUE_URGENT')
  assert.equal(urgentNotif.subject_type, 'issue')
  assert.deepEqual(urgentNotif.params, { category: 'CLEANING', entrance: null })

  const reporterNotifs = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(
    reporterNotifs.some(
      (n: any) => n.event_type === 'ISSUE_URGENT' && n.subject_id === created.id,
    ),
    false,
  )

  //    - When CHAIRMAN (0101) merged `created` into `0901` (which was REPORTED -> IN_PROGRESS),
  //      reporter/follower (0102) received both the merge notice (merged: true, subject_id: 0901)
  //      and the IN_PROGRESS notice (merged: false, subject_id: 0901).
  const mergeNotice = reporterNotifs.find(
    (n: any) =>
      n.event_type === 'ISSUE_STATUS_CHANGED' &&
      n.subject_id === '018f0000-0000-7000-8000-000000000901' &&
      n.params.merged === true,
  )
  assert.ok(mergeNotice, 'Expected follower of duplicate to receive merge notice')
  assert.equal(mergeNotice.params.status, 'DUPLICATE')
  assert.equal(mergeNotice.params.category, 'CLEANING')

  const originalProgressNotice = reporterNotifs.find(
    (n: any) =>
      n.event_type === 'ISSUE_STATUS_CHANGED' &&
      n.subject_id === '018f0000-0000-7000-8000-000000000901' &&
      n.params.merged === false &&
      n.params.status === 'IN_PROGRESS',
  )
  assert.ok(
    originalProgressNotice,
    'Expected merged follower to also receive IN_PROGRESS notice when REPORTED original moves to IN_PROGRESS',
  )

  //    - Switching off mandatory ISSUE_URGENT returns 422 PREFERENCE_MANDATORY
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/notifications/preferences', {
        method: 'PUT',
        actingUserId: '018f0000-0000-7000-8000-000000000101',
        body: {
          preferences: [{ event_type: 'ISSUE_URGENT', channel: 'in_app', enabled: false }],
        },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'PREFERENCE_MANDATORY',
  )

  disableOfflineDemo()
})

test('offlineDemoData supports #015 maintenance calendar endpoints and transitions', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const residentId = '018f0000-0000-7000-8000-000000000104'

  // Resident gets 403 FORBIDDEN
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/tasks', {
        method: 'GET',
        actingUserId: residentId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // Chairman lists tasks (seed has 4 tasks: 3 active + 1 paused)
  const tasks = await resolveOfflineDemoRequest('/maintenance/tasks', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(Array.isArray(tasks), true)
  assert.equal(tasks.length >= 4, true)

  // Filter by state=OVERDUE
  const overdueTasks = await resolveOfflineDemoRequest('/maintenance/tasks?state=OVERDUE', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(overdueTasks.every((t: any) => t.current?.state === 'OVERDUE'), true)

  // Chairman creates a new task
  const created = await resolveOfflineDemoRequest('/maintenance/tasks', {
    method: 'POST',
    actingUserId: chairmanId,
    body: {
      title: 'Elevator annual cable inspection',
      instructions: 'Contract with Schindler lift service',
      period_unit: 'YEAR',
      period_count: 1,
      lead_days: 14,
      first_due_date: '2027-02-15',
      notice: null,
    },
  })
  assert.ok(created.id)
  assert.equal(created.status, 'ACTIVE')
  assert.equal(created.current?.due_date, '2027-02-15')

  // Chairman pauses the task
  const paused = await resolveOfflineDemoRequest(`/maintenance/tasks/${created.id}/pause`, {
    method: 'POST',
    actingUserId: chairmanId,
  })
  assert.equal(paused.status, 'PAUSED')
  assert.equal(paused.current?.state, 'PAUSED')

  // Pausing already paused task throws 409 INVALID_TASK_TRANSITION
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/maintenance/tasks/${created.id}/pause`, {
        method: 'POST',
        actingUserId: chairmanId,
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'INVALID_TASK_TRANSITION',
  )

  // Resume the task
  const resumed = await resolveOfflineDemoRequest(`/maintenance/tasks/${created.id}/resume`, {
    method: 'POST',
    actingUserId: chairmanId,
  })
  assert.equal(resumed.status, 'ACTIVE')

  // Archive the task
  const archived = await resolveOfflineDemoRequest(`/maintenance/tasks/${created.id}/archive`, {
    method: 'POST',
    actingUserId: chairmanId,
  })
  assert.equal(archived.status, 'ARCHIVED')
  assert.equal(archived.current, null)

  // Editing archived task throws 409 TASK_ARCHIVED
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/maintenance/tasks/${created.id}`, {
        method: 'PATCH',
        actingUserId: chairmanId,
        body: { title: 'New title' },
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'TASK_ARCHIVED',
  )

  disableOfflineDemo()
})

test('offlineDemoData supports #016 maintenance done, skip, log filters, log edit, and accountant access', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const residentId = '018f0000-0000-7000-8000-000000000104'

  // Resident gets 403 FORBIDDEN on GET /maintenance/log
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/log', {
        method: 'GET',
        actingUserId: residentId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // Accountant can read GET /maintenance/log
  const initialLog = await resolveOfflineDemoRequest('/maintenance/log', {
    method: 'GET',
    actingUserId: accountantId,
  })
  assert.equal(Array.isArray(initialLog), true)
  assert.equal(initialLog.length >= 4, true)

  // Accountant gets 403 FORBIDDEN on GET /maintenance/tasks and PATCH /maintenance/log/:id
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/tasks', {
        method: 'GET',
        actingUserId: accountantId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/maintenance/log/${initialLog[0].id}`, {
        method: 'PATCH',
        actingUserId: accountantId,
        body: { note: 'Accountant attempt' },
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // Board member marks an active task done with cost and note
  const heatingTask = await resolveOfflineDemoRequest('/maintenance/tasks/task-heating-substation', {
    method: 'GET',
    actingUserId: boardId,
  })
  const oldOccId = heatingTask.current.occurrence_id
  const oldDueDate = heatingTask.current.due_date

  const doneRes = await resolveOfflineDemoRequest('/maintenance/tasks/task-heating-substation/done', {
    method: 'POST',
    actingUserId: boardId,
    body: {
      occurrence_id: oldOccId,
      done_on: heatingTask.last_closed_on,
      note: 'All valves and pressure gauges verified.',
      cost: '145.5',
    },
  })
  assert.equal(doneRes.entry.kind, 'DONE')
  assert.equal(doneRes.entry.cost, '145.50')
  assert.equal(doneRes.entry.recorded_by.display_label, 'Liina Vaher')
  assert.notEqual(doneRes.task.current.occurrence_id, oldOccId)
  assert.equal(doneRes.task.current.due_date > oldDueDate, true)

  // Repeating with old occurrence_id gives 409 OCCURRENCE_CLOSED
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/tasks/task-heating-substation/done', {
        method: 'POST',
        actingUserId: boardId,
        body: {
          occurrence_id: oldOccId,
          done_on: heatingTask.last_closed_on,
          note: 'Duplicate submit',
        },
      }),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'OCCURRENCE_CLOSED' &&
      err?.payload?.current_occurrence_id === doneRes.task.current.occurrence_id,
  )

  // Paused task can be skipped with required note
  const pausedTask = await resolveOfflineDemoRequest('/maintenance/tasks/task-staircase-window-paint', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  const skipRes = await resolveOfflineDemoRequest('/maintenance/tasks/task-staircase-window-paint/skip', {
    method: 'POST',
    actingUserId: chairmanId,
    body: {
      occurrence_id: pausedTask.current.occurrence_id,
      note: 'Weather too cold this season.',
    },
  })
  assert.equal(skipRes.entry.kind, 'SKIPPED')
  assert.equal(skipRes.entry.cost, null)
  assert.equal(skipRes.task.status, 'PAUSED')

  // Chairman edits a DONE log entry note and cost
  const patchedEntry = await resolveOfflineDemoRequest(`/maintenance/log/${doneRes.entry.id}`, {
    method: 'PATCH',
    actingUserId: chairmanId,
    body: {
      note: 'Updated note with invoice #402.',
      cost: '160',
    },
  })
  assert.equal(patchedEntry.note, 'Updated note with invoice #402.')
  assert.equal(patchedEntry.cost, '160.00')
  assert.equal(patchedEntry.updated_by.display_label, 'Peeter Tamm')

  // Setting cost on a SKIPPED entry returns 422 VALIDATION_ERROR
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/maintenance/log/${skipRes.entry.id}`, {
        method: 'PATCH',
        actingUserId: chairmanId,
        body: { cost: '50.00' },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  disableOfflineDemo()
})

test('offlineDemoData supports #017 automatic reminders, notices, task origin badges, and settings', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const residentId = '018f0000-0000-7000-8000-000000000104'

  // 1. Posts list returns origin: 'MAINTENANCE' for maintenance posts and null for user posts
  const posts = await resolveOfflineDemoRequest('/communication/posts?limit=50', {
    method: 'GET',
    actingUserId: residentId,
  })
  const autoNotice = posts.find((p: any) => p.id === '018f0000-0000-7000-8000-000000000604')
  assert.ok(autoNotice)
  assert.equal(autoNotice.origin, 'MAINTENANCE')
  assert.equal(autoNotice.post_type, 'OFFICIAL_NOTICE')

  const regularNotice = posts.find((p: any) => p.id === '018f0000-0000-7000-8000-000000000601')
  assert.ok(regularNotice)
  assert.equal(regularNotice.origin, null)

  // 2. Post detail reflects origin
  const noticeDetail = await resolveOfflineDemoRequest('/communication/posts/018f0000-0000-7000-8000-000000000604', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(noticeDetail.origin, 'MAINTENANCE')

  const boardTopicDetail = await resolveOfflineDemoRequest('/communication/posts/018f0000-0000-7000-8000-000000000763', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(boardTopicDetail.origin, 'MAINTENANCE')
  assert.equal(boardTopicDetail.post_type, 'BOARD_TOPIC')

  // 3. Task details have published references and notice_failed flag
  const fireTask = await resolveOfflineDemoRequest('/maintenance/tasks/task-fire-extinguishers', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(fireTask.current.board_post_id, '018f0000-0000-7000-8000-000000000763')
  assert.equal(fireTask.current.notice_post_id, '018f0000-0000-7000-8000-000000000604')
  assert.ok(fireTask.current.published_at)
  assert.equal(fireTask.current.notice_failed, false)

  const atticTask = await resolveOfflineDemoRequest('/maintenance/tasks/task-attic-ventilation', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(atticTask.current.notice_failed, true)

  // 4. Building settings include maintenance.overdue_reminder_days
  const settingsRes = await resolveOfflineDemoRequest('/settings', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  const overdueSetting = settingsRes.settings.find((s: any) => s.key === 'maintenance.overdue_reminder_days')
  assert.ok(overdueSetting)
  assert.equal(overdueSetting.value, 7)
  assert.equal(overdueSetting.type, 'INTEGER')

  // Validation: out of bounds (1..30)
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/settings', {
        method: 'PUT',
        actingUserId: chairmanId,
        body: { values: { 'maintenance.overdue_reminder_days': 0 } },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/settings', {
        method: 'PUT',
        actingUserId: chairmanId,
        body: { values: { 'maintenance.overdue_reminder_days': 31 } },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  // Valid update
  const updatedSettings = await resolveOfflineDemoRequest('/settings', {
    method: 'PUT',
    actingUserId: chairmanId,
    body: { values: { 'maintenance.overdue_reminder_days': 14 } },
  })
  const updatedOverdue = updatedSettings.settings.find((s: any) => s.key === 'maintenance.overdue_reminder_days')
  assert.equal(updatedOverdue.value, 14)

  disableOfflineDemo()
})

test('offlineDemoData supports #018 maintenance due and notice published notifications & preferences', async () => {
  enableOfflineDemo()

  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const residentId = '018f0000-0000-7000-8000-000000000102'
  const boardMemberId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'

  // 1. Feed seeds check
  const chairmanFeed = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  const maintDueItem = chairmanFeed.find((n: any) => n.event_type === 'MAINTENANCE_DUE')
  assert.ok(maintDueItem, 'Chairman receives seeded MAINTENANCE_DUE')
  assert.equal(maintDueItem.subject_type, 'maintenance_task')
  assert.ok(maintDueItem.params.due_date)
  assert.equal(typeof maintDueItem.params.overdue, 'boolean')

  const residentFeed = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: residentId,
  })
  const residentMaintDue = residentFeed.find((n: any) => n.event_type === 'MAINTENANCE_DUE')
  assert.equal(residentMaintDue, undefined, 'Resident does not receive MAINTENANCE_DUE')

  const residentNotice = residentFeed.find((n: any) => n.event_type === 'NOTICE_PUBLISHED')
  assert.ok(residentNotice, 'Resident receives seeded NOTICE_PUBLISHED')
  assert.equal(residentNotice.subject_type, 'post')
  assert.deepEqual(residentNotice.params, {}, 'Notice params must be empty')

  // 2. Preferences matrix has 52 rows (13 event types x 4 channels)
  const prefsRes = await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(prefsRes.preferences.length, 52)

  const maintPrefs = prefsRes.preferences.filter((p: any) => p.event_type === 'MAINTENANCE_DUE')
  assert.equal(maintPrefs.length, 4)
  const maintInApp = maintPrefs.find((p: any) => p.channel === 'in_app')
  assert.equal(maintInApp.enabled, true)
  const maintEmail = maintPrefs.find((p: any) => p.channel === 'email')
  assert.equal(maintEmail.enabled, false)
  assert.equal(maintPrefs.every((p: any) => p.mandatory === false), true)

  const noticePrefs = prefsRes.preferences.filter((p: any) => p.event_type === 'NOTICE_PUBLISHED')
  assert.equal(noticePrefs.length, 4)
  assert.equal(noticePrefs.every((p: any) => p.enabled === true && p.mandatory === false), true)

  const storagePrefs = prefsRes.preferences.filter((p: any) => p.event_type === 'STORAGE_ALMOST_FULL')
  assert.equal(storagePrefs.length, 4)
  assert.equal(storagePrefs.every((p: any) => p.mandatory === false), true)

  // 3. PUT /notifications/preferences bounds validation (1..52)
  const excessiveChanges = Array.from({ length: 53 }, (_, i) => ({
    event_type: 'NOTICE_PUBLISHED',
    channel: 'in_app',
    enabled: true,
  }))
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/notifications/preferences', {
        method: 'PUT',
        actingUserId: residentId,
        body: { preferences: excessiveChanges },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  // Valid preference update
  const updatedPrefs = await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'PUT',
    actingUserId: residentId,
    body: {
      preferences: [
        { event_type: 'NOTICE_PUBLISHED', channel: 'in_app', enabled: false },
        { event_type: 'MAINTENANCE_DUE', channel: 'in_app', enabled: false },
      ],
    },
  })
  const updatedNoticeInApp = updatedPrefs.preferences.find(
    (p: any) => p.event_type === 'NOTICE_PUBLISHED' && p.channel === 'in_app',
  )
  assert.equal(updatedNoticeInApp.enabled, false)

  // Re-enable in_app preference for resident
  await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'PUT',
    actingUserId: residentId,
    body: {
      preferences: [
        { event_type: 'NOTICE_PUBLISHED', channel: 'in_app', enabled: true },
      ],
    },
  })

  // 4. Publishing an OFFICIAL_NOTICE generates NOTICE_PUBLISHED for target residents and board, not author
  const createdNotice = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'POST',
    actingUserId: chairmanId,
    body: {
      post_type: 'OFFICIAL_NOTICE',
      category: 'GENERAL',
      title: 'Water Pipe Maintenance Notice',
      body: 'Water will be shut off for two hours tomorrow.',
      target_scope: 'ALL_BUILDING',
    },
  })
  assert.ok(createdNotice.id)

  const residentFeedAfter = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: residentId,
  })
  const receivedNotice = residentFeedAfter.find(
    (n: any) => n.event_type === 'NOTICE_PUBLISHED' && n.subject_id === createdNotice.id,
  )
  assert.ok(receivedNotice, 'Target resident received NOTICE_PUBLISHED')
  assert.deepEqual(receivedNotice.params, {})

  const authorFeedAfter = await resolveOfflineDemoRequest('/notifications/feed', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  const authorNotice = authorFeedAfter.find(
    (n: any) => n.event_type === 'NOTICE_PUBLISHED' && n.subject_id === createdNotice.id,
  )
  assert.equal(authorNotice, undefined, 'Author does not receive own NOTICE_PUBLISHED')

  disableOfflineDemo()
})

test('offlineDemoData supports #019 next_submission, late final reading transitions, and 409 WRONG_PERIOD', async () => {
  enableOfflineDemo()
  const residentId = '018f0000-0000-7000-8000-000000000102' // Owner Apt 14
  const kitchenColdId = '018f0000-0000-7000-8000-000000000514'
  const bathColdId = '018f0000-0000-7000-8000-000000000516'
  const bathHotId = '018f0000-0000-7000-8000-000000000517'

  // 1. Dashboard auto-selects 2026-10 while late meters remain, with per-meter next_submission
  const dash1 = await resolveOfflineDemoRequest('/meters/my-dashboard', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(dash1.period.period_code, '2026-10')
  const meters1 = dash1.apartments[0].meters
  const mKitchenCold1 = meters1.find((m: any) => m.meter_id === kitchenColdId)
  const mBathCold1 = meters1.find((m: any) => m.meter_id === bathColdId)
  const mBathHot1 = meters1.find((m: any) => m.meter_id === bathHotId)

  assert.equal(mKitchenCold1.next_submission.period_code, '2026-11')
  assert.equal(mKitchenCold1.next_submission.final, false)
  assert.equal(mKitchenCold1.next_submission.reading, null)

  assert.equal(mBathCold1.next_submission.period_code, '2026-10')
  assert.equal(mBathCold1.next_submission.final, true)
  assert.equal(mBathCold1.next_submission.reading, null)

  assert.equal(mBathHot1.next_submission.period_code, '2026-10')
  assert.equal(mBathHot1.next_submission.final, true)

  // 2. Submitting 2026-10 for kitchenCold (already on 2026-11) rejects with 409 WRONG_PERIOD
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/meters/readings', {
        method: 'POST',
        actingUserId: residentId,
        body: {
          meter_id: kitchenColdId,
          period_code: '2026-10',
          value: '132.000',
          confirmation_level: 0,
        },
      }),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'WRONG_PERIOD' &&
      err?.payload?.target_period_code === '2026-11',
  )

  // 3. Submitting late final 2026-10 readings moves both bathroom meters to 2026-11 with updated previous_value
  const savedBathCold = await resolveOfflineDemoRequest('/meters/readings', {
    method: 'POST',
    actingUserId: residentId,
    body: {
      meter_id: bathColdId,
      period_code: '2026-10',
      value: '145.500',
      confirmation_level: 0,
    },
  })
  assert.equal(savedBathCold.period_code, '2026-10')
  assert.equal(savedBathCold.value, '145.500')

  await resolveOfflineDemoRequest('/meters/readings', {
    method: 'POST',
    actingUserId: residentId,
    body: {
      meter_id: bathHotId,
      period_code: '2026-10',
      value: '90.200',
      confirmation_level: 0,
    },
  })

  // 4. Now dashboard switches active period to 2026-11 and bathCold.next_submission points to 2026-11 (final: false)
  const dash2 = await resolveOfflineDemoRequest('/meters/my-dashboard', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(dash2.period.period_code, '2026-11')
  const mBathCold2 = dash2.apartments[0].meters.find((m: any) => m.meter_id === bathColdId)
  assert.equal(mBathCold2.next_submission.period_code, '2026-11')
  assert.equal(mBathCold2.next_submission.final, false)
  assert.equal(mBathCold2.next_submission.previous_value, '145.500')
  assert.equal(mBathCold2.next_submission.reading, null)

  // 5. Submitting for 2026-11 updates next_submission.reading
  await resolveOfflineDemoRequest('/meters/readings', {
    method: 'POST',
    actingUserId: residentId,
    body: {
      meter_id: kitchenColdId,
      period_code: '2026-11',
      value: '88.300',
      confirmation_level: 0,
    },
  })
  const dash3 = await resolveOfflineDemoRequest('/meters/my-dashboard', {
    method: 'GET',
    actingUserId: residentId,
  })
  const mKitchenCold3 = dash3.apartments[0].meters.find((m: any) => m.meter_id === kitchenColdId)
  assert.equal(mKitchenCold3.next_submission.reading.value, '88.300')

  // 6. Accountant without apartment sees empty apartments, and view-only locked historical check
  const closedDash = await resolveOfflineDemoRequest('/meters/my-dashboard?period_code=2026-09', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(closedDash.period.period_code, '2026-09')
  // Even when querying older 2026-09, next_submission stays anchored to the active target month (2026-11)
  const mKitchenHist = closedDash.apartments[0].meters.find((m: any) => m.meter_id === kitchenColdId)
  assert.equal(mKitchenHist.next_submission.period_code, '2026-11')

  disableOfflineDemo()
})

function makeMinimalJpeg(width = 800, height = 600): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // length 11
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, // 1 component
    0x01, 0x11, 0x00,
    0xff, 0xd9, // EOI
  ])
}

test('offlineDemoData supports #020 issue photo upload/idempotency/fetch/delete/simulation and #021 retention cleanup', async () => {
  enableOfflineDemo()
  const reporterId = '018f0000-0000-7000-8000-000000000102' // Apt 14
  const neighborId = '018f0000-0000-7000-8000-000000000104' // Apt 02
  const chairmanId = '018f0000-0000-7000-8000-000000000101' // Chairman

  const created = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: reporterId,
    body: {
      category: 'LIGHTING',
      entrance: 2,
      place: 'Stairwell',
      title: 'Flickering stairwell lamp',
      description: 'Needs replacement',
    },
  })
  assert.equal(created.can_add_photo, true)
  assert.deepEqual(created.photos, [])

  const jpegBytes = makeMinimalJpeg(1200, 900)
  const key1 = '11111111-1111-4111-8111-111111111111'
  const key2 = '22222222-2222-4222-8222-222222222222'

  // Upload photo via POST + Idempotency-Key
  const photo1 = await resolveOfflineDemoRequest(`/issues/${created.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': key1 },
    body: jpegBytes,
  })
  assert.ok(photo1.id)
  assert.equal(photo1.mine, true)
  assert.equal(photo1.can_delete, true)
  assert.equal(photo1.width, 1200)
  assert.equal(photo1.height, 900)

  // Replay with same Idempotency-Key returns same photo without adding a second
  const replay = await resolveOfflineDemoRequest(`/issues/${created.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': key1 },
    body: jpegBytes,
  })
  assert.equal(replay.id, photo1.id)

  const detailAfterUpload = await resolveOfflineDemoRequest(`/issues/${created.id}`, {
    method: 'GET',
    actingUserId: reporterId,
  })
  assert.equal(detailAfterUpload.photos.length, 1)

  // Raw image fetch works with thumb/display variant
  const imgResp = await resolveOfflineDemoRequest(
    `/issues/${created.id}/photos/${photo1.id}?variant=thumb`,
    {
      method: 'GET',
      actingUserId: neighborId,
      raw: true,
    },
  )
  assert.equal(imgResp.status, 200)
  const blob = await imgResp.blob()
  assert.equal(blob.size, jpegBytes.byteLength)

  // Neighbor sees mine=false, can_delete=false and gets 403 on delete
  const neighborDetail = await resolveOfflineDemoRequest(`/issues/${created.id}`, {
    method: 'GET',
    actingUserId: neighborId,
  })
  assert.equal(neighborDetail.can_add_photo, false)
  assert.equal(neighborDetail.photos[0].mine, false)
  assert.equal(neighborDetail.photos[0].can_delete, false)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${created.id}/photos/${photo1.id}`, {
        method: 'DELETE',
        actingUserId: neighborId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // UPLOADS_DISABLED simulation exposes uploads_enabled: false on /issues/form, disables can_add_photo on create & detail, and blocks upload with 403 UPLOADS_DISABLED
  const formUploadsEnabled = await resolveOfflineDemoRequest('/issues/form', {
    method: 'GET',
    actingUserId: reporterId,
  })
  assert.equal(formUploadsEnabled.uploads_enabled, true)

  const formUploadsDisabled = await resolveOfflineDemoRequest('/issues/form', {
    method: 'GET',
    actingUserId: reporterId,
    headers: { 'X-Simulate-Uploads-Disabled': '1' },
  })
  assert.equal(formUploadsDisabled.uploads_enabled, false)

  const createdWithDisabledUploads = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: reporterId,
    headers: { 'X-Simulate-Uploads-Disabled': '1' },
    body: { category: 'CLEANING', entrance: 1, title: 'Created while uploads disabled' },
  })
  assert.equal(createdWithDisabledUploads.can_add_photo, false)

  const disabledDetail = await resolveOfflineDemoRequest(`/issues/${created.id}`, {
    method: 'GET',
    actingUserId: reporterId,
    headers: { 'X-Simulate-Uploads-Disabled': '1' },
  })
  assert.equal(disabledDetail.can_add_photo, false)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${created.id}/photos`, {
        method: 'POST',
        actingUserId: reporterId,
        contentType: 'image/jpeg',
        headers: { 'Idempotency-Key': key2, 'X-Simulate-Uploads-Disabled': '1' },
        body: jpegBytes,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'UPLOADS_DISABLED',
  )

  // Chairman resolves issue -> photos_delete_at set; reopen clears photos_delete_at while keeping photo
  const resolved = await resolveOfflineDemoRequest(`/issues/${created.id}/status`, {
    method: 'POST',
    actingUserId: chairmanId,
    body: { status: 'RESOLVED' },
  })
  assert.equal(resolved.photos.length, 1)
  assert.ok(resolved.photos_delete_at)

  const reopened = await resolveOfflineDemoRequest(`/issues/${created.id}/status`, {
    method: 'POST',
    actingUserId: chairmanId,
    body: { status: 'IN_PROGRESS' },
  })
  assert.equal(reopened.photos.length, 1)
  assert.equal(reopened.photos_delete_at, null)

  // Declining deletes photos immediately and GET photo returns 404 PHOTO_NOT_FOUND
  const declined = await resolveOfflineDemoRequest(`/issues/${created.id}/status`, {
    method: 'POST',
    actingUserId: chairmanId,
    body: { status: 'DECLINED' },
  })
  assert.deepEqual(declined.photos, [])
  assert.equal(declined.photos_delete_at, null)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${created.id}/photos/${photo1.id}?variant=display`, {
        method: 'GET',
        actingUserId: chairmanId,
        raw: true,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'PHOTO_NOT_FOUND',
  )

  // Full 3-photo limit -> delete 1 frees slot -> list view privacy -> DUPLICATE & WITHDRAWN cleanup
  const origIssue = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: chairmanId,
    body: { category: 'CLEANING', entrance: 1, title: 'Original issue' },
  })
  const dupIssue = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: reporterId,
    body: { category: 'CLEANING', entrance: 1, title: 'Duplicate issue with 3 photos' },
  })

  const u1 = await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333331' },
    body: jpegBytes,
  })
  await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333332' },
    body: jpegBytes,
  })
  await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333333' },
    body: jpegBytes,
  })

  // 4th photo rejected with 409 PHOTO_LIMIT_REACHED
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos`, {
        method: 'POST',
        actingUserId: reporterId,
        contentType: 'image/jpeg',
        headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333334' },
        body: jpegBytes,
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'PHOTO_LIMIT_REACHED',
  )

  // Deleting 1st photo restores 1 slot and allows uploading replacement
  await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos/${u1.id}`, {
    method: 'DELETE',
    actingUserId: reporterId,
  })
  await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/photos`, {
    method: 'POST',
    actingUserId: reporterId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333335' },
    body: jpegBytes,
  })

  // List issues exposes photo summaries (length 3) without uploader identity
  const listForNeighbor = await resolveOfflineDemoRequest('/issues', {
    method: 'GET',
    actingUserId: neighborId,
  })
  const listedDup = listForNeighbor.find((it: any) => it.id === dupIssue.id)
  assert.equal(listedDup.photos.length, 3)
  assert.equal(listedDup.photos.every((p: any) => !('uploader_user_id' in p)), true)

  // Mark DUPLICATE: dupIssue photos cleared immediately; origIssue photos remain 0 (not copied)
  const mergedDup = await resolveOfflineDemoRequest(`/issues/${dupIssue.id}/status`, {
    method: 'POST',
    actingUserId: chairmanId,
    body: { status: 'DUPLICATE', duplicate_of: origIssue.id },
  })
  assert.deepEqual(mergedDup.photos, [])
  const origDetail = await resolveOfflineDemoRequest(`/issues/${origIssue.id}`, {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.deepEqual(origDetail.photos, [])

  // Withdraw an issue with a photo clears its photos immediately
  const withdrawable = await resolveOfflineDemoRequest('/issues', {
    method: 'POST',
    actingUserId: neighborId,
    body: { category: 'YARD', entrance: null, title: 'Withdrawable issue' },
  })
  const wp = await resolveOfflineDemoRequest(`/issues/${withdrawable.id}/photos`, {
    method: 'POST',
    actingUserId: neighborId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': '44444444-4444-4444-8444-444444444441' },
    body: jpegBytes,
  })
  const withdrawn = await resolveOfflineDemoRequest(`/issues/${withdrawable.id}/withdraw`, {
    method: 'POST',
    actingUserId: neighborId,
  })
  assert.deepEqual(withdrawn.photos, [])
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${withdrawable.id}/photos/${wp.id}`, {
        method: 'GET',
        actingUserId: neighborId,
        raw: true,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'PHOTO_NOT_FOUND',
  )

  // #025 simulation answers & FORBIDDEN-before-simAnswer ordering
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/issues/${origIssue.id}/photos?simulate_upload_answer=UPLOAD_TIMEOUT`,
        {
          method: 'POST',
          actingUserId: neighborId,
          contentType: 'image/jpeg',
          body: jpegBytes,
        },
      ),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/issues/${origIssue.id}/photos?simulate_upload_answer=UPLOAD_TIMEOUT`,
        {
          method: 'POST',
          actingUserId: chairmanId,
          contentType: 'image/jpeg',
          body: jpegBytes,
        },
      ),
    (err: any) => err?.status === 408 && err?.errorCode === 'UPLOAD_TIMEOUT',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/issues/${origIssue.id}/photos?simulate_upload_answer=QUOTA`,
        {
          method: 'POST',
          actingUserId: chairmanId,
          contentType: 'image/jpeg',
          body: jpegBytes,
        },
      ),
    (err: any) =>
      err?.status === 507 &&
      err?.errorCode === 'STORAGE_QUOTA_EXCEEDED' &&
      err?.payload?.reason === 'QUOTA',
  )

  const idemKey = '55555555-5555-4555-8555-555555555551'
  const firstUp = await resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos`, {
    method: 'POST',
    actingUserId: chairmanId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': idemKey },
    body: jpegBytes,
  })
  const replayUp = await resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos`, {
    method: 'POST',
    actingUserId: chairmanId,
    contentType: 'image/jpeg',
    headers: { 'Idempotency-Key': idemKey },
    body: jpegBytes,
  })
  assert.equal(replayUp.id, firstUp.id)

  await resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos/${firstUp.id}`, {
    method: 'DELETE',
    actingUserId: chairmanId,
  })
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos`, {
        method: 'POST',
        actingUserId: chairmanId,
        contentType: 'image/jpeg',
        headers: { 'Idempotency-Key': idemKey },
        body: jpegBytes,
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'UPLOAD_REMOVED',
  )

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos?simulate_upload_answer=BUSY`, {
        method: 'POST',
        actingUserId: chairmanId,
        contentType: 'image/jpeg',
        body: jpegBytes,
      }),
    (err: any) => err?.status === 429 && err?.payload?.reason === 'BUSY',
  )

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos?simulate_upload_answer=DELETIONS_PENDING`, {
        method: 'POST',
        actingUserId: chairmanId,
        contentType: 'image/jpeg',
        body: jpegBytes,
      }),
    (err: any) => err?.status === 507 && err?.payload?.reason === 'DELETIONS_PENDING',
  )

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos?simulate_upload_answer=LOW_DISK`, {
        method: 'POST',
        actingUserId: chairmanId,
        contentType: 'image/jpeg',
        body: jpegBytes,
      }),
    (err: any) => err?.status === 507 && err?.errorCode === 'STORAGE_LOW_DISK',
  )

  // Missing Content-Length on offline demo upload (body: null, no header) -> 411 LENGTH_REQUIRED
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/issues/${origIssue.id}/photos?simulate_upload_answer=BUSY`, {
        method: 'POST',
        actingUserId: chairmanId,
        contentType: 'image/jpeg',
        body: null,
      }),
    (err: any) => err?.status === 411 && err?.errorCode === 'LENGTH_REQUIRED',
  )

  disableOfflineDemo()
})

test('offline demo supports #022 and #023 documents list, download blob, upload, edit, delete, and role privacy', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const residentId = '018f0000-0000-7000-8000-000000000102'

  // Upload options by role
  const resOpts = await resolveOfflineDemoRequest('/documents/upload-options', {
    actingUserId: residentId,
  })
  assert.equal(resOpts.can_upload, false)
  assert.deepEqual(resOpts.audiences, [])

  const accOpts = await resolveOfflineDemoRequest('/documents/upload-options', {
    actingUserId: accountantId,
  })
  assert.equal(accOpts.can_upload, true)
  assert.deepEqual(accOpts.audiences, ['BOARD_AND_ACCOUNTANT'])

  const disabledOpts = await resolveOfflineDemoRequest(
    '/documents/upload-options?simulate_uploads_disabled=1',
    { actingUserId: chairmanId },
  )
  assert.equal(disabledOpts.can_upload, false)

  // Resident sees only EVERYONE documents with uploaded_by === null
  const resDocs = await resolveOfflineDemoRequest('/documents?limit=50&offset=0', {
    actingUserId: residentId,
  })
  assert.ok(Array.isArray(resDocs) && resDocs.length > 0)
  assert.ok(resDocs.every((d: any) => d.audience === 'EVERYONE' && d.uploaded_by === null))

  // Accountant uploads invoice into BOARD_AND_ACCOUNTANT
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n%%EOF\n')
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' })
  const uploaded = await resolveOfflineDemoRequest(
    '/documents?title=Repair%20Invoice&category=INVOICE&audience=BOARD_AND_ACCOUNTANT&document_date=2026-11-01',
    {
      method: 'POST',
      actingUserId: accountantId,
      contentType: 'application/pdf',
      headers: { 'Idempotency-Key': 'offline-doc-key-1' },
      body: pdfBlob,
    },
  )
  assert.equal(uploaded.title, 'Repair Invoice')
  assert.equal(uploaded.audience, 'BOARD_AND_ACCOUNTANT')

  // Replay returns same document id
  const replay = await resolveOfflineDemoRequest(
    '/documents?title=Repair%20Invoice&category=INVOICE&audience=BOARD_AND_ACCOUNTANT',
    {
      method: 'POST',
      actingUserId: accountantId,
      contentType: 'application/pdf',
      headers: { 'Idempotency-Key': 'offline-doc-key-1' },
      body: pdfBlob,
    },
  )
  assert.equal(replay.id, uploaded.id)

  // Raw download returns Headers + blob(), while resident receives 404 for BOARD_AND_ACCOUNTANT doc
  const rawFile = await resolveOfflineDemoRequest(`/documents/${uploaded.id}/file`, {
    actingUserId: chairmanId,
    raw: true,
  })
  assert.equal(rawFile.ok, true)
  assert.ok(rawFile.headers.get('content-disposition')?.includes('attachment'))
  const dlBlob = await rawFile.blob()
  assert.equal(dlBlob.size, pdfBytes.byteLength)

  await assert.rejects(
    () => resolveOfflineDemoRequest(`/documents/${uploaded.id}/file`, { actingUserId: residentId, raw: true }),
    (err: any) => err?.status === 404 && err?.errorCode === 'DOCUMENT_NOT_FOUND',
  )

  // Board edits only title (partial PATCH)
  const patched = await resolveOfflineDemoRequest(`/documents/${uploaded.id}`, {
    method: 'PATCH',
    actingUserId: boardId,
    body: { title: 'Updated Repair Invoice' },
  })
  assert.equal(patched.title, 'Updated Repair Invoice')
  assert.equal(patched.document_date, '2026-11-01')

  // Board cannot delete (403); Chairman deletes -> 404 on subsequent GET
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/documents/${uploaded.id}`, {
        method: 'DELETE',
        actingUserId: boardId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  await resolveOfflineDemoRequest(`/documents/${uploaded.id}`, {
    method: 'DELETE',
    actingUserId: chairmanId,
  })

  await assert.rejects(
    () => resolveOfflineDemoRequest(`/documents/${uploaded.id}`, { actingUserId: chairmanId }),
    (err: any) => err?.status === 404 && err?.errorCode === 'DOCUMENT_NOT_FOUND',
  )

  // Simulation flags: UPLOAD_REMOVED, QUOTA, BUSY
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/documents?title=Test&category=OTHER&audience=BOARD&simulate_upload_answer=UPLOAD_REMOVED',
        {
          method: 'POST',
          actingUserId: chairmanId,
          contentType: 'application/pdf',
          body: pdfBlob,
        },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'UPLOAD_REMOVED',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/documents?title=Test&category=OTHER&audience=BOARD&simulate_upload_answer=QUOTA',
        {
          method: 'POST',
          actingUserId: chairmanId,
          contentType: 'application/pdf',
          body: pdfBlob,
        },
      ),
    (err: any) => err?.status === 507 && err?.errorCode === 'STORAGE_QUOTA_EXCEEDED',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/documents?title=Test&category=OTHER&audience=BOARD&simulate_upload_answer=BUSY',
        {
          method: 'POST',
          actingUserId: chairmanId,
          contentType: 'application/pdf',
          body: pdfBlob,
        },
      ),
    (err: any) => err?.status === 429 && err?.payload?.reason === 'BUSY',
  )

  // #024 Storage usage & alert offline demo tests
  enableOfflineDemo()
  // Chairman (0101) can view usage
  const chairmanUsage = await resolveOfflineDemoRequest('/files/usage', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(typeof chairmanUsage.quota_bytes, 'number')
  assert.ok(chairmanUsage.quota_bytes > 0)
  assert.equal(typeof chairmanUsage.used_bytes, 'number')
  assert.equal(typeof chairmanUsage.used_percent, 'number')
  assert.equal(typeof chairmanUsage.pending_deletion_bytes, 'number')
  assert.ok(Array.isArray(chairmanUsage.categories))
  assert.ok(chairmanUsage.categories.some((c: any) => c.category === 'photos'))
  assert.ok(chairmanUsage.categories.some((c: any) => c.category === 'documents'))

  // Board member (0105) can also view usage
  const boardUsage = await resolveOfflineDemoRequest('/files/usage', {
    method: 'GET',
    actingUserId: boardId,
  })
  assert.equal(boardUsage.quota_bytes, chairmanUsage.quota_bytes)

  // Resident (0102) cannot view usage -> 403 FORBIDDEN
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/files/usage', {
        method: 'GET',
        actingUserId: residentId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // Unsubscribe with demo-storage token disables STORAGE_ALMOST_FULL email
  const unsubRes = await resolveOfflineDemoRequest('/notifications/unsubscribe?token=demo-storage', {
    method: 'POST',
    actingUserId: residentId,
  })
  assert.deepEqual(unsubRes, { event_type: 'STORAGE_ALMOST_FULL', channel: 'email' })

  disableOfflineDemo()
})

test('offlineDemoData enforces #026 hidden/edited post and comment visibility, redaction, and board delete permissions', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const ownerId = '018f0000-0000-7000-8000-000000000102'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const tenantAuthorId = '018f0000-0000-7000-8000-000000000104'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const editedTopicId = '018f0000-0000-7000-8000-000000000602'
  const hiddenTopicId = '018f0000-0000-7000-8000-000000000605'
  const noticeId = '018f0000-0000-7000-8000-000000000601'

  // 1. Edited markers + hidden comment masking by role on 0602
  const topicForOwner = await resolveOfflineDemoRequest(`/communication/posts/${editedTopicId}`, {
    method: 'GET',
    actingUserId: ownerId,
  })
  assert.equal(topicForOwner.edited_at, '2026-10-20T18:05:00Z')
  assert.equal(topicForOwner.comments_count, 2)
  assert.equal(topicForOwner.comments[0].edited_at, '2026-10-21T09:22:00Z')
  const redactedComment = topicForOwner.comments[1]
  assert.equal(redactedComment.id, '018f0000-0000-7000-8000-000000000654')
  assert.ok(redactedComment.hidden_at)
  assert.equal(redactedComment.body, null)
  assert.equal(redactedComment.hidden_reason, null)

  // Accountant also gets redacted hidden comment
  const topicForAccountant = await resolveOfflineDemoRequest(`/communication/posts/${editedTopicId}`, {
    method: 'GET',
    actingUserId: accountantId,
  })
  assert.equal(topicForAccountant.comments[1].body, null)
  assert.equal(topicForAccountant.comments[1].hidden_reason, null)

  // Comment author (tenant 0104), Board (0105), Chairman (0101) see body and hidden_reason
  for (const privilegedId of [tenantAuthorId, boardId, chairmanId]) {
    const detail = await resolveOfflineDemoRequest(`/communication/posts/${editedTopicId}`, {
      method: 'GET',
      actingUserId: privilegedId,
    })
    const hiddenComment = detail.comments[1]
    assert.ok(typeof hiddenComment.body === 'string' && hiddenComment.body.length > 0)
    assert.ok(hiddenComment.hidden_at)
    assert.ok(typeof hiddenComment.hidden_reason === 'string' && hiddenComment.hidden_reason.length > 0)
  }

  // 2. Hidden topic 0605: excluded from feed & 404 POST_NOT_FOUND for non-author non-board
  for (const viewerId of [ownerId, accountantId]) {
    const feed = await resolveOfflineDemoRequest('/communication/posts', {
      method: 'GET',
      actingUserId: viewerId,
    })
    assert.equal(feed.some((p: any) => p.id === hiddenTopicId), false)

    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}`, {
          method: 'GET',
          actingUserId: viewerId,
        }),
      (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
    )

    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}/comments`, {
          method: 'POST',
          actingUserId: viewerId,
          body: { body: 'Trying to comment on invisible post' },
        }),
      (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
    )
  }

  // Visible in feed & detail for author + board, but commenting yields 409 POST_HIDDEN
  for (const privilegedId of [tenantAuthorId, boardId, chairmanId]) {
    const feed = await resolveOfflineDemoRequest('/communication/posts', {
      method: 'GET',
      actingUserId: privilegedId,
    })
    const item = feed.find((p: any) => p.id === hiddenTopicId)
    assert.ok(item)
    assert.ok(item.hidden_at)
    assert.ok(item.hidden_reason)

    const detail = await resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}`, {
      method: 'GET',
      actingUserId: privilegedId,
    })
    assert.ok(detail.hidden_at)
    assert.ok(detail.hidden_reason)

    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}/comments`, {
          method: 'POST',
          actingUserId: privilegedId,
          body: { body: 'Comment on hidden topic' },
        }),
      (err: any) => err?.status === 409 && err?.errorCode === 'POST_HIDDEN',
    )
  }

  // Check chronological feed order: newer hidden topic 0605 comes before older 0602 when visible
  const boardFeedBeforeDelete = await resolveOfflineDemoRequest('/communication/posts?post_type=FORUM_TOPIC', {
    method: 'GET',
    actingUserId: boardId,
  })
  const idx0605 = boardFeedBeforeDelete.findIndex((p: any) => p.id === hiddenTopicId)
  const idx0602 = boardFeedBeforeDelete.findIndex((p: any) => p.id === editedTopicId)
  assert.ok(idx0605 !== -1 && idx0602 !== -1 && idx0605 < idx0602)

  // Check comments_limit & comments_offset preserve total comments_count
  const pagedDetail = await resolveOfflineDemoRequest(
    `/communication/posts/${editedTopicId}?comments_limit=1&comments_offset=1`,
    {
      method: 'GET',
      actingUserId: ownerId,
    },
  )
  assert.equal(pagedDetail.comments_count, 2)
  assert.equal(pagedDetail.comments.length, 1)
  assert.equal(pagedDetail.comments[0].id, '018f0000-0000-7000-8000-000000000654')

  // 3. DELETE /communication/posts/:id permissions
  for (const nonBoardId of [ownerId, accountantId]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${editedTopicId}`, {
          method: 'DELETE',
          actingUserId: nonBoardId,
        }),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
  }

  // OFFICIAL_NOTICE, EMERGENCY, APARTMENT_THREAD cannot be deleted -> 409 POST_NOT_DELETABLE
  for (const nonDeletableId of [
    noticeId,
    '018f0000-0000-7000-8000-000000000701',
    '018f0000-0000-7000-8000-000000000751',
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${nonDeletableId}`, {
          method: 'DELETE',
          actingUserId: boardId,
        }),
      (err: any) => err?.status === 409 && err?.errorCode === 'POST_NOT_DELETABLE',
    )
  }

  // BOARD can delete a forum topic (even a hidden one)
  await resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}`, {
    method: 'DELETE',
    actingUserId: boardId,
  })
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${hiddenTopicId}`, {
        method: 'GET',
        actingUserId: chairmanId,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )

  // 4. POST /communication/posts and /comments validate non-empty text and never leak internal fields
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/communication/posts', {
        method: 'POST',
        actingUserId: ownerId,
        body: { post_type: 'FORUM_TOPIC', title: '   ', body: 'Hello' },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  const createdPost = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'POST',
    actingUserId: ownerId,
    body: { post_type: 'FORUM_TOPIC', title: 'Courtyard lighting check', body: 'Bulb #2 flickers' },
  })
  assert.equal('author_user_id' in createdPost, false)
  assert.equal('author_apartment_id' in createdPost, false)
  assert.equal('comments' in createdPost, false)
  assert.equal(createdPost.is_mine, true)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${createdPost.id}/comments`, {
        method: 'POST',
        actingUserId: ownerId,
        body: { body: '   ' },
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  const createdComment = await resolveOfflineDemoRequest(
    `/communication/posts/${createdPost.id}/comments`,
    {
      method: 'POST',
      actingUserId: ownerId,
      body: { body: 'Confirmed this evening' },
    },
  )
  assert.equal('author_user_id' in createdComment, false)
  assert.equal('author_apartment_id' in createdComment, false)
  assert.equal(createdComment.is_mine, true)

  disableOfflineDemo()
})

test('offlineDemoData enforces #028 board hide/unhide permissions, type rules, idempotency, and visibility', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const ownerId = '018f0000-0000-7000-8000-000000000102'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const tenantId = '018f0000-0000-7000-8000-000000000104'
  const boardId = '018f0000-0000-7000-8000-000000000105'

  const createdTopic = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'POST',
    actingUserId: ownerId,
    body: {
      post_type: 'FORUM_TOPIC',
      title: 'Test moderation topic #028',
      body: 'Body to moderate',
    },
  })

  // 1. Non-board roles receive 403 FORBIDDEN for hide & unhide
  for (const nonBoardId of [ownerId, accountantId]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
          method: 'POST',
          actingUserId: nonBoardId,
          body: { reason: 'Not allowed' },
        }),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/unhide`, {
          method: 'POST',
          actingUserId: nonBoardId,
        }),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
  }

  // 2. Non-FORUM_TOPIC posts reject hide/unhide with 409 POST_NOT_HIDEABLE
  for (const [nonHideableId, expectedType] of [
    ['018f0000-0000-7000-8000-000000000601', 'OFFICIAL_NOTICE'],
    ['018f0000-0000-7000-8000-000000000701', 'EMERGENCY'],
    ['018f0000-0000-7000-8000-000000000751', 'APARTMENT_THREAD'],
    ['018f0000-0000-7000-8000-000000000761', 'BOARD_TOPIC'],
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${nonHideableId}/hide`, {
          method: 'POST',
          actingUserId: boardId,
          body: { reason: 'Cannot hide notice' },
        }),
      (err: any) =>
        err?.status === 409 &&
        err?.errorCode === 'POST_NOT_HIDEABLE' &&
        err?.payload?.post_type === expectedType,
    )
  }

  // 3. Reason validation rejects empty, control chars, >500 chars
  for (const badReason of ['   ', '', 'bad\x07char', 'a'.repeat(501)]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
          method: 'POST',
          actingUserId: boardId,
          body: { reason: badReason },
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  // 4. Hide post by BOARD -> idempotent first reason, disappears for tenant, stays for board & author
  const hiddenFirst = await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
    method: 'POST',
    actingUserId: boardId,
    body: { reason: '  First moderation reason  ' },
  })
  assert.ok(hiddenFirst.hidden_at)
  assert.equal(hiddenFirst.hidden_reason, 'First moderation reason')
  assert.equal('hidden_by_user_id' in hiddenFirst, false)

  const hiddenSecond = await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
    method: 'POST',
    actingUserId: chairmanId,
    body: { reason: 'Second overwriting attempt' },
  })
  assert.equal(hiddenSecond.hidden_at, hiddenFirst.hidden_at)
  assert.equal(hiddenSecond.hidden_reason, 'First moderation reason')

  const tenantFeedHidden = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'GET',
    actingUserId: tenantId,
  })
  assert.equal(tenantFeedHidden.some((p: any) => p.id === createdTopic.id), false)

  const boardFeedHidden = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'GET',
    actingUserId: boardId,
  })
  const boardItem = boardFeedHidden.find((p: any) => p.id === createdTopic.id)
  assert.ok(boardItem?.hidden_at)

  // Unhide restores post for tenant and clears reason
  const unhiddenPost = await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/unhide`, {
    method: 'POST',
    actingUserId: chairmanId,
  })
  assert.equal(unhiddenPost.hidden_at, null)
  assert.equal(unhiddenPost.hidden_reason, null)

  const tenantFeedRestored = await resolveOfflineDemoRequest('/communication/posts', {
    method: 'GET',
    actingUserId: tenantId,
  })
  assert.equal(tenantFeedRestored.some((p: any) => p.id === createdTopic.id), true)

  // 5. Comments on APARTMENT_THREAD and BOARD_TOPIC -> 409 COMMENT_NOT_HIDEABLE
  for (const [postId, commentId, expectedType] of [
    ['018f0000-0000-7000-8000-000000000751', '018f0000-0000-7000-8000-000000000752', 'APARTMENT_THREAD'],
    ['018f0000-0000-7000-8000-000000000761', '018f0000-0000-7000-8000-000000000762', 'BOARD_TOPIC'],
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${postId}/comments/${commentId}/hide`, {
          method: 'POST',
          actingUserId: boardId,
          body: { reason: 'Should fail' },
        }),
      (err: any) =>
        err?.status === 409 &&
        err?.errorCode === 'COMMENT_NOT_HIDEABLE' &&
        err?.payload?.post_type === expectedType,
    )
  }

  // Comment of another post -> 404 COMMENT_NOT_FOUND
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000653/hide',
        {
          method: 'POST',
          actingUserId: boardId,
          body: { reason: 'Wrong post' },
        },
      ),
    (err: any) => err?.status === 404 && err?.errorCode === 'COMMENT_NOT_FOUND',
  )

  // Hide & unhide comment on OFFICIAL_NOTICE (0601 / 0651) with redaction check
  const hiddenNoticeComment = await resolveOfflineDemoRequest(
    '/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/hide',
    {
      method: 'POST',
      actingUserId: boardId,
      body: { reason: 'Off-topic on notice' },
    },
  )
  assert.ok(hiddenNoticeComment.hidden_at)
  assert.equal(hiddenNoticeComment.hidden_reason, 'Off-topic on notice')

  const noticeForTenant = await resolveOfflineDemoRequest(
    '/communication/posts/018f0000-0000-7000-8000-000000000601',
    { method: 'GET', actingUserId: tenantId },
  )
  assert.equal(noticeForTenant.comments[0].body, null)
  assert.equal(noticeForTenant.comments[0].hidden_reason, null)

  const unhiddenNoticeComment = await resolveOfflineDemoRequest(
    '/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/unhide',
    {
      method: 'POST',
      actingUserId: boardId,
    },
  )
  assert.equal(unhiddenNoticeComment.hidden_at, null)
  assert.equal(unhiddenNoticeComment.hidden_reason, null)
  assert.ok(typeof unhiddenNoticeComment.body === 'string' && unhiddenNoticeComment.body.length > 0)

  // 6. Idempotent unhide, 409 unhide on non-hideable, 404 POST_NOT_FOUND, 403 on comments, malformed JSON string, author vs non-author GET /posts/:id, and POST_HIDDEN lifecycle
  const unhiddenAgain = await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/unhide`, {
    method: 'POST',
    actingUserId: boardId,
  })
  assert.equal(unhiddenAgain.hidden_at, null)

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/communication/posts/018f0000-0000-7000-8000-000000000601/unhide', {
        method: 'POST',
        actingUserId: boardId,
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'POST_NOT_HIDEABLE',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/communication/posts/018f0000-0000-7000-8000-000000000761/comments/018f0000-0000-7000-8000-000000000762/unhide',
        { method: 'POST', actingUserId: boardId },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'COMMENT_NOT_HIDEABLE',
  )

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/communication/posts/018f0000-0000-7000-8000-999999999999/hide', {
        method: 'POST',
        actingUserId: boardId,
        body: { reason: 'Missing post' },
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/communication/posts/018f0000-0000-7000-8000-999999999999/unhide', {
        method: 'POST',
        actingUserId: boardId,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        '/communication/posts/018f0000-0000-7000-8000-999999999999/comments/018f0000-0000-7000-8000-000000000651/hide',
        { method: 'POST', actingUserId: boardId, body: { reason: 'Missing parent post' } },
      ),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )

  for (const nonBoardId of [ownerId, accountantId]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(
          '/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/hide',
          { method: 'POST', actingUserId: nonBoardId, body: { reason: 'Forbidden comment hide' } },
        ),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(
          '/communication/posts/018f0000-0000-7000-8000-000000000601/comments/018f0000-0000-7000-8000-000000000651/unhide',
          { method: 'POST', actingUserId: nonBoardId },
        ),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
  }

  // Malformed JSON string body -> 422 VALIDATION_ERROR (never uncaught SyntaxError)
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
        method: 'POST',
        actingUserId: boardId,
        body: '{invalid-json',
      }),
    (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
  )

  // Comment on FORUM_TOPIC & EMERGENCY hide/unhide + POST_HIDDEN comment block/unblock + author vs non-author GET
  const topicComment = await resolveOfflineDemoRequest(
    `/communication/posts/${createdTopic.id}/comments`,
    { method: 'POST', actingUserId: tenantId, body: { body: 'Comment before post hide' } },
  )
  const hiddenTopicComment = await resolveOfflineDemoRequest(
    `/communication/posts/${createdTopic.id}/comments/${topicComment.id}/hide`,
    { method: 'POST', actingUserId: boardId, body: { reason: 'Topic comment rule' } },
  )
  assert.ok(hiddenTopicComment.hidden_at)
  await resolveOfflineDemoRequest(
    `/communication/posts/${createdTopic.id}/comments/${topicComment.id}/unhide`,
    { method: 'POST', actingUserId: boardId },
  )

  const emergencyComment = await resolveOfflineDemoRequest(
    '/communication/posts/018f0000-0000-7000-8000-000000000701/comments',
    { method: 'POST', actingUserId: ownerId, body: { body: 'Emergency comment' } },
  )
  const hiddenEmergComment = await resolveOfflineDemoRequest(
    `/communication/posts/018f0000-0000-7000-8000-000000000701/comments/${emergencyComment.id}/hide`,
    { method: 'POST', actingUserId: chairmanId, body: { reason: 'Emergency cleanup' } },
  )
  assert.ok(hiddenEmergComment.hidden_at)

  // Hide topic -> author gets 200 GET /posts/:id, non-author gets 404, POST /comments gives 409 POST_HIDDEN; unhide lifts it
  await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/hide`, {
    method: 'POST',
    actingUserId: boardId,
    body: { reason: 'Hidden lifecycle test' },
  })
  const authorHiddenDetail = await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}`, {
    method: 'GET',
    actingUserId: ownerId,
  })
  assert.ok(authorHiddenDetail.hidden_at)
  assert.equal(authorHiddenDetail.hidden_reason, 'Hidden lifecycle test')

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}`, {
        method: 'GET',
        actingUserId: tenantId,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/comments`, {
        method: 'POST',
        actingUserId: ownerId,
        body: { body: 'Blocked while hidden' },
      }),
    (err: any) => err?.status === 409 && err?.errorCode === 'POST_HIDDEN',
  )

  await resolveOfflineDemoRequest(`/communication/posts/${createdTopic.id}/unhide`, {
    method: 'POST',
    actingUserId: chairmanId,
  })
  const commentAfterUnhide = await resolveOfflineDemoRequest(
    `/communication/posts/${createdTopic.id}/comments`,
    { method: 'POST', actingUserId: ownerId, body: { body: 'Allowed after unhide' } },
  )
  assert.equal(commentAfterUnhide.body, 'Allowed after unhide')

  disableOfflineDemo()
})

test('offlineDemoData enforces #027 post and comment edit rules, 24h window, check order, and no-op edited_at', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const ownerId = '018f0000-0000-7000-8000-000000000102'
  const tenantId = '018f0000-0000-7000-8000-000000000104'
  const boardId = '018f0000-0000-7000-8000-000000000105'

  const FRESH_TOPIC_ID = '018f0000-0000-7000-8000-000000000606'
  const FRESH_OWNER_COMMENT_ID = '018f0000-0000-7000-8000-000000000656'
  const FRESH_BOARD_COMMENT_ID = '018f0000-0000-7000-8000-000000000655'
  const EXPIRED_FORUM_TOPIC_ID = '018f0000-0000-7000-8000-000000000602'
  const EXPIRED_BOARD_TOPIC_ID = '018f0000-0000-7000-8000-000000000761'
  const EXPIRED_BOARD_COMMENT_ID = '018f0000-0000-7000-8000-000000000762'
  const MAINTENANCE_BOARD_TOPIC_ID = '018f0000-0000-7000-8000-000000000763'

  // 1. Seeded fresh topic 0606 starts unedited within 24h; no-op edit keeps edited_at null
  const unchanged = await resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}`, {
    method: 'PATCH',
    actingUserId: ownerId,
    body: { title: '  Weekend courtyard bench repainting helpers  ' },
  })
  assert.equal(unchanged.edited_at, null)

  // Title-only edit sets edited_at and updates post; idempotent repeat preserves timestamp
  const titleEdited = await resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}`, {
    method: 'PATCH',
    actingUserId: ownerId,
    body: { title: 'Sunday courtyard bench oiling helpers' },
  })
  assert.equal(titleEdited.title, 'Sunday courtyard bench oiling helpers')
  assert.ok(titleEdited.edited_at)
  const postRepeatNoOp = await resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}`, {
    method: 'PATCH',
    actingUserId: ownerId,
    body: { title: '  Sunday courtyard bench oiling helpers  ' },
  })
  assert.equal(postRepeatNoOp.edited_at, titleEdited.edited_at)

  // Visibility isolation & malformed path encoding -> 404 POST_NOT_FOUND
  for (const [hiddenPath, actor] of [
    [`/communication/posts/${EXPIRED_BOARD_TOPIC_ID}`, ownerId], // resident on BOARD_TOPIC
    ['/communication/posts/018f0000-0000-7000-8000-000000000751', tenantId], // other apt on APARTMENT_THREAD
    ['/communication/posts/018f0000-0000-7000-8000-000000000605', ownerId], // resident on other's hidden FORUM_TOPIC
    ['/communication/posts/%E0%A4%A', ownerId], // malformed percent-encoding
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(hiddenPath, {
          method: 'PATCH',
          actingUserId: actor,
          body: { title: 'Should be 404' },
        }),
      (err: any) => err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND',
    )
  }

  // Non-author (even BOARD/CHAIRMAN) -> 403 FORBIDDEN even when topic is within or past window
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}`, {
        method: 'PATCH',
        actingUserId: boardId,
        body: { title: 'Board overwrite attempt' },
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${EXPIRED_FORUM_TOPIC_ID}`, {
        method: 'PATCH',
        actingUserId: boardId,
        body: { title: 'Non-author expired topic check order' },
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // 2. Old FORUM_TOPIC by author -> 409 EDIT_WINDOW_CLOSED with editable_until
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/communication/posts/${EXPIRED_FORUM_TOPIC_ID}`, {
        method: 'PATCH',
        actingUserId: ownerId,
        body: { title: 'Too late edit' },
      }),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'EDIT_WINDOW_CLOSED' &&
      typeof err?.payload?.editable_until === 'string',
  )

  // 3. Old BOARD_TOPIC authored by chairman (0101) with origin == null has NO 24h limit
  const boardTopicEdited = await resolveOfflineDemoRequest(
    `/communication/posts/${EXPIRED_BOARD_TOPIC_ID}`,
    {
      method: 'PATCH',
      actingUserId: chairmanId,
      body: { body: 'Updated spare key cabinet code for November.' },
    },
  )
  assert.equal(boardTopicEdited.body, 'Updated spare key cabinet code for November.')
  assert.ok(boardTopicEdited.edited_at)

  // 4. Non-editable posts -> 409 POST_NOT_EDITABLE
  for (const [id, uid, expectedType] of [
    ['018f0000-0000-7000-8000-000000000601', chairmanId, 'OFFICIAL_NOTICE'],
    ['018f0000-0000-7000-8000-000000000701', chairmanId, 'EMERGENCY'],
    ['018f0000-0000-7000-8000-000000000751', chairmanId, 'APARTMENT_THREAD'],
    [MAINTENANCE_BOARD_TOPIC_ID, chairmanId, 'BOARD_TOPIC'],
    ['018f0000-0000-7000-8000-000000000605', tenantId, 'FORUM_TOPIC'], // hidden topic
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${id}`, {
          method: 'PATCH',
          actingUserId: uid,
          body: { title: 'Cannot edit this' },
        }),
      (err: any) =>
        err?.status === 409 &&
        err?.errorCode === 'POST_NOT_EDITABLE' &&
        err?.payload?.post_type === expectedType,
    )
  }

  // 5. Validation errors: empty object, unknown field, invalid JSON, non-object/non-string, boundaries, control chars
  for (const badBody of [
    {},
    [],
    'null',
    { title: 123 },
    { body: null },
    { title: 'Ok', extra: 'nope' },
    { title: '   ' },
    { title: 't'.repeat(256) },
    { body: 'a'.repeat(10001) },
    { body: 'Bad\x07ctrl' },
    '{not-json',
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}`, {
          method: 'PATCH',
          actingUserId: ownerId,
          body: badBody,
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  // 6. Comment edit rules: fresh comment works + no-op does not set edited_at + repeat no-op preserves edited_at + wrong user 403
  const commentNoOp = await resolveOfflineDemoRequest(
    `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
    {
      method: 'PATCH',
      actingUserId: ownerId,
      body: { body: 'Thank you Peeter! I will also pick up masking tape tomorrow morning.' },
    },
  )
  assert.equal(commentNoOp.edited_at, null)

  const commentUpdated = await resolveOfflineDemoRequest(
    `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
    {
      method: 'PATCH',
      actingUserId: ownerId,
      body: { body: 'Updated: bringing both rollers and masking tape.' },
    },
  )
  assert.equal(commentUpdated.body, 'Updated: bringing both rollers and masking tape.')
  assert.ok(commentUpdated.edited_at)

  const commentRepeatNoOp = await resolveOfflineDemoRequest(
    `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
    {
      method: 'PATCH',
      actingUserId: ownerId,
      body: { body: '  Updated: bringing both rollers and masking tape.  ' },
    },
  )
  assert.equal(commentRepeatNoOp.edited_at, commentUpdated.edited_at)

  // Comment validation edge cases
  for (const badCommentBody of [
    {},
    [],
    { body: 42 },
    { body: '   ' },
    { body: 'Valid', extra: true },
    { body: 'c'.repeat(4001) },
    { body: 'Ctrl\x07char' },
  ]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(
          `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
          {
            method: 'PATCH',
            actingUserId: ownerId,
            body: badCommentBody,
          },
        ),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_BOARD_COMMENT_ID}`,
        {
          method: 'PATCH',
          actingUserId: ownerId,
          body: { body: 'Cannot edit Peeter comment' },
        },
      ),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // Old board topic comment (>24h) -> 409 EDIT_WINDOW_CLOSED
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${EXPIRED_BOARD_TOPIC_ID}/comments/${EXPIRED_BOARD_COMMENT_ID}`,
        {
          method: 'PATCH',
          actingUserId: boardId,
          body: { body: 'Too late board comment edit' },
        },
      ),
    (err: any) =>
      err?.status === 409 &&
      err?.errorCode === 'EDIT_WINDOW_CLOSED' &&
      typeof err?.payload?.editable_until === 'string',
  )

  // Comment on APARTMENT_THREAD or origin='MAINTENANCE' post -> 409 COMMENT_NOT_EDITABLE
  const threadComment = await resolveOfflineDemoRequest(
    '/communication/posts/018f0000-0000-7000-8000-000000000751/comments',
    { method: 'POST', actingUserId: ownerId, body: { body: 'Fresh thread reply' } },
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/018f0000-0000-7000-8000-000000000751/comments/${threadComment.id}`,
        {
          method: 'PATCH',
          actingUserId: ownerId,
          body: { body: 'Try edit thread comment' },
        },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'COMMENT_NOT_EDITABLE',
  )

  const maintComment = await resolveOfflineDemoRequest(
    `/communication/posts/${MAINTENANCE_BOARD_TOPIC_ID}/comments`,
    { method: 'POST', actingUserId: chairmanId, body: { body: 'Fresh maint comment' } },
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${MAINTENANCE_BOARD_TOPIC_ID}/comments/${maintComment.id}`,
        {
          method: 'PATCH',
          actingUserId: chairmanId,
          body: { body: 'Cannot edit maintenance post comment' },
        },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'COMMENT_NOT_EDITABLE',
  )

  // Fresh comment on hidden topic or hidden comment -> 409 COMMENT_NOT_EDITABLE
  await resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}/hide`, {
    method: 'POST',
    actingUserId: boardId,
    body: { reason: 'Temporary hide for edit check' },
  })
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
        {
          method: 'PATCH',
          actingUserId: ownerId,
          body: { body: 'Edit comment while post hidden' },
        },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'COMMENT_NOT_EDITABLE',
  )
  await resolveOfflineDemoRequest(`/communication/posts/${FRESH_TOPIC_ID}/unhide`, {
    method: 'POST',
    actingUserId: boardId,
  })
  await resolveOfflineDemoRequest(
    `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}/hide`,
    {
      method: 'POST',
      actingUserId: boardId,
      body: { reason: 'Hide comment test' },
    },
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}`,
        {
          method: 'PATCH',
          actingUserId: ownerId,
          body: { body: 'Edit hidden comment' },
        },
      ),
    (err: any) => err?.status === 409 && err?.errorCode === 'COMMENT_NOT_EDITABLE',
  )
  await resolveOfflineDemoRequest(
    `/communication/posts/${FRESH_TOPIC_ID}/comments/${FRESH_OWNER_COMMENT_ID}/unhide`,
    {
      method: 'POST',
      actingUserId: boardId,
    },
  )

  // Wrong comment ID on post -> 404 COMMENT_NOT_FOUND
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(
        `/communication/posts/${FRESH_TOPIC_ID}/comments/${EXPIRED_BOARD_COMMENT_ID}`,
        {
          method: 'PATCH',
          actingUserId: boardId,
          body: { body: 'Wrong post' },
        },
      ),
    (err: any) => err?.status === 404 && err?.errorCode === 'COMMENT_NOT_FOUND',
  )

  disableOfflineDemo()
})

test('Maintenance yearly report & CSV export in offline demo (#029)', async () => {
  enableOfflineDemo()

  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const ownerId = '018f0000-0000-7000-8000-000000000102'

  // 1. Residents receive 403 FORBIDDEN on both report and export-csv
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/report?year=2026', {
        method: 'GET',
        actingUserId: ownerId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/maintenance/report/export-csv?year=2026', {
        method: 'GET',
        raw: true,
        actingUserId: ownerId,
      }),
    (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
  )

  // 2. Invalid/missing year returns 422 VALIDATION_ERROR
  for (const badQs of ['', '?year=1999', '?year=2101', '?year=2026abc', '?year=2026.5']) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/maintenance/report${badQs}`, {
          method: 'GET',
          actingUserId: chairmanId,
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/maintenance/report/export-csv${badQs}`, {
          method: 'GET',
          raw: true,
          actingUserId: accountantId,
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  // 3. Accountant and Board can fetch report for year with no entries -> zeros + empty tasks
  const emptyReport = await resolveOfflineDemoRequest('/maintenance/report?year=2010', {
    method: 'GET',
    actingUserId: accountantId,
  })
  assert.deepEqual(emptyReport, {
    year: 2010,
    done_count: 0,
    skipped_count: 0,
    total_cost: '0.00',
    tasks: [],
  })

  // 4. Report aggregates seeded entries by closed_on year, sorted by task_title
  const seedLog = await resolveOfflineDemoRequest('/maintenance/log?limit=100', {
    method: 'GET',
    actingUserId: accountantId,
  })
  assert.ok(seedLog.length >= 4)
  const latestYear = Number(seedLog[0].closed_on.slice(0, 4))
  const report = await resolveOfflineDemoRequest(`/maintenance/report?year=${latestYear}`, {
    method: 'GET',
    actingUserId: accountantId,
  })
  assert.equal(report.year, latestYear)
  assert.ok(report.tasks.length >= 1)
  const sortedTitles = report.tasks.map((t: any) => t.task_title)
  assert.deepEqual(
    sortedTitles,
    [...sortedTitles].sort((a, b) => a.localeCompare(b, 'en')),
  )

  // 5. Editing a log entry updates the report total_cost
  const editableEntry = seedLog.find(
    (e: any) => e.closed_on.startsWith(`${latestYear}-`) && e.kind === 'DONE',
  )
  assert.ok(editableEntry)
  await resolveOfflineDemoRequest(`/maintenance/log/${editableEntry.id}`, {
    method: 'PATCH',
    actingUserId: boardId,
    body: { cost: '500.25', note: '=updated cost note' },
  })
  const updatedReport = await resolveOfflineDemoRequest(`/maintenance/report?year=${latestYear}`, {
    method: 'GET',
    actingUserId: boardId,
  })
  assert.notEqual(updatedReport.total_cost, report.total_cost)

  // 6. Export CSV returns raw Response with BOM, CRLF, Content-Disposition, oldest first, formula guard
  const csvResponse = await resolveOfflineDemoRequest(
    `/maintenance/report/export-csv?year=${latestYear}`,
    {
      method: 'GET',
      raw: true,
      actingUserId: accountantId,
    },
  )
  assert.equal(csvResponse.status, 200)
  assert.equal(csvResponse.headers.get('Content-Type'), 'text/csv; charset=utf-8')
  assert.equal(
    csvResponse.headers.get('Content-Disposition'),
    `attachment; filename="maintenance-log-${latestYear}.csv"`,
  )
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer())
  assert.deepEqual(Array.from(csvBytes.subarray(0, 3)), [0xef, 0xbb, 0xbf])
  const csvText = csvBytes.toString('utf8')
  assert.equal(csvText.startsWith('\uFEFF'), true)
  assert.equal(csvText.includes('\r\n'), true)
  const lines = csvText.slice(1).trimEnd().split('\r\n')
  assert.equal(
    lines[0],
    'closed_on,task_title,kind,planned_date,cost,note,recorded_by',
  )
  assert.equal(csvText.includes("'=updated cost note"), true)

  // 7. Chairman gets 200 OK on both endpoints, and empty year CSV has BOM + header only
  const chairReport = await resolveOfflineDemoRequest(`/maintenance/report?year=${latestYear}`, {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(chairReport.year, latestYear)
  assert.equal(chairReport.total_cost, updatedReport.total_cost)

  const emptyCsvResp = await resolveOfflineDemoRequest('/maintenance/report/export-csv?year=2010', {
    method: 'GET',
    raw: true,
    actingUserId: chairmanId,
  })
  assert.equal(emptyCsvResp.status, 200)
  const emptyCsvBytes = Buffer.from(await emptyCsvResp.arrayBuffer())
  assert.deepEqual(Array.from(emptyCsvBytes.subarray(0, 3)), [0xef, 0xbb, 0xbf])
  assert.equal(
    emptyCsvBytes.toString('utf8'),
    '\uFEFFclosed_on,task_title,kind,planned_date,cost,note,recorded_by\r\n',
  )

  disableOfflineDemo()
})

test('offline demo serves /meters/apartments/:id/consumption with role isolation, months validation, replaced meters, and live submission updates (#030)', async () => {
  enableOfflineDemo()
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const residentApt14Id = '018f0000-0000-7000-8000-000000000102'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const apt14Id = '018f0000-0000-7000-8000-000000000314'
  const apt02Id = '018f0000-0000-7000-8000-000000000302'

  // 1. Resident gets own apartment consumption (periods oldest first, 2026-11 open null, 2026-08 estimated, 2026-07 replaced meter included)
  const ownConsumption = await resolveOfflineDemoRequest(
    `/meters/apartments/${apt14Id}/consumption?months=12`,
    { method: 'GET', actingUserId: residentApt14Id },
  )
  assert.equal(ownConsumption.apartment_id, apt14Id)
  assert.equal(ownConsumption.apartment_number, '14')
  assert.deepEqual(
    ownConsumption.periods.map((p: any) => p.period_code),
    ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'],
  )
  assert.equal(ownConsumption.periods[4].status, 'OPEN_FOR_RESIDENTS')

  const coldSeries = ownConsumption.resources.find((r: any) => r.resource_type === 'COLD_WATER')
  assert.ok(coldSeries)
  const monthByCode = Object.fromEntries(coldSeries.months.map((m: any) => [m.period_code, m]))
  assert.equal(monthByCode['2026-08'].estimated, true)
  assert.equal(monthByCode['2026-11'].consumption, null)
  // Replaced meter CW-1429-OLD adds +2.000 only in 2026-07
  assert.notEqual(monthByCode['2026-07'].consumption, monthByCode['2026-08'].consumption)

  // Ensure no building averages are leaked on resident consumption
  assert.equal('building_average' in ownConsumption, false)
  assert.equal('average_per_apartment' in coldSeries.months[0], false)

  // 2. Resident cannot access another apartment -> 404 APARTMENT_NOT_FOUND
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest(`/meters/apartments/${apt02Id}/consumption?months=12`, {
        method: 'GET',
        actingUserId: residentApt14Id,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'APARTMENT_NOT_FOUND',
  )

  // 3. Unknown apartment -> 404 APARTMENT_NOT_FOUND even for Chairman
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/meters/apartments/018f0000-0000-7000-8000-999999999999/consumption', {
        method: 'GET',
        actingUserId: chairmanId,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'APARTMENT_NOT_FOUND',
  )

  // 4. Invalid months -> 422 VALIDATION_ERROR
  for (const badMonths of ['0', '25', 'abc']) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/meters/apartments/${apt14Id}/consumption?months=${badMonths}`, {
          method: 'GET',
          actingUserId: accountantId,
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  // 5. BOARD role and Accountant can query Apt 02 with ?months=2
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const boardApt14 = await resolveOfflineDemoRequest(
    `/meters/apartments/${apt14Id}/consumption?months=12`,
    { method: 'GET', actingUserId: boardId },
  )
  assert.equal(boardApt14.apartment_number, '14')

  const twoMonths = await resolveOfflineDemoRequest(
    `/meters/apartments/${apt02Id}/consumption?months=2`,
    { method: 'GET', actingUserId: accountantId },
  )
  assert.deepEqual(
    twoMonths.periods.map((p: any) => p.period_code),
    ['2026-10', '2026-11'],
  )

  // 6. Malformed percent-encoding in URL fails closed with 404 (not URIError 500)
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/meters/apartments/%ZZ/consumption', {
        method: 'GET',
        actingUserId: chairmanId,
      }),
    (err: any) => err?.status === 404 && err?.errorCode === 'APARTMENT_NOT_FOUND',
  )

  // 7. Live POST /meters/readings updates open month 2026-11 in offline demo consumption
  await resolveOfflineDemoRequest('/meters/readings', {
    method: 'POST',
    actingUserId: residentApt14Id,
    body: {
      meter_id: '018f0000-0000-7000-8000-000000000516',
      period_code: '2026-10',
      value: '145.550',
      confirmation_level: 0,
    },
  })
  const afterLive = await resolveOfflineDemoRequest(
    `/meters/apartments/${apt14Id}/consumption?months=12`,
    { method: 'GET', actingUserId: residentApt14Id },
  )
  const coldAfterLive = afterLive.resources.find((r: any) => r.resource_type === 'COLD_WATER')
  const octAfterLive = coldAfterLive.months.find((m: any) => m.period_code === '2026-10')
  assert.equal(octAfterLive.consumption, '5.300')

  disableOfflineDemo()
})

test('offlineDemoData building consumption: role gating, master meter exclusion, exact averages, and live open-month update (#031)', async () => {
  enableOfflineDemo()

  const residentApt14Id = '018f0000-0000-7000-8000-000000000102'
  const tenantApt02Id = '018f0000-0000-7000-8000-000000000104'
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'

  // 1. Residents always get 403 FORBIDDEN (never see building averages)
  for (const resId of [residentApt14Id, tenantApt02Id]) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest('/meters/consumption?months=12', {
          method: 'GET',
          actingUserId: resId,
        }),
      (err: any) => err?.status === 403 && err?.errorCode === 'FORBIDDEN',
    )
  }

  // 2. Staff roles (CHAIRMAN, BOARD, ACCOUNTANT) succeed; invalid months -> 422
  for (const bad of ['0', '25', 'invalid']) {
    await assert.rejects(
      () =>
        resolveOfflineDemoRequest(`/meters/consumption?months=${bad}`, {
          method: 'GET',
          actingUserId: chairmanId,
        }),
      (err: any) => err?.status === 422 && err?.errorCode === 'VALIDATION_ERROR',
    )
  }

  for (const staffId of [chairmanId, boardId, accountantId]) {
    const res = await resolveOfflineDemoRequest('/meters/consumption?months=12', {
      method: 'GET',
      actingUserId: staffId,
    })
    assert.deepEqual(
      res.periods.map((p: any) => p.period_code),
      ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'],
    )
    const types = res.resources.map((r: any) => r.resource_type)
    assert.deepEqual(types, ['COLD_WATER', 'ELECTRICITY', 'HOT_WATER'])
    assert.equal('apartments' in res, false)
  }

  const building = await resolveOfflineDemoRequest('/meters/consumption?months=12', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  const cold = building.resources.find((r: any) => r.resource_type === 'COLD_WATER')
  assert.ok(cold)
  const coldByCode = Object.fromEntries(cold.months.map((m: any) => [m.period_code, m]))

  // 2026-11 has no submitted readings yet -> null gaps
  assert.deepEqual(coldByCode['2026-11'], {
    period_code: '2026-11',
    total: null,
    apartments_counted: 0,
    average_per_apartment: null,
    average_per_m2: null,
    estimated_readings: 0,
  })

  // 2026-10: master meter (28.500) excluded; Apt 01 (2.2) + 02 (3.85) + 09 (14.4) + 14 (2.1) = 22.550 across 4 apartments (area 208.10 m2)
  assert.deepEqual(coldByCode['2026-10'], {
    period_code: '2026-10',
    total: '22.550',
    apartments_counted: 4,
    average_per_apartment: '5.638',
    average_per_m2: '0.1084',
    estimated_readings: 0,
  })

  // 2026-08 has 5 AUTO_ESTIMATED cold water readings
  assert.equal(coldByCode['2026-08'].estimated_readings, 5)
  assert.equal(coldByCode['2026-08'].apartments_counted, 5)

  // 2026-07 includes Apt 14 replaced meter CW-1429-OLD (+2.000) while still counting Apt 14 once
  assert.equal(coldByCode['2026-07'].total, '21.400')
  assert.equal(coldByCode['2026-07'].apartments_counted, 5)

  // 3. Submitting Bathroom Cold Water for Apt 14 in 2026-10 updates total (+3.200 -> 25.750) while apartments_counted stays 4
  await resolveOfflineDemoRequest('/meters/readings', {
    method: 'POST',
    actingUserId: residentApt14Id,
    body: {
      meter_id: '018f0000-0000-7000-8000-000000000516',
      period_code: '2026-10',
      value: '145.550',
      confirmation_level: 0,
    },
  })
  const afterApt14 = await resolveOfflineDemoRequest('/meters/consumption?months=12', {
    method: 'GET',
    actingUserId: accountantId,
  })
  const coldAfter14 = afterApt14.resources
    .find((r: any) => r.resource_type === 'COLD_WATER')
    .months.find((m: any) => m.period_code === '2026-10')
  assert.equal(coldAfter14.total, '25.750')
  assert.equal(coldAfter14.apartments_counted, 4)
  assert.equal(coldAfter14.average_per_apartment, '6.438')
  assert.equal(coldAfter14.average_per_m2, '0.1237')

  // 4. OFFLINE_BUILDING apartment_count matches card count (6) and months=0 returns 422 with fieldErrors
  const offlineBuilding = await resolveOfflineDemoRequest('/property/building', {
    method: 'GET',
    actingUserId: chairmanId,
  })
  assert.equal(offlineBuilding.apartment_count, 6)
  await assert.rejects(
    () =>
      resolveOfflineDemoRequest('/meters/consumption?months=0', {
        method: 'GET',
        actingUserId: chairmanId,
      }),
    (err: any) =>
      err?.status === 422 &&
      err?.errorCode === 'VALIDATION_ERROR' &&
      Array.isArray(err?.fieldErrors) &&
      err.fieldErrors.length > 0,
  )

  disableOfflineDemo()
})





