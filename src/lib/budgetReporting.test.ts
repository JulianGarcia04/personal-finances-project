import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reportAllBudgetsEstimatedMonthly,
  reportBudgetScope
} from './budgetReporting.ts'
import { DEFAULT_MONTHLY_BUDGET_ID, type BudgetExpenseTransaction } from './budgets.ts'
import { createCardBillingLookup } from './installments.ts'

const january = { year: 2026, month: 0 }

const expense = (overrides: Partial<BudgetExpenseTransaction> = {}): BudgetExpenseTransaction => ({
  type: 'expense',
  amount: -10,
  date: new Date(2026, 0, 10),
  installments: 1,
  categoryId: 'food',
  currency: 'USD',
  ...overrides
})

const scopeInput = (overrides: Partial<Parameters<typeof reportBudgetScope>[0]> = {}) => ({
  scope: { id: 'monthly', kind: 'monthly' as const, capCurrency: 'USD' },
  transactions: [] as BudgetExpenseTransaction[],
  period: january,
  reportingCurrency: 'USD',
  exchangeRates: {} as Readonly<Record<string, number>>,
  ...overrides
})

test('reports one monthly scope with default fallback, exclusive attribution, and cap comparisons', () => {
  const transactions = [
    expense({ amount: -50 }),
    expense({ amount: -30, budgetId: null }),
    expense({ amount: -20, budgetId: 'another-budget' }),
    expense({ type: 'transfer', amount: -8 })
  ]
  const report = reportBudgetScope(scopeInput({
    scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: 'USD', totalLimit: 100 },
    categoryCaps: { food: 70 },
    transactions
  }))

  assert.deepEqual(report.monthlyAllocation, {
    amount: 80,
    currency: 'USD',
    complete: true,
    missingRateCurrencies: [],
    invalidRateCurrencies: []
  })
  assert.deepEqual(report.totalComparison, { spentAmount: 80, limitAmount: 100, remainingAmount: 20 })
  assert.deepEqual(report.categories.food, {
    monthlyAllocation: report.monthlyAllocation,
    eventCommittedPrincipal: null,
    cap: { amount: 70, currency: 'USD', reportingAmount: 70, state: 'complete' },
    comparison: { spentAmount: 80, limitAmount: 70, remainingAmount: -10 }
  })
  assert.deepEqual(Object.keys(report.categories), ['food'])
})

test('keeps event principal, monthly installments, and the all-budget estimate distinct', () => {
  const purchase = expense({ amount: -900, installments: 3, budgetId: 'trip', categoryId: 'travel' })
  const transactions = [purchase]

  for (const month of [0, 1, 2]) {
    const period = { year: 2026, month }
    const event = reportBudgetScope(scopeInput({
      scope: { id: 'trip', kind: 'event', capCurrency: 'USD', totalLimit: 1000 },
      categoryCaps: { travel: 1000 },
      transactions,
      period
    }))
    const baseline = reportBudgetScope(scopeInput({
      scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: null },
      transactions,
      period
    }))
    const global = reportAllBudgetsEstimatedMonthly({
      transactions,
      period,
      reportingCurrency: 'USD',
      exchangeRates: {}
    })

    assert.equal(event.monthlyAllocation.amount, 300)
    assert.equal(event.eventCommittedPrincipal?.amount, 900)
    assert.deepEqual(event.totalComparison, { spentAmount: 900, limitAmount: 1000, remainingAmount: 100 })
    assert.equal(event.categories.travel.monthlyAllocation.amount, 300)
    assert.equal(event.categories.travel.eventCommittedPrincipal?.amount, 900)
    assert.deepEqual(event.categories.travel.comparison, {
      spentAmount: 900,
      limitAmount: 1000,
      remainingAmount: 100
    })
    assert.equal(baseline.monthlyAllocation.amount, 0)
    assert.equal(baseline.eventCommittedPrincipal, null)
    assert.equal(global.amount, 300)
  }

  assert.equal(purchase.amount, -900, 'reporting must not rewrite the original ledger principal')
})

