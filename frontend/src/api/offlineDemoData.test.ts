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
  assert.equal(dashboard.apartments[0].can_submit_readings, false)

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

  // #010, #014 & #018 Poll, Issue & Maintenance Notifications & Preferences:
  // 1. Preferences matrix returns 48 cells (12 event types x 4 channels) with POLL_OPENED enabled by default and non-mandatory
  const prefsResp = await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'GET',
    actingUserId: '018f0000-0000-7000-8000-000000000102',
  })
  assert.equal(prefsResp.preferences.length, 48)
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

  // 2. Preferences matrix has 48 rows
  const prefsRes = await resolveOfflineDemoRequest('/notifications/preferences', {
    method: 'GET',
    actingUserId: residentId,
  })
  assert.equal(prefsRes.preferences.length, 48)

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

  // 3. PUT /notifications/preferences bounds validation (1..48)
  const excessiveChanges = Array.from({ length: 49 }, (_, i) => ({
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


