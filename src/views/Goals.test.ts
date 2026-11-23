import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as Router from 'vue-router'
import ts from 'typescript'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'
import { createCardBillingLookup, expenseAmountForDate } from '../lib/installments.ts'
import { budgetScopedMonthFilter } from '../lib/budgets.ts'
import { canTransferBetweenAccounts } from '../lib/pockets.ts'
import { isReservedBudgetName } from '../schemas.ts'

const goalsPath = fileURLToPath(new URL('./Goals.vue', import.meta.url))
const goalsView = readFileSync(goalsPath, 'utf8')
const assertContains = (pattern: RegExp, message: string) => assert.ok(pattern.test(goalsView), message)
const assertNotContains = (pattern: RegExp, message: string) => assert.ok(!pattern.test(goalsView), message)

test('S5-S6: the protected monthly baseline remains backed by legacy category limits and catches unassigned expenses', () => {
  assertContains(/Presupuesto base mensual protegido/, 'the legacy baseline must be visibly protected')
  assertContains(/categoryBudgets/, 'legacy category limits remain the baseline source')
  assertContains(/sin presupuesto asignado/, 'unassigned expenses must remain in the baseline')
})

test('S7: additional budgets expose create, edit, and archive controls while retaining archived obligations', () => {
  assertContains(/Presupuestos adicionales/, 'the additional-budget section must be visible')
  assertContains(/Nuevo presupuesto/, 'additional budgets need a create control')
  assertContains(/Editar presupuesto/, 'active additional budgets need an edit control')
  assertContains(/Eliminar presupuesto/, 'active additional budgets need a delete control')
  assertNotContains(/Archivar presupuesto|Presupuestos archivados/, 'archive wording must be renamed to delete')
  assertContains(/conserva asignaciones, historial y cuotas pendientes/, 'archive copy must explain retained obligations')
})

test('S11: additional budgets remain separate from goals, goal allocations, the planner, and legacy category limits', () => {
  assertContains(/separados de las metas, sus asignaciones, el plan 50\/30\/20 y los límites base por categoría/, 'operating budgets must stay separate from legacy planner state')
  assertContains(/categoryCaps/, 'additional category caps must be represented separately')
  assertContains(/budgetAllocations/, 'goal allocations must remain intact')
})

test('S12: nominal caps use their confirmed denomination and explain that display currency does not relabel them', () => {
  assertContains(/budget\.capCurrency/, 'stored cap amounts must retain their own denomination')
  assertContains(/moneda de visualización no cambia la moneda guardada/, 'display-currency changes must not relabel stored caps')
  assertContains(/categoryBudgetCurrency/, 'legacy caps must use their explicit confirmed denomination')
})

test('S13: legacy category-cap denomination requires explicit once-per-workspace confirmation without conversion', () => {
  assertContains(/Confirmar moneda de límites heredados/, 'legacy-unit confirmation needs an explicit action')
  assertContains(/no se convierten importes/, 'confirmation must state that values are not converted')
  assertContains(/Selecciona la moneda real de estos límites/, 'the user must explicitly select the legacy unit')
})

test('Goals.vue setup script parses with the existing TypeScript compiler', () => {
  const setupScript = goalsView.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(setupScript, 'Goals.vue must retain its TypeScript setup script')
  const result = ts.transpileModule(setupScript, {
    fileName: 'Goals.vue.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
    reportDiagnostics: true
  })
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  assert.deepEqual(errors, [])
})

