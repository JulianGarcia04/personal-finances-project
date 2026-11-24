// Card basis consistency across surfaces (P1 S6). For one shared workspace, the Dashboard (the real
// Dashboard.vue <script setup> computeds with the app's src/lib helpers), the budget alerts
// (functions/lib/budgetAlerts.js helpers, loaded like notifyBudgetThreshold) and the Asesor (the real
// buildAgentTools tool bodies) report the same budget figures under Consumo, Pagos and an unset basis
// (= Consumo), and the same cash flow under both bases.
// Dates are relative to the current month in Bogotá and "now" is its 24th (Date is mocked while the
// Dashboard computeds run), so no figure depends on the day the suite runs.
// Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/card-basis.consistency.emulator.test.mjs"
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const TIME_ZONE = 'America/Bogota'
// The app buckets months in the browser's local time zone: run it as a browser in Bogotá.
process.env.TZ = TIME_ZONE

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore')
const { buildAgentTools } = requireFunctions('./lib/agentContext.js')
const alerts = requireFunctions('./lib/budgetAlerts.js')
const http = requireFunctions('./lib/http.js')

const runId = `${Date.now()}`
const current = http.zonedYearMonth(new Date(), TIME_ZONE)
/** Noon in Bogotá on `day` of the current month plus `monthOffset`. */
const at = (monthOffset, day) => http.zonedWallClockToInstant(current.year, current.month + monthOffset, day, 12, TIME_ZONE)
const NOW = at(0, 24)

const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, `card-basis-${runId}`)
const db = getFirestore(app)
after(async () => {
  await deleteApp(app)
})

/**
 * Bogotá workspace with a Visa (closes 25, due 5; debt before its first movement), a Master (closes
 * 10, due 25), an Amex without billing days, installments, early, on-time and late card payments, a
 * loan repayment and a refund on the Visa, cash and bank expenses, category caps, the base
 * `expenseLimit`, an extra monthly budget (Viajes, with income assigned) and an event budget (Boda).
 */
