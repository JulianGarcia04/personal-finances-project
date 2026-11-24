import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import * as Router from 'vue-router'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'

const sidebar = readFileSync(fileURLToPath(new URL('./Sidebar.vue', import.meta.url)), 'utf8')
const workspaceSwitch = sidebar.match(/const switchWorkspace = async \(workspaceId: string\) => \{([\s\S]*?)\n\}/)?.[1] ?? ''

// Render the real sidebar over fake stores, a memory router and a minimal document.
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
  closest(selector: string): ViewNode | null {
    return selector === `#${this.props.id}` ? this : this.parent?.closest(selector) ?? null
  }
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
const noOp = () => {}
const Empty = { render: () => null }
const { descriptor } = parse(sidebar, { filename: 'Sidebar.vue' })
const sidebarScript = ts.transpile(compileScript(descriptor, { id: 'Sidebar.vue', inlineTemplate: true }).content, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
})

const mountSidebar = async (t: TestContext, logout: () => Promise<void> = async () => {}, realAuthStore?: object) => {
  const fakeAuthStore = Vue.reactive({
    isAuthenticated: true,
    user: { uid: 'user-a', displayName: 'Ana Gómez', email: 'ana@example.com' },
    activeWorkspaceId: 'hogar',
    activated: [] as string[],
    async activateWorkspace(workspaceId: string) { this.activated.push(workspaceId); this.activeWorkspaceId = workspaceId },
    logout
  })
  const authStore = (realAuthStore ?? fakeAuthStore) as typeof fakeAuthStore
  const notifications = { errors: [] as string[], error(message: string) { this.errors.push(message) }, success: noOp, info: noOp }
  const stores: Record<string, unknown> = {
    authStore,
    notificationsStore: notifications,
    settingsStore: Vue.reactive({ aiEnabled: false }),
    workspacesStore: Vue.reactive({
      workspaces: [{ id: 'personal', name: 'Personal' }, { id: 'hogar', name: 'Hogar con Camila' }],
      fetchMyWorkspaces: async () => {}
    })
  }
  const component = {} as { default: Vue.Component }
  new Function('exports', 'require', sidebarScript)(component, (id: string) => {
    if (id === 'vue') return { ...Vue, Transition: (_: unknown, { slots }: Vue.SetupContext) => slots.default?.() }
    if (id === 'vue-router') return Router
    if (id === '@/components/ui/useBodyScrollLock') return { useBodyScrollLock: noOp }
    if (id.endsWith('.vue')) return { default: () => null }
    if (id.startsWith('@/stores/')) {
      const name = id.slice('@/stores/'.length)
      assert.ok(name in stores, `unexpected store ${name}`)
      return { [`use${name[0].toUpperCase()}${name.slice(1)}`]: () => stores[name] }
    }
    return requireModule(id)
  })
  const router = Router.createRouter({
    history: Router.createMemoryHistory(),
    routes: [
      { path: '/', name: 'Dashboard', component: Empty },
      { path: '/login', name: 'Login', component: Empty },
      ...['accounts', 'transactions', 'goals', 'settings', 'agent', 'import'].map(path => ({ path: `/${path}`, component: Empty }))
    ]
  })
  await router.push('/accounts')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: null, get activeElement() { return focusedNode }, addEventListener: noOp, removeEventListener: noOp }
  })
  const root = new ViewNode('root')
  const app = renderer.createApp(component.default)
  t.after(() => {
    try { app.unmount() } finally {
      focusedNode = null
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
  app.use(router).mount(root)
  await new Promise(setImmediate)
  const header = () => root.descendants.find(node => node.tag === 'header')!
  const drawer = () => root.descendants.find(node => node.props.id === 'app-drawer')!
  const button = (scope: ViewNode, label: string | RegExp) => {
    const node = scope.descendants.find(node => node.tag === 'button' &&
      (typeof label === 'string' ? node.content === label : label.test(node.content)))
    assert.ok(node, `expected a "${label}" button`)
    return node
  }
  return { root, router, authStore, notifications, header, drawer, button }
}

test('S7: the mobile header shows the active workspace and opens the existing switcher in the drawer', async t => {
  const { header, drawer, button } = await mountSidebar(t)
  const control = button(header(), /Hogar con Camila/)
  assert.equal(control.props['aria-controls'], 'app-drawer')
  assert.equal(control.props['aria-expanded'], false)
  assert.match(control.props['aria-label'], /Hogar con Camila/, 'the accessible name includes the visible workspace name')
  const name = control.descendants.find(node => node.content === 'Hogar con Camila' && node.tag === 'span')
  assert.match(String(name?.props.class), /\btruncate\b/, 'a long name is truncated instead of pushing the layout')
  assert.equal(header().descendants.filter(node => node.tag === 'button').length, 1, 'the header holds no second switcher')
  assert.equal(drawer().props.inert, true)

  await control.props.onClick()
  await Vue.nextTick()
  assert.equal(drawer().props.inert, false, 'the "Más" drawer opens')
  assert.equal(control.props['aria-expanded'], true)
  const switcher = drawer().descendants.find(node => node.tag === 'button' && node.props['aria-haspopup'] === 'listbox')!
  assert.equal(switcher.props['aria-expanded'], true, 'the existing switcher is expanded')
  assert.ok(button(drawer(), 'Personal'), 'the switcher lists the other workspace')
  assert.equal(focusedNode, switcher, 'focus lands on the switcher it opened')
})

test('S7: choosing a workspace still switches through the shared activation, closes the drawer and returns to the Dashboard', async t => {
  const { router, authStore, header, drawer, button } = await mountSidebar(t)
  const control = button(header(), /Hogar con Camila/)
  await control.props.onClick()
  await Vue.nextTick()

  await button(drawer(), 'Personal').props.onClick()
  await new Promise(setImmediate)
  assert.deepEqual(authStore.activated, ['personal'], 'one activation of the chosen workspace (switch + reload)')
  assert.equal(drawer().props.inert, true, 'the drawer closes')
  assert.equal(router.currentRoute.value.name, 'Dashboard')
  assert.match(button(header(), /Personal/).content, /Personal/, 'the header follows the new active workspace')
  assert.equal(focusedNode, control, 'focus returns to the header control that opened the drawer')
})

test('S7: workspace switching delegates its data reload to the shared activation instead of repeating it', () => {
  assert.match(workspaceSwitch, /authStore\.activateWorkspace\(workspaceId\)/)
  assert.doesNotMatch(workspaceSwitch, /fetchAccounts|fetchTransactions|loadBudgetSettings/)
})

test('S7: a failed logout shows an error toast and stays signed in', async t => {
  const { router, notifications, drawer, button } = await mountSidebar(t, async () => {
    throw new Error('Firebase: Error (auth/network-request-failed).')
  })
  await button(drawer(), 'Cerrar Sesión').props.onClick()
  await new Promise(setImmediate)
  assert.equal(notifications.errors.length, 1)
  assert.match(notifications.errors[0], /No se pudo cerrar la sesión/)
  assert.doesNotMatch(notifications.errors[0], /auth\/|Firebase/)
  assert.equal(router.currentRoute.value.path, '/accounts')
})

test('S7: a successful logout still goes to the login page without a toast', async t => {
  const { router, notifications, drawer, button } = await mountSidebar(t)
  await button(drawer(), 'Cerrar Sesión').props.onClick()
  await new Promise(setImmediate)
  assert.deepEqual(notifications.errors, [])
  assert.equal(router.currentRoute.value.name, 'Login')
})

// The real auth store (its shared activation) over recording Firestore and slow workspace-scoped stores.
const tick = () => new Promise(setImmediate)
const authScript = ts.transpile(
  readFileSync(new URL('../stores/authStore.ts', import.meta.url), 'utf8').replaceAll('import.meta.env', '({})'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)
const loadRealAuthStore = (t: TestContext, log: string[]) => {
  let store: { activeWorkspaceId: string | null } | null = null
  const slow = (name: string) => async () => {
    const workspaceId = store?.activeWorkspaceId
    log.push(`start ${name}@${workspaceId}`)
    await tick()
    await tick()
    log.push(`end ${name}@${workspaceId}`)
  }
  const module = {} as typeof import('../stores/authStore.ts')
  new Function('exports', 'require', authScript)(module, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth: {}, functions: {} }
    if (id === '@/lib/push') return { disablePush: noOp, hasPushRegistration: () => false }
    if (id === '@/lib/analytics') return { identifyUser: noOp, resetAnalytics: noOp, track: noOp }
    if (id === '@/lib/legal') return { buildLegalConsent: noOp }
    if (id === '@/lib/accountDeletion') return { ACCOUNT_DELETION_CONFIRMATION: 'ELIMINAR' }
    if (id === 'firebase/functions') return { httpsCallable: noOp }
    if (id === 'firebase/auth') return {}
    if (id === 'firebase/firestore') return {
      doc: (_db: object, collection: string, docId: string) => `${collection}/${docId}`,
      updateDoc: async (path: string, data: object) => {
        log.push(`profile write ${path} ${JSON.stringify(data)}`)
        await tick()
        log.push('profile written')
      }
    }
    if (id === './workspacesStore') return { newWorkspaceCurrencyFields: noOp }
    if (id === './accountsStore') return { useAccountsStore: () => ({ fetchAccounts: slow('accounts') }) }
    if (id === './transactionsStore') return {
      useTransactionsStore: () => ({ fetchTransactions: slow('transactions'), fetchCategories: slow('categories') })
    }
    if (id === './goalsStore') return { useGoalsStore: () => ({ fetchGoals: slow('goals'), loadBudgetSettings: slow('budgetSettings') }) }
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const instance = module.useAuthStore(pinia)
  instance.user = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana Gómez' }
  instance.profile = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana Gómez', currency: 'COP', createdAt: new Date(), activeWorkspaceId: 'hogar' }
  instance.activeWorkspaceId = 'hogar'
  store = instance
  return instance
}

test('S7: switching keeps its sequence: profile write, the five reloads for the new workspace, all awaited, then the Dashboard', async t => {
  const log: string[] = []
  const authStore = loadRealAuthStore(t, log)
  const { router, drawer, button, root } = await mountSidebar(t, undefined, authStore)
  router.afterEach(to => { log.push(`route ${String(to.name)}`) })
  await button(root, 'Más').props.onClick()
  await Vue.nextTick()
  await drawer().descendants.find(node => node.props['aria-haspopup'] === 'listbox')!.props.onClick()
  await Vue.nextTick()

  await button(drawer(), 'Personal').props.onClick()
  for (let i = 0; i < 5; i++) await tick()
  const reloads = ['accounts', 'transactions', 'goals', 'budgetSettings', 'categories']
  assert.deepEqual(log, [
    'profile write users/user-a {"activeWorkspaceId":"personal"}',
    'profile written',
    ...reloads.map(name => `start ${name}@personal`),
    ...reloads.map(name => `end ${name}@personal`),
    'route Dashboard'
  ])
  assert.equal(authStore.activeWorkspaceId, 'personal')
  assert.equal(authStore.profile?.activeWorkspaceId, 'personal')
  assert.equal(drawer().props.inert, true)
})
