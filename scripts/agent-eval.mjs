#!/usr/bin/env node
// Manual LLM eval for the chat agent (never CI). Seeds tests/fixtures/agent.fixture.mjs
// into the auth+firestore+functions emulators of a demo project, sends every case in
// scripts/agent-eval.questions.json to the emulated chatWithAgent with a real Gemini
// key, and reports pass/fail per case (tool calls, partial args, numbers ±1%).
//
// `expectTools` entries may list alternatives as "a|b". Optional per case: `history` (prior {role, content} turns sent before the question),
// `expectSuccess` / `forbidSuccess` (write tools that must / must not return success)
// and `expectAnswer` (case-insensitive regex the answer must match).
//
//   GEMINI_API_KEY=... node scripts/agent-eval.mjs [--only q01,q16]
//   node scripts/agent-eval.mjs --dry-run      # no key: validates cases + seeding
//
// Same isolation as tests/functions.http.emulators.mjs: a throwaway functions source
// with its own `.env` (the key is written there, mode 0600, and deleted afterwards;
// it is never printed), an allowlisted child environment, demo project only.
// Requires `pnpm --filter functions build` and the cached firebase-tools 15.33.0.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const functionsRoot = resolve(repositoryRoot, 'functions')
const questionsPath = resolve(repositoryRoot, 'scripts/agent-eval.questions.json')
const projectId = 'demo-vault-agent-eval'
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const childMode = args.includes('--child')
const onlyArg = args.find(arg => arg.startsWith('--only='))?.slice('--only='.length) ??
  (args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined)
const only = onlyArg ? new Set(onlyArg.split(',').map(id => id.trim())) : null

const TOOL_NAMES = new Set([
  'listAccounts', 'createAccount', 'listTransactions', 'createTransaction', 'deleteTransaction', 'listCategories',
  'listGoals', 'createGoal', 'updateGoalAmount', 'semanticSearchTransactions', 'getFinancialSummary',
  'getWorkspaceSettings', 'saveCategoryBudgets'
])

// --- Cases -----------------------------------------------------------------------

function loadCases() {
  const { cases } = JSON.parse(readFileSync(questionsPath, 'utf8'))
  assert.ok(Array.isArray(cases) && cases.length > 0, 'questions file must contain cases')
  const seen = new Set()
  for (const c of cases) {
    assert.match(c.id ?? '', /^q\d{2}$/, `invalid case id ${c.id}`)
    assert.ok(!seen.has(c.id), `duplicate case id ${c.id}`)
    seen.add(c.id)
    assert.equal(typeof c.question, 'string', `${c.id}: question must be a string`)
    assert.ok(Array.isArray(c.expectTools), `${c.id}: expectTools must be an array`)
    // "a|b" accepts any of the alternatives.
    for (const name of c.expectTools.flatMap(entry => entry.split('|'))) assert.ok(TOOL_NAMES.has(name), `${c.id}: unknown tool ${name}`)
    for (const key of ['expectArgs', 'forbidArgs', 'expectNumbers']) {
      if (c[key] === undefined) continue
      assert.ok(Array.isArray(c[key]), `${c.id}: ${key} must be an array`)
      for (const spec of c[key]) {
        assert.ok(TOOL_NAMES.has(spec.tool), `${c.id}: ${key} names unknown tool ${spec.tool}`)
        assert.equal(typeof spec.args, 'object', `${c.id}: ${key} needs args`)
        if (key === 'expectNumbers') assert.equal(typeof spec.path, 'string', `${c.id}: expectNumbers needs a path`)
      }
    }
    for (const key of ['expectSuccess', 'forbidSuccess']) {
      if (c[key] === undefined) continue
      assert.ok(Array.isArray(c[key]), `${c.id}: ${key} must be an array`)
      for (const name of c[key]) assert.ok(TOOL_NAMES.has(name), `${c.id}: ${key} names unknown tool ${name}`)
    }
    if (c.expectAnswer !== undefined) new RegExp(c.expectAnswer, 'i')
    if (c.history !== undefined) {
      assert.ok(Array.isArray(c.history), `${c.id}: history must be an array`)
      for (const turn of c.history) {
        assert.ok(['user', 'assistant'].includes(turn?.role) && typeof turn.content === 'string', `${c.id}: invalid history turn`)
      }
    }
  }
  return only ? cases.filter(c => only.has(c.id)) : cases
}

