import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertWithRates, detectFxWarnings, effectiveExchangeRates } from './fx.ts'

test('S10: effectiveExchangeRates returns stored rates when base matches reporting currency or is legacy unset', () => {
  assert.deepEqual(effectiveExchangeRates({ USD: 4000 }, 'COP', 'COP'), {
    rates: { USD: 4000 },
    mismatchedBase: null
  })
  assert.deepEqual(effectiveExchangeRates({ USD: 4000 }, null, 'COP'), {
    rates: { USD: 4000 },
    mismatchedBase: null
  })
  assert.deepEqual(effectiveExchangeRates({}, 'COP', 'USD'), {
    rates: {},
    mismatchedBase: null
  })
})

test('S10: effectiveExchangeRates rejects rates authored for a different base currency', () => {
  assert.deepEqual(effectiveExchangeRates({ USD: 4000, EUR: 4400 }, 'COP', 'USD'), {
    rates: {},
    mismatchedBase: 'COP'
  })
})

test('S10: convertWithRates never multiplies by rates authored for another base currency', () => {
  assert.equal(convertWithRates(100, 'USD', 'COP', { USD: 4000 }, 'COP'), 400_000)
  assert.equal(convertWithRates(100, 'EUR', 'USD', { EUR: 4400 }, 'COP'), 100)
  assert.equal(convertWithRates(100, 'USD', 'USD', { EUR: 4400 }, 'COP'), 100)
})

test('S10: detectFxWarnings reports mismatched base currency, missing rates, and invalid rates', () => {
  assert.deepEqual(
    detectFxWarnings({
      currencies: ['COP', 'USD', 'EUR', 'GBP'],
      reportingCurrency: 'COP',
      exchangeRates: { USD: 4000, GBP: 0 },
      exchangeRatesBaseCurrency: 'COP'
    }),
    { mismatchedBase: null, missingCurrencies: ['EUR'], invalidCurrencies: ['GBP'] }
  )

  assert.deepEqual(
    detectFxWarnings({
      currencies: ['USD', 'EUR'],
      reportingCurrency: 'USD',
      exchangeRates: { EUR: 4400 },
      exchangeRatesBaseCurrency: 'COP'
    }),
    { mismatchedBase: 'COP', missingCurrencies: ['EUR'], invalidCurrencies: [] }
  )

  assert.deepEqual(
    detectFxWarnings({
      currencies: ['COP', 'COP'],
      reportingCurrency: 'COP',
      exchangeRates: { USD: 4000 },
      exchangeRatesBaseCurrency: 'COP'
    }),
    { mismatchedBase: null, missingCurrencies: [], invalidCurrencies: [] }
  )
})
