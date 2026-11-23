import {
  cloneDefaultAssociationSettings,
} from '../../utils/associationSettings.js'
import {
  createDefaultIssuesSeed,
} from '../../utils/issues.js'
import {
  createDefaultDocumentsSeed,
} from '../../utils/documents.js'
import {
  computeStorageUsage,
  evaluateStorageThresholdNotification,
} from '../../utils/storage.js'
import {
  createDefaultMaintenanceLogSeed,
  createDefaultMaintenanceSeed,
} from '../../utils/maintenance.js'
import {
  createDemoEeBuildingFacts,
} from '../../utils/buildingPassport.js'
import {
  MOCK_APARTMENT_CARDS,
  MOCK_BASE_APARTMENTS_2026_10,
  MOCK_BUILDING,
  MOCK_BUILDING_ID,
  MOCK_DEFAULT_PERIODS,
  MOCK_DEMO_USERS,
  MOCK_KNOWN_APARTMENT_ENTRANCES,
  MOCK_MEMBERSHIPS_BY_USER,
  compareMockPollsOrder,
  computeMockPollAnswerability,
  computeMockPollResults,
  createDefaultMockPolls,
  createDefaultMockPosts,
  createDefaultMockUserPreferences,
  createInitialMockNotificationsForUser,
  createMockApartmentsByPeriod,
  createMockMasterMetersByPeriod,
  getMockNoticeRecipientUserIds,
  isMockPollVisibleToUser,
  toMockPollSummary,
  toMockPollView,
  validateMockBallotAnswers,
} from '../../mocks/domains/index.js'
import { isOfflineDemoMode } from '../offlineDemoState.js'

export { isOfflineDemoMode }


let offlineNotificationsByUser = {}
let offlinePreferencesByUser = {}
let offlineSettings = cloneDefaultAssociationSettings()
let offlineIssues = createDefaultIssuesSeed()
let offlineIssuePhotoIdempotency = new Map()
let offlineIssuePhotoDailyUploads = []
export const activeOfflinePhotoUploads = new Map()
let offlineDocuments = createDefaultDocumentsSeed()
let offlineDocumentIdempotency = new Map()
export const activeOfflineDocumentUploads = new Map()
let offlineMaintenance = createDefaultMaintenanceSeed()
let offlineMaintenanceLog = createDefaultMaintenanceLogSeed()
let offlineApartmentsByPeriod = {}
let offlineMasterMetersByPeriod = {}
let offlinePeriods = []
let offlineExtraPendingDeletionBytes = 0
let offlineStorageAlertState = { armed70: true, armed90: true }
let offlineChatTurnedOnAt = null
let offlineChatMessages = []
let offlineChatNextId = 1
let offlineChatPostTimestampsByUser = {}

export function createInitialOfflineRegistryState() {
  return {
    accepted: createDemoEeBuildingFacts('2026-11-15T09:00:00Z'),
    accepted_at: '2026-11-15T09:05:00Z',
    proposal: null,
    proposal_fetched_at: null,
  }
}

let offlineRegistryState = createInitialOfflineRegistryState()
export const REGISTRY_CALLS_PER_DAY = 10
let offlineRegistryDailyCalls = { date: '', count: 0 }

export function consumeOfflineRegistryQuota() {
  const nowMs = Date.now()
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10)
  if (offlineRegistryDailyCalls.date !== todayUtc) {
    offlineRegistryDailyCalls = { date: todayUtc, count: 0 }
  }
  if (offlineRegistryDailyCalls.count >= REGISTRY_CALLS_PER_DAY) {
    const now = new Date(nowMs)
    const nextMidnightMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
    )
    const retryAfterSeconds = Math.max(1, Math.ceil((nextMidnightMs - nowMs) / 1000))
    throw makeOfflineError(
      429,
      'RATE_LIMITED',
      'Daily building register lookup limit reached.',
      {
        reason: 'DAILY_LIMIT',
        retry_after_seconds: retryAfterSeconds,
      },
    )
  }
  offlineRegistryDailyCalls.count += 1
}

