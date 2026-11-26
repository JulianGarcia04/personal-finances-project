import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import * as storeModule from '../../stores/notificationsStore.ts'

// Render the real host, confirmation dialog and store without a browser.
let focusedNode: ViewNode | null = null
class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
  get content(): string { return (this.text + this.children.map(child => child.content).join('')).trim() }
  get descendants(): ViewNode[] { return this.children.flatMap(child => [child, ...child.descendants]) }
  focus() { focusedNode = this }
  contains(node: ViewNode | null) {
    for (let current = node; current; current = current.parent) if (current === this) return true
    return false
  }
}
const detach = (node: ViewNode) => {
  if (!node.parent) return
  node.parent.children.splice(node.parent.children.indexOf(node), 1)
  node.parent = null
}
const body = Vue.markRaw(new ViewNode('body'))
const renderer = Vue.createRenderer<ViewNode, ViewNode>({
  createElement: tag => Vue.markRaw(new ViewNode(tag)),
  createText: text => new ViewNode('#text', text),
  createComment: () => new ViewNode('#comment'),
  insert(node, parent, anchor = null) {
    detach(node)
    node.parent = parent
    if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
    else parent.children.push(node)
  },
  remove: detach,
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text; node.children = [] },
  patchProp(node, key, _previous, next) { node.props[key] = next },
  querySelector: selector => (selector === 'body' ? body : null)
})