test('reports billed card installments in their payment month for the scope, its categories, and the global estimate', () => {
  const cardBilling = createCardBillingLookup([{ id: 'visa', type: 'credit', statementClosingDay: 25, paymentDueDay: 10 }])
  // Closing 25, due 10: a 28 Dec purchase closes on 25 Jan and is paid in February.
  const transactions = [
    expense({ amount: -90, date: new Date(2025, 11, 28), accountId: 'visa', budgetId: 'monthly' }),
    expense({ amount: -10, date: new Date(2026, 0, 10), accountId: 'cash', budgetId: 'monthly' })
  ]
  const february = { year: 2026, month: 1 }

  const januaryReport = reportBudgetScope(scopeInput({ transactions, cardBilling }))
  assert.equal(januaryReport.monthlyAllocation.amount, 10)
  const februaryReport = reportBudgetScope(scopeInput({ transactions, cardBilling, period: february }))
  assert.equal(februaryReport.monthlyAllocation.amount, 90)
  assert.equal(februaryReport.categories.food.monthlyAllocation.amount, 90)
  assert.equal(reportAllBudgetsEstimatedMonthly({
    transactions, period: february, reportingCurrency: 'USD', exchangeRates: {}, cardBilling
  }).amount, 90)
  // Without card billing the December purchase keeps its calendar month.
  assert.equal(reportBudgetScope(scopeInput({ transactions, period: february })).monthlyAllocation.amount, 0)
})

test('counts event principal independently of the selected calendar month', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: 'early-booking', kind: 'event', capCurrency: 'USD' },
    transactions: [expense({ amount: -80, date: new Date(2025, 0, 1), budgetId: 'early-booking' })]
  }))

  assert.equal(report.monthlyAllocation.amount, 0)
  assert.equal(report.eventCommittedPrincipal?.amount, 80)
})

test('global estimates include default, archived, unknown, and unassigned expenses but not transfers or repayments', () => {
  const report = reportAllBudgetsEstimatedMonthly({
    transactions: [
      expense({ amount: -10, budgetId: DEFAULT_MONTHLY_BUDGET_ID }),
      expense({ amount: -60, installments: 3, budgetId: 'archived-budget' }),
      expense({ amount: -30, budgetId: 'unknown-budget' }),
      expense({ amount: -40, installments: 2 }),
      expense({ amount: -8, budgetId: null }),
      expense({ type: 'transfer', amount: -500, budgetId: 'archived-budget' }),
      expense({ type: 'loan_payment', amount: 300, budgetId: 'unknown-budget' }),
      expense({ type: 'income', amount: 999 })
    ],
    period: january,
    reportingCurrency: 'USD',
    exchangeRates: {}
  })

  assert.equal(report.amount, 88)
  assert.equal(report.complete, true)
})

test('requires an own finite positive rate for every non-identity conversion and hides incomplete sums', () => {
  const rates = Object.assign(Object.create({ GBP: 5 }), {
    USD: 0,
    EUR: 2,
    AUD: 0,
    CAD: Number.NaN
  }) as Record<string, number>
  const report = reportAllBudgetsEstimatedMonthly({
    transactions: [
      expense({ amount: -10, currency: 'USD' }),
      expense({ amount: -20, currency: 'EUR' }),
      expense({ amount: -30, currency: 'GBP' }),
      expense({ amount: -40, currency: 'AUD' }),
      expense({ amount: -50, currency: 'CAD' })
    ],
    period: january,
    reportingCurrency: 'USD',
    exchangeRates: rates
  })

  assert.deepEqual(report, {
    amount: null,
    currency: 'USD',
    complete: false,
    missingRateCurrencies: ['GBP'],
    invalidRateCurrencies: ['AUD', 'CAD']
  })
})

test('rejects zero, negative, and infinite own manual rates as invalid', () => {
  for (const [currency, rate] of [['ZERO', 0], ['NEG', -1], ['INF', Number.POSITIVE_INFINITY]] as const) {
    const report = reportAllBudgetsEstimatedMonthly({
      transactions: [expense({ currency })],
      period: january,
      reportingCurrency: 'USD',
      exchangeRates: { [currency]: rate }
    })

    assert.equal(report.amount, null)
    assert.equal(report.complete, false)
    assert.deepEqual(report.invalidRateCurrencies, [currency])
    assert.deepEqual(report.missingRateCurrencies, [])
  }
})

