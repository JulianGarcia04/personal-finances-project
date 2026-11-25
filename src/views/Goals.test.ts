import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import * as Router from 'vue-router'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'
import { toDateValue, toLocalDateKey } from '../lib/dates.ts'
import { canTransferBetweenAccounts } from '../lib/pockets.ts'
import { isReservedBudgetName } from '../schemas.ts'
import type { Transaction } from '../types.ts'

const goalsPath = fileURLToPath(new URL('./Goals.vue', import.meta.url))
const goalsView = readFileSync(goalsPath, 'utf8')
const assertContains = (pattern: RegExp, message: string) => assert.ok(pattern.test(goalsView), message)
const assertNotContains = (pattern: RegExp, message: string) => assert.ok(!pattern.test(goalsView), message)

test('S5-S6: the base monthly budget keeps its stored category limits and catches unassigned expenses', () => {
  assertContains(/Presupuesto mensual base por categoría/, 'the baseline must be named as the base monthly budget')
  assertContains(/categoryCaps: goalsStore\.categoryBudgets/, 'stored category limits remain the baseline source')
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

test('S11: additional budgets remain separate from goals, goal allocations, and legacy category limits', () => {
  assertContains(/separados de las metas, sus asignaciones y los límites base por categoría/, 'operating budgets must stay separate from legacy state')
  assertContains(/categoryCaps/, 'additional category caps must be represented separately')
  assertContains(/budgetAllocations/, 'goal allocations must remain intact')
})

test('S12: nominal caps use their confirmed denomination and explain that display currency does not relabel them', () => {
  assertContains(/budget\.capCurrency/, 'stored cap amounts must retain their own denomination')
  assertContains(/moneda de visualización no cambia la moneda guardada/, 'display-currency changes must not relabel stored caps')
  assertContains(/La moneda guardada \{\{ editingOperatingBudget\.budget\.capCurrency \}\} no se puede cambiar; los límites existentes siguen en esa moneda\./, 'editing a budget must say its stored caps keep their currency')
  assertContains(/categoryBudgetCurrency/, 'legacy caps must use their explicit confirmed denomination')
})

test('S13: legacy category-cap denomination requires explicit once-per-workspace confirmation without conversion', () => {
  assertContains(/Confirmar moneda de los límites/, 'legacy-unit confirmation needs an explicit action')
  assertContains(/no se convierten importes/, 'confirmation must state that values are not converted')
  assertContains(/Selecciona la moneda real de estos límites/, 'the user must explicitly select the legacy unit')
})

test('S7 T5b: budget copy uses plain words instead of internal jargon', () => {
  const template = goalsView.slice(0, goalsView.indexOf('<script setup'))
  assert.doesNotMatch(template, /categoryBudgets/, 'the stored field name must not reach users')
  assertNotContains(/protegido|heredados|relabel/i, 'no "protegido", "límites heredados" or "relabelan" in copy or messages')
  assertContains(/Moneda de los límites por categoría: <strong/, 'the confirmed currency names what it applies to')
  assertContains(/Moneda real de los límites por categoría/, 'the currency selector names what it applies to')
  assertContains(/Los gastos sin presupuesto asignado cuentan en este presupuesto mensual base, con sus límites por categoría\./, 'the baseline explains what it holds')
  assertContains(/Quitar una elimina sólo ese límite; los límites del presupuesto mensual base no cambian\./, 'removing a cap explains the base budget is untouched')
  assertContains(/'Confirma primero la moneda de los límites por categoría\.'/, 'the pending-currency error uses the same words')
})

test('S7 T5b: Goals uses the shared notifications instead of native dialogs', () => {
  const script = goalsView.slice(goalsView.indexOf('<script setup'))
  assert.doesNotMatch(script, /(?<![.\w])(alert|confirm)\(/, 'no native alert() or confirm() may remain')
  assert.match(script, /import \{ useNotificationsStore \} from '@\/stores\/notificationsStore'/)
  assert.match(script, /const notifications = useNotificationsStore\(\)/)
})

test('S7 T5b: deleting a budget asks for a danger confirmation and only proceeds when confirmed', async () => {
  const declaration = goalsView.match(/const handleArchiveBudget = async[\s\S]*?\n\}/)?.[0]
  assert.ok(declaration, 'Goals.vue must define handleArchiveBudget')
  const javascript = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const archive = async (confirmed: boolean) => {
    const confirms: Array<Record<string, unknown>> = []
    const archived: string[] = []
    const notifications = {
      async confirm(options: Record<string, unknown>) { confirms.push(options); return confirmed },
      success() {}, error() {}, info() {}
    }
    const goalsStore = { budgetSettingsError: '', async archiveOperatingBudget(id: string) { archived.push(id) } }
    const handleArchiveBudget = new Function('notifications', 'goalsStore', `${javascript}\nreturn handleArchiveBudget`)(
      notifications, goalsStore
    ) as (budgetId: string) => Promise<void>
    await handleArchiveBudget('hogar')
    return { confirms, archived }
  }

  const declined = await archive(false)
  assert.deepEqual(declined.archived, [], 'cancelling keeps the budget')
  assert.deepEqual(declined.confirms, [{
    title: '¿Eliminar este presupuesto?',
    message: 'Se conservarán sus asignaciones, historial y cuotas pendientes.',
    confirmLabel: 'Eliminar',
    tone: 'danger'
  }])
  assert.deepEqual((await archive(true)).archived, ['hogar'])
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
  assertContains(/const budgetBasis = computed\(\(\) => workspacesStore\.activeBudgetCardBasis\)/, 'budgets count with the active workspace basis')
  assertNotContains(/import \{[^}]*\bbudgetBasis\b[^}]*\} from '@\/lib\/budgetBasis'/, 'budgets must not use a device-wide basis')
  assertContains(/const cardBillingFor = computed\(\(\) => createCardBillingLookup\(accountsStore\.accounts, budgetBasis\.value, \{\s*transactions: transactionsStore\.transactions\s*\}\)\)/, 'budget figures must follow the chosen basis and apply card payments')
  assertContains(/vista «\{\{ BUDGET_BASIS_LABELS\[budgetBasis\] \}\}»/, 'the protected baseline must name the view it counts with')
})

