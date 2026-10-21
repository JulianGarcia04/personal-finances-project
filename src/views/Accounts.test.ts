import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const accountsView = readFileSync(fileURLToPath(new URL('./Accounts.vue', import.meta.url)), 'utf8')

const computedBody = (name: string) => {
  const match = accountsView.match(new RegExp(`const ${name} = computed\\(\\(\\) =>([\\s\\S]*?)\\n\\)`))
  assert.ok(match, `${name} must be a computed selector`)
  return match[1]
}

test('settlement selectors offer main accounts, banks with pockets included, but never a pocket', () => {
  for (const name of ['settleSourceAccounts', 'settleDestinationAccounts']) {
    const body = computedBody(name)
    assert.match(body, /!isPocketAccount\(acc\)/, `${name} must hide pockets`)
    assert.doesNotMatch(body, /isPocketRelatedAccount|childAccountIds/, `${name} must keep banks that have pockets`)
  }
  assert.match(computedBody('settleSourceAccounts'), /!acc\.mirror/, 'bridge accounts still cannot pay a settlement')
})
