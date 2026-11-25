// Deterministic chat-agent tool tests against the Firestore emulator: the real tool
// bodies (functions/lib/agentContext.js buildAgentTools) with a fixed `now`, no
// Genkit and no Gemini. Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/agent.tools.emulator.test.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXED_NOW, TIME_ZONE, seedAgentFixture } from './fixtures/agent.fixture.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore')
const { buildAgentTools, resolvePrimaryCurrency } = requireFunctions('./lib/agentContext.js')
const { zonedDateKey, zonedWallClockToInstant } = requireFunctions('./lib/http.js')

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
  // Visa (closing 25, due 5): bought Sep 10 → September statement, paid in October → share 1 of 3.
  assert.equal(laptop.installmentsInfo, 'cuota 1 de 3 (compra total 300000 COP)')
})

test('getFinancialSummary last_month includes the UTC-midnight expense of the 1st and no card installment', async () => {
  const summary = await call('getFinancialSummary', { preset: 'last_month' })
  assert.deepEqual(summary.period, { start: '2026-09-01', end: '2026-09-30', label: 'septiembre de 2026' })
  assert.equal(summary.totals.income, 4_000_000)
  // Restaurant 80k + UTC-midnight delivery 30k; the Sep 10 laptop's first share is paid on Oct 5.
  assert.equal(summary.totals.expenses, 110_000)
  assert.equal(summary.totals.net, 3_890_000)
  assert.ok(summary.topExpenses.some(row => row.id === ids.transactions.utcMidnight && row.date === '2026-09-30'))
})

