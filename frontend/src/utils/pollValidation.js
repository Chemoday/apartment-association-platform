const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const CANONICAL_DATE_RE = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/

/**
 * Validates whether a string is a canonical decimal number (no exponent, at most 24 digits total, at most 6 decimals).
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidCanonicalNumber(raw) {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (!trimmed || /^-0(?:\.0+)?$/.test(trimmed)) return false
  if (!CANONICAL_DECIMAL_RE.test(trimmed)) return false
  const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed
  const [intPart, fracPart = ''] = unsigned.split('.')
  if (intPart.length + fracPart.length > 24 || fracPart.length > 6) return false
  return true
}

/**
 * Normalizes a user-typed decimal string into canonical form (dots, stripped leading/trailing zeros).
 * Returns null if invalid. Never uses floating-point arithmetic.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeCanonicalNumber(raw) {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().replace(',', '.')
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [rawInt, fracPart = ''] = unsigned.split('.')
  const intPart = rawInt.replace(/^0+(?=\d)/, '') || '0'
  if (intPart.length + fracPart.length > 24 || fracPart.length > 6) return null
  const cleanFrac = fracPart.replace(/0+$/, '')
  if (intPart === '0' && cleanFrac === '') return '0'
  return `${negative ? '-' : ''}${intPart}${cleanFrac ? `.${cleanFrac}` : ''}`
}

/**
 * Exact comparison of two canonical decimal strings without floating-point arithmetic.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 * @param {string} aRaw
 * @param {string} bRaw
 * @returns {number}
 */
export function compareCanonicalNumbers(aRaw, bRaw) {
  const a = normalizeCanonicalNumber(aRaw)
  const b = normalizeCanonicalNumber(bRaw)
  if (a === null || b === null) return 0
  if (a === b) return 0

  const aNeg = a.startsWith('-')
  const bNeg = b.startsWith('-')
  if (aNeg && !bNeg) return -1
  if (!aNeg && bNeg) return 1

  const aUnsigned = aNeg ? a.slice(1) : a
  const bUnsigned = bNeg ? b.slice(1) : b
  const [aInt, aFrac = ''] = aUnsigned.split('.')
  const [bInt, bFrac = ''] = bUnsigned.split('.')

  const maxFrac = Math.max(aFrac.length, bFrac.length)
  const aScaled = BigInt(aInt + aFrac.padEnd(maxFrac, '0'))
  const bScaled = BigInt(bInt + bFrac.padEnd(maxFrac, '0'))

  if (aScaled === bScaled) return 0
  const cmp = aScaled < bScaled ? -1 : 1
  return aNeg ? -cmp : cmp
}

/**
 * Validates whether a string is a valid calendar date in YYYY-MM-DD format.
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidCanonicalDate(raw) {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  const match = trimmed.match(CANONICAL_DATE_RE)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

/**
 * Formats a question option or own value (TEXT, NUMBER, DATE) for display in the reader's locale.
 * Never performs floating-point arithmetic on NUMBER values.
 * @param {string | null | undefined} value
 * @param {'TEXT' | 'NUMBER' | 'DATE'} valueType
 * @param {string} [locale]
 * @returns {string}
 */
export function formatPollValue(value, valueType, locale = 'en') {
  if (value === null || value === undefined || value === '') return ''
  const str = String(value)

  if (valueType === 'DATE') {
    const match = str.match(CANONICAL_DATE_RE)
    if (!match) return str
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
    const tag = locale === 'et' ? 'et-EE' : locale === 'ru' ? 'ru-RU' : 'en-GB'
    return new Intl.DateTimeFormat(tag, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      timeZone: 'UTC',
    }).format(utcDate)
  }

  if (valueType === 'NUMBER') {
    const canonical = normalizeCanonicalNumber(str) || str
    const negative = canonical.startsWith('-')
    const unsigned = negative ? canonical.slice(1) : canonical
    const [intPart, fracPart] = unsigned.split('.')
    const tag = locale === 'et' ? 'et-EE' : locale === 'ru' ? 'ru-RU' : 'en-GB'
    const parts = new Intl.NumberFormat(tag).formatToParts(1000.5)
    const groupSep = parts.find((p) => p.type === 'group')?.value ?? ' '
    const decSep = parts.find((p) => p.type === 'decimal')?.value ?? '.'
    const groupedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep)
    return `${negative ? '−' : ''}${groupedInt}${fracPart !== undefined ? `${decSep}${fracPart}` : ''}`
  }

  return str
}

