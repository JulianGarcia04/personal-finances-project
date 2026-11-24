import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

// Render the real App shell with its children replaced by markers.
class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
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
const passThrough = (_: unknown, { slots }: Vue.SetupContext) => slots.default?.()

test('S7: App mounts exactly one notification host while loading, signed out and signed in', async t => {
  const authStore = Vue.reactive({ loading: true, isAuthenticated: false, init: async () => null })
  let hostMounts = 0
  let hostUnmounts = 0
  const NotificationHost = Vue.defineComponent({
    setup() {
      hostMounts++
      Vue.onUnmounted(() => { hostUnmounts++ })
      return () => Vue.h('div', { 'data-notification-host': '' })
    }
  })
  const file = './App.vue'
  const { descriptor, errors } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'), { filename: file })
  assert.deepEqual(errors, [])
  const script = ts.transpile(compileScript(descriptor, { id: file, inlineTemplate: true }).content, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  })
  const exports = {} as { default: Vue.Component }
  new Function('exports', 'require', script)(exports, (id: string) => {
    if (id === 'vue') return { ...Vue, Transition: passThrough }
    if (id === '@/components/ui/NotificationHost.vue') return { default: NotificationHost }
    if (id === '@/components/Sidebar.vue') return { default: () => Vue.h('nav') }
    if (id === '@/components/OnboardingWizard.vue') return { default: () => null }
    if (id === '@/stores/authStore') return { useAuthStore: () => authStore }
    if (id === '@/stores/settingsStore') return { useSettingsStore: () => ({ loadSettings: async () => {} }) }
    if (id === '@/lib/push') return { onForegroundMessage: async () => {} }
    return requireModule(id)
  })
  const root = new ViewNode('root')
  const app = renderer.createApp(exports.default)
  app.component('RouterView', () => null)
  t.after(() => app.unmount())
  app.mount(root)
  await Vue.nextTick()
  const hosts = () => root.descendants.filter(node => 'data-notification-host' in node.props).length

  assert.equal(hosts(), 1, 'loading')
  authStore.loading = false
  await Vue.nextTick()
  assert.equal(hosts(), 1, 'signed out (Login can show errors)')
  authStore.isAuthenticated = true
  await Vue.nextTick()
  assert.equal(hosts(), 1, 'signed in')
  authStore.isAuthenticated = false
  await Vue.nextTick()
  assert.equal(hosts(), 1, 'signed out again')
  assert.deepEqual([hostMounts, hostUnmounts], [1, 0], 'the host survives auth changes, so pending toasts are kept')
})
