import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const wizardPath = fileURLToPath(new URL('./OnboardingWizard.vue', import.meta.url))
const appPath = fileURLToPath(new URL('../App.vue', import.meta.url))
const wizard = readFileSync(wizardPath, 'utf8')
const app = readFileSync(appPath, 'utf8')

test('the app mounts the onboarding wizard for signed-in users', () => {
  assert.match(app, /<OnboardingWizard v-if="authStore\.isAuthenticated" \/>/)
})

test('the wizard opens while the workspace cap currency is unconfirmed and loads budget settings per workspace', () => {
  assert.match(wizard, /categoryBudgetCurrency\.status === 'unconfirmed'/)
  assert.match(wizard, /goalsStore\.loadBudgetSettings\(\)/)
  assert.match(wizard, /authStore\.activeWorkspaceId/)
})

test('step 1 confirms the cap currency from a selector and cannot be skipped', () => {
  assert.match(wizard, /<select[^>]*v-model="currencyCode"/)
  assert.match(wizard, /goalsStore\.confirmLegacyCategoryBudgetCurrency\(currencyCode\.value\)/)
  const stepOne = wizard.match(/v-if="step === 1"[\s\S]*?v-else/)?.[0] ?? ''
  assert.ok(stepOne, 'step 1 markup must exist')
  assert.doesNotMatch(stepOne, /Omitir/, 'the mandatory currency step must not offer a skip')
})

test('step 2 offers optional push for this device and can be skipped', () => {
  assert.match(wizard, /enablePush\(/)
  assert.match(wizard, /getPushStatus\(/)
  assert.match(wizard, /Omitir por ahora/)
  assert.match(wizard, /Configuración/)
})