export function enableOfflineDemo() {
  isOfflineDemoMode.value = true
  offlineNotificationsByUser = {}
  offlinePreferencesByUser = {}
  offlineSettings = cloneDefaultAssociationSettings()
  offlineIssues = createDefaultIssuesSeed()
  offlineIssuePhotoIdempotency = new Map()
  offlineIssuePhotoDailyUploads = []
  activeOfflinePhotoUploads.clear()
  offlineDocuments = createDefaultDocumentsSeed()
  offlineDocumentIdempotency = new Map()
  activeOfflineDocumentUploads.clear()
  offlineMaintenance = createDefaultMaintenanceSeed()
  offlineMaintenanceLog = createDefaultMaintenanceLogSeed()
  offlineApartmentsByPeriod = {}
  offlineMasterMetersByPeriod = {}
  offlinePeriods = []
  offlineExtraPendingDeletionBytes = 0
  offlineStorageAlertState = { armed70: true, armed90: true }
  offlineChatTurnedOnAt = null
  offlineChatMessages = []
  offlineChatNextId = 1
  offlineChatPostTimestampsByUser = {}
  offlineRegistryState = createInitialOfflineRegistryState()
  offlineRegistryDailyCalls = { date: '', count: 0 }
  OFFLINE_POSTS.splice(0, OFFLINE_POSTS.length, ...createDefaultOfflinePosts())
}

export function disableOfflineDemo() {
  isOfflineDemoMode.value = false
}

export const BUILDING_ID = MOCK_BUILDING_ID

let offlineMagicLinkUsed = false
let offlineSessions = []
let offlineSignedInUserId = ''
let offlineHasPassword = true

export const OFFLINE_DEMO_USERS = MOCK_DEMO_USERS
export const OFFLINE_MEMBERSHIPS_BY_USER = MOCK_MEMBERSHIPS_BY_USER
export const OFFLINE_BUILDING = MOCK_BUILDING
export const OFFLINE_APARTMENT_CARDS = MOCK_APARTMENT_CARDS
export const OFFLINE_PERIODS = MOCK_DEFAULT_PERIODS
export const BASE_APARTMENTS_2026_10 = MOCK_BASE_APARTMENTS_2026_10

export function getOfflinePeriods() {
  if (!offlinePeriods.length) {
    offlinePeriods = JSON.parse(JSON.stringify(OFFLINE_PERIODS))
  }
  return offlinePeriods
}

export function getPeriodMasterMeters(periodCode) {
  if (!offlineMasterMetersByPeriod['2026-10']) {
    offlineMasterMetersByPeriod = createMockMasterMetersByPeriod()
  }
  const code = periodCode || '2026-10'
  return offlineMasterMetersByPeriod[code] || offlineMasterMetersByPeriod['2026-10']
}

export function getPeriodApartments(periodCode) {
  if (!offlineApartmentsByPeriod['2026-10']) {
    offlineApartmentsByPeriod = createMockApartmentsByPeriod()
  }
  const code = periodCode || '2026-10'
  return offlineApartmentsByPeriod[code] || offlineApartmentsByPeriod['2026-10']
}

export function findOfflineMeterInPeriod(periodCode, meterId) {
  const apts = getPeriodApartments(periodCode)
  for (const apt of apts) {
    const meter = apt.meters.find((item) => item.meter_id === meterId)
    if (meter) return { apt, meter }
  }
  return null
}

export function findOfflineMasterMeterInPeriod(periodCode, meterId) {
  const masters = getPeriodMasterMeters(periodCode)
  return masters.find((item) => item.meter_id === meterId) || null
}

export function computeOfflineNextSubmission(meterId, aptCanSubmit, membershipCanSubmit) {
  if (!aptCanSubmit || !membershipCanSubmit) return null
  const periods = getOfflinePeriods()
  const pPrev = periods.find((p) => p.period_code === '2026-10')
  const pCurr = periods.find((p) => p.period_code === '2026-11')
  const mPrev = findOfflineMeterInPeriod('2026-10', meterId)?.meter || null
  const mCurr = findOfflineMeterInPeriod('2026-11', meterId)?.meter || null

  const startsInCurr = mPrev?.starts_in_period === '2026-11'
  const hasSubmittedPrev = Boolean(mPrev?.reading && mPrev.reading.source !== 'AUTO_ESTIMATED')
  const hasAnyCurr = Boolean(mCurr?.reading)

  if (
    !startsInCurr &&
    pPrev &&
    pPrev.status === 'OPEN_FOR_RESIDENTS' &&
    mPrev &&
    !hasSubmittedPrev &&
    !hasAnyCurr
  ) {
    return {
      period_code: pPrev.period_code,
      due_date: pPrev.due_date,
      final: true,
      previous_value: mPrev.previous_value,
      needs_start: Boolean(mPrev.needs_start),
      average_delta: mPrev.historical_avg ?? null,
      reading: null,
    }
  }

  if (pCurr && pCurr.status === 'OPEN_FOR_RESIDENTS' && mCurr) {
    return {
      period_code: pCurr.period_code,
      due_date: pCurr.due_date,
      final: false,
      previous_value: mCurr.previous_value,
      needs_start: Boolean(mCurr.needs_start),
      average_delta: mCurr.historical_avg ?? null,
      reading: mCurr.reading ? { ...mCurr.reading } : null,
    }
  }

  return null
}