test('preserves nominal cap units across reporting currencies and distinguishes zero from absent caps', () => {
  const scope = { id: 'home', kind: 'monthly' as const, capCurrency: 'EUR', totalLimit: 0 }
  const categoryCaps = { food: 50, free: 0 }
  const transactions = [
    expense({ amount: -10, categoryId: 'food', currency: 'EUR', budgetId: 'home' }),
    expense({ amount: -5, categoryId: 'rent', currency: 'EUR', budgetId: 'home' })
  ]
  const period = { ...january }
  const ratesUsd = { EUR: 1.5 }
  const ratesGbp = { EUR: 2 }
  const before = structuredClone({ scope, categoryCaps, transactions, period, ratesUsd, ratesGbp })
  const reportUsd = reportBudgetScope(scopeInput({
    scope,
    categoryCaps,
    transactions,
    period,
    reportingCurrency: 'USD',
    exchangeRates: ratesUsd
  }))
  const reportGbp = reportBudgetScope(scopeInput({
    scope,
    categoryCaps,
    transactions,
    period,
    reportingCurrency: 'GBP',
    exchangeRates: ratesGbp
  }))

  assert.deepEqual(reportUsd.totalCap, { amount: 0, currency: 'EUR', reportingAmount: 0, state: 'complete' })
  assert.deepEqual(reportUsd.categories.food.cap, {
    amount: 50,
    currency: 'EUR',
    reportingAmount: 75,
    state: 'complete'
  })
  assert.deepEqual(reportGbp.categories.food.cap, {
    amount: 50,
    currency: 'EUR',
    reportingAmount: 100,
    state: 'complete'
  })
  assert.equal(reportUsd.categories.rent.cap, null)
  assert.equal(reportGbp.categories.rent.cap, null)
  assert.deepEqual(reportUsd.categories.free.cap, {
    amount: 0,
    currency: 'EUR',
    reportingAmount: 0,
    state: 'complete'
  })
  assert.deepEqual({ scope, categoryCaps, transactions, period, ratesUsd, ratesGbp }, before)
})

test('keeps confirmed cap amounts and units while unavailable cap rates disable comparisons', () => {
  const reportMissing = reportBudgetScope(scopeInput({
    scope: { id: 'monthly', kind: 'monthly', capCurrency: 'EUR' },
    categoryCaps: { food: 50 },
    transactions: [expense({ amount: -5, currency: 'USD', budgetId: 'monthly' })]
  }))
  const reportInvalid = reportBudgetScope(scopeInput({
    scope: { id: 'monthly', kind: 'monthly', capCurrency: 'EUR' },
    categoryCaps: { food: 50 },
    transactions: [expense({ amount: -5, currency: 'USD', budgetId: 'monthly' })],
    exchangeRates: { EUR: 0 }
  }))

  assert.equal(reportMissing.categories.food.monthlyAllocation.amount, 5)
  assert.deepEqual(reportMissing.categories.food.cap, {
    amount: 50,
    currency: 'EUR',
    reportingAmount: null,
    state: 'missing-rate'
  })
  assert.equal(reportMissing.categories.food.comparison, null)
  assert.equal(reportInvalid.categories.food.cap?.state, 'invalid-rate')
  assert.equal(reportInvalid.categories.food.comparison, null)
})

test('keeps unconfirmed default caps visible without comparing them while known-rate spending remains reportable', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: null },
    categoryCaps: { food: 25 },
    transactions: [expense({ amount: -5 })]
  }))

  assert.equal(report.monthlyAllocation.amount, 5)
  assert.equal(report.monthlyAllocation.complete, true)
  assert.equal(report.totalCap, null)
  assert.equal(report.totalComparison, null)
  assert.deepEqual(report.categories.food.cap, {
    amount: 25,
    currency: null,
    reportingAmount: null,
    state: 'unconfirmed'
  })
  assert.equal(report.categories.food.comparison, null)
})

