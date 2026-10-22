import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'
import { createCardBillingLookup, expenseAmountForDate } from '../lib/installments.ts'
import { DEFAULT_MONTHLY_BUDGET_ID, resolveBudgetId, selfFundedBudgetIds } from '../lib/budgets.ts'

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
      budgetLinkConflicts, budgetLinkedAccountIds, linkableOperatingBudgets
    } = ctx;
    ${transpiled}
    return handleSaveOperatingBudget();`
  )

  await run(state)
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
    'resolveBudgetId', 'DEFAULT_MONTHLY_BUDGET_ID', 'selfFundedBudgetIds',
    `${javascript}\nreturn realMonthTotals`
  )(
    (getter: () => unknown) => ({ get value() { return getter() } }),
    { transactions },
    { convertToPrimary: (amount: number) => amount },
    { value: 'COP' },
    expenseAmountForDate,
    cardBillingFor,
    resolveBudgetId,
    DEFAULT_MONTHLY_BUDGET_ID,
    selfFundedBudgetIds
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

test('a goal contribution inherits the budget of its linked account and saves it', () => {
  const source = readFileSync(new URL('./Goals.vue', import.meta.url), 'utf8')
  assert.match(source, /data-testid="contribute-budget"/)
  assert.match(source, /contributeBudgetId\.value = budgetIdForAccount\(linkableOperatingBudgets\.value, accountId\)/)
  assert.match(source, /:disabled="!!contributeLinkedBudget"/)
  assert.match(source, /type: 'expense',\s*budgetId: contributeLinkedBudget\.value\?\.id \?\? contributeBudgetId\.value/)
})

test('saving a budget that takes a linked account removes the link from its previous budget', async () => {
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
    goalsStore: {
      operatingBudgets: [] as unknown[],
      async createOperatingBudget(draft: Record<string, unknown>) { created.push(draft); return { id: 'toro', ...draft, archived: false } },
      async updateOperatingBudget(id: string, patch: unknown) { updates.push([id, patch]); return { id } },
      async saveOperatingBudgetCategoryCaps() {}
    }
  }
  const run = new Function('ctx', `const {
    editingOperatingBudget, budgetNameInput, budgetKindInput, budgetCapCurrencyInput,
    budgetTotalLimitInput, budgetStartDateInput, budgetEndDateInput, budgetCategoryCapInputs,
    budgetManagementError, savingOperatingBudget, showBudgetModal, goalsStore,
    budgetLinkConflicts, budgetLinkedAccountIds, linkableOperatingBudgets
  } = ctx;
  ${transpiled}
  return handleSaveOperatingBudget();`)
  await run(ctx)
  assert.equal(ctx.budgetManagementError.value, '')
  assert.deepEqual(created, [{ kind: 'event', name: 'Casa Toro', capCurrency: 'COP', linkedAccountIds: ['cash-casa', 'cash-new'] }])
  assert.deepEqual(updates, [['ventas', { linkedAccountIds: ['cash-ventas'] }]])
  assert.equal(ctx.showBudgetModal.value, false)
})

test('budget cards show available funds and the cap with accessible progress bars', () => {
  assert.match(goalsView, /data-testid="budget-card-funds"/)
  assert.match(goalsView, /data-testid="budget-card-limit"/)
  assert.match(goalsView, /role="progressbar"[\s\S]{0,200}:aria-label="`Gastado el \$\{card\.fundsPercent\} % de los fondos`"/)
  assert.match(goalsView, /Regístralo con este presupuesto y verás cuánto te queda disponible\./)
  const helpers = goalsView.match(/const percentOf = [\s\S]*?\nconst progressTone = [^\n]+\n[^\n]+/)?.[0]
  assert.ok(helpers, 'Goals.vue must define percentOf and progressTone')
  const javascript = ts.transpileModule(helpers, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const { percentOf, progressTone } = new Function(`${javascript}\nreturn { percentOf, progressTone }`)()
  assert.deepEqual([percentOf(80, 100), percentOf(150, 100), percentOf(5, 0), percentOf(0, 0)], [80, 150, 100, 0])
  assert.deepEqual([progressTone(79), progressTone(80), progressTone(100)], ['bg-accent-emerald', 'bg-accent-amber', 'bg-accent-rose'])
})
