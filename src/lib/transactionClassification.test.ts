import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Transaction } from '../types.ts'
import {
  DEFAULT_MONTHLY_BUDGET_ID, allBudgetsEstimatedMonthlyTotal,
  eventBudgetCommittedAllocation, monthlyBudgetAllocation,
} from './budgets.ts'
import { createExpenseBudgetAssigner, selectBudgetExpenses } from './transactionClassification.ts'

const expense = (extra: Partial<Transaction> = {}): Transaction => ({
  id: 'expense', workspaceId: 'workspace', userId: 'creator', accountId: 'credit',
  amount: -900, description: 'Booking', categoryId: 'travel', date: new Date(2026, 0, 10),
  type: 'expense', currency: 'USD', installments: 3, receiptUrl: 'receipt', notes: 'original',
  createdAt: new Date(2026, 0, 11), ...extra,
})

const harness = (initial = [expense()]) => {
  let rows = initial
  let userId: string | null = 'user'
  let workspaceId: string | null = 'workspace'
  let writer: () => Promise<void> = async () => {}
  const writes: { id: string; patch: { budgetId: string | null } }[] = []
  const assign = createExpenseBudgetAssigner({
    getUserId: () => userId,
    getWorkspaceId: () => workspaceId,
    findTransaction: id => rows.find(row => row.id === id),
    writePatch: async (id, patch) => { writes.push({ id, patch: { ...patch } }); await writer() },
  })
  return {
    assign, writes, rows: () => rows,
    setRows: (value: Transaction[]) => { rows = value },
    setUser: (value: string | null) => { userId = value },
    setWorkspace: (value: string | null) => { workspaceId = value },
    setWriter: (value: () => Promise<void>) => { writer = value },
  }
}

const pending = (h: ReturnType<typeof harness>) => {
  let resolve!: () => void
  h.setWriter(() => new Promise<void>(done => { resolve = done }))
  const result = h.assign('expense', 'event')
  return { result, finish: () => resolve() }
}

test('classification writes exactly one scalar field and preserves all financial metadata', async () => {
  for (const budgetId of ['event', 'monthly', DEFAULT_MONTHLY_BUDGET_ID, null]) {
    const h = harness()
    const before = structuredClone(h.rows())
    await h.assign('expense', budgetId)
    assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId } }])
    assert.deepEqual(h.rows(), [{ ...before[0], budgetId }])
  }
})

test('classifying a mirrored expense neither traverses nor changes its transfer counterpart', async () => {
  const h = harness([
    expense({ mirrorOf: 'counterpart' }),
    expense({ id: 'counterpart', workspaceId: 'other', type: 'transfer', mirrorOf: 'expense' }),
  ])
  const before = structuredClone(h.rows())
  await h.assign('expense', 'event')
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  assert.deepEqual(h.rows(), [{ ...before[0], budgetId: 'event' }, before[1]])
})

test('income is classified like an expense, writing only the budget reference', async () => {
  const h = harness([expense({ type: 'income', amount: 900 })])
  const before = structuredClone(h.rows())
  await h.assign('expense', 'event')
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  assert.deepEqual(h.rows(), [{ ...before[0], budgetId: 'event' }])
})

test('transfer and loan legs reject before any write or state mutation', async () => {
  for (const type of ['transfer', 'loan', 'loan_payment'] as const) {
    const h = harness([expense({ type })])
    const before = structuredClone(h.rows())
    await assert.rejects(h.assign('expense', 'event'), { message: 'Only expenses and income can be assigned to operating budgets' })
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.rows(), before)
  }
})

test('authentication, captured workspace and transaction presence are required before writing', async () => {
  for (const [setup, message] of [
    [(h: ReturnType<typeof harness>) => h.setUser(null), 'User is not authenticated'],
    [(h: ReturnType<typeof harness>) => h.setWorkspace(null), 'Workspace is not initialized'],
    [(h: ReturnType<typeof harness>) => h.setWorkspace('other'), 'Transaction belongs to a different workspace'],
    [(h: ReturnType<typeof harness>) => h.setRows([]), 'Transaction not found'],
  ] as const) {
    const h = harness()
    setup(h)
    const before = structuredClone(h.rows())
    await assert.rejects(h.assign('expense', 'event'), { message })
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.rows(), before)
  }
})

test('malformed budget and document segments never reach persistence', async () => {
  for (const id of ['', ' ', '.', '..', 'a/b', '__reserved__', 7, undefined, {}]) {
    const h = harness()
    const before = structuredClone(h.rows())
    await assert.rejects(h.assign('expense', id as never), { message: 'Invalid budget ID' })
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.rows(), before)
  }
  for (const target of ['transaction', 'workspace']) {
    const h = harness()
    const before = structuredClone(h.rows())
    if (target === 'workspace') h.setWorkspace('a/b')
    await assert.rejects(h.assign(target === 'transaction' ? 'a/b' : 'expense', null), {
      message: `Invalid ${target} ID`,
    })
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.rows(), before)
  }
})

