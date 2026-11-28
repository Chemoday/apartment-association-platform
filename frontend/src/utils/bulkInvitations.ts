import type {
  BulkInvitationReport,
  BulkInvitationRow,
  BulkRowOutcome,
  Locale,
  ObjectKind,
} from '@/api/schema.js'
import { OBJECT_KINDS } from './objectName.js'

export const BULK_MAX_BYTES = 1024 * 1024 // 1 MB
const SUPPORTED_LOCALES = new Set<string>(['en', 'et', 'ru'])
const SUPPORTED_KINDS = new Set<string>(OBJECT_KINDS)

const HEADER_FIRST_CELLS = new Set([
  'apartment',
  'apartment_number',
  'number',
  'object',
  'unit',
  'korter',
  'nr',
  'квартира',
  'номер',
  'объект',
])

const HEADER_SECOND_CELLS = new Set([
  'email',
  'e-mail',
  'mail',
  'e-post',
  'epost',
  'почта',
])

export interface BulkApartmentCandidate {
  apartment_id: string
  apartment_number: string
  apartment_kind?: ObjectKind | string | null
}

export interface BulkPendingCandidate {
  apartment_id?: string | null
  apartment_number?: string | null
  apartment_kind?: ObjectKind | string | null
  email?: string | null
  raw_email?: string | null
}

export interface BulkResolvedRow {
  line: number
  apartment_id: string
  apartment_number: string
  apartment_kind: ObjectKind
  email: string
  locale: Locale | null
}

export interface BulkEvaluationError {
  status: 422 | 429
  errorCode: 'BULK_LIST_TOO_LONG' | 'RATE_LIMITED'
  message: string
  retry_after_seconds?: number
}

export interface BulkEvaluationResult {
  report: BulkInvitationReport
  invitedRows: BulkResolvedRow[]
}

export function isBulkOutcomeProblem(outcome: BulkRowOutcome): boolean {
  return outcome !== 'READY' && outcome !== 'INVITED'
}

function isSimpleValidEmail(value: string): boolean {
  if (!value || value.length > 320 || /\s/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || !domain || !domain.includes('.')) return false
  if (domain.startsWith('.') || domain.endsWith('.')) return false
  return true
}

function splitBulkLine(line: string): string[] {
  let delimiter = ','
  if (line.includes(';')) delimiter = ';'
  else if (line.includes('\t')) delimiter = '\t'
  const cells = line.split(delimiter).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1').trim())
  // Drop trailing empty cells produced by spreadsheet exports (docs/API.md section 7)
  while (cells.length > 2 && cells[cells.length - 1] === '') {
    cells.pop()
  }
  return cells
}

function isHeaderRow(cells: string[]): boolean {
  if (cells.length < 2) return false
  const c0 = cells[0].toLowerCase()
  const c1 = cells[1].toLowerCase()
  if (HEADER_FIRST_CELLS.has(c0) && HEADER_SECOND_CELLS.has(c1)) return true
  // docs/API.md: second cell is not an e-mail and contains "mail"
  return !isSimpleValidEmail(cells[1]) && c1.includes('mail')
}

function createEmptyCounts(): Record<BulkRowOutcome, number> {
  return {
    INVALID_ROW: 0,
    INVALID_EMAIL: 0,
    INVALID_LOCALE: 0,
    INVALID_KIND: 0,
    APARTMENT_NOT_FOUND: 0,
    DUPLICATE_IN_LIST: 0,
    ALREADY_PENDING: 0,
    READY: 0,
    INVITED: 0,
  }
}

function matchApartment(
  apartments: BulkApartmentCandidate[],
  apartmentNumber: string,
  kind: ObjectKind,
): BulkApartmentCandidate | undefined {
  const exactNum = apartmentNumber.trim()
  return apartments.find(
    (a) =>
      (a.apartment_kind || 'APARTMENT') === kind &&
      String(a.apartment_number || '').trim() === exactNum,
  )
}

/**
 * Parse and evaluate a bulk owner-invitation list per docs/API.md section 7 (#057 + #069).
 * Supports `;`, tab, or `,` separators, `#` comments, UTF-8 BOM, trailing empty cells,
 * optional header row, and optional 4th cell (`apartment_kind`).
 */
