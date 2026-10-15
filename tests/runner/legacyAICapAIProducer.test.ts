import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId } from '../../src/lib/budgets.ts'

const indexSource = readFileSync(new URL('../../functions/src/index.ts', import.meta.url), 'utf8')
const sourceFile = ts.createSourceFile(
  'functions/src/index.ts',
  indexSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

const createTransactionCallbackSource = (): string => {
  const declarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'createTransactionTool') {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  assert.equal(declarations.length, 1, 'index.ts must define exactly one createTransactionTool')
  const initializer = declarations[0]?.initializer
  assert.ok(initializer && ts.isCallExpression(initializer), 'createTransactionTool must be initialized by a call')
  assert.equal(initializer.expression.getText(sourceFile), 'ai.defineTool')

  const callback = initializer.arguments[1]
  assert.ok(callback && ts.isArrowFunction(callback), 'createTransactionTool must pass its producer callback')
  return callback.getText(sourceFile)
}

const compileCreateTransactionCallback = (dependencies: {
  db: unknown
  admin: unknown
  activeWorkspaceId: string
  userId: string
}): ((input: Record<string, unknown>) => Promise<unknown>) => {
  const javascript = ts.transpile(createTransactionCallbackSource(), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None
  })
  const evaluate = new Function('db', 'admin', 'activeWorkspaceId', 'userId', `return ${javascript}`) as (
    db: unknown,
    admin: unknown,
    activeWorkspaceId: string,
    userId: string
  ) => (input: Record<string, unknown>) => Promise<unknown>

  return evaluate(dependencies.db, dependencies.admin, dependencies.activeWorkspaceId, dependencies.userId)
}

test('AI createTransaction writes an unassigned expense that resolves to the protected default budget', async () => {
  const accountRef = { collection: 'accounts', id: 'ai-credit-account' }
  const transactionRef = { collection: 'transactions', id: 'ai-created-expense' }
  const accountData = {
    workspaceId: 'workspace-ai',
    type: 'credit',
    balance: 250000,
    currency: 'COP'
  }
  const createdAt = { kind: 'server-timestamp' }
  const writes: Array<{ ref: typeof transactionRef; payload: Record<string, unknown> }> = []
  const updates: Array<{ ref: typeof accountRef; patch: Record<string, unknown> }> = []

  const transaction = {
    async get(ref: typeof accountRef) {
      assert.equal(ref, accountRef)
      return { exists: true, data: () => accountData }
    },
    set(ref: typeof transactionRef, payload: Record<string, unknown>) {
      assert.equal(ref, transactionRef)
      writes.push({ ref, payload })
    },
    update(ref: typeof accountRef, patch: Record<string, unknown>) {
      assert.equal(ref, accountRef)
      updates.push({ ref, patch })
    }
  }
  const db = {
    collection(name: string) {
      assert.ok(name === 'accounts' || name === 'transactions', `unexpected collection: ${name}`)
      return {
        doc(id?: string) {
          if (name === 'accounts') {
            assert.equal(id, 'ai-credit-account')
            return accountRef
          }
          assert.equal(id, undefined, 'the producer should request a generated transaction reference')
          return transactionRef
        }
      }
    },
    async runTransaction<T>(callback: (value: typeof transaction) => Promise<T>) {
      return callback(transaction)
    }
  }
  const admin = {
    firestore: {
      Timestamp: {
        fromDate(date: Date) {
          assert.ok(date instanceof Date)
          return { kind: 'timestamp', iso: date.toISOString() }
        }
      },
      FieldValue: {
        serverTimestamp: () => createdAt
      }
    }
  }
  const createTransaction = compileCreateTransactionCallback({
    db,
    admin,
    activeWorkspaceId: 'workspace-ai',
    userId: 'user-ai'
  })

  const result = await createTransaction({
    accountId: 'ai-credit-account',
    amount: -42000,
    description: 'AI expense regression fixture',
    categoryId: 'food',
    type: 'expense',
    date: '2026-10-20',
    installments: 3
  })

  assert.deepEqual(result, {
    success: true,
    message: 'Transacción agregada y saldos actualizados.'
  })
  assert.equal(writes.length, 1)
  const payload = writes[0]?.payload
  assert.ok(payload)
  assert.equal(Object.hasOwn(payload, 'budgetId'), false)
  assert.equal(resolveBudgetId(payload.budgetId as string | null | undefined), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(DEFAULT_MONTHLY_BUDGET_ID, 'default-monthly')
  assert.deepEqual(payload, {
    workspaceId: 'workspace-ai',
    userId: 'user-ai',
    accountId: 'ai-credit-account',
    amount: -42000,
    description: 'AI expense regression fixture',
    categoryId: 'food',
    date: { kind: 'timestamp', iso: '2026-10-20T00:00:00.000Z' },
    type: 'expense',
    toAccountId: null,
    installments: 3,
    currency: 'COP',
    createdAt
  })
  assert.deepEqual(updates, [{ ref: accountRef, patch: { balance: 208000 } }])
})
