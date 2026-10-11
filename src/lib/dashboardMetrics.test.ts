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
  cardDebtSummary,
  utilizationLevel
} from './dashboardMetrics.ts'

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