test('getFinancialSummary this_week uses Monday to Sunday local days', async () => {
  const summary = await call('getFinancialSummary', { preset: 'this_week', type: 'expense' })
  assert.equal(summary.period.start, '2026-10-05')
  assert.equal(summary.period.end, '2026-10-11')
  assert.equal(summary.totals.income, 0)
  // USD dinner (Oct 5) 200k + laptop share (Oct 5, Visa due day) 100k + market (Oct 11) 200k; bridge (Oct 2) is outside.
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
  assert.equal(summary.comparison.totals.expenses, 110_000)
  assert.deepEqual(summary.comparison.deltas, {
    income: { diff: 1_000_000, percent: 25 },
    expenses: { diff: 450_000, percent: 409 },
    net: { diff: 550_000, percent: 14 }
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

test('goal tools read linked pocket balances live, validate Admin links, and preserve virtual tracking', async () => {
  const goalRef = db.collection('goals').doc(ids.goal)
  await goalRef.update({ linkedAccountId: ids.accounts.pocket })

  const linkedGoals = await call('listGoals')
  assert.equal(linkedGoals.find(goal => goal.id === ids.goal).currentAmount, 500_000)
  assert.equal(linkedGoals.find(goal => goal.id === ids.goal).linkedAccountName, 'Bolsillo Viaje')

  await db.collection('accounts').doc(ids.accounts.pocket).update({ balance: 450_000 })
  const refreshedGoals = await call('listGoals')
  assert.equal(refreshedGoals.find(goal => goal.id === ids.goal).currentAmount, 450_000)

  const linkedCreate = await call('createGoal', {
    name: 'Fondo de viaje', targetAmount: 800_000, currentAmount: 300_000,
    currency: 'COP', linkedAccountId: ids.accounts.pocket, targetDate: '2027-01-01'
  })
  assert.equal(linkedCreate.currentAmount, 450_000)
  const storedLinked = (await db.collection('goals').doc(linkedCreate.id).get()).data()
  assert.equal(storedLinked.linkedAccountId, ids.accounts.pocket)
  assert.equal(storedLinked.currentAmount, 0, 'linked progress is never duplicated in currentAmount')

  const beforeInvalidCreate = (await db.collection('goals').where('workspaceId', '==', ids.workspaceId).get()).size
  const invalidCreate = await call('createGoal', {
    name: 'Tarjeta no elegible', targetAmount: 200_000,
    currency: 'COP', linkedAccountId: ids.accounts.card, targetDate: '2027-01-01'
  })
  assert.match(invalidCreate.error, /misma moneda|tarjeta/i)
  assert.equal((await db.collection('goals').where('workspaceId', '==', ids.workspaceId).get()).size, beforeInvalidCreate)

  const forbiddenUpdate = await call('updateGoalAmount', { goalId: linkedCreate.id, currentAmount: 999_000 })
  assert.match(forbiddenUpdate.error, /vinculada a una cuenta/i)
  assert.equal((await db.collection('goals').doc(linkedCreate.id).get()).data().currentAmount, 0)

  const virtualCreate = await call('createGoal', {
    name: 'Seguimiento manual', targetAmount: 50_000, currentAmount: 10_000,
    currency: 'COP', targetDate: '2027-01-01'
  })
  assert.equal(virtualCreate.currentAmount, 10_000)
  await call('updateGoalAmount', { goalId: virtualCreate.id, currentAmount: 20_000 })
  assert.equal((await db.collection('goals').doc(virtualCreate.id).get()).data().currentAmount, 20_000)
})

test('getWorkspaceSettings reports budgets vs actual for the current month', async () => {
  const settings = await call('getWorkspaceSettings')
  assert.deepEqual(settings.currentMonth.categoryBudgets, [
    { categoryId: ids.categories.tech, categoryName: 'Tecnología', limit: 50_000, spent: 100_000, remaining: -50_000, percentUsed: 200, exceeded: true },
    { categoryId: ids.categories.food, categoryName: 'Comida', limit: 300_000, spent: 460_000, remaining: -160_000, percentUsed: 153, exceeded: true }
  ])
  assert.deepEqual(settings.currentMonth.categoryBudgetTotals, { budget: 350_000, spent: 560_000, percentUsed: 160 })
  assert.deepEqual(settings.currentMonth.expenseLimit, { limit: 1_000_000, spent: 560_000, remaining: 440_000, percentUsed: 56, exceeded: false })
  assert.deepEqual(settings.budgetSplit.needs, { percent: 50, amount: 3_000_000 })
  assert.deepEqual(settings.goalAllocations, [{ goalId: ids.goal, goalName: 'Viaje a Japón', amount: 500_000 }])
})

test('P1 S6: under Pagos the budget figures follow the card ledger over the whole card history, and so does cash flow (P1 S8.4)', async () => {
  // Own workspace and user (writes need the user's active workspace), so the shared fixture is untouched.
  const workspaceId = `${ids.workspaceId}-pagos`
  const owner = `${userId}-pagos`
  const id = name => `${workspaceId}-${name}`
  const local = (month, day) => Timestamp.fromDate(zonedWallClockToInstant(2026, month, day, 12, TIME_ZONE))
  const batch = db.batch()
  const set = (collection, docId, data) => batch.set(db.collection(collection).doc(docId), data)
  set('users', owner, { email: `${owner}@example.test`, country: 'CO', currency: 'COP', activeWorkspaceId: workspaceId, workspaces: [workspaceId] })
  set('workspaces', workspaceId, {
    name: 'Pagos', ownerId: owner, members: [owner], currency: 'COP', budgetCardBasis: 'payment',
    categoryBudgets: { [id('food')]: 500_000, [id('tech')]: 500_000 }, categoryBudgetCurrency: 'COP', expenseLimit: 1_000_000
  })
  for (const [key, name] of [['food', 'Comida'], ['tech', 'Tecnología']]) {
    set('categories', id(key), { workspaceId, userId: owner, name, type: 'expense', icon: 'tag', color: '#10b981' })
  }
  set('accounts', id('bank'), { workspaceId, userId: owner, name: 'Banco', type: 'checking', balance: 1_000_000, limit: 0, currency: 'COP' })
  // Closes on the 25th, due on the 5th of the next month. Balance = -40,000 - 100,000 + 70,000.
  set('accounts', id('visa'), {
    workspaceId, userId: owner, name: 'Visa', type: 'credit', balance: -70_000, limit: 3_000_000, currency: 'COP',
    statementClosingDay: 25, paymentDueDay: 5
  })
  const movement = (docId, data) => set('transactions', id(docId), {
    workspaceId, userId: owner, description: docId, categoryId: '', toAccountId: null, installments: 1, currency: 'COP', ...data
  })
  // June purchase (statement due Jul 5), older than the summary's 2-month lookback, paid late in October.
  movement('old', { type: 'expense', amount: -40_000, accountId: id('visa'), categoryId: id('tech'), date: local(5, 10) })
  // October cycle, statement due Nov 5.
  movement('oct', { type: 'expense', amount: -100_000, accountId: id('visa'), categoryId: id('food'), date: local(9, 3) })
  // Oct 8: pays the June statement (40,000) and 30,000 of the Nov 5 statement, oldest first.
  movement('pay', { type: 'transfer', amount: 70_000, accountId: id('bank'), toAccountId: id('visa'), date: local(9, 8) })
  await batch.commit()

  const pagosTools = buildAgentTools(db, { workspaceId, userId: owner, timeZone: TIME_ZONE, primaryCurrency: 'COP', now: () => FIXED_NOW })
  const pagos = (name, input = {}) => pagosTools.find(tool => tool.name === name).run(input)
  const spentByCategory = settings => Object.fromEntries(settings.currentMonth.categoryBudgets.map(row => [row.categoryName, row.spent]))

  const settings = await pagos('getWorkspaceSettings')
  assert.deepEqual(spentByCategory(settings), { Tecnología: 40_000, Comida: 30_000 })
  assert.equal(settings.currentMonth.expenseLimit.spent, 70_000)
  // Cash flow counts the card like the Dashboard: the late June payment and the early part, both in October.
  assert.equal(settings.currentMonth.totals.expenses, 70_000)
  assert.ok(settings.notes.some(note => note.includes('base Pagos')))
  const summary = await pagos('getFinancialSummary', { preset: 'this_month' })
  assert.equal(summary.totals.expenses, 70_000)
  assert.equal(summary.byBudget.monthlyExpense, 70_000)

  // A card expense written in the same chat: the ledger reads the new balance, not the cached one.
  const created = await pagos('createTransaction', {
    accountId: id('visa'), amount: 20_000, type: 'expense', description: 'Almuerzo', categoryId: id('food'), date: '2026-10-09'
  })
  assert.equal(created.success, true)
  const after = await pagos('getWorkspaceSettings')
  // The Nov 5 statement is now 120,000, of which 30,000 (a quarter) was paid in October.
  assert.deepEqual(spentByCategory(after), { Tecnología: 40_000, Comida: 30_000 })
  assert.equal(after.currentMonth.expenseLimit.spent, 70_000)
  assert.equal(after.currentMonth.totals.expenses, 70_000)
})

// Pagos with more billing cards than one `in` query takes (30), in their own workspace. Dates are
// relative to the harness month (FIXED_NOW) and `now` is its 24th, so no figure depends on the day
// or month the suite runs. Each card: a 10,000 Comida purchase on the 3rd (statement closing on the
// 25th, due on the 5th of next month) and 5,000 paid on the 20th. Card 00 also sends 1,000 to card
// 34 on the 21st (a charge on 00's statement, a payment on 34's), across the two query batches.
let manyCards
const seedManyCards = async () => {
  if (manyCards) return manyCards
  const [year, month] = zonedDateKey(FIXED_NOW, TIME_ZONE).split('-').map(Number)
  const at = (monthOffset, day) => zonedWallClockToInstant(year, month - 1 + monthOffset, day, 12, TIME_ZONE)
  const workspaceId = `${ids.workspaceId}-cards`
  const owner = `${userId}-cards`
  const id = name => `${workspaceId}-${name}`
  const food = id('food')
  const cards = Array.from({ length: 35 }, (_, k) => id(`card${String(k).padStart(2, '0')}`))
  const batch = db.batch()
  const set = (collection, docId, data) => batch.set(db.collection(collection).doc(docId), data)
  set('users', owner, { email: `${owner}@example.test`, country: 'CO', currency: 'COP', activeWorkspaceId: workspaceId, workspaces: [workspaceId] })
  set('workspaces', workspaceId, {
    name: 'Tarjetas', ownerId: owner, members: [owner], currency: 'COP', budgetCardBasis: 'payment',
    categoryBudgets: { [food]: 1_000_000 }, categoryBudgetCurrency: 'COP', expenseLimit: 2_000_000
  })
  set('categories', food, { workspaceId, userId: owner, name: 'Comida', type: 'expense' })
  const account = (docId, data) => set('accounts', docId, { workspaceId, userId: owner, name: docId, currency: 'COP', ...data })
  const movement = (docId, data) => set('transactions', docId, {
    workspaceId, userId: owner, currency: 'COP', installments: 1, toAccountId: null, ...data, date: Timestamp.fromDate(data.date)
  })
  account(id('bank'), { type: 'checking', balance: 10_000_000 })
  cards.forEach((card, k) => {
    movement(`${card}-buy`, { type: 'expense', amount: -10_000, accountId: card, categoryId: food, date: at(0, 3) })
    movement(`${card}-pay`, { type: 'transfer', amount: 5_000, accountId: id('bank'), toAccountId: card, date: at(0, 20) })
    const transfer = k === 0 ? -1_000 : k === 34 ? 1_000 : 0
    account(card, { type: 'credit', balance: -5_000 + transfer, statementClosingDay: 25, paymentDueDay: 5, limit: 1_000_000 })
  })
  movement(id('card-to-card'), { type: 'transfer', amount: 1_000, accountId: cards[0], toAccountId: cards[34], date: at(0, 21) })
  await batch.commit()
  const now = at(0, 24)
  manyCards = {
    workspaceId,
    food,
    cards,
    period: { year, month: month - 1 },
    previousMonthDay: zonedDateKey(at(-1, 10), TIME_ZONE),
    tools: () => buildAgentTools(db, {
      workspaceId, userId: owner, timeZone: TIME_ZONE, primaryCurrency: 'COP', now: () => now, confirmationGranted: true
    })
  }
  return manyCards
}

const runTool = (tools, name, input = {}) => tools.find(tool => tool.name === name).run(input)
const budgetFigures = (settings, food) => ({
  food: settings.currentMonth.categoryBudgets.find(row => row.categoryId === food)?.spent,
  base: settings.currentMonth.expenseLimit?.spent,
  cashFlow: settings.currentMonth.totals.expenses
})

/** The app's figure for the same data: Comida this month on the Pagos basis (src/lib helpers). */
const frontendFoodSpent = async ({ workspaceId, food, period }) => {
  const [installments, reporting] = await Promise.all(['installments', 'budgetReporting']
    .map(name => import(pathToFileURL(resolve(repositoryRoot, `src/lib/${name}.ts`)).href)))
  const accounts = (await db.collection('accounts').where('workspaceId', '==', workspaceId).get()).docs
    .map(docSnap => ({ ...docSnap.data(), id: docSnap.id }))
  const transactions = (await db.collection('transactions').where('workspaceId', '==', workspaceId).get()).docs
    .map(docSnap => ({ ...docSnap.data(), id: docSnap.id, date: docSnap.data().date.toDate() }))
  // The app buckets months in the browser's local time zone.
  const previousTimeZone = process.env.TZ
  process.env.TZ = TIME_ZONE
  try {
    const cardBilling = installments.createCardBillingLookup(accounts, 'payment', { transactions })
    const report = reporting.reportBudgetScope({
      scope: { id: 'default-monthly', kind: 'monthly', capCurrency: 'COP' }, categoryCaps: { [food]: 1_000_000 },
      transactions, period, reportingCurrency: 'COP', exchangeRates: {}, cardBilling
    })
    return Math.round(report.categories[food].monthlyAllocation.amount * 100) / 100
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  }
}

test('P1 S6: under Pagos with 35 billing cards the Asesor reads every card history batch and counts a card-to-card transfer once, like the app', async () => {
  const fixture = await seedManyCards()
  const tools = fixture.tools()
  // 33 cards x 5,000 paid this month + card 34: 6,000 + card 00: 10,000 x 5,000 / 11,000 of its statement.
  const expected = 175_545.45
  const settings = await runTool(tools, 'getWorkspaceSettings')
  // Cash flow counts the same card payments (every purchase is Comida in the base budget).
  assert.deepEqual(budgetFigures(settings, fixture.food), { food: expected, base: expected, cashFlow: expected })
  assert.equal(await frontendFoodSpent(fixture), expected)
  const summary = await runTool(tools, 'getFinancialSummary', { preset: 'this_month' })
  assert.equal(summary.byBudget.monthlyExpense, expected)
})

test('P1 S6: a card purchase of last month written and deleted in the same chat moves the Pagos figures with the new balances', async () => {
  const fixture = await seedManyCards()
  const chat = fixture.tools()
  const card05 = fixture.cards[5]
  const balanceOf = async () => (await runTool(chat, 'listAccounts')).accounts.find(row => row.id === card05)?.balance
  const before = { food: 175_545.45, base: 175_545.45, cashFlow: 175_545.45 }
  // Loads (and caches) the accounts in this chat before the write.
  assert.deepEqual(budgetFigures(await runTool(chat, 'getWorkspaceSettings'), fixture.food), before)
  assert.equal(await balanceOf(), -5_000)

  const created = await runTool(chat, 'createTransaction', {
    accountId: card05, amount: 20_000, type: 'expense', description: 'Almuerzo', categoryId: fixture.food, date: fixture.previousMonthDay
  })
  assert.equal(created.success, true)
  // Its statement is due on the 5th of this month and the 5,000 paid on the 20th settle it first, so
  // all 20,000 count this month and card 05's own purchase nothing (+15,000). A stale cached
  // balance (-5,000) would read as prior credit and leave 175,545.45.
  const afterCreate = { food: 190_545.45, base: 190_545.45, cashFlow: 190_545.45 }
  assert.deepEqual(budgetFigures(await runTool(chat, 'getWorkspaceSettings'), fixture.food), afterCreate)
  assert.deepEqual(budgetFigures(await runTool(fixture.tools(), 'getWorkspaceSettings'), fixture.food), afterCreate)
  assert.equal(await frontendFoodSpent(fixture), afterCreate.food)
  assert.equal(await balanceOf(), -25_000)

  const deleted = await runTool(chat, 'deleteTransaction', { transactionId: created.id, confirmed: true })
  assert.deepEqual(deleted, { success: true, message: 'Transacción eliminada y saldos restaurados.' })
  assert.deepEqual(budgetFigures(await runTool(chat, 'getWorkspaceSettings'), fixture.food), before)
  assert.deepEqual(budgetFigures(await runTool(fixture.tools(), 'getWorkspaceSettings'), fixture.food), before)
})

test('P1 S8.4: a workspace without billing cards gets byte-identical summaries (card ledger only for billing cards)', async () => {
  // The shared fixture in its own workspace, with the Visa's billing days removed: no account bills
  // by statement, so the Asesor reads no card history and counts cards like before the ledger.
  const workspaceId = 'ws-agent-no-billing-cards'
  const owner = 'agent-user-no-billing-cards'
  const noCards = await seedAgentFixture(db, { workspaceId, userId: owner, now: FIXED_NOW })
  await db.collection('accounts').doc(noCards.accounts.card).update({ statementClosingDay: null, paymentDueDay: null })
  const noCardTools = buildAgentTools(db, { workspaceId, userId: owner, timeZone: TIME_ZONE, primaryCurrency: 'COP', now: () => FIXED_NOW })
  const outputs = {}
  for (const [key, name, input] of [
    ['month', 'getFinancialSummary', { preset: 'this_month', groupBy: 'category', compareWithPrevious: true, topN: 10 }],
    ['lastMonth', 'getFinancialSummary', { preset: 'last_month', groupBy: 'day' }],
    ['range', 'getFinancialSummary', { startDate: '2026-09-15', endDate: '2026-11-30', groupBy: 'month' }],
    ['averages', 'getFinancialSummary', { lastCompleteMonths: 2, groupBy: 'account', type: 'expense' }],
    ['settings', 'getWorkspaceSettings', {}]
  ]) outputs[key] = await runTool(noCardTools, name, input)
  // Readable totals first, to locate a difference.
  assert.deepEqual(
    Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, value.totals ?? value.currentMonth.totals])),
    {
      month: { income: 5_000_000, expenses: 560_000, net: 4_440_000, savingsRate: 88.8, upcomingInstallments: 0 },
      lastMonth: { income: 4_000_000, expenses: 210_000, net: 3_790_000, savingsRate: 94.8, upcomingInstallments: 0 },
      range: { income: 9_000_000, expenses: 770_000, net: 8_230_000, savingsRate: 91.4, upcomingInstallments: 100_000 },
      averages: { income: 0, expenses: 210_000, net: -210_000, savingsRate: 0, upcomingInstallments: 0 },
      settings: { income: 5_000_000, expenses: 560_000, net: 4_440_000, savingsRate: 88.8, upcomingInstallments: 0 }
    }
  )
  // SHA-256 of the exact JSON of all five outputs, captured at a6c71bc (before the card ledger
  // joined the cash flow): groups, top expenses, comparison, averages, byBudget, budgets and notes.
  assert.equal(createHash('sha256').update(JSON.stringify(outputs)).digest('hex'), 'df4f4b047499ab724f0a13e0048cd755e59b9e3fc4bf3176a62184ec362333f8')
})

/** `db` that records every `where` as "field op", so a test can see which queries a tool ran. */
const recordingQueries = (target, log) => new Proxy(target, {
  get(object, key) {
    const value = object[key]
    if (typeof value !== 'function') return value
    if (key === 'where') return (...args) => { log.push(`${args[0]} ${args[1]}`); return recordingQueries(value.apply(object, args), log) }
    if (['collection', 'doc', 'orderBy', 'limit', 'select'].includes(key)) return (...args) => recordingQueries(value.apply(object, args), log)
    return value.bind(object)
  }
})

test('P1 S8.4: a date-only card expense counts in Consumo budgets and, with a payment, in cash flow; a mirror-card summary reads no card history', async () => {
  const workspaceId = `${ids.workspaceId}-legacy`
  const owner = `${userId}-legacy`
  const id = name => `${workspaceId}-${name}`
  const local = (month, day) => Timestamp.fromDate(zonedWallClockToInstant(2026, month, day, 12, TIME_ZONE))
  const batch = db.batch()
  const set = (collection, docId, data) => batch.set(db.collection(collection).doc(docId), data)
  set('workspaces', workspaceId, {
    name: 'Legacy', ownerId: owner, members: [owner], currency: 'COP',
    categoryBudgets: { [id('food')]: 500_000 }, categoryBudgetCurrency: 'COP', expenseLimit: 1_000_000
  })
  set('categories', id('food'), { workspaceId, userId: owner, name: 'Comida', type: 'expense' })
  const account = (key, data) => set('accounts', id(key), { workspaceId, userId: owner, name: key, currency: 'COP', limit: 0, ...data })
  account('bank', { type: 'checking', balance: 1_000_000 })
  // Closes on the 25th, due on the 5th of the next month. Balance = -100,000 - 70,000 + 120,000.
  account('visa', { type: 'credit', balance: -50_000, statementClosingDay: 25, paymentDueDay: 5 })
  // A shared-expense bridge with billing days: mirrors never bill by statement.
  account('bridge', { type: 'credit', balance: -9_000, statementClosingDay: 20, paymentDueDay: 5, mirror: { workspaceId: 'partner' } })
  const movement = (key, data) => set('transactions', id(key), {
    workspaceId, userId: owner, description: key, categoryId: id('food'), toAccountId: null, installments: 1, currency: 'COP', ...data
  })
  movement('sep', { type: 'expense', amount: -100_000, accountId: id('visa'), date: local(8, 10) })
  // Legacy date-only string: the October cycle, statement due Nov 5.
  movement('legacy', { type: 'expense', amount: -70_000, accountId: id('visa'), date: '2026-10-03' })
  // Oct 8: pays the statement due Oct 5 (100,000) and 20,000 of the one due Nov 5.
  movement('pay', { type: 'transfer', amount: 120_000, accountId: id('bank'), toAccountId: id('visa'), categoryId: '', date: local(9, 8) })
  movement('shared', { type: 'expense', amount: -9_000, accountId: id('bridge'), date: local(9, 7) })
  await batch.commit()

  const log = []
  const legacyTools = buildAgentTools(recordingQueries(db, log), { workspaceId, userId: owner, timeZone: TIME_ZONE, primaryCurrency: 'COP', now: () => FIXED_NOW })
  const settings = await runTool(legacyTools, 'getWorkspaceSettings')
  // Consumo: the date-only purchase counts in its October cycle, plus the bridge expense.
  assert.equal(settings.currentMonth.expenseLimit.spent, 79_000)
  // Cash flow: the statement paid on Oct 8, the 20,000 paid early of the next one and the bridge expense.
  assert.equal(settings.currentMonth.totals.expenses, 129_000)
  assert.equal((await runTool(legacyTools, 'getFinancialSummary', { preset: 'this_month' })).totals.expenses, 129_000)

  // A summary of the bridge never needs the card ledger: same figures as before, no card history read.
  log.length = 0
  const bridge = await runTool(legacyTools, 'getFinancialSummary', { preset: 'this_month', accountId: id('bridge') })
  assert.deepEqual(bridge.totals, { income: 0, expenses: 9_000, net: -9_000, savingsRate: 0, upcomingInstallments: 0 })
  assert.deepEqual(bridge.topExpenses.map(row => [row.id, row.amount, row.date]), [[id('shared'), 9_000, '2026-10-07']])
  assert.deepEqual(bridge.notes, ['Excluye transferencias, préstamos (loan) y pagos de préstamos recibidos (loan_payment): no son gasto ni ingreso.'])
  assert.ok(log.length > 0)
  assert.ok(!log.some(entry => entry.endsWith(' in')), log.join(', '))
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
