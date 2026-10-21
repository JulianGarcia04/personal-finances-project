import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createBudgetWorkspaceAdapter,
  planLegacyCategoryBudgetCurrencyConfirmation,
  type BudgetWorkspaceAdapterDependencies,
  type BudgetWorkspaceContext,
  type BudgetWorkspaceLegacyData,
  type CategoryBudgetCurrencyPatch
} from './budgetWorkspaceAdapter.ts'
import type { OperatingBudget } from '../types.ts'

const workspaceId = 'workspace-a'
const userId = 'user-a'
const context: BudgetWorkspaceContext = { userId, workspaceId }

const makeWorkspace = (overrides: Partial<BudgetWorkspaceLegacyData> = {}) => ({
  currency: 'USD',
  categoryBudgets: { food: 125, travel: 0 },
  exchangeRates: { EUR: 1.12 },
  budgetIncome: 5000,
  budgetAllocations: { goal: 75 },
  budgetNeedsPercent: 50,
  budgetWantsPercent: 30,
  budgetSavingsPercent: 20,
  expenseLimit: 900,
  ...overrides
})

const makeBudget = (id: string, archived = false): OperatingBudget => ({
  id,
  workspaceId,
  kind: 'monthly',
  name: id,
  capCurrency: 'USD',
  archived,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-02T00:00:00.000Z')
})

type HarnessOptions = {
  workspace?: BudgetWorkspaceLegacyData | null
  budgets?: OperatingBudget[]
  caps?: Record<string, Record<string, number>>
  readWorkspace?: (id: string) => Promise<BudgetWorkspaceLegacyData | null>
  runLegacyWorkspaceTransaction?: BudgetWorkspaceAdapterDependencies['runLegacyWorkspaceTransaction']
}

const makeHarness = (options: HarnessOptions = {}) => {
  let activeContext: BudgetWorkspaceContext | null = { ...context }
  let workspace: BudgetWorkspaceLegacyData | null = options.workspace === undefined
    ? makeWorkspace()
    : options.workspace
  const budgets = options.budgets ?? [makeBudget('monthly-a'), makeBudget('event-archived', true)]
  const caps = options.caps ?? { 'monthly-a': { food: 40 }, 'event-archived': { travel: 600 } }
  const budgetFactoryWorkspaces: string[] = []
  const capFactoryWorkspaces: string[] = []
  const listedCapBudgets: string[] = []
  const workspaceReads: string[] = []
  const transactionContexts: BudgetWorkspaceContext[] = []
  const stagedPatches: CategoryBudgetCurrencyPatch[] = []
  const committedPatches: CategoryBudgetCurrencyPatch[] = []
  let budgetListCalls = 0
  let workspaceDocumentCount = 1

  const dependencies: BudgetWorkspaceAdapterDependencies = {
    getCurrentContext: () => activeContext,
    readWorkspace: async id => {
      workspaceReads.push(id)
      return options.readWorkspace ? options.readWorkspace(id) : workspace
    },
    createBudgetPersistence: id => {
      budgetFactoryWorkspaces.push(id)
      return {
        list: async () => {
          budgetListCalls += 1
          return budgets
        }
      }
    },
    createBudgetCategoryCapsPersistence: id => {
      capFactoryWorkspaces.push(id)
      return {
        list: async budgetId => {
          listedCapBudgets.push(budgetId)
          return caps[budgetId] ?? {}
        }
      }
    },
    runLegacyWorkspaceTransaction: options.runLegacyWorkspaceTransaction ?? (async <T>(
      transactionContext: Readonly<BudgetWorkspaceContext>,
      callback: (current: BudgetWorkspaceLegacyData, update: (patch: CategoryBudgetCurrencyPatch) => void) => T
    ): Promise<T> => {
      transactionContexts.push({ ...transactionContext })
      if (!workspace) throw new Error('Workspace not found')
      const pending: CategoryBudgetCurrencyPatch[] = []
      const result = callback(workspace, patch => pending.push({ ...patch }))
      if (pending.length > 1) throw new Error('Transaction attempted multiple workspace patches')
      if (pending.length === 1) {
        stagedPatches.push(pending[0]!)
        committedPatches.push(pending[0]!)
        workspace = { ...workspace, ...pending[0] }
      }
      return result
    })
  }

  return {
    adapter: createBudgetWorkspaceAdapter(dependencies),
    dependencies,
    getWorkspace: () => workspace,
    setWorkspace: (next: BudgetWorkspaceLegacyData | null) => { workspace = next },
    setContext: (next: BudgetWorkspaceContext | null) => { activeContext = next },
    budgetFactoryWorkspaces,
    capFactoryWorkspaces,
    listedCapBudgets,
    workspaceReads,
    transactionContexts,
    stagedPatches,
    committedPatches,
    get budgetListCalls() { return budgetListCalls },
    get workspaceDocumentCount() { return workspaceDocumentCount },
    set workspaceDocumentCount(value: number) { workspaceDocumentCount = value }
  }
}

