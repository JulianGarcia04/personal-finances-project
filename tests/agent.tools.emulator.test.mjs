// Deterministic chat-agent tool tests against the Firestore emulator: the real tool
// bodies (functions/lib/agentContext.js buildAgentTools) with a fixed `now`, no
// Genkit and no Gemini. Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/agent.tools.emulator.test.mjs"
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { FIXED_NOW, TIME_ZONE, seedAgentFixture } from './fixtures/agent.fixture.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore } = requireFunctions('firebase-admin/firestore')
const { buildAgentTools, resolvePrimaryCurrency } = requireFunctions('./lib/agentContext.js')
const { zonedDateKey } = requireFunctions('./lib/http.js')

const runId = `${Date.now()}`
const userId = `agent-user-${runId}`
let app
let db
let ids
let tools

const call = (name, input = {}) => {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool, `tool ${name} is registered`)
  return tool.run(input)
}

before(async () => {
  app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, `agent-tools-${runId}`)
  db = getFirestore(app)
  ids = await seedAgentFixture(db, { workspaceId: `ws-agent-${runId}`, userId, now: FIXED_NOW })
  const user = (await db.collection('users').doc(userId).get()).data()
  tools = buildAgentTools(db, {
    workspaceId: ids.workspaceId,
    userId,
    timeZone: TIME_ZONE,
    primaryCurrency: resolvePrimaryCurrency(user),
    now: () => FIXED_NOW
  })
})

after(async () => {
  await deleteApp(app)
})

test('the primary currency is the user currency (dashboard source), not the workspace currency', async () => {
  const workspace = (await db.collection('workspaces').doc(ids.workspaceId).get()).data()
  assert.equal(workspace.currency, 'USD')
  const settings = await call('getWorkspaceSettings')
  assert.equal(settings.currency, 'COP')
  const summary = await call('getFinancialSummary', { preset: 'this_month' })
  assert.equal(summary.currency, 'COP')
})

test('getFinancialSummary this_month: local-midnight income on the 1st, USD converted, installment share, bridge leg, no transfers or loans', async () => {
  const summary = await call('getFinancialSummary', { preset: 'this_month', groupBy: 'category' })
  assert.deepEqual(summary.period, { start: '2026-10-01', end: '2026-10-31', label: 'octubre de 2026' })
  assert.deepEqual(summary.totals, { income: 5_000_000, expenses: 560_000, net: 4_440_000, savingsRate: 88.8, upcomingInstallments: 0 })
  const byCategory = Object.fromEntries(summary.groups.map(group => [group.name, group.expenses]))
  assert.deepEqual(byCategory, { Salario: 0, Comida: 460_000, 'Tecnología': 100_000 })
  assert.equal(summary.topExpenses[0].amount, 200_000)
  const laptop = summary.topExpenses.find(row => row.id === ids.transactions.laptop)
  assert.equal(laptop.installmentsInfo, 'cuota 2 de 3 (compra total 300000 COP)')
})

test('getFinancialSummary last_month includes the UTC-midnight expense of the 1st and the first installment', async () => {
  const summary = await call('getFinancialSummary', { preset: 'last_month' })
  assert.deepEqual(summary.period, { start: '2026-09-01', end: '2026-09-30', label: 'septiembre de 2026' })
  assert.equal(summary.totals.income, 4_000_000)
  assert.equal(summary.totals.expenses, 210_000)
  assert.equal(summary.totals.net, 3_790_000)
  assert.ok(summary.topExpenses.some(row => row.id === ids.transactions.utcMidnight && row.date === '2026-09-30'))
})

test('getFinancialSummary this_week uses Monday to Sunday local days', async () => {
  const summary = await call('getFinancialSummary', { preset: 'this_week', type: 'expense' })
  assert.equal(summary.period.start, '2026-10-05')
  assert.equal(summary.period.end, '2026-10-11')
  assert.equal(summary.totals.income, 0)
  // USD dinner (Oct 5) 200k + laptop share (Oct 10) 100k + market (Oct 11) 200k; bridge (Oct 2) is outside.
  assert.equal(summary.totals.expenses, 500_000)
})

