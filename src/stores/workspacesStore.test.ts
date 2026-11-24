import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import * as Vue from 'vue'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import type { Workspace } from '../types.ts'

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
