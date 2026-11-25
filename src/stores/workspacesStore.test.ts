import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import type { Workspace } from '../types.ts'
import { planLegacyCategoryBudgetCurrencyConfirmation } from '../lib/budgetWorkspaceAdapter.ts'
import { SUPPORTED_CURRENCIES, defaultCurrencyCode } from '../lib/currencies.ts'

// The retired per-device preference must be ignored: every browser storage access is recorded.
const storageCalls: unknown[][] = []
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key: string) { storageCalls.push(['getItem', key]); return key === 'vault.budgets.basis' ? 'payment' : null },
    setItem(key: string, value: string) { storageCalls.push(['setItem', key, value]) },
    removeItem(key: string) { storageCalls.push(['removeItem', key]) }
  }
})

const requireModule = createRequire(import.meta.url)
const storeScript = ts.transpile(
  readFileSync(new URL('./workspacesStore.ts', import.meta.url), 'utf8').replaceAll('import.meta.env', '({})'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)

const workspace = (id: string, fields: Partial<Workspace> = {}): Workspace => ({
  id, name: id, ownerId: 'owner', members: ['owner', 'member'], currency: 'COP', createdAt: '2026-01-01', ...fields
})

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Loads the real store with Firestore and the auth store replaced by recording fakes.
const loadStore = (t: TestContext, uid: string, workspaces: Workspace[]) => {
  const authStore = Vue.reactive({ user: { uid }, activeWorkspaceId: workspaces[0].id })
  const db = {}
  const writes: [string, Record<string, unknown>][] = []
  let persist = async () => {}
  const storeModule = {} as typeof import('./workspacesStore.ts')
  new Function('exports', 'require', storeScript)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db, auth: { currentUser: { uid } } }
    if (id === './authStore') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return {
      doc: (client: object, collection: string, workspaceId: string) => {
        assert.equal(client, db)
        assert.equal(collection, 'workspaces')
        return workspaceId
      },
      updateDoc: async (workspaceId: string, data: Record<string, unknown>) => {
        writes.push([workspaceId, data])
        await persist()
      }
    }
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const store = storeModule.useWorkspacesStore(pinia)
  store.workspaces = workspaces
  return { store, authStore, writes, setPersistence: (next: typeof persist) => { persist = next } }
}

test('S6: the effective card basis comes from the active workspace and never from browser storage', t => {
  const { store } = loadStore(t, 'member', [workspace('workspace-a'), workspace('workspace-b')])
  assert.equal(store.activeBudgetCardBasis, 'consumption', 'a workspace without the field counts consumption')
  store.workspaces[0].budgetCardBasis = 'payment'
  assert.equal(store.activeBudgetCardBasis, 'payment')
  assert.deepEqual(storageCalls, [], 'the old browser preference is neither read nor written')
})

test('S6: an owner basis write targets only the captured workspace and updates only its cached row', async t => {
  const { store, writes, setPersistence } = loadStore(t, 'owner', [
    workspace('workspace-a', { expenseLimit: 500 }),
    workspace('workspace-b', { budgetCardBasis: 'consumption' })
  ])
  const pending = deferred()
  setPersistence(() => pending.promise)
  const save = store.updateBudgetCardBasis('workspace-a', 'payment')
  assert.equal(store.pendingBudgetCardBasisWrites.has('workspace-a'), true, 'the claim is taken before the first await')
  await assert.rejects(store.updateBudgetCardBasis('workspace-a', 'consumption'), /Ya se está guardando/)
  pending.resolve()
  await save
  assert.deepEqual(writes, [['workspace-a', { budgetCardBasis: 'payment' }]])
  assert.deepEqual(store.workspaces.map(({ id, budgetCardBasis, expenseLimit }) => ({ id, budgetCardBasis, expenseLimit })), [
    { id: 'workspace-a', budgetCardBasis: 'payment', expenseLimit: 500 },
    { id: 'workspace-b', budgetCardBasis: 'consumption', expenseLimit: undefined }
  ])
  assert.equal(store.pendingBudgetCardBasisWrites.size, 0)

  setPersistence(() => Promise.reject(new Error('Prueba: sin conexión.')))
  await assert.rejects(store.updateBudgetCardBasis('workspace-a', 'consumption'), /sin conexión/)
  assert.equal(store.workspaces[0].budgetCardBasis, 'payment', 'a failed write keeps the cached value')
  assert.equal(store.pendingBudgetCardBasisWrites.size, 0, 'a failed write releases the claim')
})

