import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId } from '../../src/lib/budgets.ts'
import { parseDateOnly } from '../../src/lib/dates.ts'
import { roundMoney } from '../../src/lib/money.ts'
import { planTransferDirection, resolveStatementImportId } from '../../src/lib/statementImport.ts'
import { StatementImportBatchSchema } from '../../src/schemas.ts'

const storeSource = readFileSync(new URL('../../src/stores/transactionsStore.ts', import.meta.url), 'utf8')
const sourceFile = ts.createSourceFile(
  'transactionsStore.ts',
  storeSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

const producerMethods: ts.MethodDeclaration[] = []
const collectProducerMethods = (node: ts.Node) => {
  if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === 'addTransactionsBatch') {
    producerMethods.push(node)
  }
  ts.forEachChild(node, collectProducerMethods)
}
collectProducerMethods(sourceFile)
assert.equal(producerMethods.length, 1, 'transactionsStore must define one addTransactionsBatch producer')

const producerJavaScript = ts.transpile(`({ ${producerMethods[0]!.getText(sourceFile)} }).addTransactionsBatch`, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.None
})

const testDatabase = { kind: 'isolated-test-db' }
const transactionCollection = { kind: 'transactions-collection' }
const transactionReference = { id: 'imported-expense-1' }

const instantiateProducer = (dependencies: Record<string, unknown>) => {
  const names = Object.keys(dependencies)
  const values = Object.values(dependencies)
  const createProducer = new Function(...names, `return ${producerJavaScript}`) as (...args: unknown[]) => Function
  return createProducer(...values)
}

test('the actual batch import producer persists unassigned expenses to the default monthly budget', async () => {
  const writes: Record<string, unknown>[] = []
  let updatedAccountBalance: number | null = null
  const account = { id: 'account-1', workspaceId: 'workspace-1', currency: 'COP', balance: 500, type: 'checking' }
  const accountRef = { kind: 'account-ref', id: 'account-1' }
  const txRef = { kind: 'tx-ref', id: 'imported-expense-1' }

  const transaction = {
    get: async (ref: unknown) => {
      assert.equal(ref, accountRef)
      return { exists: () => true, data: () => account }
    },
    set: (ref: unknown, payload: Record<string, unknown>) => {
      assert.equal(ref, txRef)
      writes.push(payload)
    },
    update: (ref: unknown, patch: { balance: number }) => {
      assert.equal(ref, accountRef)
      updatedAccountBalance = patch.balance
    }
  }

  const accountsStore = {
    accounts: [account],
    getAccountById: (accountId: string) => accountId === account.id ? account : undefined,
    fetchAccounts: async () => undefined
  }
  const producer = instantiateProducer({
    auth: { currentUser: { uid: 'user-1' } },
    useAuthStore: () => ({ activeWorkspaceId: 'workspace-1' }),
    useAccountsStore: () => accountsStore,
    StatementImportBatchSchema,
    movementAccountIsPocketRelated: () => false,
    importContextIsCurrent: () => true,
    ImportMustUsePocketCallable: class ImportMustUsePocketCallable extends Error {},
    db: testDatabase,
    runTransaction: async (database: unknown, fn: (tx: typeof transaction) => Promise<number>) => {
      assert.equal(database, testDatabase)
      return fn(transaction)
    },
    collection: (database: unknown, name: string) => {
      assert.equal(database, testDatabase)
      assert.equal(name, 'transactions')
      return transactionCollection
    },
    doc: (first: unknown, second?: string, third?: string) => {
      if (first === transactionCollection) return transactionReference
      if (first === testDatabase && second === 'accounts' && third === 'account-1') return accountRef
      if (first === testDatabase && second === 'transactions' && third === 'imported-expense-1') return txRef
      throw new Error('Unexpected doc() call')
    },
    Timestamp: { fromDate: (date: Date) => date },
    parseDateOnly,
    roundMoney,
    planTransferDirection,
    resolveStatementImportId
  })
  const store = {
    categories: [{ id: 'food', name: 'Food', workspaceId: null }],
    transactions: [],
    loading: false,
    sortTransactions: () => undefined
  }

  await producer.call(store, 'account-1', [{
    date: '2025-01-05',
    description: 'Groceries',
    amount: -42,
    categorySuggestion: 'Food'
  }])

  assert.equal(updatedAccountBalance, 458)
  assert.equal(writes.length, 1, 'one imported expense should be written in the transaction')
  const payload = writes[0]!
  assert.equal(payload.type, 'expense')
  const savedDate = payload.date as Date
  assert.deepEqual([savedDate.getFullYear(), savedDate.getMonth(), savedDate.getDate()], [2025, 0, 5],
    'a date-only statement row must stay on its local calendar day')
  assert.equal(Object.hasOwn(payload, 'budgetId'), false)
  assert.equal(resolveBudgetId(payload.budgetId as string | null | undefined), DEFAULT_MONTHLY_BUDGET_ID)
})

