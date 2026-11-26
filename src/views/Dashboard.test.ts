import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as Router from 'vue-router'
import {
  reportAllBudgetsEstimatedMonthly,
  reportBudgetScope,
  type BudgetAmountReport
} from '../lib/budgetReporting.ts'
import {
  DEFAULT_MONTHLY_BUDGET_ID,
  budgetScopedMonthFilter,
  resolveBudgetId,
  type BudgetExpenseTransaction
} from '../lib/budgets.ts'
import {
  alignedMonthPeriods,
  budgetCardFigures,
  monthComparisonPeriods,
  monthReferenceDate,
  committedCardPayments,
  expenseAmountInPeriod,
  hasBudgetActivity,
  isDateInPeriod,
  percentChange,
  previousFullMonths,
  projectionChecks,
  projectMonthEndExpenses,
  runwayDays,
  spendableUntilMonthEnd,
  splitMonthEndExpenses,
  type ProjectionCheck
} from '../lib/dashboardMetrics.ts'
import { createCardBillingLookup, expenseAmountForMonth, type BillingAccount, type ImputationBasis } from '../lib/installments.ts'
import { buildCardStatementLedger } from '../lib/cardStatements.ts'
import { BUDGET_BASIS_LABELS } from '../lib/budgetBasis.ts'
import { daysUntil, getNextOccurrence } from '../lib/creditCycle.ts'

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

// The month the Dashboard shows (?mes=); the current month unless a test selects another one.
type CalendarMonth = { year: number; month: number }
const thisMonth = (): CalendarMonth => {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() }
}
const monthDependencies = (selected: CalendarMonth = thisMonth()) => ({
  selectedMonth: { value: selected },
  monthComparisonPeriods,
  monthReferenceDate
})

