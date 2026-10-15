export const DEFAULT_MONTHLY_BUDGET_ID = 'default-monthly'

const LEGACY_CATEGORY_BUDGET_CURRENCY_PATTERN = /^[A-Z]{3}$/

/** Parse the optional stored cap denomination without treating malformed values as legacy absence. */
export const parseLegacyCategoryBudgetCurrency = (workspace: unknown): string | null => {
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
    throw new Error('Stored workspace data is malformed.')
  }

  if (!Object.prototype.hasOwnProperty.call(workspace, 'categoryBudgetCurrency')) return null

  const currency = (workspace as Record<string, unknown>).categoryBudgetCurrency
  if (typeof currency !== 'string' || !LEGACY_CATEGORY_BUDGET_CURRENCY_PATTERN.test(currency)) {
    throw new Error('Stored category budget currency is malformed.')
  }

  return currency
}

export interface LegacyCategoryExpense {
  readonly budgetId?: unknown
  readonly categoryId?: unknown
  /** Amount accumulated across the requested calendar months, in `currency`. */
  readonly amount: number
  readonly currency: string
}

export interface AnalyzeLegacyCategoryExpensesInput {
  readonly expenses: readonly LegacyCategoryExpense[]
  readonly periodMonths: number
  readonly reportingCurrency: string
  /** Explicitly confirmed denomination for the stored legacy category caps. */
  readonly categoryBudgetCurrency: string | null
  /** Manual source-currency-to-reporting-currency rates. */
  readonly exchangeRates: Readonly<Record<string, number>>
}

export interface LegacyCategorySpendReport {
  readonly categoryId: string
  readonly totalSpent: number | null
  readonly monthlyAverage: number | null
  readonly transactionCount: number
  readonly periodMonths: number
  readonly reportingCurrency: string
  readonly complete: boolean
  readonly missingRateCurrencies: readonly string[]
  readonly invalidRateCurrencies: readonly string[]
}

export interface LegacyCategorySpendAnalysis {
  readonly periodMonths: number
  readonly reportingCurrency: string
  readonly categoryBudgetCurrency: string | null
  readonly complete: boolean
  readonly canProposeCaps: boolean
  readonly missingRateCurrencies: readonly string[]
  readonly invalidRateCurrencies: readonly string[]
  readonly categories: readonly LegacyCategorySpendReport[]
}

interface CategoryTotals {
  amount: number
  transactionCount: number
  missingRateCurrencies: Set<string>
  invalidRateCurrencies: Set<string>
}

const lookupManualRate = (
  sourceCurrency: string,
  reportingCurrency: string,
  exchangeRates: Readonly<Record<string, number>>
): { rate: number } | { state: 'missing-rate' | 'invalid-rate' } => {
  if (sourceCurrency === reportingCurrency) return { rate: 1 }
  if (!Object.prototype.hasOwnProperty.call(exchangeRates, sourceCurrency)) {
    return { state: 'missing-rate' }
  }

  const rate = exchangeRates[sourceCurrency]
  return Number.isFinite(rate) && rate > 0
    ? { rate }
    : { state: 'invalid-rate' }
}

/**
 * Analyze only expenses assigned to the protected default monthly budget, including historical
 * and producer-created expenses with no budgetId. Totals are labeled in the explicit reporting
 * currency; incomplete categories never expose partial amounts, and AI cap proposals are allowed
 * only when that currency matches the confirmed legacy cap denomination.
 */