/**
 * Formats a UTC ISO timestamp in Europe/Tallinn local time.
 * @param {string | null | undefined} isoString
 * @param {string} [locale]
 * @param {{ includeTime?: boolean }} [options]
 * @returns {string}
 */
export function formatPollDateTime(isoString, locale = 'en', { includeTime = true } = {}) {
  if (!isoString) return '—'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return String(isoString)
  const tag = locale === 'et' ? 'et-EE' : locale === 'ru' ? 'ru-RU' : 'en-GB'
  const formatOpts = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'Europe/Tallinn',
  }
  if (includeTime) {
    formatOpts.hour = '2-digit'
    formatOpts.minute = '2-digit'
  }
  return new Intl.DateTimeFormat(tag, formatOpts).format(date)
}

/**
 * Validates draft answers against a poll's questions using the same rules and reason codes as the backend.
 * Reason codes: 'REQUIRED' | 'UNKNOWN_OPTION' | 'CHOICES' | 'VALUE' | 'OUT_OF_RANGE' | 'DUPLICATE'
 *
 * @param {import('../api/schema').QuestionView[]} questions
 * @param {Record<string, { option_ids?: string[], value?: string }>} draftByQuestionId
 * @returns {{ valid: boolean, questionId?: string, reason?: string, errorsByQuestionId: Record<string, string>, answers: import('../api/schema').AnswerInput[] }}
 */
export function validateBallotDraft(questions, draftByQuestionId) {
  /** @type {Record<string, string>} */
  const errorsByQuestionId = {}
  /** @type {import('../api/schema').AnswerInput[]} */
  const answers = []

  const sortedQuestions = [...(questions || [])].sort((a, b) => a.position - b.position)

  for (const q of sortedQuestions) {
    const draft = draftByQuestionId?.[q.id] || {}
    const isChoice = q.answer_mode === 'SINGLE_CHOICE' || q.answer_mode === 'MULTIPLE_CHOICE'

    if (isChoice) {
      const selectedIds = Array.isArray(draft.option_ids)
        ? draft.option_ids.filter((id) => typeof id === 'string' && id.trim() !== '')
        : []

      if (selectedIds.length === 0) {
        if (q.required) {
          errorsByQuestionId[q.id] = 'REQUIRED'
        }
        continue
      }

      const uniqueIds = new Set(selectedIds)
      if (uniqueIds.size !== selectedIds.length) {
        errorsByQuestionId[q.id] = 'DUPLICATE'
        continue
      }

      const validOptionIds = new Set((q.options || []).map((o) => o.id))
      if (selectedIds.some((id) => !validOptionIds.has(id))) {
        errorsByQuestionId[q.id] = 'UNKNOWN_OPTION'
        continue
      }

      if (q.answer_mode === 'SINGLE_CHOICE') {
        if (selectedIds.length !== 1) {
          errorsByQuestionId[q.id] = 'CHOICES'
          continue
        }
      } else {
        const minChoices = q.min_choices ?? 1
        const maxChoices = q.max_choices ?? (q.options?.length || 20)
        if (selectedIds.length < minChoices || selectedIds.length > maxChoices) {
          errorsByQuestionId[q.id] = 'CHOICES'
          continue
        }
      }

      // Preserve option order
      const orderedOptionIds = (q.options || [])
        .filter((o) => uniqueIds.has(o.id))
        .map((o) => o.id)

      answers.push({
        question_id: q.id,
        option_ids: orderedOptionIds,
      })
    } else {
      // OWN_VALUE
      const rawVal = typeof draft.value === 'string' ? draft.value.trim() : ''
      if (!rawVal) {
        if (q.required) {
          errorsByQuestionId[q.id] = 'REQUIRED'
        }
        continue
      }

      if (q.value_type === 'TEXT') {
        if (rawVal.length > 2000) {
          errorsByQuestionId[q.id] = 'OUT_OF_RANGE'
          continue
        }
        answers.push({
          question_id: q.id,
          value: rawVal,
        })
      } else if (q.value_type === 'NUMBER') {
        const canonical = normalizeCanonicalNumber(rawVal)
        if (canonical === null) {
          errorsByQuestionId[q.id] = 'VALUE'
          continue
        }
        if (q.min_value !== null && q.min_value !== undefined) {
          if (compareCanonicalNumbers(canonical, q.min_value) < 0) {
            errorsByQuestionId[q.id] = 'OUT_OF_RANGE'
            continue
          }
        }
        if (q.max_value !== null && q.max_value !== undefined) {
          if (compareCanonicalNumbers(canonical, q.max_value) > 0) {
            errorsByQuestionId[q.id] = 'OUT_OF_RANGE'
            continue
          }
        }
        answers.push({
          question_id: q.id,
          value: canonical,
        })
      } else if (q.value_type === 'DATE') {
        if (!isValidCanonicalDate(rawVal)) {
          errorsByQuestionId[q.id] = 'VALUE'
          continue
        }
        if (q.min_value && rawVal < q.min_value) {
          errorsByQuestionId[q.id] = 'OUT_OF_RANGE'
          continue
        }
        if (q.max_value && rawVal > q.max_value) {
          errorsByQuestionId[q.id] = 'OUT_OF_RANGE'
          continue
        }
        answers.push({
          question_id: q.id,
          value: rawVal,
        })
      }
    }
  }

  const firstErrorEntry = Object.entries(errorsByQuestionId)[0]
  return {
    valid: !firstErrorEntry,
    questionId: firstErrorEntry ? firstErrorEntry[0] : undefined,
    reason: firstErrorEntry ? firstErrorEntry[1] : undefined,
    errorsByQuestionId,
    answers,
  }
}