const billingDependency = (accounts: BillingAccount[] = [], basis?: ImputationBasis) => ({ value: createCardBillingLookup(accounts, basis) })

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
  accounts: BillingAccount[] = [],
  basis?: ImputationBasis
) => ({
  computed: computedDependency,
  reportAllBudgetsEstimatedMonthly,
  transactionsStore: { transactions },
  primaryCurrency: { value: currency },
  goalsStore: { exchangeRates },
  activeExchangeRates: { value: exchangeRates },
  budgetBillingFor: billingDependency(accounts, basis),
  ...monthDependencies()
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
  activeExchangeRates: { value: exchangeRates },
  transactionsStore: {
    transactions,
    spendingByCategoryThisMonth: (convert: (amount: number, currency: string) => number) => ({
      food: convert(60, 'EUR')
    })
  },
  primaryCurrency: { value: 'USD' },
  convert: (amount: number, currency: string) => currency === 'EUR' ? amount * (exchangeRates.EUR ?? 1) : amount,
  getCategory: () => ({ name: 'Food', color: '#ffffff' }),
  budgetBillingFor: billingDependency(),
  ...monthDependencies()
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

test('Dashboard budget estimate counts this month\'s card purchases by consumption and statements due this month by payment', () => {
  const transactions = [
    currentMonthExpense({ amount: -50, accountId: 'visa', date: previousMonthFirstDay() }),
    currentMonthExpense({ amount: -1000, accountId: 'visa' }),
    currentMonthExpense({ amount: -10, accountId: 'cash' })
  ]
  const estimateFor = (basis: ImputationBasis) => evaluateComputed<BudgetAmountReport>(
    'allBudgetsEstimatedMonthly',
    estimateDependencies(transactions, 'USD', {}, [visa], basis)
  )

  assert.equal(estimateFor('consumption').value.amount, 1010)
  assert.equal(estimateFor('payment').value.amount, 60)
})

test('Dashboard projects card statements once, keeping the cash-flow projection apart from the base and category cap projections', () => {
  const now = new Date()
  const transactions = [
    currentMonthExpense({ amount: -50, accountId: 'visa', date: previousMonthFirstDay(), categoryId: 'food', currency: 'EUR' }),
    currentMonthExpense({ amount: -10, accountId: 'cash', categoryId: 'food', budgetId: DEFAULT_MONTHLY_BUDGET_ID }),
    currentMonthExpense({ amount: -30, accountId: 'cash', categoryId: 'travel' }),
    currentMonthExpense({ amount: -100, accountId: 'visa', date: previousMonthFirstDay(), budgetId: 'archived-event' }),
    currentMonthExpense({ amount: -20, accountId: 'cash', budgetId: 'extra-monthly' })
  ]
  const dependencies = {
    computed: computedDependency,
    transactionsStore: { transactions },
    goalsStore: { categoryBudgets: { food: 100 } },
    convert: (amount: number, currency: string) => currency === 'EUR' ? amount * 2 : amount,
    cardBillingFor: billingDependency([visa]),
    budgetBillingFor: billingDependency([visa], 'payment'),
    splitMonthEndExpenses,
    projectMonthEndExpenses,
    resolveBudgetId,
    DEFAULT_MONTHLY_BUDGET_ID,
    ...monthDependencies()
  }
  const projection = evaluateComputed<number>('monthEndProjection', dependencies)
  const capProjection = evaluateComputed<{ budgeted: number; base: number; baseSpent: number }>('budgetMonthEndProjection', dependencies)
  const elapsed = now.getDate()
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  assert.equal(projection.value, (60 / elapsed) * days + 200)
  assert.deepEqual(capProjection.value, {
    budgeted: (10 / elapsed) * days + 100,
    base: (40 / elapsed) * days + 100,
    baseSpent: 140
  })
})

test('S8: Dashboard reports uncapped budget percent, reporting-currency limit for projection, negative savingsRate, omits $0 historical categories, and excludes bridge cards from upcoming payments', () => {
  // Uncapped budgetSummary.percent: food spent 1500/500, rent spent 0/500 -> total 150% (not 50% capped).
  const uncapped = evaluateComputed<{ percent: number | null; totalLimitForReporting: number | null }>('budgetSummary', {
    ...legacyBudgetDependencies({ status: 'confirmed', code: 'EUR' }, { EUR: 2 }, [
      currentMonthExpense({ amount: -1500, currency: 'USD', categoryId: 'food', budgetId: null })
    ]),
    goalsStore: {
      categoryBudgets: { food: 250, rent: 250 },
      categoryBudgetCurrency: { status: 'confirmed', code: 'EUR' },
      exchangeRates: { EUR: 2 }
    }
  })
  assert.equal(uncapped.value.totalLimitForReporting, 1000)
  assert.equal(uncapped.value.percent, 150)

  // Negative savingsRate is not clamped to 0 when expenses exceed income.
  const deficitRate = evaluateComputed<number>('savingsRate', {
    computed: computedDependency,
    monthlyIncome: { value: 1000 },
    monthlyExpenses: { value: 1250 }
  })
  assert.equal(deficitRate.value, -25)

  // Historical $0-share expenses must not create $0 keys in expensesByCategory.
  const oldDate = new Date(2020, 0, 15)
  const categories = evaluateComputed<Record<string, number>>('expensesByCategory', {
    computed: computedDependency,
    transactionsStore: { transactions: [currentMonthExpense({ date: oldDate, amount: -50, categoryId: 'food' })] },
    cardBillingFor: billingDependency(),
    expenseAmountForMonth,
    getCategory: () => ({ name: 'Food', color: '#fff' }),
    convert: (amount: number) => amount,
    ...monthDependencies()
  })
  assert.deepEqual(categories.value, {})

  // Bridge credit card must be excluded from upcomingCardPayments.
  assert.match(script, /upcomingCardPayments = computed[\s\S]*?\.filter\(acc => acc\.type === 'credit' && !acc\.mirror && acc\.paymentDueDay\)/)
  assert.match(script, /budgetTotal: budgetSummary\.value\?\.totalLimitForReporting \?\? 0/)
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
    linkedBudgetOfAccount: () => null,
    convert: (amount: number) => amount
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
    budgetMonthFilter,
    ...monthDependencies()
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

test('the per-budget panel explains funds overdrawn by transfers out', () => {
  assert.match(componentSource, /data-testid="dashboard-budget-breakdown"[\s\S]*?v-if="budget\.overdrawn"[^>]*>\s*Salió más plata de la que entró a este presupuesto\.\s*</)
})

test('S9: the per-budget panel lists active budgets with activity and their funds, spending and available', () => {
  const breakdown = evaluateComputed<{ id: string; name: string; fundsAmount: number | null; spent: number | null; available: number | null }[]>('budgetBreakdown', {
    computed: computedDependency,
    goalsStore: { operatingBudgets: s9OperatingBudgets, exchangeRates: {} },
    activeExchangeRates: { value: {} },
    transactionsStore: { transactions: s9Transactions() },
    primaryCurrency: { value: 'COP' },
    budgetBillingFor: billingDependency(),
    linkedBudgetOfAccount: () => null,
    budgetCardFigures,
    hasBudgetActivity,
    ...monthDependencies()
  })
  assert.deepEqual(breakdown.value.map(({ id, name, fundsAmount, spent, available }) => ({ id, name, fundsAmount, spent, available })), [
    { id: 'ventas-casa', name: 'Ventas Casa', fundsAmount: 1000000, spent: 300000, available: 700000 }
  ])
  assert.match(componentSource, /v-if="flowView === 'budget'"[\s\S]{0,400}data-testid="dashboard-budget-breakdown"/)
  // The link opens Presupuestos on the shown month (S9 T7b); its targets are checked on the mounted view.
  assert.match(componentSource, /data-testid="dashboard-budget-breakdown"[\s\S]*?:to="budgetsLink"/)
})

test('budget basis: Dashboard budget comparisons follow the basis while cash flow keeps the payment month', () => {
  assert.ok(script)
  assert.match(script, /const budgetBasis = computed\(\(\) => workspacesStore\.activeBudgetCardBasis\)/, 'budget widgets read the active workspace basis')
  assert.doesNotMatch(script, /import \{[^}]*\bbudgetBasis\b[^}]*\} from '@\/lib\/budgetBasis'/, 'no device-wide basis')
  assert.match(script, /const cardBillingFor = computed\(\(\) => createCardBillingLookup\(accountsStore\.accounts, 'payment', \{\s*transactions: transactionsStore\.transactions\s*\}\)\)/)
  assert.match(script, /const budgetBillingFor = computed\(\(\) => createCardBillingLookup\(accountsStore\.accounts, budgetBasis\.value, \{\s*transactions: transactionsStore\.transactions\s*\}\)\)/)
  // Budget side: all-budgets estimate, per-budget panel and category caps, plus the base and
  // category cap projections.
  assert.equal(script.match(/cardBilling: budgetBillingFor\.value/g)?.length, 3)
  assert.equal(script.match(/billingFor: budgetBillingFor\.value/g)?.length, 1)
  assert.equal(script.match(/cardBilling: cardBillingFor\.value/g), null)
  // Cash-flow side: the month-end projection headline, month-over-month expenses, runway,
  // member expenses, the category donut and the six-month bar chart.
  assert.equal(script.match(/billingFor: cardBillingFor\.value/g)?.length, 1)
  assert.equal(script.match(/cardBillingFor\.value\(/g)?.length, 5)
  assert.equal(componentSource.match(/data-testid="dashboard-budget-basis-caption"/g)?.length, 3)
  assert.equal(componentSource.match(/data-testid="dashboard-cap-basis"/g)?.length, 2)
})

// --- S6: budget comparisons follow the workspace basis; cash flow keeps the payment month ---

// Visa (closing 31, due 10) has a 1,000 purchase this month, on the statement paid next month,
// and 300 of it was already transferred to the card this month. Mastercard (closing 1, due 31)
// has a 200 purchase from last month that is due at this month's end. The base budget also has
// 100 in cash; another monthly budget has 400 in cash plus the Mastercard purchase.
const basisFixture = () => {
  const now = new Date()
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 12)
  const transactions = [
    { ...currentMonthExpense({ amount: -1000, accountId: 'visa', date: thisMonth }), userId: 'bo' },
    currentMonthExpense({ amount: -100, accountId: 'cash', date: thisMonth, budgetId: DEFAULT_MONTHLY_BUDGET_ID }),
    currentMonthExpense({ amount: -400, accountId: 'cash', date: thisMonth, budgetId: 'extra-monthly', categoryId: 'travel' }),
    currentMonthExpense({
      amount: -200,
      accountId: 'mastercard',
      date: new Date(now.getFullYear(), now.getMonth() - 1, 15, 12),
      budgetId: 'extra-monthly',
      categoryId: 'travel'
    }),
    { type: 'transfer', amount: 300, currency: 'USD', date: thisMonth, accountId: 'savings', toAccountId: 'visa' }
  ] as unknown as BudgetExpenseTransaction[]
  const accounts = [
    { ...visa, name: 'Visa', currency: 'USD', balance: -700 },
    { id: 'mastercard', type: 'credit', name: 'Mastercard', currency: 'USD', statementClosingDay: 1, paymentDueDay: 31, balance: -200 },
    { id: 'cash', type: 'cash', name: 'Efectivo', currency: 'USD', balance: 5000 }
  ] as BillingAccount[]
  return { transactions, accounts }
}

const DASHBOARD_COMPUTED = [
  'monthEndProjection', 'budgetMonthEndProjection', 'projectionStatus', 'projectionExceeds',
  'baseExpenseLimitPercent', 'baseExpenseLimitExceeded', 'allExpensesData', 'liquidityDays',
  'expensesByCategory', 'memberExpenses', 'upcomingCardPayments', 'committedCards', 'spendable',
  'capBasisNote'
]

// Evaluates the real Dashboard computed values for the fixture, with the workspace basis on the
// budget side; each one reads the others lazily, as Vue does.
const dashboardWithBasis = (basis: ImputationBasis) => {
  const { transactions, accounts } = basisFixture()
  const scope: Record<string, unknown> = {
    computed: computedDependency,
    transactionsStore: { transactions },
    accountsStore: { accounts },
    goalsStore: { categoryBudgets: { food: 2000 } },
    workspacesStore: { activeWorkspaceProfiles: [{ uid: 'ana', displayName: 'Ana' }, { uid: 'bo', displayName: 'Bo' }] },
    authStore: { user: { uid: 'ana' } },
    convert: (amount: number) => amount,
    cardBillingFor: { value: createCardBillingLookup(accounts, 'payment', { transactions: transactions as never }) },
    budgetBillingFor: { value: createCardBillingLookup(accounts, basis, { transactions: transactions as never }) },
    budgetBasis: { value: basis },
    BUDGET_BASIS_LABELS,
    currentExpenseLimit: { value: 1000 },
    budgetSummary: { value: { totalLimitForReporting: 2000 } },
    liquidBalance: { value: 5000 },
    availableBalance: { value: 5000 },
    budgetMonthFilter: () => null,
    getCategory: (id: string) => ({ name: id }),
    alignedMonthPeriods,
    expenseAmountForMonth,
    expenseAmountInPeriod,
    isDateInPeriod,
    percentChange,
    previousFullMonths,
    runwayDays,
    committedCardPayments,
    spendableUntilMonthEnd,
    splitMonthEndExpenses,
    projectMonthEndExpenses,
    projectionChecks,
    resolveBudgetId,
    DEFAULT_MONTHLY_BUDGET_ID,
    getNextOccurrence,
    daysUntil,
    buildCardStatementLedger,
    ...monthDependencies()
  }
  for (const name of DASHBOARD_COMPUTED) {
    scope[name] = { get value() { return evaluateComputed(name, scope).value } }
  }
  scope.getMoMData = (type: 'income' | 'expense', view: 'all' | 'budget') =>
    (evaluateComputed('getMoMData', scope) as unknown as (type: string, view: string) => unknown)(type, view)
  const read = <Value>(name: string) => (scope[name] as { value: Value }).value
  return { read, transactions, accounts }
}

// What the budget cards report for the base monthly budget with the same basis.
const baseBudgetSpend = (basis: ImputationBasis) => {
  const { transactions, accounts } = basisFixture()
  const now = new Date()
  return reportBudgetScope({
    scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: 'USD' },
    transactions,
    period: { year: now.getFullYear(), month: now.getMonth() },
    reportingCurrency: 'USD',
    exchangeRates: {},
    cardBilling: createCardBillingLookup(accounts, basis, { transactions: transactions as never })
  }).monthlyAllocation.amount
}

const projectedFromPace = (pace: number, committed = 0) => {
  const now = new Date()
  return (pace / now.getDate()) * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() + committed
}

type CapChecks = { budget: ProjectionCheck | null; limit: ProjectionCheck | null }

test('S6: with "Consumo del mes" the base cap counts this month\'s card purchase although its statement is paid next month', () => {
  const { read } = dashboardWithBasis('consumption')
  const spent = baseBudgetSpend('consumption')

  // The whole 1,000 card purchase plus 100 in cash; the other budget's 600 never counts.
  assert.equal(spent, 1100)
  assert.equal(Math.round(read<number>('baseExpenseLimitPercent')), 110)
  assert.equal(read<number>('baseExpenseLimitPercent'), (spent! / 1000) * 100, 'the cap shows what the budget cards count')
  assert.equal(read<boolean>('baseExpenseLimitExceeded'), true)
  const checks = read<CapChecks>('projectionStatus')
  assert.deepEqual(checks.limit, { projected: projectedFromPace(1100), cap: 1000, exceeds: true })
  assert.deepEqual(checks.budget, { projected: projectedFromPace(1100), cap: 2000, exceeds: projectedFromPace(1100) > 2000 })
  assert.equal(read<boolean>('projectionExceeds'), true)
  assert.equal(read<string>('capBasisNote'), 'Tarjetas según «Consumo del mes», como en tus presupuestos.')
})

test('S6: with "Pagos del mes" the base cap counts the card purchase by its ledger, as the budget cards do', () => {
  const { read } = dashboardWithBasis('payment')
  const spent = baseBudgetSpend('payment')

  // Only the 300 already transferred to the card counts this month, plus 100 in cash.
  assert.equal(spent, 400)
  assert.equal(Math.round(read<number>('baseExpenseLimitPercent')), 40)
  assert.equal(read<number>('baseExpenseLimitPercent'), (spent! / 1000) * 100, 'the cap shows what the budget cards count')
  assert.equal(read<boolean>('baseExpenseLimitExceeded'), false)
  const checks = read<CapChecks>('projectionStatus')
  assert.deepEqual(checks.limit, { projected: projectedFromPace(400), cap: 1000, exceeds: projectedFromPace(400) > 1000 })
  assert.deepEqual(checks.budget, { projected: projectedFromPace(400), cap: 2000, exceeds: projectedFromPace(400) > 2000 })
  assert.equal(read<string>('capBasisNote'), 'Tarjetas según «Pagos del mes», como en tus presupuestos.')
})

test('S6: cash-flow figures and upcoming card payments are identical under both bases and keep the payment month', () => {
  const cashFlow = (basis: ImputationBasis) => {
    const { read } = dashboardWithBasis(basis)
    return {
      projection: read<number>('monthEndProjection'),
      expenses: read<{ current: number; toDate: number; previous: number; percent: number }>('allExpensesData'),
      runway: read<number | null>('liquidityDays'),
      byCategory: read<Record<string, number>>('expensesByCategory'),
      members: read<Array<{ name: string; amount: number }>>('memberExpenses'),
      upcoming: read<Array<{ id: string; amount: number | null; debt: number }>>('upcomingCardPayments'),
      committedCards: read<number>('committedCards'),
      spendable: read<{ amount: number }>('spendable')
    }
  }
  const payment = cashFlow('payment')

  assert.deepEqual(cashFlow('consumption'), payment)
  // 300 already paid of the Visa purchase, 100 + 400 in cash and the Mastercard statement due now.
  assert.equal(payment.expenses.current, 1000)
  assert.equal(payment.projection, projectedFromPace(800, 200))
  assert.deepEqual(payment.byCategory, { food: 400, travel: 600 })
  assert.deepEqual(payment.members, [{ name: 'Ana', amount: 700 }, { name: 'Bo', amount: 300 }])
  const mastercard = payment.upcoming.find(card => card.id === 'mastercard')
  assert.equal(mastercard?.amount, 200)
  assert.equal(mastercard?.debt, 200)
  assert.equal(payment.committedCards, 200, 'Pagos de tarjeta por vencer este mes')
  assert.equal(payment.spendable.amount, 4800)
})

test('S6: the Dashboard tells what counts against a cap apart from what was paid or remains to pay', () => {
  const template = componentSource.split('<script setup lang="ts">')[0]
  assert.match(script, /const capBasisNote = computed\(\(\) => `Tarjetas según «\$\{BUDGET_BASIS_LABELS\[budgetBasis\.value\]\}», como en tus presupuestos\.`\)/)
  // The note sits with the cap projections and under the base cap bar, with the full hint on hover.
  assert.match(template, /projectionStatus\.limit\.cap[\s\S]*?:title="budgetBasisCaption" data-testid="dashboard-cap-basis">\{\{ capBasisNote \}\}/)
  assert.match(template, /baseExpenseLimitPercent, 100\)[\s\S]*?:title="budgetBasisCaption" data-testid="dashboard-cap-basis">\{\{ capBasisNote \}\}/)
  assert.match(template, /Gastos estimados al cierre a tu ritmo actual\. Tarjetas: lo que pagas este mes\./)
  assert.match(template, /Pagos de tarjeta por vencer este mes:/)
})

