import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import {
  createGoalsBudgetActions,
  type GoalsBudgetManagementDependencies,
  type GoalsBudgetSettingsDocument
} from './goalsStore.ts'
import {
  createBudgetWorkspaceAdapter,
  type BudgetWorkspaceBudgetSnapshot,
  type BudgetWorkspaceContext,
  type BudgetWorkspaceLegacyData,
  type CategoryBudgetCurrencyPatch
} from '../lib/budgetWorkspaceAdapter.ts'
import {
  allBudgetsEstimatedMonthlyTotal,
  DEFAULT_MONTHLY_BUDGET_ID,
  eventBudgetCommittedAllocation,
  resolveBudgetId
} from '../lib/budgets.ts'
import { OperatingBudgetPatchSchema } from '../schemas.ts'
import type { OperatingBudget, OperatingBudgetDraft, OperatingBudgetPatch } from '../types.ts'
import type { BudgetLinkOptions } from '../lib/budgetPersistence.ts'

const context: BudgetWorkspaceContext = { userId: 'user-a', workspaceId: 'workspace-a' }

const makeBudget = (id: string, overrides: Partial<OperatingBudget> = {}): OperatingBudget => ({
  id,
  workspaceId: context.workspaceId,
  kind: 'monthly',
  name: id,
  capCurrency: 'USD',
  archived: false,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-02T00:00:00.000Z'),
  ...overrides
})

const makeWorkspace = (overrides: Record<string, unknown> = {}) => ({
  currency: 'EUR',
  budgetIncome: 8000,
  budgetNeedsPercent: 50,
  budgetWantsPercent: 30,
  budgetSavingsPercent: 20,
  budgetAllocations: { goal: 350 },
  categoryBudgets: { food: 500, travel: 0 },
  exchangeRates: { USD: 0.92 },
  ...overrides
})

type GoalsBudgetState = Parameters<typeof createGoalsBudgetActions>[0]

type HarnessOptions = {
  budgets?: OperatingBudget[]
  caps?: Record<string, Record<string, number>>
  workspace?: ReturnType<typeof makeWorkspace>
  readAdapterWorkspace?: (workspaceId: string) => Promise<BudgetWorkspaceLegacyData | null>
}

