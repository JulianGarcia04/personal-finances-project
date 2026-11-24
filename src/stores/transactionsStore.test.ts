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

const timestamp = (date: Date) => ({ toDate: () => date, toMillis: () => date.getTime() })

// Loads the real store with Firestore, auth and the accounts store replaced by an in-memory fake that
// records every transaction commit (one entry per runTransaction call).
const loadStore = (t: TestContext, documents: Record<string, StoredDoc>) => {
  const uid = 'user-1'
  const authStore = { activeWorkspaceId: 'ws-1' }
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
    doc: (_db: unknown, collection: string, id: string) => ({ path: `${collection}/${id}`, id }),
    collection: (_db: unknown, name: string) => ({ name }),
    deleteField: () => DELETE_FIELD,
    increment: (by: number) => ({ increment: by }),
    Timestamp: { fromDate: timestamp },
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
    if (id === '@/lib/firebase') return { db: {}, auth: { currentUser: { uid } }, storage: {}, functions: {} }
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
  return { store, commits }
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
