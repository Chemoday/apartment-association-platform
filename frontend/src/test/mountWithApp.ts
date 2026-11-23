/**
 * Shared Vue component test harness (`src/test/mountWithApp.ts`, #044).
 *
 * Eliminates duplicated `createFakeDomHarness()`, `createClientVueViteServer()`,
 * and window/document event spy boilerplate across Vue component test files.
 * Provides full support for `<Teleport to="body">`, `v-model`, keyboard/focus
 * events, Pinia, Vue Router, i18n, and Vite client-mode SFC loading with zero
 * Vue Teleport warnings.
 */

import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter, type RouteRecordRaw, type Router } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'

export const DEMO_USER_IDS = {
  CHAIRMAN: '018f0000-0000-7000-8000-000000000101',
  USER: '018f0000-0000-7000-8000-000000000102',
  ACCOUNTANT: '018f0000-0000-7000-8000-000000000103',
  TENANT: '018f0000-0000-7000-8000-000000000104',
  BOARD: '018f0000-0000-7000-8000-000000000105',
} as const

export type TestEventListener = (...args: any[]) => unknown

export interface VTestNode {
  kind: 'element' | 'text' | 'comment'
  tag?: string
  props: Record<string, any>
  text?: string
  children: VTestNode[]
  parentNode: VTestNode | null
  value?: string
  composing?: boolean
  options?: any[]
  scrollCalls?: number
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
  focusCalls?: number
  scrollIntoView?: () => void
  focus?: () => void
  blur?: () => void
  getRootNode?: () => VTestNode
  contains?: (other: any) => boolean
  addEventListener?: (type: string, fn: TestEventListener) => void
  removeEventListener?: (type: string, fn: TestEventListener) => void
  dispatchEvent?: (evt: any) => void
}

