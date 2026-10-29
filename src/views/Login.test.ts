import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const login = readFileSync(fileURLToPath(new URL('./Login.vue', import.meta.url)), 'utf8')
const store = readFileSync(fileURLToPath(new URL('../stores/authStore.ts', import.meta.url)), 'utf8')

const block = (source: string, start: RegExp) => {
  const from = source.search(start)
  assert.ok(from >= 0, `missing ${start}`)
  return source.slice(from, from + 1600)
}

test('login offers Google sign-in and enters the app like email sign-in', () => {
  assert.match(login, /Continuar con Google/)
  const handler = block(login, /const handleGoogle = async/)
  assert.match(handler, /authStore\.signInWithGoogle\(\)/)
  assert.match(handler, /settingsStore\.loadSettings\(\)/)
  assert.match(handler, /router\.push\(\{ name: 'Dashboard' \}\)/)
})

test('login offers password recovery with a neutral confirmation', () => {
  assert.match(login, /¿Olvidaste tu contraseña\?/)
  const handler = block(login, /const handleReset = async/)
  assert.match(handler, /authStore\.resetPassword\(email\.value\)/)
  assert.match(handler, /PASSWORD_RESET_NOTICE/)
})

test('login maps every auth failure through the shared messages', () => {
  assert.match(login, /authErrorMessage\(error\)/)
  assert.doesNotMatch(login, /err\.code === /)
})

test('store signs in with the Google popup and bootstraps the profile once', () => {
  const google = block(store, /async signInWithGoogle\(/)
  assert.match(google, /signInWithPopup\(auth, new GoogleAuthProvider\(\)\)/)
  assert.match(google, /this\.ensureUserProfile\(/)

  const signUp = block(store, /async signUp\(/)
  assert.match(signUp, /this\.ensureUserProfile\(/)

  const ensure = block(store, /async ensureUserProfile\(/)
  assert.match(ensure, /runTransaction\(db,/)
  assert.match(ensure, /if \(snapshot\.exists\(\)\)/)
  assert.match(ensure, /buildPersonalWorkspace\(/)
  assert.match(ensure, /buildUserProfile\(/)
})

test('store password reset hides unknown emails', () => {
  const reset = block(store, /async resetPassword\(/)
  assert.match(reset, /sendPasswordResetEmail\(auth, email/)
  assert.match(reset, /auth\/user-not-found/)
})
