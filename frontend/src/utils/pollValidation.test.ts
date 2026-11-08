import test from 'node:test'
import assert from 'node:assert/strict'
import type { QuestionView } from '../api/schema.js'
import {
  compareCanonicalNumbers,
  computeNumberStats,
  formatPollDateTime,
  formatPollValue,
  isoToLocalDateInput,
  isValidCanonicalDate,
  isValidCanonicalNumber,
  localDateToEndOfDayIso,
  normalizeCanonicalNumber,
  validateBallotDraft,
  validatePollDraft,
} from './pollValidation.js'

test('canonical number validation and BigInt comparison work without float precision errors', () => {
  assert.equal(isValidCanonicalNumber('250'), true)
  assert.equal(isValidCanonicalNumber('-12.345'), true)
  assert.equal(isValidCanonicalNumber('0.000001'), true)
  assert.equal(isValidCanonicalNumber('0.0000001'), false) // > 6 decimals
  assert.equal(isValidCanonicalNumber('12,5'), false)
  assert.equal(isValidCanonicalNumber('abc'), false)

  assert.equal(normalizeCanonicalNumber('0012.500'), '12.5')
  assert.equal(normalizeCanonicalNumber('-0.000'), '0')

  assert.equal(compareCanonicalNumbers('10.00', '10'), 0)
  assert.equal(compareCanonicalNumbers('9.999999', '10'), -1)
  assert.equal(compareCanonicalNumbers('1500.01', '1500'), 1)
  assert.equal(compareCanonicalNumbers('-5', '-2'), -1)
})

test('canonical date validation and locale value formatting', () => {
  assert.equal(isValidCanonicalDate('2026-05-09'), true)
  assert.equal(isValidCanonicalDate('2026-02-30'), false)
  assert.equal(isValidCanonicalDate('09.05.2026'), false)

  const formattedDate = formatPollValue('2026-05-09', 'DATE', 'en')
  assert.ok(formattedDate.includes('2026'))

  const formattedNum = formatPollValue('1250.5', 'NUMBER', 'en')
  assert.ok(formattedNum.includes('1,250.5'))

  const dt = formatPollDateTime('2026-05-10T20:59:59Z', 'en')
  assert.ok(dt.includes('2026'))
})

test('validateBallotDraft enforces required, choice count, value format, and range constraints', () => {
  const questions: QuestionView[] = [
    {
      id: 'q-choice',
      position: 1,
      prompt: 'Which Saturday suits you?',
      text: 'Which Saturday suits you?',
      answer_mode: 'MULTIPLE_CHOICE',
      value_type: 'DATE',
      required: true,
      min_choices: 1,
      max_choices: 2,
      options: [
        { id: 'opt-1', position: 1, value: '2026-05-09' },
        { id: 'opt-2', position: 2, value: '2026-05-16' },
        { id: 'opt-3', position: 3, value: '2026-05-23' },
      ],
    },
    {
      id: 'q-num',
      position: 2,
      prompt: 'Max contribution (EUR)',
      text: 'Max contribution (EUR)',
      answer_mode: 'OWN_VALUE',
      value_type: 'NUMBER',
      required: false,
      min_value: '0',
      max_value: '1500',
      options: [],
    },
  ]

  // Missing required question
  const resMissing = validateBallotDraft(questions, {
    'q-choice': { option_ids: [], value: '' },
  })
  assert.equal(resMissing.valid, false)
  assert.equal(resMissing.questionId, 'q-choice')
  assert.equal(resMissing.reason, 'REQUIRED')

  // Too many choices
  const resTooMany = validateBallotDraft(questions, {
    'q-choice': { option_ids: ['opt-1', 'opt-2', 'opt-3'], value: '' },
  })
  assert.equal(resTooMany.valid, false)
  assert.equal(resTooMany.questionId, 'q-choice')
  assert.equal(resTooMany.reason, 'CHOICES')

  // Out of range number
  const resOutOfRange = validateBallotDraft(questions, {
    'q-choice': { option_ids: ['opt-1'], value: '' },
    'q-num': { option_ids: [], value: '2000' },
  })
  assert.equal(resOutOfRange.valid, false)
  assert.equal(resOutOfRange.questionId, 'q-num')
  assert.equal(resOutOfRange.reason, 'OUT_OF_RANGE')

  // Valid ballot
  const resValid = validateBallotDraft(questions, {
    'q-choice': { option_ids: ['opt-1', 'opt-2'], value: '' },
    'q-num': { option_ids: [], value: '350.50' },
  })
  assert.equal(resValid.valid, true)
})