export function createDefaultOfflinePosts() {
  return createDefaultMockPosts()
}

export const OFFLINE_POSTS = createDefaultOfflinePosts()

export function getActingUser(actingUserId) {
  const effectiveId = actingUserId || offlineSignedInUserId
  return (
    OFFLINE_DEMO_USERS.find((u) => u.user_id === effectiveId) || OFFLINE_DEMO_USERS[0]
  )
}

export function makeOfflineError(status, errorCode, message, extra = {}) {
  const err = new Error(message)
  err.status = status
  err.errorCode = errorCode
  err.payload = { error_code: errorCode, message, ...extra }
  err.fieldErrors = extra.errors || []
  return err
}


export const OFFLINE_KNOWN_APARTMENT_ENTRANCES = MOCK_KNOWN_APARTMENT_ENTRANCES
export const OFFLINE_POLLS = createDefaultMockPolls()

export function isOfflinePollVisibleToUser(poll, user) {
  return isMockPollVisibleToUser(poll, user, OFFLINE_MEMBERSHIPS_BY_USER)
}

export function computeOfflinePollAnswerability(poll, user) {
  return computeMockPollAnswerability(poll, user, OFFLINE_MEMBERSHIPS_BY_USER)
}

export function compareOfflinePollsOrder(a, b) {
  return compareMockPollsOrder(a, b)
}

export function toOfflinePollSummary(poll, user) {
  return toMockPollSummary(poll, user, OFFLINE_MEMBERSHIPS_BY_USER)
}

export function toOfflinePollView(poll, user) {
  return toMockPollView(poll, user, OFFLINE_MEMBERSHIPS_BY_USER)
}

export function computeOfflinePollResults(poll, isBoardUser) {
  return computeMockPollResults(poll, isBoardUser, OFFLINE_MEMBERSHIPS_BY_USER)
}

export function validateOfflinePollDraft(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > 255) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title is required.')
  }
  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  const targetScope = body?.target_scope
  if (!['ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST'].includes(targetScope)) {
    throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_scope.')
  }
  let targetEntrance = null
  let targetApartmentIds = null
  if (targetScope === 'ALL_BUILDING') {
    if (
      body.target_entrance != null ||
      (Array.isArray(body.target_apartment_ids) && body.target_apartment_ids.length > 0)
    ) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target fields for ALL_BUILDING.')
    }
  } else if (targetScope === 'ENTRANCE') {
    const ent = Number(body.target_entrance)
    if (!Number.isInteger(ent) || ![1, 2].includes(ent) || body.target_apartment_ids != null) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_entrance.')
    }
    targetEntrance = ent
  } else if (targetScope === 'APARTMENT_LIST') {
    if (
      body.target_entrance != null ||
      !Array.isArray(body.target_apartment_ids) ||
      body.target_apartment_ids.length === 0
    ) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_apartment_ids.')
    }
    const deduped = Array.from(new Set(body.target_apartment_ids.map((id) => String(id))))
    for (const aptId of deduped) {
      if (!OFFLINE_KNOWN_APARTMENT_ENTRANCES[aptId]) {
        throw makeOfflineError(422, 'INVALID_TARGET', 'Unknown apartment.')
      }
    }
    targetApartmentIds = deduped
  }

  const eligibility = body?.eligibility
  const unit = body?.unit
  const closesAt = typeof body?.closes_at === 'string' ? body.closes_at.trim() : ''
  if (
    !['RESIDENTS', 'OWNERS'].includes(eligibility) ||
    !['APARTMENT', 'PERSON'].includes(unit) ||
    !closesAt ||
    Number.isNaN(new Date(closesAt).getTime())
  ) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid poll settings.')
  }

  const rawQuestions = Array.isArray(body?.questions) ? body.questions : []
  if (rawQuestions.length < 1 || rawQuestions.length > 20) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', '1..20 questions required.')
  }

  const questions = rawQuestions.map((rq, idx) => {
    const qText = String(rq?.text ?? rq?.prompt ?? '').trim()
    if (!qText || qText.length > 500) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Question text is required.')
    }
    const mode = rq?.answer_mode
    const vType = rq?.value_type
    const rawOpts = Array.isArray(rq?.options) ? rq.options : []
    const options =
      mode === 'OWN_VALUE'
        ? []
        : rawOpts.map((o, oi) => ({
            id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
            position: oi + 1,
            value: String(typeof o === 'object' && o !== null ? o.value ?? '' : o ?? '').trim(),
          }))
    return {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      position: idx + 1,
      text: qText,
      prompt: qText,
      answer_mode: mode,
      value_type: vType,
      required: rq?.required !== false,
      min_choices: mode === 'MULTIPLE_CHOICE' ? (rq?.min_choices ?? 1) : null,
      max_choices: mode === 'MULTIPLE_CHOICE' ? (rq?.max_choices ?? options.length) : null,
      min_value: mode === 'OWN_VALUE' && vType !== 'TEXT' ? (rq?.min_value ?? null) : null,
      max_value: mode === 'OWN_VALUE' && vType !== 'TEXT' ? (rq?.max_value ?? null) : null,
      options,
    }
  })

  return {
    kind: 'INFORMATIVE',
    title,
    description,
    target_scope: targetScope,
    target_entrance: targetEntrance,
    target_apartment_ids: targetApartmentIds,
    eligibility,
    unit,
    closes_at: closesAt,
    questions,
  }
}

