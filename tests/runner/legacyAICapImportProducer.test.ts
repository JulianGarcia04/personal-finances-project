import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId } from '../../src/lib/budgets.ts'

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
  let commitCount = 0
  const batch = {
    set: (_reference: unknown, payload: Record<string, unknown>) => writes.push(payload),
    commit: async () => { commitCount += 1 }
  }
  const account = { id: 'account-1', currency: 'COP' }
  const accountsStore = {
    getAccountById: (accountId: string) => accountId === account.id ? account : undefined,
    updateAccountBalance: async () => undefined
  }
  const producer = instantiateProducer({
    auth: { currentUser: { uid: 'user-1' } },
    useAuthStore: () => ({ activeWorkspaceId: 'workspace-1' }),
    useAccountsStore: () => accountsStore,
    db: testDatabase,
    writeBatch: (database: unknown) => {
      assert.equal(database, testDatabase)
      return batch
    },
    collection: (database: unknown, name: string) => {
      assert.equal(database, testDatabase)
      assert.equal(name, 'transactions')
      return transactionCollection
    },
    doc: (collection: unknown) => {
      assert.equal(collection, transactionCollection)
      return transactionReference
    },
    Timestamp: { fromDate: (date: Date) => date },
    normalizeTransactionAmount: (amount: number, type: string) =>
      type === 'expense' ? -Math.abs(amount) : Math.abs(amount)
  })
  const store = {
    categories: [{ id: 'food', name: 'Food' }],
    transactions: [],
    loading: false
  }

  await producer.call(store, 'account-1', [{
    date: '2025-01-05',
    description: 'Groceries',
    amount: -42,
    categorySuggestion: 'Food'
  }])

  assert.equal(commitCount, 1, 'the captured import write must be committed')
  assert.equal(writes.length, 1, 'one imported expense should be sent to the batch')
  const payload = writes[0]!
  assert.equal(payload.type, 'expense')
  assert.equal(Object.hasOwn(payload, 'budgetId'), false)
  assert.equal(resolveBudgetId(payload.budgetId as string | null | undefined), DEFAULT_MONTHLY_BUDGET_ID)
})
