/**
 * Shared governance / polls domain fixtures & pure domain logic (#041).
 * Used by both `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

import type { MembershipView, TargetScope } from '../../api/schema'
import {
  compareCanonicalNumbers,
  computeNumberStats,
  isValidCanonicalDate,
  isValidCanonicalNumber,
  normalizeCanonicalNumber,
} from '../../utils/pollValidation.js'
import {
  MOCK_KNOWN_APARTMENT_ENTRANCES,
  MOCK_MEMBERSHIPS_BY_USER,
  type MockSeedUser,
} from './property.js'

export interface MockPollOption {
  id: string
  position: number
  value: string
}

export interface MockPollQuestion {
  id: string
  position: number
  text: string
  prompt: string
  answer_mode: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'OWN_VALUE'
  value_type: 'TEXT' | 'NUMBER' | 'DATE'
  required: boolean
  min_choices: number | null
  max_choices: number | null
  min_value: string | null
  max_value: string | null
  options: MockPollOption[]
}

export interface MockPollAnswer {
  question_id: string
  option_ids: string[]
  value: string | null
}

export interface MockPollBallot {
  apartment_id: string | null
  user_id: string | null
  submitted_at: string
  updated_at: string
  answers: MockPollAnswer[]
}

export interface MockInternalPoll {
  id: string
  kind: 'INFORMATIVE'
  title: string
  description: string
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'CANCELLED'
  target_scope: TargetScope
  target_entrance: number | null
  target_apartment_ids: string[] | null
  eligibility: 'RESIDENTS' | 'OWNERS'
  unit: 'APARTMENT' | 'PERSON'
  closes_at: string
  opened_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  created_at: string
  questions: MockPollQuestion[]
  ballots: MockPollBallot[]
}

export function getMockNextTwoSaturdays(now: Date = new Date()): [string, string] {
  const day = now.getUTCDay()
  const daysToNextSat = (6 - day + 7) % 7 || 7
  const sat1 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat),
  )
  const sat2 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat + 7),
  )
  return [sat1.toISOString().slice(0, 10), sat2.toISOString().slice(0, 10)]
}

export function createDefaultMockPolls(nowMs: number = Date.now()): MockInternalPoll[] {
  const [sat1, sat2] = getMockNextTwoSaturdays(new Date(nowMs))
  return [
    {
      id: '018f0000-0000-7000-8000-000000000851',
      kind: 'INFORMATIVE',
      title: 'Spring clean-up in the yard',
      description:
        'We are planning the annual courtyard clean-up, hedge trimming, and bicycle shed tidying. Please let the board know which Saturday works best for your household and whether any tools or supplies are needed.',
      status: 'OPEN',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'RESIDENTS',
      unit: 'APARTMENT',
      closes_at: new Date(nowMs + 14 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
      opened_at: '2026-10-24T09:00:00Z',
      closed_at: null,
      cancelled_at: null,
      created_at: '2026-10-24T08:45:00Z',
      questions: [
        {
          id: '018f0000-0000-7000-8000-000000000861',
          position: 1,
          text: 'Which Saturday suits you?',
          prompt: 'Which Saturday suits you?',
          answer_mode: 'MULTIPLE_CHOICE',
          value_type: 'DATE',
          required: true,
          min_choices: 1,
          max_choices: 2,
          min_value: null,
          max_value: null,
          options: [
            {
              id: '018f0000-0000-7000-8000-000000000871',
              position: 1,
              value: sat1,
            },
            {
              id: '018f0000-0000-7000-8000-000000000872',
              position: 2,
              value: sat2,
            },
          ],
        },
        {
          id: '018f0000-0000-7000-8000-000000000862',
          position: 2,
          text: 'Anything the board should know?',
          prompt: 'Anything the board should know?',
          answer_mode: 'OWN_VALUE',
          value_type: 'TEXT',
          required: false,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [],
        },
      ],
      ballots: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000301',
          user_id: null,
          submitted_at: '2026-10-24T11:15:00Z',
          updated_at: '2026-10-24T11:15:00Z',
          answers: [
            {
              question_id: '018f0000-0000-7000-8000-000000000861',
              option_ids: ['018f0000-0000-7000-8000-000000000871'],
              value: null,
            },
            {
              question_id: '018f0000-0000-7000-8000-000000000862',
              option_ids: [],
              value: 'We can bring two rakes and heavy-duty garden waste bags.',
            },
          ],
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000852',
      kind: 'INFORMATIVE',
      title: 'Courtyard EV charging readiness survey',
      description:
        'Informative survey for apartment owners on preparing electrical conduit capacity in the courtyard parking area before the 2027 budget draft.',
      status: 'OPEN',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'OWNERS',
      unit: 'APARTMENT',
      closes_at: new Date(nowMs + 21 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
      opened_at: '2026-10-25T10:00:00Z',
      closed_at: null,
      cancelled_at: null,
      created_at: '2026-10-25T09:30:00Z',
      questions: [
        {
          id: '018f0000-0000-7000-8000-000000000863',
          position: 1,
          text: 'Preferred approach for load-shared EV readiness',
          prompt: 'Preferred approach for load-shared EV readiness',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'TEXT',
          required: true,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [
            {
              id: '018f0000-0000-7000-8000-000000000873',
              position: 1,
              value: 'Install shared main cable conduit for all bays in 2027',
            },
            {
              id: '018f0000-0000-7000-8000-000000000874',
              position: 2,
              value: 'Phase installation starting with 4 shared charging bays',
            },
            {
              id: '018f0000-0000-7000-8000-000000000875',
              position: 3,
              value: 'Postpone until 2028 maintenance plan',
            },
          ],
        },
        {
          id: '018f0000-0000-7000-8000-000000000864',
          position: 2,
          text: 'Maximum one-time reserve contribution per apartment (EUR)',
          prompt: 'Maximum one-time reserve contribution per apartment (EUR)',
          answer_mode: 'OWN_VALUE',
          value_type: 'NUMBER',
          required: false,
          min_choices: null,
          max_choices: null,
          min_value: '0',
          max_value: '1500',
          options: [],
        },
      ],
      ballots: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000301',
          user_id: null,
          submitted_at: '2026-10-25T12:10:00Z',
          updated_at: '2026-10-25T12:10:00Z',
          answers: [
            {
              question_id: '018f0000-0000-7000-8000-000000000863',
              option_ids: ['018f0000-0000-7000-8000-000000000873'],
              value: null,
            },
            {
              question_id: '018f0000-0000-7000-8000-000000000864',
              option_ids: [],
              value: '350',
            },
          ],
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000853',
      kind: 'INFORMATIVE',
      title: 'Stairwell LED lighting & motion sensor schedule',
      description:
        'Completed resident poll on stairwell lighting warmth and night dimming hours.',
      status: 'CLOSED',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'RESIDENTS',
      unit: 'APARTMENT',
      closes_at: '2026-10-15T20:59:59Z',
      opened_at: '2026-10-01T09:00:00Z',
      closed_at: '2026-10-15T21:00:00Z',
      cancelled_at: null,
      created_at: '2026-10-01T08:30:00Z',
      questions: [
        {
          id: '018f0000-0000-7000-8000-000000000865',
          position: 1,
          text: 'Preferred stairwell colour temperature',
          prompt: 'Preferred stairwell colour temperature',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'TEXT',
          required: true,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [
            {
              id: '018f0000-0000-7000-8000-000000000876',
              position: 1,
              value: 'Warm white (3000K)',
            },
            {
              id: '018f0000-0000-7000-8000-000000000877',
              position: 2,
              value: 'Neutral white (4000K)',
            },
          ],
        },
      ],
      ballots: [
        {
          apartment_id: '018f0000-0000-7000-8000-000000000314',
          user_id: null,
          submitted_at: '2026-10-04T18:20:00Z',
          updated_at: '2026-10-04T18:20:00Z',
          answers: [
            {
              question_id: '018f0000-0000-7000-8000-000000000865',
              option_ids: ['018f0000-0000-7000-8000-000000000876'],
              value: null,
            },
          ],
        },
        {
          apartment_id: '018f0000-0000-7000-8000-000000000301',
          user_id: null,
          submitted_at: '2026-10-03T10:00:00Z',
          updated_at: '2026-10-03T10:00:00Z',
          answers: [
            {
              question_id: '018f0000-0000-7000-8000-000000000865',
              option_ids: ['018f0000-0000-7000-8000-000000000876'],
              value: null,
            },
          ],
        },
      ],
    },
    {
      id: '018f0000-0000-7000-8000-000000000854',
      kind: 'INFORMATIVE',
      title: 'August courtyard movie evening date',
      description:
        'Cancelled due to scheduled facade inspection scaffolding in the courtyard.',
      status: 'CANCELLED',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'RESIDENTS',
      unit: 'PERSON',
      closes_at: '2026-08-20T20:59:59Z',
      opened_at: '2026-08-10T09:00:00Z',
      closed_at: null,
      cancelled_at: '2026-08-12T15:00:00Z',
      created_at: '2026-08-10T08:30:00Z',
      questions: [
        {
          id: '018f0000-0000-7000-8000-000000000866',
          position: 1,
          text: 'Preferred evening date',
          prompt: 'Preferred evening date',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'DATE',
          required: true,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [
            {
              id: '018f0000-0000-7000-8000-000000000878',
              position: 1,
              value: '2026-08-22',
            },
          ],
        },
      ],
      ballots: [],
    },
    {
      id: '018f0000-0000-7000-8000-000000000855',
      kind: 'INFORMATIVE',
      title: 'Courtyard playground bench replacement',
      description:
        'Draft survey on replacing the two wooden benches next to the courtyard sandbox before spring.',
      status: 'DRAFT',
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      eligibility: 'RESIDENTS',
      unit: 'APARTMENT',
      closes_at: new Date(nowMs + 28 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
      opened_at: null,
      closed_at: null,
      cancelled_at: null,
      created_at: '2026-10-26T10:00:00Z',
      questions: [
        {
          id: '018f0000-0000-7000-8000-000000000867',
          position: 1,
          text: 'Which bench material do you prefer?',
          prompt: 'Which bench material do you prefer?',
          answer_mode: 'SINGLE_CHOICE',
          value_type: 'TEXT',
          required: true,
          min_choices: null,
          max_choices: null,
          min_value: null,
          max_value: null,
          options: [
            {
              id: '018f0000-0000-7000-8000-000000000879',
              position: 1,
              value: 'Oiled larch timber with backrest',
            },
            {
              id: '018f0000-0000-7000-8000-000000000880',
              position: 2,
              value: 'Recycled composite slats with steel frame',
            },
          ],
        },
      ],
      ballots: [],
    },
  ]
}

export function isMockApartmentTargetedByPoll(
  poll: MockInternalPoll,
  aptId: string,
  entrance: number,
): boolean {
  if (poll.target_scope === 'ALL_BUILDING') return true
  if (poll.target_scope === 'ENTRANCE') return poll.target_entrance === entrance
  if (poll.target_scope === 'APARTMENT_LIST') {
    return Array.isArray(poll.target_apartment_ids) && poll.target_apartment_ids.includes(aptId)
  }
  return true
}

export function isMockPollVisibleToUser(
  poll: MockInternalPoll,
  user: MockSeedUser,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
): boolean {
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  if (poll.status === 'DRAFT') return isBoardUser
  if (isBoardUser || user.building_role === 'ACCOUNTANT') return true
  const mems = membershipsByUser[user.user_id] || []
  return mems.some((m) => isMockApartmentTargetedByPoll(poll, m.apartment_id, m.entrance))
}

export function computeMockPollAnswerability(
  poll: MockInternalPoll,
  user: MockSeedUser,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
): { canAnswer: boolean; answerableApartmentIds: string[] } {
  if (poll.status !== 'OPEN' || new Date(poll.closes_at).getTime() <= Date.now()) {
    return { canAnswer: false, answerableApartmentIds: [] }
  }
  const mems = membershipsByUser[user.user_id] || []
  const qualifying = mems.filter((m) => {
    if (!isMockApartmentTargetedByPoll(poll, m.apartment_id, m.entrance)) return false
    if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
    return true
  })

  if (poll.unit === 'PERSON') {
    return { canAnswer: qualifying.length > 0, answerableApartmentIds: [] }
  }
  const sortedIds = qualifying
    .slice()
    .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
    .map((m) => m.apartment_id)
  return { canAnswer: sortedIds.length > 0, answerableApartmentIds: sortedIds }
}

export function computeMockMyBallots(
  poll: MockInternalPoll,
  user: MockSeedUser,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
) {
  if (poll.status === 'CANCELLED') return []
  if (poll.unit === 'PERSON') {
    return poll.ballots
      .filter((b) => b.user_id === user.user_id)
      .map((b) => ({
        apartment_id: null,
        submitted_at: b.submitted_at,
        updated_at: b.updated_at,
        answers: b.answers.map((a) => ({
          question_id: a.question_id,
          option_ids: [...a.option_ids],
          value: a.value,
        })),
      }))
  }
  const mems = membershipsByUser[user.user_id] || []
  const visibleAptIds = mems
    .filter((m) => {
      if (!isMockApartmentTargetedByPoll(poll, m.apartment_id, m.entrance)) return false
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
      return true
    })
    .map((m) => m.apartment_id)

  return poll.ballots
    .filter((b) => b.apartment_id && visibleAptIds.includes(b.apartment_id))
    .map((b) => ({
      apartment_id: b.apartment_id,
      submitted_at: b.submitted_at,
      updated_at: b.updated_at,
      answers: b.answers.map((a) => ({
        question_id: a.question_id,
        option_ids: [...a.option_ids],
        value: a.value,
      })),
    }))
}

export function compareMockPollsOrder(a: MockInternalPoll, b: MockInternalPoll): number {
  const aOpen = a.status === 'OPEN' ? 0 : 1
  const bOpen = b.status === 'OPEN' ? 0 : 1
  if (aOpen !== bOpen) return aOpen - bOpen
  if (a.status === 'OPEN' && b.status === 'OPEN') {
    return new Date(a.closes_at).getTime() - new Date(b.closes_at).getTime()
  }
  const aRef = a.opened_at || a.created_at
  const bRef = b.opened_at || b.created_at
  return new Date(bRef).getTime() - new Date(aRef).getTime()
}

export function toMockPollSummary(
  poll: MockInternalPoll,
  user: MockSeedUser,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
) {
  const { canAnswer, answerableApartmentIds } = computeMockPollAnswerability(
    poll,
    user,
    membershipsByUser,
  )
  const myBallots = computeMockMyBallots(poll, user, membershipsByUser)
  const answered =
    poll.status === 'CANCELLED'
      ? false
      : poll.unit === 'APARTMENT' && answerableApartmentIds.length > 0
        ? answerableApartmentIds.every((id) => myBallots.some((b) => b.apartment_id === id))
        : myBallots.length > 0
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  const resultsAvailable =
    poll.status === 'CLOSED' || (poll.status === 'OPEN' && isBoardUser)

  return {
    id: poll.id,
    kind: poll.kind,
    title: poll.title,
    description: poll.description,
    status: poll.status,
    target_scope: poll.target_scope,
    target_entrance: poll.target_entrance,
    target_apartment_ids: poll.target_apartment_ids,
    eligibility: poll.eligibility,
    unit: poll.unit,
    closes_at: poll.closes_at,
    opened_at: poll.opened_at,
    closed_at: poll.closed_at,
    cancelled_at: poll.cancelled_at,
    created_at: poll.created_at,
    results_available: resultsAvailable,
    can_answer: canAnswer,
    answerable_apartment_ids: answerableApartmentIds,
    answered,
  }
}

export function toMockPollView(
  poll: MockInternalPoll,
  user: MockSeedUser,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
) {
  const summary = toMockPollSummary(poll, user, membershipsByUser)
  const { answered: _answered, ...rest } = summary
  return {
    ...rest,
    questions: poll.questions.map((q) => ({
      id: q.id,
      position: q.position,
      text: q.text || q.prompt,
      prompt: q.text || q.prompt,
      answer_mode: q.answer_mode,
      value_type: q.value_type,
      required: q.required,
      min_choices: q.min_choices,
      max_choices: q.max_choices,
      min_value: q.min_value,
      max_value: q.max_value,
      options: q.options.map((o) => ({ ...o })),
    })),
    my_ballots: computeMockMyBallots(poll, user, membershipsByUser),
  }
}

export function computeMockPollElectorateCount(
  poll: MockInternalPoll,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
): number {
  const targetedAptIds = Object.entries(MOCK_KNOWN_APARTMENT_ENTRANCES)
    .filter(([aptId, ent]) => isMockApartmentTargetedByPoll(poll, aptId, ent))
    .map(([aptId]) => aptId)

  if (poll.unit === 'APARTMENT') {
    let eligible = 0
    for (const aptId of targetedAptIds) {
      if (aptId === '018f0000-0000-7000-8000-000000000305') continue
      if (aptId === '018f0000-0000-7000-8000-000000000302') {
        if (poll.eligibility !== 'OWNERS') eligible += 1
        continue
      }
      eligible += 1
    }
    return eligible
  }

  const eligibleUsers = new Set<string>()
  for (const [uid, mems] of Object.entries(membershipsByUser)) {
    const qualifies = mems.some((m) => {
      if (!targetedAptIds.includes(m.apartment_id)) return false
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
      return true
    })
    if (qualifies) eligibleUsers.add(uid)
  }
  return eligibleUsers.size
}

export function computeMockPollResults(
  poll: MockInternalPoll,
  isBoardUser: boolean,
  membershipsByUser: Record<string, MembershipView[]> = MOCK_MEMBERSHIPS_BY_USER,
) {
  const electorate = computeMockPollElectorateCount(poll, membershipsByUser)
  const answeredUnits = poll.ballots.length

  const questions = poll.questions.map((q) => {
    let qAnswered = 0

    if (q.answer_mode === 'SINGLE_CHOICE' || q.answer_mode === 'MULTIPLE_CHOICE') {
      const countsByOption = new Map<string, number>()
      for (const opt of q.options) {
        countsByOption.set(opt.id, 0)
      }
      for (const ballot of poll.ballots) {
        const ans = ballot.answers.find((a) => a.question_id === q.id)
        if (ans && Array.isArray(ans.option_ids) && ans.option_ids.length > 0) {
          qAnswered += 1
          for (const oid of ans.option_ids) {
            if (countsByOption.has(oid)) {
              countsByOption.set(oid, (countsByOption.get(oid) || 0) + 1)
            }
          }
        }
      }
      return {
        question_id: q.id,
        answered: qAnswered,
        options: q.options.map((opt) => ({
          option_id: opt.id,
          count: countsByOption.get(opt.id) || 0,
        })),
        number: null,
        dates: null,
        texts: null,
      }
    }

    const rawValues: string[] = []
    for (const ballot of poll.ballots) {
      const ans = ballot.answers.find((a) => a.question_id === q.id)
      const val = ans?.value != null ? String(ans.value).trim() : ''
      if (val !== '') {
        qAnswered += 1
        rawValues.push(val)
      }
    }

    if (q.value_type === 'NUMBER') {
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: computeNumberStats(rawValues),
        dates: null,
        texts: null,
      }
    }

    if (q.value_type === 'DATE') {
      const dateCounts = new Map<string, number>()
      for (const v of rawValues) {
        dateCounts.set(v, (dateCounts.get(v) || 0) + 1)
      }
      const dates = Array.from(dateCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: null,
        dates,
        texts: null,
      }
    }

    let texts: Array<{ value: string; count: number }> | null = null
    if (isBoardUser) {
      const textCounts = new Map<string, number>()
      for (const v of rawValues) {
        textCounts.set(v, (textCounts.get(v) || 0) + 1)
      }
      texts = Array.from(textCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
    }

    return {
      question_id: q.id,
      answered: qAnswered,
      options: null,
      number: null,
      dates: null,
      texts,
    }
  })

  return {
    poll_id: poll.id,
    status: poll.status,
    unit: poll.unit,
    participation: {
      answered: answeredUnits,
      electorate,
    },
    questions,
  }
}

export interface RawBallotAnswerInput {
  question_id?: unknown
  option_ids?: unknown
  value?: unknown
}

export function validateMockBallotAnswers(
  questions: MockPollQuestion[],
  rawAnswers: RawBallotAnswerInput[],
): {
  valid: boolean
  questionId?: string
  reason?: string
  normalizedAnswers: MockPollAnswer[]
} {
  const seenQuestions = new Set<string>()
  const byQuestionId = new Map<string, RawBallotAnswerInput>()

  for (const item of rawAnswers) {
    const qId = String(item?.question_id || '')
    if (seenQuestions.has(qId)) {
      return { valid: false, questionId: qId, reason: 'DUPLICATE', normalizedAnswers: [] }
    }
    const qDef = questions.find((q) => q.id === qId)
    if (!qDef) {
      return { valid: false, questionId: qId, reason: 'UNKNOWN_QUESTION', normalizedAnswers: [] }
    }
    seenQuestions.add(qId)
    byQuestionId.set(qId, item)
  }

  const normalizedAnswers: MockPollAnswer[] = []

  for (const q of questions) {
    const item = byQuestionId.get(q.id)
    const optIds: string[] = Array.isArray(item?.option_ids)
      ? item.option_ids.map((id: unknown) => String(id))
      : []
    const rawValue = item?.value != null ? String(item.value) : ''

    if (q.answer_mode === 'SINGLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      if (optIds.length !== 1) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      const validIds = new Set(q.options.map((o) => o.id))
      if (!validIds.has(optIds[0])) {
        return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] }
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [optIds[0]],
        value: null,
      })
    } else if (q.answer_mode === 'MULTIPLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      const uniqueOpts = new Set(optIds)
      if (uniqueOpts.size !== optIds.length) {
        return { valid: false, questionId: q.id, reason: 'DUPLICATE', normalizedAnswers: [] }
      }
      const validIds = new Set(q.options.map((o) => o.id))
      for (const id of optIds) {
        if (!validIds.has(id)) {
          return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] }
        }
      }
      const minC = q.min_choices ?? 1
      const maxC = q.max_choices ?? q.options.length
      if (optIds.length < minC || optIds.length > maxC) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [...optIds],
        value: null,
      })
    } else if (q.answer_mode === 'OWN_VALUE') {
      if (optIds.length > 0) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      const trimmed = rawValue.trim()
      if (trimmed === '') {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      if (q.value_type === 'TEXT') {
        if (trimmed.length > 2000) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        })
      } else if (q.value_type === 'NUMBER') {
        const canonical = normalizeCanonicalNumber(trimmed)
        if (!canonical || !isValidCanonicalNumber(canonical)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        if (q.min_value != null && compareCanonicalNumbers(canonical, q.min_value) < 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        if (q.max_value != null && compareCanonicalNumbers(canonical, q.max_value) > 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: canonical,
        })
      } else if (q.value_type === 'DATE') {
        if (!isValidCanonicalDate(trimmed)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        if (q.min_value != null && trimmed < q.min_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        if (q.max_value != null && trimmed > q.max_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        })
      }
    }
  }

  return { valid: true, normalizedAnswers }
}