test('getFinancialSummary custom range is inclusive in local days', async () => {
  const summary = await call('getFinancialSummary', { startDate: '2026-09-15', endDate: '2026-10-01' })
  assert.deepEqual(summary.period, { start: '2026-09-15', end: '2026-10-01', label: '2026-09-15 a 2026-10-01' })
  assert.equal(summary.totals.income, 9_000_000)
  assert.equal(summary.totals.expenses, 110_000)
  assert.equal(summary.totals.net, 8_890_000)
})

test('getFinancialSummary compareWithPrevious compares this month with last month', async () => {
  const summary = await call('getFinancialSummary', { preset: 'this_month', compareWithPrevious: true })
  assert.equal(summary.comparison.period.start, '2026-09-01')
  assert.equal(summary.comparison.totals.expenses, 210_000)
  assert.deepEqual(summary.comparison.deltas, {
    income: { diff: 1_000_000, percent: 25 },
    expenses: { diff: 350_000, percent: 167 },
    net: { diff: 650_000, percent: 17 }
  })
})

test('listTransactions with an account and date range includes incoming transfers', async () => {
  const pocket = await call('listTransactions', { accountId: ids.accounts.pocket, startDate: '2026-10-01', endDate: '2026-10-31' })
  assert.equal(pocket.count, 1)
  assert.deepEqual(pocket.period, { start: '2026-10-01', end: '2026-10-31' })
  assert.equal(pocket.transactions[0].id, ids.transactions.transfer)
  assert.equal(pocket.transactions[0].toAccountName, 'Bolsillo Viaje')
  assert.equal(pocket.transactions[0].accountName, 'Banco Principal')

  const bank = await call('listTransactions', { accountId: ids.accounts.bank, startDate: '2026-10-01', endDate: '2026-10-31' })
  assert.deepEqual(bank.transactions.map(row => row.date), ['2026-10-11', '2026-10-06', '2026-10-04', '2026-10-03', '2026-10-01'])

  const september = await call('listTransactions', { startDate: '2026-09-30', endDate: '2026-09-30' })
  assert.deepEqual(september.transactions.map(row => row.id), [ids.transactions.utcMidnight])
})

test('listAccounts returns balances in the primary currency and the dashboard net worth', async () => {
  const result = await call('listAccounts')
  // COP 2,000,000 + 500,000 + 100,000 - 300,000 - 60,000 = 2,240,000; USD 1,000 x 4,000; EUR 10 at 1:1 (no rate).
  assert.equal(result.totals.currency, 'COP')
  assert.equal(result.totals.netWorth, 6_240_010)
  assert.deepEqual(
    Object.fromEntries(result.totals.byCurrency.map(row => [row.currency, row.inPrimary])),
    { COP: 2_240_000, USD: 4_000_000, EUR: 10 }
  )
  const byName = Object.fromEntries(result.accounts.map(row => [row.name, row]))
  assert.equal(byName['Cuenta USD'].balanceInPrimary, 4_000_000)
  assert.equal(byName['Visa'].availableCredit, 2_700_000)
  assert.equal(byName['Bolsillo Viaje'].pocketOf, 'Banco Principal')
  assert.equal(byName['Gastos con Pareja'].bridge, true)
  assert.equal(byName['Por cobrar'], undefined, 'partner workspace accounts are excluded')
  assert.ok(result.notes.some(note => note.includes('EUR') && note.includes('1:1')))
})

test('getWorkspaceSettings reports budgets vs actual for the current month', async () => {
  const settings = await call('getWorkspaceSettings')
  assert.deepEqual(settings.currentMonth.categoryBudgets, [
    { categoryId: ids.categories.tech, categoryName: 'Tecnología', limit: 50_000, spent: 100_000, remaining: -50_000, percentUsed: 200, exceeded: true },
    { categoryId: ids.categories.food, categoryName: 'Comida', limit: 300_000, spent: 460_000, remaining: -160_000, percentUsed: 153, exceeded: true }
  ])
  assert.deepEqual(settings.currentMonth.categoryBudgetTotals, { budget: 350_000, spent: 560_000, percentUsed: 100 })
  assert.deepEqual(settings.currentMonth.expenseLimit, { limit: 1_000_000, spent: 560_000, remaining: 440_000, percentUsed: 56, exceeded: false })
  assert.deepEqual(settings.budgetSplit.needs, { percent: 50, amount: 3_000_000 })
  assert.deepEqual(settings.goalAllocations, [{ goalId: ids.goal, goalName: 'Viaje a Japón', amount: 500_000 }])
})