// --- Card payments already made (cash flow and upcoming payments) ---

const paidCardFlow = (withPayment: boolean) => {
  const purchase = currentMonthExpense({ amount: -50, accountId: 'visa', date: previousMonthFirstDay() })
  const payment = { type: 'transfer', amount: 50, currency: 'USD', date: previousMonthFirstDay(), accountId: 'savings', toAccountId: 'visa' }
  const transactions = (withPayment ? [purchase, payment] : [purchase]) as unknown as BudgetExpenseTransaction[]
  const balance = withPayment ? 0 : -50
  const getMoMData = evaluateComputed<never>('getMoMData', {
    alignedMonthPeriods,
    transactionsStore: { transactions },
    cardBillingFor: { value: createCardBillingLookup([{ ...visa, balance }], 'payment', { transactions: transactions as never }) },
    convert: (amount: number) => amount,
    expenseAmountForMonth,
    expenseAmountInPeriod,
    isDateInPeriod,
    percentChange,
    budgetMonthFilter: { value: null },
    ...monthDependencies()
  }) as unknown as (type: 'income' | 'expense', view: 'all' | 'budget') => { current: number }
  return getMoMData('expense', 'all').current
}

test('Dashboard cash flow does not count again a card statement already paid', () => {
  assert.equal(paidCardFlow(false), 50)
  assert.equal(paidCardFlow(true), 0)
})