export function createFakeDomHarness() {
  const bodyNode: VTestNode = {
    kind: 'element',
    tag: 'body',
    props: {},
    children: [],
    parentNode: null,
  }

  const nodeOps = {
    patchProp(el: VTestNode, key: string, _prevValue: any, nextValue: any) {
      if (key === 'class') {
        if (Array.isArray(nextValue)) {
          el.props.class = nextValue.filter(Boolean).join(' ')
        } else if (nextValue && typeof nextValue === 'object') {
          el.props.class = Object.entries(nextValue)
            .filter(([, active]) => Boolean(active))
            .map(([cls]) => cls)
            .join(' ')
        } else {
          el.props.class = nextValue || ''
        }
      } else {
        el.props[key] = nextValue
        if (key === 'value' || key === 'modelValue') {
          el.value = nextValue != null ? String(nextValue) : ''
        }
      }
    },
    insert(child: VTestNode, parent: VTestNode, anchor?: VTestNode | null) {
      if (!parent) return
      if (child.parentNode && child.parentNode !== parent) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx !== -1) child.parentNode.children.splice(idx, 1)
      }
      child.parentNode = parent
      if (anchor) {
        const idx = parent.children.indexOf(anchor)
        if (idx !== -1) {
          parent.children.splice(idx, 0, child)
          return
        }
      }
      if (!parent.children.includes(child)) {
        parent.children.push(child)
      }
    },
    remove(child: VTestNode) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child)
        if (idx !== -1) child.parentNode.children.splice(idx, 1)
        child.parentNode = null
      }
    },
    createElement(type: string): VTestNode {
      const listeners = new Map<string, Set<TestEventListener>>()
      const node: VTestNode = {
        kind: 'element',
        tag: type,
        props: {},
        children: [],
        parentNode: null,
        options: [],
        value: '',
        composing: false,
        scrollCalls: 0,
        focusCalls: 0,
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 200,
        scrollIntoView() {
          node.scrollCalls = (node.scrollCalls || 0) + 1
        },
        focus() {
          node.focusCalls = (node.focusCalls || 0) + 1
        },
        blur() {},
        getRootNode() {
          return bodyNode
        },
        contains(target: any) {
          if (!target) return false
          if (target === node) return true
          const stack = [...node.children]
          while (stack.length > 0) {
            const cur = stack.pop()!
            if (cur === target) return true
            stack.push(...cur.children)
          }
          return false
        },
        addEventListener(evtType: string, fn: TestEventListener) {
          if (!listeners.has(evtType)) listeners.set(evtType, new Set())
          listeners.get(evtType)!.add(fn)
        },
        removeEventListener(evtType: string, fn: TestEventListener) {
          listeners.get(evtType)?.delete(fn)
        },
        dispatchEvent(evt: any) {
          for (const fn of [...(listeners.get(evt?.type) || [])]) {
            fn(evt)
          }
        },
      }
      return node
    },
    createText(text: string): VTestNode {
      return { kind: 'text', props: {}, text, children: [], parentNode: null }
    },
    createComment(text: string): VTestNode {
      return { kind: 'comment', props: {}, text, children: [], parentNode: null }
    },
    setText(node: VTestNode, text: string) {
      node.text = text
    },
    setElementText(el: VTestNode, text: string) {
      el.children = [{ kind: 'text', props: {}, text, children: [], parentNode: el }]
    },
    parentNode(node: VTestNode) {
      return node.parentNode
    },
    nextSibling(node: VTestNode) {
      const parent = node.parentNode
      if (!parent) return null
      const idx = parent.children.indexOf(node)
      return idx >= 0 && idx + 1 < parent.children.length ? parent.children[idx + 1] : null
    },
    cloneNode(node: VTestNode): VTestNode {
      return {
        ...node,
        props: { ...node.props },
        children: node.children.map((c) => ({ ...c })),
        parentNode: null,
      }
    },
    insertStaticContent(content: string, parent: VTestNode, anchor: VTestNode | null) {
      const node: VTestNode = {
        kind: 'text',
        props: {},
        text: content.replace(/<[^>]+>/g, ' '),
        children: [],
        parentNode: null,
      }
      nodeOps.insert(node, parent, anchor)
      return [node, node] as [VTestNode, VTestNode]
    },
    querySelector(selector: string) {
      if (selector === 'body') return bodyNode
      return null
    },
  }

  const { createApp } = createRenderer<VTestNode, VTestNode>(nodeOps as any)

  function collectText(node: VTestNode | null | undefined): string {
    if (!node) return ''
    if (node.kind === 'text') return node.text || ''
    if (node.kind === 'comment') return ''
    return node.children.map(collectText).join(' ')
  }

  function findAll(root: VTestNode | null | undefined, predicate: (node: VTestNode) => boolean): VTestNode[] {
    if (!root) return []
    const hits: VTestNode[] = []
    if (predicate(root)) hits.push(root)
    for (const c of root.children) {
      hits.push(...findAll(c, predicate))
    }
    return hits
  }

  function findByTestId(root: VTestNode | null | undefined, testId: string): VTestNode | null {
    return (
      findAll(root, (n) => n.kind === 'element' && n.props['data-testid'] === testId)[0] ||
      findAll(bodyNode, (n) => n.kind === 'element' && n.props['data-testid'] === testId)[0] ||
      null
    )
  }

  async function flushUpdates(ticks = 15) {
    for (let i = 0; i < ticks; i += 1) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  return { createApp, bodyNode, collectText, findAll, findByTestId, flushUpdates }
}

export function createClientVueViteServer(): Promise<ViteDevServer> {
  return createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [
      {
        name: 'test-client-vue',
        configResolved(config) {
          const vp = config.plugins.find((p) => p.name === 'vite:vue')
          if (vp?.api?.options) {
            vp.api.options.isProduction = true
          }
          if (vp?.transform) {
            const orig = vp.transform as any
            const fn = typeof orig === 'function' ? orig : orig.handler
            const wrapped = function (this: any, code: string, id: string, opts: any) {
              return fn.call(this, code, id, { ...opts, ssr: false })
            }
            if (typeof orig === 'function') (vp as any).transform = wrapped
            else orig.handler = wrapped
          }
        },
      },
    ],
  })
}

