import { OperatingBudgetDraftSchema } from '../schemas.ts'
import type { OperatingBudget, Workspace } from '../types.ts'

/** Identity captured for one adapter operation; both fields must still be active after async work. */
export interface BudgetWorkspaceContext {
  readonly userId: string
  readonly workspaceId: string
}

/**
 * Workspace fields this boundary reads. `currency` is intentionally not a source for the legacy
 * category-cap unit; only an explicit `categoryBudgetCurrency` confirms that denomination.
 */
export interface BudgetWorkspaceLegacyData extends Partial<Pick<Workspace, 'currency' | 'categoryBudgetCurrency'>> {
  readonly categoryBudgets?: Readonly<Record<string, number>>
  readonly exchangeRates?: Readonly<Record<string, number>>
}

/** The only field an unconfirmed legacy-unit transaction may update. */
export interface CategoryBudgetCurrencyPatch {
  readonly categoryBudgetCurrency: string
}

/** Pure confirmation outcome; a confirmed same-unit plan deliberately has no patch. */
export type CategoryBudgetCurrencyPlan =
  | { readonly status: 'confirmed'; readonly patch: CategoryBudgetCurrencyPatch }
  | { readonly status: 'unchanged' }

/** Explicit legacy cap-unit state. An absent stored field is represented as `unconfirmed`. */
export type CategoryBudgetCurrencyState =
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'confirmed'; readonly code: string }

/** Additional budget and its persisted category-cap map, including archived records. */
export interface BudgetWorkspaceBudgetSnapshot {
  readonly budget: OperatingBudget
  readonly categoryCaps: Readonly<Record<string, number>>
}

/**
 * Read-only workspace slice. `budgets` contains only records returned by the additional-budget
 * persistence factory; the protected default monthly baseline remains in `legacy.categoryBudgets`.
 */
export interface BudgetWorkspaceSnapshot {
  readonly context: Readonly<BudgetWorkspaceContext>
  readonly budgets: readonly BudgetWorkspaceBudgetSnapshot[]
  readonly legacy: {
    readonly categoryBudgets: Readonly<Record<string, number>>
    readonly exchangeRates: Readonly<Record<string, number>>
    readonly categoryBudgetCurrency: CategoryBudgetCurrencyState
  }
}

/**
 * Ports for the later SDK/Pinia binding. Supply the closed budget and cap persistence factories,
 * the authoritative workspace reader, and an atomic transaction runner that invokes the callback
 * with the current workspace state and applies its patch in that same transaction. The callback
 * is synchronous so context is rechecked immediately around each possible write and retry.
 */
export interface BudgetWorkspaceAdapterDependencies {
  getCurrentContext(): BudgetWorkspaceContext | null | undefined
  readWorkspace(workspaceId: string): Promise<BudgetWorkspaceLegacyData | null>
  createBudgetPersistence(workspaceId: string): {
    list(): Promise<readonly OperatingBudget[]>
  }
  createBudgetCategoryCapsPersistence(workspaceId: string): {
    list(budgetId: string): Promise<Readonly<Record<string, number>>>
  }
  runLegacyWorkspaceTransaction<T>(
    context: Readonly<BudgetWorkspaceContext>,
    callback: (
      workspace: BudgetWorkspaceLegacyData,
      update: (patch: CategoryBudgetCurrencyPatch) => void
    ) => T
  ): Promise<T>
}

/** Read/confirm surface for a later concrete binding; it holds no optimistic or cached state. */
export interface BudgetWorkspaceAdapter {
  /** Reads the current workspace, every additional record (archived included), and each cap map. */
  loadSnapshot(): Promise<BudgetWorkspaceSnapshot>
  /** Confirms the legacy category-cap unit once; same-unit calls are no-ops, conflicts reject. */
  confirmLegacyCategoryBudgetCurrency(code: string): Promise<'confirmed' | 'unchanged'>
}

const isValidBudgetCurrency = (value: unknown): value is string => typeof value === 'string' &&
  OperatingBudgetDraftSchema.safeParse({
    kind: 'monthly',
    name: 'Currency confirmation',
    capCurrency: value
  }).success

function assertRequestedCurrency(value: unknown): asserts value is string {
  if (!isValidBudgetCurrency(value)) throw new Error('Invalid budget currency code')
}

const assertCurrentContext = (
  getCurrentContext: BudgetWorkspaceAdapterDependencies['getCurrentContext'],
  captured: Readonly<BudgetWorkspaceContext>
): void => {
  const current = getCurrentContext()
  if (!current || current.userId !== captured.userId || current.workspaceId !== captured.workspaceId) {
    throw new Error('Budget workspace context changed during operation')
  }
}

