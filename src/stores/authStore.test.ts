import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'

const store = readFileSync(fileURLToPath(new URL('./authStore.ts', import.meta.url)), 'utf8')

test('deleteAccount calls the server function with the confirmation word, then signs out', () => {
  const action = store.slice(store.indexOf('async deleteAccount()'))
  assert.match(action.slice(0, 700), /httpsCallable\(functions, 'deleteAccount', \{ timeout: DELETE_ACCOUNT_TIMEOUT_MS \}\)\(\{ confirmation: ACCOUNT_DELETION_CONFIRMATION \}\)/)
  assert.match(action.slice(0, 700), /await signOut\(auth\)/)
  assert.match(action.slice(0, 700), /this\.user = null/)
})

test('the client waits as long as the server function may run (540 s), not the 70 s default', () => {
  assert.match(store, /const DELETE_ACCOUNT_TIMEOUT_MS = 540_000/)
})

const requireModule = createRequire(import.meta.url)
const transpile = (path: string) => ts.transpile(
  readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('import.meta.env', '({})'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)
const resolveLocal = (id: string) => requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
const noOp = () => {}

// The real workspace store module, only for its pure creation helpers.
const workspacesModule = {} as typeof import('./workspacesStore.ts')
new Function('exports', 'require', transpile('./workspacesStore.ts'))(workspacesModule, (id: string) => {
  if (id === '@/lib/firebase') return { db: {}, auth: {} }
  if (id === './authStore') return { useAuthStore: () => { throw new Error('not used by the pure helpers') } }
  if (id === 'firebase/firestore') return {}
  return resolveLocal(id)
})

// Loads the real auth store with Firebase and the workspace-scoped stores replaced by recorders.
const loadAuthStore = (t: TestContext) => {
  const writes: [string, Record<string, unknown>][] = []
  const sets: [string, Record<string, unknown>][] = []
  const reloads: [string, string | null][] = []
  let authStore: { activeWorkspaceId: string | null } | null = null
  const reload = (name: string) => async () => { reloads.push([name, authStore?.activeWorkspaceId ?? null]) }
  const storeModule = {} as typeof import('./authStore.ts')
  new Function('exports', 'require', transpile('./authStore.ts'))(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth: {}, functions: {} }
    if (id === '@/lib/push') return { disablePush: noOp, hasPushRegistration: () => false }
    if (id === '@/lib/analytics') return { identifyUser: noOp, resetAnalytics: noOp, track: noOp }
    if (id === '@/lib/legal') return { buildLegalConsent: (method: string, at: unknown) => ({ method, at }) }
    if (id === '@/lib/accountDeletion') return { ACCOUNT_DELETION_CONFIRMATION: 'ELIMINAR' }
    if (id === 'firebase/functions') return { httpsCallable: noOp }
    if (id === 'firebase/auth') return {}
    if (id === 'firebase/firestore') return {
      collection: (_db: object, name: string) => ({ name }),
      doc: (...args: unknown[]) => args.length === 1 ? { id: 'ws-new', path: 'workspaces/ws-new' } : `${args[1]}/${args[2]}`,
      updateDoc: async (path: string, data: Record<string, unknown>) => { writes.push([path, data]) },
      serverTimestamp: () => 'server-time',
      runTransaction: async (_db: object, run: (tx: object) => Promise<unknown>) => run({
        get: async () => ({ exists: () => false }),
        set: (ref: string | { path: string }, data: Record<string, unknown>) => { sets.push([typeof ref === 'string' ? ref : ref.path, data]) }
      })
    }
    if (id === './workspacesStore') return workspacesModule
    if (id === './accountsStore') return { useAccountsStore: () => ({ fetchAccounts: reload('accounts') }) }
    if (id === './transactionsStore') return {
      useTransactionsStore: () => ({ fetchTransactions: reload('transactions'), fetchCategories: reload('categories') })
    }
    if (id === './goalsStore') return {
      useGoalsStore: () => ({ fetchGoals: reload('goals'), loadBudgetSettings: reload('budgetSettings') })
    }
    return resolveLocal(id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const instance = storeModule.useAuthStore(pinia)
  authStore = instance
  return { store: instance, writes, sets, reloads }
}

test('S7: activating a workspace switches to it, then reloads every workspace-scoped store for it', async t => {
  const { store, writes, reloads } = loadAuthStore(t)
  store.user = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana' }
  store.profile = { uid: 'user-a', email: 'ana@example.com', displayName: 'Ana', currency: 'COP', createdAt: new Date(), activeWorkspaceId: 'personal' }
  store.activeWorkspaceId = 'personal'

  await store.activateWorkspace('hogar')
  assert.equal(store.activeWorkspaceId, 'hogar')
  assert.equal(store.profile.activeWorkspaceId, 'hogar')
  assert.deepEqual(writes, [['users/user-a', { activeWorkspaceId: 'hogar' }]])
  assert.deepEqual(reloads.map(([name]) => name).sort(), ['accounts', 'budgetSettings', 'categories', 'goals', 'transactions'])
  assert.ok(reloads.every(([, workspaceId]) => workspaceId === 'hogar'), 'every reload reads the new workspace')
})

test('S7: the first workspace at sign-up goes through the shared creation rule and keeps its exact documents', async t => {
  const action = store.slice(store.indexOf('async ensureUserProfile('), store.indexOf('async resetPassword('))
  assert.match(action, /newWorkspaceCurrencyFields\(null, profileData\.currency\)/, 'sign-up uses the shared currency rule')

  const { store: authStore, sets } = loadAuthStore(t)
  assert.equal(await authStore.ensureUserProfile('user-a', 'ana@example.com', 'Ana', 'signup-checkbox'), true)
  // Serialized with key order, as they were always written; the country (and so the main currency)
  // is chosen later in onboarding, which then asks for the limit currency.
  const written = sets.map(([path, data]) => [path, JSON.stringify({
    ...data, createdAt: data.createdAt instanceof Date ? 'DATE' : typeof data.createdAt
  })])
  assert.deepEqual(written, [
    ['workspaces/ws-new', '{"id":"ws-new","name":"Personal","ownerId":"user-a","members":["user-a"],"currency":"USD","createdAt":"string"}'],
    ['users/user-a', '{"uid":"user-a","email":"ana@example.com","displayName":"Ana","currency":"USD","createdAt":"DATE",' +
      '"activeWorkspaceId":"ws-new","workspaces":["ws-new"],"legalConsent":{"method":"signup-checkbox","at":"server-time"}}']
  ])
  assert.ok(!written[0][1].includes('categoryBudgetCurrency'), 'stays unconfirmed until the user picks a main currency')
  assert.equal(authStore.activeWorkspaceId, 'ws-new')
})