function buildFixture(prefix, basis) {
  const id = name => `${prefix}-${name}`
  const owner = id('owner')
  const member = id('member')
  const workspaceId = id('ws')
  const workspace = {
    id: workspaceId, name: `S6 ${prefix}`, ownerId: owner, members: [owner, member], currency: 'COP',
    expenseLimit: 600_000, budgetIncome: 2_000_000,
    categoryBudgets: { [id('food')]: 300_000, [id('tech')]: 150_000, [id('fun')]: 100_000 },
    categoryBudgetCurrency: 'COP',
    ...(basis ? { budgetCardBasis: basis } : {})
  }
  const categories = [['food', 'Comida'], ['tech', 'Tecnologia'], ['fun', 'Ocio']].map(([key, name]) => ({
    id: id(key), workspaceId, userId: owner, name, type: 'expense', icon: 'tag', color: '#10b981'
  }))
  const accounts = [
    { id: id('bank'), name: 'Banco', type: 'checking', balance: 5_000_000, limit: 0, currency: 'COP' },
    { id: id('cash'), name: 'Efectivo', type: 'cash', balance: 300_000, limit: 0, currency: 'COP' },
    // Opening debt 50,000 before the first movement.
    { id: id('visa'), name: 'Visa', type: 'credit', balance: -690_000, limit: 5_000_000, currency: 'COP', statementClosingDay: 25, paymentDueDay: 5 },
    { id: id('master'), name: 'Master', type: 'credit', balance: -230_000, limit: 5_000_000, currency: 'COP', statementClosingDay: 10, paymentDueDay: 25 },
    { id: id('amex'), name: 'Amex', type: 'credit', balance: -45_000, limit: 1_000_000, currency: 'COP' }
  ].map(account => ({ ...account, workspaceId, userId: owner }))
  const budgets = [
    { id: id('travel'), workspaceId, kind: 'monthly', name: 'Viajes', capCurrency: 'COP', totalLimit: 300_000, archived: false, categoryCaps: { [id('food')]: 50_000 } },
    { id: id('wedding'), workspaceId, kind: 'event', name: 'Boda', capCurrency: 'COP', totalLimit: 1_000_000, archived: false, categoryCaps: {} }
  ]
  const tx = (key, data) => ({
    id: id(key), workspaceId, userId: owner, description: key, categoryId: '', toAccountId: null,
    installments: 1, currency: 'COP', ...data
  })
  const transactions = [
    // Visa
    tx('v1', { type: 'expense', amount: -300_000, accountId: id('visa'), categoryId: id('tech'), installments: 3, date: at(-3, 20) }),
    tx('v2', { type: 'expense', amount: -200_000, accountId: id('visa'), categoryId: id('food'), date: at(-1, 10) }),
    tx('v3', { type: 'expense', amount: -150_000, accountId: id('visa'), categoryId: id('food'), date: at(-1, 28), userId: member }),
    tx('v4', { type: 'expense', amount: -80_000, accountId: id('visa'), categoryId: id('fun'), date: at(0, 3) }),
    tx('v5', { type: 'expense', amount: -60_000, accountId: id('visa'), categoryId: id('food'), budgetId: id('travel'), date: at(0, 15) }),
    tx('e1', { type: 'expense', amount: -500_000, accountId: id('visa'), categoryId: id('fun'), budgetId: id('wedding'), date: at(0, 6) }),
    tx('p1', { type: 'transfer', amount: 100_000, accountId: id('bank'), toAccountId: id('visa'), date: at(-2, 5) }),
    tx('p2', { type: 'transfer', amount: 150_000, accountId: id('bank'), toAccountId: id('visa'), date: at(-1, 28) }),
    tx('p3', { type: 'transfer', amount: 250_000, accountId: id('bank'), toAccountId: id('visa'), date: at(0, 4) }),
    tx('r1', { type: 'income', amount: 20_000, accountId: id('visa'), date: at(0, 10) }),
    tx('l1', { type: 'loan_payment', amount: 30_000, accountId: id('visa'), date: at(0, 18) }),
    tx('p4', { type: 'transfer', amount: 100_000, accountId: id('bank'), toAccountId: id('visa'), date: at(0, 20) }),
    // Master
    tx('m0', { type: 'expense', amount: -50_000, accountId: id('master'), categoryId: id('tech'), date: at(-2, 8) }),
    tx('m3', { type: 'expense', amount: -40_000, accountId: id('master'), categoryId: id('fun'), date: at(-1, 15) }),
    tx('m1', { type: 'expense', amount: -120_000, accountId: id('master'), categoryId: id('food'), date: at(0, 5), userId: member }),
    tx('m2', { type: 'expense', amount: -90_000, accountId: id('master'), categoryId: id('tech'), date: at(0, 12) }),
    tx('pm', { type: 'transfer', amount: 70_000, accountId: id('cash'), toAccountId: id('master'), date: at(0, 22) }),
    // Amex (no billing days: calendar month)
    tx('a1', { type: 'expense', amount: -45_000, accountId: id('amex'), categoryId: id('fun'), date: at(0, 8) }),
    // Cash and bank
    tx('c1', { type: 'expense', amount: -35_000, accountId: id('cash'), categoryId: id('food'), date: at(0, 2) }),
    tx('c2', { type: 'expense', amount: -25_000, accountId: id('bank'), categoryId: id('tech'), budgetId: id('travel'), date: at(0, 21) }),
    tx('c3', { type: 'expense', amount: -10_000, accountId: id('cash'), categoryId: id('food'), date: at(-1, 28) }),
    tx('i1', { type: 'income', amount: 3_000_000, accountId: id('bank'), date: at(0, 1) }),
    tx('i2', { type: 'income', amount: 400_000, accountId: id('bank'), budgetId: id('travel'), date: at(0, 15) }),
    tx('ln', { type: 'loan', amount: -200_000, accountId: id('bank'), date: at(0, 9) })
  ]
  const users = [
    { id: owner, email: `${owner}@example.test`, displayName: 'Owner', country: 'CO', currency: 'COP', activeWorkspaceId: workspaceId, workspaces: [workspaceId] },
    { id: member, email: `${member}@example.test`, displayName: 'Member', country: 'CO', currency: 'COP', activeWorkspaceId: workspaceId, workspaces: [workspaceId] }
  ]
  return { id, owner, workspaceId, workspace, categories, accounts, budgets, transactions, users }
}

