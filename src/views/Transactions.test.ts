import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { DEFAULT_MONTHLY_BUDGET_ID, budgetChangeForEdit, canAssignBudget, canCarryBudget, linkedBudgetForAccount, resolveBudgetId } from '../lib/budgets.ts'
import { BASE_MONTHLY_BUDGET_LABEL, budgetOfTransaction } from '../lib/transactionClassification.ts'
import { BULK_CATEGORY_SINGLE_TYPE_MESSAGE, describeBulkEditOutcome, describeBulkEditPlan, planBulkTransactionEdit } from '../lib/bulkTransactionEdit.ts'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'
import { DELETED_ACCOUNT_HISTORY_MESSAGE, referencesDeletedAccount } from '../lib/deletedAccountHistory.ts'
import { canDeleteMirrorTransaction } from '../lib/mirror.ts'
import { TransactionSchema } from '../schemas.ts'

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

// Runs the actual setup script (declaration order and Vue watchers included) and returns the named bindings.
const runTransactionsSetup = <Bindings>(exposed: string[] = []) => {
  const dependencies = {
    computed, reactive, ref, watch, DEFAULT_MONTHLY_BUDGET_ID, canDeleteMirrorTransaction, toLocalDateKey,
    onMounted: () => {}, // Do not fetch data; exercise the synchronous setup path in isolation.
    useRoute: () => ({ query: {} }),
    useRouter: () => ({}),
    useAccountsStore: () => ({}),
    useAuthStore: () => ({}),
    useGoalsStore: () => ({ operatingBudgets: [] }),
    useTransactionsStore: () => ({ filteredTransactions: () => [{ id: 'movement', type: 'expense' }] }),
    useWorkspacesStore: () => ({}),
    useNotificationsStore: () => ({})
  }
  const setupBody = sourceFile.statements.filter(statement => !ts.isImportDeclaration(statement))
    .map(statement => statement.getText(sourceFile)).join('\n')
  const javascript = ts.transpile(setupBody, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }) +
    `\nreturn { ${exposed.join(', ')} }`
  const runSetup = new Function(...Object.keys(dependencies), javascript)
  const scope = effectScope()
  const bindings = scope.run(() => runSetup(...Object.values(dependencies))) as Bindings
  return { bindings, stop: () => scope.stop() }
}

test('runs Transactions setup when there are already movements to display', () => {
  let stop = () => {}
  try {
    assert.doesNotThrow(() => { stop = runTransactionsSetup().stop })
  } finally {
    stop()
  }
})

test('S9: changing any filter clears the selection', async () => {
  const { bindings, stop } = runTransactionsSetup<{
    filters: Record<string, string>
    selectedTxIds: { value: string[] }
  }>(['filters', 'selectedTxIds'])
  try {
    const { filters, selectedTxIds } = bindings
    assert.deepEqual(Object.keys(filters).sort(), ['accountId', 'budgetId', 'categoryId', 'dateFrom', 'dateTo', 'search', 'type'])
    selectedTxIds.value = ['movement']
    await nextTick()
    assert.deepEqual(selectedTxIds.value, ['movement'], 'a selection survives while filters stay the same')
    for (const [key, value] of [
      ['search', 'mercado'], ['accountId', 'bank'], ['categoryId', 'food'], ['type', 'expense'],
      ['dateFrom', '2026-11-01'], ['dateTo', '2026-11-30'], ['budgetId', DEFAULT_MONTHLY_BUDGET_ID]
    ]) {
      selectedTxIds.value = ['movement']
      filters[key] = value
      await nextTick()
      assert.deepEqual(selectedTxIds.value, [], key)
    }
  } finally {
    stop()
  }
})

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

