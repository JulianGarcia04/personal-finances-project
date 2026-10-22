import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Category, Transaction } from '../types.ts'
import { filterCategories, findCategoryByName, suggestCategoriesBySpending, visibleBaselineCategories } from './categoryPicker.ts'

const category = (id: string, name: string, type: Category['type'] = 'expense'): Category => ({
  id, name, type, workspaceId: 'w1', icon: 'HelpCircle', color: '#10b981'
})

const expense = (categoryId: string, amount: number, date: Date, type: Transaction['type'] = 'expense'): Transaction => ({
  id: `${categoryId}-${amount}-${date.toISOString()}`,
  workspaceId: 'w1',
  accountId: 'a1',
  amount,
  description: '',
  categoryId,
  date,
  type,
  currency: 'COP',
  createdAt: date
})

const categories = [
  category('food', 'Comida'),
  category('gym', 'Gimnasio'),
  category('edu', 'Educación'),
  category('salary', 'Salario', 'income')
]

test('findCategoryByName matches ignoring case, accents, and surrounding spaces', () => {
  assert.equal(findCategoryByName(categories, '  educacion ')?.id, 'edu')
  assert.equal(findCategoryByName(categories, 'COMIDA')?.id, 'food')
  assert.equal(findCategoryByName(categories, 'Mascotas'), undefined)
  assert.equal(findCategoryByName(categories, '   '), undefined)
})

test('filterCategories returns name matches, excludes selected ids, and lists prefix matches first', () => {
  const pool = [...categories, category('nails', 'Uñas y gimnasia')]
  assert.deepEqual(filterCategories(pool, 'gim', []).map(c => c.id), ['gym', 'nails'])
  assert.deepEqual(filterCategories(pool, 'gim', ['gym']).map(c => c.id), ['nails'])
  assert.deepEqual(filterCategories(pool, 'EDUC', []).map(c => c.id), ['edu'])
})

test('filterCategories with an empty query returns every unselected category sorted by name', () => {
  assert.deepEqual(filterCategories(categories, '', ['food']).map(c => c.id), ['edu', 'gym', 'salary'])
})

test('suggestCategoriesBySpending ranks expense categories by spending in the recent window', () => {
  const now = new Date(2026, 9, 21)
  const transactions = [
    expense('food', 300, new Date(2026, 9, 1)),
    expense('food', 200, new Date(2026, 8, 10)),
    expense('gym', 900, new Date(2026, 7, 15)),
    expense('edu', 5000, new Date(2026, 3, 1)), // outside the 3-month window
    expense('salary', 9999, new Date(2026, 9, 2), 'income'),
    expense('deleted', 700, new Date(2026, 9, 3)) // category no longer exists
  ]
  const result = suggestCategoriesBySpending({
    categories, transactions, now, excludeIds: [], amountOf: tx => Math.abs(tx.amount)
  })
  assert.deepEqual(result.map(c => c.id), ['gym', 'food'])
})

test('suggestCategoriesBySpending skips selected categories and respects the limit', () => {
  const now = new Date(2026, 9, 21)
  const transactions = [
    expense('food', 300, new Date(2026, 9, 1)),
    expense('gym', 900, new Date(2026, 9, 2)),
    expense('edu', 100, new Date(2026, 9, 3))
  ]
  const result = suggestCategoriesBySpending({
    categories, transactions, now, excludeIds: ['gym'], limit: 1, amountOf: tx => tx.amount
  })
  assert.deepEqual(result.map(c => c.id), ['food'])
})

test('baseline shows only categories with a limit, spending this month, or added this session', () => {
  const categories = [
    category('capped', 'Mercado'),
    category('spent', 'Transporte'),
    category('added', 'Mascotas'),
    category('zeroCap', 'Regalos'),
    category('unused', 'Educación')
  ]
  const visible = visibleBaselineCategories({
    categories,
    limits: { capped: 500, zeroCap: 0 },
    spentOf: categoryId => (categoryId === 'spent' ? 120 : 0),
    addedIds: ['added']
  })
  assert.deepEqual(visible.map(entry => entry.id), ['capped', 'spent', 'added'])
})

test('baseline hides every category when none has a limit, spending, or a pending addition', () => {
  const visible = visibleBaselineCategories({
    categories: [category('unused', 'Educación')],
    limits: {},
    spentOf: () => 0,
    addedIds: []
  })
  assert.deepEqual(visible, [])
})
