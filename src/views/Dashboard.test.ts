import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import {
  reportAllBudgetsEstimatedMonthly,
  reportBudgetScope,
  type BudgetAmountReport
} from '../lib/budgetReporting.ts'
import {
  DEFAULT_MONTHLY_BUDGET_ID,
  type BudgetExpenseTransaction
} from '../lib/budgets.ts'

const componentSource = readFileSync(new URL('./Dashboard.vue', import.meta.url), 'utf8')
const script = componentSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'Dashboard must keep a TypeScript setup script')
const sourceFile = ts.createSourceFile('Dashboard.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const computedInitializer = (name: string): string => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer.getText(sourceFile)
      }
    }
  }
  throw new Error(`Dashboard does not define computed value "${name}"`)
}

const evaluateComputed = <Value>(
  name: string,
  dependencies: Record<string, unknown>
): { value: Value } => {
  const names = Object.keys(dependencies)
  const values = Object.values(dependencies)
  const javascript = ts.transpile(`(${computedInitializer(name)})`, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None
  })
  const evaluate = new Function(...names, `return ${javascript}`) as (...args: unknown[]) => { value: Value }
  return evaluate(...values)
}

const currentMonthExpense = (overrides: Partial<BudgetExpenseTransaction> = {}): BudgetExpenseTransaction => {
  const now = new Date()
  return {
    type: 'expense',
    amount: -10,
    date: new Date(now.getFullYear(), now.getMonth(), 1),
    installments: 1,
    categoryId: 'food',
    currency: 'USD',
    ...overrides
  }
}

const computedDependency = <Value>(getter: () => Value) => ({ get value() { return getter() } })

const estimateDependencies = (
  transactions: BudgetExpenseTransaction[],
  currency: string,
  exchangeRates: Record<string, number>
) => ({
  computed: computedDependency,
  reportAllBudgetsEstimatedMonthly,
  transactionsStore: { transactions },
  primaryCurrency: { value: currency },
  goalsStore: { exchangeRates }
})

test('Dashboard estimates current monthly installments across budget IDs without adding event principal', () => {
  const transactions = [
    currentMonthExpense({ amount: -900, installments: 3, currency: 'EUR', budgetId: 'archived-event' }),
    currentMonthExpense({ amount: -30, budgetId: 'unknown-budget' }),
    currentMonthExpense({ amount: -20, budgetId: 'default-monthly' }),
    currentMonthExpense({ amount: -40, budgetId: null }),
    currentMonthExpense({ type: 'transfer', amount: -500 }),
    currentMonthExpense({ type: 'income', amount: 999 })
  ]
  const estimate = evaluateComputed<BudgetAmountReport>(
    'allBudgetsEstimatedMonthly',
    estimateDependencies(transactions, 'USD', { EUR: 2 })
  )

  assert.deepEqual(estimate.value, {
    amount: 690,
    currency: 'USD',
    complete: true,
    missingRateCurrencies: [],
    invalidRateCurrencies: []
  })
})

const legacyBudgetDependencies = (
  categoryBudgetCurrency: { status: 'unconfirmed' } | { status: 'confirmed'; code: string },
  exchangeRates: Record<string, number>,
  transactions: BudgetExpenseTransaction[]
) => ({
  computed: computedDependency,
  reportBudgetScope,
  DEFAULT_MONTHLY_BUDGET_ID,
  goalsStore: {
    categoryBudgets: { food: 100 },
    categoryBudgetCurrency,
    exchangeRates
  },
  transactionsStore: {
    transactions,
    spendingByCategoryThisMonth: (convert: (amount: number, currency: string) => number) => ({
      food: convert(60, 'EUR')
    })
  },
  primaryCurrency: { value: 'USD' },
  convert: (amount: number, currency: string) => currency === 'EUR' ? amount * (exchangeRates.EUR ?? 1) : amount,
  getCategory: () => ({ name: 'Food', color: '#ffffff' })
})