test('S6: a member cannot change the card basis and nothing is written', async t => {
  const { store, writes } = loadStore(t, 'member', [workspace('workspace-a')])
  await assert.rejects(store.updateBudgetCardBasis('workspace-a', 'payment'), /Solo el dueño/)
  assert.deepEqual(writes, [])
  assert.equal(store.workspaces[0].budgetCardBasis, undefined)
  assert.equal(store.pendingBudgetCardBasisWrites.size, 0)
})

test('S6: a delayed owner write for A does not change the basis shown after switching to B', async t => {
  const { store, authStore, writes, setPersistence } = loadStore(t, 'owner', [workspace('workspace-a'), workspace('workspace-b')])
  const pending = deferred()
  setPersistence(() => pending.promise)
  const save = store.updateBudgetCardBasis('workspace-a', 'payment')
  authStore.activeWorkspaceId = 'workspace-b'
  assert.equal(store.activeBudgetCardBasis, 'consumption')
  pending.resolve()
  await save
  assert.deepEqual(writes, [['workspace-a', { budgetCardBasis: 'payment' }]])
  assert.equal(store.activeBudgetCardBasis, 'consumption', 'B keeps its own basis')
  assert.equal(store.workspaces[1].budgetCardBasis, undefined)
  authStore.activeWorkspaceId = 'workspace-a'
  assert.equal(store.activeBudgetCardBasis, 'payment')
})

// Workspace creation with recording fakes for the new document, the profile write and the activation
// the caller passes in (src/composables/useWorkspaceActivation.ts in the app).
const loadCreationStore = (t: TestContext) => {
  const authStore = Vue.reactive({
    user: { uid: 'owner' },
    profile: { workspaces: ['personal'] } as { workspaces: string[] } | null,
    activeWorkspaceId: 'personal'
  })
  const activated: string[] = []
  const activate = async (workspaceId: string) => { activated.push(workspaceId); authStore.activeWorkspaceId = workspaceId }
  const created: [string, Record<string, unknown>][] = []
  const updated: [string, Record<string, unknown>][] = []
  const storeModule = {} as typeof import('./workspacesStore.ts')
  new Function('exports', 'require', storeScript)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth: { currentUser: { uid: 'owner' } } }
    if (id === './authStore') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return {
      collection: (_db: object, name: string) => ({ name }),
      doc: (...args: unknown[]) => args.length === 1 ? { id: 'new-ws', path: 'workspaces/new-ws' } : `${args[1]}/${args[2]}`,
      setDoc: async (ref: { path: string }, data: Record<string, unknown>) => { created.push([ref.path, data]) },
      updateDoc: async (path: string, data: Record<string, unknown>) => { updated.push([path, data]) }
    }
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const store = storeModule.useWorkspacesStore(pinia)
  store.workspaces = [workspace('personal', { ownerId: 'owner', members: ['owner'] })]
  return { store, storeModule, authStore, activate, activated, created, updated }
}

test('S7: a new workspace stores its budget-limit currency already confirmed in the creator main currency', async t => {
  for (const currency of ['COP', 'EUR']) {
    const { store, activate, activated, created, updated } = loadCreationStore(t)
    assert.equal(await store.createWorkspace('Hogar', { countryConfigured: true, currency }, activate), 'new-ws')
    const [[path, data]] = created
    assert.equal(path, 'workspaces/new-ws')
    assert.deepEqual({ ...data, createdAt: 'any' }, {
      id: 'new-ws', name: 'Hogar', ownerId: 'owner', members: ['owner'], currency, categoryBudgetCurrency: currency, createdAt: 'any'
    }, 'the main currency replaces the old USD default')
    // Read back by the onboarding/Goals confirmation rules: confirmed, so the wizard has nothing to ask.
    assert.deepEqual(planLegacyCategoryBudgetCurrencyConfirmation(data, currency), { status: 'unchanged' })
    assert.throws(() => planLegacyCategoryBudgetCurrencyConfirmation(data, currency === 'COP' ? 'USD' : 'COP'), /already confirmed/)
    // Existing behavior: listed, added to the profile and made active.
    assert.deepEqual(store.workspaces.map(w => w.id), ['personal', 'new-ws'])
    assert.deepEqual(updated, [['users/owner', { workspaces: ['personal', 'new-ws'] }]])
    assert.deepEqual(activated, ['new-ws'], 'switches through the shared activation, which reloads its data')
  }
})