// S7 kept one movement's budget in the edit modal; S9 adds the bulk path for a selection, never inline controls.
test('reassigns one movement\'s budget only from the edit modal and a selection only from the bulk edit sheet', () => {
  const bulkSheetStart = template.indexOf('<!-- Bulk Edit Sheet -->')
  assert.ok(bulkSheetStart >= 0, 'the selection has its own bulk edit sheet')
  const bulkSheet = template.slice(bulkSheetStart, template.indexOf('</BaseSheet>', bulkSheetStart))
  assert.match(bulkSheet, /data-testid="bulk-edit-budget"/)
  assert.match(bulkSheet, /data-testid="bulk-edit-category"/)
  assert.match(script, /await transactionsStore\.bulkEditTransactions\(/, 'the bulk path commits through the store in batches')
  const markers = [...template.matchAll(/data-testid="budget-assignment-(row|card|edit)"/g)]
    .map(match => match[1])
    .sort()
  assert.deepEqual(markers, ['edit'])
  assert.doesNotMatch(template, /handleBudgetAssignmentChange/)
  assert.equal(/v-if="editBudgetSelectable"[\s\S]{0,500}data-testid="budget-assignment-edit"/.test(template), true, 'edit budget selector must stay behind editBudgetSelectable')
  assert.match(script, /const editBudgetSelectable = computed\(\(\) =>\s+canCarryBudget\(editingOriginalType\.value\) && editTx\.value\.type === editingOriginalType\.value\)/, 'the selector requires a persisted expense or income with an unchanged draft type')
  assert.equal(/editingOriginalType\.value = tx\.type/.test(script), true, 'openEditModal must record the persisted transaction type')
  assert.match(template, /data-testid="budget-assignment-edit"[\s\S]{0,500}v-model="editBudgetId"/)
  // S7: one "Guardar" saves the budget with the edit; there is no separate budget-only action.
  assert.doesNotMatch(componentSource, /budget-assignment-apply|applyEditBudgetAssignment|assignBudgetToExpense|Actualizar presupuesto|assignExpenseBudget/)
  assert.match(template, /El presupuesto se guarda junto con los demás cambios al pulsar «Guardar»\./)

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

type Notifications = { errors: string[]; confirms: Array<Record<string, unknown>>; answer: boolean }
const notificationsFake = (answer = true) => {
  const record: Notifications = { errors: [], confirms: [], answer }
  return {
    record,
    notifications: {
      success: () => undefined,
      info: () => undefined,
      error: (message: string) => { record.errors.push(message) },
      confirm: async (options: Record<string, unknown>) => { record.confirms.push(options); return record.answer }
    }
  }
}

const editBudgets = [
  { budget: { id: 'viaje', name: 'Viaje', archived: false } },
  { budget: { id: 'viejo', name: 'Viejo', archived: true } },
  { budget: { id: 'casa', name: 'Casa', archived: false, linkedAccountIds: ['cash-casa'] } }
]

// Runs the real saveEditedTransaction with its real budget helpers and a recording store.
const saveEditHarness = (options: {
  original?: { type: string; budgetId: string; accountId?: string }
  draft?: Record<string, unknown>
  chosen?: string
  ready?: boolean
  update?: () => Promise<void>
} = {}) => {
  const original = { type: 'expense', budgetId: DEFAULT_MONTHLY_BUDGET_ID, accountId: 'bank', ...options.original }
  const updates: Array<[string, Record<string, unknown>]> = []
  const { record, notifications } = notificationsFake()
  let closed = 0
  const editTx = { value: {
    type: original.type, accountId: original.accountId, toAccountId: '', categoryId: 'food', amount: 100,
    installments: 1, date: '2026-11-15', description: 'Mercado', notes: '', userId: '', ...options.draft
  } }
  const editBudgetId = { value: options.chosen ?? original.budgetId }
  const editingOriginalBudgetId = { value: original.budgetId }
  const editingOriginalType = { value: original.type }
  const editingTransaction = { value: { id: 'tx-1', accountId: original.accountId, type: original.type } }
  const budgetOptionsForExpense = evaluateComponentFunction('budgetOptionsForExpense', {
    goalsStore: { operatingBudgets: editBudgets },
    linkableBudgets: { value: editBudgets.map(({ budget }) => budget) },
    DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId, canAssignBudget
  })
  const editBudgetSelectable = { value: canCarryBudget(editingOriginalType.value) && editTx.value.type === editingOriginalType.value }
  const editBudgetChoice = evaluateComponentFunction('editBudgetChoice', {
    budgetSettingsReady: { value: options.ready ?? true }, editBudgetSelectable, editBudgetId, editingOriginalBudgetId
  })
  const isOfferedEditBudget = evaluateComponentFunction('isOfferedEditBudget', {
    budgetOptionsForExpense, editingOriginalBudgetId, editingTransaction
  })
  const save = evaluateComponentFunction<() => Promise<void>>('saveEditedTransaction', {
    editTx, isEditCreditExpense: { value: false }, TransactionSchema, notifications, loading: { value: false },
    transactionsStore: {
      updateTransaction: async (id: string, update: Record<string, unknown>) => {
        updates.push([id, update])
        await options.update?.()
      }
    },
    editingTxId: { value: 'tx-1' }, editUploadedReceiptUrl: { value: '' },
    editLinkedBudget: { value: linkedBudgetForAccount(editBudgets.map(({ budget }) => budget), String(editTx.value.accountId)) },
    closeEditModal: () => { closed++ }, editBudgetChoice, isOfferedEditBudget
  })
  return { save, updates, record, closed: () => closed }
}

test('S7: "Guardar" sends the chosen budget with the edit in one update', async () => {
  const combined = saveEditHarness({ chosen: 'viaje', draft: { amount: 150 } })
  await combined.save()
  assert.equal(combined.updates.length, 1)
  assert.equal(combined.updates[0][1].amount, -150)
  assert.equal(combined.updates[0][1].chosenBudgetId, 'viaje')
  assert.equal(combined.closed(), 1)

  // A budget-only change also travels through "Guardar".
  const budgetOnly = saveEditHarness({ original: { type: 'income', budgetId: 'viaje' }, chosen: DEFAULT_MONTHLY_BUDGET_ID })
  await budgetOnly.save()
  assert.equal(budgetOnly.updates[0][1].chosenBudgetId, DEFAULT_MONTHLY_BUDGET_ID)
})

test('S7: "Guardar" sends no budget choice when the selector is unchanged, hidden or not ready', async () => {
  for (const options of [
    { draft: { amount: 150 } },
    { chosen: 'viaje', draft: { type: 'income' } },
    { original: { type: 'transfer', budgetId: DEFAULT_MONTHLY_BUDGET_ID }, chosen: 'viaje', draft: { toAccountId: 'cash', categoryId: '' } },
    { chosen: 'viaje', ready: false }
  ]) {
    const harness = saveEditHarness(options)
    await harness.save()
    assert.equal(harness.updates.length, 1, JSON.stringify(options))
    assert.equal(harness.updates[0][1].chosenBudgetId, undefined, JSON.stringify(options))
  }
})

test('S7: a linked account sends its budget whatever the selector shows', async () => {
  const harness = saveEditHarness({ original: { type: 'expense', budgetId: DEFAULT_MONTHLY_BUDGET_ID, accountId: 'cash-casa' }, chosen: 'casa' })
  await harness.save()
  assert.equal(harness.updates[0][1].linkedBudgetId, 'casa')
})

test('S7: an archived or unknown budget is refused before any write', async () => {
  for (const chosen of ['viejo', 'otro-workspace']) {
    const harness = saveEditHarness({ chosen, draft: { amount: 150 } })
    await harness.save()
    assert.deepEqual(harness.updates, [], chosen)
    assert.deepEqual(harness.record.errors, ['El presupuesto elegido ya no está disponible. Elige otro.'], chosen)
    assert.equal(harness.closed(), 0)
  }
})

test('S7: an archived current budget stays visible but not choosable, and a linked account only offers its budget', () => {
  const budgetOptionsForExpense = evaluateComponentFunction('budgetOptionsForExpense', {
    goalsStore: { operatingBudgets: editBudgets },
    linkableBudgets: { value: editBudgets.map(({ budget }) => budget) },
    DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId, canAssignBudget
  })
  const offered = (originalBudgetId: string, accountId: string) => evaluateComponentFunction<(budgetId: string) => boolean>('isOfferedEditBudget', {
    budgetOptionsForExpense, editingOriginalBudgetId: { value: originalBudgetId }, editingTransaction: { value: { accountId } }
  })
  assert.deepEqual(['viaje', 'viejo', 'otro-workspace', DEFAULT_MONTHLY_BUDGET_ID, 'casa'].map(offered('viejo', 'bank')), [true, false, false, true, true])
  assert.deepEqual(['viaje', DEFAULT_MONTHLY_BUDGET_ID, 'casa'].map(offered('casa', 'cash-casa')), [false, false, true])
})

test('S7: edit validation and save failures show an error toast and keep the form open', async () => {
  const invalid = saveEditHarness({ draft: { description: '' } })
  await invalid.save()
  assert.deepEqual(invalid.updates, [])
  assert.deepEqual(invalid.record.errors, ['La descripción es requerida'])

  const failing = saveEditHarness({ update: async () => { throw new Error('Sin conexión.') } })
  await failing.save()
  assert.deepEqual(failing.record.errors, ['Sin conexión.'])
  assert.equal(failing.closed(), 0)
})

test('S7: deleting a movement asks with a danger confirmation and reports a failure as a toast', async () => {
  const deleted: string[] = []
  const run = (answer: boolean, fail = false) => {
    const { record, notifications } = notificationsFake(answer)
    const handleDelete = evaluateComponentFunction<(id: string) => Promise<void>>('handleDelete', {
      notifications,
      transactionsStore: {
        deleteTransaction: async (id: string) => {
          if (fail) throw new Error('No se pudo borrar.')
          deleted.push(id)
        }
      }
    })
    return { record, handleDelete }
  }

  const declined = run(false)
  await declined.handleDelete('tx-1')
  assert.deepEqual(deleted, [])
  assert.deepEqual(declined.record.errors, [], 'cancelling shows nothing')
  assert.equal(declined.record.confirms[0].tone, 'danger')
  assert.equal(declined.record.confirms[0].confirmLabel, 'Eliminar')

  const failed = run(true, true)
  await failed.handleDelete('tx-1')
  assert.deepEqual(failed.record.errors, ['No se pudo borrar.'])

  const accepted = run(true)
  await accepted.handleDelete('tx-1')
  assert.deepEqual(deleted, ['tx-1'])
  assert.deepEqual(accepted.record.errors, [])
})

test('S7: a batch delete asks once and reports how many movements failed', async () => {
  const run = (answer: boolean, failing: string[], selection = ['a', 'b', 'c'], failure: (id: string) => unknown = id => new Error(`Falló ${id}.`)) => {
    const { record, notifications } = notificationsFake(answer)
    const deleted: string[] = []
    const selectedTxIds = { value: selection }
    const handleBatchDelete = evaluateComponentFunction<() => Promise<void>>('handleBatchDelete', {
      notifications,
      selectedTxIds,
      canDeleteMirrorTransaction,
      transactionsStore: {
        transactions: [],
        deleteTransaction: async (id: string) => {
          if (failing.includes(id)) throw failure(id)
          deleted.push(id)
        }
      }
    })
    return { record, deleted, selectedTxIds, handleBatchDelete }
  }

  const declined = run(false, [])
  await declined.handleBatchDelete()
  assert.deepEqual(declined.deleted, [])
  assert.deepEqual(declined.record.errors, [], 'cancelling shows nothing')
  assert.equal(declined.record.confirms.length, 1)
  assert.equal(declined.record.confirms[0].tone, 'danger')
  assert.match(String(declined.record.confirms[0].message), /3 transacciones/)

  const partial = run(true, ['a', 'c'])
  await partial.handleBatchDelete()
  assert.deepEqual(partial.deleted, ['b'])
  assert.deepEqual(partial.selectedTxIds.value, ['a', 'c'], 'failed movements stay selected')
  assert.deepEqual(partial.record.errors, ['No se pudieron eliminar 2 de 3 transacciones. Falló a.'])

  const single = run(true, ['b'])
  await single.handleBatchDelete()
  assert.deepEqual(single.record.errors, ['No se pudo eliminar 1 de 3 transacciones. Falló b.'])

  // Count and total agree in number: one selected movement is singular throughout.
  const onlyOne = run(true, ['a'], ['a'])
  await onlyOne.handleBatchDelete()
  assert.match(String(onlyOne.record.confirms[0].message), /la transacción seleccionada/)
  assert.deepEqual(onlyOne.record.errors, ['No se pudo eliminar 1 de 1 transacción. Falló a.'])
  assert.deepEqual(onlyOne.selectedTxIds.value, ['a'])
  const allOfFive = run(true, ['a', 'b'], ['a', 'b', 'c', 'd', 'e'])
  await allOfFive.handleBatchDelete()
  assert.deepEqual(allOfFive.record.errors, ['No se pudieron eliminar 2 de 5 transacciones. Falló a.'])

  // A rejection that is not an Error still explains itself.
  const nonError = run(true, ['b'], ['a', 'b'], () => 'x')
  await nonError.handleBatchDelete()
  assert.deepEqual(nonError.record.errors, ['No se pudo eliminar 1 de 2 transacciones. No se pudo eliminar una transacción.'])
})

test('S7: reversing a settlement reports a failure as a toast', async () => {
  const { record, notifications } = notificationsFake()
  const settlementToReverse = { value: { id: 'settlement-1' } }
  const confirmSettlementReversal = evaluateComponentFunction<() => Promise<void>>('confirmSettlementReversal', {
    notifications, settlementToReverse, reversingSettlement: { value: false },
    transactionsStore: { reverseSettlement: async () => { throw new Error('No se pudo revertir.') } }
  })
  await confirmSettlementReversal()
  assert.deepEqual(record.errors, ['No se pudo revertir.'])
  assert.deepEqual(settlementToReverse.value, { id: 'settlement-1' })
})

test('S7: Transactions uses the shared toasts and confirmation, never native dialogs', () => {
  assert.doesNotMatch(script, /(?<![\w.])(alert|confirm)\(/)
  assert.match(script, /const notifications = useNotificationsStore\(\)/)
  // The new-movement form reports its validation and save failures the same way.
  assert.match(script, /if \(!validation\.success\) \{\s+notifications\.error\(validation\.error\.errors\[0\]\.message\)/)
  assert.match(script, /notifications\.error\(err\?\.message \|\| 'No se pudo guardar el movimiento'\)/)
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
    toLocalDateKey,
    referencesDeletedAccount,
    DELETED_ACCOUNT_HISTORY_MESSAGE,
    accountsStore: { accounts: [{ id: 'a1' }], fetchAccounts: async () => true },
    loadedAccountsWorkspaceId: () => 'ws-1',
    notifications: { error: () => assert.fail('an existing account must open the edit form') }
  })

  openEditModal({ id: 'tx-1', type: 'expense', accountId: 'a1', amount: -10, description: 'Dinner', date: new Date(2026, 9, 15, 21, 0) })

  assert.equal(editTx.value.date, '2026-10-15')
})

const deletedAccountEditHarness = (refresh: () => Promise<boolean>) => {
  const ref = <Value>(value: Value) => ({ value })
  const editTx = ref<Record<string, unknown>>({})
  const editingTxId = ref('')
  const alerts: string[] = []
  const accountsStore = { accounts: [{ id: 'a1' }], fetchAccounts: refresh }
  const openEditModal = evaluateComponentFunction<(tx: Record<string, unknown>) => Promise<void>>('openEditModal', {
    editingTxId,
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
    toLocalDateKey,
    referencesDeletedAccount,
    DELETED_ACCOUNT_HISTORY_MESSAGE,
    accountsStore,
    loadedAccountsWorkspaceId: () => 'ws-1',
    notifications: { error: (message: string) => alerts.push(message) }
  })
  return { openEditModal, accountsStore, alerts, editingTxId, editTx }
}

test('a movement of a deleted account explains it is history instead of opening the edit form', async () => {
  let refreshes = 0
  const harness = deletedAccountEditHarness(async () => {
    refreshes++
    harness.accountsStore.accounts = [{ id: 'a1' }, { id: 'late' }]
    return true
  })

  await harness.openEditModal({ id: 'tx-2', workspaceId: 'ws-1', type: 'expense', accountId: 'deleted', amount: -10, description: 'Old', date: new Date(2026, 4, 10) })

  assert.deepEqual(harness.alerts, [DELETED_ACCOUNT_HISTORY_MESSAGE])
  assert.equal(refreshes, 1, 'accounts are refreshed once before refusing')
  assert.equal(harness.editingTxId.value, '')
  assert.deepEqual(harness.editTx.value, {})

  // An account another member created after the last load is found by the refresh.
  await harness.openEditModal({ id: 'tx-3', workspaceId: 'ws-1', type: 'expense', accountId: 'late', amount: -10, description: 'New', date: new Date(2026, 10, 10) })
  assert.equal(harness.editingTxId.value, 'tx-3')
  assert.deepEqual(harness.alerts, [DELETED_ACCOUNT_HISTORY_MESSAGE])
})

test('a failed account refresh never reports an existing account as deleted', async () => {
  const harness = deletedAccountEditHarness(async () => false)

  await harness.openEditModal({ id: 'tx-4', workspaceId: 'ws-1', type: 'expense', accountId: 'late', amount: -10, description: 'New', date: new Date(2026, 10, 10) })

  assert.deepEqual(harness.alerts, [])
  assert.equal(harness.editingTxId.value, 'tx-4')
})

test('a row left over from the previous workspace is not judged against the new workspace accounts', async () => {
  const harness = deletedAccountEditHarness(async () => assert.fail('no refresh is needed for another workspace'))

  await harness.openEditModal({ id: 'tx-5', workspaceId: 'ws-0', type: 'expense', accountId: 'old-bank', amount: -10, description: 'Old workspace', date: new Date(2026, 10, 10) })

  assert.deepEqual(harness.alerts, [])
  assert.equal(harness.editingTxId.value, 'tx-5')
})

test('a missing account is labelled as deleted only once its workspace accounts have loaded', () => {
  const accountName = (loadedWorkspaceId: string | null) => evaluateComponentFunction<(id: string, workspaceId?: string) => string>('getAccountName', {
    accountsStore: { accounts: [], getAccountById: () => undefined },
    getAccountDisplayLabel: () => 'unused',
    loadedAccountsWorkspaceId: () => loadedWorkspaceId
  })

  assert.equal(accountName('ws-1')('deleted', 'ws-1'), 'Cuenta eliminada')
  assert.equal(accountName(null)('deleted', 'ws-1'), 'Desconocida')
  assert.equal(accountName('ws-1')('deleted', 'ws-0'), 'Desconocida')
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
  assert.match(template, /:aria-describedby="newTxLinkedBudget \? 'new-tx-budget-lock' : undefined"/)
  assert.match(template, /id="new-tx-budget-lock"/)
  assert.match(template, /:aria-describedby="editingLinkedBudget \? 'edit-budget-lock' : undefined"/)
})

test('S9: the budget column shows the budget of expenses and income and "—" for the rest', () => {
  const label = (ready: boolean) => evaluateComponentFunction<(tx: Record<string, unknown>) => string>('budgetLabelOf', {
    budgetOfTransaction, DEFAULT_MONTHLY_BUDGET_ID, BASE_MONTHLY_BUDGET_LABEL,
    budgetSettingsReady: { value: ready },
    linkableBudgets: { value: [{ id: 'viaje', name: 'Viaje', archived: false }, { id: 'viejo', name: 'Viejo', archived: true }] }
  })
  const labelOf = label(true)
  assert.equal(BASE_MONTHLY_BUDGET_LABEL, 'Presupuesto mensual base')
  for (const budgetId of [undefined, null, DEFAULT_MONTHLY_BUDGET_ID]) {
    assert.equal(labelOf({ type: 'expense', budgetId }), 'Presupuesto mensual base', String(budgetId))
  }
  assert.equal(labelOf({ type: 'income', budgetId: 'viaje' }), 'Viaje')
  assert.equal(labelOf({ type: 'expense', budgetId: 'viejo' }), 'Viejo · Archivado')
  assert.equal(labelOf({ type: 'expense', budgetId: 'borrado' }), 'Presupuesto no disponible')
  for (const type of ['transfer', 'loan', 'loan_payment']) assert.equal(labelOf({ type, budgetId: 'viaje' }), '—', type)
  // Until budgets load only the base budget, which needs no lookup, is named.
  assert.equal(label(false)({ type: 'expense', budgetId: 'viaje' }), '…')
  assert.equal(label(false)({ type: 'expense' }), 'Presupuesto mensual base')

  // The budget sits under the category in the same column, so the desktop table keeps the seven
  // columns that fit without a horizontal scroll, and the budget line can't widen that column.
  const desktopTable = template.slice(template.indexOf('<table'), template.indexOf('</table>'))
  assert.equal(desktopTable.match(/<th\b/g)?.length, 7)
  assert.match(desktopTable, /<th[^>]*>Categoría \/ Presupuesto<\/th>/)
  assert.doesNotMatch(desktopTable, /<th[^>]*>Presupuesto<\/th>/)
  assert.match(desktopTable, /<!-- Category and budget -->[\s\S]{0,1200}data-testid="budget-cell"[^>]*class="[^"]*\bw-0 min-w-full truncate\b[\s\S]{0,300}budgetLabelOf\(tx\)/)
  assert.match(template, /v-if="budgetOfTransaction\(tx\) !== null"\s+data-testid="budget-badge"[\s\S]{0,600}budgetLabelOf\(tx\)/)
  assert.match(desktopTable, /colspan="7"/)
})

test('the desktop table width does not depend on how long a description or account name is', () => {
  // Measured on production data: a 314px description made the table 0.83px wider than its
  // 1150px container at 1920px, and 84px wider at 1280px, so the container always scrolled.
  const desktopTable = template.slice(template.indexOf('<table'), template.indexOf('</table>'))
  // Description and account split the free width by percentage instead of by text length.
  assert.match(desktopTable, /<th class="[^"]*\bw-\[36%\][^"]*">Detalles \/ Comercio<\/th>/)
  assert.match(desktopTable, /<th class="[^"]*\bw-\[14%\][^"]*">Cuenta<\/th>/)
  // Their text truncates instead of widening the column, down to a readable minimum.
  assert.match(desktopTable, /<!-- Description -->\s*<td class="[^"]*\bmin-w-\[10rem\][^"]*">\s*<div class="w-0 min-w-full truncate" :title="tx\.description">/)
  assert.match(desktopTable, /<!-- Account -->\s*<td class="[^"]*\bmin-w-\[7rem\][^"]*">\s*<div class="w-0 min-w-full truncate" :title="getAccountName/)
  // A max width on the description cell sent the leftover width to the amount column instead.
  const descriptionCell = desktopTable.match(/<!-- Description -->\s*<td class="([^"]*)"/)?.[1] ?? ''
  assert.doesNotMatch(descriptionCell, /max-w-/)
})

test('S9: the budget filter offers every budget, starting with the base monthly budget', () => {
  assert.match(template, /id="tx-filter-budget"[\s\S]{0,200}v-model="filters\.budgetId"/)
  assert.match(template, /<option value="">Todos los presupuestos<\/option>/)
  assert.match(template, /:value="DEFAULT_MONTHLY_BUDGET_ID">\{\{ BASE_MONTHLY_BUDGET_LABEL \}\}<\/option>/)
  assert.match(script, /\[filters\.accountId, filters\.categoryId, filters\.type, filters\.budgetId, filters\.dateFrom, filters\.dateTo\]/, 'the mobile filter count includes the budget')
})

test('S9: the category control asks for a single type and explains why it is disabled', () => {
  assert.match(template, /data-testid="bulk-edit-category"[\s\S]{0,300}:disabled="!bulkCategoryKind \|\| bulkSaving"/)
  assert.match(template, /:aria-describedby="bulkCategoryKind \? undefined : 'bulk-edit-category-hint'"/)
  assert.match(template, /id="bulk-edit-category-hint"[\s\S]{0,200}\{\{ BULK_CATEGORY_SINGLE_TYPE_MESSAGE \}\}/)
  assert.equal(BULK_CATEGORY_SINGLE_TYPE_MESSAGE, 'Para cambiar la categoría, selecciona solo gastos o solo ingresos.')
  assert.match(script, /const bulkCategoryKind = computed\(\(\) => bulkCategoryType\(selectedTransactions\.value\)\)/)
  // The picker offers the categories of that type and the ones valid for both.
  const options = evaluateComponentFunction<() => Array<{ id: string }>>('bulkCategoryOptionsFor', {
    transactionsStore: { categories: [
      { id: 'food', type: 'expense' }, { id: 'salary', type: 'income' }, { id: 'other', type: 'both' }
    ] }
  }) as unknown as (kind: string | null) => Array<{ id: string }>
  assert.deepEqual(options('expense').map(category => category.id), ['food', 'other'])
  assert.deepEqual(options('income').map(category => category.id), ['salary', 'other'])
  assert.deepEqual(options(null), [])
  // The selection bar opens the sheet; budgets are chosen only among active ones.
  assert.match(template, /@click="openBulkEdit"[\s\S]{0,300}aria-label="Editar categoría o presupuesto de la selección"/)
  assert.match(template, /data-testid="bulk-edit-budget"[\s\S]{0,400}v-for="option in bulkBudgetOptions"/)
})

const bulkRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws-1', accountId: 'bank', amount: -100, type: 'expense', categoryId: 'food', description: id,
  date: new Date(2026, 10, 15), currency: 'COP', createdAt: new Date(2026, 10, 15), ...extra
})

