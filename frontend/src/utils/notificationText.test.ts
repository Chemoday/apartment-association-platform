import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotificationDescriptor, formatNotificationText } from './notificationText.js'
import { i18n, setI18nLocale } from '../locales/index.js'

const translate = (key: string, params?: Record<string, any>) =>
  params ? i18n.global.t(key, params) : i18n.global.t(key)

test('buildNotificationDescriptor maps all 4 known event types and unknown safely', () => {
  const emergencyPub = buildNotificationDescriptor(
    {
      id: 'n1',
      event_type: 'EMERGENCY_PUBLISHED',
      params: { category: 'WATER_SHUTOFF', target_scope: 'ENTRANCE', target_entrance: 2 },
      subject_type: 'post',
      subject_id: 'post-42',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(emergencyPub.key, 'notifications.events.EMERGENCY_PUBLISHED')
  assert.equal(emergencyPub.route, '/forum/post-42')
  assert.equal(emergencyPub.variant, 'emergency')

  const emergencyRes = buildNotificationDescriptor(
    {
      id: 'n2',
      event_type: 'EMERGENCY_RESOLVED',
      params: { category: 'MAINTENANCE', target_scope: 'ALL_BUILDING' },
      subject_type: 'post',
      subject_id: 'post-42',
      created_at: '2026-04-19T10:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(emergencyRes.key, 'notifications.events.EMERGENCY_RESOLVED')
  assert.equal(emergencyRes.route, '/forum/post-42')
  assert.equal(emergencyRes.variant, 'resolved')

  const deadline = buildNotificationDescriptor(
    {
      id: 'n3',
      event_type: 'READING_DEADLINE',
      params: { period_code: '2026-03', due_date: '2026-03-25' },
      subject_type: 'period',
      subject_id: 'period-1',
      created_at: '2026-03-23T08:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(deadline.key, 'notifications.events.READING_DEADLINE')
  assert.equal(deadline.route, '/readings?period=2026-03')
  assert.equal(deadline.variant, 'deadline')

  const review = buildNotificationDescriptor(
    {
      id: 'n4',
      event_type: 'PERIOD_REVIEW',
      params: { period_code: '2026-03' },
      subject_type: 'period',
      subject_id: 'period-1',
      created_at: '2026-03-26T08:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(review.key, 'notifications.events.PERIOD_REVIEW')
  assert.equal(review.route, '/readings?period=2026-03')
  assert.equal(review.variant, 'review')

  const aptFromBoard = buildNotificationDescriptor(
    {
      id: 'n6',
      event_type: 'APARTMENT_MESSAGE',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: true },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T12:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(aptFromBoard.key, 'notifications.events.APARTMENT_MESSAGE_FROM_BOARD')
  assert.equal(aptFromBoard.route, '/messages/post-apt-14-thread-1')
  assert.equal(aptFromBoard.icon, 'mail')

  const aptPeer = buildNotificationDescriptor(
    {
      id: 'n7',
      event_type: 'APARTMENT_MESSAGE',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: false },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T12:05:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(aptPeer.key, 'notifications.events.APARTMENT_MESSAGE_PEER')
  assert.equal(aptPeer.route, '/messages/post-apt-14-thread-1')

  const aptToBoard = buildNotificationDescriptor(
    {
      id: 'n8',
      event_type: 'APARTMENT_MESSAGE_TO_BOARD',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: false },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T12:10:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(aptToBoard.key, 'notifications.events.APARTMENT_MESSAGE_TO_BOARD')
  assert.equal(aptToBoard.route, '/messages/post-apt-14-thread-1')
  assert.equal(aptToBoard.values.apartment_number, '14')

  const pollOpened = buildNotificationDescriptor(
    {
      id: 'n9',
      event_type: 'POLL_OPENED',
      params: { closes_at: '2026-05-10T20:59:59Z' },
      subject_type: 'poll',
      subject_id: 'poll-123',
      created_at: '2026-05-01T09:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(pollOpened.key, 'notifications.events.POLL_OPENED')
  assert.equal(pollOpened.route, '/polls/poll-123')
  assert.equal(pollOpened.icon, 'how_to_vote')
  assert.equal(pollOpened.variant, 'deadline')
  assert.ok(pollOpened.values.date.includes('2026'))

  const unknown = buildNotificationDescriptor(
    {
      id: 'n5',
      event_type: 'FUTURE_EVENT_TYPE' as any,
      params: {},
      subject_type: 'unknown' as any,
      subject_id: '',
      created_at: '2026-03-26T08:00:00Z',
      read_at: null,
    },
    'en',
  )
  assert.equal(unknown.key, 'notifications.events.UNKNOWN')
  assert.equal(unknown.route, null)
})

test('formatNotificationText formats human-readable text in English and Estonian', () => {
  setI18nLocale('en')
  const textEn = formatNotificationText(
    {
      id: 'n1',
      event_type: 'EMERGENCY_PUBLISHED',
      params: { category: 'WATER_SHUTOFF', target_scope: 'ENTRANCE', target_entrance: 1 },
      subject_type: 'post',
      subject_id: 'post-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'en',
  )
  assert.equal(textEn, 'Emergency alert (water shutoff, entrance 1)')

  const msgBoardEn = formatNotificationText(
    {
      id: 'n2',
      event_type: 'APARTMENT_MESSAGE',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: true },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'en',
  )
  assert.equal(msgBoardEn, 'New message from the board')

  const msgPeerEn = formatNotificationText(
    {
      id: 'n3',
      event_type: 'APARTMENT_MESSAGE',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: false },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'en',
  )
  assert.equal(msgPeerEn, "New message in your apartment's conversation with the board")

  const msgToBoardEn = formatNotificationText(
    {
      id: 'n4',
      event_type: 'APARTMENT_MESSAGE_TO_BOARD',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: false },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'en',
  )
  assert.equal(msgToBoardEn, 'New message from apartment 14')

  setI18nLocale('et')
  const textEt = formatNotificationText(
    {
      id: 'n1',
      event_type: 'EMERGENCY_PUBLISHED',
      params: { category: 'WATER_SHUTOFF', target_scope: 'ALL_BUILDING' },
      subject_type: 'post',
      subject_id: 'post-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'et',
  )
  assert.equal(textEt, 'Avariiteade (veekatkestus, kogu hoone)')

  const msgToBoardEt = formatNotificationText(
    {
      id: 'n4',
      event_type: 'APARTMENT_MESSAGE_TO_BOARD',
      params: { apartment_id: 'apt-14', apartment_number: '14', from_board: false },
      subject_type: 'post',
      subject_id: 'post-apt-14-thread-1',
      created_at: '2026-04-19T08:00:00Z',
      read_at: null,
    },
    translate,
    'et',
  )
  assert.equal(msgToBoardEt, 'Uus sõnum korterilt 14')

  // #010 POLL_OPENED localized text in en, et, and ru — never exposes poll title or questions
  setI18nLocale('en')
  const pollTextEn = formatNotificationText(
    {
      id: 'n10',
      event_type: 'POLL_OPENED',
      params: {
        closes_at: '2026-05-10T20:59:59Z',
        title: 'Secret Poll Title That Must Never Render',
      },
      subject_type: 'poll',
      subject_id: 'poll-123',
      created_at: '2026-05-01T09:00:00Z',
      read_at: null,
    },
    translate,
    'en',
  )
  assert.ok(pollTextEn.startsWith('The board started a poll. Please answer by '))
  assert.ok(pollTextEn.includes('2026'))
  assert.equal(pollTextEn.includes('Secret Poll Title'), false)

  setI18nLocale('et')
  const pollTextEt = formatNotificationText(
    {
      id: 'n10',
      event_type: 'POLL_OPENED',
      params: { closes_at: '2026-05-10T20:59:59Z' },
      subject_type: 'poll',
      subject_id: 'poll-123',
      created_at: '2026-05-01T09:00:00Z',
      read_at: null,
    },
    translate,
    'et',
  )
  assert.ok(pollTextEt.startsWith('Juhatus algatas küsitluse. Palun vastake hiljemalt '))
  assert.ok(pollTextEt.includes('2026'))

  setI18nLocale('ru')
  const pollTextRu = formatNotificationText(
    {
      id: 'n10',
      event_type: 'POLL_OPENED',
      params: { closes_at: '2026-05-10T20:59:59Z' },
      subject_type: 'poll',
      subject_id: 'poll-123',
      created_at: '2026-05-01T09:00:00Z',
      read_at: null,
    },
    translate,
    'ru',
  )
  assert.ok(pollTextRu.startsWith('Правление открыло опрос. Пожалуйста, ответьте до '))
  assert.ok(pollTextRu.includes('2026'))

  setI18nLocale('en')
})

