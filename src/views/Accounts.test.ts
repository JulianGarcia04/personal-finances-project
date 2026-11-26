import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { ref } from 'vue'
import { sameMirrorConfig } from '../lib/mirror.ts'
import { isPocketAccount } from '../lib/pockets.ts'
import { AccountSchema } from '../schemas.ts'

const accountsView = readFileSync(fileURLToPath(new URL('./Accounts.vue', import.meta.url)), 'utf8')
const script = accountsView.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'Accounts must keep a TypeScript setup script')
const template = accountsView.slice(0, accountsView.indexOf('<script setup lang="ts">'))
const sourceFile = ts.createSourceFile('Accounts.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const computedBody = (name: string) => {
  const match = accountsView.match(new RegExp(`const ${name} = computed\\(\\(\\) =>([\\s\\S]*?)\\n\\)`))
  assert.ok(match, `${name} must be a computed selector`)
  return match[1]
}

const variableInitializer = (name: string): ts.Expression | undefined => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer
    }
  }
  return undefined
}

// Evaluates one setup arrow function with its free variables injected, so it runs the real view code.
const evaluateComponentFunction = <Result>(name: string, dependencies: Record<string, unknown>): Result => {
  const initializer = variableInitializer(name)
  assert.ok(initializer && ts.isArrowFunction(initializer), `Accounts must define ${name} as an arrow function`)
  const javascript = ts.transpile(initializer.getText(sourceFile), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const evaluate = new Function(...Object.keys(dependencies), `return ${javascript}`) as (...args: unknown[]) => Result
  return evaluate(...Object.values(dependencies))
}

type ConfirmRequest = { title: string; message: string; confirmLabel?: string; cancelLabel?: string; tone?: string }

// Stands in for useNotificationsStore(); native dialogs fail the test if the view still reaches them.
const fakeNotifications = (answer = true) => {
  const calls = { errors: [] as string[], successes: [] as string[], infos: [] as string[], confirms: [] as ConfirmRequest[] }
  const notifications = {
    error: (message: string) => { calls.errors.push(message) },
    success: (message: string) => { calls.successes.push(message) },
    info: (message: string) => { calls.infos.push(message) },
    confirm: async (request: ConfirmRequest) => { calls.confirms.push(request); return answer }
  }
  return { calls, notifications }
}
const nativeDialogs = {
  alert: () => assert.fail('Accounts must not call native alert()'),
  confirm: () => assert.fail('Accounts must not call native confirm()')
}
const quietConsole = { error: () => undefined }

test('settlement selectors offer main accounts, banks with pockets included, but never a pocket', () => {
  for (const name of ['settleSourceAccounts', 'settleDestinationAccounts']) {
    const body = computedBody(name)
    assert.match(body, /!isPocketAccount\(acc\)/, `${name} must hide pockets`)
    assert.doesNotMatch(body, /isPocketRelatedAccount|childAccountIds/, `${name} must keep banks that have pockets`)
  }
  assert.match(computedBody('settleSourceAccounts'), /!acc\.mirror/, 'bridge accounts still cannot pay a settlement')
})

test('S8: Accounts loads transactions on mount and aligns credit card cycle due with statement ledger capped by debt', () => {
  assert.match(accountsView, /onMounted\(async \(\) => \{[\s\S]*?transactionsStore\.fetchTransactions\(\)/)
  assert.match(accountsView, /const cycleChargeAmount = \(account: Account\) => \{[\s\S]*?buildCardStatementLedger\(account, billing, transactionsStore\.transactions\)/)
})

test('S7: Accounts uses the shared notifications store and no native alert() or confirm()', () => {
  assert.match(script, /import \{ useNotificationsStore \} from '@\/stores\/notificationsStore'/)
  assert.match(script, /const notifications = useNotificationsStore\(\)/)
  assert.doesNotMatch(script, /(?<![\w$.])(?:alert|confirm)\s*\(/, 'no bare alert()/confirm() call may remain')
  assert.doesNotMatch(script, /window\.(?:alert|confirm)\b/)
})

const runDelete = async (account: Record<string, unknown>, options: { answer?: boolean; deleteError?: unknown } = {}) => {
  const { calls, notifications } = fakeNotifications(options.answer ?? true)
  const deleted: string[] = []
  const handleDelete = evaluateComponentFunction<(id: string, name: string) => Promise<void>>('handleDelete', {
    ...nativeDialogs,
    console: quietConsole,
    isPocketAccount,
    notifications,
    accountsStore: {
      getAccountById: (id: string) => (id === account.id ? account : undefined),
      deleteAccount: async (id: string) => {
        if (options.deleteError !== undefined) throw options.deleteError
        deleted.push(id)
      }
    }
  })
  await handleDelete(account.id as string, account.name as string)
  return { ...calls, deleted }
}

test('S7: deleting a pocket asks with a danger confirmation that keeps the pocket warning, and deletes only when accepted', async () => {
  const pocket = { id: 'pocket-viaje', name: 'Viaje', type: 'savings', parentAccountId: 'bank-1', balance: 0, currency: 'COP' }
  const request = {
    title: 'Eliminar bolsillo',
    message: 'Solo se puede eliminar el bolsillo "Viaje" si tiene saldo cero y no conserva movimientos; el historial no se borra.',
    confirmLabel: 'Eliminar bolsillo',
    tone: 'danger'
  }

  const declined = await runDelete(pocket, { answer: false })
  assert.deepEqual(declined.confirms, [request])
  assert.deepEqual(declined.deleted, [], 'declining must not delete')
  assert.deepEqual(declined.errors, [])

  const accepted = await runDelete(pocket, { answer: true })
  assert.deepEqual(accepted.confirms, [request])
  assert.deepEqual(accepted.deleted, ['pocket-viaje'])
  assert.deepEqual(accepted.errors, [])
})

test('S7: deleting an account keeps its account-specific warnings in the danger confirmation', async () => {
  const account = { id: 'bank-nomina', name: 'Nómina', type: 'checking', balance: 0, currency: 'COP' }
  const plain = await runDelete(account, { answer: true })
  assert.deepEqual(plain.confirms, [{
    title: 'Eliminar cuenta',
    message: '¿Estás seguro de que deseas eliminar la cuenta "Nómina"? Todas las transacciones asociadas ya no estarán vinculadas.',
    confirmLabel: 'Eliminar cuenta',
    tone: 'danger'
  }])
  assert.deepEqual(plain.deleted, ['bank-nomina'])

  const withPockets = await runDelete({ ...account, childAccountIds: ['pocket-viaje'] }, { answer: false })
  assert.deepEqual(withPockets.confirms, [{
    title: 'Eliminar cuenta',
    message: 'La cuenta "Nómina" tiene bolsillos vinculados. Primero elimina únicamente los bolsillos vacíos y sin movimientos; el historial no se borra.',
    confirmLabel: 'Eliminar cuenta',
    tone: 'danger'
  }])
  assert.deepEqual(withPockets.deleted, [])
})

test('S7: a failed deletion shows an error toast', async () => {
  const account = { id: 'bank-nomina', name: 'Nómina', type: 'checking', balance: 0, currency: 'COP' }
  const rejected = await runDelete(account, { deleteError: new Error('El bolsillo tiene movimientos.') })
  assert.deepEqual(rejected.errors, ['El bolsillo tiene movimientos.'])
  const unknown = await runDelete(account, { deleteError: {} })
  assert.deepEqual(unknown.errors, ['No se pudo borrar la cuenta'])
})

test('S7: an account linked to a budget is not deleted and the error toast names the current Presupuestos section', async () => {
  const linked = { id: 'cash-casa', name: 'Caja Casa', type: 'cash', linkedBudgetId: 'hogar', balance: 0, currency: 'COP' }
  const result = await runDelete(linked)
  assert.deepEqual(result.errors, ['La cuenta "Caja Casa" está ligada a un presupuesto. Quítala de las cuentas ligadas de ese presupuesto en Presupuestos antes de eliminarla.'])
  assert.deepEqual(result.confirms, [], 'a blocked deletion does not ask for confirmation')
  assert.deepEqual(result.deleted, [])
  assert.doesNotMatch(accountsView, /Metas y Presupuestos/, 'the retired section name must not appear')
})

test('S7: a blocked pocket movement shows an error toast and does not navigate', async () => {
  const { calls, notifications } = fakeNotifications()
  const pushes: unknown[] = []
  const openPocketMovement = evaluateComponentFunction<(parent: unknown, pocket: unknown, direction: string) => Promise<void>>('openPocketMovement', {
    ...nativeDialogs,
    notifications,
    canTransferBetweenAccounts: () => false,
    accountsStore: { accounts: [] },
    router: { push: async (location: unknown) => { pushes.push(location) } }
  })
  await openPocketMovement({ id: 'bank-1' }, { id: 'pocket-viaje' }, 'fund')
  assert.deepEqual(calls.errors, ['No se puede mover dinero entre estas cuentas: revisa el workspace, la moneda y el estado del bolsillo.'])
  assert.deepEqual(pushes, [])
})

const newAccountDraft = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ahorros Bancolombia', type: 'savings', balance: 1000, limit: 0, currency: 'COP',
  statementClosingDay: null, paymentDueDay: null, ...overrides
})

const runSaveAccount = async (draft: Record<string, unknown>, options: { parent?: unknown; writeError?: unknown } = {}) => {
  const { calls, notifications } = fakeNotifications()
  const showAddModal = ref(true)
  const newAcc = ref(draft)
  const loading = ref(false)
  const writes: unknown[] = []
  let closed = 0
  const write = async (payload: unknown) => {
    if (options.writeError !== undefined) throw options.writeError
    writes.push(payload)
  }
  const saveAccount = evaluateComponentFunction<() => Promise<void>>('saveAccount', {
    ...nativeDialogs,
    console: quietConsole,
    AccountSchema,
    notifications,
    track: () => undefined,
    pocketParent: ref(options.parent ?? null),
    newAcc,
    loading,
    closeAddModal: () => { closed += 1; showAddModal.value = false },
    accountsStore: { addAccount: write, addPocket: write }
  })
  await saveAccount()
  return { errors: calls.errors, writes, closed, open: showAddModal.value, draft: newAcc.value, loading: loading.value }
}

test('S7: add-account validation and save failures show an error toast and keep the sheet open with the input', async () => {
  const parent = { id: 'bank-1', name: 'Bancolombia', currency: 'COP' }
  const negativePocket = newAccountDraft({ name: 'Viaje', balance: -5 })
  const pocketResult = await runSaveAccount(negativePocket, { parent })
  assert.deepEqual(pocketResult.errors, ['Los fondos iniciales del bolsillo deben ser un monto válido y no negativo.'])
  assert.deepEqual(pocketResult.writes, [])
  assert.equal(pocketResult.closed, 0)
  assert.equal(pocketResult.open, true)
  assert.equal(pocketResult.draft.name, 'Viaje', 'the typed input is kept')

  const unnamed = await runSaveAccount(newAccountDraft({ name: '' }))
  assert.deepEqual(unnamed.errors, ['El nombre es requerido'])
  assert.deepEqual(unnamed.writes, [])
  assert.equal(unnamed.open, true)

  const failed = await runSaveAccount(newAccountDraft(), { writeError: new Error('Sin permisos para este workspace.') })
  assert.deepEqual(failed.errors, ['Sin permisos para este workspace.'])
  assert.equal(failed.closed, 0)
  assert.equal(failed.open, true)
  assert.equal(failed.draft.name, 'Ahorros Bancolombia')
  assert.equal(failed.loading, false)

  const unknown = await runSaveAccount(newAccountDraft(), { writeError: 'boom' })
  assert.deepEqual(unknown.errors, ['No se pudo guardar la cuenta.'])

  // Previous behavior: a valid account is written and the sheet closes, with no toast.
  const saved = await runSaveAccount(newAccountDraft())
  assert.deepEqual(saved.errors, [])
  assert.equal(saved.writes.length, 1)
  assert.equal(saved.closed, 1)
})

const runSaveEditedAccount = async (options: {
  draft?: Record<string, unknown>
  mirror?: { workspaceId: string; sourceAccountId: string; accountId: string }
  lockReason?: string | null
  writeError?: unknown
} = {}) => {
  const { calls, notifications } = fakeNotifications()
  const account = { id: 'bank-nomina', name: 'Nómina', type: 'checking', limit: 0, currency: 'COP', balance: 0, mirror: null }
  const showEditModal = ref(true)
  const editAcc = ref({ name: 'Nómina', type: 'checking', limit: 0, currency: 'COP', statementClosingDay: null, paymentDueDay: null, ...options.draft })
  const loading = ref(false)
  const writes: unknown[] = []
  let closed = 0
  const saveEditedAccount = evaluateComponentFunction<() => Promise<void>>('saveEditedAccount', {
    ...nativeDialogs,
    console: quietConsole,
    AccountSchema,
    sameMirrorConfig,
    notifications,
    editingAccount: { value: account },
    editingAccountId: ref(account.id),
    editAcc,
    editMirror: ref(options.mirror ?? { workspaceId: '', sourceAccountId: '', accountId: '' }),
    editMirrorLockReason: { value: options.lockReason ?? null },
    loading,
    closeEditAccountModal: () => { closed += 1; showEditModal.value = false },
    accountsStore: {
      updateAccount: async (id: string, patch: unknown) => {
        if (options.writeError !== undefined) throw options.writeError
        writes.push(['update', id, patch])
      },
      setAccountMirror: async (id: string, mirror: unknown) => { writes.push(['mirror', id, mirror]) }
    }
  })
  await saveEditedAccount()
  return { errors: calls.errors, writes, closed, open: showEditModal.value, draft: editAcc.value, loading: loading.value }
}

test('S7: edit-account validation and save failures show an error toast and keep the sheet open with the input', async () => {
  const cases: Array<[Parameters<typeof runSaveEditedAccount>[0], string]> = [
    [{ draft: { name: '' } }, 'El nombre es requerido'],
    [{ mirror: { workspaceId: 'ws-casa', sourceAccountId: 'visa', accountId: '' } }, 'Para el espejo debes elegir la cuenta que paga y la cuenta por cobrar.'],
    [{ mirror: { workspaceId: 'ws-casa', sourceAccountId: 'visa', accountId: 'visa' } }, 'La cuenta que paga y la cuenta por cobrar deben ser distintas.'],
    [
      { mirror: { workspaceId: 'ws-casa', sourceAccountId: 'visa', accountId: 'por-cobrar' }, lockReason: 'Solo puedes configurar espejo en una cuenta con saldo 0.' },
      'Solo puedes configurar espejo en una cuenta con saldo 0.'
    ]
  ]
  for (const [options, message] of cases) {
    const result = await runSaveEditedAccount(options)
    assert.deepEqual(result.errors, [message])
    assert.deepEqual(result.writes, [], `${message} must block every write`)
    assert.equal(result.closed, 0)
    assert.equal(result.open, true)
  }

  const failed = await runSaveEditedAccount({ draft: { name: 'Nómina principal' }, writeError: new Error('La cuenta ya no existe.') })
  assert.deepEqual(failed.errors, ['La cuenta ya no existe.'])
  assert.equal(failed.closed, 0)
  assert.equal(failed.open, true)
  assert.equal(failed.draft.name, 'Nómina principal', 'the edited input is kept')
  assert.equal(failed.loading, false)

  const unknown = await runSaveEditedAccount({ writeError: {} })
  assert.deepEqual(unknown.errors, ['No se pudo actualizar la cuenta'])

  // Previous behavior: a valid edit is written and the sheet closes, with no toast.
  const saved = await runSaveEditedAccount({ draft: { name: 'Nómina principal' } })
  assert.deepEqual(saved.errors, [])
  assert.equal(saved.writes.length, 1)
  assert.equal(saved.closed, 1)
})

test('S7: a failed settlement shows an error toast and keeps the settle sheet open', async () => {
  const run = async (settleError: unknown) => {
    const { calls, notifications } = fakeNotifications()
    const bridge = { id: 'bridge', name: 'Puente Casa', balance: -50000, currency: 'COP', mirror: { workspaceId: 'ws-casa', sourceAccountId: 'visa', accountId: 'por-cobrar' } }
    const settleAccount = ref<unknown>(bridge)
    const loading = ref(false)
    const saveSettlement = evaluateComponentFunction<() => Promise<void>>('saveSettlement', {
      ...nativeDialogs,
      console: quietConsole,
      notifications,
      settleAccount,
      settleForm: ref({ amount: 50000, fromAccountId: 'nomina', toAccountId: 'casa-ahorros', date: '2026-11-20' }),
      loading,
      transactionsStore: { settleMirror: async () => { throw settleError } }
    })
    await saveSettlement()
    // ref() wraps the account in a proxy, so the open sheet is identified by the account id.
    return { errors: calls.errors, open: (settleAccount.value as { id?: string } | null)?.id === bridge.id, loading: loading.value }
  }
  assert.deepEqual(await run(new Error('Saldo insuficiente en la cuenta de origen.')), {
    errors: ['Saldo insuficiente en la cuenta de origen.'], open: true, loading: false
  })
  assert.deepEqual((await run({})).errors, ['No se pudo liquidar el puente'])
})

test('S7: a failed load of the other workspace accounts shows an error toast instead of failing silently', async () => {
  const { calls, notifications } = fakeNotifications()
  const mirrorAccounts = ref<unknown[]>([{ id: 'stale' }])
  const loadingMirrorAccounts = ref(false)
  const loadMirrorAccounts = evaluateComponentFunction<(workspaceId?: string) => Promise<void>>('loadMirrorAccounts', {
    ...nativeDialogs,
    console: quietConsole,
    notifications,
    editMirror: ref({ workspaceId: 'ws-casa', sourceAccountId: '', accountId: '' }),
    mirrorAccounts,
    loadingMirrorAccounts,
    accountsStore: { fetchAccountsByWorkspace: async () => { throw new Error('permission-denied') } }
  })
  await loadMirrorAccounts()
  assert.deepEqual(calls.errors, ['No se pudieron cargar las cuentas de ese workspace. Intenta de nuevo.'])
  assert.deepEqual(mirrorAccounts.value, [])
  assert.equal(loadingMirrorAccounts.value, false)
})

test('S7: pocket cards no longer show the raw ID; only an orphan pocket keeps its support identifier', () => {
  const idInterpolations = [...template.matchAll(/\{\{\s*([\w.]+\.id)\s*\}\}/g)].map(match => match[1])
  assert.deepEqual(idInterpolations, ['account.id'], 'the only rendered identifier is the orphan support text')
  assert.match(
    template,
    /<p v-if="group\.isOrphan"[^>]*>\s*Bolsillo sin grupo\. Conserva este identificador: <span class="break-all">\{\{ account\.id \}\}<\/span>/
  )
  assert.match(template, /Ahorros · \{\{ pocket\.currency \}\}<\/p>/, 'a pocket card still shows its type and currency')
  assert.doesNotMatch(template, /\bID \{\{/)
})
