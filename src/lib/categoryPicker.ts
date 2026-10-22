import type { Category, Transaction } from '../types.ts'

// Comparison key: case-, accent-, and whitespace-insensitive.
export const normalizeCategoryName = (name: string): string =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')

export const findCategoryByName = (categories: Category[], name: string): Category | undefined => {
  const key = normalizeCategoryName(name)
  if (!key) return undefined
  return categories.find(category => normalizeCategoryName(category.name) === key)
}

// Name matches not yet selected; prefix matches first, then alphabetical.
export const filterCategories = (categories: Category[], query: string, excludeIds: string[]): Category[] => {
  const key = normalizeCategoryName(query)
  const excluded = new Set(excludeIds)
  return categories
    .filter(category => !excluded.has(category.id))
    .map(category => ({ category, name: normalizeCategoryName(category.name) }))
    .filter(({ name }) => name.includes(key))
    .sort((left, right) =>
      Number(!left.name.startsWith(key)) - Number(!right.name.startsWith(key)) ||
      left.name.localeCompare(right.name)
    )
    .map(({ category }) => category)
}

// Categories with the most expense spending in the last `months`, excluding selected ones.
export const suggestCategoriesBySpending = ({
  categories, transactions, now, excludeIds, amountOf, months = 3, limit = 5
}: {
  categories: Category[]
  transactions: Transaction[]
  now: Date
  excludeIds: string[]
  amountOf: (transaction: Transaction) => number
  months?: number
  limit?: number
}): Category[] => {
  const since = new Date(now.getFullYear(), now.getMonth() - months, now.getDate())
  const excluded = new Set(excludeIds)
  const byId = new Map(categories.map(category => [category.id, category]))
  const totals = new Map<string, number>()
  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || excluded.has(transaction.categoryId)) continue
    if (!byId.has(transaction.categoryId)) continue
    if (transaction.date < since || transaction.date > now) continue
    const amount = amountOf(transaction)
    if (!Number.isFinite(amount) || amount <= 0) continue
    totals.set(transaction.categoryId, (totals.get(transaction.categoryId) ?? 0) + amount)
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([categoryId]) => byId.get(categoryId)!)
}

// Baseline rows: categories with a positive limit, spending this month, or added this session.
export const visibleBaselineCategories = ({
  categories, limits, spentOf, addedIds
}: {
  categories: Category[]
  limits: Record<string, number | null | undefined>
  spentOf: (categoryId: string) => number
  addedIds: string[]
}): Category[] => {
  const added = new Set(addedIds)
  return categories.filter(category =>
    (limits[category.id] ?? 0) > 0 || spentOf(category.id) > 0 || added.has(category.id)
  )
}