test('localDateToEndOfDayIso and isoToLocalDateInput round-trip in Europe/Tallinn', () => {
  const summerIso = localDateToEndOfDayIso('2026-06-15')
  assert.equal(summerIso, '2026-06-15T20:59:59Z') // EEST is UTC+3
  assert.equal(isoToLocalDateInput(summerIso), '2026-06-15')

  const winterIso = localDateToEndOfDayIso('2026-11-20')
  assert.equal(winterIso, '2026-11-20T21:59:59Z') // EET is UTC+2
  assert.equal(isoToLocalDateInput(winterIso), '2026-11-20')
})

test('validatePollDraft validates board poll draft questions, options, and bounds', () => {
  const badDup = validatePollDraft({
    title: 'Test Poll',
    target_scope: 'ALL_BUILDING',
    eligibility: 'RESIDENTS',
    unit: 'APARTMENT',
    closes_date: '2026-12-15',
    questions: [
      {
        text: 'Pick a number',
        answer_mode: 'SINGLE_CHOICE',
        value_type: 'NUMBER',
        required: true,
        options: ['10.0', '10'], // duplicate after canonical normalization
      },
    ],
  })
  assert.equal(badDup.valid, false)
  assert.equal(badDup.questionErrors[0]?.options, 'OPTIONS_DUPLICATE')

  const badBounds = validatePollDraft({
    title: 'Test Poll',
    target_scope: 'ALL_BUILDING',
    eligibility: 'OWNERS',
    unit: 'APARTMENT',
    closes_date: '2026-12-15',
    questions: [
      {
        text: 'How much?',
        answer_mode: 'OWN_VALUE',
        value_type: 'NUMBER',
        required: true,
        min_value: '500',
        max_value: '100',
      },
    ],
  })
  assert.equal(badBounds.valid, false)
  assert.equal(badBounds.questionErrors[0]?.bounds, 'MIN_GREATER_THAN_MAX')

  const validDraft = validatePollDraft({
    title: 'Courtyard bench replacement',
    description: 'Choose style and budget.',
    target_scope: 'ENTRANCE',
    target_entrance: 2,
    eligibility: 'RESIDENTS',
    unit: 'APARTMENT',
    closes_date: '2026-12-15',
    questions: [
      {
        text: 'Which style?',
        answer_mode: 'MULTIPLE_CHOICE',
        value_type: 'TEXT',
        required: true,
        min_choices: 1,
        max_choices: 2,
        options: ['Wood', 'Recycled composite', 'Steel'],
      },
    ],
  })
  assert.equal(validDraft.valid, true)
  assert.ok(validDraft.payload)
  assert.equal(validDraft.payload.target_entrance, 2)
  assert.equal(validDraft.payload.questions.length, 1)
  assert.deepEqual(validDraft.payload.questions[0].options, [
    'Wood',
    'Recycled composite',
    'Steel',
  ])
})