const upcomingFor = (balance: number, transactions: unknown[]) => evaluateComputed<{ id: string; amount: number | null; debt: number }[]>('upcomingCardPayments', {
  computed: computedDependency,
  accountsStore: { accounts: [{ id: 'nu', name: 'Nu', type: 'credit', currency: 'COP', statementClosingDay: 15, paymentDueDay: 4, balance }] },
  transactionsStore: { transactions },
  getNextOccurrence,
  daysUntil,
  buildCardStatementLedger
}).value[0]

test('upcoming card payments show what is still unpaid of the statements due, capped by the debt', () => {
  const due = getNextOccurrence(4)
  // A purchase on the 1st of the month before the due month is on the statement paid on `due`.
  const purchaseDate = new Date(due.getFullYear(), due.getMonth() - 1, 1, 12)
  const purchase = { type: 'expense', amount: -1000, date: purchaseDate, accountId: 'nu' }
  const lent = { type: 'transfer', amount: 200, date: purchaseDate, accountId: 'nu', toAccountId: 'receivable' }
  const paid = { type: 'transfer', amount: 700, date: purchaseDate, accountId: 'savings', toAccountId: 'nu' }

  assert.equal(upcomingFor(-1200, [purchase, lent]).amount, 1200)
  assert.equal(upcomingFor(-500, [purchase, lent, paid]).amount, 500)
  assert.equal(upcomingFor(0, [purchase, lent, { ...paid, amount: 1200 }]).amount, 0)
  assert.equal(upcomingFor(-1200, [purchase, lent]).debt, 1200)
})

// --- S9: selected month (?mes=YYYY-MM) ---

// "Today" is 15 March 2026; the user looks at February 2026 (28 days), compared with the whole of
// January (31 days). A 600 purchase in three installments from December puts 200 in each month.
const PAST_MONTH_NOW = new Date(2026, 2, 15, 12)
const FEBRUARY_2026 = { year: 2026, month: 1 }
const pastMonthTransactions = () => [
  { type: 'income', amount: 1000, date: new Date(2026, 1, 10, 12), userId: 'ana' },
  { type: 'income', amount: 300, date: new Date(2026, 1, 12, 12), userId: 'ana', budgetId: 'viaje' },
  { type: 'income', amount: 400, date: new Date(2026, 0, 31, 18), userId: 'ana' },
  { type: 'income', amount: 100, date: new Date(2026, 0, 20, 12), userId: 'ana' },
  { type: 'income', amount: 9999, date: new Date(2026, 2, 5, 12), userId: 'ana' },
  { type: 'expense', amount: -200, date: new Date(2026, 1, 3, 12), userId: 'ana', categoryId: 'food' },
  { type: 'expense', amount: -100, date: new Date(2026, 1, 28, 20), userId: 'bo', categoryId: 'travel' },
  { type: 'expense', amount: -120, date: new Date(2026, 1, 20, 12), userId: 'bo', categoryId: 'travel', budgetId: 'viaje' },
  { type: 'expense', amount: -50, date: new Date(2026, 0, 31, 18), userId: 'ana', categoryId: 'food' },
  { type: 'expense', amount: -150, date: new Date(2026, 0, 10, 12), userId: 'ana', categoryId: 'food' },
  { type: 'expense', amount: -600, date: new Date(2025, 11, 15, 12), userId: 'ana', categoryId: 'tech', installments: 3 },
  { type: 'expense', amount: -7777, date: new Date(2026, 2, 2, 12), userId: 'ana', categoryId: 'food' }
].map((transaction, index) => ({
  id: `t${index}`,
  description: `Movimiento ${index}`,
  accountId: 'cash',
  currency: 'COP',
  installments: 1,
  ...transaction
})) as unknown as BudgetExpenseTransaction[]

const PAST_MONTH_COMPUTED = [
  ...DASHBOARD_COMPUTED, 'incomeData', 'expensesData', 'monthlyIncome', 'monthlyExpenses', 'savingsRate',
  'monthlyPurchaseTotal', 'topBleeder', 'budgetSummary', 'allBudgetsEstimatedMonthly', 'budgetBreakdown',
  'budgetKinds', 'monthlyFlowSeries', 'comparisonLabel'
]