test('keeps category rollups prototype-safe for special own category IDs', () => {
  const categoryCaps: Record<string, number> = {}
  for (const [categoryId, amount] of [['__proto__', 13], ['constructor', 11], ['toString', 12]] as const) {
    Object.defineProperty(categoryCaps, categoryId, {
      value: amount,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  const report = reportBudgetScope(scopeInput({
    categoryCaps,
    transactions: [
      expense({ amount: -13, categoryId: '__proto__', budgetId: 'monthly' }),
      expense({ amount: -11, categoryId: 'constructor', budgetId: 'monthly' }),
      expense({ amount: -12, categoryId: 'toString', budgetId: 'monthly' })
    ]
  }))

  assert.equal(Object.getPrototypeOf(report.categories), Object.prototype)
  for (const [categoryId, amount] of [['__proto__', 13], ['constructor', 11], ['toString', 12]] as const) {
    assert.equal(Object.hasOwn(report.categories, categoryId), true)
    assert.equal(report.categories[categoryId].monthlyAllocation.amount, amount)
    assert.equal(report.categories[categoryId].cap?.amount, amount)
  }
})

const income = (overrides: Partial<BudgetExpenseTransaction> = {}): BudgetExpenseTransaction =>
  expense({ type: 'income', amount: 100, ...overrides })

test('event funds are all income assigned to the budget, and available is funds minus committed spending', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: 'casa', kind: 'event', capCurrency: 'USD', totalLimit: 500 },
    transactions: [
      income({ amount: 1000, budgetId: 'casa', date: new Date(2025, 5, 1) }),
      income({ amount: 50, currency: 'EUR', budgetId: 'casa' }),
      income({ amount: 999 }),
      income({ amount: 999, budgetId: 'other' }),
      expense({ amount: -300, budgetId: 'casa', date: new Date(2025, 11, 1) }),
      expense({ amount: -999 })
    ],
    exchangeRates: { EUR: 2 }
  }))
  assert.deepEqual(report.funds, {
    amount: 1100, currency: 'USD', complete: true, missingRateCurrencies: [], invalidRateCurrencies: []
  })
  assert.equal(report.available, 800)
  assert.deepEqual(report.totalComparison, { spentAmount: 300, limitAmount: 500, remainingAmount: 200 })
})

test('monthly funds count only income assigned in the reported month', () => {
  const report = reportBudgetScope(scopeInput({
    transactions: [
      income({ amount: 400, budgetId: 'monthly' }),
      income({ amount: 999, budgetId: 'monthly', date: new Date(2025, 11, 31) }),
      expense({ amount: -100, budgetId: 'monthly' })
    ]
  }))
  assert.equal(report.funds?.amount, 400)
  assert.equal(report.available, 300)
})

test('budgets without assigned income report no funds and no available amount, as before', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: 'casa', kind: 'event', capCurrency: 'USD', totalLimit: 500 },
    transactions: [expense({ amount: -300, budgetId: 'casa' })]
  }))
  assert.equal(report.funds, null)
  assert.equal(report.available, null)
  assert.equal(report.totalComparison?.remainingAmount, 200)
})

test('the default budget never has funds: unassigned income is the monthly income, not funds', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: 'USD' },
    transactions: [income({ amount: 500 }), income({ amount: 500, budgetId: DEFAULT_MONTHLY_BUDGET_ID })]
  }))
  assert.equal(report.funds, null)
  assert.equal(report.available, null)
})

test('a budget that only had money transferred out has no funds, like a budget without income', () => {
  const linkedBudgetOf = (accountId: string) => (accountId === 'cash-casa' ? 'casa' : null)
  const transfer = (accountId: string, toAccountId: string, amount: number) =>
    expense({ type: 'transfer', accountId, toAccountId, amount, categoryId: undefined })
  const outOnly = reportBudgetScope(scopeInput({
    scope: { id: 'casa', kind: 'event', capCurrency: 'USD' },
    transactions: [transfer('cash-casa', 'bank', 300), expense({ amount: -50, budgetId: 'casa' })],
    linkedBudgetOf
  }))
  assert.equal(outOnly.funds, null)
  assert.equal(outOnly.available, null)
  // With an inflow, outflows above it keep the real negative funds and available.
  const overdrawn = reportBudgetScope(scopeInput({
    scope: { id: 'casa', kind: 'event', capCurrency: 'USD' },
    transactions: [transfer('bank', 'cash-casa', 100), transfer('cash-casa', 'bank', 300), expense({ amount: -50, budgetId: 'casa' })],
    linkedBudgetOf
  }))
  assert.equal(overdrawn.funds?.amount, -200)
  assert.equal(overdrawn.available, -250)
})

test('funds with a missing rate hide both the funds amount and the available amount', () => {
  const report = reportBudgetScope(scopeInput({
    scope: { id: 'casa', kind: 'event', capCurrency: 'USD' },
    transactions: [income({ amount: 100, currency: 'COP', budgetId: 'casa' })]
  }))
  assert.equal(report.funds?.amount, null)
  assert.deepEqual(report.funds?.missingRateCurrencies, ['COP'])
  assert.equal(report.available, null)
})
