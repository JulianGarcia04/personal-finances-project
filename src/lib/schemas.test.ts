import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MONTHLY_BUDGET_ID } from './budgets.ts'
import {
  OperatingBudgetDraftSchema,
  OperatingBudgetPatchSchema,
  OperatingBudgetRecordSchema,
  StoredOperatingBudgetRecordSchema,
  TransactionSchema
} from '../schemas.ts'

const baseTransaction = {
  accountId: 'origin',
  description: 'Movimiento',
  categoryId: 'category',
  date: new Date(),
  toAccountId: null
}

test('TransactionSchema exige montos finitos con signo según el tipo', () => {
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: -100 }).success, true)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'income', amount: 100 }).success, true)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: 100, toAccountId: 'destination' }).success, true)

  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: 100 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'income', amount: -100 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: -100, toAccountId: 'destination' }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'expense', amount: 0 }).success, false)
  assert.equal(TransactionSchema.safeParse({ ...baseTransaction, type: 'transfer', amount: Infinity, toAccountId: 'destination' }).success, false)
})

const fixedDate = (day: number) => new Date(`2025-04-${String(day).padStart(2, '0')}T12:00:00.000Z`)
const monthlyDraft = { kind: 'monthly', name: 'Household', capCurrency: 'USD' }
const eventDraft = { kind: 'event', name: 'Conference', capCurrency: 'EUR' }
const monthlyRecord = {
  id: 'monthly-1', workspaceId: 'workspace-1', ...monthlyDraft,
  archived: false, createdAt: fixedDate(1), updatedAt: fixedDate(2)
}
const eventRecord = {
  id: 'event-1', workspaceId: 'workspace-1', ...eventDraft,
  archived: false, createdAt: fixedDate(1), updatedAt: fixedDate(2)
}

test('Operating budget drafts support monthly and event budgets without requiring an overall cap', () => {
  assert.equal(OperatingBudgetDraftSchema.safeParse(monthlyDraft).success, true)
  assert.equal(OperatingBudgetDraftSchema.safeParse({
    ...eventDraft, totalLimit: 900.25, startDate: fixedDate(10), endDate: fixedDate(12)
  }).success, true)
  assert.equal(OperatingBudgetRecordSchema.safeParse(monthlyRecord).success, true)
  assert.equal(OperatingBudgetRecordSchema.safeParse(eventRecord).success, true)
})

test('Operating budget limits accept zero and fractions but reject negative and non-finite values', () => {
  for (const totalLimit of [0, 0.25]) {
    assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, totalLimit }).success, true)
    assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, totalLimit }).success, true)
  }
  for (const totalLimit of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, totalLimit }).success, false)
    assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, totalLimit }).success, false)
  }
})

test('Operating budget names, currencies, and record identities are validated strictly', () => {
  for (const name of ['', '   ', 'x'.repeat(101)]) {
    assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, name }).success, false)
  }
  for (const capCurrency of ['', '   ', 'usd', 'US', 'USDD', ' U S']) {
    assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, capCurrency }).success, false)
  }
  for (const id of ['', '   ', 'bad/id', '.', '..', '__reserved__', DEFAULT_MONTHLY_BUDGET_ID]) {
    assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, id }).success, false)
  }
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, workspaceId: '' }).success, false)
})

test('Operating budget schemas reject default spoofing and unrelated fields', () => {
  for (const field of ['id', 'workspaceId', 'archived', 'createdAt', 'isDefault', 'categoryCaps']) {
    assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, [field]: 'spoof' }).success, false)
  }
  for (const extra of [
    { isDefault: true }, { categoryCaps: { food: 10 } }, { currency: 'USD' }
  ]) {
    assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, ...extra }).success, false)
  }
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, id: DEFAULT_MONTHLY_BUDGET_ID }).success, false)
})

test('Operating budget records require decoded, valid audit metadata and archive state', () => {
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, archived: 'false' }).success, false)
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, createdAt: '2025-04-01' }).success, false)
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, updatedAt: new Date(Number.NaN) }).success, false)
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, createdAt: undefined }).success, false)
})

test('Planning dates are event-only and chronological without constraining transaction dates', () => {
  assert.equal(OperatingBudgetDraftSchema.safeParse({ ...monthlyDraft, startDate: fixedDate(10) }).success, false)
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...monthlyRecord, endDate: fixedDate(12) }).success, false)
  assert.equal(OperatingBudgetDraftSchema.safeParse({ ...eventDraft, startDate: fixedDate(12), endDate: fixedDate(10) }).success, false)
  assert.equal(OperatingBudgetRecordSchema.safeParse({ ...eventRecord, startDate: fixedDate(10), endDate: fixedDate(10) }).success, true)
})

test('Operating budget patches reject immutable and unknown fields and empty updates', () => {
  for (const field of ['kind', 'capCurrency', 'id', 'workspaceId', 'archived', 'createdAt', 'isDefault', 'categoryCaps']) {
    assert.equal(OperatingBudgetPatchSchema.safeParse({ [field]: 'spoof' }).success, false)
  }
  assert.equal(OperatingBudgetPatchSchema.safeParse({}).success, false)
  assert.equal(OperatingBudgetPatchSchema.safeParse({ unknown: true, name: 'Renamed' }).success, false)
})

test('Operating budget patches use null to clear optional limits and event dates', () => {
  const cleared = OperatingBudgetPatchSchema.safeParse({ totalLimit: null, startDate: null, endDate: null })
  assert.equal(cleared.success, true)
  if (cleared.success) {
    assert.equal(cleared.data.totalLimit, null)
    assert.equal(cleared.data.startDate, null)
    assert.equal(cleared.data.endDate, null)
  }
  const unchanged = OperatingBudgetPatchSchema.safeParse({ name: 'Renamed' })
  assert.equal(unchanged.success, true)
  if (unchanged.success) assert.equal(Object.hasOwn(unchanged.data, 'totalLimit'), false)
})

test('stored budget records drop fields a newer client added instead of failing the load', () => {
  const stored = {
    id: 'viaje', workspaceId: 'ws1', kind: 'event', name: 'Viaje', capCurrency: 'COP', archived: false,
    createdAt: new Date('2026-10-01T12:00:00'), updatedAt: new Date('2026-10-01T12:00:00'),
    fieldFromTheFuture: true
  }
  const parsed = StoredOperatingBudgetRecordSchema.parse(stored)
  assert.equal('fieldFromTheFuture' in parsed, false)
  assert.equal(parsed.name, 'Viaje')
  // Writes stay strict.
  assert.throws(() => OperatingBudgetRecordSchema.parse(stored))
})