test('computeNumberStats computes min, max, and half-even average up to 6 decimals without floats', () => {
  assert.equal(computeNumberStats([]), null)
  assert.deepEqual(computeNumberStats(['1', '2', '4']), {
    min: '1',
    max: '4',
    average: '2.333333',
  })
  assert.deepEqual(computeNumberStats(['100.50', '200.25']), {
    min: '100.5',
    max: '200.25',
    average: '150.375',
  })
  // Half-even tie-breaking at the 6th decimal place:
  // 0.000001 + 0.000002 = 0.000003 / 2 = 0.0000015 -> rounds to even 6th digit (0.000002)
  assert.deepEqual(computeNumberStats(['0.000001', '0.000002']), {
    min: '0.000001',
    max: '0.000002',
    average: '0.000002',
  })
  // 0.000002 + 0.000003 = 0.000005 / 2 = 0.0000025 -> rounds to even 6th digit (0.000002)
  assert.deepEqual(computeNumberStats(['0.000002', '0.000003']), {
    min: '0.000002',
    max: '0.000003',
    average: '0.000002',
  })
  // Negative values
  assert.deepEqual(computeNumberStats(['-10.5', '-2.5', '4']), {
    min: '-10.5',
    max: '4',
    average: '-3',
  })
})

test('every validation error code emitted by validatePollDraft and validateBallotDraft has a localized string in en, et, and ru', async () => {
  const { i18n, setI18nLocale } = await import('../locales/index.js')

  const editorValidationCodes = [
    'TITLE_REQUIRED',
    'TITLE_LENGTH',
    'DESCRIPTION_TOO_LONG',
    'DESCRIPTION_LENGTH',
    'INVALID_TARGET',
    'INVALID_TARGET_ENTRANCE',
    'INVALID_TARGET_APARTMENTS',
    'INVALID_DEADLINE',
    'DEADLINE_REQUIRED',
    'QUESTIONS_COUNT',
    'QUESTION_TEXT_REQUIRED',
    'QUESTION_TEXT_LENGTH',
    'INVALID_ANSWER_MODE',
    'INVALID_VALUE_TYPE',
    'OPTIONS_COUNT',
    'OPTION_TEXT_INVALID',
    'OPTION_EMPTY_OR_TOO_LONG',
    'OPTION_NUMBER_INVALID',
    'OPTION_INVALID_NUMBER',
    'OPTION_DATE_INVALID',
    'OPTION_INVALID_DATE',
    'OPTIONS_DUPLICATE',
    'CHOICES_RANGE_INVALID',
    'INVALID_CHOICES_BOUNDS',
    'MIN_VALUE_INVALID',
    'MAX_VALUE_INVALID',
    'INVALID_NUMBER_BOUNDS',
    'INVALID_DATE_BOUNDS',
    'BOUNDS_ORDER_INVALID',
    'MIN_GREATER_THAN_MAX',
  ]

  const ballotValidationCodes = [
    'REQUIRED',
    'UNKNOWN_QUESTION',
    'UNKNOWN_OPTION',
    'CHOICES',
    'VALUE',
    'OUT_OF_RANGE',
    'DUPLICATE',
  ]

  for (const locale of ['en', 'et', 'ru'] as const) {
    setI18nLocale(locale)
    for (const code of editorValidationCodes) {
      const key = `polls.editor.validation.${code}`
      const msg = i18n.global.t(key)
      assert.notEqual(msg, key, `Missing locale key ${key} in ${locale}`)
      assert.ok(msg.length > 5)
    }
    for (const code of ballotValidationCodes) {
      const key = `polls.validation.${code}`
      const msg = i18n.global.t(key, { min: 1, max: 3 })
      assert.notEqual(msg, key, `Missing locale key ${key} in ${locale}`)
      assert.ok(msg.length > 5)
    }
    // CheckQuestionEditor interpolation keys (#n)
    const qNum = i18n.global.t('polls.editor.questionNumber', { n: 3, number: 3 })
    assert.ok(qNum.includes('3'), `questionNumber did not interpolate in ${locale}: ${qNum}`)
    assert.equal(qNum.includes('{n}'), false)

    const optPh = i18n.global.t('polls.editor.optionPlaceholder', { n: 2, number: 2 })
    assert.ok(optPh.includes('2'), `optionPlaceholder did not interpolate in ${locale}: ${optPh}`)
    assert.equal(optPh.includes('{n}'), false)

    // Check #010 poll 404 title
    const notFoundTitle = i18n.global.t('polls.notFoundTitle')
    assert.notEqual(notFoundTitle, 'polls.notFoundTitle')
  }
  setI18nLocale('en')
})


