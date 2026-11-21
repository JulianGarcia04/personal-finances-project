import test from 'node:test'
import assert from 'node:assert/strict'
import { StatementImportBatchSchema } from '../schemas.ts'
import {
  findPotentialDuplicate,
  normalizeParsedStatementRow,
  planTransferDirection,
  resolveStatementImportId
} from './statementImport.ts'

test('statement import schema accepts long descriptions and batches above five hundred rows', () => {
  const description = 'Bank statement detail '.repeat(12)
  const rows = Array.from({ length: 501 }, (_, index) => ({
    date: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    description,
    amount: index % 2 === 0 ? 1 : -1,
    categorySuggestion: 'Other'
  }))

  const parsed = StatementImportBatchSchema.parse(rows)
  assert.equal(parsed.length, 501)
  assert.equal(parsed[0].description.length, description.length)
})

test('statement import schema rejects non-finite, zero, and invalid-date rows before persistence', () => {
  const valid = {
    date: '2026-10-10T12:00:00.000Z',
    description: 'Statement movement',
    amount: 1,
    categorySuggestion: 'Other'
  }
  assert.equal(StatementImportBatchSchema.safeParse([valid]).success, true)
  for (const amount of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(StatementImportBatchSchema.safeParse([{ ...valid, amount }]).success, false)
  }
  assert.equal(StatementImportBatchSchema.safeParse([valid, { ...valid, date: 'invalid' }]).success, false)
})

test('S11: statement import schema supports transfer rows only with a counterpartyAccountId', () => {
  const transferOk = {
    date: '2026-10-10',
    description: 'PAGO TARJETA VISA',
    amount: 500_000,
    categorySuggestion: '',
    type: 'transfer',
    counterpartyAccountId: 'bank-1'
  }
  assert.equal(StatementImportBatchSchema.safeParse([transferOk]).success, true)
  assert.equal(StatementImportBatchSchema.safeParse([{ ...transferOk, counterpartyAccountId: '' }]).success, false)
  assert.equal(StatementImportBatchSchema.safeParse([{ ...transferOk, counterpartyAccountId: null }]).success, false)
})

test('S11: normalizeParsedStatementRow defaults positive credit-card rows to transfer so payments never become fake income', () => {
  const cardPayment = normalizeParsedStatementRow(
    { date: '2026-10-10', description: 'ABONO PSE TARJETA', amount: 1_200_000, categorySuggestion: 'Ingresos' },
    'credit'
  )
  assert.equal(cardPayment.type, 'transfer')
  assert.equal(cardPayment.amount, 1_200_000)

  const cardPurchase = normalizeParsedStatementRow(
    { date: '2026-10-10', description: 'EXITO', amount: -85_000, categorySuggestion: 'Comida' },
    'credit'
  )
  assert.equal(cardPurchase.type, 'expense')
  assert.equal(cardPurchase.amount, -85_000)

  const salary = normalizeParsedStatementRow(
    { date: '2026-10-10', description: 'NOMINA', amount: 5_000_000, categorySuggestion: 'Ingresos' },
    'checking'
  )
  assert.equal(salary.type, 'income')
})

test('S11: planTransferDirection maps positive amount to counterparty->target and negative to target->counterparty', () => {
  assert.deepEqual(planTransferDirection('visa', 'bank', 500_000), {
    accountId: 'bank',
    toAccountId: 'visa',
    amount: 500_000,
    targetDelta: 500_000,
    counterpartyDelta: -500_000
  })
  assert.deepEqual(planTransferDirection('bank', 'visa', -500_000), {
    accountId: 'bank',
    toAccountId: 'visa',
    amount: 500_000,
    targetDelta: -500_000,
    counterpartyDelta: 500_000
  })
})

test('S11: findPotentialDuplicate matches existing account transactions and incoming transfers within 1 day', () => {
  const existing = [
    { id: 'tx-1', accountId: 'visa', toAccountId: null, type: 'expense', amount: -85_000, date: new Date(2026, 9, 10, 12), description: 'Exito' },
    { id: 'tx-2', accountId: 'bank', toAccountId: 'visa', type: 'transfer', amount: 1_200_000, date: new Date(2026, 9, 12, 12), description: 'Pago Visa' }
  ]
  assert.equal(
    findPotentialDuplicate({ date: '2026-10-11', amount: -85_000, type: 'expense', description: 'EXITO SUPERMERCADO' }, 'visa', existing)?.id,
    'tx-1'
  )
  assert.equal(
    findPotentialDuplicate({ date: '2026-10-12', amount: 1_200_000, type: 'transfer', description: 'ABONO PSE TARJETA' }, 'visa', existing)?.id,
    'tx-2'
  )
  assert.equal(
    findPotentialDuplicate({ date: '2026-10-15', amount: -85_000, type: 'expense', description: 'Exito' }, 'visa', existing),
    null
  )
  assert.equal(
    findPotentialDuplicate({ date: '2026-10-10', amount: -90_000, type: 'expense', description: 'Exito' }, 'visa', existing),
    null
  )
})

test('statement import keys are optional but an explicit malformed key is rejected', () => {
  assert.equal(resolveStatementImportId(undefined), null)
  assert.equal(resolveStatementImportId('import_2026-11-21'), 'import_2026-11-21')
  for (const invalid of ['', 'short', 'bad id!', 'x'.repeat(129), 42, null]) {
    assert.throws(
      () => resolveStatementImportId(invalid),
      /El identificador de importación no es válido\./
    )
  }
})
