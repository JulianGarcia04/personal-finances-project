import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Transaction } from '../types.ts'
import { DEFAULT_MONTHLY_BUDGET_ID } from './budgets.ts'
import {
  BULK_EDIT_BATCH_LIMIT,
  bulkCategoryType,
  chunkBulkEditUpdates,
  describeBulkEditOutcome,
  describeBulkEditPlan,
  planBulkTransactionEdit,
  type BulkEditContext,
  type BulkEditRequest
} from './bulkTransactionEdit.ts'

const row = (id: string, extra: Partial<Transaction> = {}): Transaction => ({
  id, workspaceId: 'ws-1', userId: 'user-1', accountId: 'bank', amount: -100, description: id,
  categoryId: 'food', date: new Date(2026, 10, 15, 12), type: 'expense', currency: 'COP',
  createdAt: new Date(2026, 10, 15), ...extra
})

const context = (extra: Partial<BulkEditContext> = {}): BulkEditContext => ({
  workspaceId: 'ws-1',
  accounts: [{ id: 'bank' }, { id: 'bridge' }, { id: 'pocket' }, { id: 'linked' }, { id: 'card' }],
  loadedAccountsWorkspaceId: 'ws-1',
  budgets: [
    { id: 'viaje', name: 'Viaje', archived: false },
    { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['linked'] },
    { id: 'viejo', name: 'Viejo', archived: true }
  ],
  categories: [
    { id: 'food', type: 'expense' }, { id: 'transport', type: 'expense' }, { id: 'salary', type: 'income' },
    { id: 'other', type: 'both' }
  ],
  ...extra
})

const plan = (rows: Transaction[], request: BulkEditRequest, extra: Partial<BulkEditContext> = {}, ids = rows.map(tx => tx.id)) =>
  planBulkTransactionEdit(request, ids, rows, context(extra))

const reasons = (result: ReturnType<typeof plan>) => Object.fromEntries(result.skipped.map(skip => [skip.id, skip.reason]))

test('S9: a budget change writes only budgetId, storing the base monthly budget as null', () => {
  const rows = [
    row('expense'), row('income', { type: 'income', amount: 100, categoryId: 'salary' }),
    row('in-trip', { budgetId: 'viaje' }), row('literal-default', { budgetId: DEFAULT_MONTHLY_BUDGET_ID })
  ]
  assert.deepEqual(plan(rows, { budgetId: 'viaje' }).updates, [
    { id: 'expense', type: 'expense', patch: { budgetId: 'viaje' } },
    { id: 'income', type: 'income', patch: { budgetId: 'viaje' } },
    { id: 'literal-default', type: 'expense', patch: { budgetId: 'viaje' } }
  ])
  assert.deepEqual(plan(rows, { budgetId: DEFAULT_MONTHLY_BUDGET_ID }).updates, [
    { id: 'in-trip', type: 'expense', patch: { budgetId: null } }
  ])
})

test('S9: a category change writes only categoryId; both together write only the fields that change', () => {
  const rows = [row('a'), row('b', { categoryId: 'transport' }), row('c', { budgetId: 'viaje' })]
  assert.deepEqual(plan(rows, { categoryId: 'transport' }).updates.map(update => [update.id, update.patch]), [
    ['a', { categoryId: 'transport' }], ['c', { categoryId: 'transport' }]
  ])
  assert.deepEqual(plan(rows, { categoryId: 'transport', budgetId: 'viaje' }).updates.map(update => [update.id, update.patch]), [
    ['a', { categoryId: 'transport', budgetId: 'viaje' }],
    ['b', { budgetId: 'viaje' }],
    ['c', { categoryId: 'transport' }]
  ])
  assert.deepEqual(reasons(plan(rows, { categoryId: 'transport', budgetId: 'viaje' })), {})
})

test('S9: rows that already have the requested values are skipped as unchanged', () => {
  const rows = [row('same', { categoryId: 'transport', budgetId: 'viaje' }), row('base'), row('null-base', { budgetId: null })]
  assert.deepEqual(reasons(plan(rows, { categoryId: 'transport', budgetId: 'viaje' })), { same: 'unchanged' })
  assert.deepEqual(plan(rows, { categoryId: 'transport', budgetId: 'viaje' }).updates.map(update => update.id), ['base', 'null-base'])
  assert.deepEqual(reasons(plan(rows, { budgetId: DEFAULT_MONTHLY_BUDGET_ID })), { base: 'unchanged', 'null-base': 'unchanged' })
})