// Runs the real applyBulkEdit with the real planning helpers and a recording store.
const bulkEditHarness = (options: {
  rows?: Array<Record<string, unknown>>
  selected?: string[]
  categoryId?: string
  budgetId?: string
  answer?: boolean
  ready?: boolean
  outcome?: (request: unknown, ids: string[]) => unknown
} = {}) => {
  const rows = options.rows ?? [bulkRow('a'), bulkRow('b'), bulkRow('transfer', { type: 'transfer', amount: 10, toAccountId: 'cash', categoryId: '' })]
  const record = { errors: [] as string[], successes: [] as string[], infos: [] as string[], confirms: [] as Array<Record<string, unknown>> }
  const notifications = {
    error: (message: string) => { record.errors.push(message) },
    success: (message: string) => { record.successes.push(message) },
    info: (message: string) => { record.infos.push(message) },
    confirm: async (confirmOptions: Record<string, unknown>) => { record.confirms.push(confirmOptions); return options.answer ?? true }
  }
  const calls: Array<[unknown, string[], unknown]> = []
  const budgets = [{ id: 'viaje', name: 'Viaje', archived: false }]
  const transactionsStore = {
    transactions: rows,
    categories: [{ id: 'food', type: 'expense' }, { id: 'transport', type: 'expense' }],
    bulkEditTransactions: async (request: never, ids: string[], passedBudgets: unknown) => {
      calls.push([request, [...ids], passedBudgets])
      if (options.outcome) return options.outcome(request, ids)
      const plan = planBulkTransactionEdit(request, ids, rows as never, bulkEditContext())
      return { plan, written: plan.updates.map(update => update.id), failed: [] }
    }
  }
  const accountsStore = { accounts: [{ id: 'bank' }, { id: 'cash' }], fetchAccounts: async () => true }
  const selectedTxIds = { value: options.selected ?? rows.map(row => String(row.id)) }
  const showBulkEdit = { value: true }
  const bulkSaving = { value: false }
  const linkableBudgets = { value: budgets }
  const bulkEditContext = evaluateComponentFunction<() => Parameters<typeof planBulkTransactionEdit>[3]>('bulkEditContext', {
    authStore: { activeWorkspaceId: 'ws-1' }, accountsStore, loadedAccountsWorkspaceId: () => 'ws-1', linkableBudgets, transactionsStore
  })
  const bulkEditRequest = evaluateComponentFunction('bulkEditRequest', {
    bulkCategoryId: { value: options.categoryId ?? '' }, bulkBudgetId: { value: options.budgetId ?? '' }
  })
  const planSelection = evaluateComponentFunction('planSelection', {
    planBulkTransactionEdit, selectedTxIds, transactionsStore, bulkEditContext
  })
  const applyBulkEdit = evaluateComponentFunction<() => Promise<void>>('applyBulkEdit', {
    bulkSaving, budgetSettingsReady: { value: options.ready ?? true }, bulkEditRequest, planSelection, accountsStore, notifications, describeBulkEditPlan, describeBulkEditOutcome,
    transactionsStore, selectedTxIds, linkableBudgets, showBulkEdit
  })
  return { applyBulkEdit, record, calls, selectedTxIds, showBulkEdit, bulkSaving }
}

