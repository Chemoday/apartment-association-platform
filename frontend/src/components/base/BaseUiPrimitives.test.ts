import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientVueViteServer, createWindowSpy, mountWithApp } from '../../test/mountWithApp.js'

test('BaseSelect, BaseTextarea, BaseInput, BaseField wire aria-invalid, aria-describedby, and role=alert (#045)', async () => {
  const vite = await createClientVueViteServer()
  try {
    const { default: BaseSelect } = await vite.ssrLoadModule('/src/components/base/BaseSelect.vue')
    const { default: BaseTextarea } = await vite.ssrLoadModule('/src/components/base/BaseTextarea.vue')
    const { default: BaseInput } = await vite.ssrLoadModule('/src/components/base/BaseInput.vue')
    const { default: BaseField } = await vite.ssrLoadModule('/src/components/base/BaseField.vue')

    // BaseSelect with error
    const sel = await mountWithApp(BaseSelect, {
      props: {
        id: 'cat-select',
        label: 'Category',
        options: [
          { value: 'LIGHTING', label: 'Lighting' },
          { value: 'HEATING', label: 'Heating' },
        ],
        error: 'Category is required',
      },
    })
    const selectEl = sel.findAll((n) => n.kind === 'element' && n.tag === 'select')[0]
    assert.ok(selectEl)
    assert.equal(selectEl.props['aria-invalid'], 'true')
    assert.equal(selectEl.props['aria-describedby'], 'cat-select-error')
    const selAlert = sel.findAll((n) => n.kind === 'element' && n.props.role === 'alert')[0]
    assert.ok(selAlert)
    assert.ok(sel.collectText().includes('Category is required'))
    sel.unmount()

    // BaseTextarea with maxlength & hint
    const ta = await mountWithApp(BaseTextarea, {
      props: {
        id: 'notes-area',
        label: 'Notes',
        modelValue: 'Hello',
        maxlength: 200,
        hint: 'Be concise',
      },
    })
    const textareaEl = ta.findAll((n) => n.kind === 'element' && n.tag === 'textarea')[0]
    assert.ok(textareaEl)
    assert.equal(textareaEl.props['aria-describedby'], 'notes-area-hint')
    assert.ok(ta.collectText().includes('5 / 200'))
    assert.ok(ta.collectText().includes('Be concise'))
    ta.unmount()

    // BaseInput with error
    const inp = await mountWithApp(BaseInput, {
      props: {
        id: 'meter-val',
        label: 'Reading',
        error: 'Invalid decimal',
      },
    })
    const inputEl = inp.findAll((n) => n.kind === 'element' && n.tag === 'input')[0]
    assert.ok(inputEl)
    assert.equal(inputEl.props['aria-invalid'], 'true')
    assert.equal(inputEl.props['aria-describedby'], 'meter-val-error')
    inp.unmount()

    // BaseField
    const fld = await mountWithApp(BaseField, {
      props: {
        id: 'custom-field',
        label: 'Custom',
        required: true,
        error: 'Required field',
      },
    })
    const fldAlert = fld.findAll((n) => n.kind === 'element' && n.props.role === 'alert')[0]
    assert.ok(fldAlert)
    assert.equal(fldAlert.props.id, 'custom-field-error')
    fld.unmount()
  } finally {
    await vite.close()
  }
})

