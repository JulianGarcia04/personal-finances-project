import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { DEFAULT_MONTHLY_BUDGET_ID, budgetChangeForEdit, canAssignBudget, canCarryBudget, resolveBudgetId } from '../lib/budgets.ts'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'

const componentSource = readFileSync(new URL('./Transactions.vue', import.meta.url), 'utf8')
const templateEnd = componentSource.indexOf('<script setup lang="ts">')
const script = componentSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(templateEnd >= 0 && script, 'Transactions must keep a TypeScript setup script')
const template = componentSource.slice(0, templateEnd)
const sourceFile = ts.createSourceFile('Transactions.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const variableInitializer = (name: string): ts.Expression | undefined => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer
    }
  }
  return undefined
}

const evaluateComponentFunction = <Result>(name: string, dependencies: Record<string, unknown>): Result => {
  const initializer = variableInitializer(name)
  assert.ok(initializer && ts.isArrowFunction(initializer), `Transactions must define ${name} as an arrow function`)
  const javascript = ts.transpile(initializer.getText(sourceFile), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None
  })
  const dependencyNames = Object.keys(dependencies)
  const dependencyValues = Object.values(dependencies)
  const evaluate = new Function(...dependencyNames, `return ${javascript}`) as (...args: unknown[]) => Result
  return evaluate(...dependencyValues)
}

type TestBudget = { id: string; name: string; archived: boolean; linkedAccountIds?: string[] }

const assignmentOptions = (
  operatingBudgets: Array<{ budget: TestBudget }>,
  currentBudgetId?: string | null,
  accountId?: string
) => evaluateComponentFunction<(currentBudgetId?: string | null, accountId?: string) => Array<{ id: string; label: string; archived: boolean }>>(
  'budgetOptionsForExpense',
  {
    goalsStore: { operatingBudgets },
    linkableBudgets: { value: operatingBudgets.map(({ budget }) => budget) },
    DEFAULT_MONTHLY_BUDGET_ID,
    resolveBudgetId,
    canAssignBudget
  }
)(currentBudgetId, accountId)

