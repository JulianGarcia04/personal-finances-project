import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'

const requireModule = createRequire(import.meta.url)
const storeScript = ts.transpile(
  readFileSync(new URL('./accountsStore.ts', import.meta.url), 'utf8'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)

type StoredAccount = Record<string, unknown>
// An accounts read that waits until the test answers it with rows keyed by document id, or fails it.
type PendingRead = { workspaceId: unknown; answer(rows: Record<string, StoredAccount>): void; fail(): void }
const flush = () => new Promise(resolve => setImmediate(resolve))

// Loads the real store with Firestore and the auth store replaced by fakes, so loads for
// different workspaces can resolve in any order.
const loadStore = (t: TestContext) => {
  const authStore = { activeWorkspaceId: 'ws-1' as string | null }
  const auth = { currentUser: { uid: 'user-1' } as { uid: string } | null }
  const reads: PendingRead[] = []
  const firestore = {
    collection: (_db: unknown, name: string) => ({ name }),
    where: (field: string, _operator: string, value: unknown) => ({ field, value }),
    query: (ref: { name: string }, ...constraints: Array<{ field: string; value: unknown }>) => {
      assert.equal(ref.name, 'accounts')
      return { workspaceId: constraints.find(constraint => constraint.field === 'workspaceId')?.value }
    },
    getDocs: (q: { workspaceId: unknown }) => new Promise((resolve, reject) => {
      reads.push({
        ...q,
        answer: rows => resolve({
          forEach: (callback: (snap: { id: string; data(): StoredAccount }) => void) =>
            Object.entries(rows).forEach(([id, data]) => callback({ id, data: () => ({ ...data }) }))
        }),
        fail: () => reject(new Error('unavailable'))
      })
    })
  }
  const storeModule = {} as typeof import('./accountsStore.ts')
  new Function('exports', 'require', storeScript)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth }
    if (id === '@/stores/authStore') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return firestore
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  return { store: storeModule.useAccountsStore(pinia), authStore, auth, reads }
}

const storedAccount = (workspaceId: string, name: string, extra: StoredAccount = {}): StoredAccount => ({
  workspaceId, userId: 'user-1', name, type: 'checking', balance: 1000, limit: 0, currency: 'COP',
  createdAt: new Date(2026, 0, 2), ...extra
})
const accountRows = (workspaceId: string, name: string) => ({ [`${workspaceId}-${name}`]: storedAccount(workspaceId, name) })
const shown = (store: ReturnType<typeof loadStore>['store']) => store.accounts.map(account => `${account.workspaceId}:${account.name}`)

test('S8.2: a slow fetchAccounts for the previous workspace that resolves after the switch leaves the new workspace accounts', async t => {
  const { store, authStore, reads } = loadStore(t)
  const previous = store.fetchAccounts()
  authStore.activeWorkspaceId = 'ws-2'
  const current = store.fetchAccounts()
  assert.deepEqual(reads.map(read => read.workspaceId), ['ws-1', 'ws-2'])

  reads[1].answer(accountRows('ws-2', 'B'))
  assert.equal(await current, true)
  reads[0].answer(accountRows('ws-1', 'A'))
  assert.equal(await previous, false, 'the late load reports that it replaced nothing')

  assert.deepEqual(shown(store), ['ws-2:B'])
  assert.equal(store.loadedWorkspaceId, 'ws-2')
  assert.equal(store.loading, false)
})

test('S8.2: after switching away and back, only the newest fetchAccounts shows accounts and ends loading', async t => {
  const { store, authStore, reads } = loadStore(t)
  const older = store.fetchAccounts()
  let olderResult: boolean | undefined
  void older.then(result => { olderResult = result })
  authStore.activeWorkspaceId = 'ws-2'
  const other = store.fetchAccounts()
  authStore.activeWorkspaceId = 'ws-1'
  const newest = store.fetchAccounts()

  reads[0].answer(accountRows('ws-1', 'older'))
  await flush()
  assert.equal(olderResult, undefined, 'a superseded load of the same workspace waits for the newest one')
  assert.deepEqual(shown(store), [], 'a superseded load of the same workspace changes nothing')
  assert.equal(store.loadedWorkspaceId, null)
  assert.equal(store.loading, true, 'the newest load is still running')
  reads[1].answer(accountRows('ws-2', 'B'))
  assert.equal(await other, false, 'a load for another workspace reports that it replaced nothing')
  assert.deepEqual(shown(store), [], 'the other workspace load changes nothing')
  assert.equal(store.loading, true, 'the newest load is still running')
  reads[2].answer(accountRows('ws-1', 'newest'))
  assert.equal(await newest, true)
  assert.equal(await older, true, 'the superseded load answers with the newest load of its workspace')
  assert.deepEqual(shown(store), ['ws-1:newest'])
  assert.equal(store.loadedWorkspaceId, 'ws-1')
  assert.equal(store.loading, false)
})

