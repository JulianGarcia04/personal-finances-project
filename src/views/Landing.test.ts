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
  assert.match(landing, /:to="\{ name: 'Login', query: \{ modo: 'registro' \} \}"/)
  assert.match(landing, /:to="\{ name: 'Login' \}"/)
  assert.match(landing, /to="\/terminos"/)
  assert.match(landing, /to="\/privacidad"/)
})

test('signup link opens the login screen in register mode', () => {
  assert.match(login, /route\.query\.modo === 'registro' \? 'register' : 'login'/)
})

test('landing is a guest-only route', () => {
  const from = router.indexOf("path: '/bienvenida'")
  assert.ok(from >= 0)
  const route = router.slice(from, from + 200)
  assert.match(route, /name: 'Landing'/)
  assert.match(route, /meta: \{ guestOnly: true \}/)
})

test('signed-out visits to the dashboard show the landing, except in the installed app', () => {
  const guard = router.slice(router.indexOf('router.beforeEach'))
  assert.match(guard, /to\.name === 'Dashboard' && !isInstalledApp\(\) \? \{ name: 'Landing' \} : \{ name: 'Login' \}/)
  assert.match(router, /matchMedia\('\(display-mode: standalone\)'\)/)
})

test('every other protected route still redirects to the login', () => {
  const guard = router.slice(router.indexOf('router.beforeEach'))
  assert.match(guard, /if \(to\.meta\.requiresAuth && !isAuth\)/)
  for (const name of ['Accounts', 'Transactions', 'Import', 'Settings', 'Agent', 'Goals']) {
    const from = router.indexOf(`name: '${name}'`)
    assert.match(router.slice(from, from + 160), /meta: \{ requiresAuth: true \}/, name)
  }
})

test('shared links get an Open Graph preview', () => {
  assert.match(html, /<meta property="og:title" content="[^"]+"/)
  assert.match(html, /<meta property="og:description" content="[^"]*pareja[^"]*"/)
  assert.match(html, /<meta property="og:image" content="\/icon-512.png"/)
})