function createGoalContributionHarness({ goal, sourceId = '', accounts = [], confirmed = true, failWrites = false }: {
  goal: Record<string, unknown>
  sourceId?: string
  accounts?: Array<Record<string, any>>
  confirmed?: boolean
  failWrites?: boolean
}) {
  const transactions: Array<Record<string, unknown>> = []
  const virtualContributions: Array<[string, number]> = []
  const goalAmountUpdates: Array<[string, number]> = []
  const toasts: Array<[string, string]> = []
  const confirms: Array<Record<string, unknown>> = []
  const notifications = {
    success(message: string) { toasts.push(['success', message]) },
    error(message: string) { toasts.push(['error', message]) },
    info(message: string) { toasts.push(['info', message]) },
    async confirm(options: Record<string, unknown>) { confirms.push(options); return confirmed }
  }
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
    showContributeModal: { value: true },
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
      async addTransaction(input: Record<string, unknown>) {
        if (failWrites) throw new Error('denied')
        transactions.push(input)
      }
    },
    goalsStore: {
      async contributeToGoal(id: string, amount: number) {
        if (failWrites) throw new Error('denied')
        virtualContributions.push([id, amount])
      },
      async updateGoalAmount(id: string, amount: number) { goalAmountUpdates.push([id, amount]) }
    },
    notifications,
    console: { error() {} },
    Date
  }
  const block = goalsView.match(/const handleContribute = async \(\) => \{[\s\S]*?(?=\n\/\/ Save budget)/)?.[0]
  assert.ok(block, 'Goals.vue must define the contribution handler')
  const javascript = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const run = new Function('ctx', `const {
    selectedGoal, selectedGoalAccount, contributeAccountId, contributeAmount, showContributeModal,
    activeWorkspaceId, accountsStore, isPocketRelatedAccount,
    isSavingsGoalAccountLinkable, hasGoalAccountLink, getGoalProgressAmount,
    canTransferBetweenAccounts, roundMoney,
    transactionsStore, goalsStore, notifications, console, Date
  } = ctx;
  ${javascript}
  return handleContribute();`)

  return { state, run, transactions, virtualContributions, goalAmountUpdates, toasts, confirms }
}

const contributionAccounts = (sourceBalance: number, sourceExtra: Record<string, unknown> = {}) => {
  const source = {
    id: 'source', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: sourceBalance,
    limit: 0, name: 'Source', createdAt: new Date(), ...sourceExtra
  }
  const target = {
    id: 'goal-account', workspaceId: 'workspace-a', type: 'savings', currency: 'COP', balance: 40,
    limit: 0, name: 'Goal account', createdAt: new Date()
  }
  return {
    goal: { id: 'linked-goal', linkedAccountId: target.id, currentAmount: 0, targetAmount: 100, currency: 'COP' },
    sourceId: source.id,
    accounts: [source, target]
  }
}

test('S7 T5b: a contribution larger than the source balance asks for a default-tone confirmation', async () => {
  const declined = createGoalContributionHarness({ ...contributionAccounts(10), confirmed: false })
  await declined.run(declined.state)
  assert.deepEqual(declined.confirms, [{
    title: 'Saldo insuficiente',
    message: 'El saldo de la cuenta es menor que el aporte. ¿Deseas continuar de todos modos?',
    confirmLabel: 'Aportar igualmente',
    tone: 'default'
  }])
  assert.deepEqual(declined.transactions, [], 'cancelling records nothing')
  assert.deepEqual(declined.toasts, [])
  assert.equal(declined.state.showContributeModal.value, true, 'the sheet stays open to adjust the amount')

  const accepted = createGoalContributionHarness({ ...contributionAccounts(10), confirmed: true })
  await accepted.run(accepted.state)
  assert.equal(accepted.transactions.length, 1, 'confirming records the transfer')
  assert.equal(accepted.state.showContributeModal.value, false)

  const covered = createGoalContributionHarness(contributionAccounts(100))
  await covered.run(covered.state)
  assert.deepEqual(covered.confirms, [], 'no confirmation when the balance covers the amount')
  assert.equal(covered.transactions.length, 1)
})

test('S7 T5b: contribution results and errors are toasts instead of alerts', async () => {
  const outcome = async (options: Parameters<typeof createGoalContributionHarness>[0]) => {
    const harness = createGoalContributionHarness(options)
    await harness.run(harness.state)
    return harness.toasts
  }
  const virtualGoal = { id: 'virtual-goal', currentAmount: 10, targetAmount: 100, currency: 'COP' }

  assert.deepEqual(await outcome({ goal: virtualGoal }), [['success', '¡Aporte virtual registrado sin modificar los saldos de tus cuentas!']])
  assert.deepEqual(await outcome(contributionAccounts(100)), [['success', '¡Aporte registrado como transferencia entre tus cuentas!']])
  assert.deepEqual(await outcome({ ...contributionAccounts(100), sourceId: 'missing' }),
    [['error', 'La cuenta vinculada o la cuenta de origen no están disponibles para esta transferencia.']])
  const pocket = contributionAccounts(10, { type: 'savings', parentAccountId: 'bank' })
  pocket.accounts.push({
    id: 'bank', workspaceId: 'workspace-a', type: 'checking', currency: 'COP', balance: 0,
    limit: 0, name: 'Bank', createdAt: new Date(), childAccountIds: ['source']
  } as (typeof pocket.accounts)[number])
  assert.deepEqual(await outcome(pocket),
    [['error', 'El saldo disponible de esta cuenta no alcanza para el aporte. No se registró ningún movimiento.']])
  for (const options of [{ goal: virtualGoal }, contributionAccounts(100)]) {
    assert.deepEqual(await outcome({ ...options, failWrites: true }), [['error', 'No se pudo registrar el aporte. Inténtalo de nuevo.']])
  }
})

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

