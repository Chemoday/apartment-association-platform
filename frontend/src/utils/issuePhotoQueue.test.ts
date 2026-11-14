import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { i18n } from '../locales/index.js'
import {
  MAX_CONCURRENT_PHOTO_UPLOADS,
  canQueuePhotoUploadsAfterCreate,
  createQueuedPhotoItem,
  drainPhotoUploadQueue,
  formatPhotoErrorMessage,
  generatePhotoIdempotencyKey,
  isPhotoErrorRetryable,
  isUploadsEnabledInForm,
  resolveCanAddPhotoFalseReason,
  resolvePostCreateAbortReason,
  revokeQueuedPhotoPreviews,
  scaleQueuedPhotoItem,
  shouldAbortRemainingUploadsForError,
  shouldShowIssuePhotosSection,
  uploadQueuedPhotoItem,
} from './issuePhotoQueue.js'

function tFn(key: string, params: Record<string, any> = {}, lang: 'en' | 'et' | 'ru' = 'en') {
  return i18n.global.t(key, params, { locale: lang })
}

describe('issuePhotoQueue use cases (#020)', () => {
  it('generates RFC-4122 UUID v4 Idempotency-Key values cleanly', () => {
    const k1 = generatePhotoIdempotencyKey()
    const k2 = generatePhotoIdempotencyKey()
    assert.notEqual(k1, k2)
    assert.match(k1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('happy path: creates immediate preview URL, scales to JPEG <= 1920px, streams upload progress, and revokes preview URL', async () => {
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    const createdUrls: string[] = []
    const revokedUrls: string[] = []

    URL.createObjectURL = () => {
      const u = `blob:mock-${createdUrls.length + 1}`
      createdUrls.push(u)
      return u
    }
    URL.revokeObjectURL = (u: string) => {
      revokedUrls.push(u)
    }

    try {
      const rawFile = new Blob(['raw-camera-photo'], { type: 'image/heic' })
      const scaledJpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
        type: 'image/jpeg',
      })
      const queue = [createQueuedPhotoItem(rawFile, { idPrefix: 'uc1' })]
      assert.equal(queue[0].previewUrl, 'blob:mock-1')
      assert.equal(queue[0].status, 'scaling')

      const getItem = (id: string) => queue.find((q) => q.localId === id)
      const updateItem = (id: string, patch: Record<string, any>) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      }

      const scaleCalls: any[] = []
      const scaledOk = await scaleQueuedPhotoItem(queue[0].localId, rawFile, {
        updateItem,
        lang: 'en',
        scaleFn: async (_file, opts) => {
          scaleCalls.push(opts)
          return { blob: scaledJpeg, width: 1920, height: 1440 }
        },
      })
      assert.equal(scaledOk, true)
      assert.deepEqual(scaleCalls, [{ maxEdgePx: 1920 }])
      assert.equal(queue[0].status, 'ready')
      assert.equal(queue[0].scaledBlob, scaledJpeg)

      const progressSteps: number[] = []
      const uploadCalls: any[] = []
      const result = await uploadQueuedPhotoItem('issue-123', queue[0].localId, {
        getItem,
        updateItem,
        tFn: (k, p) => tFn(k, p, 'en'),
        lang: 'en',
        uploadFn: async (issueId, blob, opts) => {
          uploadCalls.push({ issueId, blob, idempotencyKey: opts.idempotencyKey })
          opts.onProgress(25, 100)
          progressSteps.push(queue[0].progress)
          opts.onProgress(100, 100)
          progressSteps.push(queue[0].progress)
          return { id: 'server-photo-1', mine: true, can_delete: true }
        },
      })

      assert.equal(result.ok, true)
      assert.equal(result.photo?.id, 'server-photo-1')
      assert.deepEqual(progressSteps, [25, 100])
      assert.equal(uploadCalls.length, 1)
      assert.equal(uploadCalls[0].blob, scaledJpeg)
      assert.equal(uploadCalls[0].idempotencyKey, queue[0].idempotencyKey)
      assert.equal(queue[0].status, 'uploaded')
      assert.equal(queue[0].previewUrl, '')
      assert.deepEqual(revokedUrls, ['blob:mock-1'])
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    }
  })

  it('fail-closed: scaling failure rejects original file, sets unrecoverable PHOTO_SCALING_FAILED, and never uploads', async () => {
    const rawFile = new Blob(['corrupt-heic-payload'], { type: 'image/heic' })
    const queue = [createQueuedPhotoItem(rawFile)]
    const updateItem = (id: string, patch: Record<string, any>) => {
      const idx = queue.findIndex((q) => q.localId === id)
      if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
    }

    const scaledOk = await scaleQueuedPhotoItem(queue[0].localId, rawFile, {
      updateItem,
      lang: 'ru',
      scaleFn: async () => {
        throw new Error('PHOTO_SCALING_FAILED')
      },
    })

    assert.equal(scaledOk, false)
    assert.equal(queue[0].status, 'error')
    assert.equal(queue[0].scaledBlob, null)
    assert.equal(queue[0].unrecoverable, true)
    assert.match(queue[0].error, /камер/i)

    let uploadCalled = false
    const uploadResult = await uploadQueuedPhotoItem('issue-123', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      tFn: (k, p) => tFn(k, p, 'ru'),
      lang: 'ru',
      uploadFn: async () => {
        uploadCalled = true
        return {}
      },
    })
    assert.equal(uploadResult.ok, false)
    assert.equal(uploadCalled, false)
  })

  it('network / UPLOAD_INTERRUPTED failure stays retryable and preserves exact Idempotency-Key on manual retry', async () => {
    const rawFile = new Blob(['photo'], { type: 'image/jpeg' })
    const scaledJpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = scaledJpeg
    queue[0].status = 'ready'
    const originalKey = queue[0].idempotencyKey

    const updateItem = (id: string, patch: Record<string, any>) => {
      const idx = queue.findIndex((q) => q.localId === id)
      if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
    }

    const seenKeys: string[] = []
    let attempt = 0
    const uploadFn = async (_id: string, _blob: Blob, opts: any) => {
      attempt += 1
      seenKeys.push(opts.idempotencyKey)
      if (attempt === 1) {
        throw { status: 400, errorCode: 'UPLOAD_INTERRUPTED', payload: { error_code: 'UPLOAD_INTERRUPTED' } }
      }
      return { id: 'photo-after-retry' }
    }

    // Attempt 1 fails with 400 UPLOAD_INTERRUPTED
    const first = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(first.ok, false)
    assert.equal(queue[0].status, 'error')
    assert.equal(queue[0].unrecoverable, false)
    assert.equal(queue[0].idempotencyKey, originalKey)

    // Manual retry sends identical Idempotency-Key and succeeds
    const second = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(second.ok, true)
    assert.equal(second.photo?.id, 'photo-after-retry')
    assert.deepEqual(seenKeys, [originalKey, originalKey])
  })

  it('413 FILE_TOO_LARGE / 422 IMAGE_TOO_LARGE automatically downscales once to 1280px with a fresh key and never infinite-loops', async () => {
    const rawFile = new Blob(['giant-photo'], { type: 'image/jpeg' })
    const initialScaled = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    const smallerScaled = new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' })

    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = initialScaled
    queue[0].status = 'ready'
    const initialKey = queue[0].idempotencyKey

    const updateItem = (id: string, patch: Record<string, any>) => {
      const idx = queue.findIndex((q) => q.localId === id)
      if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
    }

    const rescaleOpts: any[] = []
    const sentPayloads: any[] = []
    let seq = 0
    const res = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      keyGenerator: () => `retry-key-${++seq}`,
      scaleFn: async (_f, opts) => {
        rescaleOpts.push(opts)
        return { blob: smallerScaled }
      },
      uploadFn: async (_id, blob, opts) => {
        sentPayloads.push({ blob, key: opts.idempotencyKey })
        if (blob === initialScaled) {
          throw { status: 413, errorCode: 'FILE_TOO_LARGE', payload: { error_code: 'FILE_TOO_LARGE' } }
        }
        return { id: 'photo-downscaled-ok' }
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })

    assert.equal(res.ok, true)
    assert.equal(res.photo?.id, 'photo-downscaled-ok')
    assert.deepEqual(rescaleOpts, [{ maxEdgePx: 1280, quality: 0.78 }])
    assert.equal(sentPayloads.length, 2)
    assert.equal(sentPayloads[0].key, initialKey)
    assert.equal(sentPayloads[1].blob, smallerScaled)
    assert.equal(sentPayloads[1].key, 'retry-key-1')

    // Verify no infinite loop if even 1280px triggers 422 IMAGE_TOO_LARGE
    const queue2 = [createQueuedPhotoItem(rawFile)]
    queue2[0].scaledBlob = initialScaled
    queue2[0].status = 'ready'
    let attempts2 = 0
    const res2 = await uploadQueuedPhotoItem('issue-1', queue2[0].localId, {
      getItem: (id) => queue2.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = queue2.findIndex((q) => q.localId === id)
        if (idx !== -1) queue2[idx] = { ...queue2[idx], ...patch }
      },
      scaleFn: async () => ({ blob: smallerScaled }),
      uploadFn: async () => {
        attempts2 += 1
        throw { status: 422, errorCode: 'IMAGE_TOO_LARGE', payload: { error_code: 'IMAGE_TOO_LARGE' } }
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(res2.ok, false)
    assert.equal(attempts2, 2)
    assert.equal(queue2[0].status, 'error')
    assert.equal(queue2[0].unrecoverable, true)
  })

  it('409 IDEMPOTENCY_KEY_REUSED automatically retries once with a fresh key without infinite loop', async () => {
    const rawFile = new Blob(['photo'], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    queue[0].status = 'ready'
    const firstKey = queue[0].idempotencyKey

    const keysUsed: string[] = []
    let keySeq = 0
    const res = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      },
      keyGenerator: () => `fresh-key-${++keySeq}`,
      uploadFn: async (_id, _blob, opts) => {
        keysUsed.push(opts.idempotencyKey)
        if (keysUsed.length === 1) {
          throw { status: 409, errorCode: 'IDEMPOTENCY_KEY_REUSED' }
        }
        return { id: 'photo-rekeyed' }
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })

    assert.equal(res.ok, true)
    assert.deepEqual(keysUsed, [firstKey, 'fresh-key-1'])
    assert.equal(queue[0].rawFile, null)
    assert.equal(queue[0].scaledBlob, null)
  })

  it('classifies terminal vs retryable errors and formats 429 retry_after_seconds countdown accurately', async () => {
    assert.equal(isPhotoErrorRetryable({ errorCode: 'UPLOADS_DISABLED' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'ISSUE_ENDED' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'PHOTO_LIMIT_REACHED' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'INVALID_IMAGE' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'UNSUPPORTED_MEDIA_TYPE' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'FILE_TOO_LARGE' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'IMAGE_TOO_LARGE' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'IDEMPOTENCY_KEY_REUSED' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'VALIDATION_ERROR' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'LENGTH_REQUIRED' }), false)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'UPLOAD_ABORTED' }), false)

    assert.equal(isPhotoErrorRetryable({ errorCode: 'UPLOAD_INTERRUPTED' }), true)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'BACKEND_UNAVAILABLE', status: 0 }), true)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'RATE_LIMITED', status: 429 }), true)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'STORAGE_QUOTA_EXCEEDED', status: 507 }), true)
    assert.equal(isPhotoErrorRetryable({ errorCode: 'STORAGE_LOW_DISK', status: 507 }), true)

    const rawFile = new Blob(['photo'], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    queue[0].status = 'ready'

    const res429 = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      },
      uploadFn: async () => {
        throw {
          status: 429,
          errorCode: 'RATE_LIMITED',
          payload: { retry_after_seconds: 37 },
        }
      },
      tFn: (k, p) => tFn(k, p, 'ru'),
      lang: 'ru',
    })
    assert.equal(res429.ok, false)
    assert.equal(queue[0].unrecoverable, false)
    assert.match(queue[0].error, /37/)
  })

  it('partial multi-photo create flow: 1 succeeds, 2 fails, 3 succeeds, retrying 2 reuses its own key without touching 1 or 3', async () => {
    const f1 = new Blob(['p1'])
    const f2 = new Blob(['p2'])
    const f3 = new Blob(['p3'])
    const queue = [
      { ...createQueuedPhotoItem(f1), scaledBlob: new Blob(['s1']), status: 'ready' },
      { ...createQueuedPhotoItem(f2), scaledBlob: new Blob(['s2']), status: 'ready' },
      { ...createQueuedPhotoItem(f3), scaledBlob: new Blob(['s3']), status: 'ready' },
    ]
    const key2 = queue[1].idempotencyKey
    const callsByBlob: string[] = []
    let failSecond = true

    const uploadFn = async (_id: string, blob: Blob, opts: any) => {
      const label = await blob.text()
      callsByBlob.push(`${label}:${opts.idempotencyKey}`)
      if (label === 's2' && failSecond) {
        throw { status: 0, errorCode: 'BACKEND_UNAVAILABLE', isBackendUnavailable: true }
      }
      return { id: `server-${label}` }
    }

    const ctx = {
      getItem: (id: string) => queue.find((q) => q.localId === id),
      updateItem: (id: string, patch: Record<string, any>) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      },
      uploadFn,
      tFn: (k: string, p?: any) => tFn(k, p, 'en'),
      lang: 'en',
    }

    const r1 = await uploadQueuedPhotoItem('issue-new', queue[0].localId, ctx)
    const r2 = await uploadQueuedPhotoItem('issue-new', queue[1].localId, ctx)
    const r3 = await uploadQueuedPhotoItem('issue-new', queue[2].localId, ctx)

    assert.equal(r1.ok, true)
    assert.equal(r2.ok, false)
    assert.equal(r3.ok, true)
    assert.equal(queue[0].status, 'uploaded')
    assert.equal(queue[1].status, 'error')
    assert.equal(queue[2].status, 'uploaded')

    // Now network recovers; retry ONLY photo 2 with identical Idempotency-Key
    failSecond = false
    const r2Retry = await uploadQueuedPhotoItem('issue-new', queue[1].localId, ctx)
    assert.equal(r2Retry.ok, true)
    assert.equal(queue[1].status, 'uploaded')
    assert.equal(callsByBlob.length, 4)
    assert.equal(callsByBlob[1], `s2:${key2}`)
    assert.equal(callsByBlob[3], `s2:${key2}`)
  })

  it('aborts cleanly on AbortSignal without marking item as an upload error', async () => {
    const controller = new AbortController()
    const rawFile = new Blob(['photo'], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    queue[0].status = 'ready'

    const res = await uploadQueuedPhotoItem('issue-1', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      },
      signal: controller.signal,
      uploadFn: async (_id, _blob, opts) => {
        assert.equal(opts.signal, controller.signal)
        controller.abort()
        throw { status: 0, errorCode: 'UPLOAD_ABORTED' }
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(res.ok, false)
    assert.equal(res.aborted, true)
    assert.equal(queue[0].error, '')
    assert.equal(queue[0].status, 'ready')

    // Abort during 413 downscale recovery restores item to retryable 'ready' instead of leaving it stuck in 'scaling'
    const controller413 = new AbortController()
    const raw413 = new Blob(['large-photo'], { type: 'image/jpeg' })
    const q413 = [createQueuedPhotoItem(raw413)]
    q413[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    q413[0].status = 'ready'

    const res413Abort = await uploadQueuedPhotoItem('issue-1', q413[0].localId, {
      getItem: (id) => q413.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = q413.findIndex((q) => q.localId === id)
        if (idx !== -1) q413[idx] = { ...q413[idx], ...patch }
      },
      signal: controller413.signal,
      uploadFn: async () => {
        throw { status: 413, errorCode: 'FILE_TOO_LARGE' }
      },
      scaleFn: async (_f, opts) => {
        assert.equal(opts.signal, controller413.signal)
        controller413.abort()
        throw new Error('PHOTO_SCALING_ABORTED')
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(res413Abort.ok, false)
    assert.equal(res413Abort.aborted, true)
    assert.equal(q413[0].status, 'ready')
    assert.equal(q413[0].unrecoverable, false)

    // Aborting scaleQueuedPhotoItem does not mark the item unrecoverable
    const scaleCtrl = new AbortController()
    const qScale = [createQueuedPhotoItem(new Blob(['pick']))]
    const scaledOk = await scaleQueuedPhotoItem(qScale[0].localId, qScale[0].rawFile!, {
      updateItem: (id, patch) => {
        const idx = qScale.findIndex((q) => q.localId === id)
        if (idx !== -1) qScale[idx] = { ...qScale[idx], ...patch }
      },
      signal: scaleCtrl.signal,
      scaleFn: async () => {
        scaleCtrl.abort()
        throw new Error('PHOTO_SCALING_ABORTED')
      },
      lang: 'en',
    })
    assert.equal(scaledOk, false)
    assert.equal(qScale[0].unrecoverable, false)
  })

  it('handles 413 downscale followed by 409 IDEMPOTENCY_KEY_REUSED and 429 retry_after_seconds edge cases', async () => {
    const rawFile = new Blob(['photo-413-409'], { type: 'image/jpeg' })
    const initialBlob = new Blob(['initial'], { type: 'image/jpeg' })
    const smallerBlob = new Blob(['smaller'], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = initialBlob
    queue[0].status = 'ready'
    const firstKey = queue[0].idempotencyKey

    const keysSeen: string[] = []
    let keySeq = 0
    const res = await uploadQueuedPhotoItem('issue-combo', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem: (id, patch) => {
        const idx = queue.findIndex((q) => q.localId === id)
        if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
      },
      keyGenerator: () => `combo-key-${++keySeq}`,
      scaleFn: async () => ({ blob: smallerBlob }),
      uploadFn: async (_id, blob, opts) => {
        keysSeen.push(`${opts.idempotencyKey}:${await blob.text()}`)
        if (keysSeen.length === 1) {
          throw { status: 413, errorCode: 'FILE_TOO_LARGE' }
        }
        if (keysSeen.length === 2) {
          throw { status: 409, errorCode: 'IDEMPOTENCY_KEY_REUSED' }
        }
        return { id: 'photo-combo-ok' }
      },
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })

    assert.equal(res.ok, true)
    assert.equal(res.photo?.id, 'photo-combo-ok')
    assert.deepEqual(keysSeen, [
      `${firstKey}:initial`,
      'combo-key-1:smaller',
      'combo-key-2:smaller',
    ])

    const msgDefault60 = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: {} },
      (k, p) => tFn(k, p, 'en'),
      'en',
    )
    assert.match(msgDefault60, /\b60\b/)

    const msgZeroClampedTo1 = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: { retry_after_seconds: 0 } },
      (k, p) => tFn(k, p, 'en'),
      'en',
    )
    assert.match(msgZeroClampedTo1, /\b60\b/) // 0 || 60 -> 60s safe fallback

    const msgSubsecond = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: { retry_after_seconds: 0.4 } },
      (k, p) => tFn(k, p, 'en'),
      'en',
    )
    assert.match(msgSubsecond, /\b1\b/)

    const msgCeil = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: { retry_after_seconds: 1.2 } },
      (k, p) => tFn(k, p, 'en'),
      'en',
    )
    assert.match(msgCeil, /\b2\b/)
  })

  it('revokeQueuedPhotoPreviews revokes all remaining preview URLs on modal/page teardown', () => {
    const origRevoke = URL.revokeObjectURL
    const revoked: string[] = []
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url)
    }
    try {
      revokeQueuedPhotoPreviews([
        { previewUrl: 'blob:a' },
        { previewUrl: '' },
        { previewUrl: 'blob:b' },
      ])
      assert.deepEqual(revoked, ['blob:a', 'blob:b'])
    } finally {
      URL.revokeObjectURL = origRevoke
    }
  })

  it('handles disabled photo uploads proactively and reactively via pure UX decision helpers', () => {
    // Proactive: backward-compatible default true when field omitted, false only when explicitly false
    assert.equal(isUploadsEnabledInForm(undefined), true)
    assert.equal(isUploadsEnabledInForm(null), true)
    assert.equal(isUploadsEnabledInForm({ urgent_enabled: false }), true)
    assert.equal(isUploadsEnabledInForm({ uploads_enabled: true }), true)
    assert.equal(isUploadsEnabledInForm({ uploads_enabled: false }), false)

    // Reactive post-create: skip futile POST .../photos when created.can_add_photo === false or nothing uploadable
    assert.equal(canQueuePhotoUploadsAfterCreate({ id: 'i1', can_add_photo: true }, 0), false)
    assert.equal(canQueuePhotoUploadsAfterCreate({ id: 'i1', can_add_photo: false }, 2), false)
    assert.equal(canQueuePhotoUploadsAfterCreate({ id: 'i1', can_add_photo: true }, 2), true)
    assert.equal(canQueuePhotoUploadsAfterCreate({ id: 'i1' }, 1), true)

    // Queue-level abort classification: whole-issue blocks stop remaining uploads immediately
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'UPLOADS_DISABLED' }), true)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'ISSUE_ENDED' }), true)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'PHOTO_LIMIT_REACHED' }), true)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'FORBIDDEN' }), true)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'UPLOAD_INTERRUPTED' }), false)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'RATE_LIMITED' }), false)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'BACKEND_UNAVAILABLE' }), false)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'FILE_TOO_LARGE' }), false)
    assert.equal(shouldAbortRemainingUploadsForError(null), false)

    // Modal post-create abort banner reason
    assert.equal(resolvePostCreateAbortReason({ errorCode: 'UPLOADS_DISABLED' }), 'UPLOADS_DISABLED')
    assert.equal(resolvePostCreateAbortReason({ errorCode: 'ISSUE_ENDED' }), 'ISSUE_ENDED')
    assert.equal(resolvePostCreateAbortReason({ errorCode: 'PHOTO_LIMIT_REACHED' }), 'PHOTO_LIMIT_REACHED')
    assert.equal(resolvePostCreateAbortReason({ errorCode: 'FORBIDDEN' }), 'FORBIDDEN')
    assert.equal(resolvePostCreateAbortReason({ errorCode: 'UPLOAD_INTERRUPTED' }), '')
    assert.equal(resolvePostCreateAbortReason(null), '')

    // IssuePhotos visibility retains error banner when queue was cleared at 0 photos
    assert.equal(
      shouldShowIssuePhotosSection({
        photosCount: 0,
        canAddPhoto: false,
        photosDeleteAt: null,
        uploadQueueCount: 0,
        actionError: 'Photos are switched off in this demo.',
      }),
      true,
    )
    assert.equal(
      shouldShowIssuePhotosSection({
        photosCount: 0,
        canAddPhoto: false,
        photosDeleteAt: null,
        uploadQueueCount: 0,
        actionError: '',
      }),
      false,
    )

    // IssuePhotos watcher reason resolution when canAddPhoto becomes false
    assert.equal(
      resolveCanAddPhotoFalseReason({ abortReason: 'UPLOADS_DISABLED', existingCount: 1, issueOpen: true }),
      'UPLOADS_DISABLED',
    )
    assert.equal(
      resolveCanAddPhotoFalseReason({ existingCount: 3, issueOpen: true }),
      'PHOTO_LIMIT_REACHED',
    )
    assert.equal(
      resolveCanAddPhotoFalseReason({ existingCount: 1, issueOpen: false }),
      'ISSUE_ENDED',
    )
    assert.equal(
      resolveCanAddPhotoFalseReason({ existingCount: 1, issueOpen: true }),
      'UPLOADS_DISABLED',
    )
  })

  it('#025 UPLOAD_REMOVED (409) is final: clears payloads, never retries, and never resends even with a new key', async () => {
    const rawFile = new Blob(['removed-photo'], { type: 'image/jpeg' })
    const scaled = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = scaled
    queue[0].status = 'ready'
    const updateItem = (id: string, patch: Record<string, any>) => {
      const idx = queue.findIndex((q) => q.localId === id)
      if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
    }

    assert.equal(isPhotoErrorRetryable({ errorCode: 'UPLOAD_REMOVED' }), false)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'UPLOAD_REMOVED' }), false)

    let uploadCalls = 0
    const uploadFn = async () => {
      uploadCalls += 1
      throw { status: 409, errorCode: 'UPLOAD_REMOVED', payload: { error_code: 'UPLOAD_REMOVED' } }
    }

    const first = await uploadQueuedPhotoItem('issue-rem', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(first.ok, false)
    assert.equal(first.removed, true)
    assert.equal(uploadCalls, 1)
    assert.equal(queue[0].status, 'error')
    assert.equal(queue[0].unrecoverable, true)
    assert.equal(queue[0].removed, true)
    assert.equal(queue[0].rawFile, null)
    assert.equal(queue[0].scaledBlob, null)
    assert.match(queue[0].error, /removed/i)

    // Attempting to invoke upload again on this item must be a strict no-op (never resend)
    const second = await uploadQueuedPhotoItem('issue-rem', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(second.ok, false)
    assert.equal(second.removed, true)
    assert.equal(uploadCalls, 1)
  })

  it('#025 408 UPLOAD_TIMEOUT is retryable with the identical Idempotency-Key and clears cleanly on retry', async () => {
    const rawFile = new Blob(['slow-photo'], { type: 'image/jpeg' })
    const queue = [createQueuedPhotoItem(rawFile)]
    queue[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
    queue[0].status = 'ready'
    const originalKey = queue[0].idempotencyKey
    const updateItem = (id: string, patch: Record<string, any>) => {
      const idx = queue.findIndex((q) => q.localId === id)
      if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
    }

    assert.equal(isPhotoErrorRetryable({ errorCode: 'UPLOAD_TIMEOUT' }), true)
    assert.equal(shouldAbortRemainingUploadsForError({ errorCode: 'UPLOAD_TIMEOUT' }), false)

    const usedKeys: string[] = []
    let attempt = 0
    const uploadFn = async (_id: string, _blob: Blob, opts: any) => {
      attempt += 1
      usedKeys.push(opts.idempotencyKey)
      if (attempt === 1) {
        throw { status: 408, errorCode: 'UPLOAD_TIMEOUT', payload: { error_code: 'UPLOAD_TIMEOUT' } }
      }
      return { id: 'photo-after-timeout' }
    }

    const r1 = await uploadQueuedPhotoItem('issue-to', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(r1.ok, false)
    assert.equal(queue[0].status, 'error')
    assert.equal(queue[0].unrecoverable, false)
    assert.equal(queue[0].idempotencyKey, originalKey)

    const r2 = await uploadQueuedPhotoItem('issue-to', queue[0].localId, {
      getItem: (id) => queue.find((q) => q.localId === id),
      updateItem,
      uploadFn,
      tFn: (k, p) => tFn(k, p, 'en'),
      lang: 'en',
    })
    assert.equal(r2.ok, true)
    assert.deepEqual(usedKeys, [originalKey, originalKey])
  })

  it('#025 uploads at most MAX_CONCURRENT_PHOTO_UPLOADS (2) simultaneously and aborts queued tasks on whole-issue errors', async () => {
    assert.equal(MAX_CONCURRENT_PHOTO_UPLOADS, 2)
    let inFlight = 0
    let maxInFlight = 0
    const started: string[] = []

    const tasks = ['p1', 'p2', 'p3']
    const summary = await drainPhotoUploadQueue(tasks, {
      concurrency: MAX_CONCURRENT_PHOTO_UPLOADS,
      worker: async (id) => {
        started.push(id)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, id === 'p1' ? 25 : 10))
        inFlight -= 1
        return { ok: true }
      },
    })
    assert.equal(maxInFlight, 2)
    assert.equal(summary.completed, 3)
    assert.equal(summary.failed, 0)
    assert.deepEqual(started, ['p1', 'p2', 'p3'])

    // Whole-issue error in worker drops unstarted third task immediately
    const abortTasks = ['a1', 'a2', 'a3']
    const abortReasons: any[] = []
    const startedAbort: string[] = []
    const abortedSummary = await drainPhotoUploadQueue(abortTasks, {
      concurrency: MAX_CONCURRENT_PHOTO_UPLOADS,
      worker: async (id) => {
        startedAbort.push(id)
        if (id === 'a1') {
          return { ok: false, error: { errorCode: 'UPLOADS_DISABLED', status: 403 } }
        }
        await new Promise((r) => setTimeout(r, 15))
        return { ok: true }
      },
      onWholeIssueAbort: (err) => abortReasons.push(err?.errorCode),
    })
    assert.deepEqual(abortReasons, ['UPLOADS_DISABLED'])
    assert.equal(abortedSummary.wholeIssueError?.errorCode, 'UPLOADS_DISABLED')
    assert.equal(startedAbort.includes('a3'), false)
  })

  it('#025 formats 429 reason (BUSY vs DAILY_LIMIT), 507 reason (QUOTA vs DELETIONS_PENDING), and logs client bug on IDEMPOTENCY_KEY_REUSED', async () => {
    for (const lang of ['en', 'et', 'ru'] as const) {
      const busyMsg = formatPhotoErrorMessage(
        { errorCode: 'RATE_LIMITED', payload: { reason: 'BUSY', retry_after_seconds: 12 } },
        (k, p) => tFn(k, p, lang),
        lang,
      )
      assert.match(busyMsg, /12/)

      const dailyMsg = formatPhotoErrorMessage(
        { errorCode: 'RATE_LIMITED', payload: { reason: 'DAILY_LIMIT', retry_after_seconds: 4000 } },
        (k, p) => tFn(k, p, lang),
        lang,
      )
      assert.ok(dailyMsg.length > 10)
      assert.equal(dailyMsg.includes('4000'), false)

      const quotaMsg = formatPhotoErrorMessage(
        { errorCode: 'STORAGE_QUOTA_EXCEEDED', payload: { reason: 'QUOTA', category: 'photos' } },
        (k, p) => tFn(k, p, lang),
        lang,
      )
      const pendingMsg = formatPhotoErrorMessage(
        { errorCode: 'STORAGE_QUOTA_EXCEEDED', payload: { reason: 'DELETIONS_PENDING' } },
        (k, p) => tFn(k, p, lang),
        lang,
      )
      assert.ok(quotaMsg.length > 10)
      assert.equal(quotaMsg, pendingMsg)
    }

    // Double IDEMPOTENCY_KEY_REUSED logs once and becomes terminally unrecoverable (no loop)
    const origError = console.error
    const logged: any[] = []
    console.error = (...args: any[]) => logged.push(args)
    try {
      const rawFile = new Blob(['dup'], { type: 'image/jpeg' })
      const queue = [createQueuedPhotoItem(rawFile)]
      queue[0].scaledBlob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' })
      queue[0].status = 'ready'
      let attempts = 0
      const res = await uploadQueuedPhotoItem('issue-dup', queue[0].localId, {
        getItem: (id) => queue.find((q) => q.localId === id),
        updateItem: (id, patch) => {
          const idx = queue.findIndex((q) => q.localId === id)
          if (idx !== -1) queue[idx] = { ...queue[idx], ...patch }
        },
        uploadFn: async () => {
          attempts += 1
          throw { status: 409, errorCode: 'IDEMPOTENCY_KEY_REUSED' }
        },
        tFn: (k, p) => tFn(k, p, 'en'),
        lang: 'en',
      })
      assert.equal(res.ok, false)
      assert.equal(attempts, 2)
      assert.equal(logged.length, 1)
      assert.equal(queue[0].unrecoverable, true)
    } finally {
      console.error = origError
    }

    // Non-numeric retry_after_seconds never produces NaN, and omitting tFn falls back cleanly
    const nanFallbackWithT = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: { retry_after_seconds: 'soon' } },
      (k, p) => tFn(k, p, 'en'),
      'en',
    )
    assert.match(nanFallbackWithT, /\b60\b/)
    assert.equal(nanFallbackWithT.includes('NaN'), false)

    const noTFnFallback = formatPhotoErrorMessage(
      { errorCode: 'RATE_LIMITED', payload: { retry_after_seconds: 15 } },
      undefined as any,
      'en',
    )
    assert.match(noTFnFallback, /\b15\b/)

    // initialStatus: 'queued' transitions cleanly queued -> scaling -> ready
    const queuedItem = createQueuedPhotoItem(new Blob(['q']), { initialStatus: 'queued' })
    assert.equal(queuedItem.status, 'queued')
    const qArr = [queuedItem]
    const okScale = await scaleQueuedPhotoItem(queuedItem.localId, queuedItem.rawFile!, {
      updateItem: (id, patch) => {
        const idx = qArr.findIndex((q) => q.localId === id)
        if (idx !== -1) qArr[idx] = { ...qArr[idx], ...patch }
      },
      scaleFn: async () => ({ blob: new Blob(['scaled']) }),
      lang: 'en',
    })
    assert.equal(okScale, true)
    assert.equal(qArr[0].status, 'ready')
  })
})

