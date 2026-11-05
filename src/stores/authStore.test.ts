import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const store = readFileSync(fileURLToPath(new URL('./authStore.ts', import.meta.url)), 'utf8')

test('deleteAccount calls the server function with the confirmation word, then signs out', () => {
  const action = store.slice(store.indexOf('async deleteAccount()'))
  assert.match(action.slice(0, 700), /httpsCallable\(functions, 'deleteAccount'\)\(\{ confirmation: ACCOUNT_DELETION_CONFIRMATION \}\)/)
  assert.match(action.slice(0, 700), /await signOut\(auth\)/)
  assert.match(action.slice(0, 700), /this\.user = null/)
})
