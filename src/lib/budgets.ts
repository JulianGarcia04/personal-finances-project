import { expenseAmountForMonth, type InstallmentTransaction } from './installments.ts'

export const DEFAULT_MONTHLY_BUDGET_ID = 'default-monthly'

export const resolveBudgetId = (budgetId?: string | null): string =>
  budgetId ?? DEFAULT_MONTHLY_BUDGET_ID

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
  convert?: BudgetCurrencyConverter
): BudgetAllocationSummary => {
  const summary = emptySummary()

  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || resolveBudgetId(transaction.budgetId) !== budgetId) continue
    const amount = expenseAmountForMonth(transaction, year, month)
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
  convert?: BudgetCurrencyConverter
): number => {
  const summary = emptySummary()

  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue
    const amount = expenseAmountForMonth(transaction, year, month)
    if (amount === 0) continue
    addExpenseAmount(summary, transaction, amount, convert)
  }

  return summary.total
}
