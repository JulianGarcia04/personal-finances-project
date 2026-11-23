import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Account } from '../types.ts'
import {
  getSavingsGoalProgressAmount,
  isSavingsGoalAccountLinkable,
  updateVirtualGoalAmountAtomically,
  type SavingsGoalProgressTransaction,
} from './savingsGoals.ts'

const workspaceId = 'workspace-a'
const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  workspaceId,
  name: id,
  type: 'checking',
  balance: 0,
  limit: 0,
  currency: 'COP',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides
})

test('legacy virtual goals use their stored progress and linked goals read the live account balance', () => {
  const target = account('target', { balance: 70 })
  const accounts = [target]
  const virtual = { id: 'virtual', workspaceId, currentAmount: 21, currency: 'COP' }
  const linked = { id: 'linked', workspaceId, currentAmount: 1, currency: 'COP', linkedAccountId: target.id }
  const roundingTarget = account('rounding', { balance: 1.005 })

  assert.equal(getSavingsGoalProgressAmount(virtual, accounts, workspaceId), 21)
  assert.equal(getSavingsGoalProgressAmount(linked, accounts, workspaceId), 70)
  assert.equal(getSavingsGoalProgressAmount({ id: 'rounding', workspaceId, currentAmount: 0, currency: 'COP', linkedAccountId: roundingTarget.id }, [roundingTarget], workspaceId), 1.01)
  assert.equal(getSavingsGoalProgressAmount({ id: 'rounding-virtual', workspaceId, currentAmount: 1.005, currency: 'COP' }, [], workspaceId), 1.01)
})

test('linked goal progress is unavailable for missing, foreign, wrong-currency, credit, bridge, or malformed pocket accounts', () => {
  const goal = { id: 'linked', workspaceId, currentAmount: 999, currency: 'COP', linkedAccountId: 'target' }
  const invalidAccounts = [
    [],
    [account('target', { workspaceId: 'workspace-b', balance: 40 })],
    [account('target', { currency: 'USD', balance: 40 })],
    [account('target', { type: 'credit', balance: 40 })],
    [account('target', { mirror: { workspaceId: 'workspace-b', accountId: 'bridge', sourceAccountId: 'source' }, balance: 40 })],
    [account('target', { parentAccountId: 'missing-parent', type: 'savings', balance: 40 })]
  ]

  for (const accounts of invalidAccounts) {
    assert.equal(getSavingsGoalProgressAmount(goal, accounts, workspaceId), null)
  }
})

test('registered same-currency pockets are linkable, but the parent remains separately validated', () => {
  const parent = account('parent', { childAccountIds: ['pocket'] })
  const pocket = account('pocket', { type: 'savings', parentAccountId: parent.id, balance: 30 })
  const accounts = [parent, pocket]

  assert.equal(isSavingsGoalAccountLinkable(pocket, accounts, workspaceId, 'COP'), true)
  assert.equal(isSavingsGoalAccountLinkable(parent, accounts, workspaceId, 'COP'), true)
  assert.equal(isSavingsGoalAccountLinkable(pocket, accounts, workspaceId, 'USD'), false)
  const invalidBalance = account('pocket', { type: 'savings', parentAccountId: parent.id, balance: Number.NaN })
  assert.equal(isSavingsGoalAccountLinkable(invalidBalance, [parent, invalidBalance], workspaceId, 'COP'), false)
  const stringBalance = account('target', { balance: '30' as unknown as number })
  assert.equal(isSavingsGoalAccountLinkable(stringBalance, [stringBalance], workspaceId, 'COP'), false)
  const malformedPocket = { ...pocket, parentAccountId: 'missing' }
  assert.equal(isSavingsGoalAccountLinkable(malformedPocket, [parent, malformedPocket], workspaceId, 'COP'), false)
})

test('simultaneous virtual contributions transact against stored progress and round the result', async () => {
  const stored = { workspaceId, currentAmount: 0.1 }
  let lock = Promise.resolve()
  let transactionCount = 0
  const runTransaction = async <Value>(update: (transaction: SavingsGoalProgressTransaction) => Promise<Value>) => {
    const previous = lock
    let release!: () => void
    lock = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      transactionCount += 1
      const pending: Array<Record<string, unknown>> = []
      const transaction: SavingsGoalProgressTransaction = {
        async get() { return { exists: () => true, data: () => ({ ...stored }) } },
        update(_reference, patch) { pending.push(patch) }
      }
      const result = await update(transaction)
      Object.assign(stored, ...pending)
      return result
    } finally {
      release()
    }
  }

  const options = { runTransaction, goalReference: 'virtual-goal', workspaceId, mode: 'contribute' as const }
  await Promise.all([
    updateVirtualGoalAmountAtomically({ ...options, amount: 0.1 }),
    updateVirtualGoalAmountAtomically({ ...options, amount: 0.2 })
  ])

  assert.equal(transactionCount, 2)
  assert.equal(stored.currentAmount, 0.4)
})

test('invalid or linked virtual-goal updates perform no stored write', async () => {
  const stored = { workspaceId, currentAmount: 10, linkedAccountId: 'account-1' }
  let writes = 0
  const runTransaction = <Value>(update: (transaction: SavingsGoalProgressTransaction) => Promise<Value>) => update({
    async get() { return { exists: () => true, data: () => ({ ...stored }) } },
    update() { writes += 1 }
  })

  await assert.rejects(
    updateVirtualGoalAmountAtomically({ runTransaction, goalReference: 'goal', workspaceId, amount: 5, mode: 'contribute' }),
    /vinculada a una cuenta/i
  )
  await assert.rejects(
    updateVirtualGoalAmountAtomically({ runTransaction, goalReference: 'goal', workspaceId, amount: 0, mode: 'contribute' }),
    /no es válido/i
  )

  assert.equal(stored.currentAmount, 10)
  assert.equal(writes, 0)
})