test('S9: a bulk edit asks once, saying how many change and how many are skipped and why', async () => {
  const declined = bulkEditHarness({ budgetId: 'viaje', answer: false })
  await declined.applyBulkEdit()
  assert.deepEqual(declined.calls, [], 'declining writes nothing')
  assert.equal(declined.record.confirms.length, 1)
  assert.equal(declined.record.confirms[0].message,
    '2 movimientos cambiarán. 1 se omitirá: 1 es una transferencia o un préstamo, que no lleva presupuesto.')
  assert.equal(declined.record.confirms[0].confirmLabel, 'Aplicar')
  assert.deepEqual(declined.selectedTxIds.value, ['a', 'b', 'transfer'])
  assert.equal(declined.showBulkEdit.value, true)
})

test('S9: a confirmed bulk edit commits through the store, reports success, clears the selection and closes the sheet', async () => {
  const harness = bulkEditHarness({ categoryId: 'transport', budgetId: DEFAULT_MONTHLY_BUDGET_ID, rows: [bulkRow('a'), bulkRow('b', { budgetId: 'viaje' })] })
  await harness.applyBulkEdit()
  assert.equal(harness.calls.length, 1)
  assert.deepEqual(harness.calls[0][0], { categoryId: 'transport', budgetId: DEFAULT_MONTHLY_BUDGET_ID })
  assert.deepEqual(harness.calls[0][1], ['a', 'b'])
  assert.deepEqual(harness.record.successes, ['Se actualizaron 2 movimientos.'])
  assert.deepEqual(harness.record.errors, [])
  assert.deepEqual(harness.selectedTxIds.value, [])
  assert.equal(harness.showBulkEdit.value, false)
  assert.equal(harness.bulkSaving.value, false)
})