test('S7: handleSaveOperatingBudget accepts numeric v-model values from number inputs without throwing', async () => {
  const blockMatch = goalsView.match(/const isValidCurrencyCode[\s\S]*?const handleArchiveBudget/)
  assert.ok(blockMatch, 'Goals.vue must define handleSaveOperatingBudget')
  const transpiled = ts.transpileModule(blockMatch[0].replace(/\nconst handleArchiveBudget$/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText

  const createdDrafts: unknown[] = []
  const offeredMoves: string[] = []
  const savedCaps: Array<{ budgetId: string; caps: Record<string, number> }> = []
  const state = {
    editingOperatingBudget: { value: null as unknown },
    budgetNameInput: { value: 'Mensual Hogar' },
    budgetKindInput: { value: 'monthly' as const },
    budgetCapCurrencyInput: { value: 'COP' },
    // Vue compiler-dom coerces <input type="number" v-model> values to numbers
    budgetTotalLimitInput: { value: 800 as unknown as string },
    budgetStartDateInput: { value: '' },
    budgetEndDateInput: { value: '' },
    budgetCategoryCapInputs: { cat1: 500 } as Record<string, number | undefined>,
    budgetManagementError: { value: '' },
    savingOperatingBudget: { value: false },
    showBudgetModal: { value: true },
    budgetLinkConflicts: { value: [] as unknown[] },
    budgetLinkedAccountIds: { value: [] as string[] },
    linkableOperatingBudgets: { value: [] as unknown[] },
    openMoveSheet: (budgetId: string) => { offeredMoves.push(budgetId) },
    isReservedBudgetName,
    track: () => undefined,
    goalsStore: {
      operatingBudgets: [] as unknown[],
      async createOperatingBudget(draft: Record<string, unknown>) {
        createdDrafts.push(draft)
        return { id: 'budget-1', ...draft, archived: false }
      },
      async updateOperatingBudget() {
        throw new Error('unexpected update')
      },
      async saveOperatingBudgetCategoryCaps(budgetId: string, caps: Record<string, number>) {
        savedCaps.push({ budgetId, caps })
      }
    }
  }

  const run = new Function(
    'ctx',
    `const {
      editingOperatingBudget, budgetNameInput, budgetKindInput, budgetCapCurrencyInput,
      budgetTotalLimitInput, budgetStartDateInput, budgetEndDateInput, budgetCategoryCapInputs,
      budgetManagementError, savingOperatingBudget, showBudgetModal, goalsStore,
      budgetLinkConflicts, budgetLinkedAccountIds, linkableOperatingBudgets, openMoveSheet,
      isReservedBudgetName, track
    } = ctx;
    ${transpiled}
    return handleSaveOperatingBudget();`
  )

  await run(state)
  assert.deepEqual(offeredMoves, ['budget-1'])
  assert.equal(state.budgetManagementError.value, '')
  assert.equal(state.showBudgetModal.value, false)
  assert.deepEqual(createdDrafts, [{
    kind: 'monthly',
    name: 'Mensual Hogar',
    capCurrency: 'COP',
    totalLimit: 800
  }])
  assert.deepEqual(savedCaps, [{ budgetId: 'budget-1', caps: { cat1: 500 } }])
})

test('budget date inputs show the local calendar day', () => {
  const declaration = goalsView.match(/const dateInputValue = [^\n]+/)?.[0]
  assert.ok(declaration, 'Goals.vue must define dateInputValue')
  const javascript = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const dateInputValue = new Function('toDateValue', 'toLocalDateKey', `${javascript}\nreturn dateInputValue`)(
    toDateValue, toLocalDateKey
  ) as (value?: Date) => string

  assert.equal(dateInputValue(new Date(2026, 9, 1, 0, 0)), '2026-10-01')
  assert.equal(dateInputValue(new Date(2026, 9, 31, 20, 30)), '2026-10-31')
  assert.equal(dateInputValue(undefined), '')
})

test('the planner counts card statements due this month instead of this month\'s card purchases', () => {
  const declaration = goalsView.match(/const realMonthTotals = computed\(\(\) => \{[\s\S]*?\n\}\)/)?.[0]
  assert.ok(declaration, 'Goals.vue must define realMonthTotals')
  const javascript = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const now = new Date()
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  // Closing 31 keeps each purchase on its calendar month's statement; due day 10 pays it next month.
  const cardBillingFor = {
    value: createCardBillingLookup([{ id: 'visa', type: 'credit', statementClosingDay: 31, paymentDueDay: 10 }])
  }
  const transactions = [
    { type: 'expense', amount: -50, date: previousMonth, accountId: 'visa', currency: 'COP' },
    { type: 'expense', amount: -1000, date: thisMonth, accountId: 'visa', currency: 'COP' },
    { type: 'expense', amount: -10, date: thisMonth, accountId: 'cash', currency: 'COP' },
    { type: 'income', amount: 400, date: thisMonth, accountId: 'cash', currency: 'COP' },
    { type: 'income', amount: 25, date: thisMonth, accountId: 'cash', currency: 'COP', budgetId: 'default-monthly' },
    // Income assigned to another budget funds only that budget.
    { type: 'income', amount: 5000, date: thisMonth, accountId: 'cash', currency: 'COP', budgetId: 'ventas-casa' },
    // Spending of a self-funded budget is paid by its own income, not by the month's income.
    { type: 'expense', amount: -700, date: thisMonth, accountId: 'cash', currency: 'COP', budgetId: 'ventas-casa' },
    // A budget without assigned income is paid by the month's income.
    { type: 'expense', amount: -5, date: thisMonth, accountId: 'cash', currency: 'COP', budgetId: 'hogar' }
  ]
  const realMonthTotals = new Function(
    'computed', 'transactionsStore', 'goalsStore', 'userCurrency', 'expenseAmountForDate', 'cardBillingFor',
    'budgetScopedMonthFilter', 'linkedBudgetOfAccount',
    `${javascript}\nreturn realMonthTotals`
  )(
    (getter: () => unknown) => ({ get value() { return getter() } }),
    { transactions },
    {
      convertToPrimary: (amount: number) => amount,
      operatingBudgets: [{ budget: { id: 'ventas-casa', kind: 'event' } }, { budget: { id: 'hogar', kind: 'monthly' } }]
    },
    { value: 'COP' },
    expenseAmountForDate,
    cardBillingFor,
    budgetScopedMonthFilter,
    () => null
  ) as { value: { income: number; expense: number } }

  assert.deepEqual(realMonthTotals.value, { income: 425, expense: 65 })
})

test('currency fields are selectors prefilled from the configured currency', () => {
  assertContains(/<select\s+v-model="legacyCategoryBudgetCurrencyInput"/, 'legacy cap currency must be chosen from a selector')
  assertContains(/<select\s+v-model="budgetCapCurrencyInput"/, 'budget cap currency must be chosen from a selector')
  assertNotContains(/v-model="(legacyCategoryBudgetCurrencyInput|budgetCapCurrencyInput)"\s+type="text"/, 'currency fields must not be free-text inputs')
  assertContains(/legacyCategoryBudgetCurrencyInput = ref\(defaultCurrencyCode\(settingsStore\.currency\)\)/, 'legacy cap currency must be prefilled')
  assertContains(/budgetCapCurrencyInput\.value = entry\?\.budget\.capCurrency \?\? defaultCurrencyCode\(settingsStore\.currency\)/, 'new budgets must be prefilled')
})

test('budget sheet lists only the chosen categories and adds or creates more inline with spending suggestions', () => {
  assertContains(/<CategoryPicker[\s\S]*?:selected-ids="budgetSelectedCategoryIds"[\s\S]*?:suggestions="budgetSuggestedCategories"[\s\S]*?@select="addBudgetCategory"/, 'the budget sheet must embed the inline category picker')
  assertContains(/suggestCategoriesBySpending\(/, 'suggestions must come from recent spending')
  assertContains(/v-for="categoryId in budgetSelectedCategoryIds"/, 'only selected categories render a cap input')
  assertNotContains(/budgetCategoryCapIds/, 'the sheet must no longer render one input per existing category')
  assertContains(/:aria-label="`Quitar \$\{categoryName\(categoryId\)\}`"/, 'each chosen category needs a remove control')
})

test('baseline monthly budget lists only used categories and adds or creates more inline', () => {
  assertContains(/v-for="cat in baselineCategories"/, 'the baseline must render only categories with a limit or spending')
  assertNotContains(/v-for="cat in expenseCategories"/, 'the baseline must not render every expense category')
  assertContains(/visibleBaselineCategories\(/, 'baseline visibility must come from the shared helper')
  assertContains(/const baselineHasSpending = [\s\S]*?monthlyAllocation\.complete === false/, 'spending that cannot be converted for lack of a rate must keep its row visible')
  assertContains(/<CategoryPicker[\s\S]*?:selected-ids="baselineCategoryIds"[\s\S]*?:suggestions="baselineSuggestedCategories"[\s\S]*?@select="addBaselineCategory"/, 'the baseline must add or create categories with the inline picker')
  assertContains(/:aria-label="`Quitar límite de \$\{cat\.name\}`"/, 'each baseline row needs a control to remove its limit')
  assertContains(/:id="`base-cap-\$\{cat\.id\}`"/, 'baseline inputs need ids so an added category can receive focus')
})

test('the budget form links accounts, warns about links moving from another budget, and persists them', () => {
  const source = readFileSync(new URL('./Goals.vue', import.meta.url), 'utf8')
  assert.match(source, /data-testid="budget-linked-accounts"/)
  assert.match(source, /:aria-pressed="budgetLinkedAccountIds\.includes\(acc\.id\)"/)
  assert.match(source, /Al guardar pasará a este presupuesto\./)
  assert.match(source, /linkedAccountConflicts\(\s*linkableOperatingBudgets\.value,\s*budgetLinkedAccountIds\.value,\s*editingOperatingBudget\.value\?\.budget\.id\s*\)/)
  assert.match(source, /totalLimit: totalLimit \?\? null,\s*linkedAccountIds\s*\}/)
  assert.match(source, /\.\.\.\(linkedAccountIds\.length \? \{ linkedAccountIds \} : \{\}\)/)
  assert.match(source, /linkedAccountIds: \(owner\.linkedAccountIds \?\? \[\]\)\.filter\(accountId => !moved\.has\(accountId\)\)/)
  assert.match(source, /Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada\./)
})

test('goal contributions do not use operating-budget expense assignment', () => {
  const source = readFileSync(new URL('./Goals.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /data-testid="contribute-budget"/)
  assert.match(source, /type: 'transfer'/)
  assert.doesNotMatch(source, /type: 'expense',[\s\S]{0,100}Aporte a meta/)
})

test('saving a budget that takes a linked account removes the link from its previous budget in the same write', async () => {
  const blockMatch = goalsView.match(/const isValidCurrencyCode[\s\S]*?const handleArchiveBudget/)
  assert.ok(blockMatch)
  const transpiled = ts.transpileModule(blockMatch[0].replace(/\nconst handleArchiveBudget$/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const updates: Array<[string, unknown]> = []
  const created: unknown[] = []
  const ctx = {
    editingOperatingBudget: { value: null as unknown },
    budgetNameInput: { value: 'Casa Toro' }, budgetKindInput: { value: 'event' },
    budgetCapCurrencyInput: { value: 'COP' }, budgetTotalLimitInput: { value: '' },
    budgetStartDateInput: { value: '' }, budgetEndDateInput: { value: '' },
    budgetCategoryCapInputs: {}, budgetManagementError: { value: '' },
    savingOperatingBudget: { value: false }, showBudgetModal: { value: true },
    budgetLinkedAccountIds: { value: ['cash-casa', 'cash-new'] },
    budgetLinkConflicts: { value: [{ accountId: 'cash-casa', budgetId: 'ventas', budgetName: 'Ventas Casa' }] },
    linkableOperatingBudgets: { value: [{ id: 'ventas', name: 'Ventas Casa', archived: false, linkedAccountIds: ['cash-casa', 'cash-ventas'] }] },
    openMoveSheet: () => undefined,
    isReservedBudgetName,
    track: () => undefined,
    accountsStore: { getAccountById: () => undefined },
    goalsStore: {
      operatingBudgets: [] as unknown[],
      async createOperatingBudget(draft: Record<string, unknown>, options: unknown) { created.push([draft, options]); return { id: 'toro', ...draft, archived: false } },
      async updateOperatingBudget(id: string, patch: unknown) { updates.push([id, patch]); return { id } },
      async saveOperatingBudgetCategoryCaps() {}
    }
  }
  const run = new Function('ctx', `const {
    editingOperatingBudget, budgetNameInput, budgetKindInput, budgetCapCurrencyInput,
    budgetTotalLimitInput, budgetStartDateInput, budgetEndDateInput, budgetCategoryCapInputs,
    budgetManagementError, savingOperatingBudget, showBudgetModal, goalsStore, accountsStore,
    budgetLinkConflicts, budgetLinkedAccountIds, linkableOperatingBudgets, openMoveSheet,
    isReservedBudgetName, track
  } = ctx;
  ${transpiled}
  return handleSaveOperatingBudget();`)
  await run(ctx)
  assert.equal(ctx.budgetManagementError.value, '')
  assert.deepEqual(created, [[
    { kind: 'event', name: 'Casa Toro', capCurrency: 'COP', linkedAccountIds: ['cash-casa', 'cash-new'] },
    { releases: [{ budgetId: 'ventas', linkedAccountIds: ['cash-ventas'] }] }
  ]])
  // The previous budget is released in the same batch, not by a second write.
  assert.deepEqual(updates, [])
  assert.equal(ctx.showBudgetModal.value, false)
})

test('the budget form rejects the name reserved for the default monthly budget, but keeps a stored one on edit', async () => {
  const blockMatch = goalsView.match(/const isValidCurrencyCode[\s\S]*?const handleArchiveBudget/)
  assert.ok(blockMatch)
  const transpiled = ts.transpileModule(blockMatch[0].replace(/\nconst handleArchiveBudget$/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const save = async (name: string, editing: unknown = null) => {
    const writes: string[] = []
    const ctx = {
      editingOperatingBudget: { value: editing },
      budgetNameInput: { value: name }, budgetKindInput: { value: 'monthly' },
      budgetCapCurrencyInput: { value: 'COP' }, budgetTotalLimitInput: { value: '' },
      budgetStartDateInput: { value: '' }, budgetEndDateInput: { value: '' },
      budgetCategoryCapInputs: {}, budgetManagementError: { value: '' },
      savingOperatingBudget: { value: false }, showBudgetModal: { value: true },
      budgetLinkedAccountIds: { value: [] }, budgetLinkConflicts: { value: [] },
      linkableOperatingBudgets: { value: [] }, openMoveSheet: () => undefined,
      isReservedBudgetName,
      track: () => undefined,
      accountsStore: { getAccountById: () => undefined },
      goalsStore: {
        operatingBudgets: [] as unknown[],
        async createOperatingBudget(draft: { name: string }) { writes.push(`create:${draft.name}`); return { id: 'b', ...draft, archived: false } },
        async updateOperatingBudget(id: string, patch: { name: string }) { writes.push(`update:${patch.name}`); return { id } },
        async saveOperatingBudgetCategoryCaps() {}
      }
    }
    await new Function('ctx', `const {
      editingOperatingBudget, budgetNameInput, budgetKindInput, budgetCapCurrencyInput,
      budgetTotalLimitInput, budgetStartDateInput, budgetEndDateInput, budgetCategoryCapInputs,
      budgetManagementError, savingOperatingBudget, showBudgetModal, goalsStore, accountsStore,
      budgetLinkConflicts, budgetLinkedAccountIds, linkableOperatingBudgets, openMoveSheet,
      isReservedBudgetName, track
    } = ctx;
    ${transpiled}
    return handleSaveOperatingBudget();`)(ctx)
    return { error: ctx.budgetManagementError.value, writes }
  }
  const reserved = 'Ese nombre está reservado para el presupuesto mensual predeterminado.'
  for (const name of ['Presupuesto mensual', '  presupuesto MENSUAL ', 'Presupuésto mensual']) {
    assert.deepEqual(await save(name), { error: reserved, writes: [] })
  }
  const other = { budget: { id: 'hogar', kind: 'monthly', name: 'Hogar', linkedAccountIds: [] }, categoryCaps: {} }
  assert.deepEqual(await save('Presupuesto mensual', other), { error: reserved, writes: [] })
  assert.deepEqual(await save('Presupuesto mensual hogar'), { error: '', writes: ['create:Presupuesto mensual hogar'] })
  // A budget already stored with that name can still be edited without renaming it.
  const legacy = { budget: { id: 'legacy', kind: 'monthly', name: 'Presupuesto mensual', linkedAccountIds: [] }, categoryCaps: {} }
  assert.deepEqual(await save('Presupuesto mensual', legacy), { error: '', writes: ['update:Presupuesto mensual'] })
})

test('a budget card explains funds overdrawn by transfers out', () => {
  assert.match(goalsView, /data-testid="budget-card-funds"[\s\S]*?v-if="card\.overdrawn"[^>]*>\s*Salió más plata de la que entró a este presupuesto\.\s*</)
})

test('budget cards show available funds and the cap with accessible progress bars', () => {
  assert.match(goalsView, /data-testid="budget-card-funds"/)
  assert.match(goalsView, /data-testid="budget-card-limit"/)
  assert.match(goalsView, /role="progressbar"[\s\S]{0,200}:aria-label="`Gastado el \$\{card\.fundsPercent\} % de los fondos`"/)
  assert.match(goalsView, /transfiérela a una de sus cuentas ligadas, y verás cuánto te queda disponible\./)
  const helpers = goalsView.match(/const percentOf = [\s\S]*?\nconst progressTone = [^\n]+\n[^\n]+/)?.[0]
  assert.ok(helpers, 'Goals.vue must define percentOf and progressTone')
  const javascript = ts.transpileModule(helpers, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const { percentOf, progressTone } = new Function(`${javascript}\nreturn { percentOf, progressTone }`)()
  assert.deepEqual([percentOf(80, 100), percentOf(150, 100), percentOf(5, 0), percentOf(0, 0)], [80, 150, 100, 0])
  assert.deepEqual([progressTone(79), progressTone(80), progressTone(100)], ['bg-accent-emerald', 'bg-accent-amber', 'bg-accent-rose'])
})

test('an event budget offers to move its existing movements, with a per-row preview', () => {
  assert.match(goalsView, /v-if="budgetMoveCandidatesById\.get\(entry\.budget\.id\)\?\.length"[\s\S]{0,200}data-testid="budget-move-open"/)
  assert.match(goalsView, /data-testid="budget-move-sheet"/)
  assert.match(goalsView, /Elige qué movimientos pasan a <strong[^>]*>«\{\{ moveSheetBudget\?\.name \}\}»<\/strong>/)
  // Linked accounts are locked to their budget, so the form must not promise otherwise.
  assert.doesNotMatch(goalsView, /Siempre puedes cambiarlo al registrarlos/)
  // S4 microcopy in the budget form, next to the linked accounts.
  assert.match(goalsView, /data-testid="budget-linked-accounts"[\s\S]{0,900}Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada\./)
  assert.match(goalsView, /:checked="moveSelectedIds\.has\(tx\.id\)"[\s\S]{0,120}@change="toggleMoveCandidate\(tx\.id\)"/)
  assert.match(goalsView, /data-testid="budget-move-apply" :disabled="movingMovements \|\| moveSelectedIds\.size === 0"/)
  // Saving a budget offers the move right away.
  assert.match(goalsView, /showBudgetModal\.value = false\s+\/\/ Offer to bring in the movements that already belong here\.\s+openMoveSheet\(budgetId\)/)
})

test('moving existing movements uses budget-only updates and keeps failures selected', async () => {
  const declaration = goalsView.match(/const applyMoveSelection = async \(\) => \{[\s\S]*?\n\}/)?.[0]
  assert.ok(declaration, 'Goals.vue must define applyMoveSelection')
  const javascript = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const calls: Array<[string, string]> = []
  let closed = 0
  const ref = <T>(value: T) => ({ value })
  const state = {
    moveSheetBudgetId: ref('casa'),
    moveSelectedIds: ref(new Set(Array.from({ length: 12 }, (_, index) => `tx-${index}`))),
    movingMovements: ref(false),
    moveError: ref(''),
    moveProgress: ref(0),
    moveTotal: ref(0),
    frozenMoveCandidates: ref<unknown>(null),
    // tx-0 is income: it must move after every expense.
    moveSheetCandidates: ref(Array.from({ length: 12 }, (_, index) => ({ id: `tx-${index}`, type: index === 0 ? 'income' : 'expense' })))
  }
  const apply = new Function(
    'moveSheetBudgetId', 'moveSelectedIds', 'movingMovements', 'moveError', 'moveProgress', 'moveTotal',
    'transactionsStore', 'closeMoveSheet', 'MOVE_BATCH_SIZE', 'frozenMoveCandidates', 'moveSheetCandidates',
    `${javascript}\nreturn applyMoveSelection`
  )(
    state.moveSheetBudgetId, state.moveSelectedIds, state.movingMovements, state.moveError, state.moveProgress, state.moveTotal,
    {
      assignExpenseBudget: async (id: string, budgetId: string) => {
        calls.push([id, budgetId])
        if (id === 'tx-11') throw new Error('denied')
      }
    },
    () => { closed += 1 },
    10,
    state.frozenMoveCandidates,
    state.moveSheetCandidates
  ) as () => Promise<void>

  await apply()
  assert.equal(calls.length, 12)
  assert.ok(calls.every(([, budgetId]) => budgetId === 'casa'))
  assert.equal(calls.at(-1)?.[0], 'tx-0', 'income moves after every expense')
  assert.equal(state.frozenMoveCandidates.value, null, 'the list unfreezes after moving')
  assert.deepEqual([...state.moveSelectedIds.value], ['tx-11'])
  assert.equal(state.moveError.value, 'Se movieron 11 de 12. Los que quedaron marcados no se pudieron mover; inténtalo de nuevo.')
  assert.equal(state.moveProgress.value, 12)
  assert.equal(state.movingMovements.value, false)
  assert.equal(closed, 0)

  calls.length = 0
  state.moveSelectedIds.value = new Set(['tx-1'])
  await apply()
  assert.deepEqual(calls, [['tx-1', 'casa']])
  assert.equal(closed, 1)
})

test('linked goals show eligible accounts and report invalid links instead of stale progress', () => {
  assert.match(goalsView, /v-for="acc in linkableAccounts"/)
  assert.match(goalsView, /accountsStore\.accounts\.filter\(account =>\s*!account\.mirror && !isPocketRelatedAccount\(account\) && account\.type !== 'credit'\)/)
  assert.match(goalsView, /data-testid="goal-linked-account-field"/)
  assert.match(goalsView, /v-for="account in linkableGoalAccounts"/)
  assert.match(goalsView, /getSavingsGoalProgressAmount\(goal, accountsStore\.accounts, activeWorkspaceId\.value\)/)
  assert.match(goalsView, /No disponible/)
})

test('Dashboard goal progress uses the same live resolver and suppresses invalid linked values', () => {
  const dashboard = readFileSync(new URL('./Dashboard.vue', import.meta.url), 'utf8')
  assert.match(dashboard, /getSavingsGoalProgressAmount\(goal, accountsStore\.accounts, authStore\.activeWorkspaceId\)/)
  assert.match(dashboard, /goal\.current !== null/)
  assert.match(dashboard, /La cuenta vinculada no está disponible; no se muestra progreso desactualizado/)
})

test('budget basis: Goals shows the consumption/payment switch and counts budgets with it', () => {
  assertContains(/data-testid="goals-budget-basis"[\s\S]{0,400}<BudgetBasisSwitch \/>/, 'the budget area must start with the basis switch')
  assertContains(/const cardBillingFor = computed\(\(\) => createCardBillingLookup\(accountsStore\.accounts, budgetBasis\.value, \{\s*transactions: transactionsStore\.transactions\s*\}\)\)/, 'budget figures must follow the chosen basis and apply card payments')
  assertContains(/vista «\{\{ BUDGET_BASIS_LABELS\[budgetBasis\] \}\}»/, 'the protected baseline must name the view it counts with')
  assertContains(/Gasto real del mes \(\{\{ BUDGET_BASIS_LABELS\[budgetBasis\] \}\}\)/, 'the 50/30/20 comparison must name the view it counts with')
})

function createGoalContributionHarness({ goal, sourceId = '', accounts = [] }: {
  goal: Record<string, unknown>
  sourceId?: string
  accounts?: Array<Record<string, any>>
}) {
  const transactions: Array<Record<string, unknown>> = []
  const virtualContributions: Array<[string, number]> = []
  const goalAmountUpdates: Array<[string, number]> = []
  const alerts: string[] = []
  const hasGoalAccountLink = (candidate: Record<string, unknown> | null) =>
    Boolean(candidate && Object.hasOwn(candidate, 'linkedAccountId') && candidate.linkedAccountId !== null)
  const isLinkable = (account: Record<string, unknown>) =>
    account.workspaceId === 'workspace-a' && account.currency === goal.currency &&
    account.type !== 'credit' && !account.mirror && typeof account.balance === 'number' && Number.isFinite(account.balance)
  const isSavingsGoalAccountLinkable = (account: Record<string, unknown>, all: Array<Record<string, unknown>>) =>
    Boolean(all.find(candidate => candidate.id === account.id && isLinkable(candidate)))
  const getGoalProgressAmount = (candidate: Record<string, unknown>) => {
    const target = accounts.find(account => account.id === candidate.linkedAccountId)
    return target && isLinkable(target) ? Number(target.balance) : null
  }
  const state = {
    selectedGoal: { value: goal },
    selectedGoalAccount: { value: accounts.find(account => account.id === goal.linkedAccountId) ?? null },
    contributeAccountId: { value: sourceId },
    contributeAmount: { value: 25 },
    showContributeBudget: { value: false },
    contributeLinkedBudget: { value: null },
    contributeBudgetId: { value: 'monthly' },
    DEFAULT_MONTHLY_BUDGET_ID: 'monthly',
    activeWorkspaceId: { value: 'workspace-a' },
    accountsStore: {
      accounts,
      getAccountById: (id: string) => accounts.find(account => account.id === id),
      async fetchAccounts() {}
    },
    isPocketRelatedAccount: (account: Record<string, unknown>) => Boolean(account.parentAccountId),
    isSavingsGoalAccountLinkable,
    hasGoalAccountLink,
    getGoalProgressAmount,
    canTransferBetweenAccounts: (source: any, destination: any, all: any[]) =>
      canTransferBetweenAccounts(source, destination, all),
    roundMoney: (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100,
    transactionsStore: {
      categories: [],
      async addTransaction(input: Record<string, unknown>) { transactions.push(input) }
    },
    goalsStore: {
      async contributeToGoal(id: string, amount: number) { virtualContributions.push([id, amount]) },
      async updateGoalAmount(id: string, amount: number) { goalAmountUpdates.push([id, amount]) }
    },
    alert: (message: string) => alerts.push(message),
    confirm: () => true,
    console: { error() {} },
    Date
  }
  const block = goalsView.match(/const handleContribute = async \(\) => \{[\s\S]*?(?=\n\/\/ Save budget)/)?.[0]
  assert.ok(block, 'Goals.vue must define the contribution handler')
  const javascript = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const run = new Function('ctx', `const {
    selectedGoal, selectedGoalAccount, contributeAccountId, contributeAmount,
    activeWorkspaceId, accountsStore, isPocketRelatedAccount,
    isSavingsGoalAccountLinkable, hasGoalAccountLink, getGoalProgressAmount,
    canTransferBetweenAccounts, roundMoney,
    transactionsStore, goalsStore, alert, confirm, console, Date
  } = ctx;
  ${javascript}
  return handleContribute();`)

  return { state, run, transactions, virtualContributions, goalAmountUpdates, alerts }
}

test('virtual goal contributions update only the virtual goal amount and do not create transactions', async () => {
  const harness = createGoalContributionHarness({
    goal: { id: 'virtual-goal', currentAmount: 10, targetAmount: 100, currency: 'COP' }
  })

  await harness.run(harness.state)

  assert.deepEqual(harness.virtualContributions, [['virtual-goal', 25]])
  assert.deepEqual(harness.transactions, [])
  assert.deepEqual(harness.goalAmountUpdates, [])
})

test('linked goal contributions create a same-currency neutral transfer without changing goal amount', async () => {
  const source = {
    id: 'source', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: 100,
    limit: 0, name: 'Source', createdAt: new Date()
  }
  const target = {
    id: 'goal-account', workspaceId: 'workspace-a', type: 'savings', currency: 'COP', balance: 40,
    limit: 0, name: 'Goal account', createdAt: new Date()
  }
  const harness = createGoalContributionHarness({
    goal: { id: 'linked-goal', linkedAccountId: target.id, currentAmount: 0, targetAmount: 100, currency: 'COP' },
    sourceId: source.id,
    accounts: [source, target]
  })

  await harness.run(harness.state)

  assert.equal(harness.transactions.length, 1)
  assert.equal(harness.transactions[0].type, 'transfer')
  assert.equal(harness.transactions[0].accountId, source.id)
  assert.equal(harness.transactions[0].toAccountId, target.id)
  assert.equal(harness.transactions[0].amount, 25)
  assert.equal(harness.transactions[0].categoryId, '')
  assert.deepEqual(harness.virtualContributions, [])
  assert.deepEqual(harness.goalAmountUpdates, [])
})

test('linked goal contribution rejects a missing, cross-workspace, credit, or same-account endpoint before writes', async () => {
  const source = {
    id: 'source', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: 100,
    limit: 0, name: 'Source', createdAt: new Date()
  }
  const invalidTargets = [
    { id: 'missing', workspaceId: 'workspace-a', type: 'savings', currency: 'COP', balance: 0 },
    { id: 'foreign', workspaceId: 'workspace-b', type: 'savings', currency: 'COP', balance: 0 },
    { id: 'wrong-currency', workspaceId: 'workspace-a', type: 'savings', currency: 'USD', balance: 0 },
    { id: 'credit', workspaceId: 'workspace-a', type: 'credit', currency: 'COP', balance: 0 },
    { id: 'bridge', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: 0, mirror: { workspaceId: 'workspace-b' } },
    { ...source }
  ]

  for (const target of invalidTargets) {
    const accounts = target.id === 'missing' ? [source] : [source, target]
    const harness = createGoalContributionHarness({
      goal: { id: `linked-${target.id}`, linkedAccountId: target.id, currentAmount: 0, targetAmount: 100, currency: 'COP' },
      sourceId: source.id,
      accounts
    })

    await harness.run(harness.state)

    assert.deepEqual(harness.transactions, [], `invalid target ${target.id} must not write a transaction`)
    assert.deepEqual(harness.virtualContributions, [], `invalid target ${target.id} must not update virtual progress`)
    assert.deepEqual(harness.goalAmountUpdates, [], `invalid target ${target.id} must not overwrite stored progress`)
  }
})

test('linked goal contributions reject an invalid source before any account or goal write', async () => {
  const target = {
    id: 'goal-account', workspaceId: 'workspace-a', type: 'savings', currency: 'COP', balance: 40,
    limit: 0, name: 'Goal', createdAt: new Date()
  }
  const invalidSources = [
    { id: 'credit', workspaceId: 'workspace-a', type: 'credit', currency: 'COP', balance: 100 },
    { id: 'bridge', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: 100, mirror: { workspaceId: 'workspace-b' } },
    { id: 'wrong-currency', workspaceId: 'workspace-a', type: 'checking', currency: 'USD', balance: 100 }
  ]

  for (const source of invalidSources) {
    const harness = createGoalContributionHarness({
      goal: { id: 'linked-goal', linkedAccountId: target.id, currentAmount: 0, targetAmount: 100, currency: 'COP' },
      sourceId: source.id,
      accounts: [source, target]
    })

    await harness.run(harness.state)

    assert.deepEqual(harness.transactions, [], `${source.id} source must not write a transfer`)
    assert.deepEqual(harness.virtualContributions, [], `${source.id} source must not update virtual progress`)
    assert.deepEqual(harness.goalAmountUpdates, [], `${source.id} source must not overwrite linked progress`)
  }
})

test('budget planner labels show the configured percentages, not fixed 50/30/20', () => {
  assertContains(/Necesidades \(\{\{ needsPercent \}\}%\)/, 'needs label must show the configured percent')
  assertContains(/Deseos \(\{\{ wantsPercent \}\}%\)/, 'wants label must show the configured percent')
  assertContains(/Ahorro \(\{\{ savingsPercent \}\}%\)/, 'savings label must show the configured percent')
  assertNotContains(/Necesidades \(50%\)|Deseos \(30%\)|Ahorro \(20%\)/, 'fixed default percentages must not be shown as labels')
})

test('plan vs real title shows the configured split, not a fixed 50/30/20', () => {
  assertContains(/Tu plan \{\{ needsPercent \}\}\/\{\{ wantsPercent \}\}\/\{\{ savingsPercent \}\} vs este mes \(real\)/, 'the title must show the configured percentages')
  assertNotContains(/Tu plan 50\/30\/20 vs este mes/, 'the title must not show a fixed split')
})

// Render the real SFCs and RouterLinks without a browser, Firebase or a canvas backend.
class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  chartData?: number[]
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
  get content(): string { return (this.text + this.children.map(child => child.content).join('')).trim() }
  get descendants(): ViewNode[] { return this.children.flatMap(child => [child, ...child.descendants]) }
  focus() { focusedNode = this }
  get focused() { return focusedNode === this }
  getContext() { return this }
  closest(selector: string): ViewNode | null {
    return selector === `#${this.props.id}` ? this : this.parent?.closest(selector) ?? null
  }
  find(tag: string, text: string): ViewNode {
    const node = this.descendants.find(node => node.tag === tag && node.content === text)
    assert.ok(node, `expected <${tag}> with text ${JSON.stringify(text)}`)
    return node
  }
  async click() {
    assert.equal(typeof this.props.onClick, 'function', `expected a clickable <${this.tag}>`)
    await this.props.onClick({ button: 0, currentTarget: this, preventDefault() {} })
    await Vue.nextTick()
  }
  getAttribute(name: string) { return this.props[name] }
}
let focusedNode: ViewNode | null = null

const detach = (node: ViewNode) => {
  if (!node.parent) return
  node.parent.children.splice(node.parent.children.indexOf(node), 1)
  node.parent = null
}
const renderer = Vue.createRenderer<ViewNode, ViewNode>({
  createElement: tag => Vue.markRaw(new ViewNode(tag)),
  createText: text => new ViewNode('#text', text),
  createComment: () => new ViewNode('#comment'),
  insert(node, parent, anchor = null) {
    detach(node)
    node.parent = parent
    if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
    else parent.children.push(node)
  },
  remove: detach,
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  setText(node, text) { node.text = text },
  setElementText(node, text) { node.text = text; node.children = [] },
  patchProp(node, key, _previous, next) { node.props[key] = next }
})

const requireModule = createRequire(import.meta.url)
const noOp = () => undefined
const MockSheet = (props: { open: boolean; title: string }, { slots }: Vue.SetupContext) =>
  props.open ? Vue.h('div', { role: 'dialog', 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null
class MockChart {
  static register() {}
  private canvas: ViewNode
  constructor(canvas: ViewNode, config: { data: { datasets: { data: number[] }[] } }) {
    this.canvas = canvas
    canvas.chartData = config.data.datasets[0].data
  }
  destroy() { this.canvas.chartData = undefined }
}

const mountNavigation = async (t: import('node:test').TestContext, path: string, showSidebar = false) => {
  const account = { id: 'cash', name: 'Efectivo', type: 'cash', currency: 'COP', balance: 100 }
  const stores = {
    authStore: { isAuthenticated: true, activeWorkspaceId: 'workspace-a' },
    settingsStore: { currency: 'COP', loadSettings: noOp },
    workspacesStore: { workspaces: [], activeWorkspaceProfiles: {} },
    accountsStore: { accounts: [account], netWorthByCurrency: { COP: 100 }, getAccountById: () => account, fetchAccounts: noOp },
    transactionsStore: { transactions: [], categories: [], fetchCategories: noOp, fetchTransactions: noOp },
    goalsStore: {
      goals: [{ id: 'trip', name: 'Viaje', targetAmount: 100, currentAmount: 25, currency: 'COP', targetDate: new Date(2030, 0, 1) }],
      categoryBudgets: { food: 100 }, categoryBudgetCurrency: { status: 'confirmed', code: 'COP' },
      operatingBudgets: [], exchangeRates: {}, convertToPrimary: (amount: number) => amount,
      budgetIncome: 100, budgetNeedsPercent: 55, budgetWantsPercent: 25, budgetSavingsPercent: 20,
      fetchGoals: noOp, loadBudgetSettings: noOp
    }
  }
  const loadComponent = (file: string) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename: file })
    assert.deepEqual(errors, [])
    const { content } = compileScript(descriptor, { id: file, inlineTemplate: true })
    const script = ts.transpile(content, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS })
    const exports = {} as { default: Vue.Component }
    new Function('exports', 'require', script)(exports, (id: string) => {
      if (id === 'vue') return { ...Vue, Transition: (_: unknown, { slots }: Vue.SetupContext) => slots.default?.(), vModelText: {}, vModelSelect: {} }
      if (id === 'vue-router') return Router
      if (id === 'chart.js') return { Chart: MockChart, registerables: [] }
      if (id === '@/lib/analytics') return { track: noOp }
      if (id === '@/components/ui/useBodyScrollLock') return { useBodyScrollLock: noOp }
      if (id.endsWith('/BaseSheet.vue')) return { default: MockSheet }
      if (id.endsWith('/BudgetBasisSwitch.vue')) return { default: () => Vue.h('div', 'Consumo del mes / Pagos del mes') }
      if (id.endsWith('.vue')) return { default: () => null }
      if (id.startsWith('@/stores/')) {
        const name = id.slice('@/stores/'.length) as keyof typeof stores
        return { [`use${name[0].toUpperCase()}${name.slice(1)}`]: () => stores[name] }
      }
      return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
    })
    return exports.default
  }
  const router = Router.createRouter({
    history: Router.createMemoryHistory(),
    routes: [
      { path: '/', name: 'Dashboard', component: () => Promise.resolve(loadComponent('./Dashboard.vue')) },
      { path: '/goals', name: 'Goals', component: () => Promise.resolve(loadComponent('./Goals.vue')) },
      ...['accounts', 'transactions', 'settings'].map(path => ({ path: `/${path}`, component: () => null }))
    ]
  })
  await router.push(path)
  const root = new ViewNode('root')
  const sidebar = showSidebar ? loadComponent('../components/Sidebar.vue') : null
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  if (sidebar) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { get activeElement() { return focusedNode }, addEventListener: noOp, removeEventListener: noOp }
    })
  }
  const app = renderer.createApp({ render: () => [sidebar && Vue.h(sidebar), Vue.h(Router.RouterView)] })
  t.after(() => {
    try { app.unmount() } finally {
      focusedNode = null
      if (sidebar) {
        if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
        else Reflect.deleteProperty(globalThis, 'document')
      }
    }
  })
  app.use(router).mount(root)
  await new Promise(setImmediate)
  const stepHistory = async (delta: number) => {
    await new Promise<void>(resolve => {
      const stop = router.afterEach(() => { stop(); resolve() })
      router.go(delta)
    })
    await Vue.nextTick()
  }
  return { root, router, stepHistory }
}

test('P1 S1: section links follow direct URLs and history, with separate workflows and a live planner', async t => {
  const { root, router, stepHistory } = await mountNavigation(t, '/goals?tab=savings')
  const nodes = () => root.descendants
  const sectionLinks = () => nodes().filter(node => node.tag === 'a' && node.props.href?.startsWith('/goals'))
  const currentLinks = () => sectionLinks().filter(node => node.props['aria-current'] === 'page').map(node => node.props.href)
  const assertSavings = () => {
    assert.ok(root.find('h2', 'Metas de ahorro').focused)
    root.find('h4', 'Viaje')
    assert.deepEqual(currentLinks(), ['/goals?tab=savings'])
    assert.ok(!nodes().some(node => node.tag === 'canvas' || node.props['data-testid'] === 'goals-budget-basis'))
    assert.ok(!nodes().some(node => node.tag === 'button' && node.content === 'Nuevo presupuesto'))
  }
  assertSavings()
  await root.find('button', 'Nuevo Objetivo').click()
  assert.ok(nodes().some(node => node.props.id === 'create-goal-form'))
  await root.find('button', 'Cancelar').click()
  const contribute = nodes().find(node => node.props['aria-label'] === 'Aportar saldo')
  assert.ok(contribute)
  await contribute.click()
  assert.ok(nodes().some(node => node.props.id === 'contribute-goal-form'))
  await root.find('button', 'Cancelar').click()

  await root.find('a', 'Presupuestos').click()
  assert.equal(router.currentRoute.value.fullPath, '/goals')
  const assertBudgets = () => {
    assert.ok(root.find('h2', 'Presupuestos').focused)
    assert.deepEqual(currentLinks(), ['/goals'])
    assert.deepEqual(nodes().find(node => node.tag === 'canvas')?.chartData, [55, 25, 20])
    assert.ok(nodes().some(node => node.props['data-testid'] === 'goals-budget-basis'))
    assert.ok(!nodes().some(node => node.props['aria-label'] === 'Aportar saldo' || node.content === 'Nuevo Objetivo'))
  }
  assertBudgets()
  const previousCanvas = nodes().find(node => node.tag === 'canvas')!
  await root.find('button', 'Nuevo presupuesto').click()
  assert.ok(nodes().some(node => node.props.id === 'operating-budget-form'))
  await stepHistory(-1)
  assertSavings()
  assert.equal(previousCanvas.chartData, undefined, 'leaving budgets must release the canvas')
  assert.ok(!nodes().some(node => node.props.role === 'dialog'))
  await stepHistory(1)
  assertBudgets()
  assert.ok(!nodes().some(node => node.props.role === 'dialog'), 'history must not reopen a sheet from another section')
  await router.push('/goals?tab=unknown')
  assertBudgets()
})

test('P1 S1: Dashboard links open savings and retain both bare budget destinations', async t => {
  const { root, router } = await mountNavigation(t, '/')
  await root.find('button', 'Por presupuesto').click()
  assert.equal(root.find('a', 'Ver presupuestos').props.href, '/goals')
  assert.equal(root.find('a', 'Ajustar').props.href, '/goals')
  await root.find('a', 'Ver metas').click()
  assert.equal(router.currentRoute.value.fullPath, '/goals?tab=savings')
  root.find('h2', 'Metas de ahorro')
})

test('P1 S1: sidebar drawer and mobile shortcuts identify the correct section', async t => {
  const { root, router } = await mountNavigation(t, '/goals', true)
  const drawer = root.descendants.find(node => node.props.id === 'app-drawer')!
  const more = root.find('button', 'Más')
  const activeDrawerPaths = () => drawer.descendants.filter(node => node.tag === 'a' && node.props['aria-current'] === 'page').map(node => node.props.href)
  const budgetShortcut = root.descendants.find(node => node.tag === 'a' && node.props.href === '/goals' && !drawer.descendants.includes(node))
  assert.ok(budgetShortcut)
  root.find('h2', 'Presupuestos')
  assert.deepEqual(activeDrawerPaths(), ['/goals'])
  assert.equal(budgetShortcut.props['aria-current'], 'page')
  await more.click()
  assert.equal(more.props['aria-expanded'], true)
  assert.ok(drawer.descendants.find(node => node.props['aria-label'] === 'Cerrar menú')?.focused)
  await drawer.find('a', 'Metas de ahorro').click()
  assert.equal(router.currentRoute.value.fullPath, '/goals?tab=savings')
  assert.equal(more.props['aria-expanded'], false)
  assert.deepEqual(activeDrawerPaths(), ['/goals?tab=savings'])
  assert.equal(budgetShortcut.props['aria-current'], undefined)
  await budgetShortcut.click()
  assert.equal(router.currentRoute.value.fullPath, '/goals')
  assert.equal(budgetShortcut.props['aria-current'], 'page')
})
