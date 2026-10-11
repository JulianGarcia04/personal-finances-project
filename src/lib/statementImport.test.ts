import test from 'node:test'
import assert from 'node:assert/strict'
import { StatementImportBatchSchema } from '../schemas.ts'

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