// Render the real SFCs and RouterLinks without a browser, Firebase or a canvas backend.
class ViewNode {
  parent: ViewNode | null = null
  children: ViewNode[] = []
  props: Record<string, any> = {}
  tag: string
  text: string
  constructor(tag: string, text = '') { this.tag = tag; this.text = text }
  get content(): string { return (this.text + this.children.map(child => child.content).join('')).trim() }
  get descendants(): ViewNode[] { return this.children.flatMap(child => [child, ...child.descendants]) }
  focus() { focusedNode = this }
  get focused() { return focusedNode === this }
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
const syncInputValue = (node: ViewNode, { value }: { value: unknown }) => { node.props.value = value }
const MockSheet = (props: { open: boolean; title: string }, { slots }: Vue.SetupContext) =>
  props.open ? Vue.h('div', { role: 'dialog', 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null

const mountNavigation = async (t: import('node:test').TestContext, path: string, showSidebar = false) => {
  const account = { id: 'cash', name: 'Efectivo', type: 'cash', currency: 'COP', balance: 100 }
  const incomeSaves: number[] = []
  const limitSaves: [string, number][] = []
  let persistLimit = async () => {}
  const authStore = Vue.reactive({ isAuthenticated: true, user: { uid: 'user-a' }, activeWorkspaceId: 'workspace-a' })
  const pinia = createPinia()
  const db = {}
  const storeSource = readFileSync(new URL('../stores/workspacesStore.ts', import.meta.url), 'utf8')
  const script = ts.transpile(storeSource.replaceAll('import.meta.env', '({})'), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  })
  const storeModule = {} as typeof import('../stores/workspacesStore.ts')
  new Function('exports', 'require', script)(storeModule, (id: string) => {
    if (id === '@/lib/firebase') return { db, auth: {} }
    if (id === './authStore') return { useAuthStore: () => authStore }
    if (id === 'firebase/firestore') return {
      doc: (client: object, collection: string, workspaceId: string) => {
        assert.equal(client, db)
        assert.equal(collection, 'workspaces')
        return workspaceId
      },
      updateDoc: async (workspaceId: string, data: { expenseLimit: number }) => {
        assert.deepEqual(Object.keys(data), ['expenseLimit'])
        limitSaves.push([workspaceId, data.expenseLimit])
        await persistLimit()
      }
    }
    return requireModule(id.startsWith('@/') ? `../${id.slice(2)}.ts` : id)
  })
  const workspacesStore = storeModule.useWorkspacesStore(pinia)
  workspacesStore.workspaces = Object.entries({ 'workspace-a': 2500, 'workspace-b': 125 }).map(([id, expenseLimit]) => ({
    id, name: id, expenseLimit, currency: 'COP', ownerId: 'user-a', members: ['user-a'], createdAt: '2026-01-01'
  }))
  const notificationsStore = {
    toasts: [] as Array<[string, string]>,
    confirms: [] as Array<Record<string, unknown>>,
    confirmResult: true,
    success(message: string) { this.toasts.push(['success', message]) },
    error(message: string) { this.toasts.push(['error', message]) },
    info(message: string) { this.toasts.push(['info', message]) },
    async confirm(options: Record<string, unknown>) { this.confirms.push(options); return this.confirmResult }
  }
  const stores = {
    authStore,
    // Reactive like the real store: the main currency can arrive after a view is mounted.
    settingsStore: Vue.reactive({ currency: 'COP', loadSettings: noOp }),
    notificationsStore,
    workspacesStore,
    accountsStore: { accounts: [account], netWorthByCurrency: { COP: 100 }, getAccountById: () => account, fetchAccounts: noOp },
    transactionsStore: Vue.reactive({ transactions: [] as Transaction[], categories: [], fetchCategories: noOp, fetchTransactions: noOp }),
    goalsStore: Vue.reactive({
      goals: [{ id: 'trip', name: 'Viaje', targetAmount: 100, currentAmount: 25, currency: 'COP', targetDate: new Date(2030, 0, 1) }],
      categoryBudgets: { food: 100 }, categoryBudgetCurrency: { status: 'confirmed', code: 'COP' },
      operatingBudgets: [], exchangeRates: {}, convertToPrimary: (amount: number) => amount,
      budgetIncome: 100,
      budgetSettingsContextKey: JSON.stringify(['user-a', 'workspace-a']),
      fetchGoals: noOp, loadBudgetSettings: noOp,
      async saveBudgetIncome(amount: number) { incomeSaves.push(amount); this.budgetIncome = amount }
    })
  }
  const loadComponent = (file: string) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename: file })
    assert.deepEqual(errors, [])
    const { content } = compileScript(descriptor, { id: file, inlineTemplate: true })
    const script = ts.transpile(content, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS })
    const exports = {} as { default: Vue.Component }
    new Function('exports', 'require', script)(exports, (id: string) => {
      if (id === 'vue') return {
        ...Vue, Transition: (_: unknown, { slots }: Vue.SetupContext) => slots.default?.(),
        vModelText: { mounted: syncInputValue, beforeUpdate: syncInputValue }, vModelSelect: {}
      }
      if (id === 'vue-router') return Router
      if (id === 'chart.js') return { Chart: class { static register = noOp; destroy = noOp }, registerables: [] }
      if (id === '@/lib/analytics') return { track: noOp }
      if (id === '@/components/ui/useBodyScrollLock') return { useBodyScrollLock: noOp }
      if (id === '@/composables/useWorkspaceActivation') return { activateWorkspace: noOp }
      if (id.endsWith('/BaseSheet.vue')) return { default: MockSheet }
      if (id.endsWith('/BudgetBasisSwitch.vue')) return { default: () => Vue.h('div', 'Consumo del mes / Pagos del mes') }
      if (id === '@/components/MonthPicker.vue') return { default: loadComponent('../components/MonthPicker.vue') }
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
      disposePinia(pinia)
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
  return { root, router, stepHistory, stores, incomeSaves, limitSaves, setLimitPersistence: (persist: typeof persistLimit) => { persistLimit = persist } }
}

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('P1 S3: the base monthly budget hydrates, validates, saves and disables its existing limit', async t => {
  const { root, router, stores, limitSaves, setLimitPersistence } = await mountNavigation(t, '/goals')
  const label = root.find('label', 'Tope total del presupuesto mensual base')
  const input = root.descendants.find(node => node.tag === 'input' && node.props.id === label.props.for)!
  const form = input.parent!.closest('#base-expense-limit-form')!
  const button = form.find('button', 'Guardar tope')
  const edit = (value: number | string) => input.props['onUpdate:modelValue'](value)
  const submit = () => form.props.onSubmit({ preventDefault() {} })
  assert.equal(input.props.value, 2500)
  assert.match(form.content, /COP/)
  assert.deepEqual(limitSaves, [], 'loading the saved amount does not write it')

  stores.workspacesStore.loading = true
  await Vue.nextTick()
  assert.equal(input.props.disabled, true)
  assert.equal(button.props.disabled, true)
  await submit()
  stores.workspacesStore.loading = false
  for (const value of [-1, Infinity]) {
    edit(value)
    await submit()
    assert.match(form.descendants.find(n => n.props.role === 'alert')?.content ?? '', /monto válido/)
  }
  assert.deepEqual(limitSaves, [])

  edit(300.5)
  const pending = deferred()
  setLimitPersistence(() => pending.promise)
  const save = submit()
  await Vue.nextTick()
  assert.equal(button.props.disabled, true)
  assert.match(button.content, /Guardando/)
  pending.resolve()
  await save
  await Vue.nextTick()
  assert.deepEqual(limitSaves, [['workspace-a', 300.5]])
  assert.equal(stores.workspacesStore.workspaces[0].expenseLimit, 300.5)
  assert.match(form.content, /Tope mensual actualizado/)

  for (const value of ['', 0]) {
    edit(value)
    await submit()
    await Vue.nextTick()
    assert.equal(input.props.value, '')
    assert.match(form.content, /Tope mensual desactivado/)
  }
  assert.deepEqual(limitSaves.slice(1), [['workspace-a', 0], ['workspace-a', 0]])

  const failed = deferred()
  setLimitPersistence(() => failed.promise)
  edit(999)
  const rejectedSave = submit()
  failed.reject(new Error('Prueba: no se pudo guardar.'))
  await rejectedSave
  await Vue.nextTick()
  assert.equal(input.props.value, 999)
  assert.equal(stores.workspacesStore.workspaces[0].expenseLimit, 0)
  assert.equal(input.props.disabled, false, 'the lock is released after a failed write')
  assert.equal(form.descendants.find(n => n.props.role === 'alert')?.content, 'Prueba: no se pudo guardar.')
  stores.authStore.activeWorkspaceId = 'unresolved-workspace'
  await Vue.nextTick()
  assert.equal(input.props.disabled, true)
  assert.equal(input.props.value, '')
  await submit()
  assert.equal(limitSaves.length, 4)
  await router.push('/goals?tab=savings')
  assert.ok(!root.descendants.some(node => node.props.id === input.props.id))
})

test('P1 S3: an in-flight save cannot overwrite the active workspace draft or its feedback', async t => {
  const { root, stores, limitSaves, setLimitPersistence } = await mountNavigation(t, '/goals')
  const form = root.descendants.find(node => node.props.id === 'base-expense-limit-form')!
  assert.ok(form, 'the base budget has the workspace limit editor')
  const input = form.descendants.find(node => node.tag === 'input')!
  const submit = () => form.props.onSubmit({ preventDefault() {} })
  for (const succeeds of [true, false]) {
    stores.authStore.activeWorkspaceId = 'workspace-a'
    await Vue.nextTick()
    input.props['onUpdate:modelValue'](305)
    const pending = deferred()
    setLimitPersistence(() => pending.promise)
    const save = submit()
    stores.authStore.activeWorkspaceId = 'workspace-b'
    await Vue.nextTick()
    assert.equal(input.props.value, 125)
    assert.equal(input.props.disabled, false)
    input.props['onUpdate:modelValue'](140)
    if (succeeds) pending.resolve()
    else pending.reject(new Error('Respuesta de otro workspace'))
    await save
    await Vue.nextTick()
    assert.equal(input.props.value, 140)
    assert.doesNotMatch(form.content, /actualizado|Respuesta de otro workspace/)
  }
  assert.deepEqual(limitSaves, [['workspace-a', 305], ['workspace-a', 305]])
  assert.equal(stores.workspacesStore.workspaces[1].expenseLimit, 125)

  stores.authStore.activeWorkspaceId = 'workspace-a'
  await Vue.nextTick()
  input.props['onUpdate:modelValue'](350)
  const pending = deferred()
  setLimitPersistence(() => pending.promise)
  const save = submit()
  stores.authStore.activeWorkspaceId = 'workspace-b'
  stores.authStore.activeWorkspaceId = 'workspace-a'
  await Vue.nextTick()
  assert.equal(input.props.value, 305, 'returning to A hydrates its last saved amount, not the discarded draft')
  assert.equal(input.props.disabled, true)
  await submit()
  assert.equal(limitSaves.length, 3, 'a quick return cannot start a second write to the same workspace')
  pending.resolve()
  await save
  await Vue.nextTick()
  assert.equal(input.props.value, 350, 'A receives its authoritative saved value without old feedback')
  assert.doesNotMatch(form.content, /actualizado/)
})

test('P1 S3 blocks a stale base-limit submit after a remount', async t => {
  const { root, router, stores, limitSaves, setLimitPersistence } = await mountNavigation(t, '/goals')
  const editor = () => root.descendants.find(node => node.props.id === 'base-expense-limit-form')
  const submit = (form: ViewNode) => form.props.onSubmit({ preventDefault() {} })
  const initialForm = editor()!
  initialForm.descendants.find(node => node.tag === 'input')!.props['onUpdate:modelValue'](700)
  const gate = deferred()
  setLimitPersistence(() => gate.promise)
  const firstSave = submit(initialForm)
  try {
    await router.push('/')
    await Vue.nextTick()
    assert.equal(editor(), undefined)
    await router.push('/goals')
    await Vue.nextTick()
    const remounted = editor()!
    assert.notEqual(remounted, initialForm)
    const input = remounted.descendants.find(node => node.tag === 'input')!
    const button = remounted.descendants.find(node => node.props.type === 'submit' && node.tag === 'button')!
    assert.equal(input.props.value, 2500, 'the first write is still pending')
    const disabledWhilePending = [input.props.disabled, button.props.disabled]
    const staleAttempt = submit(remounted)
    gate.resolve()
    await Promise.all([firstSave, staleAttempt])
    await Vue.nextTick()
    assert.deepEqual(limitSaves, [['workspace-a', 700]], 'returning to a pending editor must not write the stale cap again')
    assert.deepEqual(disabledWhilePending, [true, true])
    assert.equal(input.props.value, 700)
    assert.equal(input.props.disabled, false)
    assert.equal(button.props.disabled, false)
    assert.doesNotMatch(remounted.content, /Tope mensual actualizado/)
  } finally {
    gate.resolve()
    await firstSave
  }

  // The store also rejects concurrent callers that bypass the form, but only for the same workspace.
  const next = deferred()
  setLimitPersistence(() => next.promise)
  const updateLimit = stores.workspacesStore.updateWorkspaceLimit
  const writes = [updateLimit('workspace-a', 800), updateLimit('workspace-b', 200)]
  const duplicate = assert.rejects(updateLimit('workspace-a', 2500), /Ya se está guardando el tope/)
  next.resolve()
  await Promise.all([...writes, duplicate])
  assert.deepEqual(limitSaves, [['workspace-a', 700], ['workspace-a', 800], ['workspace-b', 200]])
})

test('P1 S3: Dashboard compares only base expenses while the monthly headline and forecast still include other budgets', async t => {
  const { root, stores } = await mountNavigation(t, '/')
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), 1)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const projected = (spent: number) => Math.round((spent / now.getDate()) * daysInMonth)
  const expense = (id: string, amount: number, budgetId?: string, categoryId = 'food'): Transaction => ({
    id, workspaceId: stores.authStore.activeWorkspaceId, type: 'expense', amount: -amount, date, budgetId,
    categoryId, accountId: 'cash', currency: 'COP', description: id, createdAt: date
  })
  stores.transactionsStore.transactions.push(
    expense('implicit', 20), expense('base', 30, 'default-monthly', 'other'),
    expense('monthly', 1000, 'extra-monthly'), expense('event', 1000, 'event'), expense('archived', 1000, 'archived-event')
  )
  await Vue.nextTick()

  const format = (amount: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(amount)
  assert.equal(root.find('span', 'Gastos imputados del Mes').parent!.descendants.find(node => node.tag === 'h4')?.props.title, format(3050))
  assert.equal(root.find('span', 'Proyección de cierre').parent!.descendants.find(node => node.tag === 'h4')?.props.title, format(projected(3050)))
  const progress = root.find('span', `Tope del presupuesto mensual base: ${format(2500)}`)
  assert.equal(progress.parent!.children.at(-1)?.content, '2%')
  const amounts = (label: ViewNode) => label.parent!.children.at(-1)?.children.filter(node => node.tag === 'span').map(node => node.content)
  assert.deepEqual(amounts(root.find('span', 'Tope del presupuesto mensual base')), [format(projected(50)), format(2500)])
  const categoryProjection = root.descendants.find(node => node.tag === 'span' && node.content.endsWith('Categorías con presupuesto'))
  assert.ok(categoryProjection)
  assert.deepEqual(amounts(categoryProjection), [format(projected(20)), format(100)])
})

