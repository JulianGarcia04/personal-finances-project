// Correr: node --test src/lib/mirror.test.ts   (Node 24 lee TS nativo, sin dependencias)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMirror, planSettlement } from './mirror.ts'

const COP = { bridgeCurrency: 'COP', sourceCurrency: 'COP', receivableCurrency: 'COP' }
const COP4 = { bridgeCurrency: 'COP', fromCurrency: 'COP', receivableCurrency: 'COP', toCurrency: 'COP' }

test('un gasto compartido no cambia el patrimonio de quien paga', () => {
  const d = planMirror({ amount: -500000, ...COP })
  // La tarjeta se endeuda 500k y aparece un derecho de cobro de 500k: neto 0.
  assert.equal(d.source + d.receivable, 0)
})

test('las dos contrapartidas de la deuda se cancelan entre workspaces', () => {
  const d = planMirror({ amount: -500000, ...COP })
  // Puente en casa (lo que casa debe) vs por cobrar en el personal (lo que le deben).
  assert.equal(d.bridge + d.receivable, 0)
})

test('el gasto resta en el puente y en la cuenta real, venga con el signo que venga', () => {
  for (const amount of [-500000, 500000]) {
    const d = planMirror({ amount, ...COP })
    assert.equal(d.bridge, -500000)
    assert.equal(d.source, -500000)
    assert.equal(d.receivable, 500000)
  }
})

test('rechaza monedas distintas: las transferencias del proyecto no convierten divisas', () => {
  assert.throws(
    () => planMirror({ amount: -100, bridgeCurrency: 'COP', sourceCurrency: 'USD', receivableCurrency: 'COP' }),
    /misma moneda/
  )
  assert.throws(
    () => planMirror({ amount: -100, bridgeCurrency: 'COP', sourceCurrency: 'COP', receivableCurrency: 'USD' }),
    /misma moneda/
  )
})

test('rechaza montos inválidos', () => {
  assert.throws(() => planMirror({ amount: 0, ...COP }), /distinto de cero/)
  assert.throws(() => planMirror({ amount: NaN, ...COP }), /distinto de cero/)
})

test('liquidar no cambia el patrimonio de ninguno de los dos workspaces', () => {
  const s = planSettlement({ amount: 500000, debt: 500000, ...COP4 })
  assert.equal(s.from + s.bridge, 0) // el deudor paga una deuda que ya tenía registrada
  assert.equal(s.receivable + s.to, 0) // tú cambias derecho de cobro por plata
})

test('liquidación total deja puente y por cobrar en cero', () => {
  const bridgeBalance = -500000
  const receivableBalance = 500000
  const s = planSettlement({ amount: 500000, debt: -bridgeBalance, ...COP4 })
  assert.equal(bridgeBalance + s.bridge, 0)
  assert.equal(receivableBalance + s.receivable, 0)
})

test('permite liquidación parcial y deja el resto pendiente', () => {
  const s = planSettlement({ amount: 200000, debt: 500000, ...COP4 })
  assert.equal(-500000 + s.bridge, -300000) // quedan 300k por reembolsar
})

test('rechaza liquidar más de lo pendiente, sin deuda, o en monedas distintas', () => {
  assert.throws(() => planSettlement({ amount: 600000, debt: 500000, ...COP4 }), /más de lo pendiente/)
  assert.throws(() => planSettlement({ amount: 100, debt: 0, ...COP4 }), /nada pendiente/)
  assert.throws(() => planSettlement({ amount: 0, debt: 500000, ...COP4 }), /mayor a cero/)
  assert.throws(() => planSettlement({ amount: 100, debt: 500, ...COP4, toCurrency: 'USD' }), /misma moneda/)
})