/**
 * Converts a YYYY-MM-DD date string into the end of that day (23:59:59) in Europe/Tallinn,
 * returned as an ISO-8601 UTC timestamp (e.g. "2026-11-12T21:59:59Z").
 * @param {string} dateStr
 * @returns {string | null}
 */
export function localDateToEndOfDayIso(dateStr) {
  if (!isValidCanonicalDate(dateStr)) return null
  const [y, m, d] = dateStr.trim().split('-').map(Number)
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Tallinn',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(noonUtc)
  const tallinnNoonHour = Number(parts.find((p) => p.type === 'hour')?.value || '14')
  const offsetHours = tallinnNoonHour - 12
  const endOfDayUtcMs = Date.UTC(y, m - 1, d, 23 - offsetHours, 59, 59)
  return new Date(endOfDayUtcMs).toISOString().replace('.000Z', 'Z')
}

/**
 * Converts a UTC ISO timestamp to YYYY-MM-DD in Europe/Tallinn for <input type="date">.
 * @param {string | null | undefined} isoString
 * @returns {string}
 */
export function isoToLocalDateInput(isoString) {
  if (!isoString) return ''
  const dt = new Date(isoString)
  if (Number.isNaN(dt.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Tallinn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt)
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value
  if (!year || !month || !day) return ''
  return `${year}-${month}-${day}`
}

/**
 * Validates a board poll draft and builds a clean PollDraftRequest payload.
 * @param {{
 *   title?: string,
 *   description?: string,
 *   target_scope?: 'ALL_BUILDING' | 'ENTRANCE' | 'APARTMENT_LIST',
 *   target_entrance?: number | string | null,
 *   target_apartment_ids?: string[] | null,
 *   eligibility?: 'RESIDENTS' | 'OWNERS',
 *   unit?: 'APARTMENT' | 'PERSON',
 *   closes_date?: string,
 *   closes_at?: string,
 *   questions?: Array<{
 *     text?: string,
 *     answer_mode?: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'OWN_VALUE',
 *     value_type?: 'TEXT' | 'NUMBER' | 'DATE',
 *     required?: boolean,
 *     min_choices?: number | string | null,
 *     max_choices?: number | string | null,
 *     min_value?: string | null,
 *     max_value?: string | null,
 *     options?: string[]
 *   }>
 * }} draft
 * @returns {{
 *   valid: boolean,
 *   fieldErrors: Record<string, string>,
 *   questionErrors: Record<number, Record<string, string>>,
 *   payload: import('../api/schema').PollDraftRequest | null
 * }}
 */
export function validatePollDraft(draft) {
  /** @type {Record<string, string>} */
  const fieldErrors = {}
  /** @type {Record<number, Record<string, string>>} */
  const questionErrors = {}

  const title = typeof draft?.title === 'string' ? draft.title.trim() : ''
  if (title.length < 1 || title.length > 255) {
    fieldErrors.title = 'TITLE_LENGTH'
  }

  const description = typeof draft?.description === 'string' ? draft.description.trim() : ''
  if (description.length > 5000) {
    fieldErrors.description = 'DESCRIPTION_LENGTH'
  }

  const targetScope = draft?.target_scope || 'ALL_BUILDING'
  let targetEntrance = null
  let targetApartmentIds = null

  if (targetScope === 'ENTRANCE') {
    const parsedEnt = Number(draft?.target_entrance)
    if (!Number.isInteger(parsedEnt) || parsedEnt < 1) {
      fieldErrors.target = 'INVALID_TARGET_ENTRANCE'
    } else {
      targetEntrance = parsedEnt
    }
  } else if (targetScope === 'APARTMENT_LIST') {
    const ids = Array.isArray(draft?.target_apartment_ids)
      ? Array.from(new Set(draft.target_apartment_ids.filter(Boolean)))
      : []
    if (ids.length === 0) {
      fieldErrors.target = 'INVALID_TARGET_APARTMENTS'
    } else {
      targetApartmentIds = ids
    }
  }

  const closesAtIso = draft?.closes_at
    ? draft.closes_at
    : draft?.closes_date
      ? localDateToEndOfDayIso(draft.closes_date)
      : null

  if (!closesAtIso) {
    fieldErrors.closes_at = 'DEADLINE_REQUIRED'
  }

  const rawQuestions = Array.isArray(draft?.questions) ? draft.questions : []
  if (rawQuestions.length < 1 || rawQuestions.length > 20) {
    fieldErrors.questions = 'QUESTIONS_COUNT'
  }

  /** @type {import('../api/schema').QuestionDraft[]} */
  const builtQuestions = []

  rawQuestions.forEach((q, idx) => {
    /** @type {Record<string, string>} */
    const qErr = {}
    const qText = typeof q?.text === 'string' ? q.text.trim() : ''
    if (qText.length < 1 || qText.length > 500) {
      qErr.text = 'QUESTION_TEXT_LENGTH'
    }

    const answerMode = q?.answer_mode || 'SINGLE_CHOICE'
    const valueType = q?.value_type || 'TEXT'
    const required = q?.required !== false

    /** @type {import('../api/schema').QuestionDraft} */
    const qPayload = {
      text: qText,
      answer_mode: answerMode,
      value_type: valueType,
      required,
    }

    if (answerMode === 'SINGLE_CHOICE' || answerMode === 'MULTIPLE_CHOICE') {
      const rawOpts = Array.isArray(q?.options) ? q.options : []
      const trimmedOpts = rawOpts.map((o) => (typeof o === 'string' ? o.trim() : ''))

      if (trimmedOpts.length < 2 || trimmedOpts.length > 20) {
        qErr.options = 'OPTIONS_COUNT'
      } else if (trimmedOpts.some((o) => o.length < 1 || o.length > 200)) {
        qErr.options = 'OPTION_EMPTY_OR_TOO_LONG'
      } else {
        const canonicalOpts = []
        let formatBad = false
        for (const opt of trimmedOpts) {
          if (valueType === 'NUMBER') {
            const norm = normalizeCanonicalNumber(opt)
            if (!norm) {
              formatBad = true
              break
            }
            canonicalOpts.push(norm)
          } else if (valueType === 'DATE') {
            if (!isValidCanonicalDate(opt)) {
              formatBad = true
              break
            }
            canonicalOpts.push(opt)
          } else {
            canonicalOpts.push(opt)
          }
        }
        if (formatBad) {
          qErr.options =
            valueType === 'NUMBER' ? 'OPTION_INVALID_NUMBER' : 'OPTION_INVALID_DATE'
        } else if (new Set(canonicalOpts).size !== canonicalOpts.length) {
          qErr.options = 'OPTIONS_DUPLICATE'
        } else {
          qPayload.options = canonicalOpts
        }
      }

      if (answerMode === 'MULTIPLE_CHOICE') {
        const optCount = trimmedOpts.length || 2
        const minC =
          q?.min_choices !== null && q?.min_choices !== undefined && q?.min_choices !== ''
            ? Number(q.min_choices)
            : 1
        const maxC =
          q?.max_choices !== null && q?.max_choices !== undefined && q?.max_choices !== ''
            ? Number(q.max_choices)
            : optCount
        if (
          !Number.isInteger(minC) ||
          !Number.isInteger(maxC) ||
          minC < 1 ||
          maxC < minC ||
          maxC > optCount
        ) {
          qErr.choices = 'INVALID_CHOICES_BOUNDS'
        } else {
          qPayload.min_choices = minC
          qPayload.max_choices = maxC
        }
      }
    } else if (answerMode === 'OWN_VALUE') {
      const rawMin = typeof q?.min_value === 'string' ? q.min_value.trim() : ''
      const rawMax = typeof q?.max_value === 'string' ? q.max_value.trim() : ''

      if (valueType === 'NUMBER') {
        let normMin = null
        let normMax = null
        if (rawMin !== '') {
          normMin = normalizeCanonicalNumber(rawMin)
          if (!normMin) qErr.bounds = 'INVALID_NUMBER_BOUNDS'
        }
        if (rawMax !== '') {
          normMax = normalizeCanonicalNumber(rawMax)
          if (!normMax) qErr.bounds = 'INVALID_NUMBER_BOUNDS'
        }
        if (!qErr.bounds && normMin !== null && normMax !== null) {
          if (compareCanonicalNumbers(normMin, normMax) > 0) {
            qErr.bounds = 'MIN_GREATER_THAN_MAX'
          }
        }
        if (normMin !== null) qPayload.min_value = normMin
        if (normMax !== null) qPayload.max_value = normMax
      } else if (valueType === 'DATE') {
        if (rawMin !== '' && !isValidCanonicalDate(rawMin)) {
          qErr.bounds = 'INVALID_DATE_BOUNDS'
        }
        if (rawMax !== '' && !isValidCanonicalDate(rawMax)) {
          qErr.bounds = 'INVALID_DATE_BOUNDS'
        }
        if (!qErr.bounds && rawMin !== '' && rawMax !== '' && rawMin > rawMax) {
          qErr.bounds = 'MIN_GREATER_THAN_MAX'
        }
        if (rawMin !== '') qPayload.min_value = rawMin
        if (rawMax !== '') qPayload.max_value = rawMax
      }
    }

    if (Object.keys(qErr).length > 0) {
      questionErrors[idx] = qErr
    }
    builtQuestions.push(qPayload)
  })

  const valid =
    Object.keys(fieldErrors).length === 0 && Object.keys(questionErrors).length === 0

  if (!valid || !closesAtIso) {
    return {
      valid: false,
      fieldErrors,
      questionErrors,
      payload: null,
    }
  }

  /** @type {import('../api/schema').PollDraftRequest} */
  const payload = {
    title,
    description,
    target_scope: targetScope,
    target_entrance: targetEntrance,
    target_apartment_ids: targetApartmentIds,
    eligibility: draft?.eligibility || 'RESIDENTS',
    unit: draft?.unit || 'APARTMENT',
    closes_at: closesAtIso,
    questions: builtQuestions,
  }

  return {
    valid: true,
    fieldErrors,
    questionErrors,
    payload,
  }
}

/**
 * Computes min, max, and average (rounded half-even to at most 6 decimals)
 * for an array of canonical decimal strings using BigInt arithmetic only.
 * Returns null if values is empty.
 * @param {string[]} values
 * @returns {{ min: string, max: string, average: string } | null}
 */
export function computeNumberStats(values) {
  const normalized = (values || [])
    .map((v) => normalizeCanonicalNumber(String(v)))
    .filter((v) => v !== null)
  if (normalized.length === 0) return null

  let minVal = normalized[0]
  let maxVal = normalized[0]
  let sumScaled = 0n

  for (const val of normalized) {
    if (compareCanonicalNumbers(val, minVal) < 0) minVal = val
    if (compareCanonicalNumbers(val, maxVal) > 0) maxVal = val

    const neg = val.startsWith('-')
    const unsigned = neg ? val.slice(1) : val
    const [intPart, fracPart = ''] = unsigned.split('.')
    const scaled = BigInt(intPart + fracPart.padEnd(6, '0').slice(0, 6))
    sumScaled += neg ? -scaled : scaled
  }

  const n = BigInt(normalized.length)
  const isNeg = sumScaled < 0n
  const absSum = isNeg ? -sumScaled : sumScaled
  let q = absSum / n
  const r = absSum % n
  const twiceR = 2n * r
  if (twiceR > n || (twiceR === n && q % 2n !== 0n)) {
    q += 1n
  }

  const qStr = q.toString().padStart(7, '0')
  const avgInt = qStr.slice(0, -6).replace(/^0+(?=\d)/, '') || '0'
  const avgFrac = qStr.slice(-6).replace(/0+$/, '')
  const avgStr =
    avgInt === '0' && avgFrac === ''
      ? '0'
      : `${isNeg ? '-' : ''}${avgInt}${avgFrac ? `.${avgFrac}` : ''}`

  return {
    min: minVal,
    max: maxVal,
    average: avgStr,
  }
}


