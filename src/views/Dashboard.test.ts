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
  resolveBudgetId,
  type BudgetExpenseTransaction
} from '../lib/budgets.ts'
import {
  alignedMonthPeriods,
  budgetCardFigures,
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
  budgetBillingFor: billingDependency(accounts, basis)
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
  budgetBillingFor: billingDependency()
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
    DEFAULT_MONTHLY_BUDGET_ID
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
    convert: (amount: number) => amount
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
    hasBudgetActivity
  })
  assert.deepEqual(breakdown.value.map(({ id, name, fundsAmount, spent, available }) => ({ id, name, fundsAmount, spent, available })), [
    { id: 'ventas-casa', name: 'Ventas Casa', fundsAmount: 1000000, spent: 300000, available: 700000 }
  ])
  assert.match(componentSource, /v-if="flowView === 'budget'"[\s\S]{0,400}data-testid="dashboard-budget-breakdown"/)
  assert.match(componentSource, /data-testid="dashboard-budget-breakdown"[\s\S]*?to="\/goals"/)
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
    buildCardStatementLedger
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
    budgetMonthFilter: { value: null }
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
