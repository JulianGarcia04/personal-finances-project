import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import type { Transaction } from '../types.ts'

const requireModule = createRequire(import.meta.url)
const storeScript = ts.transpile(
  readFileSync(new URL('./transactionsStore.ts', import.meta.url), 'utf8'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)

const DELETE_FIELD = Symbol('deleteField')
type StoredDoc = Record<string, unknown>
type Write = { kind: 'update' | 'set' | 'delete'; path: string; data?: StoredDoc }
// A collection read that waits until the test answers it with rows keyed by document id, or fails it.
type PendingRead = { collection: string; workspaceId: unknown; answer(rows: Record<string, StoredDoc>): void; fail(): void }
// A batch commit that waits until the test calls done(), or fail() to reject it.
type PendingBatch = { writes: Write[]; done(): void; fail(error: Error): void }

const timestamp = (date: Date) => ({ toDate: () => date, toMillis: () => date.getTime() })
// A Firestore Timestamp instance, for reads that check `instanceof Timestamp`.
class FakeTimestamp {
  static fromDate = timestamp
  value: Date
  constructor(value: Date) { this.value = value }
  toDate() { return this.value }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

// Loads the real store with Firestore, auth and the accounts store replaced by an in-memory fake that
// records every transaction commit (one entry per runTransaction call). Collection reads and batch
// commits wait for the test, so loads for different workspaces can resolve in any order.
const loadStore = (t: TestContext, documents: Record<string, StoredDoc>) => {
  const uid = 'user-1'
  const authStore = { activeWorkspaceId: 'ws-1' as string | null }
  const auth = { currentUser: { uid } as { uid: string } | null }
  const reads: PendingRead[] = []
  const batches: PendingBatch[] = []
  let newIds = 0
  const docs = new Map(Object.entries(documents).map(([path, data]) => [path, { ...data }]))
  const accountsOf = () => [...docs.entries()]
    .filter(([path]) => path.startsWith('accounts/'))
    .map(([path, data]) => ({ ...data, id: path.slice('accounts/'.length) }))
  const accountsStore = {
    accounts: accountsOf(),
    loadedWorkspaceId: 'ws-1',
    getAccountById(id: string) { return this.accounts.find(account => account.id === id) },
    fetchAccounts: async () => true
  }
  const commits: Write[][] = []
  const firestore = {
    doc: (first: unknown, collection?: string, id?: string) => {
      if (collection !== undefined) return { path: `${collection}/${id}`, id }
      // doc(collectionRef) names a new document, like Firestore.
      const name = (first as { name: string }).name
      const newId = `${name}-new-${++newIds}`
      return { path: `${name}/${newId}`, id: newId }
    },
    collection: (_db: unknown, name: string) => ({ name }),
    query: (ref: { name: string }, ...constraints: Array<{ field?: string; value?: unknown }>) =>
      ({ collection: ref.name, workspaceId: constraints.find(constraint => constraint.field === 'workspaceId')?.value }),
    where: (field: string, _operator: string, value: unknown) => ({ field, value }),
    orderBy: () => ({}),
    getDocs: (q: { collection: string; workspaceId: unknown }) => new Promise((resolve, reject) => {
      reads.push({
        ...q,
        answer: rows => resolve({
          forEach: (callback: (snap: { id: string; data(): StoredDoc }) => void) =>
            Object.entries(rows).forEach(([id, data]) => callback({ id, data: () => ({ ...data }) }))
        }),
        fail: () => reject(new Error('unavailable'))
      })
    }),
    writeBatch: () => {
      const writes: Write[] = []
      return {
        set: (ref: { path: string }, data: StoredDoc) => { writes.push({ kind: 'set', path: ref.path, data }) },
        update: (ref: { path: string }, data: StoredDoc) => { writes.push({ kind: 'update', path: ref.path, data }) },
        commit: () => new Promise<void>((done, fail) => { batches.push({ writes, done, fail }) })
      }
    },
    deleteField: () => DELETE_FIELD,
    increment: (by: number) => ({ increment: by }),
    Timestamp: FakeTimestamp,
    runTransaction: async (_db: unknown, body: (transaction: unknown) => Promise<unknown>) => {
      const writes: Write[] = []
      const result = await body({
        get: async (ref: { path: string; id: string }) => {
          const data = docs.get(ref.path)
          return { id: ref.id, exists: () => data !== undefined, data: () => (data === undefined ? undefined : { ...data }) }
        },
        update: (ref: { path: string }, data: StoredDoc) => { writes.push({ kind: 'update', path: ref.path, data }) },
        set: (ref: { path: string }, data: StoredDoc) => { writes.push({ kind: 'set', path: ref.path, data }) },
        delete: (ref: { path: string }) => { writes.push({ kind: 'delete', path: ref.path }) }
      })
      commits.push(writes)
      return result
    }
  }
  const storeModule = {} as typeof import('./transactionsStore.ts')
  new Function('exports', 'require', storeScript)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db: {}, auth, storage: {}, functions: {} }
    if (id === './authStore') return { useAuthStore: () => authStore }
    if (id === './accountsStore') return { useAccountsStore: () => accountsStore }
    if (id === 'firebase/firestore') return firestore
    if (id === 'firebase/functions' || id === 'firebase/storage') return {}
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const store = storeModule.useTransactionsStore(pinia)
  store.transactions = [...docs.entries()]
    .filter(([path]) => path.startsWith('transactions/'))
    .map(([path, data]) => ({
      ...data,
      id: path.slice('transactions/'.length),
      date: (data.date as { toDate(): Date }).toDate()
    }) as Transaction)
  return { store, commits, authStore, auth, reads, batches }
}

const movementDate = new Date(2026, 10, 15, 12)
const bank = { workspaceId: 'ws-1', type: 'checking', currency: 'COP', balance: 1000, name: 'Banco' }
const expense = (extra: StoredDoc = {}): StoredDoc => ({
  workspaceId: 'ws-1', userId: 'user-1', accountId: 'bank', amount: -100, type: 'expense', categoryId: 'food',
  description: 'Mercado', date: timestamp(movementDate), toAccountId: null, receiptUrl: null, notes: null,
  installments: 1, currency: 'COP', createdAt: new Date(2026, 10, 15), ...extra
})
// What the edit form sends for a movement, with optional changes.
const editOf = (changes: Record<string, unknown> = {}) => ({
  accountId: 'bank', amount: -100, description: 'Mercado', categoryId: 'food', date: movementDate,
  type: 'expense' as const, toAccountId: null, receiptUrl: null, notes: null, installments: 1, ...changes
})
const transactionWrites = (commit: Write[]) => commit.filter(write => write.path.startsWith('transactions/'))

test('S7: editing the amount and choosing a budget commits both in one transaction write', async t => {
  const { store, commits } = loadStore(t, { 'accounts/bank': bank, 'transactions/tx-1': expense() })

  const updated = await store.updateTransaction('tx-1', editOf({ amount: -150, chosenBudgetId: 'viaje' }) as never)

  assert.equal(commits.length, 1, 'one runTransaction')
  const [write] = transactionWrites(commits[0])
  assert.equal(transactionWrites(commits[0]).length, 1, 'one movement write')
  assert.equal(write.data?.amount, -150)
  assert.equal(write.data?.budgetId, 'viaje')
  assert.deepEqual(commits[0].find(entry => entry.path === 'accounts/bank')?.data, { balance: 950 }, 'the balance moves in the same commit')
  assert.equal(updated.budgetId, 'viaje')
  assert.equal(store.transactions.find(tx => tx.id === 'tx-1')?.budgetId, 'viaje')
})

test('S7: a budget-only change saved with "Guardar" persists, and choosing the default removes the reference', async t => {
  const { store, commits } = loadStore(t, { 'accounts/bank': bank, 'transactions/tx-1': expense({ budgetId: 'hogar' }) })

  await store.updateTransaction('tx-1', editOf({ chosenBudgetId: 'viaje' }) as never)
  assert.equal(transactionWrites(commits[0])[0].data?.budgetId, 'viaje')
  assert.equal(commits[0].some(entry => entry.path.startsWith('accounts/')), false, 'an unchanged amount moves no balance')

  await store.updateTransaction('tx-1', editOf({ chosenBudgetId: 'default-monthly' }) as never)
  assert.equal(transactionWrites(commits[1])[0].data?.budgetId, DELETE_FIELD)
  assert.equal('budgetId' in (store.transactions.find(tx => tx.id === 'tx-1') ?? {}), false)
  assert.equal(commits.length, 2)
})

test('S7: a linked account still forces its budget and ignores the user choice', async t => {
  const { store, commits } = loadStore(t, {
    'accounts/bank': { ...bank, linkedBudgetId: 'casa' }, 'transactions/tx-1': expense({ budgetId: 'casa' })
  })

  const updated = await store.updateTransaction('tx-1', editOf({ amount: -120, chosenBudgetId: 'viaje', linkedBudgetId: 'casa' }) as never)

  assert.equal(transactionWrites(commits[0])[0].data?.budgetId, 'casa')
  assert.equal(updated.budgetId, 'casa')
})

test('S7: an edit without a budget choice writes the same fields as before and keeps the budget', async t => {
  const { store, commits } = loadStore(t, { 'accounts/bank': bank, 'transactions/tx-1': expense({ budgetId: 'hogar' }) })

  const updated = await store.updateTransaction('tx-1', editOf({ amount: -130, notes: 'Con domicilio' }) as never)

  assert.equal(commits.length, 1)
  const [write] = transactionWrites(commits[0])
  assert.deepEqual(Object.keys(write.data ?? {}).sort(), [
    'accountId', 'amount', 'categoryId', 'currency', 'date', 'description', 'installments', 'notes',
    'receiptUrl', 'toAccountId', 'type', 'userId'
  ])
  assert.equal(updated.budgetId, 'hogar')
})

const pocketDocs = (extra: StoredDoc = {}) => ({
  'accounts/parent': { workspaceId: 'ws-1', type: 'savings', currency: 'COP', balance: 1000, name: 'Ahorros', childAccountIds: ['pocket'] },
  'accounts/pocket': { workspaceId: 'ws-1', type: 'savings', currency: 'COP', balance: 500, name: 'Bolsillo', parentAccountId: 'parent', childAccountIds: [] },
  'transactions/tx-1': expense({ accountId: 'pocket', ...extra })
})

test('S7: a pocket movement edit with a budget choice is one write with its balances', async t => {
  const { store, commits } = loadStore(t, pocketDocs())

  const updated = await store.updateTransaction('tx-1', editOf({ accountId: 'pocket', amount: -150, chosenBudgetId: 'viaje' }) as never)

  assert.equal(commits.length, 1, 'one runTransaction')
  const movement = transactionWrites(commits[0])
  assert.equal(movement.length, 1)
  assert.equal(movement[0].data?.amount, -150)
  assert.equal(movement[0].data?.budgetId, 'viaje')
  assert.equal(commits[0].find(entry => entry.path === 'accounts/pocket')?.data?.balance, 450)
  assert.equal(updated.budgetId, 'viaje')
})

// The transfer leg lives in the other workspace unless a test edits it from the active one.
const sharedExpenseDocs = (extra: StoredDoc = {}, transferWorkspaceId = 'ws-2') => ({
  'accounts/bridge': {
    workspaceId: 'ws-1', type: 'checking', currency: 'COP', balance: -100, name: 'Puente',
    mirror: { workspaceId: 'ws-2', accountId: 'receivable', sourceAccountId: 'card' }
  },
  'accounts/card': { workspaceId: 'ws-2', type: 'credit', currency: 'COP', balance: -100, name: 'Tarjeta' },
  'accounts/receivable': { workspaceId: 'ws-2', type: 'checking', currency: 'COP', balance: 100, name: 'Por cobrar' },
  'transactions/leg-expense': expense({ accountId: 'bridge', mirrorOf: 'leg-transfer', ...extra }),
  'transactions/leg-transfer': expense({
    workspaceId: transferWorkspaceId, accountId: 'card', toAccountId: 'receivable', type: 'transfer', amount: 100, categoryId: '',
    mirrorOf: 'leg-expense'
  })
})

test('S7: a shared expense edit saves the chosen budget on its expense leg in the same write as both legs', async t => {
  const { store, commits } = loadStore(t, sharedExpenseDocs())

  const updated = await store.updateTransaction('leg-expense', editOf({ accountId: 'bridge', amount: -150, chosenBudgetId: 'viaje' }) as never)

  assert.equal(commits.length, 1, 'one runTransaction')
  const legs = Object.fromEntries(transactionWrites(commits[0]).map(write => [write.path, write.data]))
  assert.equal(legs['transactions/leg-expense']?.amount, -150)
  assert.equal(legs['transactions/leg-expense']?.budgetId, 'viaje')
  assert.equal(legs['transactions/leg-transfer']?.amount, 150)
  assert.equal('budgetId' in (legs['transactions/leg-transfer'] ?? {}), false, 'the transfer leg never carries a budget')
  assert.equal(updated.budgetId, 'viaje')
})

test('S7: a shared expense edit without a budget choice writes the same leg fields as before', async t => {
  const { store, commits } = loadStore(t, sharedExpenseDocs({ budgetId: 'hogar' }))

  const updated = await store.updateTransaction('leg-expense', editOf({ accountId: 'bridge', amount: -150 }) as never)

  const legs = Object.fromEntries(transactionWrites(commits[0]).map(write => [write.path, Object.keys(write.data ?? {}).sort()]))
  assert.deepEqual(legs, {
    'transactions/leg-expense': ['amount', 'categoryId', 'date', 'description', 'installments', 'notes', 'receiptUrl'],
    'transactions/leg-transfer': ['amount', 'date', 'description']
  })
  assert.equal(updated.budgetId, 'hogar')
})

const budgetOf = (write: Write | undefined) => (write?.data && 'budgetId' in write.data ? write.data.budgetId : '(no budgetId)')

test('S7: the edit decides the budget before the choice: type changes, account links and the live stored type win', async t => {
  const bank2 = { ...bank, name: 'Banco 2' }
  const transfer = expense({ type: 'transfer', amount: 100, toAccountId: 'bank2', categoryId: '' })
  for (const [name, docs, edit, expected] of [
    ['expense to income leaves the budget', { 'accounts/bank': bank, 'transactions/tx-1': expense({ budgetId: 'hogar' }) },
      editOf({ type: 'income', amount: 100, chosenBudgetId: 'viaje' }), DELETE_FIELD],
    ['expense to transfer leaves the budget', { 'accounts/bank': bank, 'accounts/bank2': bank2, 'transactions/tx-1': expense({ budgetId: 'hogar' }) },
      editOf({ type: 'transfer', amount: 100, toAccountId: 'bank2', categoryId: '', chosenBudgetId: 'viaje' }), DELETE_FIELD],
    ['transfer to expense keeps the stored state', { 'accounts/bank': bank, 'accounts/bank2': bank2, 'transactions/tx-1': transfer },
      editOf({ chosenBudgetId: 'viaje' }), '(no budgetId)'],
    ['moving into a linked account takes its budget', { 'accounts/bank': bank, 'accounts/bank2': { ...bank2, linkedBudgetId: 'casa' }, 'transactions/tx-1': expense() },
      editOf({ accountId: 'bank2', chosenBudgetId: 'viaje', linkedBudgetId: 'casa' }), 'casa']
  ] as const) {
    const { store, commits } = loadStore(t, docs)
    await store.updateTransaction('tx-1', edit as never)
    assert.equal(budgetOf(transactionWrites(commits[0])[0]), expected, name)
  }

  // The view saw an unchanged expense, but the stored movement is already income: the live type decides.
  const live = loadStore(t, { 'accounts/bank': bank, 'transactions/tx-1': expense({ type: 'income', amount: 100 }) })
  Object.assign(live.store.transactions[0], { type: 'expense', amount: -100 })
  await live.store.updateTransaction('tx-1', editOf({ chosenBudgetId: 'viaje' }) as never)
  assert.equal(budgetOf(transactionWrites(live.commits[0])[0]), DELETE_FIELD)
})

test('S7: a budget-only choice on a pocket movement or a shared expense travels in its single write', async t => {
  const pocket = loadStore(t, pocketDocs())
  await pocket.store.updateTransaction('tx-1', editOf({ accountId: 'pocket', chosenBudgetId: 'viaje' }) as never)
  assert.equal(budgetOf(transactionWrites(pocket.commits[0])[0]), 'viaje')

  const pocketDefault = loadStore(t, pocketDocs({ budgetId: 'hogar' }))
  await pocketDefault.store.updateTransaction('tx-1', editOf({ accountId: 'pocket', chosenBudgetId: 'default-monthly' }) as never)
  assert.equal(budgetOf(transactionWrites(pocketDefault.commits[0])[0]), DELETE_FIELD)

  const sharedDefault = loadStore(t, sharedExpenseDocs({ budgetId: 'hogar' }))
  await sharedDefault.store.updateTransaction('leg-expense', editOf({ accountId: 'bridge', chosenBudgetId: 'default-monthly' }) as never)
  const legs = transactionWrites(sharedDefault.commits[0])
  assert.equal(budgetOf(legs.find(write => write.path === 'transactions/leg-expense')), DELETE_FIELD)
  assert.equal(budgetOf(legs.find(write => write.path === 'transactions/leg-transfer')), '(no budgetId)')

  // Edited from the transfer leg, a choice reaches neither leg.
  const fromTransfer = loadStore(t, sharedExpenseDocs({}, 'ws-1'))
  await fromTransfer.store.updateTransaction('leg-transfer', editOf({
    accountId: 'card', toAccountId: 'receivable', type: 'transfer', amount: 150, categoryId: '', chosenBudgetId: 'viaje'
  }) as never)
  assert.equal(fromTransfer.commits.length, 1)
  assert.deepEqual(transactionWrites(fromTransfer.commits[0]).map(budgetOf), ['(no budgetId)', '(no budgetId)'])
})

test('S7: without a budget choice no edit writes a budget, for ordinary, pocket and shared movements', async t => {
  const kinds = [
    ['ordinary', (extra: StoredDoc) => ({ 'accounts/bank': bank, 'transactions/tx-1': expense(extra) }), 'tx-1', 'bank'],
    ['pocket', pocketDocs, 'tx-1', 'pocket'],
    ['shared', (extra: StoredDoc) => sharedExpenseDocs(extra), 'leg-expense', 'bridge']
  ] as const
  for (const [kind, docsOf, id, accountId] of kinds) {
    for (const stored of [{}, { budgetId: 'hogar' }]) {
      for (const noChoice of [{}, { chosenBudgetId: undefined }, { chosenBudgetId: null }]) {
        for (const change of [{ amount: -150 }, { notes: 'Con domicilio' }]) {
          const { store, commits } = loadStore(t, docsOf(stored))
          const updated = await store.updateTransaction(id, editOf({ accountId, ...change, ...noChoice }) as never)
          const label = JSON.stringify({ kind, stored, noChoice, change })
          assert.equal(commits.length, 1, label)
          assert.deepEqual(commits[0].filter(write => write.data && 'budgetId' in write.data), [], label)
          assert.equal(updated.budgetId, stored.budgetId, label)
        }
      }
    }
  }
})

// S8.2: switching workspaces while a load is still running.
const storedMovement = (workspaceId: string, description: string, extra: StoredDoc = {}): StoredDoc => ({
  workspaceId, userId: 'user-1', accountId: 'bank', amount: -100, type: 'expense', categoryId: 'food',
  description, date: timestamp(movementDate), currency: 'COP', createdAt: new Date(2026, 10, 15), ...extra
})
const storedCategory = (workspaceId: string, name: string): StoredDoc => ({
  workspaceId, name, icon: 'Tag', color: '#6b7280', type: 'expense'
})
type LoadedStore = ReturnType<typeof loadStore>['store']
const workspaceLoads = [
  {
    name: 'fetchTransactions',
    collection: 'transactions',
    start: (store: LoadedStore) => store.fetchTransactions(),
    rows: (workspaceId: string, label: string) => ({ [`${workspaceId}-${label}`]: storedMovement(workspaceId, label) }),
    shown: (store: LoadedStore) => store.transactions.map(tx => `${tx.workspaceId}:${tx.description}`)
  },
  {
    name: 'fetchCategories',
    collection: 'categories',
    start: (store: LoadedStore) => store.fetchCategories(),
    rows: (workspaceId: string, label: string) => ({ [`${workspaceId}-${label}`]: storedCategory(workspaceId, label) }),
    shown: (store: LoadedStore) => store.categories.map(category => `${category.workspaceId}:${category.name}`)
  }
]

for (const load of workspaceLoads) {
  test(`S8.2: a slow ${load.name} for the previous workspace that resolves after the switch leaves the new workspace's data`, async t => {
    const { store, authStore, reads } = loadStore(t, {})
    const previous = load.start(store)
    authStore.activeWorkspaceId = 'ws-2'
    const current = load.start(store)
    assert.deepEqual(reads.map(read => [read.collection, read.workspaceId]), [[load.collection, 'ws-1'], [load.collection, 'ws-2']])

    reads[1].answer(load.rows('ws-2', 'B'))
    await current
    reads[0].answer(load.rows('ws-1', 'A'))
    await previous

    assert.deepEqual(load.shown(store), ['ws-2:B'])
    assert.equal(store.loading, false)
  })

  test(`S8.2: after switching away and back, only the newest ${load.name} shows data and ends loading`, async t => {
    const { store, authStore, reads } = loadStore(t, {})
    const older = load.start(store)
    authStore.activeWorkspaceId = 'ws-2'
    const other = load.start(store)
    authStore.activeWorkspaceId = 'ws-1'
    const newest = load.start(store)

    reads[0].answer(load.rows('ws-1', 'older'))
    await older
    assert.deepEqual(load.shown(store), [], 'a superseded load of the same workspace changes nothing')
    assert.equal(store.loading, true, 'the newest load is still running')
    reads[1].answer(load.rows('ws-2', 'B'))
    await other
    assert.deepEqual(load.shown(store), [], 'the other workspace load changes nothing')
    assert.equal(store.loading, true, 'the newest load is still running')
    reads[2].answer(load.rows('ws-1', 'newest'))
    await newest
    assert.deepEqual(load.shown(store), ['ws-1:newest'])
    assert.equal(store.loading, false)
  })

  test(`S8.2: a ${load.name} that ends after logout, or after another user signs in, shows nothing and ends loading`, async t => {
    for (const signOut of ['logout', 'other user'] as const) {
      const { store, authStore, auth, reads, batches } = loadStore(t, {})
      const loading = load.start(store)
      if (signOut === 'logout') {
        auth.currentUser = null
        authStore.activeWorkspaceId = null
      } else {
        auth.currentUser = { uid: 'user-2' }
      }
      reads[0].answer(load.rows('ws-1', 'A'))
      await loading
      assert.deepEqual(load.shown(store), [], signOut)
      assert.equal(batches.length, 0, signOut)
      assert.equal(store.loading, false, signOut)
    }
  })

  test(`S8.2 (current behavior): when the ${load.name} after a switch fails, the previous workspace data stays`, async t => {
    t.mock.method(console, 'error', () => {})
    const { store, authStore, reads } = loadStore(t, {})
    const first = load.start(store)
    reads[0].answer(load.rows('ws-1', 'A'))
    await first
    authStore.activeWorkspaceId = 'ws-2'
    const failed = load.start(store)
    reads[1].fail()
    await failed
    assert.deepEqual(load.shown(store), ['ws-1:A'])
    assert.equal(store.loading, false)
  })
}

test('S8.2: a slow settlement check for the previous workspace leaves the new workspace reversible settlements', async t => {
  const { store, authStore, reads } = loadStore(t, {})
  let finishPrevious!: (reversible: boolean) => void
  store.canReverseSettlement = (tx: Transaction) => tx.workspaceId === 'ws-1'
    ? new Promise<boolean>(resolve => { finishPrevious = resolve })
    : Promise.resolve(true)
  const previous = store.fetchTransactions()
  reads[0].answer({ 'tx-a': storedMovement('ws-1', 'A') })
  await flush()
  assert.deepEqual(store.transactions.map(tx => tx.id), ['tx-a'], 'the movements show while the settlement check runs')

  authStore.activeWorkspaceId = 'ws-2'
  const current = store.fetchTransactions()
  reads[1].answer({ 'tx-b': storedMovement('ws-2', 'B') })
  await current
  finishPrevious(true)
  await previous

  assert.deepEqual(store.transactions.map(tx => tx.id), ['tx-b'])
  assert.deepEqual(store.reversibleSettlementIds, ['tx-b'])
  assert.equal(store.loading, false)
})

test('S8.2: an empty category list for the previous workspace read after the switch creates no categories anywhere', async t => {
  const { store, authStore, reads, batches } = loadStore(t, {})
  const previous = store.fetchCategories()
  authStore.activeWorkspaceId = 'ws-2'
  const current = store.fetchCategories()
  reads[1].answer({ 'cat-b': storedCategory('ws-2', 'B') })
  await current

  reads[0].answer({})
  await flush()
  assert.deepEqual(batches.map(batch => batch.writes[0]?.data?.workspaceId), [], 'no default categories are written for either workspace')
  await previous
  assert.deepEqual(store.categories.map(category => `${category.workspaceId}:${category.name}`), ['ws-2:B'])
  assert.equal(store.loading, false)
})

test('S8.2: default categories for a new workspace are written there and not shown after a switch during the write', async t => {
  const { store, authStore, reads, batches } = loadStore(t, {})
  const previous = store.fetchCategories()
  reads[0].answer({})
  await flush()
  assert.equal(batches.length, 1, 'the empty active workspace gets its defaults')

  authStore.activeWorkspaceId = 'ws-2'
  const current = store.fetchCategories()
  reads[1].answer({ 'cat-b': storedCategory('ws-2', 'B') })
  await current
  batches[0].done()
  await previous

  assert.equal(batches[0].writes.length, 9)
  assert.deepEqual([...new Set(batches[0].writes.map(write => write.data?.workspaceId))], ['ws-1'])
  assert.deepEqual(store.categories.map(category => `${category.workspaceId}:${category.name}`), ['ws-2:B'])
  assert.equal(store.loading, false)
})

test('S8.2: a normal fetchTransactions load shows the workspace movements and reversible settlements as before', async t => {
  const { store, reads } = loadStore(t, {})
  store.canReverseSettlement = async (tx: Transaction) => tx.id === 'tx-settled'
  const createdAt = new Date(2026, 10, 14, 9)
  const stored = {
    'tx-settled': storedMovement('ws-1', 'Liquidación', { createdAt: new FakeTimestamp(createdAt) }),
    'tx-plain': storedMovement('ws-1', 'Mercado', { notes: 'Con domicilio', budgetId: 'hogar' })
  }
  const loading = store.fetchTransactions()
  assert.equal(store.loading, true)
  assert.deepEqual(reads.map(read => [read.collection, read.workspaceId]), [['transactions', 'ws-1']])

  reads[0].answer(stored)
  await loading

  assert.deepEqual(store.transactions, [
    { id: 'tx-settled', ...stored['tx-settled'], date: movementDate, createdAt },
    { id: 'tx-plain', ...stored['tx-plain'], date: movementDate, createdAt: new Date(2026, 10, 15) }
  ])
  assert.deepEqual(store.reversibleSettlementIds, ['tx-settled'])
  assert.equal(store.loading, false)
})

test('S8.2: a normal fetchCategories load shows the workspace categories, or writes and shows the defaults of a new workspace', async t => {
  const existing = loadStore(t, {})
  const loadingExisting = existing.store.fetchCategories()
  assert.equal(existing.store.loading, true)
  assert.deepEqual(existing.reads.map(read => [read.collection, read.workspaceId]), [['categories', 'ws-1']])
  existing.reads[0].answer({ 'cat-1': storedCategory('ws-1', 'Mercado'), 'cat-2': storedCategory('ws-1', 'Arriendo') })
  await loadingExisting
  assert.deepEqual(existing.store.categories, [
    { id: 'cat-1', ...storedCategory('ws-1', 'Mercado') },
    { id: 'cat-2', ...storedCategory('ws-1', 'Arriendo') }
  ])
  assert.equal(existing.batches.length, 0)
  assert.equal(existing.store.loading, false)

  const fresh = loadStore(t, {})
  const loadingFresh = fresh.store.fetchCategories()
  fresh.reads[0].answer({})
  await flush()
  assert.equal(fresh.batches.length, 1)
  fresh.batches[0].done()
  await loadingFresh
  const [batch] = fresh.batches
  assert.deepEqual(batch.writes.map(write => write.data?.name),
    ['Comida', 'Transporte', 'Entretenimiento', 'Servicios', 'Salud', 'Educación', 'Ingresos', 'Ahorro', 'Otros'])
  assert.ok(batch.writes.every(write => write.kind === 'set' && write.path.startsWith('categories/') && write.data?.workspaceId === 'ws-1'))
  assert.deepEqual(fresh.store.categories, batch.writes.map(write => ({ id: write.path.slice('categories/'.length), ...write.data })))
  assert.equal(fresh.store.loading, false)
})

const categoriesShown = (store: LoadedStore) => store.categories.map(category => `${category.workspaceId}:${category.name}`)

test('S8.2: an empty category list for the previous workspace read before the new workspace loads creates nothing and keeps loading', async t => {
  const { store, authStore, reads, batches } = loadStore(t, {})
  const previous = store.fetchCategories()
  authStore.activeWorkspaceId = 'ws-2'
  const current = store.fetchCategories()

  reads[0].answer({})
  await previous
  assert.equal(batches.length, 0, 'no default categories are written for either workspace')
  assert.deepEqual(categoriesShown(store), [])
  assert.equal(store.loading, true, 'the new workspace load is still running')
  reads[1].answer({ 'cat-b': storedCategory('ws-2', 'B') })
  await current
  assert.deepEqual(categoriesShown(store), ['ws-2:B'])
  assert.equal(store.loading, false)
})

test('S8.2: default categories written while switching away and back are not shown over the newer list of the same workspace', async t => {
  const { store, authStore, reads, batches } = loadStore(t, {})
  const older = store.fetchCategories()
  reads[0].answer({})
  await flush()
  assert.equal(batches.length, 1, 'the empty workspace gets its defaults')
  authStore.activeWorkspaceId = 'ws-2'
  const other = store.fetchCategories()
  authStore.activeWorkspaceId = 'ws-1'
  const newest = store.fetchCategories()
  reads[2].answer({ 'cat-a': storedCategory('ws-1', 'Mascotas') })
  await newest
  assert.deepEqual(categoriesShown(store), ['ws-1:Mascotas'])

  batches[0].done()
  await older
  assert.deepEqual(categoriesShown(store), ['ws-1:Mascotas'], 'the older defaults do not replace the newer list')
  assert.equal(store.loading, false)
  reads[1].answer({ 'cat-b': storedCategory('ws-2', 'B') })
  await other
  assert.deepEqual(categoriesShown(store), ['ws-1:Mascotas'])
  assert.deepEqual([...new Set(batches[0].writes.map(write => write.data?.workspaceId))], ['ws-1'], 'the defaults are written to their workspace')
  assert.equal(store.loading, false)
})

test('S8.2: default categories written when the user logs out during the write are not shown', async t => {
  const { store, authStore, auth, reads, batches } = loadStore(t, {})
  const loading = store.fetchCategories()
  reads[0].answer({})
  await flush()
  auth.currentUser = null
  authStore.activeWorkspaceId = null
  batches[0].done()
  await loading

  assert.deepEqual([...new Set(batches[0].writes.map(write => write.data?.workspaceId))], ['ws-1'])
  assert.deepEqual(categoriesShown(store), [])
  assert.equal(store.loading, false)
})

test('S8.2: two overlapping loads of an empty workspace write its default categories once when the older read lands first', async t => {
  const { store, reads, batches } = loadStore(t, {})
  const older = store.fetchCategories()
  const newer = store.fetchCategories()
  reads[0].answer({})
  await flush()
  reads[1].answer({})
  await flush()
  assert.equal(batches.length, 1)
  batches[0].done()
  await Promise.all([older, newer])

  assert.equal(batches[0].writes.length, 9)
  assert.deepEqual(store.categories.map(category => category.id), batches[0].writes.map(write => write.path.slice('categories/'.length)))
  assert.equal(store.loading, false)
})

test('S8.2: switching while movements and categories load ends with the new workspace data in every order of the four reads', async t => {
  const orders = (items: number[]): number[][] => items.length <= 1 ? [items]
    : items.flatMap((item, index) => orders([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]))
  for (const order of orders([0, 1, 2, 3])) {
    const { store, authStore, reads } = loadStore(t, {})
    const loads = [store.fetchTransactions(), store.fetchCategories()]
    authStore.activeWorkspaceId = 'ws-2'
    loads.push(store.fetchTransactions(), store.fetchCategories())
    // Reads: 0 movements A, 1 categories A, 2 movements B, 3 categories B.
    const rows = [
      { 'tx-a': storedMovement('ws-1', 'A') }, { 'cat-a': storedCategory('ws-1', 'A') },
      { 'tx-b': storedMovement('ws-2', 'B') }, { 'cat-b': storedCategory('ws-2', 'B') }
    ]
    for (const index of order) {
      reads[index].answer(rows[index])
      await loads[index]
    }
    const label = `reads ${order}`
    assert.deepEqual(store.transactions.map(tx => tx.workspaceId), ['ws-2'], label)
    assert.deepEqual(store.categories.map(category => category.workspaceId), ['ws-2'], label)
    assert.equal(store.loading, false, label)
  }
})

// S9: budget filter and bulk category/budget edits.
const budgetRows = (): Record<string, StoredDoc> => ({
  'accounts/bank': bank,
  'accounts/bank2': { ...bank, name: 'Banco 2' },
  'transactions/absent': expense(),
  'transactions/null': expense({ budgetId: null }),
  'transactions/literal': expense({ budgetId: 'default-monthly' }),
  'transactions/income-base': expense({ type: 'income', amount: 100, categoryId: 'salary' }),
  'transactions/trip': expense({ budgetId: 'viaje' }),
  'transactions/income-trip': expense({ type: 'income', amount: 100, categoryId: 'salary', budgetId: 'viaje' }),
  'transactions/transfer': expense({ type: 'transfer', amount: 100, toAccountId: 'bank2', categoryId: '' }),
  'transactions/stray-transfer': expense({ type: 'transfer', amount: 100, toAccountId: 'bank2', categoryId: '', budgetId: 'viaje' }),
  'transactions/loan': expense({ type: 'loan', categoryId: '' })
})
const idsOf = (rows: Array<{ id: string }>) => rows.map(row => row.id).sort()

test('S9: the base monthly budget filter covers absent, null and the literal default, for expenses and income', t => {
  const { store } = loadStore(t, budgetRows())
  assert.deepEqual(idsOf(store.filteredTransactions({ budgetId: 'default-monthly' })), ['absent', 'income-base', 'literal', 'null'])
  assert.deepEqual(idsOf(store.filteredTransactions({ budgetId: 'viaje' })), ['income-trip', 'trip'])
  // Transfers and loans never match a budget filter, even with a stray stored reference.
  assert.deepEqual(idsOf(store.filteredTransactions({ budgetId: 'viaje', type: 'transfer' })), [])
  // No budget filter keeps every movement, as before.
  assert.equal(store.filteredTransactions({ budgetId: '' }).length, 9)
  assert.equal(store.filteredTransactions({}).length, 9)
})

const bulkBudgets = [{ id: 'viaje', name: 'Viaje', archived: false }]
const bulkCategories = [
  { id: 'food', workspaceId: 'ws-1', name: 'Comida', icon: 'Utensils', color: '#10b981', type: 'expense' as const },
  { id: 'transport', workspaceId: 'ws-1', name: 'Transporte', icon: 'Car', color: '#3b82f6', type: 'expense' as const }
]
const manyExpenses = (count: number): Record<string, StoredDoc> => Object.fromEntries([
  ['accounts/bank', bank],
  ...Array.from({ length: count }, (_, index) => [`transactions/bulk-${index}`, expense()])
])
// Lets every pending batch commit (or fail) in order, waiting for the store to send the next one.
const settleBatches = async (batches: PendingBatch[], outcomes: Array<'ok' | Error>) => {
  for (let index = 0; index < outcomes.length; index++) {
    for (let tries = 0; tries < 20 && batches.length <= index; tries++) await flush()
    const outcome = outcomes[index]
    if (outcome === 'ok') batches[index].done()
    else batches[index].fail(outcome)
  }
}

test('S9: a bulk edit commits one writeBatch per 500 rows that writes only categoryId and budgetId', async t => {
  const { store, batches, commits } = loadStore(t, manyExpenses(501))
  store.categories = bulkCategories
  const ids = store.transactions.map(tx => tx.id)

  const running = store.bulkEditTransactions({ categoryId: 'transport', budgetId: 'viaje' }, ids, bulkBudgets)
  await settleBatches(batches, ['ok', 'ok'])
  const outcome = await running

  assert.deepEqual(batches.map(batch => batch.writes.length), [500, 1])
  assert.equal(commits.length, 0, 'no runTransaction')
  for (const write of batches.flatMap(batch => batch.writes)) {
    assert.equal(write.kind, 'update')
    assert.match(write.path, /^transactions\/bulk-/)
    assert.deepEqual(write.data, { categoryId: 'transport', budgetId: 'viaje' })
  }
  assert.equal(outcome.written.length, 501)
  assert.deepEqual(outcome.failed, [])
  assert.ok(store.transactions.every(tx => tx.categoryId === 'transport' && tx.budgetId === 'viaje'))
  assert.ok(store.transactions.every(tx => tx.amount === -100 && tx.accountId === 'bank'), 'financial fields untouched')
})

test('S9: a bulk edit writes the base budget as null, skips rows that cannot take the change and leaves them as they were', async t => {
  const { store, batches } = loadStore(t, budgetRows())
  store.categories = bulkCategories

  const running = store.bulkEditTransactions({ budgetId: 'default-monthly' }, ['trip', 'income-trip', 'transfer', 'absent', 'loan'], bulkBudgets)
  await settleBatches(batches, ['ok'])
  const outcome = await running

  assert.deepEqual(batches[0].writes, [
    { kind: 'update', path: 'transactions/trip', data: { budgetId: null } },
    { kind: 'update', path: 'transactions/income-trip', data: { budgetId: null } }
  ])
  assert.deepEqual(outcome.plan.skipped, [
    { id: 'transfer', reason: 'no-budget-type' }, { id: 'absent', reason: 'unchanged' }, { id: 'loan', reason: 'no-budget-type' }
  ])
  assert.equal(store.transactions.find(tx => tx.id === 'trip')?.budgetId, null)
  assert.equal('budgetId' in (store.transactions.find(tx => tx.id === 'transfer') ?? {}), false)
})

test('S9: a failed chunk is reported with its rows while the other chunks still apply', async t => {
  const { store, batches } = loadStore(t, manyExpenses(501))
  store.categories = bulkCategories
  const ids = store.transactions.map(tx => tx.id)

  const running = store.bulkEditTransactions({ budgetId: 'viaje' }, ids, bulkBudgets)
  await settleBatches(batches, [new Error('permission-denied'), 'ok'])
  const outcome = await running

  assert.equal(outcome.written.length, 1)
  assert.equal(outcome.failed.length, 1)
  assert.equal(outcome.failed[0].ids.length, 500)
  assert.deepEqual(outcome.failed[0].ids, ids.slice(0, 500))
  assert.equal(store.transactions.filter(tx => tx.budgetId === 'viaje').length, 1, 'only the committed chunk changes local rows')
})

test('S9: nothing is written for an invalid request, and nothing local changes after a switch during the commit', async t => {
  const invalid = loadStore(t, budgetRows())
  invalid.store.categories = bulkCategories
  await assert.rejects(invalid.store.bulkEditTransactions({ categoryId: 'transport' }, ['absent', 'income-base'], bulkBudgets), /selecciona solo gastos o solo ingresos/)
  await assert.rejects(invalid.store.bulkEditTransactions({ budgetId: 'archivado' }, ['absent'], bulkBudgets), /ya no está disponible/)
  assert.equal(invalid.batches.length, 0)

  const switched = loadStore(t, budgetRows())
  switched.store.categories = bulkCategories
  const running = switched.store.bulkEditTransactions({ budgetId: 'viaje' }, ['absent'], bulkBudgets)
  await flush()
  switched.authStore.activeWorkspaceId = 'ws-2'
  await settleBatches(switched.batches, ['ok'])
  const outcome = await running
  assert.deepEqual(outcome.written, ['absent'])
  assert.equal('budgetId' in (switched.store.transactions.find(tx => tx.id === 'absent') ?? {}), false)

  // Another user signing in stops the remaining chunks; they are reported as failed, never sent.
  const relogged = loadStore(t, manyExpenses(501))
  relogged.store.categories = bulkCategories
  const pending = relogged.store.bulkEditTransactions({ budgetId: 'viaje' }, relogged.store.transactions.map(tx => tx.id), bulkBudgets)
  await flush()
  relogged.auth.currentUser = { uid: 'user-2' }
  await settleBatches(relogged.batches, ['ok'])
  const stopped = await pending
  assert.equal(relogged.batches.length, 1)
  assert.equal(stopped.written.length, 500)
  assert.equal(stopped.failed.length, 1)
  assert.equal(stopped.failed[0].ids.length, 1)
})
