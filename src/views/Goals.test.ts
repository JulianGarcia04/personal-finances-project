import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'
import { createCardBillingLookup, expenseAmountForDate } from '../lib/installments.ts'

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
      budgetManagementError, savingOperatingBudget, showBudgetModal, goalsStore
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
    { type: 'income', amount: 400, date: thisMonth, accountId: 'cash', currency: 'COP' }
  ]
  const realMonthTotals = new Function(
    'computed', 'transactionsStore', 'goalsStore', 'userCurrency', 'expenseAmountForDate', 'cardBillingFor',
    `${javascript}\nreturn realMonthTotals`
  )(
    (getter: () => unknown) => ({ get value() { return getter() } }),
    { transactions },
    { convertToPrimary: (amount: number) => amount },
    { value: 'COP' },
    expenseAmountForDate,
    cardBillingFor
  ) as { value: { income: number; expense: number } }

  assert.deepEqual(realMonthTotals.value, { income: 400, expense: 60 })
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
  assertContains(/<CategoryPicker[\s\S]*?:selected-ids="baselineCategoryIds"[\s\S]*?:suggestions="baselineSuggestedCategories"[\s\S]*?@select="addBaselineCategory"/, 'the baseline must add or create categories with the inline picker')
  assertContains(/:aria-label="`Quitar límite de \$\{cat\.name\}`"/, 'each baseline row needs a control to remove its limit')
  assertContains(/:id="`base-cap-\$\{cat\.id\}`"/, 'baseline inputs need ids so an added category can receive focus')
})