export function getOfflineUserPreferences(userId) {
  if (!offlinePreferencesByUser[userId]) {
    offlinePreferencesByUser[userId] = createDefaultMockUserPreferences()
  }
  return offlinePreferencesByUser[userId]
}

export function getOfflineUserNotifications(userId) {
  if (!offlineNotificationsByUser[userId]) {
    offlineNotificationsByUser[userId] = createInitialMockNotificationsForUser(userId, {
      includeOfflineMaintenanceSeed: true,
    })
  }
  return offlineNotificationsByUser[userId]
}

export function getNoticeRecipientUserIds(notice, authorUserId) {
  return getMockNoticeRecipientUserIds(notice, authorUserId)
}

export function dispatchMaintenanceAndNoticeNotifications(notif) {
  if (notif.event_type === 'MAINTENANCE_DUE') {
    const recipientUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105']
    emitOfflineIssueNotificationBatch({
      recipientUserIds,
      event_type: 'MAINTENANCE_DUE',
      subject_type: 'maintenance_task',
      subject_id: notif.subject_id,
      params: notif.params,
      created_at: notif.created_at || new Date().toISOString(),
    })
  } else if (notif.event_type === 'NOTICE_PUBLISHED') {
    const recipientUserIds = getNoticeRecipientUserIds(notif, notif.author_user_id)
    emitOfflineIssueNotificationBatch({
      recipientUserIds,
      event_type: 'NOTICE_PUBLISHED',
      subject_type: 'post',
      subject_id: notif.subject_id,
      params: {},
      created_at: notif.created_at || new Date().toISOString(),
    })
  }
}

export function checkAndEmitOfflineStorageAlert() {
  const currentUsage = computeStorageUsage({
    issuesStore: offlineIssues,
    documentsStore: offlineDocuments,
    extraPendingDeletionBytes: offlineExtraPendingDeletionBytes,
  })
  const triggered = evaluateStorageThresholdNotification(currentUsage, offlineStorageAlertState)
  if (triggered) {
    const boardUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105']
    emitOfflineIssueNotificationBatch({
      recipientUserIds: boardUserIds,
      event_type: 'STORAGE_ALMOST_FULL',
      subject_type: 'storage',
      subject_id: 'storage',
      params: {
        threshold: triggered.threshold,
        used_percent: triggered.used_percent,
      },
      created_at: new Date().toISOString(),
    })
  }
}

export function emitOfflineIssueNotificationBatch(batch) {
  for (const uid of batch.recipientUserIds || []) {
    const prefs = getOfflineUserPreferences(uid)
    const inAppPref = prefs.find(
      (p) => p.event_type === batch.event_type && p.channel === 'in_app',
    )
    if (batch.event_type === 'ISSUE_URGENT' || !inAppPref || inAppPref.enabled) {
      getOfflineUserNotifications(uid).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        event_type: batch.event_type,
        subject_type: batch.subject_type,
        subject_id: batch.subject_id,
        params: { ...batch.params },
        created_at: batch.created_at,
        read_at: null,
      })
    }
  }
}

