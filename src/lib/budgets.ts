import { expenseAmountForMonth, type CardBillingLookup, type InstallmentTransaction } from './installments.ts'
import type { OperatingBudgetKind } from '../types.ts'

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

/** Active budget an account is linked to: every movement of that account belongs to it. */
export const linkedBudgetForAccount = <T extends LinkableBudget>(
  budgets: readonly T[],
  accountId: string
): T | null => {
  if (!accountId) return null
  return budgets.find(budget => !budget.archived && budget.linkedAccountIds?.includes(accountId)) ?? null
}

/** Budget a new movement from this account inherits: its active linked budget, else the default. */
export const budgetIdForAccount = (budgets: readonly LinkableBudget[], accountId: string): string =>
  linkedBudgetForAccount(budgets, accountId)?.id ?? DEFAULT_MONTHLY_BUDGET_ID

/** A movement of a linked account can only belong to that account's budget. */
export const canAssignBudget = (budgets: readonly LinkableBudget[], accountId: string, budgetId: string): boolean => {
  const linked = linkedBudgetForAccount(budgets, accountId)
  return !linked || linked.id === budgetId
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

/**
 * Budgets paid by their own income in the period, so their spending does not count against the
 * month's income: an event budget with any assigned income, a monthly budget with assigned income
 * in that month. Unknown budgets (kindOf returns undefined) never qualify.
 */
export const selfFundedBudgetIds = (
  transactions: Iterable<{ type: string; budgetId?: string | null; date: Date }>,
  period: { year: number; month: number; kindOf: (budgetId: string) => OperatingBudgetKind | undefined }
): Set<string> => {
  const funded = new Set<string>()
  for (const t of transactions) {
    const budgetId = resolveBudgetId(t.budgetId)
    if (t.type !== 'income' || budgetId === DEFAULT_MONTHLY_BUDGET_ID || funded.has(budgetId)) continue
    const kind = period.kindOf(budgetId)
    const inPeriod = t.date.getFullYear() === period.year && t.date.getMonth() === period.month
    if (kind === 'event' || (kind === 'monthly' && inPeriod)) funded.add(budgetId)
  }
  return funded
}

export interface BudgetMoveCandidate {
  type: string
  accountId: string
  categoryId?: string | null
  budgetId?: string | null
  date: Date
}

/**
 * Default-budget movements an event budget can take over: any expense or income from a linked
 * account and, when the budget has dates, any expense in a capped category, within the budget's
 * dates (end day inclusive). An undated budget never sweeps a category's whole history.
 */
export const budgetMoveCandidates = <T extends BudgetMoveCandidate>(
  transactions: readonly T[],
  options: { linkedAccountIds: readonly string[]; categoryIds: readonly string[]; startDate?: Date | null; endDate?: Date | null }
): T[] => {
  const linked = new Set(options.linkedAccountIds)
  const capped = new Set(options.startDate || options.endDate ? options.categoryIds : [])
  const start = options.startDate?.getTime() ?? -Infinity
  const end = options.endDate
    ? new Date(options.endDate.getFullYear(), options.endDate.getMonth(), options.endDate.getDate() + 1).getTime()
    : Infinity
  return transactions.filter(transaction => {
    if (!canCarryBudget(transaction.type) || resolveBudgetId(transaction.budgetId) !== DEFAULT_MONTHLY_BUDGET_ID) return false
    const time = transaction.date.getTime()
    if (time < start || time >= end) return false
    return linked.has(transaction.accountId)
      || (transaction.type === 'expense' && !!transaction.categoryId && capped.has(transaction.categoryId))
  })
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

/**
 * Funds of a budget: income explicitly assigned to it. Event budgets add every such income;
 * monthly budgets only the income dated in the given calendar month. The default budget
 * has no funds, because unassigned income is the monthly income.
 */
export const budgetFundsAllocation = (
  transactions: readonly BudgetExpenseTransaction[],
  budgetId: string,
  kind: 'monthly' | 'event',
  year: number,
  month: number,
  convert?: BudgetCurrencyConverter
): { total: number; count: number } => {
  let total = 0
  let count = 0
  if (budgetId === DEFAULT_MONTHLY_BUDGET_ID) return { total, count }

  for (const transaction of transactions) {
    if (transaction.type !== 'income' || transaction.budgetId !== budgetId) continue
    if (kind === 'monthly') {
      const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date)
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month) continue
    }
    const amount = Math.abs(transaction.amount)
    total += convert ? convert(amount, transaction.currency) : amount
    count += 1
  }

  return { total, count }
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