export function createWindowSpy() {
  const listeners = new Map<string, Set<TestEventListener>>()
  const windowObj = {
    addEventListener(type: string, fn: TestEventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: TestEventListener) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(evt: any) {
      for (const fn of [...(listeners.get(evt.type) || [])]) {
        fn(evt)
      }
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    location: { search: '' },
  }
  return { listeners, windowObj }
}

export function createDocAndWindowSpy() {
  const docListeners = new Map<string, Set<TestEventListener>>()
  const { listeners: winListeners, windowObj } = createWindowSpy()
  const documentObj = {
    visibilityState: 'visible',
    addEventListener(type: string, fn: TestEventListener) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: TestEventListener) {
      docListeners.get(type)?.delete(fn)
    },
    dispatchEvent(evt: any) {
      for (const fn of [...(docListeners.get(evt.type) || [])]) {
        fn(evt)
      }
    },
  }
  return { docListeners, winListeners, documentObj, windowObj }
}

export interface MountWithAppOptions {
  props?: Record<string, any>
  routes?: RouteRecordRaw[]
  initialRoute?: string
  pinia?: Pinia
  router?: Router
  plugins?: any[]
}

const DefaultDummyRoute = { template: '<div />' }

/**
 * High-level component mounting helper that wires a Vue component with Pinia,
 * Vue Router, and the fake DOM renderer (`<Teleport to="body">` ready).
 */
export async function mountWithApp(component: Component, options: MountWithAppOptions = {}) {
  const harness = createFakeDomHarness()
  const pinia = options.pinia || createPinia()
  const router =
    options.router ||
    createRouter({
      history: createMemoryHistory(),
      routes: options.routes || [
        { path: '/', name: 'dashboard', component: DefaultDummyRoute },
        { path: '/readings', name: 'readings', component: DefaultDummyRoute },
        { path: '/accounting', name: 'accounting', component: DefaultDummyRoute },
        { path: '/apartments', name: 'apartments', component: DefaultDummyRoute },
        { path: '/apartments/:id', name: 'apartment-card', component: DefaultDummyRoute },
        { path: '/building', name: 'building', component: DefaultDummyRoute },
        { path: '/chat', name: 'chat', component: DefaultDummyRoute },
        { path: '/settings/association', name: 'association-settings', component: DefaultDummyRoute },
        { path: '/polls', name: 'polls', component: DefaultDummyRoute },
        { path: '/issues', name: 'issues', component: DefaultDummyRoute },
      ],
    })

  if (options.initialRoute) {
    await router.push(options.initialRoute)
    await router.isReady()
  }

  const root = harness.bodyNode
  const Wrapper = defineComponent({
    setup() {
      return () => h(component as any, options.props || {})
    },
  })

  const app = harness.createApp(Wrapper)
  app.use(pinia)
  app.use(router)
  if (Array.isArray(options.plugins)) {
    for (const plugin of options.plugins) {
      app.use(plugin)
    }
  }

  const container: VTestNode = {
    kind: 'element',
    tag: 'div',
    props: { id: 'app' },
    children: [],
    parentNode: root,
  }
  root.children.push(container)
  app.mount(container)
  await harness.flushUpdates()

  return {
    app,
    pinia,
    router,
    container,
    bodyNode: harness.bodyNode,
    collectText: () => harness.collectText(container),
    collectAllText: () => harness.collectText(harness.bodyNode).trim(),
    findAll: (predicate: (node: VTestNode) => boolean) => harness.findAll(container, predicate),
    findByTestId: (testId: string) => harness.findByTestId(container, testId),
    flushUpdates: harness.flushUpdates,
    unmount: () => {
      app.unmount()
    },
  }
}
