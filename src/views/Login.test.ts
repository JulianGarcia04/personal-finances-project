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

test('login maps every auth failure through the shared messages of its flow', () => {
  assert.match(block(login, /const handleSubmit = async/), /authErrorMessage\(error, 'email'\)/)
  assert.match(block(login, /const handleGoogle = async/), /authErrorMessage\(error, 'google'\)/)
  assert.match(block(login, /const handleReset = async/), /authErrorMessage\(error, 'reset'\)/)
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

const router = readFileSync(fileURLToPath(new URL('../router/index.ts', import.meta.url)), 'utf8')

test('signup requires an unticked consent checkbox linking both documents', () => {
  assert.match(login, /id="legal-consent"[\s\S]{0,200}v-model="acceptedLegal"[\s\S]{0,120}required/)
  assert.match(login, /const acceptedLegal = ref\(false\)/)
  assert.match(login, /to="\/terminos"/)
  assert.match(login, /to="\/privacidad"/)
})

test('Google sign-in states that continuing accepts both documents', () => {
  assert.match(login, /Al continuar con Google aceptas/)
})

test('store records consent only when it creates the profile', () => {
  const ensure = block(store, /async ensureUserProfile\(/)
  assert.match(ensure, /buildLegalConsent\(consentMethod, serverTimestamp\(\)\)/)
  assert.ok(
    ensure.indexOf('if (snapshot.exists())') < ensure.indexOf('buildLegalConsent('),
    'existing profiles are returned before consent is built'
  )
  assert.match(block(store, /async signUp\(/), /'signup-checkbox'/)
  assert.match(block(store, /async signInWithGoogle\(/), /'google-continue'/)
})

test('legal documents are public routes', () => {
  for (const path of ['/terminos', '/privacidad']) {
    const route = block(router, new RegExp(`path: '${path}'`)).slice(0, 220)
    assert.doesNotMatch(route, /requiresAuth|guestOnly/)
  }
})