test('S9: transfers, loans and loan payments cannot take a budget', () => {
  const rows = [
    row('transfer', { type: 'transfer', amount: 50, toAccountId: 'card', categoryId: '' }),
    row('loan', { type: 'loan', categoryId: '' }),
    row('loan-payment', { type: 'loan_payment', amount: 30, categoryId: '' }),
    row('expense')
  ]
  const result = plan(rows, { budgetId: 'viaje' })
  assert.deepEqual(reasons(result), { transfer: 'no-budget-type', loan: 'no-budget-type', 'loan-payment': 'no-budget-type' })
  assert.deepEqual(result.updates.map(update => update.id), ['expense'])
})

test('S9: a linked account keeps its budget; moving its movement into that budget is allowed', () => {
  const rows = [row('linked-in-casa', { accountId: 'linked', budgetId: 'casa' }), row('linked-legacy', { accountId: 'linked' })]
  assert.deepEqual(reasons(plan(rows, { budgetId: 'viaje' })), { 'linked-in-casa': 'linked-account', 'linked-legacy': 'linked-account' })
  assert.deepEqual(reasons(plan(rows, { budgetId: DEFAULT_MONTHLY_BUDGET_ID })), { 'linked-in-casa': 'linked-account', 'linked-legacy': 'linked-account' })
  const intoCasa = plan(rows, { budgetId: 'casa' })
  assert.deepEqual(intoCasa.updates, [{ id: 'linked-legacy', type: 'expense', patch: { budgetId: 'casa' } }])
  assert.deepEqual(reasons(intoCasa), { 'linked-in-casa': 'unchanged' })
  // A category change alone is fine on a linked account; with a refused budget the whole row is skipped.
  assert.deepEqual(plan(rows, { categoryId: 'transport' }).updates.map(update => update.id), ['linked-in-casa', 'linked-legacy'])
  assert.deepEqual(reasons(plan(rows, { categoryId: 'transport', budgetId: 'viaje' })), { 'linked-in-casa': 'linked-account', 'linked-legacy': 'linked-account' })
})