export function evaluateBulkInvitationsText(
  text: string,
  options: {
    apartments: BulkApartmentCandidate[]
    existingPending: BulkPendingCandidate[]
    limitRemaining: number
    mode: 'preview' | 'send'
  },
): BulkEvaluationResult {
  const normalizedText = text.startsWith('\uFEFF') ? text.slice(1) : text
  const byteLength = new TextEncoder().encode(normalizedText).length
  if (byteLength > BULK_MAX_BYTES) {
    const err: BulkEvaluationError = {
      status: 422,
      errorCode: 'BULK_LIST_TOO_LONG',
      message: 'The list exceeds the 1 MB limit.',
    }
    throw err
  }

  const rawLines = normalizedText.split(/\r?\n/)
  const dataLines: Array<{ line: number; cells: string[] }> = []
  let headerChecked = false

  for (let i = 0; i < rawLines.length; i += 1) {
    const trimmed = rawLines[i].trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const cells = splitBulkLine(trimmed)
    if (!headerChecked) {
      headerChecked = true
      if (isHeaderRow(cells)) {
        continue
      }
    }
    dataLines.push({ line: i + 1, cells })
  }

  const maxRows = Math.max(options.apartments.length * 2, 2)
  if (dataLines.length > maxRows) {
    const err: BulkEvaluationError = {
      status: 422,
      errorCode: 'BULK_LIST_TOO_LONG',
      message: 'The list has too many rows for this building.',
    }
    throw err
  }

  const pendingKeys = new Set<string>()
  for (const p of options.existingPending) {
    const email = String(p.raw_email || p.email || '').trim().toLowerCase()
    if (!email) continue
    if (p.apartment_id) {
      pendingKeys.add(`${p.apartment_id}::${email}`)
    } else if (p.apartment_number) {
      const k = p.apartment_kind || 'APARTMENT'
      pendingKeys.add(`${k}:${p.apartment_number.trim()}::${email}`)
    }
  }

  const seenInList = new Set<string>()
  const counts = createEmptyCounts()
  const rows: BulkInvitationRow[] = []
  const readyRows: BulkResolvedRow[] = []

  for (const entry of dataLines) {
    const { line, cells } = entry
    if (cells.length < 2 || cells.length > 4) {
      counts.INVALID_ROW += 1
      rows.push({
        line,
        apartment_number: cells[0] || null,
        apartment_kind: null,
        email: cells[1] || null,
        locale: cells[2] || null,
        outcome: 'INVALID_ROW',
      })
      continue
    }

    const aptNum = cells[0] || ''
    const email = cells[1] || ''
    const rawLocale = (cells[2] || '').toLowerCase()
    const rawKind = (cells[3] || '').toUpperCase()

    if (!aptNum) {
      counts.INVALID_ROW += 1
      rows.push({
        line,
        apartment_number: null,
        apartment_kind: null,
        email: email || null,
        locale: rawLocale || null,
        outcome: 'INVALID_ROW',
      })
      continue
    }

    if (!isSimpleValidEmail(email)) {
      counts.INVALID_EMAIL += 1
      rows.push({
        line,
        apartment_number: aptNum,
        apartment_kind: rawKind && SUPPORTED_KINDS.has(rawKind) ? (rawKind as ObjectKind) : null,
        email: email || null,
        locale: rawLocale || null,
        outcome: 'INVALID_EMAIL',
      })
      continue
    }

    if (rawLocale && !SUPPORTED_LOCALES.has(rawLocale)) {
      counts.INVALID_LOCALE += 1
      rows.push({
        line,
        apartment_number: aptNum,
        apartment_kind: rawKind && SUPPORTED_KINDS.has(rawKind) ? (rawKind as ObjectKind) : null,
        email,
        locale: rawLocale,
        outcome: 'INVALID_LOCALE',
      })
      continue
    }

    if (rawKind && !SUPPORTED_KINDS.has(rawKind)) {
      counts.INVALID_KIND += 1
      rows.push({
        line,
        apartment_number: aptNum,
        apartment_kind: null,
        email,
        locale: rawLocale || null,
        outcome: 'INVALID_KIND',
      })
      continue
    }

    const kind: ObjectKind = (rawKind as ObjectKind) || 'APARTMENT'
    const matched = matchApartment(options.apartments, aptNum, kind)
    if (!matched) {
      counts.APARTMENT_NOT_FOUND += 1
      rows.push({
        line,
        apartment_number: aptNum,
        apartment_kind: kind,
        email,
        locale: rawLocale || null,
        outcome: 'APARTMENT_NOT_FOUND',
      })
      continue
    }

    const dedupeKey = `${matched.apartment_id}::${email.toLowerCase()}`
    if (seenInList.has(dedupeKey)) {
      counts.DUPLICATE_IN_LIST += 1
      rows.push({
        line,
        apartment_number: matched.apartment_number,
        apartment_kind: kind,
        email,
        locale: rawLocale || null,
        outcome: 'DUPLICATE_IN_LIST',
      })
      continue
    }
    seenInList.add(dedupeKey)

    const fallbackPendingKey = `${kind}:${matched.apartment_number.trim()}::${email.toLowerCase()}`
    if (pendingKeys.has(dedupeKey) || pendingKeys.has(fallbackPendingKey)) {
      counts.ALREADY_PENDING += 1
      rows.push({
        line,
        apartment_number: matched.apartment_number,
        apartment_kind: kind,
        email,
        locale: rawLocale || null,
        outcome: 'ALREADY_PENDING',
      })
      continue
    }

    const outcome: BulkRowOutcome = options.mode === 'send' ? 'INVITED' : 'READY'
    counts[outcome] += 1
    rows.push({
      line,
      apartment_number: matched.apartment_number,
      apartment_kind: kind,
      email,
      locale: rawLocale || null,
      outcome,
    })
    readyRows.push({
      line,
      apartment_id: matched.apartment_id,
      apartment_number: matched.apartment_number,
      apartment_kind: kind,
      email,
      locale: (rawLocale || null) as Locale | null,
    })
  }

  if (options.mode === 'send' && readyRows.length > options.limitRemaining) {
    const err: BulkEvaluationError = {
      status: 429,
      errorCode: 'RATE_LIMITED',
      message: 'The building daily invitation limit is reached.',
      retry_after_seconds: 3600,
    }
    throw err
  }

  return {
    report: {
      rows,
      counts,
      limit_remaining:
        options.mode === 'send'
          ? Math.max(0, options.limitRemaining - readyRows.length)
          : options.limitRemaining,
    },
    invitedRows: options.mode === 'send' ? readyRows : [],
  }
}
