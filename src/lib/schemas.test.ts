import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransactionSchema } from '../schemas.ts'

const baseTransaction = {
  accountId: 'origin',
  description: 'Movimiento',
  categoryId: 'category',
  date: new Date(),
  toAccountId: null
}

test('TransactionSchema exige montos finitos con signo según el tipo', () => {
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: -100 }).success, true)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'income', amount: 100 }).success, true)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: 100, toAccountId: 'destination' }).success, true)

  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: 100 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'income', amount: -100 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: -100, toAccountId: 'destination' }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: 0 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: Infinity, toAccountId: 'destination' }).success, false)
})
