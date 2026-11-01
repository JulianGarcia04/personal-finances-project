import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardBillingLookup, expenseAmountForMonth } from './installments.ts'

// Closing 15, due 4: a purchase on 3-oct is on the statement closed 15-oct, paid 4-nov.
const card = (balance: number) => ({ id: 'nu', type: 'credit', statementClosingDay: 15, paymentDueDay: 4, balance })
const expense = (day: string, amount: number, installments = 1) =>
  ({ type: 'expense', amount: -amount, date: new Date(`${day}T12:00:00`), installments, accountId: 'nu' })
const payment = (day: string, amount: number) =>
  ({ type: 'transfer', amount, date: new Date(`${day}T12:00:00`), accountId: 'savings', toAccountId: 'nu' })
const OCT = [2026, 9] as const
const NOV = [2026, 10] as const
const DEC = [2026, 11] as const

const paymentsView = (transactions: ReturnType<typeof expense | typeof payment>[], balance: number) => {
  const billingFor = createCardBillingLookup([card(balance)], 'payment', { transactions })
  return (tx: ReturnType<typeof expense>, [year, month]: readonly [number, number]) =>
    expenseAmountForMonth(tx, year, month, billingFor('nu'))
}

test('an early payment counts in the month it was paid, not again in the due month', () => {
  const purchase = expense('2026-10-03', 1000)
  const amountIn = paymentsView([purchase, payment('2026-10-04', 1000)], 0)
  assert.equal(amountIn(purchase, OCT), 1000)
  assert.equal(amountIn(purchase, NOV), 0)
})

test('the unpaid rest of a statement stays in its payment month', () => {
  const purchase = expense('2026-10-03', 1000)
  const amountIn = paymentsView([purchase, payment('2026-10-20', 400)], -600)
  assert.equal(amountIn(purchase, OCT), 400)
  assert.equal(amountIn(purchase, NOV), 600)
})

test('without payments the payment view keeps the statement payment month', () => {
  const purchase = expense('2026-10-03', 1000)
  const amountIn = paymentsView([purchase], -1000)
  assert.equal(amountIn(purchase, OCT), 0)
  assert.equal(amountIn(purchase, NOV), 1000)
})

test('payments settle the oldest statement first', () => {
  const september = expense('2026-09-10', 300) // statement paid 4-oct
  const october = expense('2026-10-03', 1000) // statement paid 4-nov
  const amountIn = paymentsView([september, october, payment('2026-10-01', 500)], -800)
  assert.equal(amountIn(september, OCT), 300)
  assert.equal(amountIn(october, OCT), 200)
  assert.equal(amountIn(october, NOV), 800)
})

test('charges that are not expenses share the statement with expenses', () => {
  const purchase = expense('2026-10-03', 1000)
  const lent = { type: 'transfer', amount: 1000, date: new Date('2026-10-05T12:00:00'), accountId: 'nu', toAccountId: 'receivable' }
  const amountIn = paymentsView([purchase, lent, payment('2026-10-20', 1000)], -1000)
  assert.equal(amountIn(purchase, OCT), 500)
  assert.equal(amountIn(purchase, NOV), 500)
})

test('each installment follows the payments of its own statement', () => {
  const purchase = expense('2026-10-03', 300, 3) // 100 on the statements paid in nov, dec and jan
  const amountIn = paymentsView([purchase, payment('2026-10-20', 100)], -200)
  assert.equal(amountIn(purchase, OCT), 100)
  assert.equal(amountIn(purchase, NOV), 0)
  assert.equal(amountIn(purchase, DEC), 100)
})

test('debt from before the first movement is paid before recorded statements', () => {
  const purchase = expense('2026-10-03', 1000)
  // Balance -1500 with 1000 recorded charges and a 500 payment: 1000 of debt existed already.
  const amountIn = paymentsView([purchase, payment('2026-10-20', 500)], -1500)
  assert.equal(amountIn(purchase, OCT), 0)
  assert.equal(amountIn(purchase, NOV), 1000)
})

test('the consumption basis ignores payments', () => {
  const purchase = expense('2026-10-03', 1000)
  const billingFor = createCardBillingLookup([card(0)], 'consumption', { transactions: [purchase, payment('2026-10-04', 1000)] })
  assert.equal(expenseAmountForMonth(purchase, ...OCT, billingFor('nu')), 1000)
  assert.equal(expenseAmountForMonth(purchase, ...NOV, billingFor('nu')), 0)
})