const settlementLegs = () => {
  const paid = {
    id: 'paid', workspaceId: 'home', accountId: 'checking', toAccountId: 'bridge',
    amount: 250, description: 'Liquidación de Cuenta puente', categoryId: '',
    date: new Date('2025-04-12T12:00:00.000Z'), type: 'transfer', currency: 'COP',
    mirrorOf: 'received', notes: 'Reembolso pagado desde Cuenta corriente'
  }
  const received = {
    id: 'received', workspaceId: 'personal', accountId: 'receivable', toAccountId: 'savings',
    amount: 250, description: 'Liquidación de Cuenta puente', categoryId: '',
    date: new Date('2025-04-12T12:00:00.000Z'), type: 'transfer', currency: 'COP',
    mirrorOf: 'paid', notes: 'Reembolso recibido en Ahorros'
  }
  const accountsById = {
    checking: { id: 'checking', workspaceId: 'home', currency: 'COP' },
    bridge: {
      id: 'bridge', workspaceId: 'home', currency: 'COP',
      mirror: { workspaceId: 'personal', accountId: 'receivable', sourceAccountId: 'checking' }
    },
    receivable: { id: 'receivable', workspaceId: 'personal', currency: 'COP' },
    savings: { id: 'savings', workspaceId: 'personal', currency: 'COP' }
  }
  return { paid, received, accountsById }
}

test('plans an accounting-only reversal only for a strictly validated settlement pair', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.planSettlementReversal, 'function', 'settlement reversal planner is required')
  const { paid, received, accountsById } = settlementLegs()
  const plan = mirror.planSettlementReversal({ first: received, second: paid, accountsById })

  assert.deepEqual(plan, {
    amount: 250,
    paidLegId: 'paid',
    receivedLegId: 'received',
    fromAccountId: 'checking',
    bridgeAccountId: 'bridge',
    receivableAccountId: 'receivable',
    toAccountId: 'savings',
    workspaceId: 'home',
    mirrorWorkspaceId: 'personal',
    deltas: { from: 250, bridge: -250, receivable: 250, to: -250 }
  })
})

test('matches a legacy date-only leg with its local-noon counterpart on the same calendar day', async () => {
  const mirror = await import('./mirror.ts')
  const { paid, received, accountsById } = settlementLegs()
  const plan = mirror.planSettlementReversal({
    first: { ...received, date: new Date(2025, 3, 12, 12) },
    second: { ...paid, date: '2025-04-12' },
    accountsById
  })

  assert.equal(plan.paidLegId, 'paid')
})

test('does not identify generic mirrorOf activity as a bridge settlement', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.planSettlementReversal, 'function', 'settlement reversal planner is required')
  assert.equal(typeof mirror.isSettlementCandidate, 'function', 'settlement candidates must be identified explicitly')
  const { paid, received, accountsById } = settlementLegs()
  assert.equal(mirror.isSettlementCandidate(paid), true)
  assert.equal(mirror.isSettlementCandidate({ ...paid, type: 'expense' }), false)
  assert.throws(() => mirror.planSettlementReversal({
    first: { ...received, type: 'expense', amount: -250 }, second: paid, accountsById
  }), /liquidación|settlement/i)
  assert.throws(() => mirror.planSettlementReversal({
    first: received, second: { ...paid, mirrorOf: 'unrelated' }, accountsById
  }), /vínculos/)
  assert.throws(() => mirror.planSettlementReversal({
    first: received, second: { ...paid, currency: 'USD' }, accountsById
  }), /monedas/)
})

test('fails closed for ambiguous legacy pairs and already reversed settlements', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.planSettlementReversal, 'function', 'settlement reversal planner is required')
  const { paid, received, accountsById } = settlementLegs()
  assert.throws(() => mirror.planSettlementReversal({
    first: { ...received, notes: 'Transferencia espejo' }, second: paid, accountsById
  }), /liquidación|settlement/i)
  assert.throws(() => mirror.planSettlementReversal({
    first: { ...received, reversedBy: 'reversal-a' }, second: paid, accountsById
  }), /reverted|revertid/i)
})

