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

export type EditBudgetChange =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'set'; budgetId: string }

/**
 * Budget an edited movement carries, decided in the same write as the financial edit (the rules
 * accept a budget change next to other fields only in these cases): transfers and loans carry
 * none, a movement of a linked account takes that account's budget, and switching between
 * expense and income leaves the old budget.
 */
export const budgetChangeForEdit = (edit: {
  fromType: string
  toType: string
  linkedBudgetId: string | null
}): EditBudgetChange => {
  if (!canCarryBudget(edit.toType)) return { action: 'clear' }
  if (edit.linkedBudgetId) return { action: 'set', budgetId: edit.linkedBudgetId }
  if (canCarryBudget(edit.fromType) && edit.fromType !== edit.toType) return { action: 'clear' }
  return { action: 'keep' }
}

/** Accounts that join and leave a budget when its links change; order alone is no change. */
export const linkedAccountsChange = (
  before: readonly string[] | undefined,
  after: readonly string[]
): { changed: boolean; added: string[]; removed: string[] } => {
  const previous = new Set(before ?? [])
  const next = new Set(after)
  const added = [...next].filter(id => !previous.has(id))
  const removed = [...previous].filter(id => !next.has(id))
  return { changed: added.length > 0 || removed.length > 0, added, removed }
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
 * Budgets paid by their own funds in the period, so their spending does not count against the
 * month's income: an event budget with any funding inflow (assigned income or a transfer into a
 * linked account), a monthly budget with one in that month. Unknown budgets never qualify.
 */
export const selfFundedBudgetIds = (
  transactions: Iterable<Pick<BudgetExpenseTransaction, 'type' | 'amount' | 'budgetId' | 'date' | 'accountId' | 'toAccountId'>>,
  period: {
    year: number
    month: number
    kindOf: (budgetId: string) => OperatingBudgetKind | undefined
    linkedBudgetOf?: LinkedBudgetLookup
  }
): Set<string> => {
  const funded = new Set<string>()
  for (const t of transactions) {
    // Funding inflows: assigned income, or a transfer into a budget's linked account.
    const linkedTo = t.type === 'transfer' && t.toAccountId && period.linkedBudgetOf ? period.linkedBudgetOf(t.toAccountId) : null
    const budgetId = t.type === 'income' ? resolveBudgetId(t.budgetId)
      : linkedTo && transferFundsDelta(t, linkedTo, period.linkedBudgetOf!) > 0 ? linkedTo
      : DEFAULT_MONTHLY_BUDGET_ID
    if (budgetId === DEFAULT_MONTHLY_BUDGET_ID || funded.has(budgetId)) continue
    const kind = period.kindOf(budgetId)
    const inPeriod = t.date.getFullYear() === period.year && t.date.getMonth() === period.month
    if (kind === 'event' || (kind === 'monthly' && inPeriod)) funded.add(budgetId)
  }
  return funded
}

/**
 * Which movements of a month count when it is seen by budget: income assigned to another budget
 * only funds that budget, and spending of a budget self-funded in the month is paid by its own
 * funds. Shared by the Goals planner and the Dashboard "Por presupuesto" view.
 */
export const budgetScopedMonthFilter = (
  transactions: Parameters<typeof selfFundedBudgetIds>[0],
  period: Parameters<typeof selfFundedBudgetIds>[1]
) => {
  const selfFunded = selfFundedBudgetIds(transactions, period)
  return {
    selfFunded,
    countsIncome: (transaction: { budgetId?: string | null }) =>
      resolveBudgetId(transaction.budgetId) === DEFAULT_MONTHLY_BUDGET_ID,
    countsExpense: (transaction: { budgetId?: string | null }) =>
      !selfFunded.has(resolveBudgetId(transaction.budgetId))
  }
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
  toAccountId?: string | null
}

/** Active budget each account is linked to, or null. */
export type LinkedBudgetLookup = (accountId: string) => string | null

/**
 * How a transfer moves a budget's funds, by the accounts it touches (never by its stored sign):
 * into an account linked to the budget adds, out of it subtracts, and between two accounts of the
 * same budget the money never leaves it.
 */
export const transferFundsDelta = (
  transaction: Pick<BudgetExpenseTransaction, 'type' | 'amount' | 'accountId' | 'toAccountId'>,
  budgetId: string,
  linkedBudgetOf: LinkedBudgetLookup
): number => {
  if (transaction.type !== 'transfer' || !transaction.accountId || !transaction.toAccountId) return 0
  const from = linkedBudgetOf(transaction.accountId)
  const to = linkedBudgetOf(transaction.toAccountId)
  if (from === to) return 0
  const amount = Math.abs(transaction.amount)
  if (to === budgetId) return amount
  if (from === budgetId) return -amount
  return 0
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
  convert?: BudgetCurrencyConverter,
  linkedBudgetOf?: LinkedBudgetLookup
): { total: number; count: number } => {
  let total = 0
  let count = 0
  if (budgetId === DEFAULT_MONTHLY_BUDGET_ID) return { total, count }

  for (const transaction of transactions) {
    // Assigned income adds; transfers add or subtract by the linked accounts they touch.
    const delta = transaction.type === 'income'
      ? (transaction.budgetId === budgetId ? Math.abs(transaction.amount) : 0)
      : linkedBudgetOf ? transferFundsDelta(transaction, budgetId, linkedBudgetOf) : 0
    if (delta === 0) continue
    if (kind === 'monthly') {
      const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date)
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month) continue
    }
    const converted = convert ? convert(Math.abs(delta), transaction.currency) : Math.abs(delta)
    total += delta > 0 ? converted : -converted
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