test('S11: keyed statement transfers use the receipt callable and replay without stale Pinia state', async () => {
  const accountsList = [
    { id: 'visa', workspaceId: 'workspace-1', currency: 'COP', balance: -1_000_000, type: 'credit' },
    { id: 'bank', workspaceId: 'workspace-1', currency: 'COP', balance: 3_000_000, type: 'checking' }
  ]
  const accountsStore = {
    accounts: accountsList,
    getAccountById: (accountId: string) => accountsList.find(account => account.id === accountId),
    fetchAccounts: async () => undefined
  }
  const requestPayloads: Record<string, unknown>[] = []
  const createdAt = '2026-10-12T12:00:00.000Z'
  const importedTransaction = {
    id: 'receipt-transfer',
    date: '2026-10-12T12:00:00.000Z',
    amount: 1_000_000,
    type: 'transfer',
    accountId: 'bank',
    toAccountId: 'visa',
    categoryId: '',
    description: 'ABONO PSE',
    currency: 'COP',
    createdAt,
    userId: 'user-1'
  }
  const baseResult = {
    accountId: 'visa',
    balance: 0,
    balances: { visa: 0, bank: 2_000_000 },
    createdAt,
    transactionIds: ['receipt-transfer'],
    transactions: [importedTransaction]
  }
  let calls = 0
  const producer = instantiateProducer({
    auth: { currentUser: { uid: 'user-1' } },
    useAuthStore: () => ({ activeWorkspaceId: 'workspace-1' }),
    useAccountsStore: () => accountsStore,
    StatementImportBatchSchema,
    movementAccountIsPocketRelated: () => false,
    importContextIsCurrent: () => true,
    ImportMustUsePocketCallable: class ImportMustUsePocketCallable extends Error {},
    functions: { kind: 'functions' },
    httpsCallable: (_functions: unknown, name: string) => {
      assert.equal(name, 'importPocketStatement')
      return async (data: Record<string, unknown>) => {
        requestPayloads.push(data)
        calls += 1
        return { data: calls === 1 ? baseResult : { ...baseResult, replayed: true } }
      }
    },
    db: testDatabase,
    runTransaction: async () => { throw new Error('keyed imports must not use the client transaction path') },
    collection: (_database: unknown, name: string) => ({ collection: name }),
    doc: (first: unknown) => {
      if (typeof first === 'object' && first !== null && 'collection' in first) return transactionReference
      throw new Error('Unexpected doc() call')
    },
    Timestamp: { fromDate: (date: Date) => date },
    parseDateOnly,
    roundMoney,
    planTransferDirection,
    resolveStatementImportId
  })
  const store = { categories: [], transactions: [] as unknown[], loading: false, sortTransactions: () => undefined }
  const rows = [{
    date: '2026-10-12',
    description: 'ABONO PSE',
    amount: 1_000_000,
    categorySuggestion: '',
    type: 'transfer' as const,
    counterpartyAccountId: 'bank'
  }]

  const firstRun = await producer.call(store, 'visa', rows, { statementImportId: 'import-key-123456' })
  assert.equal(firstRun.length, 1)
  assert.equal(requestPayloads[0]?.statementImportId, 'import-key-123456')
  assert.deepEqual(requestPayloads[0]?.rows, [{
    date: '2026-10-12',
    description: 'ABONO PSE',
    amount: 1_000_000,
    categoryId: '',
    type: 'transfer',
    counterpartyAccountId: 'bank'
  }])
  assert.equal(accountsStore.getAccountById('visa')?.balance, 0)
  assert.equal(accountsStore.getAccountById('bank')?.balance, 2_000_000)
  assert.equal((store.transactions[0] as { accountId: string }).accountId, 'bank')
  assert.equal((store.transactions[0] as { toAccountId: string }).toAccountId, 'visa')

  const retryRun = await producer.call(store, 'visa', rows, { statementImportId: 'import-key-123456' })
  assert.equal(retryRun.length, 0)
  assert.equal(accountsStore.getAccountById('visa')?.balance, 0)
  assert.equal(accountsStore.getAccountById('bank')?.balance, 2_000_000)
  assert.equal(store.transactions.length, 1)
})
