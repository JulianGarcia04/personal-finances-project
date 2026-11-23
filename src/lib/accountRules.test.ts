import assert from 'node:assert/strict'
import test from 'node:test'
import type { Account } from '../types.ts'
import { getAccountCurrencyLockReason } from './accountRules.ts'

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-1',
  workspaceId: 'ws-1',
  name: 'Cuenta Principal',
  type: 'checking',
  balance: 0,
  limit: 0,
  currency: 'COP',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides
})

test('getAccountCurrencyLockReason allows currency edits on a clean zero-balance account', () => {
  assert.equal(getAccountCurrencyLockReason(makeAccount(), false), null)
})

test('getAccountCurrencyLockReason blocks currency edits when balance is non-zero or movements exist', () => {
  assert.match(getAccountCurrencyLockReason(makeAccount({ balance: 100 }), false) ?? '', /saldo/i)
  assert.match(getAccountCurrencyLockReason(makeAccount({ balance: -50, type: 'credit' }), false) ?? '', /saldo/i)
  assert.match(getAccountCurrencyLockReason(makeAccount({ balance: 0 }), true) ?? '', /movimientos/i)
})

test('getAccountCurrencyLockReason blocks currency edits for pockets, parents, mirrors, and budget-linked accounts', () => {
  assert.match(getAccountCurrencyLockReason(makeAccount({ parentAccountId: 'parent-1' }), false) ?? '', /bolsillo/i)
  assert.match(getAccountCurrencyLockReason(makeAccount({ childAccountIds: ['p-1'] }), false) ?? '', /bolsillo/i)
  assert.match(getAccountCurrencyLockReason(makeAccount({
    mirror: { workspaceId: 'ws-2', accountId: 'rec', sourceAccountId: 'src' }
  }), false) ?? '', /puente/i)
  assert.match(getAccountCurrencyLockReason(makeAccount({ linkedBudgetId: 'budget-1' }), false) ?? '', /presupuesto/i)
})
