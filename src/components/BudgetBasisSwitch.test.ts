import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import type { Workspace } from '../types.ts'

// Render the real switch and workspaces store without a browser or Firebase.
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
const transpile = (source: string) => ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS })
const storeScript = transpile(readFileSync(new URL('../stores/workspacesStore.ts', import.meta.url), 'utf8').replaceAll('import.meta.env', '({})'))
const switchFile = './BudgetBasisSwitch.vue'
const { descriptor } = parse(readFileSync(new URL(switchFile, import.meta.url), 'utf8'), { filename: switchFile })
const switchScript = transpile(compileScript(descriptor, { id: switchFile, inlineTemplate: true }).content)
const resolveLocal = (id: string) => requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const workspace = (id: string, ownerId: string, fields: Partial<Workspace> = {}): Workspace =>
  ({ id, name: id, ownerId, members: ['owner', 'member'], currency: 'COP', createdAt: '2026-01-01', ...fields })

// Mounts the switch over the real store; the first workspace starts active and writes can be delayed.
const mountSwitch = async (t: TestContext, uid: string, workspaces: Workspace[]) => {
  const authStore = Vue.reactive({ user: { uid }, activeWorkspaceId: workspaces[0].id })
  const writes: [string, Record<string, unknown>][] = []
  let persist: () => Promise<void> = async () => {}
  const storeModule = {} as typeof import('../stores/workspacesStore.ts')
  new Function('exports', 'require', storeScript)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth: { currentUser: { uid } } }
    if (id === './authStore') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return {
      doc: (_db: object, _collection: string, workspaceId: string) => workspaceId,
      updateDoc: async (workspaceId: string, data: Record<string, unknown>) => { writes.push([workspaceId, data]); await persist() }
    }
    return resolveLocal(id)
  })
  const pinia = createPinia()
  const store = storeModule.useWorkspacesStore(pinia)
  store.workspaces = workspaces
  const component = {} as { default: Vue.Component }
  new Function('exports', 'require', switchScript)(component, (id: string) => {
    if (id === 'vue') return Vue
    if (id === '@/stores/authStore') return { useAuthStore: () => authStore }
    if (id === '@/stores/workspacesStore') return { useWorkspacesStore: () => store }
    return resolveLocal(id)
  })
  const root = new ViewNode('root')
  const app = renderer.createApp(component.default)
  t.after(() => { app.unmount(); disposePinia(pinia) })
  app.mount(root)
  await Vue.nextTick()
  const button = (label: string) => {
    const node = root.descendants.find(node => node.tag === 'button' && node.content === label)
    assert.ok(node, `expected a "${label}" button`)
    return node
  }
  const group = () => root.descendants.find(node => node.props.role === 'group')!
  const state = () => ({
    consumoPressed: button('Consumo del mes').props['aria-pressed'],
    pagosPressed: button('Pagos del mes').props['aria-pressed'],
    disabled: [button('Consumo del mes').props.disabled, button('Pagos del mes').props.disabled],
    busy: group().props['aria-busy'],
    saving: /Guardando/.test(root.content),
    alert: root.descendants.find(node => node.props.role === 'alert')?.content ?? null,
    ownerNote: /Solo el dueño/.test(root.content)
  })
  return { root, store, authStore, writes, button, state, setPersistence: (next: () => Promise<void>) => { persist = next } }
}

test('S6: the workspace owner can switch the shared card basis and the choice is persisted', async t => {
  const { root, writes, button } = await mountSwitch(t, 'owner', [workspace('A', 'owner')])
  assert.equal(button('Consumo del mes').props['aria-pressed'], true)
  assert.deepEqual([button('Consumo del mes').props.disabled, button('Pagos del mes').props.disabled], [false, false])
  assert.doesNotMatch(root.content, /Solo el dueño/)

  await button('Pagos del mes').props.onClick()
  await Vue.nextTick()
  assert.deepEqual(writes, [['A', { budgetCardBasis: 'payment' }]])
  assert.equal(button('Pagos del mes').props['aria-pressed'], true)
  assert.equal(button('Consumo del mes').props['aria-pressed'], false)
})

test('S6: a member sees the active workspace basis read-only with an owner-only note and has no write path', async t => {
  const m = await mountSwitch(t, 'member', [
    workspace('A', 'owner', { budgetCardBasis: 'payment' }),
    workspace('B', 'owner', { budgetCardBasis: 'bogus' as never })
  ])
  const buttons = [m.button('Consumo del mes'), m.button('Pagos del mes')]
  assert.equal(m.store.activeBudgetCardBasis, 'payment')
  assert.equal(buttons[1].props['aria-pressed'], true)
  assert.deepEqual(buttons.map(node => node.props.disabled), [true, true])
  const note = m.root.descendants.find(node => node.tag === 'p' && /Solo el dueño del espacio de trabajo puede cambiar/.test(node.content))
  assert.ok(note, 'members are told who can change the basis')
  assert.ok(note.props.id && buttons.every(node => node.props['aria-describedby'] === note.props.id), 'the disabled controls reference the note')

  await buttons[0].props.onClick?.()
  await Vue.nextTick()
  assert.equal(buttons[1].props['aria-pressed'], true)
  m.authStore.activeWorkspaceId = 'B'
  await Vue.nextTick()
  assert.equal(m.store.activeBudgetCardBasis, 'consumption', 'an invalid stored value reads consumption')
  assert.equal(m.state().consumoPressed, true)
  await assert.rejects(m.store.updateBudgetCardBasis('A', 'consumption'), /Solo el dueño/)
  await assert.rejects(m.store.updateBudgetCardBasis('A', 'bogus' as never), /Elige/)
  assert.deepEqual(m.writes, [])
})