// Evaluates the real Dashboard computed values for the fixture with `selected` as the shown month.
const dashboardForMonth = (selected: CalendarMonth, flowView: 'all' | 'budget' = 'all') => {
  const transactions = pastMonthTransactions()
  const accounts = [{ id: 'cash', type: 'cash', name: 'Efectivo', currency: 'COP', balance: 5000 }] as BillingAccount[]
  const categories: Record<string, string> = { food: 'Comida', travel: 'Viajes', tech: 'Tecnología' }
  const scope: Record<string, unknown> = {
    computed: computedDependency,
    transactionsStore: { transactions },
    accountsStore: { accounts },
    goalsStore: {
      categoryBudgets: { food: 400 },
      categoryBudgetCurrency: { status: 'confirmed', code: 'COP' },
      operatingBudgets: [{ budget: { id: 'viaje', name: 'Viaje', kind: 'monthly', capCurrency: 'COP', archived: false }, categoryCaps: {} }]
    },
    workspacesStore: { activeWorkspaceProfiles: [{ uid: 'ana', displayName: 'Ana' }, { uid: 'bo', displayName: 'Bo' }] },
    authStore: { user: { uid: 'ana' } },
    primaryCurrency: { value: 'COP' },
    activeExchangeRates: { value: {} },
    convert: (amount: number) => amount,
    cardBillingFor: { value: createCardBillingLookup(accounts, 'payment', { transactions: transactions as never }) },
    budgetBillingFor: { value: createCardBillingLookup(accounts, 'consumption', { transactions: transactions as never }) },
    budgetBasis: { value: 'consumption' },
    BUDGET_BASIS_LABELS,
    currentExpenseLimit: { value: 1000 },
    liquidBalance: { value: 5000 },
    availableBalance: { value: 5000 },
    flowView: { value: flowView },
    isCurrentMonth: { value: false },
    linkedBudgetOfAccount: () => null,
    getCategory: (id: string) => ({ name: categories[id] ?? id, color: '#fff' }),
    reportAllBudgetsEstimatedMonthly,
    reportBudgetScope,
    budgetScopedMonthFilter,
    budgetCardFigures,
    hasBudgetActivity,
    alignedMonthPeriods,
    expenseAmountForMonth,
    expenseAmountInPeriod,
    isDateInPeriod,
    percentChange,
    previousFullMonths,
    runwayDays,
    committedCardPayments,
    spendableUntilMonthEnd,
    splitMonthEndExpenses,
    projectMonthEndExpenses,
    projectionChecks,
    resolveBudgetId,
    DEFAULT_MONTHLY_BUDGET_ID,
    getNextOccurrence,
    daysUntil,
    buildCardStatementLedger,
    ...monthDependencies(selected)
  }
  scope.isCurrentMonth = { value: selected.year === thisMonth().year && selected.month === thisMonth().month }
  for (const name of PAST_MONTH_COMPUTED) {
    scope[name] = { get value() { return evaluateComputed(name, scope).value } }
  }
  scope.budgetMonthFilter = evaluateComputed('budgetMonthFilter', scope)
  scope.getMoMData = (type: 'income' | 'expense', view: 'all' | 'budget') =>
    (evaluateComputed('getMoMData', scope) as unknown as (type: string, view: string) => unknown)(type, view)
  return <Value>(name: string) => (scope[name] as { value: Value }).value
}

type MonthFlow = { current: number; toDate: number; previous: number; percent: number }

test('S9: in a past month every month figure follows the selected month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: PAST_MONTH_NOW.getTime() })
  const read = dashboardForMonth(FEBRUARY_2026)

  // February: 1,000 + 300 of income; 200 + 100 + 120 spent plus the 200 installment.
  assert.equal(read<MonthFlow>('incomeData').current, 1300)
  assert.equal(read<MonthFlow>('expensesData').current, 620)
  assert.equal(read<number>('monthlyPurchaseTotal'), 420, 'purchases dated in February')
  assert.deepEqual(read<Record<string, number>>('expensesByCategory'), { Comida: 200, Viajes: 220, 'Tecnología': 200 })
  assert.deepEqual(read<[string, number] | null>('topBleeder'), ['Viajes', 220])
  assert.deepEqual(read<Array<{ name: string; amount: number }>>('memberExpenses'), [{ name: 'Ana', amount: 400 }, { name: 'Bo', amount: 220 }])
  assert.equal(read<number>('savingsRate'), ((1300 - 620) / 1300) * 100)
  // Base budget: February spending without the Viaje budget (200 + 100 + 200) against today's cap.
  assert.equal(read<{ baseSpent: number }>('budgetMonthEndProjection').baseSpent, 500)
  assert.equal(read<number>('baseExpenseLimitPercent'), 50)
  assert.equal(read<boolean>('baseExpenseLimitExceeded'), false)
  assert.equal(read<{ totalSpentReal: number | null; percent: number | null }>('budgetSummary').totalSpentReal, 200)
  assert.equal(read<{ percent: number | null }>('budgetSummary').percent, 50)
  assert.equal(read<BudgetAmountReport>('allBudgetsEstimatedMonthly').amount, 620)
  assert.deepEqual(
    read<Array<{ id: string; fundsAmount: number | null; spent: number | null; available: number | null }>>('budgetBreakdown')
      .map(({ id, fundsAmount, spent, available }) => ({ id, fundsAmount, spent, available })),
    [{ id: 'viaje', fundsAmount: 300, spent: 120, available: 180 }]
  )
})

test('S9: a past month is compared in full with the full previous month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: PAST_MONTH_NOW.getTime() })
  const read = dashboardForMonth(FEBRUARY_2026)
  // All of January, including the 31st (not January 1..15 as today, nor 1..28 as February's length).
  assert.deepEqual(read<MonthFlow>('incomeData'), { current: 1300, toDate: 1300, previous: 500, percent: 160 })
  assert.deepEqual(read<MonthFlow>('expensesData'), { current: 620, toDate: 620, previous: 400, percent: 55 })
  assert.equal(read<string>('comparisonLabel'), 'vs el mes anterior completo')

  const byBudget = dashboardForMonth(FEBRUARY_2026, 'budget')
  assert.deepEqual(byBudget<MonthFlow>('incomeData'), { current: 1000, toDate: 1000, previous: 500, percent: 100 })
  assert.equal(byBudget<MonthFlow>('expensesData').current, 500)
})

test('S9: the current month keeps the comparison with the same days of the previous month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: PAST_MONTH_NOW.getTime() })
  const read = dashboardForMonth({ year: 2026, month: 2 })
  // March 1..15 against February 1..15.
  assert.deepEqual(read<MonthFlow>('incomeData'), { current: 9999, toDate: 9999, previous: 1300, percent: 669 })
  assert.equal(read<string>('comparisonLabel'), 'vs mismo periodo del mes anterior')
})

