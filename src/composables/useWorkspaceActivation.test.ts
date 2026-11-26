import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'

const requireModule = createRequire(import.meta.url)
const transpile = (path: string) => ts.transpile(
  readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)
const resolveLocal = (id: string) => requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
const noOp = () => {}
const tick = () => new Promise(setImmediate)

// The real activation over the real auth store (recording Firestore) and slow workspace-scoped stores
// that log which workspace was active when each reload started and ended.
const loadActivation = (t: TestContext, signedIn = true) => {
  const log: string[] = []
  let authStore: { activeWorkspaceId: string | null } | null = null
  const slow = (name: string) => async () => {
    const workspaceId = authStore?.activeWorkspaceId
    log.push(`start ${name}@${workspaceId}`)
    await tick()
    await tick()
    log.push(`end ${name}@${workspaceId}`)
  }
  const authModule = {} as typeof import('../stores/authStore.ts')
  new Function('exports', 'require', transpile('../stores/authStore.ts'))(authModule, (id: string) => {
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
    return resolveLocal(id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const store = authModule.useAuthStore(pinia)
  if (signedIn) {
    store.user = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana' }
    store.profile = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana', currency: 'COP', createdAt: new Date(), activeWorkspaceId: 'personal' }
  }
  store.activeWorkspaceId = 'personal'
  authStore = store

  const activation = {} as typeof import('./useWorkspaceActivation.ts')
  new Function('exports', 'require', transpile('./useWorkspaceActivation.ts'))(activation, (id: string) => {
    if (id === '@/stores/authStore') return { useAuthStore: () => store }
    if (id === '@/stores/accountsStore') return { useAccountsStore: () => ({ fetchAccounts: slow('accounts') }) }
    if (id === '@/stores/transactionsStore') return {
      useTransactionsStore: () => ({ fetchTransactions: slow('transactions'), fetchCategories: slow('categories') })
    }
    if (id === '@/stores/goalsStore') return { useGoalsStore: () => ({ fetchGoals: slow('goals'), loadBudgetSettings: slow('budgetSettings') }) }
    assert.fail(`unexpected import ${id}`)
  })
  return { activateWorkspace: activation.activateWorkspace, store, log }
}

test('S8.3: activating a workspace switches to it, then reloads every workspace-scoped store for it', async t => {
  const { activateWorkspace, store, log } = loadActivation(t)
  await activateWorkspace('hogar')
  assert.equal(store.activeWorkspaceId, 'hogar')
  assert.equal(store.profile?.activeWorkspaceId, 'hogar')
  assert.deepEqual(log.filter(line => line.startsWith('profile write')), ['profile write users/user-a {"activeWorkspaceId":"hogar"}'])
  const reloads = log.filter(line => line.startsWith('start ')).map(line => line.slice('start '.length))
  assert.deepEqual(reloads.map(entry => entry.split('@')[0]).sort(), ['accounts', 'budgetSettings', 'categories', 'goals', 'transactions'])
  assert.ok(reloads.every(entry => entry.endsWith('@hogar')), 'every reload reads the new workspace')
})

test('S8.3: activation keeps its sequence: profile write, then the five reloads for the new workspace, all awaited', async t => {
  const { activateWorkspace, log } = loadActivation(t)
  await activateWorkspace('hogar')
  log.push('activated')
  const reloads = ['accounts', 'transactions', 'goals', 'budgetSettings', 'categories']
  assert.deepEqual(log, [
    'profile write users/user-a {"activeWorkspaceId":"hogar"}',
    'profile written',
    ...reloads.map(name => `start ${name}@hogar`),
    ...reloads.map(name => `end ${name}@hogar`),
    'activated'
  ])
})

test('S8.3: without a signed-in user, activation neither switches nor reloads', async t => {
  const { activateWorkspace, store, log } = loadActivation(t, false)
  await activateWorkspace('hogar')
  assert.deepEqual(log, [])
  assert.equal(store.activeWorkspaceId, 'personal')
})