test('P1 S2: budgets retain the estimated income editor and save its value in the current workspace', async t => {
  const { root, router, stores, incomeSaves } = await mountNavigation(t, '/goals')
  const budgetInputs = () => root.descendants.filter(node => node.tag === 'input')
  assert.ok(!budgetInputs().some(node => node.props.type === 'range'), 'the planner sliders must be gone')
  assert.ok(!root.descendants.some(node => node.tag === 'canvas'))
  assert.doesNotMatch(root.content, /Plan de Presupuesto|50\/30\/20|vs este mes \(real\)/)
  const label = root.find('label', 'Ingreso mensual estimado')
  const income = budgetInputs().find(node => node.props.id === label.props.for && node.props.type === 'number')
  assert.ok(income, 'the label must name the editable amount')
  assert.equal(root.descendants.filter(node => node.tag === 'label' && node.content === label.content).length, 1)
  assert.equal(income.props.value, 100)
  assert.ok(!income.props.disabled)
  assert.match(income.parent!.content, /COP/)

  const changeIncome = async (value: number | string, valid = true) => {
    income.props['onUpdate:modelValue'](value)
    await income.props.onChange({ target: { validity: { valid } } })
    await Vue.nextTick()
  }
  await changeIncome(-1, false)
  assert.deepEqual(incomeSaves, [])
  assert.ok(root.descendants.some(node => node.props.role === 'alert' && node.content === 'Ingresa un monto mayor o igual a 0.'))
  await changeIncome(275.5)
  await changeIncome('')
  assert.deepEqual(incomeSaves, [275.5, 0], 'decimals are kept and clearing the amount stores zero')

  stores.authStore.activeWorkspaceId = 'workspace-b'
  await Vue.nextTick()
  assert.equal(income.props.disabled, true)
  assert.equal(income.props.value, '')
  stores.goalsStore.budgetSettingsContextKey = JSON.stringify(['user-a', 'workspace-b'])
  stores.goalsStore.budgetIncome = 120
  await Vue.nextTick()
  assert.ok(!income.props.disabled)
  assert.equal(income.props.value, 120)

  await router.push('/goals?tab=savings')
  assert.ok(!root.descendants.some(node => node.tag === 'label' && node.content === label.content))
})