test('persistence rejection propagates unchanged without optimistic local changes', async () => {
  const h = harness([expense({ budgetId: 'old' })])
  const before = structuredClone(h.rows())
  const failure = new Error('permission-denied')
  h.setWriter(async () => { throw failure })
  await assert.rejects(h.assign('expense', 'event'), error => error === failure)
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  assert.deepEqual(h.rows(), before)
})

test('local classification changes only after the write completes', async () => {
  const h = harness()
  const before = structuredClone(h.rows())
  const write = pending(h)
  assert.deepEqual(h.rows(), before)
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  write.finish()
  await write.result
  assert.deepEqual(h.rows(), [{ ...before[0], budgetId: 'event' }])
})

test('user or workspace changes during a write cannot mutate either old or replacement local rows', async () => {
  for (const change of ['user', 'logout', 'workspace']) {
    const old = [expense()]
    const h = harness(old)
    const write = pending(h)
    if (change === 'user') h.setUser('second-user')
    if (change === 'logout') h.setUser(null)
    if (change === 'workspace') h.setWorkspace('other')
    const replacement = [expense({ workspaceId: change === 'workspace' ? 'other' : 'workspace' })]
    h.setRows(replacement)
    const before = structuredClone(replacement)
    write.finish()
    await write.result
    assert.deepEqual(old, [expense()])
    assert.deepEqual(h.rows(), before)
    assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  }
})

test('post-write relookup preserves refreshed financial fields instead of restoring a stale snapshot', async () => {
  const h = harness()
  const write = pending(h)
  h.setRows([expense({ amount: -450, description: 'refreshed', installments: 2 })])
  const before = structuredClone(h.rows())
  write.finish()
  await write.result
  assert.deepEqual(h.rows(), [{ ...before[0], budgetId: 'event' }])
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
})

test('removed, retyped or foreign local rows are not patched after an in-flight write', async () => {
  for (const replacement of [[], [expense({ type: 'income' })], [expense({ workspaceId: 'other' })]]) {
    const h = harness()
    const write = pending(h)
    h.setRows(replacement)
    const before = structuredClone(h.rows())
    write.finish()
    await write.result
    assert.deepEqual(h.rows(), before)
    assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
  }
})

test('expense selection keeps exclusive membership and legacy absent/null/default compatibility', () => {
  const rows = [
    expense(), expense({ id: 'null', budgetId: null }),
    expense({ id: 'default', budgetId: DEFAULT_MONTHLY_BUDGET_ID }),
    expense({ id: 'event', budgetId: 'event' }), expense({ id: 'monthly', budgetId: 'monthly' }),
    expense({ id: 'income', type: 'income' }), expense({ id: 'transfer', type: 'transfer', budgetId: 'event' }),
  ]
  const before = structuredClone(rows)
  assert.deepEqual(selectBudgetExpenses(rows, DEFAULT_MONTHLY_BUDGET_ID).map(row => row.id), ['expense', 'null', 'default'])
  assert.deepEqual(selectBudgetExpenses(rows, 'event').map(row => row.id), ['event'])
  assert.deepEqual(selectBudgetExpenses(rows, 'monthly').map(row => row.id), ['monthly'])
  assert.deepEqual(selectBudgetExpenses(rows, 'archived').map(row => row.id), [])
  assert.deepEqual(rows, before)
  assert.equal(Object.hasOwn(rows[0], 'budgetId'), false)
  assert.equal(selectBudgetExpenses(rows, 'event')[0], rows[3])
})

test('a 900-unit three-installment event assignment restates attribution, not global allocations', async () => {
  const h = harness()
  const globalBefore = [0, 1, 2].map(month => allBudgetsEstimatedMonthlyTotal(h.rows(), 2026, month))
  assert.deepEqual(globalBefore, [300, 300, 300])
  assert.equal(monthlyBudgetAllocation(h.rows(), DEFAULT_MONTHLY_BUDGET_ID, 2026, 0).total, 300)
  await h.assign('expense', 'event')
  assert.equal(eventBudgetCommittedAllocation(h.rows(), 'event').total, 900)
  assert.equal(monthlyBudgetAllocation(h.rows(), DEFAULT_MONTHLY_BUDGET_ID, 2026, 0).total, 0)
  assert.deepEqual([0, 1, 2].map(month => allBudgetsEstimatedMonthlyTotal(h.rows(), 2026, month)), globalBefore)
  assert.equal(h.rows()[0].amount, -900)
  assert.deepEqual(h.writes, [{ id: 'expense', patch: { budgetId: 'event' } }])
})
