import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expenseAmountForMonth, getMonthlyInstallmentAmount } from './installments.ts'

test('distribuye una compra en cuotas durante los meses siguientes', () => {
  const transaction = {
    type: 'expense',
    amount: -600,
    date: new Date(2026, 7, 10),
    installments: 6
  }

  assert.equal(expenseAmountForMonth(transaction, 2026, 7), 100)
  assert.equal(expenseAmountForMonth(transaction, 2027, 0), 100)
  assert.equal(expenseAmountForMonth(transaction, 2027, 1), 0)
  assert.equal(getMonthlyInstallmentAmount(transaction.amount, transaction.installments), 100)
})

test('las compras sin cuotas se imputan solo en su mes', () => {
  const transaction = {
    type: 'expense',
    amount: -250,
    date: new Date(2026, 7, 10)
  }

  assert.equal(expenseAmountForMonth(transaction, 2026, 7), 250)
  assert.equal(expenseAmountForMonth(transaction, 2026, 8), 0)
})
