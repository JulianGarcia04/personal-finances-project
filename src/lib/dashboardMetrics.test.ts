import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alignedMonthPeriods,
  isDateInPeriod,
  expenseAmountInPeriod,
  percentChange,
  previousFullMonths,
  runwayDays,
  committedCardPayments,
  spendableUntilMonthEnd,
  projectMonthEndExpenses,
  splitMonthEndExpenses,
  cardDebtSummary,
  utilizationLevel,
  isSpendableAccount,
  projectionChecks,
  cardDebtRows,
  budgetCardFigures,
  hasBudgetActivity,
  parseFlowView
} from './dashboardMetrics.ts'
import { createCardBillingLookup } from './installments.ts'

// --- Aligned month-over-month ---

test('aligned MoM on day 31 clamps the previous period to the last day of February', () => {
  const periods = alignedMonthPeriods(new Date(2026, 2, 31, 15, 0))
  assert.deepEqual(periods.current, { year: 2026, month: 2, uptoDay: 31 })
  assert.deepEqual(periods.previous, { year: 2026, month: 1, uptoDay: 28 })
})

test('aligned MoM on day 1 compares only the first day of each month', () => {
  const periods = alignedMonthPeriods(new Date(2026, 0, 1, 9, 0))
  assert.deepEqual(periods.current, { year: 2026, month: 0, uptoDay: 1 })
  assert.deepEqual(periods.previous, { year: 2025, month: 11, uptoDay: 1 })
})

test('isDateInPeriod includes the whole last day and excludes later days', () => {
  const period = { year: 2026, month: 1, uptoDay: 10 }
  assert.equal(isDateInPeriod(new Date(2026, 1, 10, 23, 59), period), true)
  assert.equal(isDateInPeriod(new Date(2026, 1, 11, 0, 0), period), false)
  assert.equal(isDateInPeriod(new Date(2026, 0, 5), period), false)
})

test('expenseAmountInPeriod imputes an installment on the purchase day-of-month', () => {
  const purchase = { type: 'expense', amount: -300, date: new Date(2026, 0, 20), installments: 3 }
  // February installment counts only once day 20 is reached.
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 1, uptoDay: 19 }), 0)
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 1, uptoDay: 20 }), 100)
})

test('expenseAmountInPeriod clamps a day-31 purchase to the end of a short month', () => {
  const purchase = { type: 'expense', amount: -200, date: new Date(2026, 0, 31), installments: 2 }
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 1, uptoDay: 28 }), 100)
})

test('expenseAmountInPeriod imputes a billed card installment on the payment due day', () => {
  // Closing 25, due 10: a 28 Sep purchase is paid on 10 Nov, 10 Dec and 10 Jan.
  const purchase = { type: 'expense', amount: -300, date: new Date(2026, 8, 28), installments: 3 }
  const billing = { statementClosingDay: 25, paymentDueDay: 10 }
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 9, uptoDay: 31 }, billing), 0)
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 10, uptoDay: 9 }, billing), 0)
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 10, uptoDay: 10 }, billing), 100)
})

test('expenseAmountInPeriod clamps a day-31 due date to the end of a short month', () => {
  // Closing 25, due 31: a 20 Jan purchase is paid on 31 Jan and on 28 Feb.
  const purchase = { type: 'expense', amount: -200, date: new Date(2026, 0, 20), installments: 2 }
  const billing = { statementClosingDay: 25, paymentDueDay: 31 }
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 1, uptoDay: 27 }, billing), 0)
  assert.equal(expenseAmountInPeriod(purchase, { year: 2026, month: 1, uptoDay: 28 }, billing), 100)
})

test('expenseAmountInPeriod ignores non-expense movements such as transfers', () => {
  const transfer = { type: 'transfer', amount: -500, date: new Date(2026, 1, 1) }
  assert.equal(expenseAmountInPeriod(transfer, { year: 2026, month: 1, uptoDay: 28 }), 0)
})

test('percentChange keeps the legacy semantics for an empty previous period', () => {
  assert.equal(percentChange(150, 100), 50)
  assert.equal(percentChange(50, 100), -50)
  assert.equal(percentChange(10, 0), 100)
  assert.equal(percentChange(0, 0), 0)
})

// --- Runway ---

