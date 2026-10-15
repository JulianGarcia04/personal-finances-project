import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const goalsPath = fileURLToPath(new URL('./Goals.vue', import.meta.url))
const goalsView = readFileSync(goalsPath, 'utf8')
const assertContains = (pattern: RegExp, message: string) => assert.ok(pattern.test(goalsView), message)

test('S5-S6: the protected monthly baseline remains backed by legacy category limits and catches unassigned expenses', () => {
  assertContains(/Presupuesto base mensual protegido/, 'the legacy baseline must be visibly protected')
  assertContains(/categoryBudgets/, 'legacy category limits remain the baseline source')
  assertContains(/sin presupuesto asignado/, 'unassigned expenses must remain in the baseline')
})

test('S7: additional budgets expose create, edit, and archive controls while retaining archived obligations', () => {
  assertContains(/Presupuestos adicionales/, 'the additional-budget section must be visible')
  assertContains(/Nuevo presupuesto/, 'additional budgets need a create control')
  assertContains(/Editar presupuesto/, 'active additional budgets need an edit control')
  assertContains(/Archivar presupuesto/, 'active additional budgets need an archive control')
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
