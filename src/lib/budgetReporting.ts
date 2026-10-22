import {
  allBudgetsEstimatedMonthlyTotal,
  budgetFundsAllocation,
  type LinkedBudgetLookup,
  eventBudgetCommittedAllocation,
  monthlyBudgetAllocation,
  resolveBudgetId,
  type BudgetExpenseTransaction
} from './budgets.ts'
import type { CardBillingLookup } from './installments.ts'

/** Calendar month using the same zero-based month convention as `Date#getMonth`. */
export interface BudgetCalendarPeriod {
  year: number
  month: number
}

/** Minimal scope shape needed to report stored caps without importing a persistence adapter. */
export interface BudgetReportingScope {
  id: string
  kind: 'monthly' | 'event'
  /** Null means the stored cap denomination has not been confirmed. */
  capCurrency: string | null
  totalLimit?: number
}

/** Converted spending in the selected reporting currency; incomplete totals are never exposed. */
export interface BudgetAmountReport {
  amount: number | null
  currency: string
  complete: boolean
  missingRateCurrencies: string[]
  invalidRateCurrencies: string[]
}

/** Original cap amount/unit plus its optional conversion to the current reporting currency. */
export interface BudgetCapReport {
  amount: number
  currency: string | null
  reportingAmount: number | null
  state: 'complete' | 'unconfirmed' | 'missing-rate' | 'invalid-rate'
}

export interface BudgetCapComparison {
  spentAmount: number
  limitAmount: number
  remainingAmount: number
}

export interface BudgetCategoryReport {
  monthlyAllocation: BudgetAmountReport
  /** Full event-assigned category principal; null for monthly scopes. */
  eventCommittedPrincipal: BudgetAmountReport | null
  /** Null means this category has no stored cap; a zero-valued cap remains present. */
  cap: BudgetCapReport | null
  /** Compares monthly allocation or event principal according to the scope kind. */
  comparison: BudgetCapComparison | null
}

export interface BudgetScopeReport {
  scopeId: string
  kind: 'monthly' | 'event'
  period: BudgetCalendarPeriod
  reportingCurrency: string
  /** Monthly installment allocation for this scope, separate from event principal. */
  monthlyAllocation: BudgetAmountReport
  /** Full event-assigned expense principal; null for monthly scopes. */
  eventCommittedPrincipal: BudgetAmountReport | null
  totalCap: BudgetCapReport | null
  totalComparison: BudgetCapComparison | null
  /**
   * Income assigned to this budget plus transfers into its linked accounts minus out; null without
   * any funding inflow in the period (the budget is then cap-only). Negative when more left than came in.
   */
  funds: BudgetAmountReport | null
  /** Funds minus the spending compared against the cap; null without complete funds and spending. */
  available: number | null
  /** Own-property-safe category-ID lookup, including cap-only categories. */
  categories: Record<string, BudgetCategoryReport>
}

export interface BudgetScopeReportInput {
  scope: BudgetReportingScope
  /** Category caps remain nominal values in `scope.capCurrency`. */
  categoryCaps?: Readonly<Record<string, number>>
  transactions: readonly BudgetExpenseTransaction[]
  period: BudgetCalendarPeriod
  reportingCurrency: string
  /** Current manual rates: source currency -> reporting currency. */
  exchangeRates: Readonly<Record<string, number>>
  /** Card billing days by account; billed card installments count in their payment month. */
  cardBilling?: CardBillingLookup
  /** Budget each account is linked to: transfers into or out of those accounts move funds. */
  linkedBudgetOf?: LinkedBudgetLookup
}

export interface AllBudgetsEstimateInput {
  transactions: readonly BudgetExpenseTransaction[]
  period: BudgetCalendarPeriod
  reportingCurrency: string
  /** Current manual rates: source currency -> reporting currency. */
  exchangeRates: Readonly<Record<string, number>>
  /** Card billing days by account; billed card installments count in their payment month. */
  cardBilling?: CardBillingLookup
}

interface RateDiagnostics {
  missing: Set<string>
  invalid: Set<string>
}

type RateLookup = { rate: number } | { state: 'missing-rate' | 'invalid-rate' }

const createDiagnostics = (): RateDiagnostics => ({ missing: new Set(), invalid: new Set() })

