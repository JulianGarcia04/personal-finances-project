import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUPPORTED_CURRENCIES, currencyOptionsWith, defaultCurrencyCode } from './currencies.ts'

test('currency options keep a stored code outside the supported list', () => {
  assert.equal(currencyOptionsWith('COP'), SUPPORTED_CURRENCIES)
  assert.equal(currencyOptionsWith(null), SUPPORTED_CURRENCIES)
  const withStored = currencyOptionsWith('gbp')
  assert.equal(withStored.length, SUPPORTED_CURRENCIES.length + 1)
  assert.deepEqual(withStored.at(-1), { code: 'GBP', label: 'GBP' })
})

test('default currency prefers the configured code and falls back to the first option', () => {
  assert.equal(defaultCurrencyCode('usd'), 'USD')
  assert.equal(defaultCurrencyCode('GBP'), 'COP')
  assert.equal(defaultCurrencyCode(undefined), 'COP')
})