const captureContext = (
  getCurrentContext: BudgetWorkspaceAdapterDependencies['getCurrentContext']
): Readonly<BudgetWorkspaceContext> => {
  const current = getCurrentContext()
  if (!current || !current.userId.trim() || !current.workspaceId.trim()) {
    throw new Error('Active budget workspace context is required')
  }
  return { userId: current.userId, workspaceId: current.workspaceId }
}

const copyNumericRecord = (record: Readonly<Record<string, number>> | undefined): Record<string, number> => ({
  ...(record ?? {})
})

const categoryCurrencyState = (workspace: BudgetWorkspaceLegacyData): CategoryBudgetCurrencyState => {
  if (!Object.hasOwn(workspace, 'categoryBudgetCurrency')) return { status: 'unconfirmed' }

  const storedCode: unknown = workspace.categoryBudgetCurrency
  if (!isValidBudgetCurrency(storedCode)) throw new Error('Stored category budget currency is invalid')
  return { status: 'confirmed', code: storedCode }
}

/**
 * Plans the one-time legacy denomination update. It never consults workspace/profile display
 * currency, rewrites amounts, or converts rates. Use this synchronous planner from a transaction.
 */
export function planLegacyCategoryBudgetCurrencyConfirmation(
  workspace: BudgetWorkspaceLegacyData,
  requestedCode: string
): CategoryBudgetCurrencyPlan {
  assertRequestedCurrency(requestedCode)
  if (!Object.hasOwn(workspace, 'categoryBudgetCurrency')) {
    return { status: 'confirmed', patch: { categoryBudgetCurrency: requestedCode } }
  }

  const storedCode: unknown = workspace.categoryBudgetCurrency
  if (!isValidBudgetCurrency(storedCode)) throw new Error('Stored category budget currency is invalid')
  if (storedCode === requestedCode) return { status: 'unchanged' }
  throw new Error(`Category budget currency is already confirmed as ${storedCode}`)
}

/**
 * Composes the closed additional-budget/cap readers with the authoritative legacy workspace
 * projection. It performs reads only; confirmation writes exactly the explicit currency metadata
 * through the injected atomic transaction callback and propagates persistence failures unchanged.
 */
export function createBudgetWorkspaceAdapter(
  dependencies: BudgetWorkspaceAdapterDependencies
): BudgetWorkspaceAdapter {
  return {
    async loadSnapshot(): Promise<BudgetWorkspaceSnapshot> {
      const context = captureContext(dependencies.getCurrentContext)
      assertCurrentContext(dependencies.getCurrentContext, context)
      const workspace = await dependencies.readWorkspace(context.workspaceId)
      assertCurrentContext(dependencies.getCurrentContext, context)
      if (!workspace) throw new Error('Workspace not found')

      const budgetPersistence = dependencies.createBudgetPersistence(context.workspaceId)
      assertCurrentContext(dependencies.getCurrentContext, context)
      const categoryCapsPersistence = dependencies.createBudgetCategoryCapsPersistence(context.workspaceId)
      assertCurrentContext(dependencies.getCurrentContext, context)
      const budgets = await budgetPersistence.list()
      assertCurrentContext(dependencies.getCurrentContext, context)

      const budgetSnapshots: BudgetWorkspaceBudgetSnapshot[] = []
      for (const budget of budgets) {
        assertCurrentContext(dependencies.getCurrentContext, context)
        const categoryCaps = await categoryCapsPersistence.list(budget.id)
        assertCurrentContext(dependencies.getCurrentContext, context)
        budgetSnapshots.push({ budget, categoryCaps: copyNumericRecord(categoryCaps) })
      }
      assertCurrentContext(dependencies.getCurrentContext, context)

      return {
        context: { ...context },
        budgets: budgetSnapshots,
        legacy: {
          categoryBudgets: copyNumericRecord(workspace.categoryBudgets),
          exchangeRates: copyNumericRecord(workspace.exchangeRates),
          categoryBudgetCurrency: categoryCurrencyState(workspace)
        }
      }
    },

    async confirmLegacyCategoryBudgetCurrency(code: string): Promise<'confirmed' | 'unchanged'> {
      assertRequestedCurrency(code)
      const context = captureContext(dependencies.getCurrentContext)
      assertCurrentContext(dependencies.getCurrentContext, context)

      const result = await dependencies.runLegacyWorkspaceTransaction(context, (workspace, update) => {
        // The transaction runner may invoke this callback again after a retry.
        assertCurrentContext(dependencies.getCurrentContext, context)
        const plan = planLegacyCategoryBudgetCurrencyConfirmation(workspace, code)
        if (plan.status === 'unchanged') {
          assertCurrentContext(dependencies.getCurrentContext, context)
          return 'unchanged'
        }

        assertCurrentContext(dependencies.getCurrentContext, context)
        update(plan.patch)
        assertCurrentContext(dependencies.getCurrentContext, context)
        return 'confirmed'
      })
      assertCurrentContext(dependencies.getCurrentContext, context)
      return result
    }
  }
}
