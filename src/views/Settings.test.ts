import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { CategorySchema } from '../schemas.ts'

const settings = readFileSync(fileURLToPath(new URL('./Settings.vue', import.meta.url)), 'utf8')
const legal = readFileSync(fileURLToPath(new URL('./Legal.vue', import.meta.url)), 'utf8')

const script = settings.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'Settings must keep a TypeScript setup script')
const sourceFile = ts.createSourceFile('Settings.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

// Evaluates one top-level `const` of the setup script with its dependencies injected by name.
const evaluateSetupConst = <Result>(name: string, dependencies: Record<string, unknown>): Result => {
  let initializer: ts.Expression | undefined
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) initializer = declaration.initializer
    }
  }
  assert.ok(initializer, `Settings must define ${name}`)
  // Parenthesized so an object literal is read as an expression, not a block.
  const javascript = ts.transpile(`(${initializer.getText(sourceFile)})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  return new Function(...Object.keys(dependencies), `return ${javascript}`)(...Object.values(dependencies)) as Result
}

// Shared notifications store fake plus recorders for the native dialogs it replaces.
const dialogs = (confirmAnswer = true) => {
  const errors: string[] = []
  const confirms: Array<Record<string, unknown>> = []
  const native: string[] = []
  return {
    errors,
    confirms,
    native,
    deps: {
      notifications: {
        success: () => {},
        info: () => {},
        error: (message: string) => { errors.push(message) },
        confirm: async (options: Record<string, unknown>) => { confirms.push(options); return confirmAnswer }
      },
      alert: (message: string) => { native.push(`alert: ${message}`) },
      confirm: (message: string) => { native.push(`confirm: ${message}`); return confirmAnswer },
      console: { error: () => {} }
    }
  }
}

test('settings has a data tab that downloads the active workspace as JSON', () => {
  assert.match(settings, /type SettingsTab = [^\n]*'data'/)
  assert.match(settings, /id: 'data', label: 'Tus datos'/)
  assert.match(settings, /<template v-else-if="activeTab === 'data'">[\s\S]*@click="handleExport"/)

  const handler = settings.slice(settings.indexOf('const handleExport = async'))
  assert.match(handler.slice(0, 1200), /fetchWorkspaceExport\(db, authStore\.activeWorkspaceId, authStore\.user\.uid\)/)
  assert.match(handler.slice(0, 1200), /new Blob\(\[JSON\.stringify\(data, null, 2\)\], \{ type: 'application\/json' \}\)/)
  assert.match(handler.slice(0, 1200), /exportFileName\(/)
})

test('data tab links both legal documents and legal pages return to it', () => {
  const tab = settings.slice(settings.indexOf(`<template v-else-if="activeTab === 'data'">`))
  assert.match(tab, /to="\/terminos"/)
  assert.match(tab, /to="\/privacidad"/)
  assert.match(legal, /\{ name: 'Settings', query: \{ tab: 'data' \} \}/)
})

test('existing settings tabs are unchanged', () => {
  for (const id of ['workspace', 'regional', 'categories', 'ai']) {
    assert.match(settings, new RegExp(`id: '${id}', label: `))
  }
})

test('P1 S3: settings no longer edits the base budget expense limit', () => {
  assert.equal(/expenseLimitInput|updateWorkspaceLimit|Límite de gastos mensual/.test(settings), false)
})

test('data tab deletes the account only after typing the confirmation word', () => {
  const tab = settings.slice(settings.indexOf(`<template v-else-if="activeTab === 'data'">`))
  assert.match(tab, /Eliminar mi cuenta/)
  assert.match(tab, /v-model="deleteConfirmation"/)
  assert.match(tab, /@click="handleDeleteAccount"\s*:disabled="deletingAccount \|\| !isDeletionConfirmed\(deleteConfirmation\)"/)

  const handler = settings.slice(settings.indexOf('const handleDeleteAccount = async'))
  assert.match(handler.slice(0, 800), /if \(!isDeletionConfirmed\(deleteConfirmation\.value\)\) return/)
  assert.match(handler.slice(0, 800), /await authStore\.deleteAccount\(\)/)
  assert.match(handler.slice(0, 800), /await router\.replace\('\/login'\)/)
})

test('S7: settings uses the shared notifications store and no native dialogs', () => {
  assert.match(script, /import \{ useNotificationsStore \} from '@\/stores\/notificationsStore'/)
  assert.match(script, /const notifications = useNotificationsStore\(\)/)
  assert.equal(/(?<![.\w])(alert|confirm)\(/.test(script), false, 'no native alert() or confirm() may remain')
})

test('S7: deleting a category asks a danger confirmation and does nothing when cancelled', async () => {
  for (const answer of [false, true]) {
    const ui = dialogs(answer)
    const deleted: string[] = []
    const deleteCategory = evaluateSetupConst<(id: string) => Promise<void>>('deleteCategory', {
      ...ui.deps,
      transactionsStore: { deleteCategory: async (id: string) => { deleted.push(id) } }
    })
    await deleteCategory('cat-1')
    assert.deepEqual(ui.native, [])
    assert.equal(ui.confirms.length, 1)
    assert.equal(ui.confirms[0].tone, 'danger')
    assert.deepEqual(deleted, answer ? ['cat-1'] : [])
    assert.deepEqual(ui.errors, [])
  }
})

test('S7: a failed category deletion shows an error toast', async () => {
  const ui = dialogs(true)
  const deleteCategory = evaluateSetupConst<(id: string) => Promise<void>>('deleteCategory', {
    ...ui.deps,
    transactionsStore: { deleteCategory: async () => { throw new Error('permission-denied') } }
  })
  await deleteCategory('cat-1')
  assert.equal(ui.errors.length, 1)
  assert.doesNotMatch(ui.errors[0], /permission-denied/)
})

const categoryForm = (name: string, addCategory: (category: unknown) => Promise<void>) => {
  const ui = dialogs()
  const form = {
    newCatName: ref(name),
    newCatIcon: ref('ShoppingCart'),
    newCatColor: ref('#f43f5e'),
    newCatType: ref<'expense' | 'income' | 'both'>('income'),
    loadingCategory: ref(false)
  }
  const createCategory = evaluateSetupConst<() => Promise<void>>('createCategory', {
    ...ui.deps,
    ...form,
    CategorySchema,
    transactionsStore: { addCategory }
  })
  return { ui, form, createCategory }
}

test('S7: an invalid category shows the validation message as an error toast', async () => {
  const added: unknown[] = []
  const { ui, createCategory } = categoryForm('', async (category) => { added.push(category) })
  await createCategory()
  const expected = CategorySchema.safeParse({ name: '', icon: 'ShoppingCart', color: '#f43f5e', type: 'income' })
  assert.equal(expected.success, false)
  assert.deepEqual(ui.errors, [expected.error?.errors[0].message])
  assert.deepEqual(ui.native, [])
  assert.deepEqual(added, [])
})

test('S7: a failed category creation shows an error toast; a successful one still resets the form', async () => {
  const failing = categoryForm('Mascotas', async () => { throw new Error('unavailable') })
  await failing.createCategory()
  assert.equal(failing.ui.errors.length, 1)
  assert.equal(failing.form.newCatName.value, 'Mascotas', 'a failed creation keeps the draft')
  assert.equal(failing.form.loadingCategory.value, false)

  const added: unknown[] = []
  const working = categoryForm('Mascotas', async (category) => { added.push(category) })
  await working.createCategory()
  assert.deepEqual(added, [{ name: 'Mascotas', icon: 'ShoppingCart', color: '#f43f5e', type: 'income' }])
  assert.deepEqual(working.ui.errors, [])
  assert.equal(working.form.newCatName.value, '')
  assert.equal(working.form.newCatType.value, 'expense')
})

test('S7: a failed workspace creation shows an error toast without technical details', async () => {
  for (const fails of [true, false]) {
    const ui = dialogs()
    const created: string[] = []
    const newWorkspaceName = ref('  Hogar  ')
    const creatingWorkspace = ref(false)
    const handleCreateWorkspace = evaluateSetupConst<() => Promise<void>>('handleCreateWorkspace', {
      ...ui.deps,
      newWorkspaceName,
      creatingWorkspace,
      track: () => {},
      settingsStore: { countryConfigured: true, currency: 'COP' },
      goalsStore: { budgetAlertsEnabled: true },
      budgetAlertsEnabled: ref(true),
      activateWorkspace: async () => {},
      workspacesStore: {
        createWorkspace: async (name: string) => {
          created.push(name)
          if (fails) throw new Error('Missing or insufficient permissions.')
        }
      }
    })
    await handleCreateWorkspace()
    assert.deepEqual(created, ['Hogar'])
    assert.deepEqual(ui.native, [])
    assert.equal(creatingWorkspace.value, false)
    if (fails) {
      assert.equal(ui.errors.length, 1)
      assert.doesNotMatch(ui.errors[0], /Missing or insufficient permissions/)
    } else {
      assert.deepEqual(ui.errors, [])
      assert.equal(newWorkspaceName.value, '')
    }
  }
})

test('S7: a workspace created from Settings gets the main currency and shows its own freshly loaded data', async () => {
  const ui = dialogs()
  const settingsStore = { countryConfigured: true, currency: 'MXN' }
  const goalsStore = { budgetAlertsEnabled: false }
  const budgetAlertsEnabled = ref(false)
  const calls: unknown[][] = []
  const activated: string[] = []
  // The shared activation (switch + reload): the new workspace's settings arrive with it.
  const activateWorkspace = async (workspaceId: string) => { activated.push(workspaceId); goalsStore.budgetAlertsEnabled = true }
  const handleCreateWorkspace = evaluateSetupConst<() => Promise<void>>('handleCreateWorkspace', {
    ...ui.deps,
    newWorkspaceName: ref('Hogar'),
    creatingWorkspace: ref(false),
    track: () => {},
    settingsStore,
    goalsStore,
    budgetAlertsEnabled,
    activateWorkspace,
    workspacesStore: {
      // The store creates, confirms the limit currency and activates through the activation it is given.
      createWorkspace: async (...args: unknown[]) => {
        calls.push(args)
        await (args[2] as (workspaceId: string) => Promise<void>)('new-ws')
      }
    }
  })
  await handleCreateWorkspace()
  assert.deepEqual(calls, [['Hogar', settingsStore, activateWorkspace]],
    'the creator settings decide the confirmed limit currency; the shared activation switches and reloads')
  assert.deepEqual(activated, ['new-ws'])
  assert.equal(budgetAlertsEnabled.value, true, 'the alerts switch shows the new workspace, not the previous one')
  assert.deepEqual(ui.errors, [])

  assert.match(script, /import \{ activateWorkspace \} from '@\/composables\/useWorkspaceActivation'/)
  const handler = settings.slice(settings.indexOf('const handleCreateWorkspace = async'), settings.indexOf('const handleInviteUser'))
  assert.doesNotMatch(handler, /switchWorkspace|activateWorkspace\(|fetchAccounts|fetchTransactions|loadBudgetSettings/,
    'no second switch or reload next to the shared one')
})

test('S7: a failed budget-alerts toggle reverts the switch and shows an error toast', async () => {
  for (const fails of [true, false]) {
    const ui = dialogs()
    const saved: boolean[] = []
    const budgetAlertsEnabled = ref(false)
    const handleBudgetAlertsChange = evaluateSetupConst<() => Promise<void>>('handleBudgetAlertsChange', {
      ...ui.deps,
      budgetAlertsEnabled,
      goalsStore: {
        saveBudgetAlertsEnabled: async (enabled: boolean) => {
          saved.push(enabled)
          if (fails) throw new Error('unavailable')
        }
      }
    })
    await handleBudgetAlertsChange()
    assert.deepEqual(saved, [false])
    assert.equal(budgetAlertsEnabled.value, fails)
    assert.equal(ui.errors.length, fails ? 1 : 0)
  }
})

test('S7: a failed general settings save shows an error toast', async () => {
  for (const fails of [true, false]) {
    const ui = dialogs()
    const saved: unknown[] = []
    const handleGeneralSettingsChange = evaluateSetupConst<() => Promise<void>>('handleGeneralSettingsChange', {
      ...ui.deps,
      aiEnabled: ref(false),
      useCustomKey: ref(true),
      country: ref('MX'),
      currency: ref('MXN'),
      settingsStore: {
        saveSettings: async (values: unknown) => {
          saved.push(values)
          if (fails) throw new Error('unavailable')
        }
      }
    })
    await handleGeneralSettingsChange()
    assert.deepEqual(saved, [{ aiEnabled: false, useCustomKey: true, country: 'MX', currency: 'MXN' }])
    assert.equal(ui.errors.length, fails ? 1 : 0)
  }
})

test('S7: push notifications explain a missing configuration without technical names', () => {
  assert.equal(/VAPID|VITE_/.test(settings), false, 'environment variable names must not reach users')
  const pushStatusText = evaluateSetupConst<{ value: string }>('pushStatusText', {
    computed,
    pushError: ref(''),
    pushStatus: ref('missing-vapid')
  })
  assert.match(pushStatusText.value, /notificaciones push no están disponibles en esta instalación/i)
})
