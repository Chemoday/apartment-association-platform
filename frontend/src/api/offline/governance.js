import {
  UNHANDLED,
  OFFLINE_MEMBERSHIPS_BY_USER,
  OFFLINE_POLLS,
  makeOfflineError,
  isOfflinePollVisibleToUser,
  computeOfflinePollAnswerability,
  compareOfflinePollsOrder,
  toOfflinePollSummary,
  toOfflinePollView,
  computeOfflinePollResults,
  validateOfflinePollDraft,
  emitOfflinePollOpenedNotifications,
  validateOfflineBallotAnswers,
} from './state.js'
import {
  computeMockPollElectorateCount,
} from '../../mocks/domains/index.js'

export async function handleOfflineGovernance(ctx) {
  const { urlObj, pathname, method, body, user } = ctx

  if (pathname === '/governance/polls' && method === 'GET') {
    const statusFilter = urlObj.searchParams.get('status')
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || '50'), 1), 100)
    const offset = Math.max(Number(urlObj.searchParams.get('offset') || '0'), 0)

    if (statusFilter && !['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'].includes(statusFilter)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid poll status filter.')
    }

    const visible = OFFLINE_POLLS.filter((p) => {
      if (!isOfflinePollVisibleToUser(p, user)) return false
      if (statusFilter && p.status !== statusFilter) return false
      return true
    })

    visible.sort(compareOfflinePollsOrder)
    return visible.slice(offset, offset + limit).map((p) => toOfflinePollSummary(p, user))
  }

  if (pathname === '/governance/polls' && method === 'POST') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can create polls.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const parsed = validateOfflinePollDraft(reqBody)
    const nowIso = new Date().toISOString()
    const created = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      ...parsed,
      status: 'DRAFT',
      opened_at: null,
      closed_at: null,
      cancelled_at: null,
      created_at: nowIso,
      ballots: [],
    }
    OFFLINE_POLLS.unshift(created)
    return toOfflinePollView(created, user)
  }

  const offlinePollActionMatch = pathname.match(
    /^\/governance\/polls\/([^/]+)\/(open|close|cancel)$/,
  )
  if (offlinePollActionMatch && method === 'POST') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can manage polls.')
    }
    const [, pollId, action] = offlinePollActionMatch
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const maxFutureMs = nowMs + 366 * 86400 * 1000

    if (action === 'open') {
      if (found.status !== 'DRAFT') {
        throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be opened.')
      }
      const closesMs = new Date(found.closes_at).getTime()
      if (Number.isNaN(closesMs) || closesMs <= nowMs || closesMs > maxFutureMs) {
        throw makeOfflineError(
          422,
          'INVALID_DEADLINE',
          'The closing time must be in the future (at most one year ahead).',
        )
      }
      if (computeMockPollElectorateCount(found, OFFLINE_MEMBERSHIPS_BY_USER) < 1) {
        throw makeOfflineError(
          422,
          'POLL_HAS_NO_ELECTORATE',
          'Nobody in the target scope can answer this poll.',
        )
      }
      found.status = 'OPEN'
      found.opened_at = nowIso
      emitOfflinePollOpenedNotifications(found, user, nowIso)
      return toOfflinePollView(found, user)
    }

    if (action === 'close') {
      if (found.status !== 'OPEN') {
        throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll can be closed.')
      }
      found.status = 'CLOSED'
      found.closed_at = nowIso
      return toOfflinePollView(found, user)
    }

    if (action === 'cancel') {
      if (found.status !== 'OPEN') {
        throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll can be cancelled.')
      }
      found.status = 'CANCELLED'
      found.cancelled_at = nowIso
      return toOfflinePollView(found, user)
    }
  }

  const offlinePollDetailMatch = pathname.match(/^\/governance\/polls\/([^/]+)$/)
  if (offlinePollDetailMatch && method === 'GET') {
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    return toOfflinePollView(found, user)
  }

  if (offlinePollDetailMatch && method === 'PUT') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can edit poll drafts.')
    }
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'DRAFT') {
      throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be edited.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const parsed = validateOfflinePollDraft(reqBody)
    Object.assign(found, parsed)
    return toOfflinePollView(found, user)
  }

  if (offlinePollDetailMatch && method === 'DELETE') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can delete poll drafts.')
    }
    const pollId = offlinePollDetailMatch[1]
    const idx = OFFLINE_POLLS.findIndex((p) => p.id === pollId)
    if (idx === -1) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (OFFLINE_POLLS[idx].status !== 'DRAFT') {
      throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be deleted.')
    }
    OFFLINE_POLLS.splice(idx, 1)
    return null
  }

  if (offlinePollDetailMatch && method === 'PATCH') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can extend poll deadlines.')
    }
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'OPEN') {
      throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll deadline can be extended.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const nextClosesAt = typeof reqBody?.closes_at === 'string' ? reqBody.closes_at.trim() : ''
    const nextMs = new Date(nextClosesAt).getTime()
    const currentMs = new Date(found.closes_at).getTime()
    const maxFutureMs = Date.now() + 366 * 86400 * 1000
    if (!nextClosesAt || Number.isNaN(nextMs) || nextMs <= currentMs || nextMs > maxFutureMs) {
      throw makeOfflineError(
        422,
        'INVALID_DEADLINE',
        'The new deadline must be later than the current deadline (and at most one year from now).',
      )
    }
    found.closes_at = nextClosesAt
    return toOfflinePollView(found, user)
  }

  const offlinePollBallotMatch = pathname.match(/^\/governance\/polls\/([^/]+)\/ballot$/)
  if (offlinePollBallotMatch && method === 'PUT') {
    const pollId = offlinePollBallotMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'OPEN' || new Date(found.closes_at).getTime() <= Date.now()) {
      throw makeOfflineError(409, 'POLL_NOT_OPEN', 'This poll has closed.')
    }

    const { canAnswer, answerableApartmentIds } = computeOfflinePollAnswerability(found, user)
    if (!canAnswer) {
      throw makeOfflineError(403, 'NOT_ELIGIBLE', 'You cannot answer this poll.')
    }

    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    let targetApartmentId = null
    if (found.unit === 'PERSON') {
      if (reqBody.apartment_id !== undefined && reqBody.apartment_id !== null) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'apartment_id must not be sent for a PERSON poll.',
        )
      }
    } else {
      if (reqBody.apartment_id !== undefined && reqBody.apartment_id !== null) {
        if (!answerableApartmentIds.includes(String(reqBody.apartment_id))) {
          throw makeOfflineError(403, 'NOT_ELIGIBLE', 'You cannot answer for this apartment.')
        }
        targetApartmentId = String(reqBody.apartment_id)
      } else if (answerableApartmentIds.length === 1) {
        targetApartmentId = answerableApartmentIds[0]
      } else {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Select which apartment is answering.')
      }
    }

    if (!Array.isArray(reqBody.answers)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'answers must be an array.')
    }

    const validation = validateOfflineBallotAnswers(found.questions, reqBody.answers)
    if (!validation.valid) {
      throw makeOfflineError(422, 'INVALID_ANSWER', 'Invalid answer.', {
        question_id: validation.questionId,
        reason: validation.reason,
      })
    }

    const nowIso = new Date().toISOString()
    const normalizedAnswers = validation.normalizedAnswers

    const existingIdx = found.ballots.findIndex((b) =>
      found.unit === 'APARTMENT'
        ? b.apartment_id === targetApartmentId
        : b.user_id === user.user_id,
    )

    if (existingIdx >= 0) {
      found.ballots[existingIdx] = {
        ...found.ballots[existingIdx],
        updated_at: nowIso,
        answers: normalizedAnswers,
      }
    } else {
      found.ballots.push({
        apartment_id: found.unit === 'APARTMENT' ? targetApartmentId : null,
        user_id: found.unit === 'PERSON' ? user.user_id : null,
        submitted_at: nowIso,
        updated_at: nowIso,
        answers: normalizedAnswers,
      })
    }

    return toOfflinePollView(found, user)
  }

  const offlinePollResultsMatch = pathname.match(/^\/governance\/polls\/([^/]+)\/results$/)
  if (offlinePollResultsMatch && method === 'GET') {
    const pollId = offlinePollResultsMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const resultsAvailable =
      found.status === 'CLOSED' || (found.status === 'OPEN' && isBoardUser)
    if (!resultsAvailable) {
      throw makeOfflineError(
        409,
        'RESULTS_NOT_AVAILABLE',
        'Results are not available for this poll.',
        { status: found.status },
      )
    }
    return computeOfflinePollResults(found, isBoardUser)
  }


  return UNHANDLED
}
