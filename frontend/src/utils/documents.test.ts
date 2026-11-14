import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DOCUMENT_BYTES,
  addDocumentInStore,
  buildDocumentEditPatch,
  buildMinimalPdfBytes,
  checkDocumentUploadPreflight,
  createDefaultDocumentsSeed,
  deleteDocumentInStore,
  editDocumentInStore,
  extractDocumentFieldErrors,
  formatDocumentErrorMessage,
  formatDocumentSize,
  generateDocumentIdempotencyKey,
  getDocumentFileFromStore,
  getDocumentFromStore,
  getMaxDocumentDate,
  getUploadOptionsForUser,
  hasPdfMagicHeader,
  inspectPdfBlob,
  isDocumentUploadErrorRetryable,
  isSingleLineVisibleTitle,
  isValidDocumentDate,
  parseContentDispositionFilename,
  prefillDocumentTitleFromFilename,
  queryDocumentsStore,
  resolveDocumentCategoryKey,
  sanitizeDownloadFilename,
  validateDocumentDraft,
} from './documents.js'

const CHAIRMAN = { user_id: 'chair-1', building_role: 'CHAIRMAN' }
const BOARD = { user_id: 'board-1', building_role: 'BOARD' }
const ACCOUNTANT = { user_id: 'acc-1', building_role: 'ACCOUNTANT' }
const RESIDENT = { user_id: 'res-1', building_role: 'USER' }
const RESIDENT_MEM = [{ apartment_id: 'apt-14', apartment_number: '14' }]

