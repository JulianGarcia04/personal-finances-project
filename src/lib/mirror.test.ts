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