test('S7: before the creator picks a main currency, a new workspace leaves the limit currency for onboarding', async t => {
  const { store, created, activate, activated } = loadCreationStore(t)
  await store.createWorkspace('Hogar', { countryConfigured: false, currency: 'USD' }, activate)
  const [[, data]] = created
  assert.equal(Object.hasOwn(data, 'categoryBudgetCurrency'), false)
  assert.equal(data.currency, 'USD', 'the profile currency (a sign-up default) is kept, never a fixed code')
  assert.deepEqual(activated, ['new-ws'])
})

test('S7: the shared creation rule writes exactly the confirmation patch onboarding writes, for every supported currency', t => {
  const { storeModule } = loadCreationStore(t)
  for (const { code } of SUPPORTED_CURRENCIES) {
    const plan = planLegacyCategoryBudgetCurrencyConfirmation({}, code)
    assert.equal(plan.status, 'confirmed', code)
    assert.deepEqual(storeModule.newWorkspaceCurrencyFields(code, 'USD'), { currency: code, ...plan.patch }, code)
  }
  assert.deepEqual(storeModule.newWorkspaceCurrencyFields(null, 'USD'), { currency: 'USD' })
})

test('S7: a stored main currency with other casing, spaces or an unknown code still creates the workspace', async t => {
  const fallback = defaultCurrencyCode(null)
  for (const [stored, expected] of [['cop', 'COP'], [' COP', 'COP'], ['eur ', 'EUR'], [' mxn ', 'MXN'], ['Peso', fallback], ['', fallback]]) {
    const { store, created, activate, activated } = loadCreationStore(t)
    assert.equal(await store.createWorkspace('Hogar', { countryConfigured: true, currency: stored }, activate), 'new-ws', JSON.stringify(stored))
    const [[, data]] = created
    assert.equal(data.currency, expected, JSON.stringify(stored))
    assert.equal(data.categoryBudgetCurrency, expected, 'normalized like the rest of the app, then confirmed')
    assert.deepEqual(planLegacyCategoryBudgetCurrencyConfirmation(data, expected), { status: 'unchanged' })
    assert.deepEqual(activated, ['new-ws'])
  }
  const { store, created, activate } = loadCreationStore(t)
  await store.createWorkspace('Hogar', { countryConfigured: false, currency: ' usd' }, activate)
  assert.deepEqual({ currency: created[0][1].currency, confirmed: Object.hasOwn(created[0][1], 'categoryBudgetCurrency') }, { currency: 'USD', confirmed: false })
})

test('S8.3: creation activates at the same point as before: after the profile write, while loading, never without a profile', async t => {
  const { store, updated } = loadCreationStore(t)
  const seen: unknown[] = []
  await store.createWorkspace('Hogar', { countryConfigured: true, currency: 'COP' }, async workspaceId => {
    seen.push([workspaceId, updated.length, store.loading])
  })
  assert.deepEqual(seen, [['new-ws', 1, true]], 'activated once, after the profile write, before loading ends')
  assert.equal(store.loading, false)

  const failing = loadCreationStore(t)
  await assert.rejects(failing.store.createWorkspace('Hogar', { countryConfigured: true, currency: 'COP' }, async () => {
    throw new Error('reload failed')
  }), /reload failed/, 'a failed activation still fails the creation')
  assert.equal(failing.store.loading, false)

  const withoutProfile = loadCreationStore(t)
  withoutProfile.authStore.profile = null
  assert.equal(await withoutProfile.store.createWorkspace('Hogar', { countryConfigured: true, currency: 'COP' }, withoutProfile.activate), 'new-ws')
  assert.deepEqual(withoutProfile.activated, [], 'no profile, no profile write and no activation')
  assert.deepEqual(withoutProfile.updated, [])
})
