import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUPPORTED_COUNTRIES, SUPPORTED_CURRENCIES, currencyForCountry, currencyOptionsWith, defaultCurrencyCode } from './currencies.ts'

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

test('every supported country maps to a supported currency', () => {
  for (const country of SUPPORTED_COUNTRIES) {
    assert.ok(SUPPORTED_CURRENCIES.some(option => option.code === country.currency), country.code)
    assert.equal(currencyForCountry(country.code), country.currency)
  }
  assert.equal(currencyForCountry('CO'), 'COP')
  assert.equal(currencyForCountry('ES'), 'EUR')
})

test('currencyForCountry falls back to the first supported currency for unknown countries', () => {
  assert.equal(currencyForCountry('ZZ'), SUPPORTED_CURRENCIES[0].code)
})