const deferredVoid = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const makeHarness = (options: HarnessOptions = {}) => {
  let activeContext: BudgetWorkspaceContext | null = { ...context }
  let workspace: Record<string, unknown> | null = options.workspace ?? makeWorkspace()
  let budgets = [...(options.budgets ?? [])]
  const caps = Object.fromEntries(Object.entries(options.caps ?? {}).map(([id, entries]) => [id, { ...entries }]))
  const writes: Array<{ workspaceId: string; patch: Record<string, unknown> }> = []
  const persistenceCalls: Array<{ operation: string; workspaceId: string; id?: string; releases?: unknown }> = []
  const capCalls: Array<{ operation: string; workspaceId: string; budgetId: string; categoryId: string }> = []
  const transactionPatches: CategoryBudgetCurrencyPatch[] = []
  const history = [{
    transactionId: 'expense-1', budgetId: 'event-a', installments: 3, amount: -900,
    type: 'expense', date: new Date('2025-01-15T00:00:00.000Z'), currency: 'USD', categoryId: 'travel'
  }]
  let nextId = 0

  const applyReleases = (releases: BudgetLinkOptions['releases']) => {
    for (const release of releases ?? []) {
      budgets = budgets.map(candidate => candidate.id === release.budgetId
        ? { ...candidate, linkedAccountIds: [...release.linkedAccountIds] }
        : candidate)
    }
  }

  const createBudgetPersistence = (workspaceId: string) => ({
    create: async (draft: OperatingBudgetDraft, linkOptions: BudgetLinkOptions = {}) => {
      persistenceCalls.push({ operation: 'create', workspaceId, ...(linkOptions.releases ? { releases: linkOptions.releases } : {}) })
      applyReleases(linkOptions.releases)
      const now = new Date('2025-02-01T00:00:00.000Z')
      const budget = makeBudget(`created-${++nextId}`, { ...draft, workspaceId, createdAt: now, updatedAt: now })
      budgets = [...budgets, budget]
      return budget
    },
    list: async () => budgets.filter(budget => budget.workspaceId === workspaceId),
    read: async (budgetId: string) => {
      const budget = budgets.find(candidate => candidate.id === budgetId && candidate.workspaceId === workspaceId)
      if (!budget) throw new Error('Budget not found')
      return budget
    },
    patch: async (budgetId: string, patch: Record<string, unknown>, linkOptions: BudgetLinkOptions = {}) => {
      const validatedPatch = OperatingBudgetPatchSchema.parse(patch)
      persistenceCalls.push({ operation: 'patch', workspaceId, id: budgetId, ...(linkOptions.releases ? { releases: linkOptions.releases } : {}) })
      applyReleases(linkOptions.releases)
      const budget = budgets.find(candidate => candidate.id === budgetId && candidate.workspaceId === workspaceId)
      if (!budget) throw new Error('Budget not found')
      const updated = { ...budget, ...validatedPatch, updatedAt: new Date('2025-02-02T00:00:00.000Z') } as OperatingBudget
      budgets = budgets.map(candidate => candidate.id === budgetId ? updated : candidate)
      return updated
    },
    archive: async (budgetId: string) => {
      persistenceCalls.push({ operation: 'archive', workspaceId, id: budgetId })
      const budget = budgets.find(candidate => candidate.id === budgetId && candidate.workspaceId === workspaceId)
      if (!budget) throw new Error('Budget not found')
      const archived = { ...budget, archived: true, updatedAt: new Date('2025-02-03T00:00:00.000Z') }
      budgets = budgets.map(candidate => candidate.id === budgetId ? archived : candidate)
      return archived
    }
  })

  const createCategoryCapsPersistence = (workspaceId: string) => ({
    list: async (budgetId: string) => ({ ...(caps[budgetId] ?? {}) }),
    read: async (budgetId: string, categoryId: string) => caps[budgetId]?.[categoryId],
    set: async (budgetId: string, categoryId: string, amount: number) => {
      capCalls.push({ operation: 'set', workspaceId, budgetId, categoryId })
      caps[budgetId] ??= {}
      Object.defineProperty(caps[budgetId], categoryId, { value: amount, enumerable: true, configurable: true, writable: true })
    },
    remove: async (budgetId: string, categoryId: string) => {
      capCalls.push({ operation: 'remove', workspaceId, budgetId, categoryId })
      delete caps[budgetId]?.[categoryId]
    }
  })

  const dependencies: GoalsBudgetManagementDependencies = {
    getCurrentContext: () => activeContext,
    readWorkspaceSettings: async () => workspace as GoalsBudgetSettingsDocument | null,
    createWorkspaceAdapter: () => createBudgetWorkspaceAdapter({
      getCurrentContext: () => activeContext,
      readWorkspace: options.readAdapterWorkspace ?? (async () => workspace as BudgetWorkspaceLegacyData | null),
      createBudgetPersistence: workspaceId => createBudgetPersistence(workspaceId),
      createBudgetCategoryCapsPersistence: workspaceId => createCategoryCapsPersistence(workspaceId),
      runLegacyWorkspaceTransaction: async <Value>(
        transactionContext: Readonly<BudgetWorkspaceContext>,
        callback: (
          current: BudgetWorkspaceLegacyData,
          update: (patch: CategoryBudgetCurrencyPatch) => void
        ) => Value
      ): Promise<Value> => {
        if (!workspace) throw new Error('Workspace not found')
        const pending: CategoryBudgetCurrencyPatch[] = []
        const result = callback(workspace as BudgetWorkspaceLegacyData, patch => pending.push({ ...patch }))
        assert.equal(transactionContext.workspaceId, context.workspaceId)
        for (const patch of pending) {
          transactionPatches.push(patch)
          workspace = { ...workspace, ...patch }
        }
        return result
      }
    }),
    createBudgetPersistence: workspaceId => createBudgetPersistence(workspaceId),
    createCategoryCapsPersistence: workspaceId => createCategoryCapsPersistence(workspaceId),
    writeWorkspaceSettings: async (workspaceId, patch) => {
      writes.push({ workspaceId, patch: { ...patch } })
      workspace = { ...workspace, ...patch }
    }
  }

  const state = {
    goals: [],
    budgetIncome: 0,
    budgetNeedsPercent: 50,
    budgetWantsPercent: 30,
    budgetSavingsPercent: 20,
    budgetAllocations: {},
    categoryBudgets: {},
    exchangeRates: {},
    operatingBudgets: [] as BudgetWorkspaceBudgetSnapshot[],
    categoryBudgetCurrency: { status: 'unconfirmed' as const },
    budgetSettingsContextKey: null,
    budgetSettingsLoading: false,
    budgetSettingsError: null,
    budgetSettingsLoadVersion: 0,
    loading: false
  } as unknown as GoalsBudgetState

  return {
    actions: createGoalsBudgetActions(state, dependencies),
    state,
    dependencies,
    history,
    writes,
    persistenceCalls,
    capCalls,
    transactionPatches,
    getWorkspace: () => workspace,
    getBudgets: () => budgets,
    getCaps: (budgetId: string) => ({ ...(caps[budgetId] ?? {}) }),
    setContext: (next: BudgetWorkspaceContext | null) => { activeContext = next },
    setWorkspace: (next: Record<string, unknown> | null) => { workspace = next }
  }
}

