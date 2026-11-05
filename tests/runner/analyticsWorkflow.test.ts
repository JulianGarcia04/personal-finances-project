import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = (name: string) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
const merge = workflow('firebase-hosting-merge.yml')
const pullRequest = workflow('firebase-hosting-pull-request.yml')

test('production deploys build with the PostHog key and host from repository variables', () => {
  assert.match(merge, /VITE_POSTHOG_KEY: \$\{\{ vars\.VITE_POSTHOG_KEY \}\}/)
  assert.match(merge, /VITE_POSTHOG_HOST: \$\{\{ vars\.VITE_POSTHOG_HOST \}\}/)
  assert.match(merge, /::warning::[^\n]*VITE_POSTHOG_KEY/)
})

test('pull request previews never send analytics', () => {
  assert.doesNotMatch(pullRequest, /POSTHOG/)
})
