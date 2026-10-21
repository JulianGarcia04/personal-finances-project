import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId } from '../../src/lib/budgets.ts'
import { roundMoney } from '../../functions/src/money.ts'

const pocketsSource = readFileSync(new URL('../../functions/src/pockets.ts', import.meta.url), 'utf8')
const agentContextSource = readFileSync(new URL('../../functions/src/agentContext.ts', import.meta.url), 'utf8')
assert.match(agentContextSource, /mutateWorkspaceTransaction\(db,\s*\{[\s\S]*?kind:\s*'created'/)

const strippedSource = pocketsSource.replace(/^import\s+.*$/gm, '')
const transpiled = ts.transpileModule(strippedSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

const createMutateWorkspaceTransaction = new Function(
  'Timestamp',
  'FieldValue',
  'roundMoney',
  `const exports = {};
${transpiled}
return mutateWorkspaceTransaction;`
)

test('AI createTransaction producer writes an unassigned expense that resolves to the protected default budget', async () => {
  const userRef = { collection: 'users', id: 'user-ai' }
  const workspaceRef = { collection: 'workspaces', id: 'workspace-ai' }
  const accountRef = { collection: 'accounts', id: 'ai-credit-account' }
  const transactionRef = { collection: 'transactions', id: 'ai-created-expense' }
  const childrenQuery = { kind: 'children-query', parentId: 'ai-credit-account' }
  const createdAt = { kind: 'server-timestamp' }

  const writes: Array<{ ref: unknown; payload: Record<string, unknown> }> = []
  const updates: Array<{ ref: unknown; patch: Record<string, unknown> }> = []

  const tx = {
    async get(target: unknown) {
      if (target === userRef) {
        return { exists: true, data: () => ({ activeWorkspaceId: 'workspace-ai' }) }
      }
      if (target === workspaceRef) {
        return { exists: true, data: () => ({ members: ['user-ai'] }) }
      }
      if (target === accountRef) {
        return {
          id: 'ai-credit-account',
          exists: true,
          data: () => ({
            workspaceId: 'workspace-ai',
            type: 'credit',
            balance: -250000,
            currency: 'COP'
          })
        }
      }
      if (target === childrenQuery) {
        return { empty: true, size: 0, docs: [] }
      }
      throw new Error('Unexpected transaction.get target')
    },
    create(ref: unknown, payload: Record<string, unknown>) {
      writes.push({ ref, payload })
    },
    update(ref: unknown, patch: Record<string, unknown>) {
      updates.push({ ref, patch })
    },
    delete() {
      throw new Error('Unexpected delete')
    }
  }

  const db = {
    collection(name: string) {
      return {
        doc(id?: string) {
          if (name === 'users') return userRef
          if (name === 'workspaces') return workspaceRef
          if (name === 'accounts') {
            assert.equal(id, 'ai-credit-account')
            return accountRef
          }
          if (name === 'transactions') {
            assert.equal(id, undefined)
            return transactionRef
          }
          throw new Error(`Unexpected collection ${name}`)
        },
        where(field: string, op: string, value: string) {
          assert.equal(name, 'accounts')
          assert.equal(field, 'parentAccountId')
          assert.equal(op, '==')
          assert.equal(value, 'ai-credit-account')
          return Object.assign(childrenQuery, {
            limit() {
              return childrenQuery
            }
          })
        }
      }
    },
    async runTransaction<T>(callback: (transaction: typeof tx) => Promise<T>) {
      return callback(tx)
    }
  }

  const mutateWorkspaceTransaction = createMutateWorkspaceTransaction(
    { fromDate: (date: Date) => ({ kind: 'timestamp', iso: date.toISOString() }) },
    { serverTimestamp: () => createdAt },
    roundMoney
  )

  const result = await mutateWorkspaceTransaction(db, {
    kind: 'created',
    userId: 'user-ai',
    workspaceId: 'workspace-ai',
    movement: {
      accountId: 'ai-credit-account',
      amount: -42000,
      description: 'AI expense regression fixture',
      categoryId: 'food',
      type: 'expense',
      toAccountId: null,
      date: new Date('2026-10-20T12:00:00.000Z'),
      installments: 3
    }
  })

  assert.equal(result.id, 'ai-created-expense')
  assert.equal(writes.length, 1)
  const payload = writes[0]!.payload
  assert.equal(payload.type, 'expense')
  assert.equal(payload.amount, -42000)
  assert.equal(payload.installments, 3)
  assert.equal(Object.hasOwn(payload, 'budgetId'), false)
  assert.equal(resolveBudgetId(payload.budgetId as string | null | undefined), DEFAULT_MONTHLY_BUDGET_ID)
  assert.deepEqual(updates, [{ ref: accountRef, patch: { balance: -292000 } }])
})