test('S9: the six-month cash-flow chart ends at the selected month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: PAST_MONTH_NOW.getTime() })
  type Bar = { label: string; year: number; month: number; income: number; expense: number }
  const series = dashboardForMonth(FEBRUARY_2026)<Bar[]>('monthlyFlowSeries')
  assert.deepEqual(series.map(({ year, month }) => [year, month]), [[2025, 8], [2025, 9], [2025, 10], [2025, 11], [2026, 0], [2026, 1]])
  assert.deepEqual(series.slice(-3).map(({ income, expense }) => [income, expense]), [[0, 200], [500, 400], [1300, 620]])
  assert.equal(series.at(-1)?.label, new Date(2026, 1, 1).toLocaleString('es-CO', { month: 'short' }))

  const current = dashboardForMonth({ year: 2026, month: 2 })<Bar[]>('monthlyFlowSeries')
  assert.deepEqual(current.at(-1), { label: new Date(2026, 2, 1).toLocaleString('es-CO', { month: 'short' }), year: 2026, month: 2, income: 9999, expense: 7777 })
  assert.match(script, /const last6Months = monthlyFlowSeries\.value/)
})

// --- S9: the real Dashboard, router and month picker ---

class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
  get content(): string { return (this.text + this.children.map(child => child.content).join('')).trim() }
  get descendants(): ViewNode[] { return this.children.flatMap(child => [child, ...child.descendants]) }
}
const detach = (node: ViewNode) => {
  if (!node.parent) return
  node.parent.children.splice(node.parent.children.indexOf(node), 1)
  node.parent = null
}
const renderer = Vue.createRenderer<ViewNode, ViewNode>({
  createElement: tag => Vue.markRaw(new ViewNode(tag)),
  createText: text => new ViewNode('#text', text),
  createComment: () => new ViewNode('#comment'),
  insert(node, parent, anchor = null) {
    detach(node)
    node.parent = parent
    if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
    else parent.children.push(node)
  },
  remove: detach,
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text; node.children = [] },
  patchProp(node, key, _previous, next) { node.props[key] = next }
})
const requireModule = createRequire(import.meta.url)
const noOp = async () => undefined

// What a mounted Dashboard test may replace in the default fixture below.
type DashboardSetup = {
  now: Date
  accounts: Array<{ id: string; balance: number } & Record<string, unknown>>
  transactions: unknown[]
  categories: unknown[]
  profiles: unknown[]
  operatingBudgets: unknown[]
  categoryBudgets: Record<string, number>
  expenseLimit: number
}
type ChartConfig = { type: string; data: { labels: string[]; datasets: Array<{ data: number[] }> } }

const mountDashboard = async (t: TestContext, path: string, setup: Partial<DashboardSetup> = {}) => {
  t.mock.timers.enable({ apis: ['Date'], now: (setup.now ?? PAST_MONTH_NOW).getTime() })
  const accounts = setup.accounts ?? [
    { id: 'cash', name: 'Efectivo', type: 'cash', currency: 'COP', balance: 5000 },
    { id: 'visa', name: 'Visa', type: 'credit', currency: 'COP', balance: -300, limit: 1000, statementClosingDay: 31, paymentDueDay: 10 }
  ]
  const charts: ChartConfig[] = []
  const stores: Record<string, unknown> = {
    authStore: { user: { uid: 'ana', displayName: 'Ana' }, activeWorkspaceId: 'w' },
    accountsStore: {
      accounts,
      netWorthByCurrency: { COP: accounts.reduce((sum, account) => sum + account.balance, 0) },
      getAccountById: (id: string) => accounts.find(account => account.id === id),
      fetchAccounts: noOp
    },
    transactionsStore: Vue.reactive({
      transactions: setup.transactions ?? pastMonthTransactions(),
      categories: setup.categories ?? [{ id: 'food', name: 'Comida', color: '#fff', icon: 'Utensils' }],
      fetchCategories: noOp,
      fetchTransactions: noOp
    }),
    settingsStore: { currency: 'COP', aiEnabled: false, loading: false, loadSettings: noOp },
    workspacesStore: {
      activeBudgetCardBasis: 'consumption',
      workspaces: [{ id: 'w', expenseLimit: setup.expenseLimit ?? 1000 }],
      activeWorkspaceProfiles: setup.profiles ?? []
    },
    goalsStore: Vue.reactive({
      goals: [{ id: 'trip', name: 'Viaje a la playa', targetAmount: 100, currentAmount: 25, currency: 'COP', targetDate: new Date(2030, 0, 1) }],
      exchangeRates: {},
      exchangeRatesBaseCurrency: 'COP',
      operatingBudgets: setup.operatingBudgets ?? [],
      categoryBudgets: setup.categoryBudgets ?? { food: 400 },
      categoryBudgetCurrency: { status: 'confirmed', code: 'COP' },
      budgetSettingsLoading: false,
      budgetSettingsContextKey: 'k',
      convertToPrimary: (amount: number) => amount,
      fetchGoals: noOp,
      loadBudgetSettings: noOp
    })
  }
  const loadComponent = (file: string): Vue.Component => {
    const { descriptor, errors } = parse(readFileSync(new URL(file, import.meta.url), 'utf8'), { filename: file })
    assert.deepEqual(errors, [])
    const javascript = ts.transpile(compileScript(descriptor, { id: file, inlineTemplate: true }).content, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS
    })
    const exports = {} as { default: Vue.Component }
    new Function('exports', 'require', javascript)(exports, (id: string) => {
      if (id === 'vue') return Vue
      if (id === 'vue-router') return Router
      if (id === 'chart.js') {
        return {
          Chart: class { static register = () => undefined; constructor(_canvas: unknown, config: ChartConfig) { charts.push(config) } destroy = () => undefined },
          registerables: []
        }
      }
      if (id === '@/components/MonthPicker.vue') return { default: loadComponent('../components/MonthPicker.vue') }
      if (id.endsWith('.vue')) return { default: () => null }
      if (id.startsWith('@/stores/')) {
        const name = id.slice('@/stores/'.length)
        return { [`use${name[0].toUpperCase()}${name.slice(1)}`]: () => stores[name] }
      }
      return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
    })
    return exports.default
  }
  const router = Router.createRouter({
    history: Router.createMemoryHistory(),
    routes: [
      { path: '/', component: loadComponent('./Dashboard.vue') },
      ...['transactions', 'import', 'accounts', 'goals', 'settings'].map(name => ({ path: `/${name}`, component: { render: () => null } }))
    ]
  })
  await router.push(path)
  const root = new ViewNode('root')
  const app = renderer.createApp({ render: () => Vue.h(Router.RouterView) })
  t.after(() => app.unmount())
  app.use(router).mount(root)
  const settle = async () => {
    await new Promise(setImmediate)
    await Vue.nextTick()
  }
  await settle()
  const byTestId = (id: string) => root.descendants.filter(node => node.props['data-testid'] === id)
  const button = (name: string) => {
    const node = root.descendants.find(node => node.tag === 'button' && (node.props['aria-label'] === name || node.content === name))
    assert.ok(node, `expected a "${name}" button`)
    return node
  }
  const pickerValue = () => byTestId('month-picker')[0]?.descendants.find(node => node.props['aria-live'] === 'polite')?.content
  return { root, router, settle, byTestId, button, pickerValue, charts, fullPath: () => router.currentRoute.value.fullPath }
}

