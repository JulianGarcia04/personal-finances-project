import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

// Render the real picker without a browser.
class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
  get content(): string { return (this.text + this.children.map(child => child.content).join('')).trim() }
  get descendants(): ViewNode[] { return this.children.flatMap(child => [child, ...child.descendants]) }
}
const detach = (node: ViewNode) => {
  if (!node.parent) return
  node.parent.children.splice(node.parent.children.indexOf(node), 1)
  node.parent = null
}
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
  patchProp(node, key, _previous, next) { node.props[key] = next }
})

const requireModule = createRequire(import.meta.url)
const pickerFile = './MonthPicker.vue'
const { descriptor } = parse(readFileSync(new URL(pickerFile, import.meta.url), 'utf8'), { filename: pickerFile })
const pickerScript = ts.transpile(
  compileScript(descriptor, { id: pickerFile, inlineTemplate: true }).content,
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)
const MonthPicker = (() => {
  const exports = {} as { default: Vue.Component }
  new Function('exports', 'require', pickerScript)(exports, (id: string) => id === 'vue' ? Vue : requireModule(id))
  return exports.default
})()

const mountPicker = async (t: TestContext, props: { label: string; canGoNext: boolean }) => {
  const events: string[] = []
  const state = Vue.reactive({ ...props })
  const root = new ViewNode('root')
  const app = renderer.createApp({
    render: () => Vue.h(MonthPicker, {
      ...state,
      onPrevious: () => events.push('previous'),
      onNext: () => events.push('next')
    })
  })
  t.after(() => app.unmount())
  app.mount(root)
  await Vue.nextTick()
  const button = (name: string) => {
    const node = root.descendants.find(node => node.tag === 'button' && node.props['aria-label'] === name)
    assert.ok(node, `expected a "${name}" button`)
    return node
  }
  const valueNode = () => root.descendants.find(node => node.props['aria-live'] === 'polite')
  return { root, state, events, button, valueNode }
}

test('S9: the picker shows the month as a labelled group and announces its value', async t => {
  const { root, valueNode, button } = await mountPicker(t, { label: 'octubre de 2026', canGoNext: true })
  const group = root.descendants.find(node => node.props.role === 'group')
  assert.ok(group, 'the controls form a group')
  assert.equal(group.props['aria-label'], 'Mes')
  assert.equal(valueNode()?.content, 'octubre de 2026')
  assert.equal(valueNode()?.props['aria-atomic'], 'true')
  for (const name of ['Mes anterior', 'Mes siguiente']) {
    assert.equal(button(name).props.type, 'button')
    assert.equal(button(name).props.title, name)
  }
})

test('S9: the picker asks for the previous and the next month', async t => {
  const { events, button } = await mountPicker(t, { label: 'octubre de 2026', canGoNext: true })
  assert.equal(button('Mes siguiente').props.disabled, false)
  button('Mes anterior').props.onClick()
  button('Mes siguiente').props.onClick()
  assert.deepEqual(events, ['previous', 'next'])
})

test('S9: the next month is disabled at the current month and the new value is announced', async t => {
  const { state, events, button, valueNode } = await mountPicker(t, { label: 'octubre de 2026', canGoNext: true })
  state.label = 'noviembre de 2026'
  state.canGoNext = false
  await Vue.nextTick()
  assert.equal(valueNode()?.content, 'noviembre de 2026')
  assert.equal(button('Mes siguiente').props.disabled, true)
  assert.ok(!button('Mes anterior').props.disabled, 'earlier months stay reachable')
  button('Mes anterior').props.onClick()
  assert.deepEqual(events, ['previous'])
})
