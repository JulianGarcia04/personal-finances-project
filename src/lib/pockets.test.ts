import assert from 'node:assert/strict'
import test from 'node:test'
import type { Account } from '../types.ts'
import * as pocketUi from './pockets.ts'
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
  const parent = account({ id: 'bank', balance: 1_000, childAccountIds: ['pocket'] })
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

test('account groups attach only registered same-workspace and same-currency pockets', () => {
  assert.equal(typeof pocketUi.groupAccountsByPocket, 'function', 'account grouping helper must exist')
  const bank = account({ id: 'bank', name: 'Nu', balance: 700, childAccountIds: ['travel'] })
  const secondBank = account({ id: 'bank-2', name: 'Bancolombia', balance: 40, childAccountIds: ['trip'] })
  const accounts = [
    bank,
    account({ id: 'travel', name: 'Viaje', type: 'savings', parentAccountId: 'bank', balance: 300 }),
    secondBank,
    account({ id: 'trip', name: 'Viaje', type: 'savings', parentAccountId: 'bank-2', balance: 15 }),
    account({ id: 'currency-mismatch', type: 'savings', currency: 'USD', parentAccountId: 'bank', balance: 10 }),
    account({ id: 'workspace-mismatch', type: 'savings', workspaceId: 'workspace-2', parentAccountId: 'bank', balance: 20 }),
    account({ id: 'orphan', type: 'savings', parentAccountId: 'missing', balance: 5 }),
    account({ id: 'legacy', balance: 25, parentAccountId: null })
  ]

  const groups = pocketUi.groupAccountsByPocket(accounts, 'workspace-1')
  assert.deepEqual(groups.find(group => group.account.id === 'bank')?.pockets.map(child => child.id), ['travel'])
  assert.deepEqual(groups.find(group => group.account.id === 'bank-2')?.pockets.map(child => child.id), ['trip'])
  assert.ok(groups.some(group => group.account.id === 'currency-mismatch' && group.isOrphan))
  assert.ok(groups.some(group => group.account.id === 'workspace-mismatch' && group.isOrphan))
  assert.ok(groups.some(group => group.account.id === 'orphan' && group.isOrphan))
  assert.ok(groups.some(group => group.account.id === 'legacy' && !group.isOrphan))
})

test('account labels distinguish a bank pocket from an orphan and preserve identifiers', () => {
  assert.equal(typeof pocketUi.getAccountDisplayLabel, 'function', 'account label helper must exist')
  const bank = account({ id: 'bank', name: 'Nu' })
  const pocket = account({ id: 'trip', name: 'Viaje', type: 'savings', parentAccountId: 'bank' })
  const orphan = account({ id: 'orphan-17', name: 'Fondo', type: 'savings', parentAccountId: 'missing' })

  assert.equal(pocketUi.getAccountDisplayLabel(pocket, [bank, { ...bank, childAccountIds: ['trip'] }, pocket]), 'Nu › Viaje')
  assert.match(pocketUi.getAccountDisplayLabel(orphan, [orphan]), /sin grupo.*orphan-17/i)
  assert.equal(pocketUi.getAccountDisplayLabel(bank, [bank]), 'Nu')
})

test('related transfer endpoints require eligible accounts in one workspace and currency', () => {
  assert.equal(typeof pocketUi.canTransferBetweenAccounts, 'function', 'transfer eligibility helper must exist')
  const bank = account({ id: 'bank', balance: 700, childAccountIds: ['pocket'] })
  const pocket = account({ id: 'pocket', type: 'savings', parentAccountId: 'bank', balance: 300 })
  const otherBank = account({ id: 'other-bank', type: 'checking', balance: 0 })
  const otherCurrency = account({ id: 'usd-bank', type: 'checking', currency: 'USD', balance: 0 })
  const credit = account({ id: 'credit', type: 'credit', balance: 0 })
  const mirror = account({
    id: 'mirror',
    type: 'checking',
    balance: 0,
    mirror: { workspaceId: 'workspace-2', accountId: 'receivable', sourceAccountId: 'source' }
  })
  const accounts = [bank, pocket, otherBank, otherCurrency, credit, mirror]

  assert.equal(pocketUi.canTransferBetweenAccounts(pocket, otherBank, accounts), true)
  assert.equal(pocketUi.canTransferBetweenAccounts(bank, pocket, accounts), true)
  assert.equal(pocketUi.canTransferBetweenAccounts(pocket, otherCurrency, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(pocket, credit, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(pocket, mirror, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(otherBank, credit, accounts), true, 'ordinary transfers keep legacy eligibility')
})

test('bank accounts with pockets retain ordinary credit-card payment eligibility', () => {
  const bank = account({ id: 'bank', type: 'savings', balance: 700, childAccountIds: ['pocket'] })
  const pocket = account({ id: 'pocket', type: 'savings', parentAccountId: bank.id, balance: 300 })
  const credit = account({ id: 'credit', type: 'credit', balance: -500, limit: 2_000 })
  const accounts = [bank, pocket, credit]
  const before = structuredClone(accounts)

  assert.equal(pocketUi.canTransferBetweenAccounts(bank, credit, accounts), true)
  assert.equal(pocketUi.canTransferBetweenAccounts(credit, bank, accounts), true)
  assert.equal(pocketUi.canTransferBetweenAccounts(pocket, credit, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(credit, pocket, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(bank, { ...credit, currency: 'USD' }, accounts), false)
  assert.equal(pocketUi.canTransferBetweenAccounts(bank, { ...credit, workspaceId: 'other' }, accounts), false)
  assert.deepEqual(accounts, before)
})

test('display totals exclude malformed foreign or unregistered child records', () => {
  const bank = account({ id: 'bank', balance: 700, childAccountIds: ['valid'] })
  const valid = account({ id: 'valid', type: 'savings', parentAccountId: 'bank', balance: 300 })
  const foreign = account({ id: 'foreign', type: 'savings', workspaceId: 'workspace-2', parentAccountId: 'bank', balance: 90 })
  const unregistered = account({ id: 'unregistered', type: 'savings', parentAccountId: 'bank', balance: 60 })

  assert.deepEqual(getAccountPocketTotals('bank', [bank, valid, foreign, unregistered]), {
    availableBalance: 700,
    pocketBalance: 300,
    totalBalance: 1_000
  })
})
