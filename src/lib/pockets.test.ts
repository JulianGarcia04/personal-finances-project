import assert from 'node:assert/strict'
import test from 'node:test'
import type { Account } from '../types.ts'
import {
  getAccountPocketTotals,
  getTransactionAccountDeltas,
  getTransactionReplacementDeltas,
  isPocketAccount,
  planPocketOpening
} from './pockets.ts'

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'balance'>): Account {
  return {
    id: overrides.id,
    workspaceId: 'workspace-1',
    name: 'Bank account',
    type: 'checking',
    balance: overrides.balance,
    limit: 0,
    currency: 'COP',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  }
}

test('legacy accounts remain roots and retain their stored net-worth total', () => {
  const bank = account({ id: 'bank', balance: 1_000 })
  const legacyNullParent = account({ id: 'legacy-null-parent', balance: 25, parentAccountId: null })

  assert.equal(isPocketAccount(legacyNullParent), false)
  assert.deepEqual(getAccountPocketTotals('bank', [bank]), {
    availableBalance: 1_000,
    pocketBalance: 0,
    totalBalance: 1_000
  })
})

test('funded pocket opening splits existing parent money without increasing total wealth', () => {
  const parent = account({ id: 'bank', balance: 1_000 })
  const parentAfter = { ...parent, balance: 700 }
  const pocket = account({
    id: 'pocket',
    name: 'Travel',
    type: 'savings',
    parentAccountId: 'bank',
    balance: 300
  })

  assert.deepEqual(getAccountPocketTotals('bank', [parentAfter, pocket]), {
    availableBalance: 700,
    pocketBalance: 300,
    totalBalance: 1_000
  })
  assert.deepEqual(planPocketOpening(parent, 300, 'workspace-1'), {
    parentBalanceAfter: 700,
    pocketBalance: 300,
    totalBalanceBefore: 1_000,
    totalBalanceAfter: 1_000,
    openingTransactionAmount: 300
  })
})

test('zero-balance pocket opening does not fabricate an allocation transaction', () => {
  assert.deepEqual(planPocketOpening(account({ id: 'bank', balance: 500 }), 0, 'workspace-1'), {
    parentBalanceAfter: 500,
    pocketBalance: 0,
    totalBalanceBefore: 500,
    totalBalanceAfter: 500,
    openingTransactionAmount: null
  })
})

test('pocket opening rejects invalid amounts, ineligible parents, and insufficient funds', () => {
  const parent = account({ id: 'bank', balance: 100 })

  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 101]) {
    assert.throws(() => planPocketOpening(parent, amount, 'workspace-1'))
  }
  assert.throws(() => planPocketOpening(account({ id: 'credit', balance: 100, type: 'credit' }), 1, 'workspace-1'))
  assert.throws(() => planPocketOpening(account({ id: 'cash', balance: 100, type: 'cash' }), 1, 'workspace-1'))
  assert.throws(() => planPocketOpening(account({ id: 'mirror', balance: 100, mirror: {
    workspaceId: 'other-workspace', accountId: 'receivable', sourceAccountId: 'source'
  } }), 1, 'workspace-1'))
  assert.throws(() => planPocketOpening(account({ id: 'pocket', balance: 100, parentAccountId: 'bank' }), 1, 'workspace-1'))
  assert.throws(() => planPocketOpening(account({ id: 'bank', balance: 100 }), 1, 'workspace-2'))
  assert.throws(() => planPocketOpening(parent, 1, 'workspace-1', 'USD'))
})

test('pocket movement deltas preserve income, expense, and neutral transfer semantics', () => {
  assert.deepEqual(getTransactionAccountDeltas({ accountId: 'pocket', amount: 40, type: 'income' }), { pocket: 40 })
  assert.deepEqual(getTransactionAccountDeltas({ accountId: 'pocket', amount: -15, type: 'expense' }), { pocket: -15 })
  assert.deepEqual(getTransactionAccountDeltas({
    accountId: 'bank', toAccountId: 'pocket', amount: 25, type: 'transfer'
  }), { bank: -25, pocket: 25 })
  assert.throws(() => getTransactionAccountDeltas({ accountId: 'pocket', amount: 1, type: 'loan' }))
})

test('transaction replacement deltas combine overlapping old and new accounts', () => {
  assert.deepEqual(getTransactionReplacementDeltas(
    { accountId: 'bank', toAccountId: 'pocket', amount: 30, type: 'transfer' },
    { accountId: 'pocket', toAccountId: 'bank', amount: 20, type: 'transfer' }
  ), { bank: 50, pocket: -50 })
  assert.deepEqual(getTransactionReplacementDeltas(
    { accountId: 'pocket', amount: -40, type: 'expense' },
    { accountId: 'pocket', amount: -15, type: 'expense' }
  ), { pocket: 25 })
  assert.deepEqual(getTransactionReplacementDeltas(
    { accountId: 'pocket', amount: 10, type: 'income' }, null
  ), { pocket: -10 })
})