test('previousFullMonths returns the last three full months, newest first', () => {
  assert.deepEqual(previousFullMonths(new Date(2026, 1, 15), 3), [
    { year: 2026, month: 0, days: 31 },
    { year: 2025, month: 11, days: 31 },
    { year: 2025, month: 10, days: 30 }
  ])
})

test('runway divides liquid balance by the average daily expense of full months', () => {
  const days = runwayDays({
    liquidBalance: 9000,
    history: [
      { expenses: 3100, days: 31 },
      { expenses: 3000, days: 30 },
      { expenses: 3100, days: 31 }
    ],
    monthToDateExpenses: 5000,
    dayOfMonth: 5
  })
  // 9200 / 92 days = 100 per day -> 90 days.
  assert.equal(days, 90)
})

test('runway ignores empty history months and falls back to current-month pace', () => {
  const days = runwayDays({
    liquidBalance: 1000,
    history: [{ expenses: 0, days: 31 }, { expenses: 0, days: 30 }],
    monthToDateExpenses: 500,
    dayOfMonth: 10
  })
  // 500 / 10 = 50 per day -> 20 days.
  assert.equal(days, 20)
})

test('runway is infinite (null) when there are no expenses at all', () => {
  assert.equal(runwayDays({ liquidBalance: 1000, history: [], monthToDateExpenses: 0, dayOfMonth: 10 }), null)
})

test('runway is zero when there is no liquid balance', () => {
  assert.equal(runwayDays({ liquidBalance: -50, history: [{ expenses: 300, days: 30 }], monthToDateExpenses: 0, dayOfMonth: 3 }), 0)
})

// --- Spendable until month end ---

test('committed card payments only count statements due by month end, capped by current debt', () => {
  const now = new Date(2026, 3, 10)
  const committed = committedCardPayments([
    { statementAmount: 400, debt: 1000, dueDate: new Date(2026, 3, 25) },
    // Already partially paid: only the remaining debt is still committed.
    { statementAmount: 400, debt: 150, dueDate: new Date(2026, 3, 30) },
    // Due next month: not committed for this month.
    { statementAmount: 900, debt: 900, dueDate: new Date(2026, 4, 2) },
    // Unknown statement amount: nothing can be committed.
    { statementAmount: null, debt: 700, dueDate: new Date(2026, 3, 20) }
  ], now)
  assert.equal(committed, 550)
})

test('spendable subtracts committed payments and spreads the rest over the remaining days', () => {
  const result = spendableUntilMonthEnd({ availableBalance: 2100, committed: 600, now: new Date(2026, 3, 16) })
  // April has 30 days; days 16..30 inclusive = 15 days.
  assert.deepEqual(result, { amount: 1500, perDay: 100, daysLeft: 15, isDeficit: false })
})

test('spendable reports a deficit instead of clamping, with zero per day', () => {
  const result = spendableUntilMonthEnd({ availableBalance: 200, committed: 500, now: new Date(2026, 1, 28) })
  assert.deepEqual(result, { amount: -300, perDay: 0, daysLeft: 1, isDeficit: true })
})

// --- Month-end projection ---

test('projection extrapolates this month pace and adds already committed installments', () => {
  const projected = projectMonthEndExpenses({
    paceExpensesToDate: 1000,
    committedExpenses: 500,
    now: new Date(2026, 3, 10)
  })
  // 1000 / 10 days * 30 days + 500
  assert.equal(projected, 3500)
})

