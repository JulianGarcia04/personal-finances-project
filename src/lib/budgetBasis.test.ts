import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGET_BASIS_HINTS,
  BUDGET_BASIS_LABELS,
  budgetBasis,
  parseBudgetBasis,
  setBudgetBasis
} from './budgetBasis.ts'

test('parseBudgetBasis defaults to consumption and accepts payment', () => {
  assert.equal(parseBudgetBasis('payment'), 'payment')
  assert.equal(parseBudgetBasis('consumption'), 'consumption')
  assert.equal(parseBudgetBasis(null), 'consumption')
  assert.equal(parseBudgetBasis('other'), 'consumption')
})

test('budget basis starts on consumption and survives missing storage', () => {
  assert.equal(budgetBasis.value, 'consumption')
  setBudgetBasis('payment')
  assert.equal(budgetBasis.value, 'payment')
  setBudgetBasis('consumption')
  assert.equal(budgetBasis.value, 'consumption')
})

test('each budget view names what it counts', () => {
  assert.equal(BUDGET_BASIS_LABELS.consumption, 'Consumo del mes')
  assert.equal(BUDGET_BASIS_LABELS.payment, 'Pagos del mes')
  assert.match(BUDGET_BASIS_HINTS.consumption, /tarjeta de crédito/)
  assert.match(BUDGET_BASIS_HINTS.consumption, /corte/)
  assert.match(BUDGET_BASIS_HINTS.payment, /meses anteriores/)
})
