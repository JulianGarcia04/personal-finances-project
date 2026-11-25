import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createGoalsBudgetActions, type GoalsBudgetManagementDependencies } from '../stores/goalsStore.ts'
import {
  createBudgetWorkspaceAdapter,
  planLegacyCategoryBudgetCurrencyConfirmation,
  type BudgetWorkspaceAdapterDependencies
} from '../lib/budgetWorkspaceAdapter.ts'

const wizardPath = fileURLToPath(new URL('./OnboardingWizard.vue', import.meta.url))
const appPath = fileURLToPath(new URL('../App.vue', import.meta.url))
const wizard = readFileSync(wizardPath, 'utf8')
const app = readFileSync(appPath, 'utf8')

test('the app mounts the onboarding wizard for signed-in users', () => {
  assert.match(app, /<OnboardingWizard v-if="authStore\.isAuthenticated" \/>/)
})

test('the wizard opens while the workspace cap currency is unconfirmed and loads budget settings per workspace', () => {
  assert.match(wizard, /categoryBudgetCurrency\.status === 'unconfirmed'/)
  assert.match(wizard, /goalsStore\.loadBudgetSettings\(\)/)
  assert.match(wizard, /authStore\.activeWorkspaceId/)
})

test('the region step saves country and main currency, proposing the country currency', () => {
  const stepOne = wizard.match(/v-if="step === 'region'"[\s\S]*?v-else-if/)?.[0] ?? ''
  assert.ok(stepOne, 'region step markup must exist')
  assert.match(stepOne, /<select[^>]*v-model="countryCode"/)
  assert.match(stepOne, /<select[^>]*v-model="mainCurrencyCode"/)
  assert.match(wizard, /mainCurrencyCode\.value = currencyForCountry\(countryCode\.value\)/)
  assert.match(wizard, /settingsStore\.saveSettings\(\{[\s\S]*?country: countryCode\.value,[\s\S]*?currency: mainCurrencyCode\.value/)
  assert.doesNotMatch(stepOne, /Omitir/, 'the region step must not offer a skip')
})

test('the currency step confirms the cap currency from a selector prefilled with the main currency and offers no skip', () => {
  const stepTwo = wizard.match(/v-else-if="step === 'currency'"[\s\S]*?v-else-if/)?.[0] ?? ''
  assert.ok(stepTwo, 'currency step markup must exist')
  assert.match(stepTwo, /<select[^>]*v-model="currencyCode"/)
  assert.match(wizard, /currencyCode\.value = defaultCurrencyCode\(mainCurrencyCode\.value\)/)
  assert.match(wizard, /goalsStore\.confirmLegacyCategoryBudgetCurrency\(currencyCode\.value\)/)
  assert.doesNotMatch(stepTwo, /Omitir/, 'unconfirmed workspaces must still decide the currency (P0 integrity)')
})

test('the push step offers optional push for this device and can be skipped; the counter shows only the steps still needed', () => {
  assert.match(wizard, /enablePush\(/)
  assert.match(wizard, /getPushStatus\(/)
  assert.match(wizard, /Omitir por ahora/)
  assert.match(wizard, /Configuración/)
  assert.match(wizard, /Paso \{\{ stepNumber \}\} de \{\{ steps\.length \}\}/)
})

test('without a saved country the region step proposes that country currency instead of the signup default', () => {
  assert.match(wizard, /settingsStore\.countryConfigured\s*\?\s*defaultCurrencyCode\(settingsStore\.currency\)\s*:\s*currencyForCountry\(settingsStore\.country\)/)
})

// Render the real wizard over fake stores (no browser, no Firebase).
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
const body = new ViewNode('body')
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
  querySelector: selector => selector === 'body' ? body : null,
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text; node.children = [] },
  patchProp(node, key, _previous, next) { node.props[key] = next }
})

const requireModule = createRequire(import.meta.url)
const noOp = () => {}
const { descriptor } = parse(wizard, { filename: 'OnboardingWizard.vue' })
const wizardScript = ts.transpile(compileScript(descriptor, { id: 'OnboardingWizard.vue', inlineTemplate: true }).content, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
})
// v-model on a select only needs its bound value here.
const recordValue = (node: ViewNode, { value }: { value: unknown }) => { node.props.value = value }

const tick = () => new Promise(setImmediate)

interface WizardSetup {
  // In-memory workspace documents, read with a delay by the real budget-settings loader and adapter.
  docs: Record<string, Record<string, unknown>>
  countryConfigured?: boolean
  currency?: string
  settingsLoading?: boolean
  accounts?: number // accounts in every workspace (default 1)
  accountsFetch?: 'fast' | 'deferred' | 'fails'
}

