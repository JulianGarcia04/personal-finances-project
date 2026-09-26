import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTransactionDisplay } from './transactionDisplay.ts'

const resolveAccountName = (id: string) => {
  const names: Record<string, string> = {
    checking: 'Cuenta Corriente',
    savings: 'Ahorros'
  }
  return names[id] || 'Desconocida'
}

test('income transaction renders as positive with emerald tone', () => {
  const tx = { type: 'income', amount: 1500, accountId: 'checking', toAccountId: null }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'income')
  assert.equal(display.prefix, '+')
  assert.equal(display.amountClass, 'text-accent-emerald')
  assert.equal(display.amount, 1500)
  assert.equal(display.route, undefined)
})

test('expense transaction renders as negative with rose tone', () => {
  const tx = { type: 'expense', amount: -300, accountId: 'checking', toAccountId: null }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'expense')
  assert.equal(display.prefix, '')
  assert.equal(display.amountClass, 'text-accent-rose')
  assert.equal(display.amount, -300)
})

test('transfer with positive amount renders neutral with route', () => {
  const tx = { type: 'transfer', amount: 500, accountId: 'checking', toAccountId: 'savings' }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'transfer')
  assert.equal(display.prefix, '')
  assert.equal(display.amountClass, 'text-accent-amber')
  assert.equal(display.amount, 500)
  assert.equal(display.route, 'Cuenta Corriente → Ahorros')
})

test('transfer with legacy negative stored amount is shown as absolute value', () => {
  const tx = { type: 'transfer', amount: -500, accountId: 'checking', toAccountId: 'savings' }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'transfer')
  assert.equal(display.amount, 500)
  assert.equal(display.route, 'Cuenta Corriente → Ahorros')
})

test('transfer without toAccountId stays neutral but has no route', () => {
  const tx = { type: 'transfer', amount: 500, accountId: 'checking', toAccountId: null }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'transfer')
  assert.equal(display.amountClass, 'text-accent-amber')
  assert.equal(display.route, undefined)
})

test('loan (money lent out) renders like an expense', () => {
  const tx = { type: 'loan', amount: -800, accountId: 'checking', toAccountId: null }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'expense')
  assert.equal(display.prefix, '')
  assert.equal(display.amountClass, 'text-accent-rose')
  assert.equal(display.amount, -800)
})

test('loan_payment (money received back) renders like income', () => {
  const tx = { type: 'loan_payment', amount: 800, accountId: 'checking', toAccountId: null }
  const display = getTransactionDisplay(tx, resolveAccountName)

  assert.equal(display.tone, 'income')
  assert.equal(display.prefix, '+')
  assert.equal(display.amountClass, 'text-accent-emerald')
  assert.equal(display.amount, 800)
})