const lookupRate = (
  currency: string,
  reportingCurrency: string,
  exchangeRates: Readonly<Record<string, number>>
): RateLookup => {
  if (currency === reportingCurrency) return { rate: 1 }
  if (!Object.hasOwn(exchangeRates, currency)) return { state: 'missing-rate' }

  const rate = exchangeRates[currency]
  return Number.isFinite(rate) && rate > 0
    ? { rate }
    : { state: 'invalid-rate' }
}

const convertOrZero = (
  amount: number,
  currency: string,
  reportingCurrency: string,
  exchangeRates: Readonly<Record<string, number>>,
  diagnostics: RateDiagnostics
): number => {
  const result = lookupRate(currency, reportingCurrency, exchangeRates)
  if ('rate' in result) return amount * result.rate

  if (result.state === 'missing-rate') diagnostics.missing.add(currency)
  else diagnostics.invalid.add(currency)
  // The aggregate is marked incomplete below, so this placeholder is never presented as a total.
  return 0
}

const moneyReport = (
  partialAmount: number,
  currency: string,
  diagnostics: RateDiagnostics
): BudgetAmountReport => {
  const missingRateCurrencies = [...diagnostics.missing].sort()
  const invalidRateCurrencies = [...diagnostics.invalid].sort()
  const complete = missingRateCurrencies.length === 0 && invalidRateCurrencies.length === 0

  return {
    amount: complete ? partialAmount : null,
    currency,
    complete,
    missingRateCurrencies,
    invalidRateCurrencies
  }
}

const capReport = (
  amount: number,
  currency: string | null,
  reportingCurrency: string,
  exchangeRates: Readonly<Record<string, number>>
): BudgetCapReport => {
  if (currency === null) {
    return { amount, currency, reportingAmount: null, state: 'unconfirmed' }
  }

  const result = lookupRate(currency, reportingCurrency, exchangeRates)
  if ('rate' in result) {
    return { amount, currency, reportingAmount: amount * result.rate, state: 'complete' }
  }

  return { amount, currency, reportingAmount: null, state: result.state }
}

const compare = (
  spending: BudgetAmountReport,
  cap: BudgetCapReport | null
): BudgetCapComparison | null => {
  if (cap === null || cap.reportingAmount === null || spending.amount === null) return null

  return {
    spentAmount: spending.amount,
    limitAmount: cap.reportingAmount,
    remainingAmount: cap.reportingAmount - spending.amount
  }
}