test('loads additional budgets, archived caps, and authoritative legacy maps without inferring currency', async () => {
  const harness = makeHarness()
  const snapshot = await harness.adapter.loadSnapshot()

  assert.deepEqual(snapshot.context, context)
  assert.deepEqual(snapshot.budgets, [
    { budget: makeBudget('monthly-a'), categoryCaps: { food: 40 } },
    { budget: makeBudget('event-archived', true), categoryCaps: { travel: 600 } }
  ])
  assert.deepEqual(snapshot.legacy, {
    categoryBudgets: { food: 125, travel: 0 },
    exchangeRates: { EUR: 1.12 },
    categoryBudgetCurrency: { status: 'unconfirmed' }
  })
  assert.deepEqual(harness.workspaceReads, [workspaceId])
  assert.deepEqual(harness.budgetFactoryWorkspaces, [workspaceId])
  assert.deepEqual(harness.capFactoryWorkspaces, [workspaceId])
  assert.deepEqual(harness.listedCapBudgets, ['monthly-a', 'event-archived'])
  assert.equal(harness.budgetListCalls, 1)
  assert.equal(snapshot.budgets.some(entry => entry.budget.id === 'default-monthly'), false)
})

test('legacy currency planner emits the scalar-only patch, is idempotent, and rejects conflicts', () => {
  const unconfirmed = makeWorkspace()
  assert.deepEqual(planLegacyCategoryBudgetCurrencyConfirmation(unconfirmed, 'COP'), {
    status: 'confirmed',
    patch: { categoryBudgetCurrency: 'COP' }
  })
  assert.deepEqual(planLegacyCategoryBudgetCurrencyConfirmation(
    makeWorkspace({ categoryBudgetCurrency: 'COP', currency: 'EUR' }), 'COP'
  ), { status: 'unchanged' })
  assert.throws(
    () => planLegacyCategoryBudgetCurrencyConfirmation(makeWorkspace({ categoryBudgetCurrency: 'COP' }), 'USD'),
    { message: 'Category budget currency is already confirmed as COP' }
  )
  assert.throws(
    () => planLegacyCategoryBudgetCurrencyConfirmation(unconfirmed, 'cop'),
    { message: 'Invalid budget currency code' }
  )
  assert.throws(
    () => planLegacyCategoryBudgetCurrencyConfirmation(makeWorkspace({ categoryBudgetCurrency: 'bad' }), 'USD'),
    { message: 'Stored category budget currency is invalid' }
  )
})