test('destructive tools without confirmed return needsConfirmation and write nothing', async () => {
  const deletion = await call('deleteTransaction', { transactionId: ids.transactions.market })
  assert.equal(deletion.needsConfirmation, true)
  assert.equal(deletion.summary.description, 'Mercado Éxito')
  assert.ok((await db.collection('transactions').doc(ids.transactions.market).get()).exists)

  const budgets = await call('saveCategoryBudgets', { budgets: [{ categoryId: ids.categories.food, monthlyLimit: 999 }] })
  assert.equal(budgets.needsConfirmation, true)
  const workspace = (await db.collection('workspaces').doc(ids.workspaceId).get()).data()
  assert.equal(workspace.categoryBudgets[ids.categories.food], 300_000)
})

test('confirmed: true without a confirmation turn still only returns the summary', async () => {
  const deletion = await call('deleteTransaction', { transactionId: ids.transactions.market, confirmed: true })
  assert.equal(deletion.needsConfirmation, true)
  assert.match(deletion.message, /Aún no hay confirmación/)
  assert.ok((await db.collection('transactions').doc(ids.transactions.market).get()).exists)

  const budgets = await call('saveCategoryBudgets', { budgets: [{ categoryId: ids.categories.food, monthlyLimit: 999 }], confirmed: true })
  assert.equal(budgets.needsConfirmation, true)
  const workspace = (await db.collection('workspaces').doc(ids.workspaceId).get()).data()
  assert.equal(workspace.categoryBudgets[ids.categories.food], 300_000)
})

test('confirmed: true after a confirmation turn writes', async () => {
  const user = (await db.collection('users').doc(userId).get()).data()
  const granted = buildAgentTools(db, {
    workspaceId: ids.workspaceId, userId, timeZone: TIME_ZONE, primaryCurrency: resolvePrimaryCurrency(user),
    now: () => FIXED_NOW, confirmationGranted: true
  })
  const save = granted.find(tool => tool.name === 'saveCategoryBudgets')
  // Same limit as the fixture, so later tests see unchanged budgets.
  const result = await save.run({ budgets: [{ categoryId: ids.categories.tech, monthlyLimit: 50_000 }], confirmed: true })
  assert.equal(result.success, true)
  assert.equal(result.savedBudgets, 1)
})

test('deleteTransaction with an unknown or guessed id returns a lookup hint instead of failing', async () => {
  for (const confirmed of [undefined, true]) {
    const result = await call('deleteTransaction', { transactionId: 'Mercado Éxito', confirmed })
    assert.match(result.error, /no existe en el workspace activo.*listTransactions/)
  }
  assert.ok((await db.collection('transactions').doc(ids.transactions.market).get()).exists)
})

test('createTransaction keeps a date-only value on the same local day and signs expenses negative', async () => {
  const result = await call('createTransaction', {
    accountId: ids.accounts.cash, amount: 15_000, type: 'expense', description: 'Taxi', categoryId: ids.categories.food, date: '2026-10-01'
  })
  assert.equal(result.success, true)
  assert.equal(result.amount, -15_000)
  assert.equal(result.date, '2026-10-01')
  const stored = (await db.collection('transactions').doc(result.id).get()).data()
  assert.equal(stored.amount, -15_000)
  assert.equal(zonedDateKey(stored.date.toDate(), TIME_ZONE), '2026-10-01')
  const cash = (await db.collection('accounts').doc(ids.accounts.cash).get()).data()
  assert.equal(cash.balance, 85_000)
})

test('createTransaction rejects a bridge expense with { error } instead of throwing', async () => {
  const result = await call('createTransaction', {
    accountId: ids.accounts.bridge, amount: 10_000, type: 'expense', description: 'Cena', categoryId: ids.categories.food
  })
  assert.match(result.error, /cuenta puente/)
  const bridge = (await db.collection('accounts').doc(ids.accounts.bridge).get()).data()
  assert.equal(bridge.balance, -60_000)
})

test('invalid tool input comes back as { error }', async () => {
  const result = await call('getFinancialSummary', { preset: 'this_month', startDate: '2026-10-01' })
  assert.match(result.error, /Usa solo una forma de periodo/)
})
