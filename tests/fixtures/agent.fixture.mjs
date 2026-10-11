// Shared chat-agent fixture for tests/agent.tools.emulator.test.mjs and
// scripts/agent-eval.mjs. Dates are relative to an anchor `now` (local calendar
// of America/Bogota), so the LLM eval can seed it at the real current date while
// the deterministic suite pins `now` to FIXED_NOW.
//
// Contents: COP + USD (rated) + EUR (no rate → 1:1 flagged) accounts, a pocket, a
// credit card with a 3-installment purchase started last month, a transfer into
// the pocket, a loan and a loan payment, a bridge (mirror) expense whose mirror
// leg is a transfer in a partner workspace, income at local midnight on the 1st
// and an expense at UTC midnight on the 1st (previous local day).
//
// The user's currency (COP) intentionally differs from the workspace currency
// (USD): the agent must consolidate in the user's currency like the dashboard.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))
const { zonedDateKey, zonedWallClockToInstant } = requireFunctions('./lib/http.js')
const { Timestamp } = requireFunctions('firebase-admin/firestore')

export const TIME_ZONE = 'America/Bogota'
// Sunday 2026-10-11 15:00 in Bogotá (week Mon 2026-10-05 to Sun 2026-10-11).
export const FIXED_NOW = new Date('2026-10-11T15:00:00-05:00')

export function fixtureIds(workspaceId) {
  const id = name => `${workspaceId}-${name}`
  return {
    workspaceId,
    partnerWorkspaceId: `${workspaceId}-partner`,
    accounts: {
      bank: id('bank'), pocket: id('pocket'), cash: id('cash'), usd: id('usd'),
      card: id('card'), bridge: id('bridge'), eur: id('eur'),
      partnerSource: id('partner-source'), receivable: id('receivable')
    },
    categories: { food: id('food'), tech: id('tech'), salary: id('salary') },
    goal: id('goal-trip'),
    transactions: {
      salary: id('tx-salary'), market: id('tx-market'), usdDinner: id('tx-usd-dinner'), laptop: id('tx-laptop'),
      transfer: id('tx-transfer'), loan: id('tx-loan'), loanPayment: id('tx-loan-payment'),
      bridgeExpense: id('tx-bridge'), bridgeMirror: id('tx-bridge-mirror'),
      lastMonthSalary: id('tx-salary-prev'), lastMonthFood: id('tx-food-prev'), utcMidnight: id('tx-utc-midnight')
    }
  }
}