test('confirmation uses the transaction callback and changes only the confirmed unit', async () => {
  const original = makeWorkspace()
  const harness = makeHarness({ workspace: original })
  const beforeCount = harness.workspaceDocumentCount

  assert.equal(await harness.adapter.confirmLegacyCategoryBudgetCurrency('COP'), 'confirmed')
  assert.deepEqual(harness.transactionContexts, [context])
  assert.deepEqual(harness.stagedPatches, [{ categoryBudgetCurrency: 'COP' }])
  assert.deepEqual(harness.committedPatches, [{ categoryBudgetCurrency: 'COP' }])
  assert.deepEqual(harness.getWorkspace(), { ...original, categoryBudgetCurrency: 'COP' })
  assert.deepEqual(harness.getWorkspace()?.categoryBudgets, original.categoryBudgets)
  assert.deepEqual(harness.getWorkspace()?.exchangeRates, original.exchangeRates)
  assert.equal(harness.getWorkspace()?.budgetIncome, original.budgetIncome)
  assert.deepEqual(harness.getWorkspace()?.budgetAllocations, original.budgetAllocations)
  assert.equal(harness.getWorkspace()?.expenseLimit, original.expenseLimit)
  assert.equal(harness.workspaceDocumentCount, beforeCount)

  harness.setWorkspace({ ...harness.getWorkspace()!, currency: 'EUR' })
  assert.deepEqual((await harness.adapter.loadSnapshot()).legacy.categoryBudgetCurrency, {
    status: 'confirmed', code: 'COP'
  })
  assert.equal(await harness.adapter.confirmLegacyCategoryBudgetCurrency('COP'), 'unchanged')
  assert.equal(harness.committedPatches.length, 1)
  assert.deepEqual(harness.getWorkspace()?.categoryBudgets, original.categoryBudgets)
  assert.deepEqual(harness.getWorkspace()?.exchangeRates, original.exchangeRates)
})

test('invalid and conflicting confirmations reject without writes or document-count changes', async () => {
  const harness = makeHarness({ workspace: makeWorkspace({ categoryBudgetCurrency: 'COP' }) })
  const before = harness.getWorkspace()
  const beforeCount = harness.workspaceDocumentCount

  await assert.rejects(harness.adapter.confirmLegacyCategoryBudgetCurrency('US'), {
    message: 'Invalid budget currency code'
  })
  assert.equal(harness.transactionContexts.length, 0)
  await assert.rejects(harness.adapter.confirmLegacyCategoryBudgetCurrency('USD'), {
    message: 'Category budget currency is already confirmed as COP'
  })
  assert.deepEqual(harness.stagedPatches, [])
  assert.deepEqual(harness.committedPatches, [])
  assert.deepEqual(harness.getWorkspace(), before)
  assert.equal(harness.workspaceDocumentCount, beforeCount)
})

test('workspace switches during async loading reject the captured snapshot', async () => {
  let resolveWorkspace!: (value: BudgetWorkspaceLegacyData | null) => void
  const pendingWorkspace = new Promise<BudgetWorkspaceLegacyData | null>(resolve => { resolveWorkspace = resolve })
  const harness = makeHarness({ readWorkspace: async () => pendingWorkspace })
  const pending = harness.adapter.loadSnapshot()
  harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
  resolveWorkspace(makeWorkspace())

  await assert.rejects(pending, { message: 'Budget workspace context changed during operation' })
  assert.deepEqual(harness.workspaceReads, [workspaceId])
  assert.deepEqual(harness.committedPatches, [])
})

test('transaction callback retries recheck context and never commit a stale patch', async () => {
  let harness: ReturnType<typeof makeHarness>
  let attempts = 0
  const runLegacyWorkspaceTransaction: BudgetWorkspaceAdapterDependencies['runLegacyWorkspaceTransaction'] = async <T>(
    _transactionContext,
    callback
  ): Promise<T> => {
    const current = harness.getWorkspace()!
    const firstAttempt: CategoryBudgetCurrencyPatch[] = []
    callback(current, patch => firstAttempt.push({ ...patch }))
    attempts += 1
    harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
    attempts += 1
    return callback(current, patch => harness.committedPatches.push({ ...patch }))
  }
  harness = makeHarness({ runLegacyWorkspaceTransaction })
  const before = harness.getWorkspace()
  const beforeCount = harness.workspaceDocumentCount

  await assert.rejects(harness.adapter.confirmLegacyCategoryBudgetCurrency('COP'), {
    message: 'Budget workspace context changed during operation'
  })
  assert.equal(attempts, 2)
  assert.deepEqual(harness.stagedPatches, [])
  assert.deepEqual(harness.committedPatches, [])
  assert.deepEqual(harness.getWorkspace(), before)
  assert.equal(harness.workspaceDocumentCount, beforeCount)
})

test('budget persistence failures propagate unchanged', async () => {
  const failure = new Error('closed budget reader failed')
  const harness = makeHarness({
    readWorkspace: async () => { throw failure }
  })
  await assert.rejects(harness.adapter.loadSnapshot(), error => error === failure)
  assert.deepEqual(harness.committedPatches, [])
})
