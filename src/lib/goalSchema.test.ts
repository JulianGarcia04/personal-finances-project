import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GoalSchema } from '../schemas.ts'

test('goal validation preserves the linked account and still accepts an existing virtual goal', () => {
  const virtual = { name: 'Reserve', targetAmount: 100, currentAmount: 15, currency: 'COP', targetDate: new Date(2027, 1, 1) }
  assert.deepEqual(GoalSchema.parse(virtual), virtual)
  const linked = { ...virtual, linkedAccountId: 'savings-account' }
  assert.deepEqual(GoalSchema.parse(linked), linked)
  assert.equal(GoalSchema.safeParse({ ...virtual, linkedAccountId: '  ' }).success, false)
})