export function emitOfflinePollOpenedNotifications(poll, openerUser, createdAtIso) {
  for (const demoUser of OFFLINE_DEMO_USERS) {
    if (demoUser.user_id === openerUser.user_id) continue
    const { canAnswer } = computeOfflinePollAnswerability(poll, demoUser)
    if (!canAnswer) continue

    const prefs = getOfflineUserPreferences(demoUser.user_id)
    const inAppPref = prefs.find(
      (p) => p.event_type === 'POLL_OPENED' && p.channel === 'in_app',
    )
    if (!inAppPref || inAppPref.enabled) {
      getOfflineUserNotifications(demoUser.user_id).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        event_type: 'POLL_OPENED',
        subject_type: 'poll',
        subject_id: poll.id,
        params: {
          closes_at: poll.closes_at,
        },
        created_at: createdAtIso,
        read_at: null,
      })
    }
  }
}

export function validateOfflineBallotAnswers(questions, rawAnswers) {
  return validateMockBallotAnswers(questions, rawAnswers)
}



export const UNHANDLED = Symbol('OFFLINE_UNHANDLED')

export const offlineStore = {
  get offlineNotificationsByUser() { return offlineNotificationsByUser },
  set offlineNotificationsByUser(val) { offlineNotificationsByUser = val },
  get offlinePreferencesByUser() { return offlinePreferencesByUser },
  set offlinePreferencesByUser(val) { offlinePreferencesByUser = val },
  get offlineSettings() { return offlineSettings },
  set offlineSettings(val) { offlineSettings = val },
  get offlineIssues() { return offlineIssues },
  set offlineIssues(val) { offlineIssues = val },
  get offlineIssuePhotoIdempotency() { return offlineIssuePhotoIdempotency },
  set offlineIssuePhotoIdempotency(val) { offlineIssuePhotoIdempotency = val },
  get offlineIssuePhotoDailyUploads() { return offlineIssuePhotoDailyUploads },
  set offlineIssuePhotoDailyUploads(val) { offlineIssuePhotoDailyUploads = val },
  get offlineDocuments() { return offlineDocuments },
  set offlineDocuments(val) { offlineDocuments = val },
  get offlineDocumentIdempotency() { return offlineDocumentIdempotency },
  set offlineDocumentIdempotency(val) { offlineDocumentIdempotency = val },
  get offlineMaintenance() { return offlineMaintenance },
  set offlineMaintenance(val) { offlineMaintenance = val },
  get offlineMaintenanceLog() { return offlineMaintenanceLog },
  set offlineMaintenanceLog(val) { offlineMaintenanceLog = val },
  get offlineApartmentsByPeriod() { return offlineApartmentsByPeriod },
  set offlineApartmentsByPeriod(val) { offlineApartmentsByPeriod = val },
  get offlineMasterMetersByPeriod() { return offlineMasterMetersByPeriod },
  set offlineMasterMetersByPeriod(val) { offlineMasterMetersByPeriod = val },
  get offlinePeriods() { return offlinePeriods },
  set offlinePeriods(val) { offlinePeriods = val },
  get offlineExtraPendingDeletionBytes() { return offlineExtraPendingDeletionBytes },
  set offlineExtraPendingDeletionBytes(val) { offlineExtraPendingDeletionBytes = val },
  get offlineStorageAlertState() { return offlineStorageAlertState },
  set offlineStorageAlertState(val) { offlineStorageAlertState = val },
  get offlineChatTurnedOnAt() { return offlineChatTurnedOnAt },
  set offlineChatTurnedOnAt(val) { offlineChatTurnedOnAt = val },
  get offlineChatMessages() { return offlineChatMessages },
  set offlineChatMessages(val) { offlineChatMessages = val },
  get offlineChatNextId() { return offlineChatNextId },
  set offlineChatNextId(val) { offlineChatNextId = val },
  get offlineChatPostTimestampsByUser() { return offlineChatPostTimestampsByUser },
  set offlineChatPostTimestampsByUser(val) { offlineChatPostTimestampsByUser = val },
  get offlineRegistryState() { return offlineRegistryState },
  set offlineRegistryState(val) { offlineRegistryState = val },
  get offlineRegistryDailyCalls() { return offlineRegistryDailyCalls },
  set offlineRegistryDailyCalls(val) { offlineRegistryDailyCalls = val },
  get offlineMagicLinkUsed() { return offlineMagicLinkUsed },
  set offlineMagicLinkUsed(val) { offlineMagicLinkUsed = val },
  get offlineSessions() { return offlineSessions },
  set offlineSessions(val) { offlineSessions = val },
  get offlineSignedInUserId() { return offlineSignedInUserId },
  set offlineSignedInUserId(val) { offlineSignedInUserId = val },
  get offlineHasPassword() { return offlineHasPassword },
  set offlineHasPassword(val) { offlineHasPassword = val },
}