test('Dashboard keeps legacy caps nominal in confirmed currency and uses manual FX only for comparisons', () => {
  const template = componentSource.split('<script setup lang="ts">')[0]
  const transactions = [
    currentMonthExpense({ amount: -60, currency: 'EUR', budgetId: null }),
    currentMonthExpense({ amount: -1000, currency: 'USD', budgetId: 'other-budget' })
  ]
  const confirmed = evaluateComputed<{
    capCurrency: string | null
    reportingCurrency: string
    totalBudget: number | null
    totalSpentReal: number | null
    percent: number | null
    rows: Array<{ percent: number | null }>
    comparisonWarnings: string[]
  }>('budgetSummary', legacyBudgetDependencies({ status: 'confirmed', code: 'EUR' }, { EUR: 2 }, transactions))

  assert.equal(confirmed.value.capCurrency, 'EUR')
  assert.equal(confirmed.value.reportingCurrency, 'USD')
  assert.equal(confirmed.value.totalBudget, 100)
  assert.equal(confirmed.value.totalSpentReal, 120)
  assert.equal(confirmed.value.percent, 60)
  assert.equal(confirmed.value.rows[0]?.percent, 60)

  const missingRate = evaluateComputed<{
    capCurrency: string | null
    totalBudget: number | null
    percent: number | null
    comparisonWarnings: string[]
  }>('budgetSummary', legacyBudgetDependencies(
    { status: 'confirmed', code: 'EUR' },
    {},
    [currentMonthExpense({ amount: -60, currency: 'USD', budgetId: null })]
  ))
  assert.equal(missingRate.value.capCurrency, 'EUR')
  assert.equal(missingRate.value.totalBudget, 100)
  assert.equal(missingRate.value.percent, null)
  assert.ok(missingRate.value.comparisonWarnings.some(warning => warning.includes('EUR')))
  assert.match(template, /formatCurrency\(budgetSummary\.totalBudget, budgetSummary\.capCurrency\)/)
  assert.match(template, /formatCurrency\(budgetSummary\.totalSpentReal, budgetSummary\.reportingCurrency\)/)
  assert.doesNotMatch(template, /formatPrimaryCurrency\(budgetSummary\.totalBudget\)/)
})

test('Dashboard does not label or compare legacy caps before their unit is confirmed', () => {
  const template = componentSource.split('<script setup lang="ts">')[0]
  const summary = evaluateComputed<{
    capCurrency: string | null
    totalBudget: number | null
    percent: number | null
  }>('budgetSummary', legacyBudgetDependencies(
    { status: 'unconfirmed' },
    { EUR: 2 },
    [currentMonthExpense({ amount: -60, currency: 'EUR', budgetId: null })]
  ))

  assert.equal(summary.value.capCurrency, null)
  assert.equal(summary.value.totalBudget, null)
  assert.equal(summary.value.percent, null)
  assert.match(template, /Moneda de límites por confirmar/)
})

test('Dashboard exposes reporting currency and names missing and invalid manual rates without a partial total', () => {
  const transactions = [
    currentMonthExpense({ amount: -12, currency: 'EUR' }),
    currentMonthExpense({ amount: -8, currency: 'CAD' })
  ]
  const dependencies = estimateDependencies(transactions, 'USD', { CAD: 0 })
  const estimate = evaluateComputed<BudgetAmountReport>('allBudgetsEstimatedMonthly', dependencies)
  const warnings = evaluateComputed<string[]>('allBudgetsEstimateWarnings', {
    computed: computedDependency,
    allBudgetsEstimatedMonthly: estimate
  })
  const template = componentSource.split('<script setup lang="ts">')[0]

  assert.equal(estimate.value.amount, null)
  assert.equal(estimate.value.complete, false)
  assert.deepEqual([...warnings.value], [
    'Faltan tasas manuales para: EUR',
    'Tasas inválidas para: CAD'
  ])
  assert.match(template, /Moneda de reporte:/)
  assert.match(template, /allBudgetsEstimatedMonthly\.currency/)
  assert.match(template, /allBudgetsEstimateWarnings/)
  assert.match(template, /allBudgetsEstimatedMonthly\.amount !== null/)
})