test('a bridge account only accepts shared expenses; every other movement on, onto or to it is refused', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.assertBridgeMovement, 'function', 'bridge movement guard is required')
  const bridge = { mirror: { workspaceId: 'personal', accountId: 'receivable', sourceAccountId: 'card' } }
  const bank = { mirror: null }

  assert.doesNotThrow(() => mirror.assertBridgeMovement('expense', bridge))
  for (const type of ['expense', 'income', 'loan', 'loan_payment']) {
    assert.doesNotThrow(() => mirror.assertBridgeMovement(type, bank))
  }
  assert.doesNotThrow(() => mirror.assertBridgeMovement('transfer', bank, bank))

  for (const type of ['income', 'transfer', 'loan', 'loan_payment']) {
    assert.throws(() => mirror.assertBridgeMovement(type, bridge, bank), /cuenta puente solo admite gastos compartidos/)
  }
  assert.throws(() => mirror.assertBridgeMovement('transfer', bank, bridge), /cuenta puente solo admite gastos compartidos/)
})

function sharedExpensePair() {
  const bridgeLeg = {
    id: 'expense', workspaceId: 'home', accountId: 'bridge', toAccountId: null, amount: -300,
    type: 'expense', mirrorOf: 'transfer', description: 'Mercado', categoryId: 'food', notes: null
  }
  const mirrorLeg = {
    id: 'transfer', workspaceId: 'personal', accountId: 'card', toAccountId: 'receivable', amount: 300,
    type: 'transfer', mirrorOf: 'expense', description: 'Mercado', categoryId: '',
    notes: 'Gasto reembolsable registrado en "Bridge"'
  }
  return { bridgeLeg, mirrorLeg }
}

test('a shared expense pair is identified from either leg', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.sharedExpenseLegs, 'function', 'shared expense pair splitter is required')
  const { bridgeLeg, mirrorLeg } = sharedExpensePair()
  assert.deepEqual(mirror.sharedExpenseLegs(bridgeLeg, mirrorLeg), { bridgeLeg, mirrorLeg })
  assert.deepEqual(mirror.sharedExpenseLegs(mirrorLeg, bridgeLeg), { bridgeLeg, mirrorLeg })
})

test('settlements, reversals and broken pairs are not shared expenses', async () => {
  const mirror = await import('./mirror.ts')
  const { bridgeLeg, mirrorLeg } = sharedExpensePair()
  const { paid, received } = settlementLegs()
  assert.throws(() => mirror.sharedExpenseLegs(paid, received), /liquidaciones no se editan/)
  assert.throws(() => mirror.sharedExpenseLegs(
    { ...paid, settlementType: 'reversal' }, { ...received, settlementType: 'reversal' }
  ), /liquidaciones no se editan/)
  assert.throws(() => mirror.sharedExpenseLegs(bridgeLeg, { ...mirrorLeg, mirrorOf: 'other' }), /pata espejo/)
  assert.throws(() => mirror.sharedExpenseLegs(bridgeLeg, { ...mirrorLeg, amount: 200 }), /no es válido/)
  assert.throws(() => mirror.sharedExpenseLegs(bridgeLeg, { ...mirrorLeg, type: 'expense', amount: -300 }), /no es válido/)
})

test('editing a shared expense moves the three balances by the difference only', async () => {
  const mirror = await import('./mirror.ts')
  assert.equal(typeof mirror.planSharedExpenseEdit, 'function', 'shared expense edit planner is required')
  // 300 -> 450: the debt grows 150 on both sides and the card is charged 150 more.
  assert.deepEqual(mirror.planSharedExpenseEdit({ previousAmount: -300, amount: -450, ...COP }), {
    bridge: -150, source: -150, receivable: 150
  })
  // 300 -> 120, whatever sign the form sends.
  assert.deepEqual(mirror.planSharedExpenseEdit({ previousAmount: -300, amount: 120, ...COP }), {
    bridge: 180, source: 180, receivable: -180
  })
  assert.deepEqual(mirror.planSharedExpenseEdit({ previousAmount: -300, amount: -300, ...COP }), {
    bridge: 0, source: 0, receivable: 0
  })
  assert.throws(() => mirror.planSharedExpenseEdit({ previousAmount: -300, amount: 0, ...COP }), /distinto de cero/)
  assert.throws(() => mirror.planSharedExpenseEdit({
    previousAmount: -300, amount: -100, bridgeCurrency: 'COP', sourceCurrency: 'USD', receivableCurrency: 'COP'
  }), /misma moneda/)
})