// Today's figures and forward-looking widgets; none of them belongs to another month.
const TODAY_WIDGETS = [
  'Disponible para gastar', 'Proyección de cierre', 'Deuda en tarjetas', 'Patrimonio Neto', 'Runway',
  'Próximos Pagos de Tarjeta', 'Transacciones Recientes', 'Saldos de Cuentas', 'Tus Metas de Ahorro'
]
const MONTH_WIDGETS = ['Ingresos del Mes', 'Gastos imputados del Mes', 'Tasa de Ahorro', 'Distribución de Gastos', 'Flujo de Caja Mensual', 'Presupuesto del Mes', 'Asignaciones mensuales estimadas']
const NOTICE = 'Los topes, la configuración de tarjetas y las tasas de cambio son los actuales.'

test('S9: a past month hides today\'s and forward-looking widgets and says which month is shown', async t => {
  const view = await mountDashboard(t, '/?mes=2026-02')
  const content = view.root.content
  for (const title of TODAY_WIDGETS) assert.doesNotMatch(content, new RegExp(title), `${title} is hidden in a past month`)
  for (const title of MONTH_WIDGETS) assert.match(content, new RegExp(title), `${title} follows the month`)

  const [notice] = view.byTestId('dashboard-past-month-notice')
  assert.ok(notice, 'a past month shows the notice')
  assert.equal(notice.props.role, 'status')
  // The test renderer trims each text node, so the space before the month name is not in `content`.
  assert.match(notice.content, /^Estás viendo\s*febrero de 2026/)
  assert.equal(notice.descendants.find(node => node.tag === 'strong')?.content, 'febrero de 2026')
  assert.ok(notice.descendants.some(node => node.tag === 'button' && node.content === 'Volver al mes actual'))
  assert.equal(content.split(NOTICE).length - 1, 1, 'today\'s limits, card setting and rates are mentioned once')
  assert.equal(view.pickerValue(), 'febrero de 2026')
  assert.equal(view.button('Mes siguiente').props.disabled, false)
  assert.match(content, /vs el mes anterior completo/)
})

test('S9: the current month shows every widget, no notice, and the picker cannot go forward', async t => {
  const view = await mountDashboard(t, '/')
  const content = view.root.content
  for (const title of [...TODAY_WIDGETS, ...MONTH_WIDGETS]) assert.match(content, new RegExp(title), `${title} is shown this month`)
  assert.deepEqual(view.byTestId('dashboard-past-month-notice'), [])
  assert.doesNotMatch(content, new RegExp(NOTICE))
  assert.equal(view.pickerValue(), 'marzo de 2026')
  assert.equal(view.button('Mes siguiente').props.disabled, true)
  assert.match(content, /vs mismo periodo del mes anterior/)
})

test('S9: the picker moves between months and "Volver al mes actual" returns to today', async t => {
  const view = await mountDashboard(t, '/')
  view.button('Mes anterior').props.onClick()
  await view.settle()
  assert.equal(view.fullPath(), '/?mes=2026-02')
  assert.equal(view.pickerValue(), 'febrero de 2026')
  assert.doesNotMatch(view.root.content, /Disponible para gastar/)

  view.button('Mes anterior').props.onClick()
  await view.settle()
  assert.equal(view.fullPath(), '/?mes=2026-01')
  view.button('Mes siguiente').props.onClick()
  await view.settle()
  assert.equal(view.fullPath(), '/?mes=2026-02')

  await view.button('Volver al mes actual').props.onClick()
  await view.settle()
  assert.equal(view.fullPath(), '/')
  assert.equal(view.pickerValue(), 'marzo de 2026')
  assert.match(view.root.content, /Disponible para gastar/)
  assert.deepEqual(view.byTestId('dashboard-past-month-notice'), [])
})

test('S9 T7b: the links to Presupuestos carry the shown month only when it is a past month', async t => {
  const view = await mountDashboard(t, '/')
  view.button('Por presupuesto').props.onClick()
  await view.settle()
  const budgetLinks = () => ['Ver presupuestos', 'Ajustar'].map(text =>
    view.root.descendants.find(node => node.tag === 'a' && node.content === text)?.props.href)
  assert.deepEqual(budgetLinks(), ['/goals', '/goals'], 'the current month links to the bare budgets page')

  view.button('Mes anterior').props.onClick()
  await view.settle()
  assert.deepEqual(budgetLinks(), ['/goals?mes=2026-02', '/goals?mes=2026-02'])

  await view.button('Volver al mes actual').props.onClick()
  await view.settle()
  assert.deepEqual(budgetLinks(), ['/goals', '/goals'])
})