test('P1 S1: section links follow direct URLs and history, with separate workflows', async t => {
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
    assert.ok(nodes().some(node => node.props['data-testid'] === 'goals-budget-basis'))
    assert.ok(!nodes().some(node => node.props['aria-label'] === 'Aportar saldo' || node.content === 'Nuevo Objetivo'))
  }
  assertBudgets()
  await root.find('button', 'Nuevo presupuesto').click()
  assert.ok(nodes().some(node => node.props.id === 'operating-budget-form'))
  await stepHistory(-1)
  assertSavings()
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

test('S7 T5b: deleting a goal asks for a danger confirmation and reports a failure with a toast', async t => {
  const { root, stores } = await mountNavigation(t, '/goals?tab=savings')
  const notifications = stores.notificationsStore
  const deletions: string[] = []
  let failDelete = false
  Object.assign(stores.goalsStore, {
    async deleteGoal(id: string) {
      if (failDelete) throw new Error('denied')
      deletions.push(id)
    }
  })
  const deleteButton = () => root.descendants.find(node => node.props['aria-label'] === 'Eliminar meta')!

  notifications.confirmResult = false
  await deleteButton().click()
  assert.deepEqual(deletions, [], 'cancelling keeps the goal')
  assert.deepEqual(notifications.confirms, [{
    title: '¿Eliminar esta meta?',
    message: 'Esta acción no se puede deshacer. Tus cuentas y movimientos no cambian.',
    confirmLabel: 'Eliminar',
    tone: 'danger'
  }])

  notifications.confirmResult = true
  await deleteButton().click()
  assert.deepEqual(deletions, ['trip'])
  assert.deepEqual(notifications.toasts, [])

  failDelete = true
  await deleteButton().click()
  assert.deepEqual(notifications.toasts, [['error', 'No se pudo eliminar la meta de ahorro. Inténtalo de nuevo.']])
})

const fillNewGoal = async (root: ViewNode, currency?: string) => {
  const byId = (id: string) => root.descendants.find(node => node.props.id === id)!
  await root.find('button', 'Nuevo Objetivo').click()
  byId('goal-name').props['onUpdate:modelValue']('Fondo')
  byId('goal-target').props['onUpdate:modelValue'](500)
  byId('goal-date').props['onUpdate:modelValue']('2030-01-01')
  if (currency) byId('goal-currency').props['onUpdate:modelValue'](currency)
  await byId('create-goal-form').props.onSubmit({ preventDefault() {} })
  await Vue.nextTick()
}

test('S7 T5b: a new goal starts in the main currency, even when it loads late, until the user picks another', async t => {
  const { root, stores } = await mountNavigation(t, '/goals?tab=savings')
  const created: Array<Record<string, unknown>> = []
  Object.assign(stores.goalsStore, { async addGoal(goal: Record<string, unknown>) { created.push(goal) } })
  // The user's main currency arrives after the view mounted.
  stores.settingsStore.currency = 'EUR'
  await root.find('button', 'Nuevo Objetivo').click()
  const currencySelect = root.descendants.find(node => node.props.id === 'goal-currency')!
  assert.deepEqual(
    currencySelect.descendants.filter(node => node.tag === 'option').map(node => node.props.value),
    ['COP', 'MXN', 'EUR', 'USD', 'CLP', 'ARS', 'PEN'],
    'every supported main currency can be chosen'
  )

  await fillNewGoal(root)
  await fillNewGoal(root, 'USD')
  await fillNewGoal(root)
  assert.deepEqual(created.map(goal => goal.currency), ['EUR', 'USD', 'EUR'], 'a reset form returns to the main currency')
})

test('S7 T5b: a goal that cannot be created keeps the form open and shows an error toast', async t => {
  const { root, stores } = await mountNavigation(t, '/goals?tab=savings')
  Object.assign(stores.goalsStore, { async addGoal() { throw new Error('denied') } })
  await fillNewGoal(root)
  assert.deepEqual(stores.notificationsStore.toasts, [['error', 'No se pudo crear la meta de ahorro. Inténtalo de nuevo.']])
  assert.ok(root.descendants.some(node => node.props.id === 'create-goal-form'))
})

test('S7 T5b: goal amounts and dates use the es-CO format with the main currency as fallback', async t => {
  const { root, stores } = await mountNavigation(t, '/goals?tab=savings')
  const money = (amount: number, currency: string) => new Intl.NumberFormat('es-CO', {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2
  }).format(amount)
  stores.settingsStore.currency = 'EUR'
  stores.goalsStore.goals.push(
    { id: 'usd', name: 'Viaje USD', targetAmount: 1234.5, currentAmount: 0, currency: 'USD', targetDate: new Date(2030, 0, 1) },
    { id: 'legacy', name: 'Sin moneda', targetAmount: 300, currentAmount: 0, currency: '', targetDate: new Date(2030, 0, 1) }
  )
  await Vue.nextTick()

  const titles = new Set(root.descendants.map(node => node.props.title))
  for (const expected of [money(100, 'COP'), money(1234.5, 'USD'), money(300, 'EUR')]) {
    assert.ok(titles.has(expected), `expected an amount shown as ${JSON.stringify(expected)}`)
  }
  const dueDate = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(2030, 0, 1))
  root.find('p', `Meta: ${dueDate}`)

  // The contribution amount shows the same currency symbol as the formatted amounts.
  const contributeButtons = root.descendants.filter(node => node.props['aria-label'] === 'Aportar saldo')
  const amountPrefix = async (index: number) => {
    await contributeButtons[index].click()
    const input = root.descendants.find(node => node.props.id === 'contribute-amount')!
    return [input.parent!.children.find(node => node.tag === 'span')?.content, input.props.class]
  }
  assert.deepEqual(await amountPrefix(0), ['$', 'field font-semibold pl-8'])
  assert.deepEqual(await amountPrefix(1), ['US$', 'field font-semibold pl-14'])
})

