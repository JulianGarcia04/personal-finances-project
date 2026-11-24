import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'

const agent = readFileSync(fileURLToPath(new URL('./Agent.vue', import.meta.url)), 'utf8')
const templateEnd = agent.indexOf('<script setup lang="ts">')
const script = agent.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(templateEnd >= 0 && script, 'Agent must keep a TypeScript setup script')
const template = agent.slice(0, templateEnd)
const sourceFile = ts.createSourceFile('Agent.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

// Evaluates one top-level `const` of the setup script with its dependencies injected by name.
const evaluateSetupConst = <Result>(name: string, dependencies: Record<string, unknown> = {}): Result => {
  let initializer: ts.Expression | undefined
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) initializer = declaration.initializer
    }
  }
  assert.ok(initializer, `Agent must define ${name}`)
  // Parenthesized so an object literal is read as an expression, not a block.
  const javascript = ts.transpile(`(${initializer.getText(sourceFile)})`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  return new Function(...Object.keys(dependencies), `return ${javascript}`)(...Object.values(dependencies)) as Result
}

// Shared notifications store fake plus recorders for the native dialogs it replaces.
const dialogs = (confirmAnswer: boolean) => {
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

test('S7: the advisor uses the shared notifications store and no native dialogs', () => {
  assert.match(script, /import \{ useNotificationsStore \} from '@\/stores\/notificationsStore'/)
  assert.match(script, /const notifications = useNotificationsStore\(\)/)
  assert.equal(/(?<![.\w])(alert|confirm)\(/.test(script), false, 'no native alert() or confirm() may remain')
})

test('S7: deleting a conversation asks a danger confirmation and does nothing when cancelled', async () => {
  for (const answer of [false, true]) {
    const ui = dialogs(answer)
    const deleted: string[] = []
    const deleteConversation = evaluateSetupConst<(chatId: string) => Promise<void>>('deleteConversation', {
      ...ui.deps,
      chatsStore: { deleteChat: async (chatId: string) => { deleted.push(chatId) } }
    })
    await deleteConversation('chat-1')
    assert.deepEqual(ui.native, [])
    assert.equal(ui.confirms.length, 1)
    assert.equal(ui.confirms[0].tone, 'danger')
    assert.deepEqual(deleted, answer ? ['chat-1'] : [])
    assert.deepEqual(ui.errors, [])
  }
})

test('S7: a failed conversation deletion shows an error toast', async () => {
  const ui = dialogs(true)
  const deleteConversation = evaluateSetupConst<(chatId: string) => Promise<void>>('deleteConversation', {
    ...ui.deps,
    chatsStore: { deleteChat: async () => { throw new Error('permission-denied') } }
  })
  await deleteConversation('chat-1')
  assert.equal(ui.errors.length, 1)
  assert.doesNotMatch(ui.errors[0], /permission-denied/)
})

test('S7: the advisor header and connection errors use plain language', () => {
  assert.equal(/acceso a BD|\bBD\b/.test(template), false, 'the header must not mention the database')

  const notices: Array<[string, string]> = []
  const reportError = evaluateSetupConst<(chatId: string | null, err: unknown) => void>('reportError', {
    console: { error: () => {} },
    chatsStore: { addErrorNotice: (chatId: string, message: string) => { notices.push([chatId, message]) } }
  })
  reportError('chat-1', new TypeError('Failed to fetch'))
  reportError('chat-1', Object.assign(new Error('Alcanzaste el límite diario de consultas.'), { fromServer: true }))

  assert.equal(notices.length, 2)
  assert.doesNotMatch(notices[0][1], /emulador|backend|Failed to fetch/i)
  assert.match(notices[0][1], /^⚠️ /)
  // Server rejections keep their user-facing message, as before.
  assert.deepEqual(notices[1], ['chat-1', '⚠️ Alcanzaste el límite diario de consultas.'])
  assert.equal(/\b(emuladore?s?|backend)\b/i.test(agent), false, 'no developer setup terms in user-facing copy')
})

const chipsFor = () => evaluateSetupConst<(currency: string) => { starters: string[]; followUps: string[] }>('chipsFor', {
  CHIP_EXAMPLE_AMOUNTS: evaluateSetupConst('CHIP_EXAMPLE_AMOUNTS'),
  FALLBACK_CHIP_AMOUNTS: evaluateSetupConst('FALLBACK_CHIP_AMOUNTS')
})

test('S7: suggestion chips use the main currency instead of a fixed COP', () => {
  assert.equal(/\d+ COP/.test(agent), false, 'no chip may hard-code COP')

  const euro = chipsFor()('EUR')
  const all = [...euro.starters, ...euro.followUps]
  assert.equal(all.some(chip => chip.includes('COP')), false)
  assert.ok(euro.starters.some(chip => /^Registra un gasto de \d+ EUR en Comida hoy$/.test(chip)))
  assert.ok(euro.followUps.some(chip => /^Crea una cuenta llamada Efectivo con saldo \d+ EUR$/.test(chip)))

  // A currency without a sized example still names itself.
  const real = chipsFor()('BRL')
  assert.ok(real.starters.some(chip => /^Registra un gasto de \d+ BRL en Comida hoy$/.test(chip)))

  // The main currency is the user's, read like the Dashboard (COP when unset).
  const mainCurrency = evaluateSetupConst<{ value: string }>('mainCurrency', { computed, settingsStore: { currency: 'MXN' } })
  assert.equal(mainCurrency.value, 'MXN')
  const unset = evaluateSetupConst<{ value: string }>('mainCurrency', { computed, settingsStore: { currency: '' } })
  assert.equal(unset.value, 'COP')

  const chips = evaluateSetupConst<{ value: { starters: string[]; followUps: string[] } }>('chips', {
    computed,
    chipsFor: chipsFor(),
    mainCurrency: ref('PEN')
  })
  assert.ok(chips.value.starters.some(chip => chip.includes(' PEN ')))
  assert.match(template, /v-for="chip in chips\.starters"/)
  assert.match(template, /v-for="chip in chips\.followUps"/)
})

test('S7: COP users keep the same suggestion chips as before', () => {
  const { starters, followUps } = chipsFor()('COP')
  assert.deepEqual(starters, [
    'Resumen de mis gastos de este mes',
    'Compara este mes con el anterior',
    '¿Cómo voy con mi presupuesto?',
    'Mis 5 gastos más grandes del mes',
    '¿Cuál es mi patrimonio neto actual?',
    'Registra un gasto de 30000 COP en Comida hoy'
  ])
  assert.deepEqual(followUps, [
    'Resumen de mis gastos de este mes',
    'Compara este mes con el anterior',
    '¿Cómo voy con mi presupuesto?',
    'Mis 5 gastos más grandes del mes',
    '¿Cuándo compré ropa?',
    '¿Cómo voy con mis metas de ahorro?',
    'Dáme consejos para ahorrar',
    'Crea una cuenta llamada Efectivo con saldo 50000 COP'
  ])
})