describe('documents client helpers (#022 & #023)', () => {
  it('prefills single-line visible title without folder path or trailing .pdf', () => {
    assert.equal(prefillDocumentTitleFromFilename('/Users/alice/AGM 2026.PDF'), 'AGM 2026')
    assert.equal(prefillDocumentTitleFromFilename('C:\\Temp\\docs\\invoice-10.pdf'), 'invoice-10')
    assert.equal(prefillDocumentTitleFromFilename('multi\nline\ttitle.pdf'), 'multi line title')
    assert.equal(prefillDocumentTitleFromFilename('.pdf'), '')
    assert.equal(prefillDocumentTitleFromFilename(`${'x'.repeat(250)}.pdf`).length, 200)
  })

  it('validates single-line visible titles and rejects invisible/multiline/overlong values', () => {
    assert.equal(isSingleLineVisibleTitle('Articles 2026'), true)
    assert.equal(isSingleLineVisibleTitle(''), false)
    assert.equal(isSingleLineVisibleTitle('   \u200B\uFEFF  '), false)
    assert.equal(isSingleLineVisibleTitle('line1\nline2'), false)
    assert.equal(isSingleLineVisibleTitle('tab\there'), false)
    assert.equal(isSingleLineVisibleTitle('a'.repeat(201)), false)
  })

  it('enforces document_date optional bounds 1900-01-01 to +5 years in Tallinn TZ', () => {
    const fixedNow = Date.UTC(2026, 10, 13, 12, 0, 0) // 2026-11-13
    assert.equal(getMaxDocumentDate(fixedNow), '2031-11-13')
    // Leap day clamps cleanly +5 years
    assert.equal(getMaxDocumentDate(Date.UTC(2024, 1, 29, 12, 0, 0)), '2029-02-28')

    assert.equal(isValidDocumentDate('', fixedNow), true)
    assert.equal(isValidDocumentDate(null, fixedNow), true)
    assert.equal(isValidDocumentDate('1900-01-01', fixedNow), true)
    assert.equal(isValidDocumentDate('2031-11-13', fixedNow), true)
    assert.equal(isValidDocumentDate('1899-12-31', fixedNow), false)
    assert.equal(isValidDocumentDate('2031-11-14', fixedNow), false)
    assert.equal(isValidDocumentDate('2026-02-29', fixedNow), false)
    assert.equal(isValidDocumentDate('2024-02-29', fixedNow), true)
  })

  it('inspects %PDF- magic header and enforces size limits before upload', async () => {
    const validPdf = buildMinimalPdfBytes('Test PDF')
    assert.equal(hasPdfMagicHeader(validPdf), true)
    assert.equal(hasPdfMagicHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])), false)

    const okRes = await inspectPdfBlob(new Blob([validPdf], { type: 'application/pdf' }))
    assert.equal(okRes.ok, true)

    const notPdf = await inspectPdfBlob(new Blob(['not a pdf'], { type: 'application/pdf' }))
    assert.deepEqual(notPdf, { ok: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE' })

    const empty = await inspectPdfBlob(new Blob([], { type: 'application/pdf' }))
    assert.deepEqual(empty, { ok: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE' })

    const oversized = await inspectPdfBlob(new Blob([validPdf]), validPdf.byteLength - 1)
    assert.deepEqual(oversized, { ok: false, errorCode: 'FILE_TOO_LARGE' })
  })

  it('sanitizes download filenames and parses RFC 5987 Content-Disposition cleanly', () => {
    assert.equal(sanitizeDownloadFilename('Annual Report 2025'), 'Annual Report 2025.pdf')
    assert.equal(sanitizeDownloadFilename('Report.PDF'), 'Report.pdf')
    assert.equal(sanitizeDownloadFilename('../../bad:name?.pdf'), 'bad name .pdf')
    assert.equal(
      parseContentDispositionFilename("attachment; filename*=UTF-8''%D0%A3%D1%81%D1%82%D0%B0%D0%B2%202026.pdf"),
      'Устав 2026.pdf',
    )
    assert.equal(
      parseContentDispositionFilename("attachment; filename*=UTF-8'en'Board%20Report.pdf"),
      'Board Report.pdf',
    )
    assert.equal(
      parseContentDispositionFilename('attachment; filename="minutes-2026.pdf"'),
      'minutes-2026.pdf',
    )
    assert.equal(parseContentDispositionFilename('', 'Fallback Title'), 'Fallback Title.pdf')
  })

  it('maps unknown backend categories to OTHER and formats sizes', () => {
    assert.equal(resolveDocumentCategoryKey('INVOICE'), 'INVOICE')
    assert.equal(resolveDocumentCategoryKey('FUTURE_AUDIT_DOC'), 'OTHER')
    assert.equal(formatDocumentSize(512, 'en'), '512 B')
    assert.equal(formatDocumentSize(2048, 'en'), '2.0 KB')
    assert.ok(formatDocumentSize(2_500_000, 'en').endsWith(' MB'))
  })

  it('computes minimal PATCH payload containing only changed fields', () => {
    const orig = {
      id: 'doc-1',
      title: 'Original Title',
      category: 'CONTRACT',
      audience: 'BOARD',
      document_date: '2026-05-01',
    }
    assert.deepEqual(buildDocumentEditPatch(orig, orig), { patch: {}, hasChanges: false })
    assert.deepEqual(
      buildDocumentEditPatch(orig, {
        title: '  Updated Title  ',
        category: 'CONTRACT',
        audience: 'BOARD',
        document_date: '2026-05-01',
      }),
      { patch: { title: 'Updated Title' }, hasChanges: true },
    )
    assert.deepEqual(
      buildDocumentEditPatch(orig, {
        ...orig,
        document_date: '',
      }),
      { patch: { document_date: null }, hasChanges: true },
    )
  })

  it('classifies retryable errors vs UPLOAD_REMOVED/411/IDEMPOTENCY_KEY_REUSED, formats 500 traceId, and extracts 422 field errors', () => {
    assert.equal(isDocumentUploadErrorRetryable({ status: 409, errorCode: 'UPLOAD_REMOVED' }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 409, errorCode: 'IDEMPOTENCY_KEY_REUSED' }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 411 }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 411, errorCode: 'LENGTH_REQUIRED' }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 413, errorCode: 'FILE_TOO_LARGE' }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 415, errorCode: 'UNSUPPORTED_MEDIA_TYPE' }), false)
    assert.equal(isDocumentUploadErrorRetryable({ status: 400, errorCode: 'UPLOAD_INTERRUPTED' }), true)
    assert.equal(isDocumentUploadErrorRetryable({ status: 408, errorCode: 'UPLOAD_TIMEOUT' }), true)
    assert.equal(isDocumentUploadErrorRetryable({ status: 429, errorCode: 'RATE_LIMITED' }), true)
    assert.equal(isDocumentUploadErrorRetryable({ status: 507, errorCode: 'STORAGE_QUOTA_EXCEEDED' }), true)

    const fieldErrs = extractDocumentFieldErrors(
      {
        payload: {
          errors: [
            { loc: ['query', 'title'] },
            { loc: ['body', 'document_date'] },
          ],
        },
      },
      null,
      'en',
    )
    assert.ok(fieldErrs.title)
    assert.ok(fieldErrs.document_date)

    for (const lang of ['en', 'et', 'ru']) {
      assert.ok(formatDocumentErrorMessage({ status: 413 }, null, lang).includes('20'))
      assert.ok(formatDocumentErrorMessage({ status: 413, payload: {} }, null, lang).includes('20'))
      assert.ok(formatDocumentErrorMessage({ status: 415 }, null, lang).length > 5)
      assert.ok(formatDocumentErrorMessage({ errorCode: 'UPLOAD_INTERRUPTED' }, null, lang).length > 5)
      assert.ok(formatDocumentErrorMessage({ errorCode: 'UPLOAD_REMOVED' }, null, lang).length > 5)
      assert.ok(formatDocumentErrorMessage({ errorCode: 'UPLOADS_DISABLED' }, null, lang).length > 5)
      assert.ok(formatDocumentErrorMessage({ status: 507 }, null, lang).length > 10)
      assert.ok(formatDocumentErrorMessage({ errorCode: 'DOCUMENT_NOT_FOUND' }, null, lang).length > 5)
      const err500 = formatDocumentErrorMessage(
        { status: 500, errorCode: 'INTERNAL_SERVER_ERROR', traceId: 'tr-9988' },
        null,
        lang,
      )
      assert.ok(err500.includes('tr-9988'))
    }

    const key1 = generateDocumentIdempotencyKey()
    const key2 = generateDocumentIdempotencyKey()
    assert.notEqual(key1, key2)
    assert.ok(key1.length >= 16)
  })

  it('validates client draft including empty document_date omission', () => {
    const ok = validateDocumentDraft(
      { title: 'Budget 2027', category: 'FINANCIAL_REPORT', audience: 'BOARD', document_date: '' },
      {
        requireFile: true,
        file: new Blob([buildMinimalPdfBytes('Budget')], { type: 'application/pdf' }),
        fileIsPdf: true,
      },
    )
    assert.equal(ok.valid, true)
    assert.equal(ok.payload.document_date, null)

    const bad = validateDocumentDraft(
      { title: 'bad\nline', category: 'NOPE', audience: 'ALIENS', document_date: '1850-01-01' },
      { requireFile: true, file: null },
    )
    assert.equal(bad.valid, false)
    assert.equal(bad.fieldErrors.file, 'FILE_REQUIRED')
    assert.equal(bad.fieldErrors.title, 'TITLE_INVALID')
    assert.equal(bad.fieldErrors.category, 'CATEGORY_REQUIRED')
    assert.equal(bad.fieldErrors.audience, 'AUDIENCE_INVALID')
    assert.equal(bad.fieldErrors.document_date, 'DATE_INVALID')
  })
})