test('BaseAlertBanner, BasePagination, and BaseToastStack render accessible roles and emit interactions (#045)', async () => {
  const vite = await createClientVueViteServer()
  try {
    const { default: BaseAlertBanner } = await vite.ssrLoadModule('/src/components/base/BaseAlertBanner.vue')
    const { default: BasePagination } = await vite.ssrLoadModule('/src/components/base/BasePagination.vue')
    const { default: BaseToastStack } = await vite.ssrLoadModule('/src/components/base/BaseToastStack.vue')

    // BaseAlertBanner
    let dismissed = false
    const banner = await mountWithApp(BaseAlertBanner, {
      props: {
        variant: 'error',
        title: 'Save failed',
        message: 'Please retry',
        dismissible: true,
        onDismiss: () => {
          dismissed = true
        },
      },
    })
    const alertDiv = banner.findAll((n) => n.kind === 'element' && n.props.role === 'alert')[0]
    assert.ok(alertDiv)
    const dismissBtn = banner.findAll((n) => n.kind === 'element' && n.tag === 'button')[0]
    assert.ok(dismissBtn)
    dismissBtn.props.onClick()
    assert.equal(dismissed, true)
    banner.unmount()

    // BasePagination
    const emittedPages: number[] = []
    const pager = await mountWithApp(BasePagination, {
      props: {
        page: 1,
        pageSize: 10,
        total: 25,
        'onUpdate:page': (p: number) => emittedPages.push(p),
      },
    })
    assert.ok(pager.collectText().includes('1 / 3'))
    const prevBtn = pager.findByTestId('pagination-prev')
    const nextBtn = pager.findByTestId('pagination-next')
    assert.ok(prevBtn && nextBtn)
    assert.equal(prevBtn.props.disabled, true)
    assert.equal(nextBtn.props.disabled, false)
    nextBtn.props.onClick()
    assert.deepEqual(emittedPages, [2])
    pager.unmount()

    // BaseToastStack
    const dismissedToasts: string[] = []
    const stack = await mountWithApp(BaseToastStack, {
      props: {
        toasts: [
          { id: 't1', message: 'Saved successfully', variant: 'success' },
          { id: 't2', message: 'Network error', variant: 'error' },
        ],
        onDismiss: (id: string) => dismissedToasts.push(id),
      },
    })
    assert.ok(stack.collectText().includes('Saved successfully'))
    assert.ok(stack.collectText().includes('Network error'))
    const buttons = stack.findAll((n) => n.kind === 'element' && n.tag === 'button')
    assert.equal(buttons.length, 2)
    buttons[0].props.onClick()
    assert.deepEqual(dismissedToasts, ['t1'])
    stack.unmount()
  } finally {
    await vite.close()
  }
})

test('CTO audit P2-6/P2-8/P3-1: BaseField error+hint has no dangling aria-describedby, BaseConfirmDialog blocks close while busy, BasePagination clamps out-of-range page, BaseTextarea shows counter without label', async () => {
  const vite = await createClientVueViteServer()
  try {
    const { default: BaseField } = await vite.ssrLoadModule('/src/components/base/BaseField.vue')
    const { default: BasePagination } = await vite.ssrLoadModule('/src/components/base/BasePagination.vue')
    const { default: BaseTextarea } = await vite.ssrLoadModule('/src/components/base/BaseTextarea.vue')
    const { default: BaseConfirmDialog } = await vite.ssrLoadModule('/src/components/base/BaseConfirmDialog.vue')

    // BaseField with both error and hint must NOT render hint element or dangle hintId
    const fld = await mountWithApp(BaseField, {
      props: {
        id: 'dual-field',
        label: 'Dual',
        hint: 'Helpful hint',
        error: 'Validation failed',
      },
    })
    assert.ok(fld.collectText().includes('Validation failed'))
    assert.equal(fld.collectText().includes('Helpful hint'), false)
    fld.unmount()

    // BasePagination with page > totalPages stays visible and clamps prev
    const emitted: number[] = []
    const pager = await mountWithApp(BasePagination, {
      props: {
        page: 3,
        pageSize: 10,
        total: 5,
        'onUpdate:page': (p: number) => emitted.push(p),
      },
    })
    assert.ok(pager.collectText().includes('1 / 1'))
    const prevBtn = pager.findByTestId('pagination-prev')
    assert.ok(prevBtn)
    prevBtn.props.onClick()
    assert.deepEqual(emitted, [1])
    pager.unmount()

    // BaseTextarea without label still renders maxlength counter
    const ta = await mountWithApp(BaseTextarea, {
      props: {
        id: 'no-label-ta',
        modelValue: 'abc',
        maxlength: 50,
      },
    })
    const counter = ta.findByTestId('textarea-counter')
    assert.ok(counter)
    assert.ok(ta.collectText().includes('3 / 50'))
    ta.unmount()

    // BaseConfirmDialog blocks Escape close when busy=true
    const origWindow = (globalThis as any).window
    const { windowObj } = createWindowSpy()
    ;(globalThis as any).window = windowObj
    try {
      let cancelled = false
      const dlg = await mountWithApp(BaseConfirmDialog, {
        props: {
          open: true,
          title: 'Delete item',
          message: 'Are you sure?',
          busy: true,
          onCancel: () => {
            cancelled = true
          },
        },
      })
      windowObj.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} })
      await dlg.flushUpdates(2)
      assert.equal(cancelled, false)
      dlg.unmount()
    } finally {
      ;(globalThis as any).window = origWindow
    }
  } finally {
    await vite.close()
  }
})