test('S5-S6 keep the default monthly budget in legacy category caps and resolve unassigned expenses to it', async () => {
  const event = makeBudget('event-a', { kind: 'event', archived: true })
  const harness = makeHarness({ budgets: [event], caps: { 'event-a': { food: 900 } } })
  await harness.actions.loadBudgetSettings()

  assert.deepEqual(harness.state.categoryBudgets, { food: 500, travel: 0 })
  assert.deepEqual(harness.state.operatingBudgets.map(entry => entry.budget.id), ['event-a'])
  assert.equal(harness.state.operatingBudgets.some(entry => entry.budget.id === DEFAULT_MONTHLY_BUDGET_ID), false)
  assert.equal(resolveBudgetId(undefined), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(resolveBudgetId(null), DEFAULT_MONTHLY_BUDGET_ID)
  await assert.rejects(harness.actions.updateOperatingBudget(DEFAULT_MONTHLY_BUDGET_ID, { name: 'Not allowed' }), /protected default/)
  await assert.rejects(harness.actions.archiveOperatingBudget(DEFAULT_MONTHLY_BUDGET_ID), /protected default/)
  await assert.rejects(harness.actions.saveOperatingBudgetCategoryCaps(DEFAULT_MONTHLY_BUDGET_ID, { food: 10 }), /protected default/)
  assert.deepEqual(harness.persistenceCalls, [])
  assert.deepEqual(harness.capCalls, [])
})

test('S7 creates and edits additional budgets with workspace-bound scalar and category-cap services', async () => {
  const harness = makeHarness()
  await harness.actions.loadBudgetSettings()
  const created = await harness.actions.createOperatingBudget({
    kind: 'event', name: 'Viaje', capCurrency: 'EUR', totalLimit: 1200,
    startDate: new Date('2025-08-01T00:00:00.000Z'), endDate: new Date('2025-08-10T00:00:00.000Z')
  })
  await harness.actions.saveOperatingBudgetCategoryCaps(created.id, { food: 250, transport: 0 })
  const edited = await harness.actions.updateOperatingBudget(created.id, { name: 'Viaje familiar', totalLimit: 1300 })

  assert.equal(edited.name, 'Viaje familiar')
  assert.equal(edited.capCurrency, 'EUR')
  assert.deepEqual(harness.getCaps(created.id), { food: 250, transport: 0 })
  assert.deepEqual(harness.state.operatingBudgets.find(entry => entry.budget.id === created.id)?.categoryCaps, { food: 250, transport: 0 })
  assert.ok(harness.persistenceCalls.every(call => call.workspaceId === context.workspaceId))
  assert.ok(harness.capCalls.every(call => call.workspaceId === context.workspaceId))
  assert.deepEqual(harness.capCalls.map(call => `${call.operation}:${call.categoryId}`), ['set:food', 'set:transport'])
})

test('S7 rejects a runtime capCurrency patch before mutating budget state', async () => {
  const budget = makeBudget('monthly-a')
  const harness = makeHarness({ budgets: [budget] })
  await harness.actions.loadBudgetSettings()
  const before = structuredClone(harness.state.operatingBudgets)

  await assert.rejects(
    harness.actions.updateOperatingBudget(budget.id, { capCurrency: 'EUR' } as unknown as OperatingBudgetPatch),
    /capCurrency/
  )

  assert.deepEqual(harness.state.operatingBudgets, before)
  assert.deepEqual(harness.getBudgets(), [budget])
  assert.deepEqual(harness.persistenceCalls, [])
})

test('S7 discards a delayed budget edit after the active workspace changes', async () => {
  const budgetA = makeBudget('budget-a')
  const budgetB = makeBudget('budget-b', { workspaceId: 'workspace-b' })
  const workspaceB = makeWorkspace({
    currency: 'USD', budgetIncome: 12000, categoryBudgets: { home: 700 },
    exchangeRates: { EUR: 1.1 }, categoryBudgetCurrency: 'USD'
  })
  const harness = makeHarness({ budgets: [budgetA, budgetB] })
  await harness.actions.loadBudgetSettings()

  const gate = deferredVoid()
  const started = deferredVoid()
  const createPersistence = harness.dependencies.createBudgetPersistence
  harness.dependencies.createBudgetPersistence = workspaceId => {
    const persistence = createPersistence(workspaceId)
    if (workspaceId !== context.workspaceId) return persistence
    return {
      ...persistence,
      patch: async (budgetId, patch) => {
        started.resolve()
        await gate.promise
        return persistence.patch(budgetId, patch)
      }
    }
  }
  const pendingEdit = harness.actions.updateOperatingBudget(budgetA.id, { name: 'Stale edit' })
  await started.promise

  harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
  harness.setWorkspace(workspaceB)
  await harness.actions.loadBudgetSettings()
  gate.resolve()
  await assert.rejects(pendingEdit, /Budget workspace context changed during operation/)

  assert.equal(harness.state.budgetSettingsContextKey, JSON.stringify(['user-b', 'workspace-b']))
  assert.deepEqual(harness.state.categoryBudgets, { home: 700 })
  assert.deepEqual(harness.state.operatingBudgets.map(entry => entry.budget.id), ['budget-b'])
  assert.deepEqual(harness.persistenceCalls, [{ operation: 'patch', workspaceId: 'workspace-a', id: 'budget-a' }])
})

test('S7 discards a delayed category-cap update after the active workspace changes', async () => {
  const budgetA = makeBudget('budget-a')
  const budgetB = makeBudget('budget-b', { workspaceId: 'workspace-b' })
  const harness = makeHarness({
    budgets: [budgetA, budgetB],
    caps: { 'budget-a': { food: 50 }, 'budget-b': { home: 20 } }
  })
  await harness.actions.loadBudgetSettings()

  const gate = deferredVoid()
  const started = deferredVoid()
  const createCaps = harness.dependencies.createCategoryCapsPersistence
  harness.dependencies.createCategoryCapsPersistence = workspaceId => {
    const caps = createCaps(workspaceId)
    if (workspaceId !== context.workspaceId) return caps
    return {
      ...caps,
      set: async (budgetId, categoryId, amount) => {
        started.resolve()
        await gate.promise
        return caps.set(budgetId, categoryId, amount)
      }
    }
  }
  const pendingCaps = harness.actions.saveOperatingBudgetCategoryCaps('budget-a', { food: 80 })
  await started.promise

  harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
  harness.setWorkspace(makeWorkspace({ currency: 'USD', categoryBudgets: { home: 700 } }))
  await harness.actions.loadBudgetSettings()
  gate.resolve()
  await assert.rejects(pendingCaps, /Budget workspace context changed during operation/)

  assert.deepEqual(harness.state.operatingBudgets.map(entry => entry.budget.id), ['budget-b'])
  assert.deepEqual(harness.state.operatingBudgets[0]?.categoryCaps, { home: 20 })
  assert.deepEqual(harness.capCalls, [{ operation: 'set', workspaceId: 'workspace-a', budgetId: 'budget-a', categoryId: 'food' }])
})

test('S7 archives without deleting category caps, assignment history, or pending installment obligations', async () => {
  const event = makeBudget('event-a', { kind: 'event' })
  const harness = makeHarness({ budgets: [event], caps: { 'event-a': { food: 900 } } })
  await harness.actions.loadBudgetSettings()
  const historyBefore = structuredClone(harness.history)
  const capsBefore = harness.getCaps('event-a')
  const monthlyObligationBefore = allBudgetsEstimatedMonthlyTotal(harness.history, 2025, 0)
  const eventPrincipalBefore = eventBudgetCommittedAllocation(harness.history, 'event-a').total

  const archived = await harness.actions.archiveOperatingBudget('event-a')

  assert.equal(archived.archived, true)
  assert.deepEqual(harness.state.operatingBudgets.find(entry => entry.budget.id === 'event-a'), {
    budget: archived, categoryCaps: capsBefore
  })
  assert.deepEqual(harness.getCaps('event-a'), capsBefore)
  assert.deepEqual(harness.history, historyBefore)
  assert.equal(allBudgetsEstimatedMonthlyTotal(harness.history, 2025, 0), monthlyObligationBefore)
  assert.equal(eventBudgetCommittedAllocation(harness.history, 'event-a').total, eventPrincipalBefore)
  assert.equal(monthlyObligationBefore, 300)
  assert.equal(eventPrincipalBefore, 900)
  assert.deepEqual(harness.persistenceCalls.map(call => call.operation), ['archive'])
})

test('S7 archived budgets and their caps survive a settings reload', async () => {
  const event = makeBudget('event-a', { kind: 'event' })
  const harness = makeHarness({ budgets: [event], caps: { 'event-a': { food: 900 } } })
  await harness.actions.loadBudgetSettings()
  await harness.actions.archiveOperatingBudget('event-a')
  await harness.actions.loadBudgetSettings()

  const reloaded = harness.state.operatingBudgets.find(entry => entry.budget.id === 'event-a')
  assert.equal(reloaded?.budget.archived, true)
  assert.deepEqual(reloaded?.categoryCaps, { food: 900 })
})

test('P1 S2 saves only a finite, nonnegative estimated income and leaves other settings intact', async () => {
  const workspace = makeWorkspace({
    budgetNeedsPercent: 55, budgetWantsPercent: 25, expenseLimit: 700,
    exchangeRatesBaseCurrency: 'EUR', categoryBudgetCurrency: 'EUR', budgetAlertsEnabled: false
  })
  const budget = makeBudget('monthly-a', { totalLimit: 900 })
  const harness = makeHarness({ workspace, budgets: [budget], caps: { 'monthly-a': { food: 80 } } })
  await harness.actions.loadBudgetSettings()
  const before = structuredClone(harness.state)

  for (const invalid of [-1, NaN, Infinity]) {
    await assert.rejects(harness.actions.saveBudgetIncome(invalid), /ingreso mensual/)
  }
  assert.deepEqual(harness.writes, [])
  assert.deepEqual(harness.state, before)

  await harness.actions.saveBudgetIncome(9000.5)
  assert.deepEqual(harness.writes, [{ workspaceId: context.workspaceId, patch: { budgetIncome: 9000.5 } }])
  assert.deepEqual(harness.getWorkspace(), { ...workspace, budgetIncome: 9000.5 })
  assert.deepEqual(harness.state, { ...before, budgetIncome: 9000.5 })
})

test('P1 S2 requires the active workspace settings and does not cache an old workspace write after a switch', async () => {
  const harness = makeHarness()
  await assert.rejects(harness.actions.saveBudgetIncome(9000), /not ready/)
  assert.deepEqual(harness.writes, [])
  await harness.actions.loadBudgetSettings()

  const gate = deferredVoid()
  harness.dependencies.writeWorkspaceSettings = async (workspaceId, patch) => {
    harness.writes.push({ workspaceId, patch })
    await gate.promise
  }
  const pendingSave = harness.actions.saveBudgetIncome(9000)
  harness.setContext({ ...context, workspaceId: 'workspace-b' })
  await assert.rejects(harness.actions.saveBudgetIncome(12000), /not ready/)
  harness.setWorkspace(makeWorkspace({ budgetIncome: 12000 }))
  await harness.actions.loadBudgetSettings()
  gate.resolve()
  await assert.rejects(pendingSave, /context changed/)

  assert.deepEqual(harness.writes, [{ workspaceId: context.workspaceId, patch: { budgetIncome: 9000 } }])
  assert.equal(harness.state.budgetIncome, 12000)
})

test('P1 S2 does not overwrite the loaded cache when switching back before settings reload', async () => {
  const harness = makeHarness()
  await harness.actions.loadBudgetSettings()
  const gate = deferredVoid()
  harness.dependencies.writeWorkspaceSettings = async (workspaceId, patch) => {
    harness.writes.push({ workspaceId, patch })
    await gate.promise
  }
  const save = harness.actions.saveBudgetIncome(9000)
    .then(() => undefined, (error: Error) => error.message)

  harness.setContext({ ...context, workspaceId: 'workspace-b' })
  harness.setWorkspace(makeWorkspace({ budgetIncome: 12000 }))
  await harness.actions.loadBudgetSettings()
  const workspaceBSnapshot = structuredClone(harness.state)
  harness.setContext(context) // Active id changes before the sidebar reloads the settings.

  gate.resolve()
  const error = await save
  assert.deepEqual(harness.writes, [{ workspaceId: context.workspaceId, patch: { budgetIncome: 9000 } }])
  assert.deepEqual(harness.state, workspaceBSnapshot, 'an A save must not update the still-loaded B cache')
  assert.match(error ?? '', /not ready/)
})

test('S11 legacy settings saves preserve goals, ratios, category limits, exchange rates, and separate budget state', async () => {
  const budget = makeBudget('monthly-a')
  const harness = makeHarness({ budgets: [budget], caps: { 'monthly-a': { food: 80 } } })
  await harness.actions.loadBudgetSettings()
  const budgetsBefore = structuredClone(harness.state.operatingBudgets)
  const currencyStateBefore = structuredClone(harness.state.categoryBudgetCurrency)
  const settings = {
    budgetIncome: 9000,
    budgetNeedsPercent: 45,
    budgetWantsPercent: 35,
    budgetSavingsPercent: 20,
    budgetAllocations: { goal: 425 },
    categoryBudgets: { food: 600 },
    exchangeRates: { USD: 0.95 }
  }

  await harness.actions.saveLegacySettings(settings)

  assert.deepEqual(Object.keys(harness.writes[0]!.patch).sort(), [
    'budgetAllocations', 'budgetIncome', 'budgetNeedsPercent', 'budgetSavingsPercent',
    'budgetWantsPercent', 'categoryBudgets', 'exchangeRates'
  ])
  assert.deepEqual(harness.writes[0]!.patch, settings)
  assert.deepEqual(harness.state.operatingBudgets, budgetsBefore)
  assert.deepEqual(harness.state.categoryBudgetCurrency, currencyStateBefore)
  assert.equal(harness.state.budgetAllocations.goal, 425)
  assert.equal(harness.state.budgetIncome, 9000)
})

test('S11 a delayed legacy settings save stays on its captured workspace after switching', async () => {
  const workspaceA = makeWorkspace()
  const workspaceB = makeWorkspace({
    currency: 'USD', budgetIncome: 12000, budgetNeedsPercent: 40,
    budgetWantsPercent: 40, budgetSavingsPercent: 20,
    budgetAllocations: { goal: 700 }, categoryBudgets: { home: 700 },
    exchangeRates: { EUR: 1.1 }, categoryBudgetCurrency: 'USD'
  })
  const harness = makeHarness({ workspace: workspaceA })
  await harness.actions.loadBudgetSettings()
  const persisted = new Map<string, Record<string, unknown>>([
    ['workspace-a', { ...workspaceA }],
    ['workspace-b', { ...workspaceB }]
  ])
  const beforeB = structuredClone(workspaceB)
  harness.dependencies.readWorkspaceSettings = async workspaceId =>
    (persisted.get(workspaceId) as GoalsBudgetSettingsDocument | undefined) ?? null
  const gate = deferredVoid()
  const started = deferredVoid()
  harness.dependencies.writeWorkspaceSettings = async (workspaceId, patch) => {
    if (workspaceId === 'workspace-a') {
      started.resolve()
      await gate.promise
    }
    persisted.set(workspaceId, { ...(persisted.get(workspaceId) ?? {}), ...patch })
    harness.writes.push({ workspaceId, patch })
  }
  const pendingSave = harness.actions.saveLegacySettings({
    budgetIncome: 9000, budgetNeedsPercent: 45, budgetWantsPercent: 35,
    budgetSavingsPercent: 20, budgetAllocations: { goal: 425 },
    categoryBudgets: { food: 600 }, exchangeRates: { USD: 0.95 }
  })
  await started.promise

  harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
  harness.setWorkspace(workspaceB)
  await harness.actions.loadBudgetSettings()
  gate.resolve()
  await assert.rejects(pendingSave, /Budget workspace context changed during operation/)

  assert.equal(harness.state.budgetIncome, 12000)
  assert.deepEqual(harness.state.categoryBudgets, { home: 700 })
  assert.deepEqual(persisted.get('workspace-b'), beforeB)
  assert.equal((persisted.get('workspace-a') as Record<string, unknown>).budgetIncome, 9000)
  assert.deepEqual(harness.writes.map(write => write.workspaceId), ['workspace-a'])
})

test('S12-S13 confirm legacy cap currency once without inferring display currency, converting caps, or changing other workspace data', async () => {
  const originalWorkspace = makeWorkspace()
  const harness = makeHarness({ workspace: originalWorkspace })
  await harness.actions.loadBudgetSettings()
  assert.deepEqual(harness.state.categoryBudgetCurrency, { status: 'unconfirmed' })

  assert.equal(await harness.actions.confirmLegacyCategoryBudgetCurrency('COP'), 'confirmed')
  assert.deepEqual(harness.transactionPatches, [{ categoryBudgetCurrency: 'COP' }])
  assert.equal((harness.getWorkspace() as typeof originalWorkspace).currency, 'EUR')
  assert.deepEqual((harness.getWorkspace() as typeof originalWorkspace).categoryBudgets, originalWorkspace.categoryBudgets)
  assert.deepEqual((harness.getWorkspace() as typeof originalWorkspace).exchangeRates, originalWorkspace.exchangeRates)
  assert.deepEqual((harness.getWorkspace() as typeof originalWorkspace).budgetAllocations, originalWorkspace.budgetAllocations)
  const confirmedWorkspace = structuredClone(harness.getWorkspace())

  harness.setWorkspace({ ...(harness.getWorkspace() as typeof originalWorkspace), currency: 'USD' })
  await harness.actions.loadBudgetSettings()
  assert.deepEqual(harness.state.categoryBudgetCurrency, { status: 'confirmed', code: 'COP' })
  assert.equal(await harness.actions.confirmLegacyCategoryBudgetCurrency('COP'), 'unchanged')
  assert.equal(harness.transactionPatches.length, 1)
  await assert.rejects(harness.actions.confirmLegacyCategoryBudgetCurrency('EUR'), /already confirmed as COP/)
  assert.equal(harness.transactionPatches.length, 1)
  assert.deepEqual(harness.getWorkspace(), { ...confirmedWorkspace, currency: 'USD' })
})

test('budget mutations are rejected while the active workspace snapshot is still loading', async () => {
  let resolveRead!: (value: BudgetWorkspaceLegacyData | null) => void
  const harness = makeHarness({
    readAdapterWorkspace: async () => new Promise(resolve => { resolveRead = resolve })
  })
  const loading = harness.actions.loadBudgetSettings()
  assert.equal(harness.state.budgetSettingsLoading, true)
  await assert.rejects(harness.actions.createOperatingBudget({ kind: 'monthly', name: 'Too early', capCurrency: 'USD' }), /not ready/)
  await assert.rejects(harness.actions.saveBudgetIncome(9000), /not ready/)
  resolveRead(makeWorkspace() as BudgetWorkspaceLegacyData)
  await loading
  assert.equal(harness.state.budgetSettingsLoading, false)
  assert.deepEqual(harness.persistenceCalls, [])
  assert.deepEqual(harness.writes, [])
})

test('workspace changes during an older settings read cannot overwrite the newer active workspace state', async () => {
  let resolveFirstRead!: (value: BudgetWorkspaceLegacyData | null) => void
  let firstRead = true
  const workspaceB: BudgetWorkspaceLegacyData = {
    currency: 'USD', categoryBudgets: { home: 700 }, exchangeRates: { EUR: 1.1 }, categoryBudgetCurrency: 'USD'
  }
  const harness = makeHarness({
    readAdapterWorkspace: async workspaceId => {
      if (workspaceId === context.workspaceId && firstRead) {
        firstRead = false
        return new Promise(resolve => { resolveFirstRead = resolve })
      }
      return workspaceId === 'workspace-b' ? workspaceB : makeWorkspace() as BudgetWorkspaceLegacyData
    }
  })

  const staleLoad = harness.actions.loadBudgetSettings()
  harness.setContext({ userId: 'user-b', workspaceId: 'workspace-b' })
  harness.setWorkspace({ ...workspaceB, budgetIncome: 12000, budgetNeedsPercent: 40, budgetWantsPercent: 40, budgetSavingsPercent: 20 })
  await harness.actions.loadBudgetSettings()
  resolveFirstRead(makeWorkspace() as BudgetWorkspaceLegacyData)
  await staleLoad

  assert.deepEqual(harness.state.categoryBudgets, { home: 700 })
  assert.deepEqual(harness.state.categoryBudgetCurrency, { status: 'confirmed', code: 'USD' })
  assert.equal(harness.state.budgetIncome, 12000)
  assert.equal(harness.state.budgetSettingsContextKey, JSON.stringify(['user-b', 'workspace-b']))
})

test('moving a linked account releases it from its previous budget in the same save', async () => {
  const previous = makeBudget('event-a', { kind: 'event', linkedAccountIds: ['cash-1', 'cash-2'] })
  const harness = makeHarness({ budgets: [previous] })
  await harness.actions.loadBudgetSettings()
  const created = await harness.actions.createOperatingBudget(
    { kind: 'event', name: 'Fiesta', capCurrency: 'USD', linkedAccountIds: ['cash-1'] },
    { releases: [{ budgetId: 'event-a', linkedAccountIds: ['cash-2'] }] }
  )
  assert.deepEqual(harness.persistenceCalls.at(-1), {
    operation: 'create', workspaceId: context.workspaceId, releases: [{ budgetId: 'event-a', linkedAccountIds: ['cash-2'] }]
  })
  const linksOf = (budgetId: string) => harness.state.operatingBudgets.find(entry => entry.budget.id === budgetId)?.budget.linkedAccountIds
  assert.deepEqual(linksOf('event-a'), ['cash-2'])
  assert.deepEqual(linksOf(created.id), ['cash-1'])

  await harness.actions.updateOperatingBudget(created.id, { linkedAccountIds: ['cash-1', 'cash-2'] }, {
    releases: [{ budgetId: 'event-a', linkedAccountIds: [] }]
  })
  assert.equal(harness.persistenceCalls.filter(call => call.operation === 'patch').length, 1)
  assert.equal(linksOf('event-a'), undefined)
  assert.deepEqual(linksOf(created.id), ['cash-1', 'cash-2'])
})

test('S10: saveLegacySettings preserves exchangeRatesBaseCurrency when omitted, sets it when provided, and clears it to null', async () => {
  const harness = makeHarness({
    workspace: makeWorkspace({ exchangeRates: { USD: 4000 }, exchangeRatesBaseCurrency: 'COP' })
  })
  await harness.actions.loadBudgetSettings()
  assert.equal(harness.state.exchangeRatesBaseCurrency, 'COP')

  // Omitting exchangeRatesBaseCurrency leaves both Firestore and Pinia state intact.
  await harness.actions.saveLegacySettings({
    budgetIncome: 9000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
    budgetAllocations: {}, categoryBudgets: { food: 500 }, exchangeRates: { USD: 4000 }
  })
  assert.equal(harness.state.exchangeRatesBaseCurrency, 'COP')
  assert.equal('exchangeRatesBaseCurrency' in harness.writes.at(-1)!.patch, false)

  // Providing a new base updates it; passing null clears it.
  await harness.actions.saveLegacySettings({
    budgetIncome: 9000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
    budgetAllocations: {}, categoryBudgets: { food: 500 }, exchangeRates: { EUR: 1.1 },
    exchangeRatesBaseCurrency: 'USD'
  })
  assert.equal(harness.state.exchangeRatesBaseCurrency, 'USD')
  assert.equal(harness.writes.at(-1)!.patch.exchangeRatesBaseCurrency, 'USD')

  await harness.actions.saveLegacySettings({
    budgetIncome: 9000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
    budgetAllocations: {}, categoryBudgets: { food: 500 }, exchangeRates: {},
    exchangeRatesBaseCurrency: null
  })
  assert.equal(harness.state.exchangeRatesBaseCurrency, null)
  assert.equal(harness.writes.at(-1)!.patch.exchangeRatesBaseCurrency, null)
})

// S8.2: the real store with Firestore and the auth store replaced by fakes; each goals read waits
// until the test answers it, so loads for different workspaces can resolve in any order.
const requireModule = createRequire(import.meta.url)
const goalsStoreScript = ts.transpile(
  readFileSync(new URL('./goalsStore.ts', import.meta.url), 'utf8'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
)
type StoredGoal = Record<string, unknown>
type PendingGoalsRead = { workspaceId: unknown; answer(rows: Record<string, StoredGoal>): void; fail(): void }
// A Firestore Timestamp instance, for reads that check `instanceof Timestamp`.
class FakeTimestamp {
  value: Date
  constructor(value: Date) { this.value = value }
  toDate() { return this.value }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

const loadGoalsStore = (t: TestContext) => {
  const authStore = { activeWorkspaceId: 'workspace-a' as string | null }
  const auth = { currentUser: { uid: 'user-a' } as { uid: string } | null }
  const reads: PendingGoalsRead[] = []
  const firestore = {
    collection: (_db: unknown, name: string) => ({ name }),
    where: (field: string, _operator: string, value: unknown) => ({ field, value }),
    query: (ref: { name: string }, ...constraints: Array<{ field: string; value: unknown }>) => {
      assert.equal(ref.name, 'goals')
      return { workspaceId: constraints.find(constraint => constraint.field === 'workspaceId')?.value }
    },
    getDocs: (q: { workspaceId: unknown }) => new Promise((resolve, reject) => {
      reads.push({
        ...q,
        answer: rows => resolve({
          forEach: (callback: (snap: { id: string; data(): StoredGoal }) => void) =>
            Object.entries(rows).forEach(([id, data]) => callback({ id, data: () => ({ ...data }) }))
        }),
        fail: () => reject(new Error('unavailable'))
      })
    }),
    Timestamp: FakeTimestamp
  }
  const storeModule = {} as typeof import('./goalsStore.ts')
  new Function('exports', 'require', goalsStoreScript)(storeModule, (id: string) => {
    if (id === '../lib/firebase.ts') return { db: {}, auth }
    if (id === './authStore.ts') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return firestore
    return requireModule(id)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  return { store: storeModule.useGoalsStore(pinia), authStore, auth, reads }
}

const storedGoal = (workspaceId: string, name: string, extra: StoredGoal = {}): StoredGoal => ({
  workspaceId, userId: 'user-a', name, targetAmount: 1000, currentAmount: 250, currency: 'COP',
  targetDate: new FakeTimestamp(new Date(2027, 5, 30)), createdAt: new Date(2026, 0, 2), ...extra
})
const goalRows = (workspaceId: string, name: string) => ({ [`${workspaceId}-${name}`]: storedGoal(workspaceId, name) })

test('S8.2: a slow fetchGoals for the previous workspace that resolves after the switch leaves the new workspace goals', async t => {
  const { store, authStore, reads } = loadGoalsStore(t)
  const previous = store.fetchGoals()
  await flush()
  authStore.activeWorkspaceId = 'workspace-b'
  const current = store.fetchGoals()
  await flush()
  assert.deepEqual(reads.map(read => read.workspaceId), ['workspace-a', 'workspace-b'])

  reads[1].answer(goalRows('workspace-b', 'B'))
  await current
  reads[0].answer(goalRows('workspace-a', 'A'))
  await previous

  assert.deepEqual(store.goals.map(goal => goal.name), ['B'])
  assert.equal(store.loading, false)
})

test('S8.2: after switching away and back, only the newest fetchGoals shows goals and ends loading', async t => {
  const { store, authStore, reads } = loadGoalsStore(t)
  const older = store.fetchGoals()
  await flush()
  authStore.activeWorkspaceId = 'workspace-b'
  const other = store.fetchGoals()
  await flush()
  authStore.activeWorkspaceId = 'workspace-a'
  const newest = store.fetchGoals()
  await flush()

  reads[0].answer(goalRows('workspace-a', 'older'))
  await older
  assert.deepEqual(store.goals, [], 'a superseded load of the same workspace changes nothing')
  assert.equal(store.loading, true, 'the newest load is still running')
  reads[1].answer(goalRows('workspace-b', 'B'))
  await other
  assert.deepEqual(store.goals, [], 'the other workspace load changes nothing')
  assert.equal(store.loading, true, 'the newest load is still running')
  reads[2].answer(goalRows('workspace-a', 'newest'))
  await newest
  assert.deepEqual(store.goals.map(goal => goal.name), ['newest'])
  assert.equal(store.loading, false)
})

test('S8.2: a normal fetchGoals load shows the workspace goals as before', async t => {
  const { store, reads } = loadGoalsStore(t)
  const loading = store.fetchGoals()
  await flush()
  assert.equal(store.loading, true)
  assert.deepEqual(reads.map(read => read.workspaceId), ['workspace-a'])

  const createdAt = new Date(2026, 1, 3)
  reads[0].answer({
    trip: storedGoal('workspace-a', 'Viaje', { targetAmount: '5000', createdAt: new FakeTimestamp(createdAt) }),
    car: storedGoal('workspace-a', 'Carro', { currentAmount: undefined, currency: undefined, linkedAccountId: 'savings' })
  })
  await loading

  assert.deepEqual(store.goals, [
    { id: 'trip', userId: 'user-a', name: 'Viaje', targetAmount: 5000, currentAmount: 250, currency: 'COP', targetDate: new Date(2027, 5, 30), createdAt },
    { id: 'car', userId: 'user-a', name: 'Carro', targetAmount: 1000, currentAmount: 0, currency: 'USD', targetDate: new Date(2027, 5, 30), createdAt: new Date(2026, 0, 2), linkedAccountId: 'savings' }
  ])
  assert.equal(store.loading, false)
})

test('S8.2: a fetchGoals that ends after logout, or after another user signs in, shows nothing and ends loading', async t => {
  for (const signOut of ['logout', 'other user'] as const) {
    const { store, authStore, auth, reads } = loadGoalsStore(t)
    const loading = store.fetchGoals()
    await flush()
    if (signOut === 'logout') {
      auth.currentUser = null
      authStore.activeWorkspaceId = null
    } else {
      auth.currentUser = { uid: 'user-b' }
    }
    reads[0].answer(goalRows('workspace-a', 'A'))
    await loading
    assert.deepEqual(store.goals, [], signOut)
    assert.equal(store.loading, false, signOut)
  }
})

test('S8.2 (current behavior): when the fetchGoals after a switch fails, the previous workspace goals stay', async t => {
  t.mock.method(console, 'error', () => {})
  const { store, authStore, reads } = loadGoalsStore(t)
  const first = store.fetchGoals()
  await flush()
  reads[0].answer(goalRows('workspace-a', 'A'))
  await first
  authStore.activeWorkspaceId = 'workspace-b'
  const failed = store.fetchGoals()
  await flush()
  reads[1].fail()
  await failed
  assert.deepEqual(store.goals.map(goal => goal.name), ['A'])
  assert.equal(store.loading, false)
})
