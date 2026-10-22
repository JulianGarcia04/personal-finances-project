import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MONTHLY_BUDGET_ID,
  allBudgetsEstimatedMonthlyTotal,
  eventBudgetCommittedAllocation,
  budgetIdForAccount,
  budgetIdToPersist,
  canAssignBudget,
  canCarryBudget,
  linkedAccountConflicts,
  linkedBudgetForAccount,
  monthlyBudgetAllocation,
  resolveBudgetId,
  selfFundedBudgetIds
} from './budgets.ts'
import { createCardBillingLookup } from './installments.ts'

const expense = (overrides: Partial<{
  type: string
  amount: number
  date: Date
  installments: number | null
  budgetId: string | null
  categoryId: string | null
  currency: string
  accountId: string | null
}> = {}) => ({
  type: 'expense',
  amount: -100,
  date: new Date(2026, 0, 10),
  installments: 1,
  categoryId: 'food',
  currency: 'USD',
  ...overrides
})

test('resolves missing and null membership to the protected default and preserves explicit IDs', () => {
  assert.equal(DEFAULT_MONTHLY_BUDGET_ID, 'default-monthly')
  assert.equal(resolveBudgetId(undefined), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(resolveBudgetId(null), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(resolveBudgetId('archived-budget'), 'archived-budget')
})

test('separates event committed principal from monthly installments and legacy default spending', () => {
  const eventPurchase = expense({ amount: -900, installments: 3, budgetId: 'trip', categoryId: 'travel' })
  const legacyPurchase = expense({ amount: -120, categoryId: 'travel' })
  const transactions = [eventPurchase, legacyPurchase]

  assert.deepEqual(monthlyBudgetAllocation(transactions, 'trip', 2026, 0), {
    total: 300,
    byCategory: { travel: 300 }
  })
  assert.deepEqual(monthlyBudgetAllocation(transactions, DEFAULT_MONTHLY_BUDGET_ID, 2026, 0), {
    total: 120,
    byCategory: { travel: 120 }
  })
  assert.deepEqual(eventBudgetCommittedAllocation(transactions, 'trip'), {
    total: 900,
    byCategory: { travel: 900 }
  })
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2026, 0), 420)
})

test('keeps another monthly budget independent and resolves absent membership as default', () => {
  const transactions = [
    expense({ amount: -15, budgetId: 'monthly-a' }),
    expense({ amount: -25, budgetId: 'monthly-b' }),
    expense({ amount: -35, budgetId: null }),
    expense({ amount: -45 })
  ]

  assert.equal(monthlyBudgetAllocation(transactions, 'monthly-a', 2026, 0).total, 15)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly-b', 2026, 0).total, 25)
  assert.equal(monthlyBudgetAllocation(transactions, DEFAULT_MONTHLY_BUDGET_ID, 2026, 0).total, 80)
})

test('reuses calendar-month installment allocation across year boundaries with exact cent rounding', () => {
  const purchase = expense({ amount: -10, installments: 3, date: new Date(2025, 11, 31), budgetId: 'monthly' })
  const transactions = [purchase]

  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2025, 10).total, 0)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2025, 11).total, 3.34)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 0).total, 3.33)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 1).total, 3.33)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 2).total, 0)
})

test('imputes billed card installments to their payment month when a billing lookup is given', () => {
  const billingFor = createCardBillingLookup([
    { id: 'visa', type: 'credit', statementClosingDay: 25, paymentDueDay: 10 },
    { id: 'cash', type: 'cash' }
  ])
  // Closing 25, due 10: a 28 Sep purchase is paid in Nov, Dec and Jan.
  const transactions = [
    expense({ amount: -300, installments: 3, date: new Date(2026, 8, 28), accountId: 'visa', budgetId: 'monthly' }),
    expense({ amount: -50, date: new Date(2026, 8, 28), accountId: 'cash', budgetId: 'monthly' })
  ]

  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 8, undefined, billingFor).total, 50)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 9, undefined, billingFor).total, 0)
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 10, undefined, billingFor).total, 100)
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2027, 0, undefined, billingFor), 100)
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2027, 1, undefined, billingFor), 0)
  // Without the lookup the calendar-month imputation is unchanged.
  assert.equal(monthlyBudgetAllocation(transactions, 'monthly', 2026, 8).total, 150)
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2027, 0), 0)
})