test('S8.2: a normal fetchAccounts load shows the workspace accounts as before and reports the replacement', async t => {
  const { store, reads } = loadStore(t)
  const loading = store.fetchAccounts()
  assert.equal(store.loading, true)
  assert.deepEqual(reads.map(read => read.workspaceId), ['ws-1'])

  const createdAt = new Date(2026, 1, 3)
  const stored = {
    bank: storedAccount('ws-1', 'Banco', { createdAt: { toDate: () => createdAt } }),
    card: storedAccount('ws-1', 'Visa', { type: 'credit', balance: -200, limit: 5000, statementClosingDay: 20, paymentDueDay: 5 })
  }
  reads[0].answer(stored)

  assert.equal(await loading, true)
  assert.deepEqual(store.accounts, [
    { id: 'bank', ...stored.bank, createdAt },
    { id: 'card', ...stored.card, createdAt: new Date(2026, 0, 2) }
  ])
  assert.equal(store.loadedWorkspaceId, 'ws-1')
  assert.equal(store.loading, false)
})

// Callers that read fetchAccounts' answer: OnboardingWizard.vue (first-account step) and
// assertAccountsStillExist / Transactions.vue openEditModal (deleted-account refusal).
test('S8.2: the onboarding check overtaken by newer loads of the same workspace still sees an empty workspace', async t => {
  const { store, authStore, reads } = loadStore(t)
  const first = store.fetchAccounts()
  reads[0].answer(accountRows('ws-1', 'A'))
  await first
  authStore.activeWorkspaceId = 'ws-2'
  const activation = store.fetchAccounts()
  // OnboardingWizard: its steps are fixed when its own check ends.
  let atWizardEnd = ''
  const wizard = store.fetchAccounts().catch(() => false).then(() => {
    const workspaceId = authStore.activeWorkspaceId
    const hasNoAccounts = workspaceId !== null && store.loadedWorkspaceId === workspaceId && store.accounts.length === 0
    atWizardEnd = hasNoAccounts ? 'first-account step' : 'no first-account step'
  })
  const dashboard = store.fetchAccounts()

  reads[1].answer({})
  reads[2].answer({})
  await flush()
  assert.equal(atWizardEnd, '', 'the wizard check waits for the newest load of its workspace')
  reads[3].answer({})
  const [activated, , dashboardLoaded] = await Promise.all([activation, wizard, dashboard])

  assert.equal(atWizardEnd, 'first-account step')
  assert.deepEqual([activated, dashboardLoaded], [true, true])
  assert.equal(store.loadedWorkspaceId, 'ws-2')
})

test('S8.2: the deleted-account refresh overlapping another load of the same workspace still refuses', async t => {
  for (const order of [[1, 2], [2, 1]]) {
    const { store, reads } = loadStore(t)
    const first = store.fetchAccounts()
    reads[0].answer(accountRows('ws-1', 'bank'))
    await first
    const referencesDeleted = () => !store.accounts.some(account => account.id === 'gone')
    const check = store.fetchAccounts()
    const other = store.fetchAccounts()

    for (const index of order) {
      reads[index].answer(accountRows('ws-1', 'bank'))
      await flush()
    }
    const refreshed = await check
    assert.equal(refreshed && referencesDeleted(), true, `refuses with the deleted-account message (reads ${order})`)
    assert.equal(await other, true)
  }
})

test('S8.2: a fetchAccounts that ends after logout, or after another user signs in, shows nothing and ends loading', async t => {
  for (const signOut of ['logout', 'other user'] as const) {
    const { store, authStore, auth, reads } = loadStore(t)
    const load = store.fetchAccounts()
    if (signOut === 'logout') {
      auth.currentUser = null
      authStore.activeWorkspaceId = null
    } else {
      auth.currentUser = { uid: 'user-2' }
    }
    reads[0].answer(accountRows('ws-1', 'A'))
    assert.equal(await load, false, signOut)
    assert.deepEqual(shown(store), [], signOut)
    assert.equal(store.loadedWorkspaceId, null, signOut)
    assert.equal(store.loading, false, signOut)
  }
})

test('S8.2 (current behavior): when the load after a switch fails, the previous accounts stay, marked as another workspace', async t => {
  t.mock.method(console, 'error', () => {})
  const { store, authStore, reads } = loadStore(t)
  const first = store.fetchAccounts()
  reads[0].answer(accountRows('ws-1', 'A'))
  await first
  authStore.activeWorkspaceId = 'ws-2'
  const failed = store.fetchAccounts()
  reads[1].fail()

  assert.equal(await failed, false)
  assert.deepEqual(shown(store), ['ws-1:A'])
  assert.equal(store.loadedWorkspaceId, 'ws-1', 'callers can tell these are not the active workspace accounts')
  assert.equal(store.loading, false)
})