/** Writes the fixture with the Admin SDK (bypasses rules). Returns the ids. */
export async function seedAgentFixture(db, { workspaceId, userId, now = FIXED_NOW }) {
  const ids = fixtureIds(workspaceId)
  const { accounts: a, categories: c, transactions: t } = ids
  const [year, month, today] = zonedDateKey(now, TIME_ZONE).split('-').map(Number)
  // Local wall clock `monthOffset` months from the anchor month.
  const at = (monthOffset, day, hour) => zonedWallClockToInstant(year, month - 1 + monthOffset, day, hour, TIME_ZONE)
  const batch = db.batch()
  const set = (collection, id, data) => batch.set(db.collection(collection).doc(id), data)
  const createdAt = Timestamp.fromDate(now)

  set('users', userId, {
    email: `${userId}@example.test`, country: 'CO', currency: 'COP',
    activeWorkspaceId: workspaceId, workspaces: [workspaceId]
  })
  set('workspaces', workspaceId, {
    name: 'Casa', ownerId: userId, members: [userId], currency: 'USD',
    exchangeRates: { USD: 4000 },
    categoryBudgets: { [c.food]: 300_000, [c.tech]: 50_000 },
    expenseLimit: 1_000_000,
    budgetIncome: 6_000_000,
    budgetAllocations: { [ids.goal]: 500_000 },
    createdAt
  })
  set('workspaces', ids.partnerWorkspaceId, {
    name: 'Pareja', ownerId: `${userId}-partner`, members: [`${userId}-partner`], currency: 'COP', createdAt
  })

  for (const [key, name, type] of [['food', 'Comida', 'expense'], ['tech', 'Tecnología', 'expense'], ['salary', 'Salario', 'income']]) {
    set('categories', c[key], { workspaceId, userId, name, type, icon: 'tag', color: '#10b981' })
  }
  set('goals', ids.goal, {
    workspaceId, userId, name: 'Viaje a Japón', targetAmount: 3_000_000, currentAmount: 1_000_000, currency: 'COP',
    targetDate: Timestamp.fromDate(at(6, 1, 12)), createdAt
  })

  const account = (id, data, ws = workspaceId) => set('accounts', id, { workspaceId: ws, userId, limit: 0, createdAt, ...data })
  account(a.bank, { name: 'Banco Principal', type: 'checking', balance: 2_000_000, currency: 'COP', childAccountIds: [a.pocket] })
  account(a.pocket, { name: 'Bolsillo Viaje', type: 'savings', balance: 500_000, currency: 'COP', parentAccountId: a.bank, pocketActivity: true })
  account(a.cash, { name: 'Efectivo', type: 'cash', balance: 100_000, currency: 'COP' })
  account(a.usd, { name: 'Cuenta USD', type: 'savings', balance: 1_000, currency: 'USD' })
  account(a.card, { name: 'Visa', type: 'credit', balance: -300_000, limit: 3_000_000, currency: 'COP', statementClosingDay: 25, paymentDueDay: 5 })
  account(a.bridge, {
    name: 'Gastos con Pareja', type: 'checking', balance: -60_000, currency: 'COP',
    mirror: { workspaceId: ids.partnerWorkspaceId, accountId: a.receivable, sourceAccountId: a.partnerSource }
  })
  account(a.eur, { name: 'Euros', type: 'cash', balance: 10, currency: 'EUR' })
  account(a.partnerSource, { name: 'Banco Pareja', type: 'checking', balance: 940_000, currency: 'COP' }, ids.partnerWorkspaceId)
  account(a.receivable, { name: 'Por cobrar', type: 'checking', balance: 60_000, currency: 'COP' }, ids.partnerWorkspaceId)

  const tx = (id, type, amount, date, data = {}, ws = workspaceId) => set('transactions', id, {
    workspaceId: ws, userId, accountId: a.bank, amount, description: id, categoryId: '', date: Timestamp.fromDate(date),
    type, toAccountId: null, receiptUrl: null, notes: null, installments: 1, currency: 'COP', createdAt, ...data
  })
  tx(t.salary, 'income', 5_000_000, at(0, 1, 0), { description: 'Salario', categoryId: c.salary })
  tx(t.market, 'expense', -200_000, at(0, today, 10), { description: 'Mercado Éxito', categoryId: c.food })
  tx(t.usdDinner, 'expense', -50, at(0, 5, 12), { description: 'Cena en Miami', categoryId: c.food, accountId: a.usd, currency: 'USD' })
  tx(t.laptop, 'expense', -300_000, at(-1, 10, 12), { description: 'Portátil', categoryId: c.tech, accountId: a.card, installments: 3 })
  tx(t.transfer, 'transfer', 500_000, at(0, 3, 12), { description: 'Ahorro viaje', toAccountId: a.pocket })
  tx(t.loan, 'loan', -100_000, at(0, 4, 12), { description: 'Préstamo a Juan' })
  tx(t.loanPayment, 'loan_payment', 40_000, at(0, 6, 12), { description: 'Abono de Juan' })
  tx(t.bridgeExpense, 'expense', -60_000, at(0, 2, 12), {
    description: 'Cena compartida', categoryId: c.food, accountId: a.bridge, mirrorOf: t.bridgeMirror
  })
  tx(t.bridgeMirror, 'transfer', 60_000, at(0, 2, 12), {
    description: 'Cena compartida', accountId: a.partnerSource, toAccountId: a.receivable, mirrorOf: t.bridgeExpense
  }, ids.partnerWorkspaceId)
  tx(t.lastMonthSalary, 'income', 4_000_000, at(-1, 15, 12), { description: 'Salario', categoryId: c.salary })
  tx(t.lastMonthFood, 'expense', -80_000, at(-1, 20, 12), { description: 'Restaurante', categoryId: c.food })
  // UTC midnight on the 1st = 19:00 of the previous local day (last month).
  tx(t.utcMidnight, 'expense', -30_000, new Date(Date.UTC(year, month - 1, 1)), { description: 'Domicilio nocturno', categoryId: c.food })

  await batch.commit()
  return ids
}
