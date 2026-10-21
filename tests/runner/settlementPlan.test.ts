import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as client from '../../src/lib/mirror.ts'
import * as server from '../../functions/src/settlementPlan.ts'

const COP4 = { bridgeCurrency: 'COP', fromCurrency: 'COP', receivableCurrency: 'COP', toCurrency: 'COP' }
const stamp = (millis: number) => ({ toDate: () => new Date(millis) })

function settlementPair() {
  const date = stamp(Date.UTC(2026, 9, 21, 17))
  const paid = {
    id: 'paid-leg', workspaceId: 'home', accountId: 'from', toAccountId: 'bridge', amount: 300,
    description: 'Liquidación de Casa', categoryId: '', date, type: 'transfer', currency: 'COP',
    mirrorOf: 'received-leg', notes: 'Reembolso pagado desde Banco', settlementType: 'settlement'
  }
  const received = {
    ...paid, id: 'received-leg', workspaceId: 'personal', accountId: 'receivable', toAccountId: 'to',
    mirrorOf: 'paid-leg', notes: 'Reembolso recibido en Ahorros'
  }
  const accountsById = {
    from: { id: 'from', workspaceId: 'home', currency: 'COP' },
    bridge: { id: 'bridge', workspaceId: 'home', currency: 'COP', mirror: { workspaceId: 'personal', accountId: 'receivable', sourceAccountId: 'card' } },
    receivable: { id: 'receivable', workspaceId: 'personal', currency: 'COP' },
    to: { id: 'to', workspaceId: 'personal', currency: 'COP' }
  }
  return { paid, received, accountsById }
}

function outcome(run: () => unknown) {
  try {
    return { ok: run() }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

test('server settlement plan matches the client plan for valid and rejected inputs', () => {
  const cases = [
    { amount: 300, debt: 500, ...COP4 },
    { amount: 500, debt: 500, ...COP4 },
    { amount: 0, debt: 500, ...COP4 },
    { amount: 600, debt: 500, ...COP4 },
    { amount: 100, debt: 0, ...COP4 },
    { amount: 100, debt: 500, ...COP4, toCurrency: 'USD' }
  ]
  for (const input of cases) {
    assert.deepEqual(outcome(() => server.planSettlement(input)), outcome(() => client.planSettlement(input)), JSON.stringify(input))
  }
})

test('server settlement reversal plan matches the client plan for valid and rejected pairs', () => {
  const variants: Array<(pair: ReturnType<typeof settlementPair>) => void> = [
    () => {},
    pair => { pair.received.amount = 299 },
    pair => { pair.received.mirrorOf = 'other' },
    pair => { (pair.paid as Record<string, unknown>).reversedBy = 'reversal' },
    pair => { pair.accountsById.to.currency = 'USD' },
    pair => { pair.accountsById.bridge.mirror.accountId = 'elsewhere' },
    pair => { pair.received.date = stamp(Date.UTC(2026, 9, 22, 17)) }
  ]
  for (const mutate of variants) {
    const pair = settlementPair()
    mutate(pair)
    for (const [first, second] of [[pair.paid, pair.received], [pair.received, pair.paid]]) {
      assert.deepEqual(
        outcome(() => server.planSettlementReversal({ first, second, accountsById: pair.accountsById })),
        outcome(() => client.planSettlementReversal({ first, second, accountsById: pair.accountsById }))
      )
    }
  }
})

test('server settlement candidate check matches the client check', () => {
  const { paid } = settlementPair()
  const records = [
    paid,
    { ...paid, settlementType: 'reversal' },
    { ...paid, reversedBy: 'x' },
    { ...paid, settlementType: null },
    { ...paid, settlementType: null, notes: 'Otra nota' },
    { ...paid, type: 'expense' }
  ]
  for (const record of records) {
    assert.equal(server.isSettlementCandidate(record), client.isSettlementCandidate(record), JSON.stringify(record))
  }
})

test('server settlement rejections are a domain error the callable can expose', () => {
  assert.throws(() => server.planSettlement({ amount: 0, debt: 1, ...COP4 }), server.SettlementRejection)
})