test('S9: when a chunk fails, its movements stay selected and an error says how many were saved', async () => {
  const harness = bulkEditHarness({
    budgetId: 'viaje',
    outcome: (request, ids) => {
      const plan = planBulkTransactionEdit(request as never, ids, [bulkRow('a'), bulkRow('b'), bulkRow('c')] as never, {
        workspaceId: 'ws-1', accounts: [{ id: 'bank' }], loadedAccountsWorkspaceId: 'ws-1',
        budgets: [{ id: 'viaje', name: 'Viaje', archived: false }], categories: []
      })
      return { plan, written: ['a'], failed: [{ ids: ['b', 'c'], error: new Error('permission-denied') }] }
    },
    rows: [bulkRow('a'), bulkRow('b'), bulkRow('c')]
  })
  await harness.applyBulkEdit()
  assert.deepEqual(harness.selectedTxIds.value, ['b', 'c'])
  assert.deepEqual(harness.record.errors, ['Se actualizaron 1 de 3 movimientos. No se pudieron guardar 2; siguen seleccionados para que lo intentes de nuevo.'])
  assert.deepEqual(harness.record.successes, [])

  const thrown = bulkEditHarness({ budgetId: 'viaje', outcome: () => { throw new Error('Sin conexión.') } })
  await thrown.applyBulkEdit()
  assert.deepEqual(thrown.record.errors, ['Sin conexión.'])
  assert.deepEqual(thrown.selectedTxIds.value, ['a', 'b', 'transfer'])
  assert.equal(thrown.bulkSaving.value, false)
})