test('S6: a delayed A write resolving after switching to B leaves B basis, switch state and error untouched', async t => {
  const m = await mountSwitch(t, 'owner', [workspace('A', 'owner'), workspace('B', 'owner', { budgetCardBasis: 'consumption' })])
  const pending = deferred()
  m.setPersistence(() => pending.promise)
  const click = m.button('Pagos del mes').props.onClick()
  await Vue.nextTick()
  assert.equal(m.store.pendingBudgetCardBasisWrites.has('A'), true, 'claim taken synchronously')
  assert.deepEqual(m.state().disabled, [true, true])
  assert.equal(m.state().busy, true)
  m.authStore.activeWorkspaceId = 'B'
  await Vue.nextTick()
  const bDuring = m.state()
  assert.deepEqual(bDuring, { consumoPressed: true, pagosPressed: false, disabled: [false, false], busy: false, saving: false, alert: null, ownerNote: false })
  pending.resolve()
  await click
  await Vue.nextTick()
  assert.deepEqual(m.state(), bDuring, 'B unchanged after A resolves')
  assert.equal(m.store.activeBudgetCardBasis, 'consumption')
  assert.deepEqual(m.writes, [['A', { budgetCardBasis: 'payment' }]])
  assert.equal(m.store.pendingBudgetCardBasisWrites.size, 0)
  m.authStore.activeWorkspaceId = 'A'
  await Vue.nextTick()
  assert.equal(m.state().pagosPressed, true)
})

test('S6: a delayed A write rejecting after switching to B shows no error on B and A keeps its previous basis', async t => {
  const m = await mountSwitch(t, 'owner', [workspace('A', 'owner'), workspace('B', 'owner')])
  const pending = deferred()
  m.setPersistence(() => pending.promise)
  const click = m.button('Pagos del mes').props.onClick()
  m.authStore.activeWorkspaceId = 'B'
  await Vue.nextTick()
  pending.reject(new Error('offline'))
  await click
  await Vue.nextTick()
  assert.equal(m.state().alert, null, 'no A error on B')
  assert.deepEqual(m.state().disabled, [false, false])
  assert.equal(m.store.pendingBudgetCardBasisWrites.size, 0, 'claim released on failure')
  m.authStore.activeWorkspaceId = 'A'
  await Vue.nextTick()
  assert.equal(m.state().consumoPressed, true, 'A keeps the previous basis')
  assert.match(m.state().alert ?? '', /No se pudo guardar/)
})

test('S6: an owner of A who is a member of B sees B read-only mid-write and B is never written', async t => {
  const m = await mountSwitch(t, 'owner', [workspace('A', 'owner'), workspace('B', 'someone-else', { budgetCardBasis: 'payment' })])
  const pending = deferred()
  m.setPersistence(() => pending.promise)
  await m.button('Consumo del mes').props.onClick()
  assert.deepEqual(m.writes, [], 'a same-value click writes nothing')
  const click = m.button('Pagos del mes').props.onClick()
  m.authStore.activeWorkspaceId = 'B'
  await Vue.nextTick()
  assert.deepEqual(m.state(), { consumoPressed: false, pagosPressed: true, disabled: [true, true], busy: false, saving: false, alert: null, ownerNote: true })
  await m.button('Consumo del mes').props.onClick()
  await Vue.nextTick()
  await assert.rejects(m.store.updateBudgetCardBasis('B', 'consumption'), /Solo el dueño/)
  pending.resolve()
  await click
  await Vue.nextTick()
  assert.deepEqual(m.writes, [['A', { budgetCardBasis: 'payment' }]])
  assert.equal(m.store.workspaces[1].budgetCardBasis, 'payment')
})

test('S6: the store rejects an invalid basis from the owner and an unknown workspace without writing', async t => {
  const m = await mountSwitch(t, 'owner', [workspace('A', 'owner')])
  await assert.rejects(m.store.updateBudgetCardBasis('A', 'monthly' as never), /Elige/)
  await assert.rejects(m.store.updateBudgetCardBasis('Z', 'payment'), /Solo el dueño/)
  assert.deepEqual(m.writes, [])
  assert.equal(m.store.pendingBudgetCardBasisWrites.size, 0)
})