test('counts assigned event bookings regardless of whether their purchase date is early or future', () => {
  const bookings = [
    expense({ amount: -80, date: new Date(2025, 0, 1), budgetId: 'event' }),
    expense({ amount: -120, date: new Date(2028, 0, 1), budgetId: 'event' })
  ]

  assert.deepEqual(eventBudgetCommittedAllocation(bookings, 'event'), {
    total: 200,
    byCategory: { food: 200 }
  })
})

test('excludes transfers, income and loan movements but counts uncategorized expenses overall', () => {
  const transactions = [
    expense({ type: 'transfer', amount: -500 }),
    expense({ type: 'income', amount: 400 }),
    expense({ type: 'loan', amount: -300 }),
    expense({ type: 'loan_payment', amount: 250 }),
    expense({ amount: -25, categoryId: '' })
  ]

  assert.deepEqual(monthlyBudgetAllocation(transactions, DEFAULT_MONTHLY_BUDGET_ID, 2026, 0), {
    total: 25,
    byCategory: {}
  })
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2026, 0), 25)
})

test('global monthly allocations include default, archived, unknown and unassigned expenses', () => {
  const transactions = [
    expense({ amount: -10, budgetId: 'default-monthly' }),
    expense({ amount: -20, budgetId: 'archived-budget', installments: 2 }),
    expense({ amount: -30, budgetId: 'unknown-budget' }),
    expense({ amount: -40 })
  ]

  assert.equal(monthlyBudgetAllocation(transactions, 'archived-budget', 2026, 0).total, 10)
  assert.equal(monthlyBudgetAllocation(transactions, 'unknown-budget', 2026, 0).total, 30)
  assert.equal(monthlyBudgetAllocation(transactions, DEFAULT_MONTHLY_BUDGET_ID, 2026, 0).total, 50)
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2026, 0), 90)
})

test('rolls up prototype-like category IDs as own numeric properties without changing prototypes', () => {
  const categoryAmounts = [
    ['constructor', 11],
    ['toString', 12],
    ['__proto__', 13]
  ] as const
  const transactions = [
    ...categoryAmounts.map(([categoryId, amount]) =>
      expense({ amount: -amount, budgetId: 'event', categoryId })
    ),
    expense({ amount: -4, budgetId: 'event', categoryId: 'constructor' })
  ]
  const expectedCategoryAmounts = [
    ['constructor', 15],
    ['toString', 12],
    ['__proto__', 13]
  ] as const
  const objectPrototypeDescriptors = categoryAmounts.map(([categoryId]) =>
    Object.getOwnPropertyDescriptor(Object.prototype, categoryId)
  )

  const assertSafeBreakdown = (summary: { total: number; byCategory: Record<string, number> }) => {
    assert.equal(summary.total, 40)
    assert.equal(Object.getPrototypeOf(summary.byCategory), Object.prototype)
    for (const [categoryId, amount] of expectedCategoryAmounts) {
      const descriptor = Object.getOwnPropertyDescriptor(summary.byCategory, categoryId)
      assert.ok(descriptor, `${categoryId} should be an own category property`)
      assert.equal(descriptor.value, amount)
      assert.equal(descriptor.get, undefined)
    }
  }

  assertSafeBreakdown(monthlyBudgetAllocation(transactions, 'event', 2026, 0))
  assertSafeBreakdown(eventBudgetCommittedAllocation(transactions, 'event'))
  assert.deepEqual(
    categoryAmounts.map(([categoryId]) => Object.getOwnPropertyDescriptor(Object.prototype, categoryId)),
    objectPrototypeDescriptors
  )
})