test('S9: nothing is asked or written when no row can take the change or the request is invalid', async () => {
  const none = bulkEditHarness({ budgetId: 'viaje', rows: [bulkRow('transfer', { type: 'transfer', amount: 10, toAccountId: 'cash', categoryId: '' })] })
  await none.applyBulkEdit()
  assert.deepEqual(none.record.confirms, [])
  assert.deepEqual(none.calls, [])
  assert.deepEqual(none.record.errors, ['Ningún movimiento cambiará. 1 se omitirá: 1 es una transferencia o un préstamo, que no lleva presupuesto.'])

  const mixed = bulkEditHarness({ categoryId: 'transport', rows: [bulkRow('a'), bulkRow('income', { type: 'income', amount: 5 })] })
  await mixed.applyBulkEdit()
  assert.deepEqual(mixed.record.confirms, [])
  assert.deepEqual(mixed.record.errors, ['Para cambiar la categoría, selecciona solo gastos o solo ingresos.'])

  const empty = bulkEditHarness({})
  await empty.applyBulkEdit()
  assert.deepEqual(empty.record.errors, ['Elige una categoría o un presupuesto para cambiar.'])

  // Links and existing references are judged against loaded budgets, so nothing runs before they load.
  const loading = bulkEditHarness({ budgetId: 'viaje', ready: false })
  await loading.applyBulkEdit()
  assert.deepEqual([loading.record.confirms, loading.record.errors, loading.calls], [[], [], []])
})