test('month-end projection adds card statements of earlier purchases once and extrapolates only this month\'s purchases', () => {
  // 15 Nov 2026 (30-day month). Visa: closing 25, due 10.
  const now = new Date(2026, 10, 15, 12, 0)
  const billingFor = createCardBillingLookup([
    { id: 'visa', type: 'credit', statementClosingDay: 25, paymentDueDay: 10 },
    { id: 'cash', type: 'cash' }
  ])
  const transactions = [
    // Cash purchase this month: follows the daily pace.
    { type: 'expense', amount: -150_000, date: new Date(2026, 10, 5), accountId: 'cash', currency: 'COP' },
    // Card purchase on 20 Oct: statement of 25 Oct, paid on 10 Nov -> a known commitment.
    { type: 'expense', amount: -200_000, date: new Date(2026, 9, 20), accountId: 'visa', currency: 'COP' },
    // Card purchase on 3 Nov: statement of 25 Nov, paid in December -> nothing this month.
    { type: 'expense', amount: -90_000, date: new Date(2026, 10, 3), accountId: 'visa', currency: 'COP' },
    { type: 'income', amount: 1_000_000, date: new Date(2026, 10, 1), accountId: 'cash', currency: 'COP' }
  ]
  const convert = (amount: number) => amount

  // Before: calendar months put both card purchases in their purchase month.
  const before = splitMonthEndExpenses(transactions, now, { convert })
  assert.deepEqual(before, { pace: 240_000, committed: 0 })
  assert.equal(projectMonthEndExpenses({ paceExpensesToDate: before.pace, committedExpenses: before.committed, now }), 480_000)

  // After: 150,000 / 15 days * 30 days + 200,000 due on 10 Nov.
  const after = splitMonthEndExpenses(transactions, now, { convert, billingFor })
  assert.deepEqual(after, { pace: 150_000, committed: 200_000 })
  assert.equal(projectMonthEndExpenses({ paceExpensesToDate: after.pace, committedExpenses: after.committed, now }), 500_000)

  // `include` narrows the split (budgeted categories) and `convert` receives the currency.
  const onlyCard = splitMonthEndExpenses(transactions, now, {
    convert: (amount, currency) => (currency === 'COP' ? amount / 1000 : amount),
    billingFor,
    include: transaction => transaction.accountId === 'visa'
  })
  assert.deepEqual(onlyCard, { pace: 0, committed: 200 })
})

test('projection on the last day equals the actual month total', () => {
  assert.equal(projectMonthEndExpenses({ paceExpensesToDate: 2800, committedExpenses: 0, now: new Date(2026, 1, 28) }), 2800)
})

// --- Card debt ---

test('card debt sums negative credit balances and computes utilization over total limit', () => {
  const summary = cardDebtSummary([
    { balance: -300, limit: 1000 },
    { balance: 50, limit: 1000 }, // overpaid card: no debt
    { balance: -100, limit: 0 }
  ])
  assert.deepEqual(summary, { debt: 400, limit: 2000, utilization: 20 })
})

test('card utilization is null when no card has a limit', () => {
  assert.deepEqual(cardDebtSummary([{ balance: -100, limit: 0 }]), { debt: 100, limit: 0, utilization: null })
})

test('utilization level warns above 30% and alerts above 70%', () => {
  assert.equal(utilizationLevel(null), 'ok')
  assert.equal(utilizationLevel(30), 'ok')
  assert.equal(utilizationLevel(31), 'warn')
  assert.equal(utilizationLevel(71), 'alert')
})

// --- Review fixes (T4) ---

test('spendable cash only counts top-level checking and cash accounts', () => {
  assert.equal(isSpendableAccount({ type: 'checking' }), true)
  assert.equal(isSpendableAccount({ type: 'cash' }), true)
  assert.equal(isSpendableAccount({ type: 'savings' }), false)
  assert.equal(isSpendableAccount({ type: 'credit' }), false)
  // Pockets are money set aside, mirror accounts are bridges.
  assert.equal(isSpendableAccount({ type: 'checking', parentAccountId: 'main' }), false)
  assert.equal(isSpendableAccount({ type: 'checking', mirror: true }), false)
})

test('projection compares budgeted categories against the budget and all spending against the limit', () => {
  const checks = projectionChecks({
    budgetedProjection: 900,
    budgetTotal: 1000,
    totalProjection: 8000,
    expenseLimit: 5000
  })
  assert.deepEqual(checks, {
    budget: { projected: 900, cap: 1000, exceeds: false },
    limit: { projected: 8000, cap: 5000, exceeds: true }
  })
})

test('projection checks are absent when there is no budget nor expense limit', () => {
  assert.deepEqual(
    projectionChecks({ budgetedProjection: 0, budgetTotal: 0, totalProjection: 8000, expenseLimit: 0 }),
    { budget: null, limit: null }
  )
})

