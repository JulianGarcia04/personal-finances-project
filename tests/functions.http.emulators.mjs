// Runs tests/functions.http.emulator.test.mjs against the real HTTP functions
// (functions/lib/index.js) on the auth+firestore+functions emulators of a demo project.
//
// The functions emulator loads `.env` from the functions source directory, and
// functions/.env holds real secrets. So the launcher builds a throwaway source
// directory in the OS temp dir: an index.cjs that re-exports functions/lib/index.js,
// a node_modules symlink to functions/node_modules, and tests/fixtures/functions.env
// copied as `.env`. The child process environment is allowlisted, so no ambient
// key or credential reaches the emulator.
//
// Requires `pnpm --filter functions build` and the cached firebase-tools 15.33.0
// (same offline policy as tests/pockets.imports.emulators.mjs).
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectId = 'demo-vault-http'
const functionsRoot = resolve(repositoryRoot, 'functions')
const configTemplate = resolve(repositoryRoot, 'tests/firebase.functions-http.json')
const envFixture = resolve(repositoryRoot, 'tests/fixtures/functions.env')
const originalHome = homedir()
const emulatorCache = process.env.FIREBASE_EMULATORS_PATH || join(originalHome, '.cache/firebase/emulators')
assert.equal(process.argv.length, 2, 'supported invocation is node tests/functions.http.emulators.mjs')
assert.ok(existsSync(resolve(functionsRoot, 'lib/index.js')), 'run `pnpm --filter functions build` first')

function ensurePortAvailable(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`Required emulator port ${port} is unavailable: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(error => (error ? reject(error) : resolvePort())))
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

// The fixture env must never carry anything that looks like a real Google API key.
const fixtureEnv = readFileSync(envFixture, 'utf8')
assert.doesNotMatch(fixtureEnv, /AIza[0-9A-Za-z_-]{20,}/, 'the emulator env fixture must not contain real API keys')
assert.match(fixtureEnv, /^ENCRYPTION_SECRET=emulator-only-/m)

const cliEntry = resolveCachedCli()
const cliVersion = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' })
assert.equal(cliVersion.status, 0, `cached Firebase CLI version check failed: ${cliVersion.stderr}`)
assert.equal(cliVersion.stdout.trim(), '15.33.0', 'only the approved cached Firebase CLI may run')
for (const port of [8080, 9099, 5001]) await ensurePortAvailable(port)

const workRoot = mkdtempSync(join(tmpdir(), 'functions-http-'))
chmodSync(workRoot, 0o700)
const temporaryHome = join(workRoot, 'home')
const sourceDir = join(workRoot, 'source')
for (const dir of [temporaryHome, sourceDir]) {
  mkdirSync(dir, { mode: 0o700 })
}
const functionsPackage = JSON.parse(readFileSync(resolve(functionsRoot, 'package.json'), 'utf8'))
writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
  name: 'functions-http-emulator-fixture',
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
copyFileSync(envFixture, join(sourceDir, '.env'))

// The CLI resolves `source` and `rules` relative to the config file (absolute paths
// are not honored), so the materialized config lives next to the throwaway source and
// links the live repository rules.
const config = JSON.parse(readFileSync(configTemplate, 'utf8'))
symlinkSync(resolve(dirname(configTemplate), config.firestore.rules), join(workRoot, 'firestore.rules'))
config.functions.source = 'source'
config.firestore.rules = 'firestore.rules'
const configPath = join(workRoot, 'firebase.json')
writeFileSync(configPath, JSON.stringify(config, null, 2))

const childEnvironment = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: temporaryHome,
  TMPDIR: tmpdir(),
  npm_config_offline: 'true',
  FIREBASE_EMULATORS_PATH: emulatorCache,
  CI: 'true'
}
const testFile = resolve(repositoryRoot, 'tests/functions.http.emulator.test.mjs')
const command = [
  'emulators:exec', '--project', projectId, '--only', 'auth,firestore,functions',
  '--config', configPath, `node --test --test-concurrency=1 ${JSON.stringify(testFile)}`
]

try {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliEntry, ...command], {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: 'inherit'
    })
    child.once('error', rejectRun)
    child.once('exit', code => (code === 0
      ? resolveRun()
      : rejectRun(new Error(`Firebase emulator runner exited with ${code}`))))
  })
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}