test('renders reassignment only for existing expenses and income on desktop rows, mobile cards, and the edit modal', () => {
  const markers = [...template.matchAll(/data-testid="budget-assignment-(row|card|edit)"/g)]
    .map(match => match[1])
    .sort()
  assert.deepEqual(markers, ['card', 'edit', 'row'])
  assert.match(template, /v-if="canCarryBudget\(tx\.type\)"[\s\S]{0,500}data-testid="budget-assignment-row"/)
  assert.match(template, /v-if="canCarryBudget\(tx\.type\)"[\s\S]{0,500}data-testid="budget-assignment-card"/)
  assert.equal(/v-if="canCarryBudget\(editingOriginalType\) && editTx\.type === editingOriginalType"[\s\S]{0,500}data-testid="budget-assignment-edit"/.test(template), true, 'edit budget selector must require a persisted expense or income with an unchanged draft type')
  assert.equal(/editingOriginalType\.value = tx\.type/.test(script), true, 'openEditModal must record the persisted transaction type')
  assert.match(template, /data-testid="budget-assignment-row"[\s\S]{0,500}@change="handleBudgetAssignmentChange\(tx, \$event\)"/)
  assert.match(template, /data-testid="budget-assignment-card"[\s\S]{0,500}@change="handleBudgetAssignmentChange\(tx, \$event\)"/)
  assert.match(template, /data-testid="budget-assignment-edit"[\s\S]{0,500}v-model="editBudgetId"/)
  assert.match(template, /data-testid="budget-assignment-apply"[\s\S]{0,200}@click="applyEditBudgetAssignment"/)
  assert.equal(/<label class="sr-only">\s*Presupuesto asignado\s*<select/.test(template), false, 'inline budget selectors must not be clipped by sr-only labels')
  assert.equal(/<label class="sr-only" :for="`budget-assignment-row-\$\{tx\.id\}`">Presupuesto asignado<\/label>\s*<select[\s\S]{0,160}:id="`budget-assignment-row-\$\{tx\.id\}`"/.test(template), true, 'row budget selector must have a separate associated label')
  assert.equal(/<label class="sr-only" :for="`budget-assignment-card-\$\{tx\.id\}`">Presupuesto asignado<\/label>\s*<select[\s\S]{0,160}:id="`budget-assignment-card-\$\{tx\.id\}`"/.test(template), true, 'card budget selector must have a separate associated label')

  const addModalStart = template.indexOf(':open="showAddModal"')
  const editModalStart = template.indexOf('<!-- Edit Transaction Modal -->')
  assert.ok(addModalStart >= 0 && editModalStart > addModalStart, 'create and edit modals must remain distinct')
  assert.doesNotMatch(template.slice(addModalStart, editModalStart), /data-testid="budget-assignment-/)
})

test('offers the default and active budgets, retaining only an already assigned archived budget', () => {
  const operatingBudgets = [
    { budget: { id: 'default-monthly', name: 'Duplicate default', archived: false } },
    { budget: { id: 'active-monthly', name: 'Monthly', archived: false } },
    { budget: { id: 'current-archived', name: 'Archived event', archived: true } },
    { budget: { id: 'other-archived', name: 'Other archived', archived: true } }
  ]

  assert.deepEqual(assignmentOptions(operatingBudgets, 'current-archived'), [
    { id: 'default-monthly', label: 'Presupuesto mensual predeterminado', archived: false },
    { id: 'active-monthly', label: 'Monthly', archived: false },
    { id: 'current-archived', label: 'Archived event', archived: true }
  ])
  assert.deepEqual(assignmentOptions(operatingBudgets), [
    { id: 'default-monthly', label: 'Presupuesto mensual predeterminado', archived: false },
    { id: 'active-monthly', label: 'Monthly', archived: false }
  ])
})

test('uses the B3 budget-only action for expenses and income, suppressing transfers, no-ops, and duplicate in-flight writes', async () => {
  const calls: Array<[string, string]> = []
  let financialWrites = 0
  const pendingIds = new Set<string>(['pending-expense'])
  const budgetSettingsReady = { value: true }
  const assignBudget = evaluateComponentFunction<(
    transaction: { id: string; type: string; budgetId?: string | null },
    budgetId: string
  ) => Promise<boolean>>('assignBudgetToExpense', {
    transactionsStore: {
      assignExpenseBudget: async (transactionId: string, budgetId: string) => { calls.push([transactionId, budgetId]) },
      updateTransaction: async () => { financialWrites += 1 }
    },
    assigningBudgetIds: { value: pendingIds },
    budgetSettingsReady,
    resolveBudgetId,
    canCarryBudget,
    canAssignBudget,
    linkableBudgets: { value: [{ id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] }] },
    alert: () => undefined
  })

  assert.equal(await assignBudget({ id: 'expense-1', type: 'expense', budgetId: null }, 'event-1'), true)
  assert.equal(await assignBudget({ id: 'income-1', type: 'income' }, 'event-1'), true)
  assert.deepEqual(calls, [['expense-1', 'event-1'], ['income-1', 'event-1']])
  assert.equal(await assignBudget({ id: 'transfer-1', type: 'transfer' }, 'event-1'), false)
  assert.equal(await assignBudget({ id: 'default-1', type: 'expense' }, DEFAULT_MONTHLY_BUDGET_ID), false)
  assert.equal(await assignBudget({ id: 'pending-expense', type: 'expense' }, 'event-1'), false)
  assert.deepEqual(calls, [['expense-1', 'event-1'], ['income-1', 'event-1']])
  assert.equal(financialWrites, 0)

  // A linked account's movement can only move to that account's budget.
  assert.equal(await assignBudget({ id: 'linked-1', type: 'expense', accountId: 'cash-casa', budgetId: 'casa' } as never, DEFAULT_MONTHLY_BUDGET_ID), false)
  assert.equal(await assignBudget({ id: 'linked-2', type: 'income', accountId: 'cash-casa' } as never, 'event-1'), false)
  assert.equal(await assignBudget({ id: 'linked-3', type: 'expense', accountId: 'cash-casa' } as never, 'casa'), true)
  assert.deepEqual(calls.at(-1), ['linked-3', 'casa'])

  budgetSettingsReady.value = false
  assert.equal(await assignBudget({ id: 'unready-expense', type: 'expense' }, 'event-1'), false)
  assert.equal(calls.length, 3)
})