test('card debt rows report per-card debt and utilization, highest utilization first', () => {
  const rows = cardDebtRows([
    { id: 'a', name: 'Visa', balance: -200, limit: 1000 },
    { id: 'b', name: 'Master', balance: -450, limit: 1000 },
    { id: 'c', name: 'Sin cupo', balance: -100, limit: 0 },
    { id: 'd', name: 'Al día', balance: 20, limit: 500 }
  ])
  assert.deepEqual(rows, [
    { id: 'b', name: 'Master', debt: 450, limit: 1000, utilization: 45 },
    { id: 'a', name: 'Visa', debt: 200, limit: 1000, utilization: 20 },
    { id: 'd', name: 'Al día', debt: 0, limit: 500, utilization: 0 },
    { id: 'c', name: 'Sin cupo', debt: 100, limit: 0, utilization: null }
  ])
})

// --- S9: per-budget view ---

const budgetReportContext = (transactions: Record<string, unknown>[]) => ({
  transactions: transactions as never,
  period: { year: 2026, month: 9 },
  reportingCurrency: 'COP',
  exchangeRates: {},
  linkedBudgetOf: () => null
})

test('S9: budget card figures report funds, spending and what is left of an event budget', () => {
  const october = new Date(2026, 9, 5, 12)
  const figures = budgetCardFigures(
    { budget: { id: 'ventas-casa', kind: 'event', capCurrency: 'COP' }, categoryCaps: {} },
    budgetReportContext([
      { type: 'income', amount: 1000000, budgetId: 'ventas-casa', date: october, currency: 'COP' },
      { type: 'expense', amount: -300000, budgetId: 'ventas-casa', date: october, currency: 'COP', installments: 1 }
    ])
  )
  assert.equal(figures.currency, 'COP')
  assert.equal(figures.fundsAmount, 1000000)
  assert.equal(figures.spent, 300000)
  assert.equal(figures.available, 700000)
  assert.equal(figures.limitAmount, null)
  assert.equal(hasBudgetActivity(figures), true)
})

test('budget card figures flag funds overdrawn by transfers out, and ignore a budget with only outflows', () => {
  const october = new Date(2026, 9, 5, 12)
  const context = (transactions: Record<string, unknown>[]) => ({
    ...budgetReportContext(transactions),
    linkedBudgetOf: (accountId: string) => (accountId === 'cash-casa' ? 'casa' : null)
  })
  const transfer = (accountId: string, toAccountId: string, amount: number) =>
    ({ type: 'transfer', accountId, toAccountId, amount, date: october, currency: 'COP' })
  const entry = { budget: { id: 'casa', kind: 'event' as const, capCurrency: 'COP' }, categoryCaps: {} }
  const overdrawn = budgetCardFigures(entry, context([transfer('bank', 'cash-casa', 100), transfer('cash-casa', 'bank', 300)]))
  assert.equal(overdrawn.fundsAmount, -200)
  assert.equal(overdrawn.available, -200)
  assert.equal(overdrawn.overdrawn, true)
  const outOnly = budgetCardFigures(entry, context([transfer('cash-casa', 'bank', 300)]))
  assert.equal(outOnly.funds, null)
  assert.equal(outOnly.available, null)
  assert.equal(outOnly.overdrawn, false)
  assert.equal(hasBudgetActivity(outOnly), false)
  const funded = budgetCardFigures(entry, context([transfer('bank', 'cash-casa', 300)]))
  assert.equal(funded.overdrawn, false)
})

test('S9: a budget with no funds and no spending in the period has no activity', () => {
  const idle = budgetCardFigures(
    { budget: { id: 'hogar', kind: 'monthly', capCurrency: 'COP', totalLimit: 500 }, categoryCaps: {} },
    budgetReportContext([])
  )
  assert.equal(hasBudgetActivity(idle), false)
  const spending = budgetCardFigures(
    { budget: { id: 'hogar', kind: 'monthly', capCurrency: 'COP' }, categoryCaps: {} },
    budgetReportContext([{ type: 'expense', amount: -20, budgetId: 'hogar', date: new Date(2026, 9, 2, 12), currency: 'COP', installments: 1 }])
  )
  assert.equal(hasBudgetActivity(spending), true)
})

test('S9: the remembered Dashboard view defaults to everything for unknown or missing values', () => {
  assert.equal(parseFlowView('budget'), 'budget')
  assert.equal(parseFlowView('all'), 'all')
  assert.equal(parseFlowView(null), 'all')
  assert.equal(parseFlowView('other'), 'all')
})