test('S7 T5b: a category limit that cannot be saved shows an error toast and keeps the typed amount', async t => {
  t.mock.method(console, 'error', () => undefined)
  const { root, stores } = await mountNavigation(t, '/goals')
  ;(stores.transactionsStore.categories as unknown[]).push({ id: 'food', name: 'Comida', type: 'expense', icon: 'Utensils', color: '#f97316' })
  await Vue.nextTick()
  const saved: unknown[] = []
  Object.assign(stores.goalsStore, {
    async saveBudgetSettings(settings: { categoryBudgets: unknown }) {
      saved.push(settings.categoryBudgets)
      throw new Error('denied')
    }
  })
  const input = root.descendants.find(node => node.props.id === 'base-cap-food')
  assert.ok(input, 'the category with a limit has its editor')
  await input.props.onChange({ target: { value: '150' } })
  await Vue.nextTick()
  assert.deepEqual(saved, [{ food: 150 }])
  assert.deepEqual(stores.notificationsStore.toasts, [['error', 'No se pudo guardar el límite de Comida. Inténtalo de nuevo.']])
  assert.equal(input.props.value, 150, 'the typed amount stays on screen, as before')
})

// --- S9 T7b: Presupuestos follows the selected month (?mes=YYYY-MM, shared with the Dashboard) ---

// "Today" is 15 March 2026 and February 2026 is the past month. Vacaciones is a monthly budget
// funded and spent in both months; Boda is an event budget funded in January and spent in both.
// The base budget spends on food in both months, on travel only in February and on tech only in March.
const T7B_NOW = new Date(2026, 2, 15, 12)
const PAST_MONTH_NOTICE = 'Los topes, la configuración de tarjetas y las tasas de cambio son los actuales.'
const copMoney = (amount: number) => new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2
}).format(amount)

const mountBudgetMonths = async (t: import('node:test').TestContext, path: string) => {
  t.mock.timers.enable({ apis: ['Date'], now: T7B_NOW.getTime() })
  const view = await mountNavigation(t, path)
  const { stores } = view
  const movement = (id: string, type: 'income' | 'expense', amount: number, date: Date, extra: Partial<Transaction> = {}): Transaction => ({
    id, workspaceId: 'workspace-a', type, amount: type === 'expense' ? -amount : amount, date,
    accountId: 'cash', currency: 'COP', description: id, createdAt: date, ...extra
  } as Transaction)
  stores.transactionsStore.categories = ['food', 'travel', 'tech'].map(id =>
    ({ id, name: id, type: 'expense', icon: 'Utensils', color: '#f97316', workspaceId: null })) as never
  stores.goalsStore.operatingBudgets = [
    { budget: { id: 'vacaciones', name: 'Vacaciones', kind: 'monthly', capCurrency: 'COP', totalLimit: 200, archived: false }, categoryCaps: {} },
    { budget: { id: 'boda', name: 'Boda', kind: 'event', capCurrency: 'COP', totalLimit: 2000, archived: false }, categoryCaps: {} }
  ] as never
  stores.transactionsStore.transactions.push(
    movement('vacaciones-feb-in', 'income', 300, new Date(2026, 1, 12, 12), { budgetId: 'vacaciones' }),
    movement('vacaciones-mar-in', 'income', 500, new Date(2026, 2, 5, 12), { budgetId: 'vacaciones' }),
    movement('vacaciones-feb', 'expense', 120, new Date(2026, 1, 20, 12), { budgetId: 'vacaciones', categoryId: 'travel' }),
    movement('vacaciones-mar', 'expense', 50, new Date(2026, 2, 3, 12), { budgetId: 'vacaciones', categoryId: 'travel' }),
    movement('boda-in', 'income', 1000, new Date(2026, 0, 10, 12), { budgetId: 'boda' }),
    movement('boda-feb', 'expense', 400, new Date(2026, 1, 14, 12), { budgetId: 'boda', categoryId: 'food' }),
    movement('boda-mar', 'expense', 100, new Date(2026, 2, 1, 12), { budgetId: 'boda', categoryId: 'food' }),
    movement('food-feb', 'expense', 200, new Date(2026, 1, 3, 12), { categoryId: 'food' }),
    movement('food-mar', 'expense', 70, new Date(2026, 2, 2, 12), { categoryId: 'food' }),
    movement('travel-feb', 'expense', 40, new Date(2026, 1, 28, 20), { categoryId: 'travel' }),
    movement('tech-mar', 'expense', 30, new Date(2026, 2, 4, 12), { categoryId: 'tech' })
  )
  await Vue.nextTick()
  const settle = async () => {
    await new Promise(setImmediate)
    await Vue.nextTick()
  }
  const goTo = async (to: string) => {
    await view.router.push(to)
    await settle()
  }
  const budgetCard = (name: string) => {
    let node: ViewNode | null = view.root.find('h4', name)
    while (node && node.tag !== 'article') node = node.parent
    const progress = node?.descendants.find(child => child.props['data-testid'] === 'budget-card-progress')
    assert.ok(progress, `expected the ${name} budget card`)
    return progress
  }
  const baseRows = () => view.root.descendants
    .filter(node => node.tag === 'input' && String(node.props.id ?? '').startsWith('base-cap-'))
    .map(input => [String(input.props.id).slice('base-cap-'.length), input.parent!.parent!.content] as const)
  const byTestId = (id: string) => view.root.descendants.filter(node => node.props['data-testid'] === id)
  const pickerLabel = () => byTestId('month-picker')[0]?.descendants.find(node => node.props['aria-live'] === 'polite')?.content
  const button = (label: string) => {
    const node = view.root.descendants.find(node => node.tag === 'button' && (node.props['aria-label'] === label || node.content === label))
    assert.ok(node, `expected a "${label}" button`)
    return node
  }
  return { ...view, settle, goTo, budgetCard, baseRows, byTestId, pickerLabel, button, fullPath: () => view.router.currentRoute.value.fullPath }
}

