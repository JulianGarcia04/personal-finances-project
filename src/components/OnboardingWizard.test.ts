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

test('step 1 saves country and main currency, proposing the country currency', () => {
  const stepOne = wizard.match(/v-if="step === 1"[\s\S]*?v-else-if/)?.[0] ?? ''
  assert.ok(stepOne, 'step 1 markup must exist')
  assert.match(stepOne, /<select[^>]*v-model="countryCode"/)
  assert.match(stepOne, /<select[^>]*v-model="mainCurrencyCode"/)
  assert.match(wizard, /mainCurrencyCode\.value = currencyForCountry\(countryCode\.value\)/)
  assert.match(wizard, /settingsStore\.saveSettings\(\{[\s\S]*?country: countryCode\.value,[\s\S]*?currency: mainCurrencyCode\.value/)
  assert.doesNotMatch(stepOne, /Omitir/, 'the region step must not offer a skip')
})

test('step 2 confirms the cap currency from a selector prefilled with the main currency and cannot be skipped', () => {
  const stepTwo = wizard.match(/v-else-if="step === 2"[\s\S]*?v-else/)?.[0] ?? ''
  assert.ok(stepTwo, 'step 2 markup must exist')
  assert.match(stepTwo, /<select[^>]*v-model="currencyCode"/)
  assert.match(wizard, /currencyCode\.value = defaultCurrencyCode\(mainCurrencyCode\.value\)/)
  assert.match(wizard, /goalsStore\.confirmLegacyCategoryBudgetCurrency\(currencyCode\.value\)/)
  assert.doesNotMatch(stepTwo, /Omitir/, 'the mandatory currency step must not offer a skip')
})

test('step 3 offers optional push for this device and can be skipped', () => {
  assert.match(wizard, /enablePush\(/)
  assert.match(wizard, /getPushStatus\(/)
  assert.match(wizard, /Omitir por ahora/)
  assert.match(wizard, /Configuración/)
  assert.match(wizard, /Paso \{\{ step \}\} de 3/)
})

test('without a saved country the region step proposes that country currency instead of the signup default', () => {
  assert.match(wizard, /settingsStore\.countryConfigured\s*\?\s*defaultCurrencyCode\(settingsStore\.currency\)\s*:\s*currencyForCountry\(settingsStore\.country\)/)
})
