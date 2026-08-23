// Correr: node --test src/lib/loan.test.ts   (Node 24 lee TS nativo, sin dependencias)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransactionSchema } from '../schemas.ts'

const base = {
  accountId: 'cuenta-1',
  amount: -100000,
  description: 'Préstamo a Juan',
  date: new Date('2026-08-01T12:00:00'),
}

test('loan y loan_payment son tipos válidos (con o sin categoría)', () => {
  assert.ok(TransactionSchema.safeParse({ ...base, type: 'loan', categoryId: '' }).success)
  assert.ok(TransactionSchema.safeParse({ ...base, type: 'loan_payment', amount: 50000 }).success)
})

test('los tipos inválidos siguen rechazados', () => {
  assert.ok(!TransactionSchema.safeParse({ ...base, type: 'borrow' }).success)
})