describe('documents store access, privacy & upload/edit/delete contract (#022 & #023)', () => {
  it('enforces role visibility, resident uploaded_by redaction, and upload-options per role', () => {
    const store = createDefaultDocumentsSeed()
    const noMem = queryDocumentsStore(store, RESIDENT, [])
    assert.equal(noMem.ok, false)
    assert.equal(noMem.status, 403)

    const resList = queryDocumentsStore(store, RESIDENT, RESIDENT_MEM)
    assert.equal(resList.ok, true)
    assert.ok(resList.items.length > 0)
    assert.ok(resList.items.every((d: any) => d.audience === 'EVERYONE'))
    assert.ok(resList.items.every((d: any) => d.uploaded_by === null))
    assert.ok(resList.items.every((d: any) => d.can_edit === false && d.can_delete === false))

    const accList = queryDocumentsStore(store, ACCOUNTANT, [])
    assert.ok(accList.items.some((d: any) => d.audience === 'BOARD_AND_ACCOUNTANT'))
    assert.equal(accList.items.some((d: any) => d.audience === 'BOARD'), false)
    assert.ok(accList.items.every((d: any) => d.uploaded_by !== null))
    assert.ok(accList.items.every((d: any) => d.can_edit === false && d.can_delete === false))

    const boardList = queryDocumentsStore(store, BOARD, [])
    assert.ok(boardList.items.some((d: any) => d.audience === 'BOARD'))
    assert.ok(boardList.items.every((d: any) => d.can_edit === true && d.can_delete === false))

    const chairList = queryDocumentsStore(store, CHAIRMAN, [])
    assert.equal(chairList.items.length, store.length)
    assert.ok(chairList.items.every((d: any) => d.can_edit === true && d.can_delete === true))

    assert.deepEqual(getUploadOptionsForUser(RESIDENT).can_upload, false)
    assert.deepEqual(getUploadOptionsForUser(ACCOUNTANT).audiences, ['BOARD_AND_ACCOUNTANT'])
    assert.deepEqual(getUploadOptionsForUser(BOARD).audiences, [
      'EVERYONE',
      'BOARD_AND_ACCOUNTANT',
      'BOARD',
    ])
    assert.equal(getUploadOptionsForUser(CHAIRMAN, { uploadsDisabled: true }).can_upload, false)
  })

  it('enforces strict upload preflight order, idempotent replay, 409 conflict, and MIME/size validation', () => {
    const store = createDefaultDocumentsSeed()
    const idem = new Map<string, any>()
    const pdfBytes = buildMinimalPdfBytes('Uploaded PDF')

    // Resident cannot upload
    const resDeny = addDocumentInStore({
      store,
      user: RESIDENT,
      userMemberships: RESIDENT_MEM,
      bytes: pdfBytes,
      query: { title: 'Test', category: 'OTHER', audience: 'EVERYONE' },
      contentLength: pdfBytes.byteLength,
    })
    assert.equal(resDeny.status, 403)

    // Accountant cannot upload to EVERYONE
    const accScopeDeny = addDocumentInStore({
      store,
      user: ACCOUNTANT,
      bytes: pdfBytes,
      query: { title: 'Invoice 1', category: 'INVOICE', audience: 'EVERYONE' },
      contentLength: pdfBytes.byteLength,
    })
    assert.equal(accScopeDeny.status, 403)

    // 415 on non-PDF MIME & non-%PDF- magic bytes
    const badMime = checkDocumentUploadPreflight({
      store,
      user: CHAIRMAN,
      query: { title: 'Doc', category: 'OTHER', audience: 'BOARD' },
      contentType: 'image/jpeg',
      contentLength: pdfBytes.byteLength,
    })
    assert.equal(badMime.status, 415)

    const fakePdf = addDocumentInStore({
      store,
      user: CHAIRMAN,
      bytes: new TextEncoder().encode('hello world'),
      query: { title: 'Fake', category: 'OTHER', audience: 'BOARD' },
      contentType: 'application/pdf',
      contentLength: 11,
    })
    assert.equal(fakePdf.status, 415)

    // 413 on oversized declaration & 403 UPLOADS_DISABLED
    const tooBig = checkDocumentUploadPreflight({
      store,
      user: CHAIRMAN,
      query: { title: 'Huge', category: 'OTHER', audience: 'BOARD' },
      contentType: 'application/pdf',
      contentLength: MAX_DOCUMENT_BYTES + 1,
    })
    assert.equal(tooBig.status, 413)

    const disabled = checkDocumentUploadPreflight({
      store,
      user: CHAIRMAN,
      query: { title: 'Valid', category: 'OTHER', audience: 'BOARD' },
      contentType: 'application/pdf',
      contentLength: pdfBytes.byteLength,
      uploadsDisabled: true,
    })
    assert.equal(disabled.errorCode, 'UPLOADS_DISABLED')

    // Successful upload + idempotent replay + conflict on different payload
    const key = 'doc-idem-key-1'
    const created = addDocumentInStore({
      store,
      user: ACCOUNTANT,
      bytes: pdfBytes,
      query: { title: 'Устав 2026', category: 'INVOICE', audience: 'BOARD_AND_ACCOUNTANT' },
      contentType: 'application/pdf',
      contentLength: pdfBytes.byteLength,
      idempotencyKey: key,
      idempotencyStore: idem,
    })
    assert.equal(created.status, 201)
    assert.equal(created.document.title, 'Устав 2026')

    // Unicode title Content-Disposition must be accepted by standard Fetch Headers without TypeError
    const fileRes = getDocumentFileFromStore(store, created.document.id, CHAIRMAN)
    assert.equal(fileRes.ok, true)
    assert.doesNotThrow(() => new Headers({ 'Content-Disposition': fileRes.contentDisposition }))

    const replay = addDocumentInStore({
      store,
      user: ACCOUNTANT,
      bytes: pdfBytes,
      query: { title: 'Устав 2026', category: 'INVOICE', audience: 'BOARD_AND_ACCOUNTANT' },
      contentType: 'application/pdf',
      contentLength: pdfBytes.byteLength,
      idempotencyKey: key,
      idempotencyStore: idem,
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.document.id, created.document.id)

    const collision = addDocumentInStore({
      store,
      user: ACCOUNTANT,
      bytes: buildMinimalPdfBytes('Different File'),
      query: { title: 'Another', category: 'INVOICE', audience: 'BOARD_AND_ACCOUNTANT' },
      contentType: 'application/pdf',
      contentLength: 999,
      idempotencyKey: key,
      idempotencyStore: idem,
    })
    assert.equal(collision.status, 409)
    assert.equal(collision.errorCode, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('enforces partial edit by Board/Chairman and chairman-only deletion returning 404 thereafter', () => {
    const store = createDefaultDocumentsSeed()
    const targetId = store[0].id

    // Accountant cannot edit
    const accEdit = editDocumentInStore({
      store,
      documentId: targetId,
      user: ACCOUNTANT,
      body: { title: 'Hacked' },
    })
    assert.equal(accEdit.status, 403)

    // Board edits only document_date -> clears to null while keeping title intact
    const cleared = editDocumentInStore({
      store,
      documentId: targetId,
      user: BOARD,
      body: { document_date: null },
    })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.document.document_date, null)
    assert.equal(cleared.document.title, store[0].title)

    // Board cannot delete
    const boardDel = deleteDocumentInStore({ store, documentId: targetId, user: BOARD })
    assert.equal(boardDel.status, 403)

    // Chairman deletes -> item and file return 404
    const chairDel = deleteDocumentInStore({ store, documentId: targetId, user: CHAIRMAN })
    assert.equal(chairDel.ok, true)
    assert.equal(getDocumentFromStore(store, targetId, CHAIRMAN).status, 404)
    assert.equal(getDocumentFileFromStore(store, targetId, CHAIRMAN).status, 404)
  })
})
