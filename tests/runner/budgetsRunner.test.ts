import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Public script configuration; the real emulator command is checked separately.
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const securityCommand = manifest.scripts['test:budgets:security']
const runnerOptions = securityCommand.split(/\s+/)

test('budget security files execute one at a time', () => {
  assert.equal(runnerOptions.find(option => option.startsWith('--test-concurrency=')), '--test-concurrency=1')
})

test('budget security cases have a 15-second default execution bound', () => {
  assert.equal(runnerOptions.find(option => option.startsWith('--test-timeout=')), '--test-timeout=15000')
})

test('budget security retains its demo-only emulator configuration and complete file discovery', () => {
  const previousCommand = 'pnpm exec firebase emulators:exec --only firestore --project demo-vault-b2 --config firebase.budgets.test.json "pnpm exec node --test tests/firestore/*.test.ts"'
  assert.equal(
    securityCommand.replace(' --test-concurrency=1', '').replace(' --test-timeout=15000', ''),
    previousCommand,
  )
})

test('the default test command retains existing application test discovery', () => {
  assert.equal(manifest.scripts.test.split(/\s+/).slice(0, 3).join(' '), 'node --test src/**/*.test.ts')
})