test('a linked account\'s movements only offer that account\'s budget', () => {
  const operatingBudgets = [
    { budget: { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] } },
    { budget: { id: 'viaje', name: 'Viaje', archived: false } }
  ]
  // A movement still in another budget can move to the linked budget only.
  assert.deepEqual(assignmentOptions(operatingBudgets, null, 'cash-casa').map(option => option.id), ['default-monthly', 'casa'])
  assert.deepEqual(assignmentOptions(operatingBudgets, 'casa', 'cash-casa').map(option => option.id), ['casa'])
  assert.deepEqual(assignmentOptions(operatingBudgets, null, 'bank').map(option => option.id), ['default-monthly', 'casa', 'viaje'])
  assert.match(template, /:disabled="isBudgetAssignmentPending\(tx\.id\) \|\| isBudgetLockedFor\(tx\)"/)
  assert.match(template, /data-testid="budget-assignment-edit-locked"/)
})

test('loads budget settings when the Transactions view is entered', () => {
  let mountedCallback: ts.ArrowFunction | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'onMounted') {
      const callback = node.arguments[0]
      if (callback && ts.isArrowFunction(callback)) mountedCallback = callback
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  assert.ok(mountedCallback, 'Transactions must register an onMounted callback')
  const mountedBody = mountedCallback.body.getText(sourceFile)
  assert.match(mountedBody, /await goalsStore\.loadBudgetSettings\(\)/)
  assert.equal(/syncBudgetSettingsAvailability\(\)/.test(mountedBody), true, 'mount must synchronize budget readiness after loading')
  assert.equal(/watch\([\s\S]{0,300}syncBudgetSettingsAvailability\s*\)/.test(script), true, 'store load-state changes must update budget readiness')
})

test('fails closed until settings are loaded for an active workspace without errors', () => {
  const goalsStore: {
    budgetSettingsLoading: boolean
    budgetSettingsError: string | null
    budgetSettingsContextKey: string | null
  } = {
    budgetSettingsLoading: false,
    budgetSettingsError: 'permission-denied',
    budgetSettingsContextKey: 'user:workspace'
  }
  const budgetSettingsReady = { value: true }
  const budgetSettingsError = { value: '' }
  const syncReadiness = evaluateComponentFunction<() => void>('syncBudgetSettingsAvailability', {
    goalsStore,
    budgetSettingsReady,
    budgetSettingsError
  })

  syncReadiness()
  assert.equal(budgetSettingsReady.value, false)
  assert.equal(budgetSettingsError.value, 'permission-denied')

  goalsStore.budgetSettingsLoading = true
  goalsStore.budgetSettingsError = null
  syncReadiness()
  assert.equal(budgetSettingsReady.value, false)
  assert.equal(budgetSettingsError.value, '')

  goalsStore.budgetSettingsLoading = false
  goalsStore.budgetSettingsContextKey = null
  syncReadiness()
  assert.equal(budgetSettingsReady.value, false)
  assert.equal(budgetSettingsError.value, 'No hay un espacio de trabajo activo para cargar los presupuestos.')

  goalsStore.budgetSettingsContextKey = 'user:workspace'
  syncReadiness()
  assert.equal(budgetSettingsReady.value, true)
  assert.equal(budgetSettingsError.value, '')
})

test('pre-fills the edit form with the local calendar day of an evening movement', () => {
  const ref = <Value>(value: Value) => ({ value })
  const editTx = ref<Record<string, unknown>>({})
  const openEditModal = evaluateComponentFunction<(tx: Record<string, unknown>) => void>('openEditModal', {
    editingTxId: ref(''),
    editBudgetId: ref(''),
    editingOriginalBudgetId: ref(''),
    editingOriginalType: ref(''),
    editTx,
    editUploadedReceiptUrl: ref(''),
    editSelectedFileName: ref(''),
    editReceiptError: ref(''),
    showEditModal: ref(false),
    resolveBudgetId,
    toDateValue,
    toLocalDateKey
  })

  openEditModal({ id: 'tx-1', type: 'expense', accountId: 'a1', amount: -10, description: 'Dinner', date: new Date(2026, 9, 15, 21, 0) })

  assert.equal(editTx.value.date, '2026-10-15')
})

test('date input defaults never use the UTC day', () => {
  assert.doesNotMatch(script, /toISOString\(\)\.(substring|slice)\(0, 10\)/)
  assert.match(script, /date: toLocalDateKey\(\)/)
})

test('the new-movement form can create a missing category inline and selects it', () => {
  assert.match(template, /<CategoryQuickCreate[\s\S]*?:type="newTx\.type"[\s\S]*?@created="handleNewTxCategoryCreated"/)
  assert.match(script!, /newTx\.value\.categoryId = category\.id/)
})