test('S9: settlements and their reversals are locked', () => {
  const rows = [
    row('settlement', { type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', mirrorOf: 'twin-1', settlementType: 'settlement' }),
    row('legacy-settlement', {
      type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', mirrorOf: 'twin-2',
      description: 'Liquidación de Casa', notes: 'Reembolso pagado desde Banco'
    }),
    row('reversed', { type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', mirrorOf: 'twin-3', reversedBy: 'rev' }),
    row('reversal', { type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', mirrorOf: 'twin-4', settlementType: 'reversal', reversalOf: 'x' })
  ]
  assert.deepEqual(reasons(plan(rows, { budgetId: 'viaje' })), {
    settlement: 'locked-settlement', 'legacy-settlement': 'locked-settlement', reversed: 'locked-settlement', reversal: 'locked-settlement'
  })
})

test('S9: the transfer twin of a shared expense cannot take a budget, while its expense leg can', () => {
  const rows = [
    row('twin-transfer', { type: 'transfer', amount: 30, accountId: 'card', toAccountId: 'bank', categoryId: '', mirrorOf: 'leg' }),
    row('bridge-expense', { accountId: 'bridge', mirrorOf: 'other-twin' })
  ]
  const result = plan(rows, { budgetId: 'viaje' })
  assert.deepEqual(reasons(result), { 'twin-transfer': 'mirror-transfer' })
  assert.deepEqual(result.updates, [{ id: 'bridge-expense', type: 'expense', patch: { budgetId: 'viaje' } }])
  // Category and budget live only on the expense leg, so it changes alone (the twin carries neither).
  assert.deepEqual(plan([rows[1]], { categoryId: 'transport', budgetId: 'viaje' }).updates, [
    { id: 'bridge-expense', type: 'expense', patch: { categoryId: 'transport', budgetId: 'viaje' } }
  ])
})

test('S9: pocket movements take a category or budget like any expense or income', () => {
  const pocketExpense = row('pocket-expense', { accountId: 'pocket' })
  assert.deepEqual(plan([pocketExpense], { categoryId: 'transport', budgetId: 'viaje' }).updates, [
    { id: 'pocket-expense', type: 'expense', patch: { categoryId: 'transport', budgetId: 'viaje' } }
  ])
})

test('S9: rows from a deleted account are skipped once that workspace\'s accounts are loaded', () => {
  const rows = [row('orphan', { accountId: 'deleted' }), row('orphan-transfer-destination', {
    type: 'transfer', amount: 10, toAccountId: 'deleted-too', categoryId: ''
  }), row('ok')]
  assert.deepEqual(reasons(plan(rows, { budgetId: 'viaje' })), {
    orphan: 'deleted-account', 'orphan-transfer-destination': 'deleted-account'
  })
  assert.deepEqual(reasons(plan([rows[0]], { categoryId: 'transport' })), { orphan: 'deleted-account' })
})

test('S9: rows that are gone or belong to another workspace are unavailable', () => {
  const rows = [row('elsewhere', { workspaceId: 'ws-0' }), row('ok')]
  const result = plan(rows, { budgetId: 'viaje' }, {}, ['elsewhere', 'missing', 'ok'])
  assert.deepEqual(reasons(result), { elsewhere: 'unavailable', missing: 'unavailable' })
  assert.deepEqual(result.updates.map(update => update.id), ['ok'])
})

test('S9: a category change keeps a row whose budget no longer exists only if the budget changes too', () => {
  // The rules refuse any non-budget edit that keeps a reference to a missing or foreign budget.
  const rows = [row('stale', { budgetId: 'deleted-budget' }), row('archived', { budgetId: 'viejo' })]
  assert.deepEqual(reasons(plan(rows, { categoryId: 'transport' })), { stale: 'stale-budget' })
  assert.deepEqual(plan(rows, { categoryId: 'transport' }).updates.map(update => update.id), ['archived'])
  assert.deepEqual(plan(rows, { categoryId: 'transport', budgetId: 'viaje' }).updates.map(update => [update.id, update.patch]), [
    ['stale', { categoryId: 'transport', budgetId: 'viaje' }], ['archived', { categoryId: 'transport', budgetId: 'viaje' }]
  ])
  assert.deepEqual(plan(rows, { budgetId: DEFAULT_MONTHLY_BUDGET_ID }).updates.map(update => [update.id, update.patch]), [
    ['stale', { budgetId: null }], ['archived', { budgetId: null }]
  ])
})

test('S9: one mixed selection skips each row for its own reason and changes every other row', () => {
  const rows = [
    row('ok'), row('elsewhere', { workspaceId: 'ws-0' }),
    row('settlement', { type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', mirrorOf: 'twin-1', settlementType: 'settlement' }),
    row('reversed', { type: 'transfer', amount: 40, toAccountId: 'card', categoryId: '', reversedBy: 'rev' }),
    row('orphan', { accountId: 'deleted' }),
    row('twin', { type: 'transfer', amount: 30, accountId: 'card', toAccountId: 'bank', categoryId: '', mirrorOf: 'leg' }),
    row('loan', { type: 'loan', categoryId: '' }), row('transfer', { type: 'transfer', amount: 10, toAccountId: 'card', categoryId: '' }),
    row('linked-in-casa', { accountId: 'linked', budgetId: 'casa' }), row('linked-legacy', { accountId: 'linked' }),
    row('stale', { budgetId: 'deleted-budget' }), row('archived', { budgetId: 'viejo' }),
    row('same', { budgetId: 'viaje', categoryId: 'transport' }), row('literal', { budgetId: DEFAULT_MONTHLY_BUDGET_ID }),
    row('null', { budgetId: null }), row('income', { type: 'income', amount: 100, categoryId: 'salary' }),
    row('in-archived-link', { accountId: 'pocket' })
  ]
  // An archived budget no longer holds the accounts it linked.
  const withArchivedLink = {
    budgets: [...context().budgets, { id: 'cerrado', name: 'Cerrado', archived: true, linkedAccountIds: ['pocket'] }]
  }
  const ids = [...rows.map(tx => tx.id), 'missing']

  const intoTrip = plan(rows, { budgetId: 'viaje' }, withArchivedLink, ids)
  assert.deepEqual(reasons(intoTrip), {
    elsewhere: 'unavailable', missing: 'unavailable', settlement: 'locked-settlement', reversed: 'locked-settlement',
    orphan: 'deleted-account', twin: 'mirror-transfer', loan: 'no-budget-type', transfer: 'no-budget-type',
    'linked-in-casa': 'linked-account', 'linked-legacy': 'linked-account', same: 'unchanged'
  })
  assert.deepEqual(intoTrip.updates.map(update => [update.id, update.patch]), [
    'ok', 'stale', 'archived', 'literal', 'null', 'income', 'in-archived-link'
  ].map(id => [id, { budgetId: 'viaje' }]))

  // Back to the base: absent, null and the literal default are already there; the order of the selection is kept.
  const intoBase = plan(rows, { budgetId: DEFAULT_MONTHLY_BUDGET_ID }, withArchivedLink, ['ok', 'literal', 'null', 'same', 'archived', 'stale', 'linked-in-casa'])
  assert.deepEqual(intoBase.updates.map(update => [update.id, update.patch]), [
    ['same', { budgetId: null }], ['archived', { budgetId: null }], ['stale', { budgetId: null }]
  ])
  assert.deepEqual(intoBase.skipped, [
    { id: 'ok', reason: 'unchanged' }, { id: 'literal', reason: 'unchanged' }, { id: 'null', reason: 'unchanged' },
    { id: 'linked-in-casa', reason: 'linked-account' }
  ])

  // A category alone: the stale budget blocks its row, while archived references and linked accounts do not.
  const recategorized = plan(rows, { categoryId: 'transport' }, withArchivedLink,
    ['ok', 'stale', 'archived', 'linked-in-casa', 'linked-legacy', 'same', 'orphan', 'in-archived-link'])
  assert.deepEqual(reasons(recategorized), { stale: 'stale-budget', same: 'unchanged', orphan: 'deleted-account' })
  assert.deepEqual(recategorized.updates.map(update => [update.id, update.patch]), [
    'ok', 'archived', 'linked-in-casa', 'linked-legacy', 'in-archived-link'
  ].map(id => [id, { categoryId: 'transport' }]))
})

test('S9: a category change needs a selection of a single type, expense or income', () => {
  const expense = row('expense')
  const income = row('income', { type: 'income', amount: 100, categoryId: 'salary' })
  const transfer = row('transfer', { type: 'transfer', amount: 10, toAccountId: 'card', categoryId: '' })
  assert.equal(bulkCategoryType([expense, row('expense-2')]), 'expense')
  assert.equal(bulkCategoryType([income]), 'income')
  assert.equal(bulkCategoryType([expense, income]), null)
  assert.equal(bulkCategoryType([expense, transfer]), null)
  assert.equal(bulkCategoryType([transfer]), null)
  assert.equal(bulkCategoryType([]), null)

  assert.throws(() => plan([expense, income], { categoryId: 'other' }), /selecciona solo gastos o solo ingresos/)
  assert.throws(() => plan([expense, transfer], { categoryId: 'food' }), /selecciona solo gastos o solo ingresos/)
  // Rows that are gone or belong to another workspace give the selection no type.
  assert.throws(() => plan([row('elsewhere', { workspaceId: 'ws-0' })], { categoryId: 'food' }), /selecciona solo gastos o solo ingresos/)
  assert.throws(() => plan([expense], { categoryId: 'food' }, {}, ['missing']), /selecciona solo gastos o solo ingresos/)
  // A budget change does not need a single type.
  assert.equal(plan([expense, income, transfer], { budgetId: 'viaje' }).updates.length, 2)
})

test('S9: the category must exist and fit the selection type ("both" fits either)', () => {
  const incomes = [row('income', { type: 'income', amount: 100, categoryId: 'salary' })]
  assert.throws(() => plan(incomes, { categoryId: 'food' }), /La categoría elegida ya no está disponible/)
  assert.throws(() => plan(incomes, { categoryId: 'missing' }), /La categoría elegida ya no está disponible/)
  assert.deepEqual(plan(incomes, { categoryId: 'other' }).updates[0].patch, { categoryId: 'other' })
  assert.deepEqual(plan([row('expense')], { categoryId: 'other' }).updates[0].patch, { categoryId: 'other' })
})

test('S9: only the base monthly budget or an active budget of the workspace can be chosen', () => {
  for (const budgetId of ['viejo', 'otro-workspace', '']) {
    assert.throws(() => plan([row('a')], { budgetId }), /El presupuesto elegido ya no está disponible/, budgetId)
  }
  assert.throws(() => plan([row('a')], {}), /Elige una categoría o un presupuesto/)
})

test('S9: updates are split into write batches of at most 500', () => {
  assert.equal(BULK_EDIT_BATCH_LIMIT, 500)
  const updates = Array.from({ length: 1001 }, (_, index) => ({ id: `tx-${index}`, type: 'expense' as const, patch: { budgetId: 'viaje' } }))
  assert.deepEqual(chunkBulkEditUpdates(updates).map(chunk => chunk.length), [500, 500, 1])
  assert.deepEqual(chunkBulkEditUpdates(updates.slice(0, 500)).map(chunk => chunk.length), [500])
  assert.deepEqual(chunkBulkEditUpdates([]), [])
})

test('S9: the confirmation says how many will change and how many are skipped, and why', () => {
  const rows = [
    row('a'), row('b'), row('c'),
    row('transfer', { type: 'transfer', amount: 10, toAccountId: 'card', categoryId: '' }),
    row('linked', { accountId: 'linked', budgetId: 'casa' }),
    row('loan', { type: 'loan', categoryId: '' })
  ]
  assert.equal(
    describeBulkEditPlan(plan(rows, { budgetId: 'viaje' })),
    '3 movimientos cambiarán. 3 se omitirán: 2 son transferencias o préstamos, que no llevan presupuesto; 1 es de una cuenta ligada a otro presupuesto.'
  )
  assert.equal(describeBulkEditPlan(plan([row('a')], { budgetId: 'viaje' })), '1 movimiento cambiará.')
  assert.equal(
    describeBulkEditPlan(plan([row('a', { budgetId: 'viaje' }), row('orphan', { accountId: 'deleted' })], { budgetId: 'viaje' })),
    'Ningún movimiento cambiará. 2 se omitirán: 1 ya tenía ese valor; 1 es de una cuenta eliminada.'
  )
  for (const [reason, rowsOf] of [
    ['unavailable', [row('elsewhere', { workspaceId: 'ws-0' })]],
    ['locked-settlement', [row('s', { type: 'transfer', amount: 4, toAccountId: 'card', categoryId: '', mirrorOf: 't', settlementType: 'settlement' })]],
    ['mirror-transfer', [row('m', { type: 'transfer', amount: 4, toAccountId: 'card', categoryId: '', mirrorOf: 't' })]],
    ['stale-budget', [row('stale', { budgetId: 'deleted-budget' })]]
  ] as const) {
    const request = reason === 'stale-budget' ? { categoryId: 'transport' } : { budgetId: 'viaje' }
    const text = describeBulkEditPlan(plan([...rowsOf], request))
    assert.match(text, /^Ningún movimiento cambiará\. 1 se omitirá: 1 /, reason)
  }
  assert.match(describeBulkEditPlan(plan([row('s', { type: 'transfer', amount: 4, toAccountId: 'card', categoryId: '', mirrorOf: 't', settlementType: 'settlement' })], { budgetId: 'viaje' })), /liquidación o reversión/)
  assert.match(describeBulkEditPlan(plan([row('m', { type: 'transfer', amount: 4, toAccountId: 'card', categoryId: '', mirrorOf: 't' })], { budgetId: 'viaje' })), /transferencia de un gasto compartido/)
  assert.match(describeBulkEditPlan(plan([row('stale', { budgetId: 'deleted-budget' })], { categoryId: 'transport' })), /presupuesto que ya no existe/)
})

test('S9: the result message reports updates, skipped rows and failed writes', () => {
  assert.equal(describeBulkEditOutcome({ planned: 3, written: 3, skipped: 0 }), 'Se actualizaron 3 movimientos.')
  assert.equal(describeBulkEditOutcome({ planned: 1, written: 1, skipped: 2 }), 'Se actualizó 1 movimiento. 2 se omitieron.')
  assert.equal(describeBulkEditOutcome({ planned: 2, written: 2, skipped: 1 }), 'Se actualizaron 2 movimientos. 1 se omitió.')
  assert.equal(
    describeBulkEditOutcome({ planned: 600, written: 500, skipped: 0 }),
    'Se actualizaron 500 de 600 movimientos. No se pudieron guardar 100; siguen seleccionados para que lo intentes de nuevo.'
  )
  assert.equal(
    describeBulkEditOutcome({ planned: 1, written: 0, skipped: 0 }),
    'No se pudo guardar 1 movimiento; sigue seleccionado para que lo intentes de nuevo.'
  )
  assert.equal(
    describeBulkEditOutcome({ planned: 4, written: 0, skipped: 0 }),
    'No se pudieron guardar 4 movimientos; siguen seleccionados para que lo intentes de nuevo.'
  )
})