// Hand-computed month: every date is relative to "today" (mocked), and the Dashboard shows the
// month before it. Visa closes on the 20th and is paid on the 5th. Shown month: cash income
// 4,500,000 vs 3,000,000; expenses 1,050,000 cash + 800,000 of card payments = 1,850,000 vs
// 80,000 + 300,000 = 380,000; card purchases are spread over members and categories by the
// statements those payments cover. Rows of "today's" month must not count.
const LAST_MONTH_TODAY = new Date(2026, 10, 25, 12)
const lastMonthSetup = (today: Date): Partial<DashboardSetup> => {
  const at = (monthOffset: number, day: number, hours = 12, minutes = 0) =>
    new Date(today.getFullYear(), today.getMonth() + monthOffset, day, hours, minutes)
  const lastDayOf = (monthOffset: number, hours: number) => at(monthOffset + 1, 0, hours)
  const [shown, previous, earlier, current] = [-1, -2, -3, 0]
  const movement = (id: string, type: string, amount: number, date: Date, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: 'w', type, amount, date, currency: 'COP', description: id, installments: 1, accountId: 'cash', userId: 'ana', categoryId: '', ...extra
  })
  return {
    now: today,
    expenseLimit: 1_000_000,
    categoryBudgets: { food: 300_000 },
    profiles: [{ uid: 'ana', displayName: 'Ana' }, { uid: 'bo', displayName: 'Bo' }],
    categories: [
      { id: 'food', name: 'Comida', color: '#1', type: 'expense' }, { id: 'transport', name: 'Transporte', color: '#2', type: 'expense' },
      { id: 'travel', name: 'Viajes', color: '#3', type: 'expense' }, { id: 'gifts', name: 'Regalos', color: '#4', type: 'expense' },
      { id: 'tech', name: 'Tecnología', color: '#5', type: 'expense' }
    ],
    operatingBudgets: [
      { budget: { id: 'viaje', name: 'Viaje', kind: 'monthly', capCurrency: 'COP', archived: false }, categoryCaps: {} },
      { budget: { id: 'boda', name: 'Boda', kind: 'event', capCurrency: 'COP', archived: false }, categoryCaps: {} }
    ],
    accounts: [
      { id: 'cash', name: 'Efectivo', type: 'cash', currency: 'COP', balance: 5_000_000 },
      { id: 'visa', name: 'Visa', type: 'credit', currency: 'COP', balance: -310_000, limit: 5_000_000, statementClosingDay: 20, paymentDueDay: 5 }
    ],
    transactions: [
      movement('I1', 'income', 4_000_000, at(shown, 3)),
      movement('I2', 'income', 500_000, at(shown, 15), { userId: 'bo', budgetId: 'viaje' }),
      movement('I3', 'income', 3_000_000, lastDayOf(previous, 23)),
      movement('I4', 'income', 9_999_999, at(current, 2)),
      movement('E1', 'expense', -200_000, at(shown, 1, 0, 30), { categoryId: 'food' }),
      movement('E2', 'expense', -100_000, lastDayOf(shown, 22), { userId: 'bo', categoryId: 'transport' }),
      movement('E3', 'expense', -150_000, at(shown, 12), { userId: 'bo', categoryId: 'travel', budgetId: 'viaje' }),
      movement('E4', 'expense', -80_000, at(previous, 10), { categoryId: 'food' }),
      movement('E5', 'expense', -7_777_777, at(current, 3), { categoryId: 'food' }),
      movement('E6', 'expense', -600_000, at(shown, 20), { categoryId: 'gifts', budgetId: 'boda' }),
      movement('C1', 'expense', -300_000, at(previous, 10), { categoryId: 'food', accountId: 'visa' }),
      movement('C2', 'expense', -120_000, at(previous, 25), { userId: 'bo', categoryId: 'food', accountId: 'visa' }),
      movement('C3', 'expense', -900_000, at(earlier, 5), { categoryId: 'tech', accountId: 'visa', installments: 3 }),
      movement('C4', 'expense', -50_000, at(shown, 18), { categoryId: 'food', accountId: 'visa', budgetId: 'viaje' }),
      movement('C5', 'expense', -40_000, at(shown, 25), { categoryId: 'food', accountId: 'visa' }),
      movement('P0', 'transfer', 300_000, at(previous, 5), { toAccountId: 'visa' }),
      movement('P1', 'transfer', 500_000, at(shown, 5), { toAccountId: 'visa' }),
      movement('P2', 'transfer', 300_000, at(shown, 28), { toAccountId: 'visa' })
    ]
  }
}

test('S9: a past month\'s figures, charts and budget panels match the hand computation', async t => {
  const today = LAST_MONTH_TODAY
  const monthStart = (offset: number) => new Date(today.getFullYear(), today.getMonth() + offset, 1)
  const shown = monthStart(-1)
  const key = `${shown.getFullYear()}-${String(shown.getMonth() + 1).padStart(2, '0')}`
  const view = await mountDashboard(t, `/?mes=${key}`, lastMonthSetup(today))
  const money = (amount: number) => new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format(amount)
  // The test renderer trims each text node, so compare without spaces.
  const flat = (text: string) => text.replace(/\s/g, '')
  const card = (title: string) => {
    let node: ViewNode | null | undefined = view.root.descendants.find(child => ['span', 'h4'].includes(child.tag) && child.content === title)
    while (node && !String(node.props.class ?? '').includes('glass-panel')) node = node.parent
    assert.ok(node, `expected the "${title}" card`)
    return node.content
  }

  const income = card('Ingresos del Mes')
  assert.ok(flat(income).includes(flat(`+${money(4_500_000)}`)), income)
  assert.match(income, /\+50%/)
  assert.ok(income.includes(`vs el mes anterior completo (${money(3_000_000)})`), income)

  const expenses = card('Gastos imputados del Mes')
  assert.ok(flat(expenses).includes(flat(money(1_850_000))), expenses)
  assert.match(expenses, /\+387%/)
  assert.ok(expenses.includes(`vs el mes anterior completo (${money(380_000)})`), expenses)
  assert.ok(expenses.includes(`Compras registradas: ${money(1_140_000)} total`), expenses)
  assert.match(expenses, /Mayor fuga: Regalos/)
  assert.ok(flat(expenses).includes(flat(`Ana${money(1_548_936.17)}`)), `Ana's share: ${expenses}`)
  assert.ok(flat(expenses).includes(flat(`Bo${money(301_063.83)}`)), `Bo's share: ${expenses}`)
  assert.ok(expenses.includes(`Tope del presupuesto mensual base: ${money(1_000_000)}`), expenses)
  assert.match(expenses, /72%/)
  assert.match(card('Tasa de Ahorro'), /58\.9%/)

  const rounded = (values: number[]) => values.map(value => Math.round(value * 100) / 100)
  const donut = view.charts.filter(chart => chart.type === 'doughnut').at(-1)
  assert.ok(donut, 'expected the spending distribution chart')
  assert.deepEqual(
    Object.fromEntries(donut.data.labels.map((label, index) => [label, rounded(donut.data.datasets[0].data)[index]])),
    { Comida: 572_340.43, Transporte: 100_000, Viajes: 150_000, Regalos: 600_000, 'Tecnología': 427_659.57 }
  )
  const flow = view.charts.filter(chart => chart.type === 'bar').at(-1)
  assert.ok(flow, 'expected the cash-flow chart')
  assert.deepEqual(flow.data.labels, [-6, -5, -4, -3, -2, -1].map(offset => monthStart(offset).toLocaleString('es-CO', { month: 'short' })))
  assert.deepEqual(flow.data.datasets[0].data, [0, 0, 0, 0, 3_000_000, 4_500_000])
  assert.deepEqual(rounded(flow.data.datasets[1].data), [0, 0, 0, 0, 380_000, 1_850_000])

  // Base category limits by consumption: food 200,000 cash + 120,000 on the statement closing in the shown month.
  const basePanel = card('Presupuesto del Mes')
  assert.ok(flat(basePanel).includes(flat(money(320_000))), basePanel)
  assert.match(basePanel, /107%/)

  const content = view.root.content
  for (const title of TODAY_WIDGETS) assert.doesNotMatch(content, new RegExp(title), `${title} is hidden in a past month`)
  const label = shown.toLocaleString('es-CO', { month: 'long', year: 'numeric' })
  assert.match(view.byTestId('dashboard-past-month-notice')[0]?.content ?? '', new RegExp(`^Estás viendo\\s*${label}`))
  assert.ok(content.includes('Volver al mes actual'))

  // "Por presupuesto": Viaje has 500,000 of funds and spent 150,000 cash + 50,000 on the card.
  view.button('Por presupuesto').props.onClick()
  await view.settle()
  const [breakdown] = view.byTestId('dashboard-budget-breakdown')
  assert.ok(breakdown, 'expected the per-budget panel')
  for (const amount of [500_000, 200_000, 300_000]) assert.ok(flat(breakdown.content).includes(flat(money(amount))), `${amount} in ${breakdown.content}`)
})