test('the new-movement form offers a budget for expenses and income, inherited from the linked account', () => {
  assert.match(template, /v-if="showNewTxBudget"[\s\S]{0,200}data-testid="new-tx-budget"/)
  assert.match(template, /id="new-tx-budget"[\s\S]{0,120}v-model="newTx\.budgetId"[\s\S]{0,120}:disabled="!!newTxLinkedBudget"[\s\S]{0,200}@change="newTxBudgetTouched = true"/)
  assert.match(template, /Esta cuenta está ligada a «\{\{ newTxLinkedBudget\.name \}\}»: todos sus movimientos van a ese presupuesto\./)
  assert.match(template, /Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada\./)
  assert.match(script, /canCarryBudget\(newTx\.value\.type\)/)
  assert.match(script, /if \(newTxLinkedBudget\.value\) \{\s+newTx\.value\.budgetId = newTxLinkedBudget\.value\.id/)
  assert.match(script, /budgetId: showNewTxBudget\.value \? \(newTxLinkedBudget\.value\?\.id \?\? newTx\.value\.budgetId\) : null/)
  assert.match(script, /newTxBudgetTouched\.value = false/)
})

test('an edit decides its budget in the same write and tells the user beforehand', () => {
  const budgets = [
    { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] },
    { id: 'viaje', name: 'Viaje', archived: false }
  ]
  const notice = (originalType: string, originalBudgetId: string, draftType: string, accountId: string) =>
    evaluateComponentFunction<() => { kind: string; budgetName: string } | null>('editBudgetNotice', {
      editingOriginalType: { value: originalType },
      editingOriginalBudgetId: { value: originalBudgetId },
      editTx: { value: { type: draftType, accountId } },
      editLinkedBudget: { value: budgets.find(budget => budget.linkedAccountIds?.includes(accountId)) ?? null },
      linkableBudgets: { value: budgets },
      DEFAULT_MONTHLY_BUDGET_ID,
      budgetChangeForEdit,
      canCarryBudget
    })()

  assert.deepEqual(notice('income', 'viaje', 'transfer', 'bank'), { kind: 'released', budgetName: 'Viaje' })
  assert.deepEqual(notice('expense', 'viaje', 'income', 'bank'), { kind: 'switched', budgetName: 'Viaje' })
  assert.deepEqual(notice('expense', DEFAULT_MONTHLY_BUDGET_ID, 'expense', 'cash-casa'), { kind: 'linked', budgetName: 'Casa' })
  assert.deepEqual(notice('expense', 'viaje', 'income', 'cash-casa'), { kind: 'linked', budgetName: 'Casa' })
  assert.equal(notice('expense', 'casa', 'expense', 'cash-casa'), null)
  assert.equal(notice('expense', 'viaje', 'expense', 'bank'), null)
  assert.equal(notice('expense', DEFAULT_MONTHLY_BUDGET_ID, 'transfer', 'cash-casa'), null)

  // One write: no budget-only release before the financial edit; the store receives the link.
  assert.doesNotMatch(script, /releaseBudgetBeforeTypeChange/)
  assert.match(script, /await transactionsStore\.updateTransaction\(editingTxId\.value, \{[\s\S]{0,700}linkedBudgetId: editLinkedBudget\.value\?\.id \?\? null/)
  assert.match(template, /data-testid="edit-budget-released"/)
  assert.match(template, /data-testid="edit-budget-linked"[\s\S]{0,300}Al guardar, este movimiento pasará a «\{\{ editBudgetNoticeState\.budgetName \}\}» porque la cuenta está ligada a ese presupuesto\./)
})

test('locked budget selectors expose the lock reason to assistive technology', () => {
  assert.match(template, /:aria-describedby="budgetLockTitle\(tx\) \? `budget-lock-row-\$\{tx\.id\}` : undefined"/)
  assert.match(template, /:id="`budget-lock-row-\$\{tx\.id\}`" class="sr-only"/)
  assert.match(template, /:aria-describedby="budgetLockTitle\(tx\) \? `budget-lock-card-\$\{tx\.id\}` : undefined"/)
  assert.match(template, /:aria-describedby="newTxLinkedBudget \? 'new-tx-budget-lock' : undefined"/)
  assert.match(template, /id="new-tx-budget-lock"/)
  assert.match(template, /:aria-describedby="editingLinkedBudget \? 'edit-budget-lock' : undefined"/)
})
