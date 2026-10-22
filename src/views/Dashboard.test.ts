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
  budgetScopedMonthFilter,
  type BudgetExpenseTransaction
} from '../lib/budgets.ts'
import {
  alignedMonthPeriods,
  budgetCardFigures,
  expenseAmountInPeriod,
  hasBudgetActivity,
  isDateInPeriod,
  percentChange,
  projectMonthEndExpenses,
  splitMonthEndExpenses
} from '../lib/dashboardMetrics.ts'
import { createCardBillingLookup, expenseAmountForMonth, type BillingAccount } from '../lib/installments.ts'

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

const billingDependency = (accounts: BillingAccount[] = []) => ({ value: createCardBillingLookup(accounts) })

// Closing 31 keeps every purchase on its calendar month's statement and due day 10 pays
// it the following month, so the expectations do not depend on today's date.
const visa: BillingAccount = { id: 'visa', type: 'credit', statementClosingDay: 31, paymentDueDay: 10 }

const previousMonthFirstDay = () => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() - 1, 1)
}

const estimateDependencies = (
  transactions: BudgetExpenseTransaction[],
  currency: string,
  exchangeRates: Record<string, number>,
  accounts: BillingAccount[] = []
) => ({
  computed: computedDependency,
  reportAllBudgetsEstimatedMonthly,
  transactionsStore: { transactions },
  primaryCurrency: { value: currency },
  goalsStore: { exchangeRates },
  cardBillingFor: billingDependency(accounts)
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
  getCategory: () => ({ name: 'Food', color: '#ffffff' }),
  cardBillingFor: billingDependency()
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

test('Dashboard budget estimate counts card statements due this month instead of this month\'s card purchases', () => {
  const transactions = [
    currentMonthExpense({ amount: -50, accountId: 'visa', date: previousMonthFirstDay() }),
    currentMonthExpense({ amount: -1000, accountId: 'visa' }),
    currentMonthExpense({ amount: -10, accountId: 'cash' })
  ]
  const estimate = evaluateComputed<BudgetAmountReport>(
    'allBudgetsEstimatedMonthly',
    estimateDependencies(transactions, 'USD', {}, [visa])
  )

  assert.equal(estimate.value.amount, 60)
})

test('Dashboard month-end projection adds card statements of earlier purchases once without extrapolating them', () => {
  const now = new Date()
  const transactions = [
    currentMonthExpense({ amount: -50, accountId: 'visa', date: previousMonthFirstDay(), categoryId: 'food' }),
    currentMonthExpense({ amount: -10, accountId: 'cash', categoryId: 'food' }),
    currentMonthExpense({ amount: -30, accountId: 'cash', categoryId: 'travel' })
  ]
  const projection = evaluateComputed<{ total: number; budgeted: number }>('monthEndProjection', {
    computed: computedDependency,
    transactionsStore: { transactions },
    goalsStore: { categoryBudgets: { food: 100 } },
    convert: (amount: number) => amount,
    cardBillingFor: billingDependency([visa]),
    splitMonthEndExpenses,
    projectMonthEndExpenses
  })
  const elapsed = now.getDate()
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  assert.equal(projection.value.total, (40 / elapsed) * days + 50)
  assert.equal(projection.value.budgeted, (10 / elapsed) * days + 50)
})

// --- S9: "Todo" / "Por presupuesto" ---

// Salary 5,000,000 + 1,000,000 income assigned to the event "Ventas Casa", 300,000 spent in
// Ventas Casa and 50,000 of everyday spending, all on day 1 of the current month.
const s9Transactions = () => {
  const now = new Date()
  const day1 = new Date(now.getFullYear(), now.getMonth(), 1, 12)
  return [
    { type: 'income', amount: 5000000, date: day1, currency: 'COP', accountId: 'bank' },
    { type: 'income', amount: 1000000, date: day1, currency: 'COP', accountId: 'bank', budgetId: 'ventas-casa' },
    { type: 'expense', amount: -300000, date: day1, currency: 'COP', accountId: 'bank', budgetId: 'ventas-casa', installments: 1 },
    { type: 'expense', amount: -50000, date: day1, currency: 'COP', accountId: 'bank', installments: 1 }
  ] as unknown as BudgetExpenseTransaction[]
}

const s9OperatingBudgets = [
  { budget: { id: 'ventas-casa', name: 'Ventas Casa', kind: 'event', capCurrency: 'COP', archived: false }, categoryCaps: {} },
  { budget: { id: 'viaje', name: 'Viaje', kind: 'event', capCurrency: 'COP', archived: false }, categoryCaps: {} },
  { budget: { id: 'viejo', name: 'Viejo', kind: 'event', capCurrency: 'COP', archived: true }, categoryCaps: {} }
]

const s9MonthFlow = (transactions: BudgetExpenseTransaction[]) => {
  const transactionsStore = { transactions }
  const budgetMonthFilter = evaluateComputed<never>('budgetMonthFilter', {
    budgetScopedMonthFilter,
    transactionsStore,
    budgetKinds: { value: new Map(s9OperatingBudgets.map(({ budget }) => [budget.id, budget.kind])) },
    linkedBudgetOfAccount: () => null
  })
  return evaluateComputed<never>('getMoMData', {
    alignedMonthPeriods,
    transactionsStore,
    cardBillingFor: billingDependency(),
    convert: (amount: number) => amount,
    expenseAmountForMonth,
    expenseAmountInPeriod,
    isDateInPeriod,
    percentChange,
    budgetMonthFilter
  }) as unknown as (type: 'income' | 'expense', view: 'all' | 'budget') => { current: number; toDate: number; previous: number }
}

test('S9: "Todo" keeps every movement while "Por presupuesto" leaves out budget funds and self-funded spending', () => {
  const getMoMData = s9MonthFlow(s9Transactions())
  assert.equal(getMoMData('income', 'all').current, 6000000)
  assert.equal(getMoMData('expense', 'all').current, 350000)
  assert.equal(getMoMData('income', 'budget').current, 5000000)
  assert.equal(getMoMData('income', 'budget').toDate, 5000000)
  assert.equal(getMoMData('expense', 'budget').current, 50000)
})

test('S9: the month-over-month comparison of "Por presupuesto" judges each month by its own funding', () => {
  const now = new Date()
  const previousDay1 = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)
  const getMoMData = s9MonthFlow([
    { type: 'income', amount: 400, date: previousDay1, currency: 'COP', budgetId: 'ventas-casa' },
    { type: 'income', amount: 900, date: previousDay1, currency: 'COP' }
  ] as unknown as BudgetExpenseTransaction[])
  assert.equal(getMoMData('income', 'all').previous, 1300)
  assert.equal(getMoMData('income', 'budget').previous, 900)
})

test('S9: "Todo" is the default and runway, limit and savings keep their meaning', () => {
  assert.match(script, /const flowView = ref<FlowView>\(readFlowView\(\)\)/)
  assert.match(script, /const allExpensesData = computed\(\(\) => getMoMData\('expense', 'all'\)\)/)
  assert.match(script, /monthToDateExpenses: allExpensesData\.value\.toDate/)
  assert.match(script, /const incomeData = computed\(\(\) => getMoMData\('income', flowView\.value\)\)/)
  assert.match(componentSource, /aria-pressed="flowView === 'all'"[\s\S]{0,500}Todo/)
  assert.match(componentSource, /aria-pressed="flowView === 'budget'"[\s\S]{0,500}Por presupuesto/)
  assert.match(componentSource, /Todo el dinero que entra y sale de tus cuentas\./)
  assert.match(componentSource, /Ingresos y gastos del mes sin los fondos propios de tus presupuestos\./)
  // The choice is remembered per device and survives storage being unavailable.
  assert.match(script, /try \{[^}]*localStorage\.getItem\(FLOW_VIEW_KEY\)/)
  assert.match(script, /try \{[^}]*localStorage\.setItem\(FLOW_VIEW_KEY, view\)/)
})

test('S9: the per-budget panel lists active budgets with activity and their funds, spending and available', () => {
  const breakdown = evaluateComputed<{ id: string; name: string; fundsAmount: number | null; spent: number | null; available: number | null }[]>('budgetBreakdown', {
    computed: computedDependency,
    goalsStore: { operatingBudgets: s9OperatingBudgets, exchangeRates: {} },
    transactionsStore: { transactions: s9Transactions() },
    primaryCurrency: { value: 'COP' },
    cardBillingFor: billingDependency(),
    linkedBudgetOfAccount: () => null,
    budgetCardFigures,
    hasBudgetActivity
  })
  assert.deepEqual(breakdown.value.map(({ id, name, fundsAmount, spent, available }) => ({ id, name, fundsAmount, spent, available })), [
    { id: 'ventas-casa', name: 'Ventas Casa', fundsAmount: 1000000, spent: 300000, available: 700000 }
  ])
  assert.match(componentSource, /v-if="flowView === 'budget'"[\s\S]{0,400}data-testid="dashboard-budget-breakdown"/)
  assert.match(componentSource, /data-testid="dashboard-budget-breakdown"[\s\S]*?to="\/goals"/)
})