const setOwn = <Value>(record: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

/**
 * Reports one monthly or event budget in the current reporting currency.
 * Monthly installments and event committed principal are separate fields. Caps retain their
 * stored nominal amount and confirmed denomination; absent manual rates or unconfirmed units
 * disable comparisons instead of applying a 1:1 fallback.
 */
export const reportBudgetScope = (input: BudgetScopeReportInput): BudgetScopeReport => {
  const { scope, transactions, period, reportingCurrency, exchangeRates, cardBilling } = input
  const monthlyDiagnostics = createDiagnostics()
  const monthlySummary = monthlyBudgetAllocation(
    transactions,
    scope.id,
    period.year,
    period.month,
    (amount, currency) => convertOrZero(
      amount,
      currency,
      reportingCurrency,
      exchangeRates,
      monthlyDiagnostics
    ),
    cardBilling
  )
  const monthlyAllocation = moneyReport(monthlySummary.total, reportingCurrency, monthlyDiagnostics)

  let eventCommittedSummary: ReturnType<typeof eventBudgetCommittedAllocation> | null = null
  let eventCommittedPrincipal: BudgetAmountReport | null = null
  if (scope.kind === 'event') {
    const eventDiagnostics = createDiagnostics()
    eventCommittedSummary = eventBudgetCommittedAllocation(
      transactions,
      scope.id,
      (amount, currency) => convertOrZero(
        amount,
        currency,
        reportingCurrency,
        exchangeRates,
        eventDiagnostics
      )
    )
    eventCommittedPrincipal = moneyReport(eventCommittedSummary.total, reportingCurrency, eventDiagnostics)
  }

  const totalCap = scope.totalLimit === undefined
    ? null
    : capReport(scope.totalLimit, scope.capCurrency, reportingCurrency, exchangeRates)
  const scopeSpending = scope.kind === 'event' ? eventCommittedPrincipal! : monthlyAllocation
  const totalComparison = compare(scopeSpending, totalCap)

  const fundsDiagnostics = createDiagnostics()
  const fundsSummary = budgetFundsAllocation(
    transactions,
    scope.id,
    scope.kind,
    period.year,
    period.month,
    (amount, currency) => convertOrZero(amount, currency, reportingCurrency, exchangeRates, fundsDiagnostics),
    input.linkedBudgetOf
  )
  // Without a funding inflow in the period the budget is unfunded, even if money went out.
  const funds = fundsSummary.inflows === 0
    ? null
    : moneyReport(fundsSummary.total, reportingCurrency, fundsDiagnostics)
  const available = funds?.amount == null || scopeSpending.amount === null
    ? null
    : funds.amount - scopeSpending.amount
  const categories: Record<string, BudgetCategoryReport> = {}
  const categoryIds = new Set([
    ...Object.keys(monthlySummary.byCategory),
    ...Object.keys(eventCommittedSummary?.byCategory ?? {}),
    ...Object.keys(input.categoryCaps ?? {})
  ])

  for (const categoryId of categoryIds) {
    const categoryTransactions = transactions.filter(transaction =>
      transaction.type === 'expense' &&
      resolveBudgetId(transaction.budgetId) === scope.id &&
      transaction.categoryId === categoryId
    )
    const categoryDiagnostics = createDiagnostics()
    const categorySummary = monthlyBudgetAllocation(
      categoryTransactions,
      scope.id,
      period.year,
      period.month,
      (amount, currency) => convertOrZero(
        amount,
        currency,
        reportingCurrency,
        exchangeRates,
        categoryDiagnostics
      ),
      cardBilling
    )
    const monthlyCategoryAllocation = moneyReport(categorySummary.total, reportingCurrency, categoryDiagnostics)
    let eventCategoryPrincipal: BudgetAmountReport | null = null
    if (scope.kind === 'event') {
      const eventCategoryTransactions = transactions.filter(transaction =>
        transaction.type === 'expense' &&
        transaction.budgetId === scope.id &&
        transaction.categoryId === categoryId
      )
      const eventCategoryDiagnostics = createDiagnostics()
      const committedCategory = eventBudgetCommittedAllocation(
        eventCategoryTransactions,
        scope.id,
        (amount, currency) => convertOrZero(
          amount,
          currency,
          reportingCurrency,
          exchangeRates,
          eventCategoryDiagnostics
        )
      )
      eventCategoryPrincipal = moneyReport(committedCategory.total, reportingCurrency, eventCategoryDiagnostics)
    }
    const hasCap = input.categoryCaps !== undefined && Object.hasOwn(input.categoryCaps, categoryId)
    const cap = hasCap
      ? capReport(input.categoryCaps![categoryId], scope.capCurrency, reportingCurrency, exchangeRates)
      : null
    const comparisonSpending = scope.kind === 'event' ? eventCategoryPrincipal! : monthlyCategoryAllocation

    setOwn(categories, categoryId, {
      monthlyAllocation: monthlyCategoryAllocation,
      eventCommittedPrincipal: eventCategoryPrincipal,
      cap,
      comparison: compare(comparisonSpending, cap)
    })
  }

  return {
    scopeId: scope.id,
    kind: scope.kind,
    period: { year: period.year, month: period.month },
    reportingCurrency,
    monthlyAllocation,
    eventCommittedPrincipal,
    totalCap,
    totalComparison,
    funds,
    available,
    categories
  }
}

/**
 * Estimates this calendar month's installments across every expense, including default,
 * unassigned, unknown, and archived budget IDs. Transfers, income, repayments, and event
 * committed principal are not added a second time.
 */
export const reportAllBudgetsEstimatedMonthly = (
  input: AllBudgetsEstimateInput
): BudgetAmountReport => {
  const { transactions, period, reportingCurrency, exchangeRates, cardBilling } = input
  const diagnostics = createDiagnostics()
  const partialTotal = allBudgetsEstimatedMonthlyTotal(
    transactions,
    period.year,
    period.month,
    (amount, currency) => convertOrZero(
      amount,
      currency,
      reportingCurrency,
      exchangeRates,
      diagnostics
    ),
    cardBilling
  )

  return moneyReport(partialTotal, reportingCurrency, diagnostics)
}
