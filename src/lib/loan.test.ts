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

test('loan acepta montos negativos y rechaza montos positivos', () => {
  assert.ok(TransactionSchema.safeParse({ ...base, type: 'loan', categoryId: '' }).success)
  assert.ok(!TransactionSchema.safeParse({ ...base, type: 'loan', amount: 100000 }).success)
})

test('loan_payment acepta montos positivos y rechaza montos negativos', () => {
  assert.ok(TransactionSchema.safeParse({ ...base, type: 'loan_payment', amount: 50000 }).success)
  assert.ok(!TransactionSchema.safeParse({ ...base, type: 'loan_payment', amount: -50000 }).success)
})

test('los tipos inválidos siguen rechazados', () => {
  assert.ok(!TransactionSchema.safeParse({ ...base, type: 'borrow' }).success)
})