const mountWizard = async (t: TestContext, setup: WizardSetup) => {
  const authStore = Vue.reactive({ user: { uid: 'user-a' }, activeWorkspaceId: null as string | null })
  const { docs } = setup
  const saved: Record<string, unknown>[] = []
  const confirmations: string[] = []
  const pushes: unknown[] = []
  const tracked: unknown[][] = []
  const slowRead = async <T>(value: () => T) => { await tick(); await tick(); return value() }
  const getCurrentContext = () => authStore.activeWorkspaceId ? { userId: 'user-a', workspaceId: authStore.activeWorkspaceId } : null
  const state = Vue.reactive({
    goals: [], budgetIncome: 0, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20, budgetAllocations: {},
    categoryBudgets: {}, exchangeRates: {}, exchangeRatesBaseCurrency: null, operatingBudgets: [],
    categoryBudgetCurrency: { status: 'unconfirmed' }, budgetSettingsContextKey: null, budgetSettingsLoading: false,
    budgetSettingsError: null, budgetSettingsLoadVersion: 0, budgetAlertsEnabled: true, loading: false
  }) as Parameters<typeof createGoalsBudgetActions>[0]
  const runLegacyWorkspaceTransaction = (async (context, callback) => {
    await tick()
    return callback({ ...docs[context.workspaceId] }, patch => {
      confirmations.push(`${context.workspaceId}:${patch.categoryBudgetCurrency}`)
      Object.assign(docs[context.workspaceId], patch)
    })
  }) as BudgetWorkspaceAdapterDependencies['runLegacyWorkspaceTransaction']
  const actions = createGoalsBudgetActions(state, {
    getCurrentContext,
    readWorkspaceSettings: id => slowRead(() => docs[id] ? { ...docs[id] } : null),
    createWorkspaceAdapter: () => createBudgetWorkspaceAdapter({
      getCurrentContext,
      readWorkspace: id => slowRead(() => docs[id] ? { ...docs[id] } : null),
      createBudgetPersistence: () => ({ list: async () => [] }),
      createBudgetCategoryCapsPersistence: () => ({ list: async () => ({}) }),
      runLegacyWorkspaceTransaction
    })
  } as GoalsBudgetManagementDependencies)
  const goalsStore = Object.assign(state, {
    loadBudgetSettings: actions.loadBudgetSettings,
    confirmLegacyCategoryBudgetCurrency: actions.confirmLegacyCategoryBudgetCurrency
  })
  const settingsStore = Vue.reactive({
    country: 'CO', countryConfigured: setup.countryConfigured ?? false, currency: setup.currency ?? 'USD',
    loading: setup.settingsLoading ?? false, aiEnabled: true, useCustomKey: false,
    async saveSettings(values: { country: string; currency: string }) {
      saved.push(values)
      Object.assign(this, { country: values.country, currency: values.currency, countryConfigured: true })
    }
  })
  let releaseAccounts = () => {}
  const accountsGate = setup.accountsFetch === 'deferred' ? new Promise<void>(resolve => { releaseAccounts = resolve }) : null
  const accountsStore = Vue.reactive({
    accounts: Array.from({ length: setup.accounts ?? 1 }, (_, index) => ({ id: `account-${index}` })),
    loadedWorkspaceId: null as string | null,
    fetches: 0,
    async fetchAccounts() {
      const workspaceId = authStore.activeWorkspaceId
      this.fetches++
      await (accountsGate ?? tick())
      if (setup.accountsFetch === 'fails' || workspaceId !== authStore.activeWorkspaceId) return false
      this.loadedWorkspaceId = workspaceId
      return true
    }
  })
  const stores: Record<string, unknown> = { authStore, settingsStore, goalsStore, accountsStore }
  const component = {} as { default: Vue.Component }
  new Function('exports', 'require', wizardScript)(component, (id: string) => {
    if (id === 'vue') return { ...Vue, vModelSelect: { mounted: recordValue, updated: recordValue } }
    if (id === 'vue-router') return { useRouter: () => ({ push: async (to: unknown) => { pushes.push(to) } }) }
    if (id === '@/lib/analytics') return { track: (...args: unknown[]) => { tracked.push(args) } }
    if (id === '@/lib/push') return { enablePush: async () => 'enabled', getPushStatus: async () => 'disabled' }
    if (id === '@/components/ui/useBodyScrollLock') return { useBodyScrollLock: noOp }
    if (id.startsWith('@/stores/')) {
      const name = id.slice('@/stores/'.length)
      assert.ok(name in stores, `unexpected store ${name}`)
      return { [`use${name[0].toUpperCase()}${name.slice(1)}`]: () => stores[name] }
    }
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const root = new ViewNode('root')
  const app = renderer.createApp(component.default)
  t.after(() => { app.unmount(); body.children = [] })
  app.mount(root)
  const dialog = () => body.descendants.find(node => node.props.role === 'dialog') ?? null
  const header = () => dialog()?.descendants.find(node => node.tag === 'header')?.content ?? ''
  // Every header shown while the wizard is open, sampled on each turn of the event loop.
  const seen: string[] = []
  const sample = async (turns = 12) => {
    for (let turn = 0; turn < turns; turn++) {
      await tick()
      if (dialog()) seen.push(`${authStore.activeWorkspaceId}: ${header()}`)
    }
  }
  // Like activateWorkspace (src/composables/useWorkspaceActivation.ts): switch, then reload (the wizard also loads on the context change).
  const activate = async (workspaceId: string, appReload = true) => {
    authStore.activeWorkspaceId = workspaceId
    await tick()
    if (appReload) {
      void goalsStore.loadBudgetSettings()
      void accountsStore.fetchAccounts()
    }
    await sample()
  }
  const button = (label: string) => {
    const node = dialog()?.descendants.find(node => node.tag === 'button' && node.content === label)
    assert.ok(node, `expected a "${label}" button`)
    return node
  }
  const hasButton = (label: string) => Boolean(dialog()?.descendants.some(node => node.tag === 'button' && node.content === label))
  const select = (index: number) => dialog()!.descendants.filter(node => node.tag === 'select')[index]
  const click = async (label: string) => {
    await button(label).props.onClick()
    await sample(6)
  }
  const totals = () => [...new Set(seen.map(line => line.match(/Paso \d+ de (\d+)/)?.[1]))]
  return {
    authStore, settingsStore, goalsStore, accountsStore, docs, saved, confirmations, pushes, tracked, seen,
    dialog, header, button, hasButton, select, click, sample, activate, totals, releaseAccounts: () => releaseAccounts()
  }
}

test('S7: a new user walks region, limit currency, push and first account, with "Atrás" between shown steps', async t => {
  const ui = await mountWizard(t, { docs: { s: { currency: 'USD' } }, accounts: 0 })
  await ui.activate('s', false)
  assert.ok(ui.dialog(), 'opens for the unconfirmed sign-up workspace')
  assert.equal(ui.accountsStore.fetches, 1, 'loads the active workspace accounts to know if one is missing')
  assert.match(ui.header(), /Paso 1 de 4/)
  assert.match(ui.header(), /Tu país y moneda principal/)
  assert.equal(ui.hasButton('Atrás'), false, 'nothing to go back to on the first step')

  ui.select(0).props['onUpdate:modelValue']('MX')
  ui.select(0).props.onChange()
  await Vue.nextTick()
  await ui.click('Continuar')
  assert.deepEqual(ui.saved.map(({ country, currency }) => [country, currency]), [['MX', 'MXN']])

  assert.match(ui.header(), /Paso 2 de 4/)
  assert.match(ui.header(), /Moneda de tus límites de presupuesto/)
  assert.match(ui.dialog()!.content, /límites por categoría/, 'explains what the currency is for')
  assert.equal(ui.select(0).props.value, 'MXN', 'preselects the main currency just chosen')
  assert.equal(ui.hasButton('Omitir por ahora'), false)

  await ui.click('Atrás')
  assert.match(ui.header(), /Paso 1 de 4/)
  assert.equal(ui.select(0).props.value, 'MX', 'going back keeps the saved region')
  await ui.click('Continuar')
  await ui.click('Confirmar y continuar')
  assert.deepEqual(ui.confirmations, ['s:MXN'])
  assert.equal(ui.docs.s.categoryBudgetCurrency, 'MXN')

  assert.match(ui.header(), /Paso 3 de 4/)
  await ui.click('Omitir por ahora')
  assert.match(ui.header(), /Paso 4 de 4/)
  assert.match(ui.header(), /primera cuenta/)
  await ui.click('Atrás')
  assert.match(ui.header(), /Paso 3 de 4/)
  await ui.click('Omitir por ahora')

  await ui.click('Crear mi primera cuenta')
  assert.deepEqual(ui.pushes, [{ name: 'Accounts' }])
  assert.equal(ui.dialog(), null)
  assert.deepEqual(ui.tracked, [['onboarding_finished', { push_enabled: false }]])
  assert.deepEqual(ui.totals(), ['4'], 'the step total never changed')
})

test('S7: an existing unconfirmed workspace with a saved country starts at the limit currency, confirms once and never reopens', async t => {
  const ui = await mountWizard(t, {
    docs: { a: { currency: 'COP', categoryBudgetCurrency: 'COP' }, u: { currency: 'USD' } },
    countryConfigured: true, currency: 'COP', accounts: 2
  })
  await ui.activate('a')
  assert.deepEqual(ui.seen, [], 'a confirmed workspace does not open it')
  await ui.activate('u')
  assert.match(ui.header(), /Paso 1 de 2/)
  assert.match(ui.header(), /Moneda de tus límites de presupuesto/)
  assert.equal(ui.select(0).props.value, 'COP', 'preselects the main currency')
  assert.equal(ui.hasButton('Atrás'), false)

  await ui.click('Confirmar y continuar')
  assert.deepEqual(ui.confirmations, ['u:COP'])
  assert.match(ui.header(), /Paso 2 de 2/)

  await ui.click('Atrás')
  assert.equal(ui.select(0).props.disabled, true, 'a confirmed currency is shown, not changed')
  await ui.click('Continuar')
  assert.deepEqual(ui.confirmations, ['u:COP'], 'going back does not confirm twice')

  await ui.click('Omitir por ahora')
  assert.equal(ui.dialog(), null, 'push stays skippable and, with accounts, ends the wizard')
  assert.deepEqual(ui.saved, [], 'the saved region is not asked again')

  ui.seen.length = 0
  void ui.goalsStore.loadBudgetSettings()
  await ui.sample()
  await ui.activate('a')
  await ui.activate('u')
  assert.deepEqual(ui.seen, [], 'no reopening after finishing, after reloads or after switching back')
})

test('S7: a workspace created with its limit currency confirmed never opens the wizard, across delayed reloads and switches', async t => {
  const created = planLegacyCategoryBudgetCurrencyConfirmation({}, 'COP')
  assert.equal(created.status, 'confirmed')
  const ui = await mountWizard(t, {
    docs: { a: { currency: 'COP', categoryBudgetCurrency: 'COP' }, n: { currency: 'COP', ...created.patch } },
    countryConfigured: true, currency: 'COP', accounts: 0
  })
  await ui.activate('a')
  await ui.activate('n')
  await ui.activate('a')
  await ui.activate('n')
  void ui.goalsStore.loadBudgetSettings()
  void ui.goalsStore.loadBudgetSettings()
  await ui.sample()
  assert.deepEqual(ui.seen, [])
  assert.deepEqual(ui.goalsStore.categoryBudgetCurrency, { status: 'confirmed', code: 'COP' })
})

test('S7: the wizard waits for the workspace budget settings and the user settings; a saved country then skips the region', async t => {
  const ui = await mountWizard(t, { docs: { u: { currency: 'USD' } }, settingsLoading: true })
  ui.authStore.activeWorkspaceId = 'u'
  await tick()
  assert.equal(ui.goalsStore.budgetSettingsLoading, true)
  assert.equal(ui.dialog(), null, 'not while the budget settings load')
  await ui.sample()
  assert.equal(ui.dialog(), null, 'not while the user settings load')
  Object.assign(ui.settingsStore, { countryConfigured: true, currency: 'MXN', loading: false })
  await ui.sample()
  assert.match(ui.header(), /Paso 1 de 2/)
  assert.match(ui.header(), /Moneda de tus límites de presupuesto/)
  assert.equal(ui.select(0).props.value, 'MXN')
})

test('S7: the step total stays the same when the accounts arrive after the budget settings', async t => {
  const ui = await mountWizard(t, { docs: { u: { currency: 'USD' } }, countryConfigured: true, currency: 'COP', accounts: 0, accountsFetch: 'deferred' })
  await ui.activate('u')
  assert.equal(ui.goalsStore.budgetSettingsLoading, false)
  ui.releaseAccounts()
  await ui.sample()
  assert.match(ui.header(), /Paso 1 de 3/, 'currency, push and the first-account prompt')
  assert.deepEqual(ui.totals(), ['3'], 'never shown as "de 2" first')
  await ui.click('Confirmar y continuar')
  await ui.click('Omitir por ahora')
  assert.match(ui.header(), /Paso 3 de 3/)
  assert.match(ui.header(), /primera cuenta/)
})

test('S7: a failed accounts check never keeps an unconfirmed workspace from deciding its limit currency', async t => {
  const ui = await mountWizard(t, { docs: { u: { currency: 'USD' } }, countryConfigured: true, currency: 'COP', accounts: 0, accountsFetch: 'fails' })
  await ui.activate('u')
  assert.match(ui.header(), /Paso 1 de 2/)
  assert.match(ui.header(), /Moneda de tus límites de presupuesto/)
  assert.deepEqual(ui.totals(), ['2'], 'without a known account list there is no first-account prompt')
})
