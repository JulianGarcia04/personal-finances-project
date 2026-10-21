import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as legacyCategoryBudgetModule from '../../functions/src/legacyCategoryBudgets.ts'

const { analyzeLegacyCategoryExpenses, buildLegacyCategoryBudgetsPatch } = legacyCategoryBudgetModule
const parseLegacyCategoryBudgetCurrency = (
  legacyCategoryBudgetModule as unknown as {
    parseLegacyCategoryBudgetCurrency?: (workspace: unknown) => string | null
  }
).parseLegacyCategoryBudgetCurrency

test('legacy AI analysis includes only default and unassigned expenses in labeled profile currency', () => {
  const analysis = analyzeLegacyCategoryExpenses({
    expenses: [
      { categoryId: 'food', amount: 10, currency: 'EUR' },
      { categoryId: 'food', amount: 20, currency: 'USD', budgetId: 'default-monthly' },
      { categoryId: 'food', amount: 999, currency: 'USD', budgetId: 'other-budget' },
      { categoryId: 'food', amount: 4, currency: 'CAD', budgetId: null }
    ],
    periodMonths: 2,
    reportingCurrency: 'USD',
    categoryBudgetCurrency: 'USD',
    exchangeRates: { EUR: 1.2, CAD: 0.8 }
  })

  assert.equal(analysis.reportingCurrency, 'USD')
  assert.equal(analysis.categoryBudgetCurrency, 'USD')
  assert.equal(analysis.complete, true)
  assert.equal(analysis.canProposeCaps, true)
  assert.deepEqual(analysis.categories, [{
    categoryId: 'food',
    totalSpent: 35,
    monthlyAverage: 18,
    transactionCount: 3,
    periodMonths: 2,
    reportingCurrency: 'USD',
    complete: true,
    missingRateCurrencies: [],
    invalidRateCurrencies: []
  }])
})

test('legacy AI analysis labels reporting currency but disables cap proposals for a different confirmed cap unit', () => {
  const analysis = analyzeLegacyCategoryExpenses({
    expenses: [{ categoryId: 'food', amount: 12, currency: 'USD', budgetId: 'default-monthly' }],
    periodMonths: 3,
    reportingCurrency: 'USD',
    categoryBudgetCurrency: 'COP',
    exchangeRates: {}
  })

  assert.equal(analysis.reportingCurrency, 'USD')
  assert.equal(analysis.categoryBudgetCurrency, 'COP')
  assert.equal(analysis.canProposeCaps, false)
  assert.equal(analysis.categories[0]?.totalSpent, 12)
  assert.equal(analysis.categories[0]?.reportingCurrency, 'USD')
})

test('missing and invalid manual rates hide partial totals and disable cap proposals', () => {
  const analysis = analyzeLegacyCategoryExpenses({
    expenses: [
      { categoryId: 'food', amount: 5, currency: 'USD', budgetId: 'default-monthly' },
      { categoryId: 'food', amount: 7, currency: 'EUR', budgetId: 'default-monthly' },
      { categoryId: 'food', amount: 9, currency: 'GBP', budgetId: 'default-monthly' }
    ],
    periodMonths: 1,
    reportingCurrency: 'USD',
    categoryBudgetCurrency: 'USD',
    exchangeRates: { GBP: 0 }
  })

  assert.equal(analysis.complete, false)
  assert.equal(analysis.canProposeCaps, false)
  assert.deepEqual(analysis.missingRateCurrencies, ['EUR'])
  assert.deepEqual(analysis.invalidRateCurrencies, ['GBP'])
  assert.deepEqual(analysis.categories[0], {
    categoryId: 'food',
    totalSpent: null,
    monthlyAverage: null,
    transactionCount: 3,
    periodMonths: 1,
    reportingCurrency: 'USD',
    complete: false,
    missingRateCurrencies: ['EUR'],
    invalidRateCurrencies: ['GBP']
  })
})

test('legacy cap writes reject unconfirmed or mismatched units without mutating stored caps', () => {
  const current = { food: 100, rent: 20 }
  const proposed = [{ categoryId: 'food', monthlyLimit: 120 }]

  assert.throws(
    () => buildLegacyCategoryBudgetsPatch(current, proposed, null, 'USD'),
    /confirmed/i
  )
  assert.deepEqual(current, { food: 100, rent: 20 })

  assert.throws(
    () => buildLegacyCategoryBudgetsPatch(current, proposed, 'COP', 'USD'),
    /currency/i
  )
  assert.deepEqual(current, { food: 100, rent: 20 })
})

test('legacy cap writes merge only the confirmed-unit category caps without mutating the input', () => {
  const current = { food: 100, rent: 20 }
  const patch = buildLegacyCategoryBudgetsPatch(current, [
    { categoryId: 'food', monthlyLimit: 120 },
    { categoryId: 'rent', monthlyLimit: 0 }
  ], 'COP', 'COP')

  assert.deepEqual(patch, { food: 120 })
  assert.deepEqual(current, { food: 100, rent: 20 })
})

test('stored cap-currency parsing distinguishes absent legacy state from malformed present values', () => {
  assert.equal(typeof parseLegacyCategoryBudgetCurrency, 'function')
  if (typeof parseLegacyCategoryBudgetCurrency !== 'function') return

  assert.equal(parseLegacyCategoryBudgetCurrency({}), null)
  for (const categoryBudgetCurrency of [undefined, null, '', 'usd', 'US', 'USDT', 'USD ']) {
    assert.throws(
      () => parseLegacyCategoryBudgetCurrency({ categoryBudgetCurrency }),
      /malformed/i
    )
  }
  assert.equal(parseLegacyCategoryBudgetCurrency({ categoryBudgetCurrency: 'GBP' }), 'GBP')
})

test('legacy AI analysis rejects malformed present cap currency before analyzing expenses', () => {
  assert.throws(() => analyzeLegacyCategoryExpenses({
    expenses: [{ categoryId: 'food', amount: 12, currency: 'USD' }],
    periodMonths: 1,
    reportingCurrency: 'USD',
    categoryBudgetCurrency: 'usd',
    exchangeRates: {}
  }), /currency/i)
})

test('legacy cap writes reject malformed confirmed currency without changing stored caps', () => {
  const current = { food: 100, rent: 20 }
  const workspace = { categoryBudgetCurrency: 'usd', categoryBudgets: current }

  assert.throws(
    () => buildLegacyCategoryBudgetsPatch(current, [
      { categoryId: 'food', monthlyLimit: 120 }
    ], workspace.categoryBudgetCurrency, workspace.categoryBudgetCurrency),
    /currency/i
  )
  assert.strictEqual(workspace.categoryBudgets, current)
  assert.deepEqual(workspace.categoryBudgets, { food: 100, rent: 20 })
})

test('schema-shaped three-letter currency GBP remains valid outside the settings selector', () => {
  const analysis = analyzeLegacyCategoryExpenses({
    expenses: [{ categoryId: 'food', amount: 12, currency: 'GBP', budgetId: 'default-monthly' }],
    periodMonths: 1,
    reportingCurrency: 'GBP',
    categoryBudgetCurrency: 'GBP',
    exchangeRates: {}
  })

  assert.equal(analysis.canProposeCaps, true)
  assert.equal(analysis.categoryBudgetCurrency, 'GBP')
  assert.deepEqual(
    buildLegacyCategoryBudgetsPatch({}, [{ categoryId: 'food', monthlyLimit: 12 }], 'GBP', 'GBP'),
    { food: 12 }
  )
})
