import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitMoney } from './money.ts'

const cop = (val: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(val)

test('splits es-CO currency at the non-breaking space after the symbol', () => {
  const [symbol, amount] = splitMoney(cop(123456789))
  assert.equal(symbol, '$')
  assert.equal(amount, '123.456.789')
})

test('keeps the minus sign with the symbol for negative amounts', () => {
  const [symbol, amount] = splitMoney(cop(-2500))
  assert.equal(`${symbol} ${amount}`.replace(/\s/g, ''), cop(-2500).replace(/\s/g, ''))
  assert.ok(!/\s/.test(amount))
  assert.match(amount, /^[\d.,]+$/)
})

test('handles narrow no-break and regular spaces', () => {
  assert.deepEqual(splitMoney('US$ 1,000'), ['US$', '1,000'])
  assert.deepEqual(splitMoney('€ 50'), ['€', '50'])
})

test('returns the whole string as the number part when there is no space', () => {
  assert.deepEqual(splitMoney('$1.000'), ['', '$1.000'])
})
