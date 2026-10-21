import assert from 'node:assert/strict'
import { accessSync, constants, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectId = 'demo-vault-pockets'
const configPath = resolve(repositoryRoot, 'functions/firebase.pockets-imports.json')
const rulesLink = resolve(repositoryRoot, 'functions/test-fixtures/pockets-callable/firestore.rules')
const expectedRules = resolve(repositoryRoot, 'firestore.rules')
const originalHome = homedir()
const emulatorCache = process.env.FIREBASE_EMULATORS_PATH || join(originalHome, '.cache/firebase/emulators')
const uiMode = process.argv.slice(2).length === 1 && process.argv[2] === '--ui'
assert.ok(process.argv.length === 2 || uiMode, 'supported invocation is node tests/pockets.imports.emulators.mjs [--ui]')

function ensurePortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`Required emulator port ${port} is unavailable: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(error =>
      error ? reject(error) : resolvePort()
    ))
  })
}

function resolveCachedCli() {
  const cacheRoot = join(originalHome, '.npm/_npx')
  const matches = []
  for (const cacheEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!cacheEntry.isDirectory()) continue
    const packagePath = join(cacheRoot, cacheEntry.name, 'node_modules/firebase-tools/package.json')
    try {
      const packageData = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageData.version === '15.33.0') matches.push(join(dirname(packagePath), 'lib/bin/firebase.js'))
    } catch {
      // A cache directory without the exact approved CLI version is not a candidate.
    }
  }
  assert.equal(matches.length, 1, 'exact cached firebase-tools 15.33.0 entry must be uniquely available')
  return matches[0]
}

function resolveCachedBrowser() {
  const cacheRoot = join(originalHome, '.npm/_npx')
  const matches = []
  for (const cacheEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!cacheEntry.isDirectory()) continue
    const packagePath = join(cacheRoot, cacheEntry.name, 'node_modules/playwright/package.json')
    try {
      const packageData = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageData.version === '1.63.0') matches.push(packagePath)
    } catch {
      // An unrelated cache entry is not a candidate for browser proof.
    }
  }
  assert.equal(matches.length, 1, 'exact cached Playwright 1.63.0 package must be uniquely available')
  const browserRequire = createRequire(matches[0])
  const playwright = browserRequire('playwright')
  const executable = playwright.chromium.executablePath()
  assert.match(executable, /chromium-1243/, 'only the preapproved cached Chromium revision may run')
  assert.ok(existsSync(executable), `cached Chromium executable must exist: ${executable}`)
  accessSync(executable, constants.X_OK)
  return { packagePath: matches[0], executable }
}

assert.equal(realpathSync(rulesLink), expectedRules, 'callable emulator must load the repository Firestore rules')
assert.match(readFileSync(rulesLink, 'utf8'), /function isWorkspaceMember\(/)
const cliEntry = resolveCachedCli()
const cliVersion = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' })
assert.equal(cliVersion.status, 0, `cached Firebase CLI version check failed: ${cliVersion.stderr}`)
assert.equal(cliVersion.stdout.trim(), '15.33.0', 'only the approved cached Firebase CLI may run')
const browserTools = uiMode ? resolveCachedBrowser() : null
for (const port of uiMode ? [8080, 9099, 5001, 4173] : [8080, 9099, 5001]) await ensurePortAvailable(port)

const temporaryHome = mkdtempSync(join(tmpdir(), 'pockets-imports-home-'))
chmodSync(temporaryHome, 0o700)
const childEnvironment = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: temporaryHome,
  TMPDIR: tmpdir(),
  npm_config_offline: 'true',
  FIREBASE_EMULATORS_PATH: emulatorCache,
  CI: 'true',
  ...(browserTools ? {
    POCKETS_PLAYWRIGHT_PACKAGE: browserTools.packagePath,
    POCKETS_CHROMIUM_EXECUTABLE: browserTools.executable
  } : {})
}

const testCommand = uiMode
  ? 'node --test --test-concurrency=1 tests/pockets.integration.test.mjs tests/pockets.imports.integration.test.mjs tests/settlements.pockets.integration.test.mjs && node --test tests/pockets.ui.test.mjs'
  : 'node --test --test-concurrency=1 tests/pockets.integration.test.mjs tests/pockets.imports.integration.test.mjs tests/settlements.pockets.integration.test.mjs'
const command = [
  'emulators:exec', '--project', projectId, '--only', 'auth,firestore,functions',
  '--config', 'functions/firebase.pockets-imports.json', testCommand
]

if (browserTools) {
  console.log(`Using cached Playwright 1.63.0 and Chromium revision 1243: ${browserTools.executable}`)
}

try {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliEntry, ...command], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: 'inherit'
    })
    child.once('error', rejectRun)
    child.once('exit', code => code === 0
      ? resolveRun()
      : rejectRun(new Error(`Firebase emulator runner exited with ${code}`)))
  })
} finally {
  rmSync(temporaryHome, { recursive: true, force: true })
}