test('S9 T7b: monthly budget cards count the selected month', async t => {
  const view = await mountBudgetMonths(t, '/goals?mes=2026-02')
  const assertCard = (spent: number, funds: number, percent: number, available: number) => {
    const card = view.budgetCard('Vacaciones')
    assert.ok(card.content.includes(`Gastado ${copMoney(spent)} de ${copMoney(funds)} en fondos · ${percent} %`), card.content)
    assert.ok(card.content.includes(`${copMoney(spent)} / ${copMoney(200)}`), card.content)
    assert.ok(card.descendants.some(node => node.props.title === copMoney(available)), `available ${available}: ${card.content}`)
  }
  assertCard(120, 300, 40, 180)
  await view.goTo('/goals')
  assertCard(50, 500, 10, 450)
})

test('S9 T7b: the base category limits and the categories listed follow the selected month', async t => {
  const view = await mountBudgetMonths(t, '/goals?mes=2026-02')
  const rows = () => Object.fromEntries(view.baseRows())
  assert.deepEqual(Object.keys(rows()), ['food', 'travel'], 'February lists the limited category and the one spent in February')
  assert.ok(rows().food.includes(`Gastado en COP: ${copMoney(200)}`), rows().food)
  assert.match(rows().food, /200% · ¡Excedido!/)
  assert.ok(rows().travel.includes(`Gastado en COP: ${copMoney(40)}`), rows().travel)

  await view.goTo('/goals')
  assert.deepEqual(Object.keys(rows()), ['food', 'tech'], 'March lists the limited category and the one spent in March')
  assert.ok(rows().food.includes(`Gastado en COP: ${copMoney(70)}`), rows().food)
  assert.match(rows().food, /70%/)
  assert.ok(rows().tech.includes(`Gastado en COP: ${copMoney(30)}`), rows().tech)

  // Suggestions for setting up limits guide today's setup, so they stay based on today's spending.
  assert.match(goalsView, /const baselineSuggestedCategories = computed\(\(\) => suggestCategoriesBySpending\(\{[\s\S]*?now: new Date\(\),/)
  assert.match(goalsView, /const budgetSuggestedCategories = computed\(\(\) => suggestCategoriesBySpending\(\{[\s\S]*?now: new Date\(\),/)
})

test('S9 T7b: event budgets keep their lifetime totals in every month', async t => {
  const view = await mountBudgetMonths(t, '/goals')
  const march = view.budgetCard('Boda').content
  assert.ok(march.includes(`Gastado ${copMoney(500)} de ${copMoney(1000)} en fondos · 50 %`), march)
  assert.ok(march.includes(`${copMoney(500)} / ${copMoney(2000)}`), march)
  for (const month of ['2026-02', '2026-01']) {
    await view.goTo(`/goals?mes=${month}`)
    assert.equal(view.budgetCard('Boda').content, march, `${month} shows the same event totals`)
  }
})

test('S9 T7b: the month picker is only in Presupuestos and the month survives switching sections', async t => {
  const view = await mountBudgetMonths(t, '/goals')
  const sectionHref = (label: string) => view.root.find('a', label).props.href
  assert.equal(view.byTestId('month-picker').length, 1)
  assert.equal(view.pickerLabel(), 'marzo de 2026')
  assert.equal(view.button('Mes siguiente').props.disabled, true)
  assert.equal(sectionHref('Metas de ahorro'), '/goals?tab=savings')
  assert.equal(sectionHref('Presupuestos'), '/goals')

  await view.button('Mes anterior').click()
  await view.settle()
  assert.equal(view.fullPath(), '/goals?mes=2026-02')
  assert.equal(view.pickerLabel(), 'febrero de 2026')
  assert.equal(sectionHref('Metas de ahorro'), '/goals?tab=savings&mes=2026-02')
  assert.equal(sectionHref('Presupuestos'), '/goals?mes=2026-02')

  await view.root.find('a', 'Metas de ahorro').click()
  await view.settle()
  assert.equal(view.fullPath(), '/goals?tab=savings&mes=2026-02')
  view.root.find('h2', 'Metas de ahorro')
  assert.deepEqual(view.byTestId('month-picker'), [], 'savings goals have no month')
  assert.deepEqual(view.byTestId('goals-past-month-notice'), [])

  await view.root.find('a', 'Presupuestos').click()
  await view.settle()
  assert.equal(view.fullPath(), '/goals?mes=2026-02')
  assert.equal(view.pickerLabel(), 'febrero de 2026')
  await view.button('Mes siguiente').click()
  await view.settle()
  assert.equal(view.fullPath(), '/goals')
})

test('S9 T7b: a past month says which month is shown and keeps every budget editor available', async t => {
  const view = await mountBudgetMonths(t, '/goals?mes=2026-02')
  const [notice] = view.byTestId('goals-past-month-notice')
  assert.ok(notice, 'a past month shows the notice')
  assert.equal(notice.props.role, 'status')
  assert.match(notice.content, /^Estás viendo\s*febrero de 2026/)
  assert.equal(notice.descendants.find(node => node.tag === 'strong')?.content, 'febrero de 2026')
  assert.equal(view.root.content.split(PAST_MONTH_NOTICE).length - 1, 1, 'today\'s limits, card setting and rates are mentioned once')

  // Budget settings are not per month: editing stays available in a past month.
  const input = (id: string) => view.root.descendants.find(node => node.tag === 'input' && node.props.id === id)
  for (const id of ['base-expense-limit', 'estimated-monthly-income', 'base-cap-food']) {
    assert.ok(input(id), `${id} is shown`)
    assert.ok(!input(id)!.props.disabled, `${id} stays editable`)
  }
  assert.ok(view.root.descendants.some(node => node.tag === 'button' && node.content === 'Nuevo presupuesto'))
  assert.ok(view.root.descendants.some(node => node.tag === 'button' && node.content === 'Editar presupuesto'))
  assert.ok(!view.button('Guardar tope').props.disabled)

  await view.button('Volver al mes actual').click()
  await view.settle()
  assert.equal(view.fullPath(), '/goals')
  assert.deepEqual(view.byTestId('goals-past-month-notice'), [])
  assert.doesNotMatch(view.root.content, new RegExp(PAST_MONTH_NOTICE))
  assert.equal(view.pickerLabel(), 'marzo de 2026')
})

// Hand-computed budgets of the month before "today" (mocked); every date is relative to "today".
// Visa closes on the 20th and is paid on the 5th; a 900,000 purchase in three installments puts
// 300,000 in the shown month. Rows of "today's" month must not count.
const LAST_MONTH_TODAY = new Date(2026, 10, 25, 12)
const lastMonthMovements = (today: Date): Transaction[] => {
  const at = (monthOffset: number, day: number, hours = 12, minutes = 0) =>
    new Date(today.getFullYear(), today.getMonth() + monthOffset, day, hours, minutes)
  const lastDayOf = (monthOffset: number, hours: number) => at(monthOffset + 1, 0, hours)
  const [shown, previous, earlier, current] = [-1, -2, -3, 0]
  const movement = (id: string, type: string, amount: number, date: Date, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: 'workspace-a', type, amount, date, currency: 'COP', description: id, installments: 1,
    accountId: 'cash', userId: 'user-a', categoryId: '', createdAt: date, ...extra
  }) as unknown as Transaction
  return [
    movement('I1', 'income', 4_000_000, at(shown, 3)),
    movement('I2', 'income', 500_000, at(shown, 15), { budgetId: 'viaje' }),
    movement('I3', 'income', 3_000_000, lastDayOf(previous, 23)),
    movement('I4', 'income', 9_999_999, at(current, 2)),
    movement('E1', 'expense', -200_000, at(shown, 1, 0, 30), { categoryId: 'food' }),
    movement('E2', 'expense', -100_000, lastDayOf(shown, 22), { categoryId: 'transport' }),
    movement('E3', 'expense', -150_000, at(shown, 12), { categoryId: 'travel', budgetId: 'viaje' }),
    movement('E4', 'expense', -80_000, at(previous, 10), { categoryId: 'food' }),
    movement('E5', 'expense', -7_777_777, at(current, 3), { categoryId: 'food' }),
    movement('E6', 'expense', -600_000, at(shown, 20), { categoryId: 'gifts', budgetId: 'boda' }),
    movement('C1', 'expense', -300_000, at(previous, 10), { categoryId: 'food', accountId: 'visa' }),
    movement('C2', 'expense', -120_000, at(previous, 25), { categoryId: 'food', accountId: 'visa' }),
    movement('C3', 'expense', -900_000, at(earlier, 5), { categoryId: 'tech', accountId: 'visa', installments: 3 }),
    movement('C4', 'expense', -50_000, at(shown, 18), { categoryId: 'food', accountId: 'visa', budgetId: 'viaje' }),
    movement('C5', 'expense', -40_000, at(shown, 25), { categoryId: 'food', accountId: 'visa' }),
    movement('P0', 'transfer', 300_000, at(previous, 5), { toAccountId: 'visa' }),
    movement('P1', 'transfer', 500_000, at(shown, 5), { toAccountId: 'visa' }),
    movement('P2', 'transfer', 300_000, at(shown, 28), { toAccountId: 'visa' })
  ]
}
const monthKeyFrom = (today: Date, offset: number) => {
  const month = new Date(today.getFullYear(), today.getMonth() + offset, 1)
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
}

const mountLastMonthBudgets = async (t: import('node:test').TestContext, path: string, basis: 'consumption' | 'payment') => {
  t.mock.timers.enable({ apis: ['Date'], now: LAST_MONTH_TODAY.getTime() })
  const view = await mountNavigation(t, path)
  const { stores } = view
  ;(stores.accountsStore.accounts as unknown[]).push(
    { id: 'visa', name: 'Visa', type: 'credit', currency: 'COP', balance: -310_000, limit: 5_000_000, statementClosingDay: 20, paymentDueDay: 5 })
  ;(stores.workspacesStore.workspaces[0] as Record<string, unknown>).budgetCardBasis = basis
  stores.goalsStore.categoryBudgets = { food: 300_000 }
  stores.transactionsStore.categories = ['food', 'transport', 'travel', 'gifts', 'tech'].map(id =>
    ({ id, name: id, type: 'expense', icon: 'Utensils', color: '#f97316', workspaceId: null })) as never
  stores.goalsStore.operatingBudgets = [
    { budget: { id: 'viaje', name: 'Viaje', kind: 'monthly', capCurrency: 'COP', totalLimit: 400_000, archived: false }, categoryCaps: { travel: 100_000 } },
    { budget: { id: 'boda', name: 'Boda', kind: 'event', capCurrency: 'COP', totalLimit: 2_000_000, archived: false }, categoryCaps: {} },
    { budget: { id: 'old', name: 'Viejo', kind: 'monthly', capCurrency: 'COP', totalLimit: 100, archived: true }, categoryCaps: {} }
  ] as never
  stores.transactionsStore.transactions.push(...lastMonthMovements(LAST_MONTH_TODAY))
  const settle = async () => {
    await new Promise(setImmediate)
    await Vue.nextTick()
  }
  await settle()
  await settle()
  const card = (name: string) => {
    let node: ViewNode | null = view.root.find('h4', name)
    while (node && node.tag !== 'article') node = node.parent
    assert.ok(node, `expected the ${name} budget card`)
    return node.content
  }
  const baseRows = (): Record<string, string> => Object.fromEntries(view.root.descendants
    .filter(node => node.tag === 'input' && String(node.props.id ?? '').startsWith('base-cap-'))
    .map(input => [String(input.props.id).slice('base-cap-'.length), input.parent!.parent!.content]))
  return { ...view, settle, card, baseRows }
}

test('S9: Presupuestos of a past month match the hand computation under "Consumo del mes" and "Pagos del mes"', async t => {
  const shownMonth = monthKeyFrom(LAST_MONTH_TODAY, -1)
  const consumption = await mountLastMonthBudgets(t, `/goals?mes=${shownMonth}`, 'consumption')
  const trip = consumption.card('Viaje')
  assert.ok(trip.includes(`Gastado ${copMoney(200_000)} de ${copMoney(500_000)} en fondos · 40 %`), trip)
  assert.ok(trip.includes(`${copMoney(200_000)} / ${copMoney(400_000)}`), trip)
  const rows = consumption.baseRows()
  assert.deepEqual(Object.keys(rows).sort(), ['food', 'tech', 'transport'])
  // Food: 200,000 cash + 120,000 on the statement closing in the shown month.
  assert.ok(rows.food.includes(`Gastado en COP: ${copMoney(320_000)}`), rows.food)
  assert.ok(rows.tech.includes(`Gastado en COP: ${copMoney(300_000)}`), rows.tech)
  assert.ok(rows.transport.includes(`Gastado en COP: ${copMoney(100_000)}`), rows.transport)
  const wedding = consumption.card('Boda')
  assert.ok(wedding.includes(copMoney(600_000)), wedding)
  for (const path of ['/goals', `/goals?mes=${monthKeyFrom(LAST_MONTH_TODAY, -2)}`, `/goals?mes=${monthKeyFrom(LAST_MONTH_TODAY, -22)}`]) {
    await consumption.router.push(path)
    await consumption.settle()
    assert.equal(consumption.card('Boda'), wedding, `the event budget is the same at ${path}`)
  }

  t.mock.timers.reset()
  const payments = await mountLastMonthBudgets(t, `/goals?mes=${shownMonth}`, 'payment')
  const paidRows = payments.baseRows()
  assert.deepEqual(Object.keys(paidRows).sort(), ['food', 'tech', 'transport'])
  // The card payments of the shown month are spread over the purchases of the statements they pay.
  assert.ok(paidRows.food.includes(`Gastado en COP: ${copMoney(551_063.83)}`), paidRows.food)
  assert.ok(paidRows.tech.includes(`Gastado en COP: ${copMoney(427_659.57)}`), paidRows.tech)
  assert.ok(payments.card('Viaje').includes(`Gastado ${copMoney(171_276.6)} de ${copMoney(500_000)}`), payments.card('Viaje'))
})
