import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const landing = read('./Landing.vue')
const login = read('./Login.vue')
const router = read('../router/index.ts')
const html = read('../../index.html')

test('landing speaks to couples and individuals and says the beta is free', () => {
  assert.match(landing, /pareja/)
  assert.match(landing, /personales/)
  assert.match(landing, /Gratis durante la beta/)
})

test('landing links to signup, login and both legal documents', () => {
  assert.match(landing, /:href="signupHref"/)
  assert.match(landing, /:href="loginHref"/)
  assert.ok(landing.includes('const signupHref = `${props.appUrl}/login?modo=registro`'))
  assert.ok(landing.includes('const loginHref = `${props.appUrl}/login`'))
  assert.match(landing, /href="\/terminos"/)
  assert.match(landing, /href="\/privacidad"/)
})

test('landing renders without the app router so the static site can reuse it', () => {
  assert.doesNotMatch(landing, /router-link|useRouter|useRoute|Store\(/)
  assert.match(landing, /withDefaults\(defineProps<\{ appUrl\?: string \}>\(\), \{ appUrl: '' \}\)/)
})

test('signup link opens the login screen in register mode', () => {
  assert.match(login, /route\.query\.modo === 'registro' \? 'register' : 'login'/)
})

test('the app no longer serves the landing: the static site on the landing domain does', () => {
  assert.doesNotMatch(router, /\/bienvenida|name: 'Landing'|isInstalledApp/)
})

test('signed-out visits to every protected route open the login', () => {
  const guard = router.slice(router.indexOf('router.beforeEach'))
  assert.match(guard, /if \(to\.meta\.requiresAuth && !isAuth\) \{\s*next\(\{ name: 'Login' \}\)/)
  for (const name of ['Dashboard', 'Accounts', 'Transactions', 'Import', 'Settings', 'Agent', 'Goals']) {
    const from = router.indexOf(`name: '${name}'`)
    assert.match(router.slice(from, from + 160), /meta: \{ requiresAuth: true \}/, name)
  }
})

test('shared links get an Open Graph preview', () => {
  assert.match(html, /<meta property="og:title" content="[^"]+"/)
  assert.match(html, /<meta property="og:description" content="[^"]*pareja[^"]*"/)
  assert.match(html, /<meta property="og:image" content="\/icon-512.png"/)
})