const round = value => (typeof value === 'number' ? Math.round(value * 100) / 100 : value)
const deep = value => JSON.parse(JSON.stringify(value, (_, x) => round(x)))
const shortener = prefix => id => String(id).replace(`${prefix}-`, '')

// --- Dashboard: the real <script setup> initializers, evaluated with stub stores ---

const componentSource = readFileSync(resolve(repositoryRoot, 'src/views/Dashboard.vue'), 'utf8')
const setupScript = componentSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const setupSource = ts.createSourceFile('Dashboard.ts', setupScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declarations = new Map()
for (const statement of setupSource.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) {
      declarations.set(declaration.name.text, declaration.initializer.getText(setupSource))
    }
  }
}
const libModules = await Promise.all(
  ['installments', 'budgetBasis', 'dashboardMetrics', 'creditCycle', 'cardStatements', 'budgets', 'fx', 'budgetReporting']
    .map(name => import(pathToFileURL(resolve(repositoryRoot, `src/lib/${name}.ts`)).href))
)

function dashboardFigures(fx, prefix) {
  const provided = Object.assign({}, ...libModules.map(module => ({ ...module })))
  const transactions = fx.transactions
    .map(t => ({ ...t, date: new Date(t.date), createdAt: new Date(t.date) }))
    .sort((a, b) => b.date.getTime() - a.date.getTime())
  Object.assign(provided, {
    computed: fn => ({ get value() { return fn() } }),
    ref: value => ({ value }),
    watch: () => {},
    transactionsStore: { transactions, categories: fx.categories },
    accountsStore: {
      accounts: fx.accounts,
      getAccountById: accountId => fx.accounts.find(account => account.id === accountId),
      netWorthByCurrency: { COP: fx.accounts.reduce((sum, account) => sum + account.balance, 0) }
    },
    settingsStore: { currency: 'COP' },
    goalsStore: {
      categoryBudgets: fx.workspace.categoryBudgets,
      categoryBudgetCurrency: { status: 'confirmed', code: 'COP' },
      exchangeRates: {},
      exchangeRatesBaseCurrency: 'COP',
      operatingBudgets: fx.budgets.map(({ categoryCaps, ...budget }) => ({ budget, categoryCaps })),
      convertToPrimary: (amount, currency, primary) => (currency === primary ? amount : NaN)
    },
    workspacesStore: {
      activeBudgetCardBasis: provided.parseBudgetBasis(fx.workspace.budgetCardBasis),
      workspaces: [fx.workspace],
      activeWorkspace: fx.workspace,
      activeWorkspaceProfiles: fx.users.map(user => ({ uid: user.id, displayName: user.displayName, email: user.email }))
    },
    authStore: { activeWorkspaceId: fx.workspaceId, user: { uid: fx.owner } }
  })
  const cache = new Map()
  const env = new Proxy({}, {
    has: (_, key) => typeof key === 'string' && (key in provided || declarations.has(key)),
    get: (_, key) => {
      if (key === Symbol.unscopables) return undefined
      if (key in provided) return provided[key]
      if (!cache.has(key)) {
        const javascript = ts.transpile(`(${declarations.get(key)})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
        cache.set(key, new Function('env', `with (env) { return ${javascript.trim().replace(/;$/, '')} }`)(env))
      }
      return cache.get(key)
    }
  })
  const value = name => {
    assert.ok(declarations.has(name), `Dashboard defines ${name}`)
    return env[name]?.value ?? env[name]
  }
  const short = shortener(prefix)
  const period = { year: current.year, month: current.month }
  const report = (scope, categoryCaps) => provided.reportBudgetScope({
    scope, categoryCaps, transactions, period, reportingCurrency: 'COP', exchangeRates: {}, cardBilling: env.budgetBillingFor.value
  })
  const categoriesOf = scopeReport =>
    Object.fromEntries(Object.entries(scopeReport.categories).map(([key, row]) => [short(key), round(row.monthlyAllocation?.amount)]))

  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() })
  try {
    const travel = fx.budgets[0]
    const defaultReport = report({ id: provided.DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency: 'COP' }, fx.workspace.categoryBudgets)
    const travelReport = report({ id: travel.id, kind: 'monthly', capCurrency: 'COP', totalLimit: travel.totalLimit }, travel.categoryCaps)
    return {
      basis: env.budgetBasis.value,
      budget: {
        baseSpent: round(value('budgetMonthEndProjection').baseSpent),
        baseExpenseLimitPercent: round(value('baseExpenseLimitPercent')),
        defaultCategories: categoriesOf(defaultReport),
        defaultScopeMonthly: round(defaultReport.monthlyAllocation?.amount),
        budgetSummaryTotalSpentReal: round(value('budgetSummary')?.totalSpentReal),
        travelCategories: categoriesOf(travelReport),
        budgets: deep(value('budgetBreakdown').map(b => ({ id: short(b.id), spent: b.spent, funds: b.fundsAmount, available: b.available?.amount ?? b.available }))),
        allBudgetsMonthly: round(value('allBudgetsEstimatedMonthly')?.amount)
      },
      cashFlow: deep({
        monthEndProjection: value('monthEndProjection'),
        incomeData: value('incomeData'),
        allExpensesData: value('allExpensesData'),
        liquidityDays: value('liquidityDays'),
        availableBalance: value('availableBalance'),
        committedCards: value('committedCards'),
        spendable: value('spendable'),
        upcomingCardPayments: value('upcomingCardPayments').map(p => ({ id: short(p.id), amount: p.amount, debt: p.debt, due: p.dueDate.toISOString() })),
        expensesByCategory: value('expensesByCategory'),
        memberExpenses: value('memberExpenses')
      })
    }
  } finally {
    mock.timers.reset()
  }
}

// --- Server: the fixture in the emulator, read by the Asesor tools and the alert helpers ---

async function seed(fx) {
  const batch = db.batch()
  const set = (collection, docId, data) => batch.set(db.collection(collection).doc(docId), data)
  for (const { id, ...user } of fx.users) set('users', id, user)
  const { id: _workspaceId, ...workspace } = fx.workspace
  set('workspaces', fx.workspaceId, workspace)
  for (const { id, ...category } of fx.categories) set('categories', id, category)
  for (const { id, ...account } of fx.accounts) set('accounts', id, account)
  for (const { id, categoryCaps, ...budget } of fx.budgets) {
    set('budgets', id, { ...budget, createdAt: Timestamp.fromDate(NOW), updatedAt: Timestamp.fromDate(NOW) })
    for (const [categoryId, amount] of Object.entries(categoryCaps)) {
      batch.set(db.collection('budgets').doc(id).collection('categoryCaps').doc(categoryId), { amount })
    }
  }
  for (const { id, date, ...transaction } of fx.transactions) set('transactions', id, { ...transaction, date: Timestamp.fromDate(date) })
  await batch.commit()
}

async function serverFigures(fx, prefix) {
  await seed(fx)
  const short = shortener(prefix)

  const tools = buildAgentTools(db, { workspaceId: fx.workspaceId, userId: fx.owner, timeZone: TIME_ZONE, primaryCurrency: 'COP', now: () => NOW })
  const run = (name, input = {}) => tools.find(tool => tool.name === name).run(input)
  const settings = await run('getWorkspaceSettings')
  const summary = await run('getFinancialSummary', { preset: 'this_month' })
  const asesor = {
    categoryBudgets: Object.fromEntries(settings.currentMonth.categoryBudgets.map(row => [short(row.categoryId), row.spent])),
    expenseLimitSpent: settings.currentMonth.expenseLimit.spent,
    expenseLimitPercent: settings.currentMonth.expenseLimit.percentUsed,
    totals: settings.currentMonth.totals,
    summaryTotals: summary.totals,
    monthlyExpense: summary.byBudget.monthlyExpense,
    monthlyIncome: summary.byBudget.monthlyIncome,
    budgets: summary.byBudget.budgets.map(b => ({ id: short(b.budgetId ?? b.id), spent: b.spent, funds: b.funds, available: b.available }))
  }

  // Loaded like notifyBudgetThreshold: the workspace basis decides the card billing.
  const workspace = (await db.collection('workspaces').doc(fx.workspaceId).get()).data()
  const accounts = (await db.collection('accounts').where('workspaceId', '==', fx.workspaceId).get()).docs
    .map(docSnap => ({ ...docSnap.data(), id: docSnap.id }))
  const all = (await db.collection('transactions').where('workspaceId', '==', fx.workspaceId).get()).docs.map(docSnap => docSnap.data())
  const cardBasis = http.workspaceCardBasis(workspace)
  const types = alerts.alertTransactionTypes(cardBasis)
  const loaded = all.filter(transaction => types.includes(transaction.type))
  const { billingFor } = alerts.alertCardBilling(workspace, accounts, cardBasis === 'payment' ? { transactions: loaded, timeZone: TIME_ZONE } : undefined)
  const expenses = all.filter(transaction => transaction.type === 'expense')
  const month = http.zonedYearMonth(NOW, TIME_ZONE)
  const options = { timeZone: TIME_ZONE, reportingCurrency: 'COP', exchangeRates: {}, billingFor }
  const travel = { id: fx.budgets[0].id, kind: 'monthly' }
  const alertFigures = {
    defaultCategories: Object.fromEntries(Object.keys(fx.workspace.categoryBudgets)
      .map(categoryId => [short(categoryId), alerts.categorySpendForScope(expenses, categoryId, { id: 'default-monthly', kind: 'monthly' }, month, options)])),
    defaultScopeTotal: alerts.scopeTotalSpend(expenses, { id: 'default-monthly', kind: 'monthly' }, month, options),
    travelCategories: Object.fromEntries([fx.id('food'), fx.id('tech')]
      .map(categoryId => [short(categoryId), alerts.categorySpendForScope(expenses, categoryId, travel, month, options)])),
    travelTotal: alerts.scopeTotalSpend(expenses, travel, month, options),
    weddingTotal: alerts.scopeTotalSpend(expenses, { id: fx.budgets[1].id, kind: 'event' }, month, options),
    monthlyExpenseAllBudgets: alerts.monthlyExpenseTotal(expenses, month, options, new Set())
  }
  return { asesor, alerts: alertFigures }
}

const surfaces = new Map()
/** Dashboard, alerts and Asesor figures for the fixture under `basis` (undefined = field absent). */
const figuresFor = basis => {
  const key = basis ?? 'absent'
  if (!surfaces.has(key)) {
    const prefix = `basis-${runId}-${key}`
    const fx = buildFixture(prefix, basis)
    surfaces.set(key, serverFigures(fx, prefix).then(server => ({ dashboard: dashboardFigures(fx, prefix), ...server })))
  }
  return surfaces.get(key)
}

/** Every surface reports `expected` for the budget comparisons. */
function assertSameBudgetFigures({ dashboard, asesor, alerts: alertFigures }, expected) {
  const { categories, base, basePercent, travel, travelTotal, travelFunds, wedding, allBudgets } = expected
  // Category caps and the base monthly cap (the default budget).
  assert.deepEqual(dashboard.budget.defaultCategories, categories)
  assert.deepEqual(alertFigures.defaultCategories, categories)
  assert.deepEqual(asesor.categoryBudgets, categories)
  for (const figure of [dashboard.budget.baseSpent, dashboard.budget.defaultScopeMonthly, dashboard.budget.budgetSummaryTotalSpentReal, alertFigures.defaultScopeTotal, asesor.expenseLimitSpent]) {
    assert.equal(figure, base)
  }
  assert.equal(dashboard.budget.baseExpenseLimitPercent, basePercent)
  assert.equal(asesor.expenseLimitPercent, Math.round(basePercent))
  // The extra monthly budget (Viajes): its caps, spending and funds.
  assert.deepEqual(dashboard.budget.travelCategories, travel)
  assert.deepEqual(alertFigures.travelCategories, travel)
  assert.equal(alertFigures.travelTotal, travelTotal)
  const travelRow = { id: 'travel', spent: travelTotal, funds: travelFunds, available: round(travelFunds - travelTotal) }
  // The event budget (Boda) counts its full principal under both bases.
  const weddingRow = { id: 'wedding', spent: wedding, funds: null, available: null }
  assert.deepEqual(dashboard.budget.budgets, [travelRow, weddingRow])
  assert.deepEqual(asesor.budgets, [travelRow, weddingRow])
  assert.equal(alertFigures.weddingTotal, wedding)
  // Month spending of every budget; byBudget leaves out Viajes, which its own funds cover.
  assert.equal(dashboard.budget.allBudgetsMonthly, allBudgets)
  assert.equal(alertFigures.monthlyExpenseAllBudgets, allBudgets)
  assert.equal(asesor.monthlyExpense, round(allBudgets - travelTotal))
}

test('Consumo: Dashboard, alerts and Asesor count each card purchase in its statement cycle month', async () => {
  const figures = await figuresFor('consumption')
  assert.equal(figures.dashboard.basis, 'consumption')
  assertSameBudgetFigures(figures, {
    categories: { food: 305_000, tech: 0, fun: 165_000 },
    base: 470_000,
    basePercent: 78.33,
    travel: { food: 60_000, tech: 25_000 },
    travelTotal: 85_000,
    travelFunds: 400_000,
    wedding: 500_000,
    allBudgets: 1_055_000
  })
})

test('Pagos: Dashboard, alerts and Asesor count card purchases when their statements are paid (card ledger)', async () => {
  const figures = await figuresFor('payment')
  assert.equal(figures.dashboard.basis, 'payment')
  // By hand, oldest statement first: early, on-time and late payments, the refund and the loan
  // repayment on the Visa settle its statements in the months they were made.
  assertSameBudgetFigures(figures, {
    categories: { food: 373_987.34, tech: 150_000, fun: 95_126.58 },
    base: 619_113.92,
    basePercent: 103.19,
    travel: { food: 7_594.94, tech: 25_000 },
    travelTotal: 32_594.94,
    travelFunds: 400_000,
    wedding: 500_000,
    allBudgets: 715_000
  })
})

test('a workspace without a card basis is Consumo on every surface', async () => {
  const [absent, consumption] = await Promise.all([figuresFor(undefined), figuresFor('consumption')])
  assert.deepEqual(absent, consumption)
})

test('cash flow is identical under both card bases on the Dashboard and in the Asesor', async () => {
  const [consumption, payment] = await Promise.all([figuresFor('consumption'), figuresFor('payment')])
  assert.deepEqual(payment.dashboard.cashFlow, consumption.dashboard.cashFlow)
  assert.deepEqual(payment.asesor.totals, consumption.asesor.totals)
  assert.deepEqual(payment.asesor.summaryTotals, consumption.asesor.summaryTotals)
  assert.equal(payment.asesor.monthlyIncome, consumption.asesor.monthlyIncome)
  // Próximos pagos and the pending card payments do not follow the budget basis.
  assert.deepEqual(
    payment.dashboard.cashFlow.upcomingCardPayments.map(({ id, amount, debt }) => ({ id, amount, debt })),
    [{ id: 'master', amount: 140_000, debt: 230_000 }, { id: 'visa', amount: 690_000, debt: 690_000 }]
  )
  assert.equal(payment.dashboard.cashFlow.committedCards, 140_000)
})