// --- Parent: launch the emulators ---------------------------------------------------

function ensurePortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`Required emulator port ${port} is unavailable: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(error => (error ? reject(error) : resolvePort())))
  })
}

function resolveCachedCli() {
  const cacheRoot = join(homedir(), '.npm/_npx')
  const matches = []
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packagePath = join(cacheRoot, entry.name, 'node_modules/firebase-tools/package.json')
    try {
      if (JSON.parse(readFileSync(packagePath, 'utf8')).version === '15.33.0') matches.push(join(dirname(packagePath), 'lib/bin/firebase.js'))
    } catch {
      // Not a cached firebase-tools 15.33.0 entry.
    }
  }
  assert.equal(matches.length, 1, 'exact cached firebase-tools 15.33.0 entry must be uniquely available')
  return matches[0]
}

async function runParent() {
  loadCases()
  assert.ok(existsSync(resolve(functionsRoot, 'lib/agentContext.js')), 'run `pnpm --filter functions build` first')
  const apiKey = process.env.GEMINI_API_KEY ?? ''
  if (!dryRun && !apiKey) {
    console.error('GEMINI_API_KEY is required (or use --dry-run). It is only written to the throwaway emulator .env.')
    process.exit(2)
  }
  if (/[\r\n]/.test(apiKey)) throw new Error('GEMINI_API_KEY must be a single line.')

  const cliEntry = resolveCachedCli()
  const cliVersion = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' })
  assert.equal(cliVersion.stdout.trim(), '15.33.0', 'only the approved cached Firebase CLI may run')
  for (const port of [8080, 9099, 5001]) await ensurePortAvailable(port)

  const workRoot = mkdtempSync(join(tmpdir(), 'agent-eval-'))
  chmodSync(workRoot, 0o700)
  try {
    const temporaryHome = join(workRoot, 'home')
    const sourceDir = join(workRoot, 'source')
    for (const dir of [temporaryHome, sourceDir]) mkdirSync(dir, { mode: 0o700 })
    const functionsPackage = JSON.parse(readFileSync(resolve(functionsRoot, 'package.json'), 'utf8'))
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: 'agent-eval-emulator-fixture',
      private: true,
      main: 'index.cjs',
      engines: functionsPackage.engines,
      dependencies: {
        'firebase-admin': functionsPackage.dependencies['firebase-admin'],
        'firebase-functions': functionsPackage.dependencies['firebase-functions']
      }
    }, null, 2))
    writeFileSync(join(sourceDir, 'index.cjs'), `'use strict'\nmodule.exports = require(${JSON.stringify(resolve(functionsRoot, 'lib/index.js'))})\n`)
    symlinkSync(resolve(functionsRoot, 'node_modules'), join(sourceDir, 'node_modules'), 'dir')
    // Dry run: no key, so the embedding trigger skips ("no-key") and nothing reaches Gemini.
    writeFileSync(join(sourceDir, '.env'), [
      'ENCRYPTION_SECRET=emulator-only-encryption-secret-32chars',
      `GEMINI_API_KEY=${dryRun ? '' : apiKey}`,
      'DEFAULT_KEY_DAILY_CHAT_LIMIT=1000',
      'DEFAULT_KEY_DAILY_PARSE_LIMIT=0',
      ''
    ].join('\n'), { mode: 0o600 })

    const config = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/firebase.functions-http.json'), 'utf8'))
    symlinkSync(resolve(repositoryRoot, 'firestore.rules'), join(workRoot, 'firestore.rules'))
    config.functions.source = 'source'
    config.firestore.rules = 'firestore.rules'
    const configPath = join(workRoot, 'firebase.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    const childArgs = ['--child', ...(dryRun ? ['--dry-run'] : []), ...(onlyArg ? [`--only=${onlyArg}`] : [])]
    const inner = `node ${JSON.stringify(fileURLToPath(import.meta.url))} ${childArgs.join(' ')}`
    const code = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        cliEntry, 'emulators:exec', '--project', projectId, '--only', 'auth,firestore,functions', '--config', configPath, inner
      ], {
        cwd: repositoryRoot,
        // Allowlisted: the key only travels through the throwaway .env file.
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: temporaryHome,
          TMPDIR: tmpdir(),
          npm_config_offline: 'true',
          FIREBASE_EMULATORS_PATH: process.env.FIREBASE_EMULATORS_PATH || join(homedir(), '.cache/firebase/emulators'),
          CI: 'true'
        },
        stdio: 'inherit'
      })
      child.once('error', rejectRun)
      child.once('exit', resolveRun)
    })
    process.exitCode = code ?? 1
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

// --- Child: seed, ask, check ----------------------------------------------------------

function resolvePlaceholder(value, vars) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const resolved = value.slice(1).split('.').reduce((node, key) => node?.[key], vars)
    assert.notEqual(resolved, undefined, `unknown placeholder ${value}`)
    return resolved
  }
  if (Array.isArray(value)) return value.map(item => resolvePlaceholder(item, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholder(item, vars)]))
  }
  return value
}

/** `a.b[0].c` and `groups[key=$categories.food].expenses` lookups. */
function readPath(root, path, vars) {
  let node = root
  for (const segment of path.split(/\.(?![^[]*\])/)) {
    const match = /^([^[]+)(?:\[(.+)\])?$/.exec(segment)
    assert.ok(match, `bad path segment ${segment}`)
    node = node?.[match[1]]
    if (match[2] !== undefined) {
      if (/^\d+$/.test(match[2])) node = node?.[Number(match[2])]
      else {
        const [field, raw] = match[2].split('=')
        const wanted = resolvePlaceholder(raw, vars)
        node = Array.isArray(node) ? node.find(item => item?.[field] === wanted) : undefined
      }
    }
  }
  return node
}

/** Every number-like token in a Spanish/English answer, read both ways (1.234,5 / 1,234.5). */
function numbersIn(text) {
  const found = []
  const pattern = /\d[\d.,   ]*\d|\d/g
  let match
  while ((match = pattern.exec(text))) {
    const token = match[0].replace(/[   ]/g, '')
    const rest = text.slice(pattern.lastIndex, pattern.lastIndex + 12)
    const scale = /^\s*(millones|millón|millon)/i.test(rest) ? 1e6 : /^\s*mil\b/i.test(rest) ? 1e3 : 1
    for (const candidate of [token.replace(/\./g, '').replace(',', '.'), token.replace(/,/g, '')]) {
      const value = Number.parseFloat(candidate)
      if (Number.isFinite(value)) found.push(value * scale)
    }
  }
  return found
}

const argsMatch = (input, expected) => Object.entries(expected).every(([key, value]) => isDeepStrictEqual(input?.[key], value))

async function runChild() {
  assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'the eval only runs against a demo project')
  for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
    assert.match(process.env[name] ?? '', /^(127\.0\.0\.1|localhost):\d+$/, `${name} must point to a loopback emulator`)
  }
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'ambient Google credentials are not allowed')

  const cases = loadCases()
  const requireFunctions = createRequire(resolve(functionsRoot, 'package.json'))
  const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
  const { getFirestore } = requireFunctions('firebase-admin/firestore')
  const { buildAgentTools, resolvePrimaryCurrency } = requireFunctions('./lib/agentContext.js')
  const { buildDateContext } = requireFunctions('./lib/agentTools.js')
  const { isEmbeddable, EMBEDDINGS_COLLECTION } = requireFunctions('./lib/embeddings.js')
  const { seedAgentFixture, TIME_ZONE } = await import('../tests/fixtures/agent.fixture.mjs')

  const authBase = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`
  const functionsBase = `http://127.0.0.1:5001/${process.env.GCLOUD_PROJECT}/us-central1`
  const runId = `${Date.now()}`
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, `agent-eval-${runId}`)
  const db = getFirestore(app)
  try {
    // Emulator ID token for a fresh user.
    const signUp = await fetch(`${authBase}/accounts:signUp?key=emulator-only-fixture-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `eval-${runId}@example.test`, password: 'emulator-only-password', returnSecureToken: true })
    }).then(response => response.json())
    assert.ok(signUp.idToken, 'auth emulator sign-up failed')
    const now = new Date()
    const ids = await seedAgentFixture(db, { workspaceId: `ws-eval-${runId}`, userId: signUp.localId, now })
    const user = (await db.collection('users').doc(signUp.localId).get()).data()
    const tools = buildAgentTools(db, {
      workspaceId: ids.workspaceId, userId: signUp.localId, timeZone: TIME_ZONE, primaryCurrency: resolvePrimaryCurrency(user)
    })
    const dates = buildDateContext(now, TIME_ZONE)
    const vars = {
      ...ids,
      dates,
      month: { day01: dates.thisMonth.start, day07: `${dates.thisMonth.start.slice(0, 8)}07` }
    }

    // Expected numbers come from the deterministic tools on the seeded data.
    const expectedNumbers = async c => Promise.all((c.expectNumbers ?? []).map(async spec => {
      const tool = tools.find(t => t.name === spec.tool)
      const output = await tool.run(resolvePlaceholder(spec.args, vars))
      assert.equal(output?.error, undefined, `${c.id}: ${spec.tool} failed: ${output?.error}`)
      const value = readPath(output, spec.path, vars)
      assert.equal(typeof value, 'number', `${c.id}: ${spec.path} did not resolve to a number`)
      return { path: spec.path, value }
    }))

    let loaded = false
    for (let attempt = 0; attempt < 60 && !loaded; attempt += 1) {
      loaded = await fetch(`${functionsBase}/chatWithAgent`, { method: 'GET' }).then(r => r.status === 405, () => false)
      if (!loaded) await new Promise(done => setTimeout(done, 500))
    }
    assert.ok(loaded, 'chatWithAgent is not loaded in the functions emulator')

    if (dryRun) {
      for (const c of cases) {
        resolvePlaceholder(c.expectArgs ?? [], vars)
        resolvePlaceholder(c.forbidArgs ?? [], vars)
        const numbers = await expectedNumbers(c)
        console.log(`${c.id} ok  ${c.intent}${numbers.length ? `  → ${numbers.map(n => `${n.path}=${n.value}`).join(', ')}` : ''}`)
      }
      const seeded = await db.collection('transactions').where('workspaceId', '==', ids.workspaceId).get()
      console.log(`\nDry run OK: ${cases.length} cases valid; fixture seeded (${seeded.size} transactions); chatWithAgent loaded. No Gemini calls made.`)
      return
    }

    // Semantic search needs the trigger-built embeddings of the seeded rows.
    const embeddable = (await db.collection('transactions').where('workspaceId', '==', ids.workspaceId).get()).docs.filter(d => isEmbeddable(d.data())).length
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const indexed = (await db.collection(EMBEDDINGS_COLLECTION).where('workspaceId', '==', ids.workspaceId).get()).size
      if (indexed >= embeddable) break
      if (attempt === 59) console.warn(`Only ${indexed}/${embeddable} embeddings ready; semantic cases may fail.`)
      await new Promise(done => setTimeout(done, 1000))
    }

    const results = []
    for (const c of cases) {
      const failures = []
      const numbers = await expectedNumbers(c)
      const response = await fetch(`${functionsBase}/chatWithAgent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${signUp.idToken}` },
        body: JSON.stringify({ messages: [...(c.history ?? []), { role: 'user', content: c.question }], useDefaultKey: true, debugTrace: true })
      })
      const body = await response.json().catch(() => ({}))
      const calls = body.debugTrace?.toolCalls ?? []
      if (response.status !== 200) failures.push(`HTTP ${response.status}: ${body.error ?? 'sin cuerpo'}`)
      else if (!body.debugTrace) failures.push('debugTrace missing (is FUNCTIONS_EMULATOR set?)')
      for (const name of c.expectTools) {
        if (!calls.some(call => name.split('|').includes(call.name))) failures.push(`tool ${name} not called`)
      }
      for (const spec of resolvePlaceholder(c.expectArgs ?? [], vars)) {
        if (!calls.some(call => call.name === spec.tool && argsMatch(call.input, spec.args))) {
          failures.push(`${spec.tool} never called with ${JSON.stringify(spec.args)}`)
        }
      }
      for (const spec of resolvePlaceholder(c.forbidArgs ?? [], vars)) {
        if (calls.some(call => call.name === spec.tool && argsMatch(call.input, spec.args))) {
          failures.push(`${spec.tool} called with forbidden ${JSON.stringify(spec.args)}`)
        }
      }
      const toolResults = body.debugTrace?.toolResults ?? []
      for (const name of c.expectSuccess ?? []) {
        if (!toolResults.some(r => r.name === name && r.success)) failures.push(`tool ${name} never succeeded`)
      }
      for (const name of c.forbidSuccess ?? []) {
        if (toolResults.some(r => r.name === name && r.success)) failures.push(`tool ${name} succeeded but must not`)
      }
      if (c.expectAnswer && !new RegExp(c.expectAnswer, 'i').test(String(body.response ?? ''))) {
        failures.push(`answer does not match /${c.expectAnswer}/i`)
      }
      if (!String(body.response ?? '').trim()) failures.push('empty answer')
      const mentioned = numbersIn(String(body.response ?? ''))
      for (const { path, value } of numbers) {
        if (value === 0) continue // a zero cannot be told apart from other zeros in prose
        const target = Math.abs(value)
        if (!mentioned.some(n => Math.abs(n - target) <= target * 0.01)) failures.push(`number ${path}=${value} not in answer`)
      }
      results.push({ id: c.id, pass: failures.length === 0 })
      const guard = body.debugTrace?.guard ? `  guard=${body.debugTrace.guard}` : ''
      const retried = body.debugTrace?.attempts > 1 ? `  attempts=${body.debugTrace.attempts}` : ''
      const toolErrors = toolResults.filter(r => r.error).map(r => `${r.name}: ${r.error}`)
      console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${c.id} ${c.intent}  [${calls.map(call => call.name).join(', ') || 'sin herramientas'}]${retried}${guard}`)
      for (const toolError of toolErrors) console.log(`     ! ${toolError}`)
      for (const rejected of body.debugTrace?.rejectedAnswers ?? []) console.log(`     ~ rejected: ${String(rejected).slice(0, 400).replace(/\s+/g, ' ') || '(vacía)'}`)
      for (const failure of failures) console.log(`     - ${failure}`)
      if (failures.length) console.log(`     answer: ${String(body.response ?? '').slice(0, 400).replace(/\s+/g, ' ')}`)
    }
    const passed = results.filter(r => r.pass).length
    console.log(`\n${passed}/${results.length} cases passed.`)
    if (passed !== results.length) process.exitCode = 1
  } finally {
    await deleteApp(app)
  }
}

if (childMode) await runChild()
else await runParent()