test('passes positive amounts to the explicit converter and leaves input transactions unchanged', () => {
  const transactions = [
    expense({ amount: -12.5, budgetId: 'monthly', categoryId: 'food', currency: 'EUR' }),
    expense({ amount: -7.5, budgetId: 'event', categoryId: 'travel', currency: 'USD' })
  ]
  const before = structuredClone(transactions)
  const converted: Array<[number, string]> = []
  const convert = (amount: number, currency: string) => {
    converted.push([amount, currency])
    return amount * (currency === 'EUR' ? 2 : 3)
  }

  assert.deepEqual(monthlyBudgetAllocation(transactions, 'monthly', 2026, 0, convert), {
    total: 25,
    byCategory: { food: 25 }
  })
  assert.equal(allBudgetsEstimatedMonthlyTotal(transactions, 2026, 0, convert), 47.5)
  assert.deepEqual(converted, [[12.5, 'EUR'], [12.5, 'EUR'], [7.5, 'USD']])
  assert.deepEqual(transactions, before)
})

test('only expenses and income can carry a budget', () => {
  assert.deepEqual(
    (['expense', 'income', 'transfer', 'loan', 'loan_payment'] as const).map(canCarryBudget),
    [true, true, false, false, false]
  )
})

const linkedBudgets = [
  { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] },
  { id: 'old', name: 'Viejo', archived: true, linkedAccountIds: ['cash-old'] },
  { id: 'plain', name: 'Sin cuentas', archived: false }
]

test('a movement inherits the active budget its account is linked to, else the default', () => {
  assert.equal(budgetIdForAccount(linkedBudgets, 'cash-casa'), 'casa')
  assert.equal(budgetIdForAccount(linkedBudgets, 'cash-old'), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(budgetIdForAccount(linkedBudgets, 'unlinked'), DEFAULT_MONTHLY_BUDGET_ID)
  assert.equal(budgetIdForAccount(linkedBudgets, ''), DEFAULT_MONTHLY_BUDGET_ID)
})

test('reports accounts already linked to another active budget', () => {
  assert.deepEqual(linkedAccountConflicts(linkedBudgets, ['cash-casa', 'cash-old', 'free']), [
    { accountId: 'cash-casa', budgetId: 'casa', budgetName: 'Casa' }
  ])
  assert.deepEqual(linkedAccountConflicts(linkedBudgets, ['cash-casa'], 'casa'), [])
})

test('a movement saved under the default budget stores no explicit reference', () => {
  assert.equal(budgetIdToPersist('expense', DEFAULT_MONTHLY_BUDGET_ID), null)
  assert.equal(budgetIdToPersist('income', 'casa'), 'casa')
  assert.equal(budgetIdToPersist('transfer', 'casa'), null)
  assert.equal(budgetIdToPersist('expense', ''), null)
})

test('a budget is self-funded once any income is assigned to it', () => {
  const funded = selfFundedBudgetIds([
    { type: 'income', budgetId: 'ventas-casa' },
    { type: 'income', budgetId: DEFAULT_MONTHLY_BUDGET_ID },
    { type: 'income' },
    { type: 'expense', budgetId: 'hogar' }
  ])
  assert.deepEqual([...funded], ['ventas-casa'])
})

test('a movement of a linked account can only go to that account\'s budget', () => {
  const budgets = [
    { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] },
    { id: 'viaje', name: 'Viaje', archived: true, linkedAccountIds: ['cash-viaje'] }
  ]
  assert.equal(linkedBudgetForAccount(budgets, 'cash-casa')?.id, 'casa')
  // Archiving the budget frees its accounts.
  assert.equal(linkedBudgetForAccount(budgets, 'cash-viaje'), null)
  assert.equal(canAssignBudget(budgets, 'cash-casa', 'casa'), true)
  assert.equal(canAssignBudget(budgets, 'cash-casa', DEFAULT_MONTHLY_BUDGET_ID), false)
  assert.equal(canAssignBudget(budgets, 'cash-casa', 'other'), false)
  assert.equal(canAssignBudget(budgets, 'bank', 'casa'), true)
  assert.equal(canAssignBudget(budgets, '', DEFAULT_MONTHLY_BUDGET_ID), true)
})