export const analyzeLegacyCategoryExpenses = (
  input: AnalyzeLegacyCategoryExpensesInput
): LegacyCategorySpendAnalysis => {
  const categoryBudgetCurrency = input.categoryBudgetCurrency === null
    ? null
    : parseLegacyCategoryBudgetCurrency({ categoryBudgetCurrency: input.categoryBudgetCurrency })
  const totals = new Map<string, CategoryTotals>()

  input.expenses.forEach(expense => {
    const isUnassigned = expense.budgetId === undefined || expense.budgetId === null
    if (!isUnassigned && expense.budgetId !== DEFAULT_MONTHLY_BUDGET_ID) return

    const categoryId = typeof expense.categoryId === 'string' && expense.categoryId
      ? expense.categoryId
      : 'sin-categoria'
    let category = totals.get(categoryId)
    if (!category) {
      category = {
        amount: 0,
        transactionCount: 0,
        missingRateCurrencies: new Set(),
        invalidRateCurrencies: new Set()
      }
      totals.set(categoryId, category)
    }
    category.transactionCount += 1

    const conversion = lookupManualRate(
      expense.currency,
      input.reportingCurrency,
      input.exchangeRates
    )
    if (!('rate' in conversion)) {
      if (conversion.state === 'missing-rate') category.missingRateCurrencies.add(expense.currency)
      else category.invalidRateCurrencies.add(expense.currency)
      return
    }

    category.amount += expense.amount * conversion.rate
  })

  const categories = [...totals.entries()].map(([categoryId, category]): LegacyCategorySpendReport => {
    const missingRateCurrencies = [...category.missingRateCurrencies].sort()
    const invalidRateCurrencies = [...category.invalidRateCurrencies].sort()
    const complete = missingRateCurrencies.length === 0 && invalidRateCurrencies.length === 0

    return {
      categoryId,
      totalSpent: complete ? Math.round(category.amount) : null,
      monthlyAverage: complete ? Math.round(category.amount / input.periodMonths) : null,
      transactionCount: category.transactionCount,
      periodMonths: input.periodMonths,
      reportingCurrency: input.reportingCurrency,
      complete,
      missingRateCurrencies,
      invalidRateCurrencies
    }
  }).sort((left, right) => (right.totalSpent ?? Number.NEGATIVE_INFINITY) - (left.totalSpent ?? Number.NEGATIVE_INFINITY))

  const missingRateCurrencies = [...new Set(categories.flatMap(category => category.missingRateCurrencies))].sort()
  const invalidRateCurrencies = [...new Set(categories.flatMap(category => category.invalidRateCurrencies))].sort()
  const complete = missingRateCurrencies.length === 0 && invalidRateCurrencies.length === 0

  return {
    periodMonths: input.periodMonths,
    reportingCurrency: input.reportingCurrency,
    categoryBudgetCurrency,
    complete,
    canProposeCaps: categories.length > 0
      && complete
      && categoryBudgetCurrency !== null
      && categoryBudgetCurrency === input.reportingCurrency,
    missingRateCurrencies,
    invalidRateCurrencies,
    categories
  }
}

export interface LegacyCategoryBudgetChange {
  readonly categoryId: string
  readonly monthlyLimit: number
}

/** Build the legacy-only cap map after requiring the workspace's explicit cap denomination. */
export const buildLegacyCategoryBudgetsPatch = (
  currentCaps: unknown,
  budgets: readonly LegacyCategoryBudgetChange[],
  confirmedCurrency: unknown,
  requestedCurrency: unknown
): Record<string, number> => {
  if (confirmedCurrency === null || confirmedCurrency === undefined) {
    throw new Error('Legacy category budget currency must be confirmed before saving.')
  }
  const validConfirmedCurrency = parseLegacyCategoryBudgetCurrency({
    categoryBudgetCurrency: confirmedCurrency
  })
  if (validConfirmedCurrency === null) {
    throw new Error('Legacy category budget currency must be confirmed before saving.')
  }
  if (typeof requestedCurrency !== 'string' || requestedCurrency !== validConfirmedCurrency) {
    throw new Error('Requested currency must match the confirmed legacy category budget currency.')
  }

  const updated: Record<string, number> = currentCaps && typeof currentCaps === 'object'
    ? { ...currentCaps as Record<string, number> }
    : {}
  budgets.forEach(budget => {
    if (budget.monthlyLimit > 0) updated[budget.categoryId] = Number(budget.monthlyLimit)
    else delete updated[budget.categoryId]
  })

  return updated
}
