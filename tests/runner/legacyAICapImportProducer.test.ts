import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId } from '../../src/lib/budgets.ts'
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
    Timestamp: { fromDate: (date: Date) => date }
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
  assert.equal(Object.hasOwn(payload, 'budgetId'), false)
  assert.equal(resolveBudgetId(payload.budgetId as string | null | undefined), DEFAULT_MONTHLY_BUDGET_ID)
})