// Minimal document: focus, body scroll lock and keydown listeners with capture/bubble order.
type KeyListener = { fn: (event: FakeKeyEvent) => void; capture: boolean }
type FakeKeyEvent = ReturnType<typeof keyEvent>
const keyEvent = (key: string, shiftKey = false) => ({
  key, shiftKey, defaultPrevented: false, propagationStopped: false, immediateStopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.propagationStopped = true },
  stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true }
})
const isCapture = (options?: boolean | { capture?: boolean }) => options === true || (typeof options === 'object' && options?.capture === true)
const installDocument = () => {
  const keyListeners: KeyListener[] = []
  const fakeDocument = {
    body: { style: { overflow: '' } },
    get activeElement() { return focusedNode },
    addEventListener(type: string, fn: KeyListener['fn'], options?: boolean | { capture?: boolean }) {
      if (type === 'keydown') keyListeners.push({ fn, capture: isCapture(options) })
    },
    removeEventListener(type: string, fn: KeyListener['fn'], options?: boolean | { capture?: boolean }) {
      const index = keyListeners.findIndex(listener => listener.fn === fn && listener.capture === isCapture(options))
      if (type === 'keydown' && index >= 0) keyListeners.splice(index, 1)
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  const restore = () => {
    focusedNode = null
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  // Document capture listeners run first; stopping propagation there skips every bubble listener.
  const press = (key: string, shiftKey = false) => {
    const event = keyEvent(key, shiftKey)
    for (const capture of [true, false]) {
      for (const listener of keyListeners.filter(entry => entry.capture === capture)) {
        listener.fn(event)
        if (event.immediateStopped) break
      }
      if (event.propagationStopped) break
    }
    return event
  }
  return { fakeDocument, keyListeners, press, restore }
}

const requireModule = createRequire(import.meta.url)
const passThrough = (_: unknown, { slots }: Vue.SetupContext) => slots.default?.()
const componentVue = { ...Vue, Transition: passThrough, TransitionGroup: passThrough }
const loadComponent = (file: string, store: ReturnType<typeof storeModule.useNotificationsStore>): Vue.Component => {
  const { descriptor, errors } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'), { filename: file })
  assert.deepEqual(errors, [])
  const script = ts.transpile(compileScript(descriptor, { id: file, inlineTemplate: true }).content, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  })
  const exports = {} as { default: Vue.Component }
  new Function('exports', 'require', script)(exports, (id: string) => {
    if (id === 'vue') return componentVue
    if (id === '@/stores/notificationsStore') return { ...storeModule, useNotificationsStore: () => store }
    if (id.endsWith('.vue')) return { default: loadComponent(id, store) }
    if (id.startsWith('./')) return requireModule(`${id}.ts`)
    return requireModule(id)
  })
  return exports.default
}

const mountHost = async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { restore, ...dom } = installDocument()
  const pinia = createPinia()
  const store = storeModule.useNotificationsStore(pinia)
  const root = new ViewNode('root')
  const app = renderer.createApp(loadComponent('./NotificationHost.vue', store))
  // Unmount while the fake document is still installed: the dialog removes its listener then.
  t.after(() => {
    try { app.unmount() } finally { disposePinia(pinia); body.children = []; restore() }
  })
  app.mount(root)
  await Vue.nextTick()
  const nodes = () => [...root.descendants, ...body.descendants]
  const dialog = () => nodes().find(node => node.props.role === 'alertdialog') ?? null
  const button = (label: string) => {
    const node = dialog()?.descendants.find(child => child.tag === 'button' && child.content === label)
    assert.ok(node, `expected a "${label}" button in the dialog`)
    return node
  }
  const settle = async () => { await Vue.nextTick(); await Vue.nextTick() }
  return { store, root, nodes, dialog, button, settle, ...dom }
}
const clickEvent = (node: ViewNode) => ({ target: node, currentTarget: node })
const zIndex = (node: ViewNode | null | undefined) => Number(/(?:^|\s)z-\[(\d+)\]/.exec(String(node?.props.class ?? ''))?.[1] ?? NaN)

test('S7: the host announces errors in an assertive alert region and other toasts in a polite status region', async t => {
  const h = await mountHost(t)
  const region = (live: string) => h.nodes().find(node => node.props['aria-live'] === live)
  assert.equal(region('assertive')?.props.role, 'alert', 'the assertive region exists before any error')
  assert.equal(region('polite')?.props.role, 'status', 'the polite region exists before any notice')

  h.store.error('No se pudo guardar.')
  h.store.success('Cuenta creada.')
  h.store.info('Sin cambios.')
  await Vue.nextTick()
  assert.equal(region('assertive')?.content, 'No se pudo guardar.')
  assert.match(region('polite')?.content ?? '', /Cuenta creada\./)
  assert.match(region('polite')?.content ?? '', /Sin cambios\./)
  assert.doesNotMatch(region('polite')?.content ?? '', /No se pudo guardar/)

  const close = region('assertive')?.descendants.find(node => node.tag === 'button' && node.props['aria-label'] === 'Cerrar notificación')
  assert.ok(close, 'each toast can be dismissed')
  close.props.onClick(clickEvent(close))
  await Vue.nextTick()
  assert.equal(region('assertive')?.content, '')
  assert.deepEqual(h.store.toasts.map(toast => toast.kind), ['success', 'info'])
})

test('S7: the confirmation dialog shows the request and resolves true on confirm', async t => {
  const h = await mountHost(t)
  assert.equal(h.dialog(), null)
  const answer = h.store.confirm({ title: '¿Eliminar cuenta?', message: 'Se borrarán sus movimientos.' })
  await h.settle()
  const dialog = h.dialog()
  assert.ok(dialog, 'the confirmation renders as an alert dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(h.nodes().find(node => node.props.id === dialog.props['aria-labelledby'])?.content, '¿Eliminar cuenta?')
  assert.equal(h.nodes().find(node => node.props.id === dialog.props['aria-describedby'])?.content, 'Se borrarán sus movimientos.')
  assert.equal(h.fakeDocument.body.style.overflow, 'hidden', 'page scroll is locked while open')

  const confirm = h.button('Confirmar')
  h.button('Cancelar')
  confirm.props.onClick(clickEvent(confirm))
  assert.equal(await answer, true)
  await h.settle()
  assert.equal(h.dialog(), null)
  assert.equal(h.fakeDocument.body.style.overflow, '', 'page scroll is restored')
})

test('S7: the cancel button resolves false', async t => {
  const h = await mountHost(t)
  const answer = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?', cancelLabel: 'Volver', confirmLabel: 'Eliminar', tone: 'danger' })
  await h.settle()
  const cancel = h.button('Volver')
  cancel.props.onClick(clickEvent(cancel))
  assert.equal(await answer, false)
  await h.settle()
  assert.equal(h.dialog(), null)
})

test('S7: Escape resolves false without also closing a sheet underneath', async t => {
  const h = await mountHost(t)
  let sheetEscapes = 0
  h.fakeDocument.addEventListener('keydown', (event: { key: string }) => { if (event.key === 'Escape') sheetEscapes++ })
  const answer = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?' })
  await h.settle()
  h.press('Escape')
  assert.equal(await answer, false)
  assert.equal(sheetEscapes, 0, 'the open sheet keeps its Escape for later')
  await h.settle()
  assert.equal(h.dialog(), null)
  h.press('Escape')
  assert.equal(sheetEscapes, 1, 'once the confirmation closes, Escape reaches the sheet again')
  assert.equal(h.keyListeners.length, 1, 'the dialog removed its listener')
})

test('S7: a backdrop click resolves false and a click inside the panel does not', async t => {
  const h = await mountHost(t)
  const answer = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?' })
  await h.settle()
  const backdrop = h.dialog()!.parent!
  backdrop.props.onClick({ target: h.dialog(), currentTarget: backdrop })
  await h.settle()
  assert.ok(h.dialog(), 'a click that started inside the panel keeps the dialog open')
  backdrop.props.onClick(clickEvent(backdrop))
  assert.equal(await answer, false)
})

test('S7: a danger confirmation focuses the safe action first and focus returns to the trigger', async t => {
  const h = await mountHost(t)
  const trigger = new ViewNode('button')
  trigger.focus()
  const danger = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?', tone: 'danger' })
  await h.settle()
  assert.equal(focusedNode, h.button('Cancelar'), 'danger starts on Cancelar')
  h.press('Escape')
  await danger
  await h.settle()
  assert.equal(focusedNode, trigger, 'focus returns to the element that opened it')

  const neutral = h.store.confirm({ title: 'Registrar', message: '¿Continuar?' })
  await h.settle()
  assert.equal(focusedNode, h.button('Confirmar'), 'a default confirmation starts on Confirmar')
  h.store.resolveConfirmation(false)
  await neutral
})

test('S7: Tab keeps focus inside the confirmation', async t => {
  const h = await mountHost(t)
  const answer = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?', tone: 'danger' })
  await h.settle()
  const tab = h.press('Tab')
  assert.equal(tab.defaultPrevented, true)
  assert.equal(focusedNode, h.button('Confirmar'))
  h.press('Tab')
  assert.equal(focusedNode, h.button('Cancelar'), 'Tab wraps around')
  h.press('Tab', true)
  assert.equal(focusedNode, h.button('Confirmar'), 'Shift+Tab wraps backwards')
  h.store.resolveConfirmation(false)
  await answer
})

test('S7: the confirmation and toasts stack above open sheets and the onboarding overlay', async t => {
  const h = await mountHost(t)
  const toastStack = h.nodes().find(node => node.descendants.some(child => child.props['aria-live'] === 'assertive') && /(?:^|\s)fixed(?:\s|$)/.test(node.props.class ?? ''))
  assert.ok(zIndex(toastStack) > 70, `toast stack z-index ${zIndex(toastStack)} must be above the onboarding overlay (70)`)
  const answer = h.store.confirm({ title: 'Eliminar', message: '¿Seguro?' })
  await h.settle()
  const overlay = h.dialog()?.parent
  assert.ok(zIndex(overlay) > 70, `dialog z-index ${zIndex(overlay)} must be above sheets (60) and onboarding (70)`)
  h.store.resolveConfirmation(true)
  await answer
})
