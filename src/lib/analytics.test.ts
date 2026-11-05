import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ANALYTICS_EVENTS, analyticsConfig, sanitizeEvent } from './analytics.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const event = (name: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  uuid: 'event-1',
  event: name,
  properties: { token: 'phc_test', distinct_id: 'uid-1', $browser: 'Chrome', ...properties },
  ...extra
})

test('analytics stays off in development and without a key or a host', () => {
  const production = { DEV: false, VITE_POSTHOG_KEY: 'phc_test', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com' }
  assert.deepEqual(analyticsConfig(production), { key: 'phc_test', host: 'https://eu.i.posthog.com' })
  assert.deepEqual(
    analyticsConfig({ ...production, VITE_POSTHOG_KEY: ' phc_test ', VITE_POSTHOG_HOST: ' https://eu.i.posthog.com/ ' }),
    { key: 'phc_test', host: 'https://eu.i.posthog.com' }
  )
  assert.equal(analyticsConfig({ ...production, DEV: true }), null)
  assert.equal(analyticsConfig({ ...production, VITE_POSTHOG_KEY: '' }), null)
  assert.equal(analyticsConfig({ ...production, VITE_POSTHOG_HOST: undefined }), null)
})

test('only the app events and the allowed PostHog events leave the browser', () => {
  for (const name of ['$autocapture', '$snapshot', '$rageclick', '$feature_flag_called', '$set', 'custom_event']) {
    assert.equal(sanitizeEvent(event(name)), null, name)
  }
  for (const name of ['$pageview', '$pageleave', '$exception', '$web_vitals', '$identify', ...Object.keys(ANALYTICS_EVENTS)]) {
    assert.notEqual(sanitizeEvent(event(name)), null, name)
  }
})

test('app events keep only their declared properties and the PostHog context', () => {
  const result = sanitizeEvent(event('transaction_created', { type: 'expense', amount: -50000, description: 'Mercado' }))!
  assert.equal(result.properties.type, 'expense')
  assert.equal('amount' in result.properties, false)
  assert.equal('description' in result.properties, false)
  assert.equal(result.properties.distinct_id, 'uid-1')
  assert.equal(result.properties.token, 'phc_test')
  assert.equal(result.properties.$browser, 'Chrome')
})

test('URLs lose their query string and hash, nested ones included', () => {
  const result = sanitizeEvent(event('$pageview', {
    $current_url: 'https://app.finances.lynor.cloud/transactions?search=arriendo#top',
    $referrer: 'https://finances.lynor.cloud/?utm_source=x',
    $pathname: '/transactions'
  }, { $set_once: { $initial_person_info: { u: 'https://app.finances.lynor.cloud/login?modo=registro', r: '$direct' } } }))!
  assert.equal(result.properties.$current_url, 'https://app.finances.lynor.cloud/transactions')
  assert.equal(result.properties.$referrer, 'https://finances.lynor.cloud/')
  assert.equal(result.properties.$pathname, '/transactions')
  const initial = (result.$set_once as { $initial_person_info: { u: string; r: string } }).$initial_person_info
  assert.equal(initial.u, 'https://app.finances.lynor.cloud/login')
  assert.equal(initial.r, '$direct')
})

test('error messages lose every number and the breadcrumbs are dropped', () => {
  const message = 'No puedes liquidar más de lo pendiente (1.250.000)'
  const result = sanitizeEvent(event('$exception', {
    $exception_list: [{ type: 'Error', value: message, stacktrace: { frames: [{ lineno: 89, filename: 'mirror.ts' }] } }],
    $exception_values: [message],
    $exception_message: 'Saldo 300,5',
    $exception_steps: [{ message: 'console: 50000' }]
  }))!
  const [exception] = result.properties.$exception_list as Array<{ value: string; stacktrace: { frames: Array<{ lineno: number }> } }>
  assert.equal(exception.value, 'No puedes liquidar más de lo pendiente (#)')
  assert.equal(exception.stacktrace.frames[0].lineno, 89)
  assert.deepEqual(result.properties.$exception_values, ['No puedes liquidar más de lo pendiente (#)'])
  assert.equal(result.properties.$exception_message, 'Saldo #')
  assert.equal('$exception_steps' in result.properties, false)
})

test('the app starts analytics and reports Vue errors', () => {
  const main = source('../main.ts')
  assert.match(main, /initAnalytics\(\)/)
  assert.match(main, /app\.config\.errorHandler = \(error, _instance, info\) => \{[\s\S]*?captureError\(error, \{ vue_info: info \}\)/)
})

test('signed-in users are identified by uid only and forgotten on logout and account deletion', () => {
  const store = source('../stores/authStore.ts')
  assert.match(store, /identifyUser\(firebaseUser\.uid\)/)
  assert.doesNotMatch(store, /identifyUser\([^)]*email/)
  for (const action of ['async logout()', 'async deleteAccount()']) {
    const start = store.indexOf(action)
    assert.match(store.slice(start, start + 900), /resetAnalytics\(\)/, action)
  }
  assert.match(store, /track\('signed_up', \{ method: 'email' \}\)/)
  assert.match(store, /track\('logged_in', \{ method: 'email' \}\)/)
  assert.match(store, /track\(created \? 'signed_up' : 'logged_in', \{ method: 'google' \}\)/)
})

test('each key action reports its event', () => {
  const sites: Array<[string, RegExp]> = [
    ['../components/OnboardingWizard.vue', /track\('onboarding_finished', \{ push_enabled: pushStatus\.value === 'enabled' \}\)/],
    ['../views/Accounts.vue', /track\('bank_account_created', \{ type: 'savings', pocket: true \}\)/],
    ['../views/Accounts.vue', /track\('bank_account_created', \{ type: newAcc\.value\.type, pocket: false \}\)/],
    ['../views/Transactions.vue', /track\('transaction_created', \{ type: newTx\.value\.type \}\)/],
    ['../views/Import.vue', /track\('statement_imported', \{ transactions: rows\.length \}\)/],
    ['../views/Agent.vue', /track\('advisor_message_sent'\)/],
    ['../views/Goals.vue', /track\('budget_created', \{ kind: draft\.kind \}\)/],
    ['../views/Goals.vue', /track\('goal_created'\)/],
    ['../views/Settings.vue', /track\('workspace_created'\)/],
    ['../views/Settings.vue', /track\('member_invited'\)/],
    ['../views/Settings.vue', /track\('data_exported'\)/],
    ['./push.ts', /track\('push_enabled'\)/]
  ]
  for (const [file, pattern] of sites) assert.match(source(file), pattern, file)
})
