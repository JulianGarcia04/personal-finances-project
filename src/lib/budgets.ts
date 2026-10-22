import { expenseAmountForMonth, type CardBillingLookup, type InstallmentTransaction } from './installments.ts'

export const DEFAULT_MONTHLY_BUDGET_ID = 'default-monthly'

export const resolveBudgetId = (budgetId?: string | null): string =>
  budgetId ?? DEFAULT_MONTHLY_BUDGET_ID

export type BudgetCarryingType = 'expense' | 'income'

/** Only expenses and income belong to a budget; transfers and loans never do. */
export const canCarryBudget = (type: string): type is BudgetCarryingType =>
  type === 'expense' || type === 'income'

export interface LinkableBudget {
  id: string
  name: string
  archived: boolean
  linkedAccountIds?: readonly string[]
}

/** Budget a new movement from this account inherits: its active linked budget, else the default. */
export const budgetIdForAccount = (budgets: readonly LinkableBudget[], accountId: string): string => {
  if (!accountId) return DEFAULT_MONTHLY_BUDGET_ID
  const linked = budgets.find(budget => !budget.archived && budget.linkedAccountIds?.includes(accountId))
  return linked?.id ?? DEFAULT_MONTHLY_BUDGET_ID
}

export interface LinkedAccountConflict {
  accountId: string
  budgetId: string
  budgetName: string
}

/** Accounts already linked to another active budget (an account belongs to at most one). */
export const linkedAccountConflicts = (
  budgets: readonly LinkableBudget[],
  accountIds: readonly string[],
  ownBudgetId?: string
): LinkedAccountConflict[] => {
  const conflicts: LinkedAccountConflict[] = []
  for (const accountId of accountIds) {
    const owner = budgets.find(budget =>
      budget.id !== ownBudgetId && !budget.archived && budget.linkedAccountIds?.includes(accountId))
    if (owner) conflicts.push({ accountId, budgetId: owner.id, budgetName: owner.name })
  }
  return conflicts
}

/** The default budget is the absence of a reference, so it is stored as null. */
export const budgetIdToPersist = (type: string, budgetId?: string | null): string | null =>
  canCarryBudget(type) && budgetId && budgetId !== DEFAULT_MONTHLY_BUDGET_ID ? budgetId : null

export interface BudgetExpenseTransaction extends InstallmentTransaction {
  budgetId?: string | null
  categoryId?: string | null
  currency: string
}

export type BudgetCurrencyConverter = (positiveAmount: number, currency: string) => number

export interface BudgetAllocationSummary {
  total: number
  byCategory: Record<string, number>
}

const emptySummary = (): BudgetAllocationSummary => ({ total: 0, byCategory: {} })

const addExpenseAmount = (
  summary: BudgetAllocationSummary,
  transaction: BudgetExpenseTransaction,
  positiveAmount: number,
  convert?: BudgetCurrencyConverter
) => {
  const amount = convert ? convert(positiveAmount, transaction.currency) : positiveAmount
  summary.total += amount
  const categoryId = transaction.categoryId
  if (categoryId) {
    const categoryTotal = (Object.hasOwn(summary.byCategory, categoryId)
      ? summary.byCategory[categoryId]
      : 0) + amount
    Object.defineProperty(summary.byCategory, categoryId, {
      value: categoryTotal,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
}

export const monthlyBudgetAllocation = (
  transactions: readonly BudgetExpenseTransaction[],
  budgetId: string,
  year: number,
  month: number,
  convert?: BudgetCurrencyConverter,
  billingFor?: CardBillingLookup
): BudgetAllocationSummary => {
  const summary = emptySummary()

  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || resolveBudgetId(transaction.budgetId) !== budgetId) continue
    const amount = expenseAmountForMonth(transaction, year, month, billingFor?.(transaction.accountId))
    if (amount === 0) continue
    addExpenseAmount(summary, transaction, amount, convert)
  }

  return summary
}

export const eventBudgetCommittedAllocation = (
  transactions: readonly BudgetExpenseTransaction[],
  budgetId: string,
  convert?: BudgetCurrencyConverter
): BudgetAllocationSummary => {
  const summary = emptySummary()

  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || transaction.budgetId !== budgetId) continue
    const amount = Math.abs(transaction.amount)
    if (amount === 0) continue
    addExpenseAmount(summary, transaction, amount, convert)
  }

  return summary
}

export const allBudgetsEstimatedMonthlyTotal = (
  transactions: readonly BudgetExpenseTransaction[],
  year: number,
  month: number,
  convert?: BudgetCurrencyConverter,
  billingFor?: CardBillingLookup
): number => {
  const summary = emptySummary()

  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue
    const amount = expenseAmountForMonth(transaction, year, month, billingFor?.(transaction.accountId))
    if (amount === 0) continue
    addExpenseAmount(summary, transaction, amount, convert)
  }

  return summary.total
}
