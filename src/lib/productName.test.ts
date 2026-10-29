// The product is called Lynor Finanzas wherever people see it. Internal identifiers
// (storage keys, Firebase project IDs, the export format id) keep a lowercase
// "vault" and are not user-facing, so the check matches the capitalized name only.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const shipped = [
  '../../index.html',
  ...['../', '../../public/'].flatMap((dir) =>
    readdirSync(fileURLToPath(new URL(dir, import.meta.url)), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(vue|ts|js|webmanifest)$/.test(file) && !file.endsWith('.test.ts'))
      .map((file) => dir + file)
  )
]

test('the app calls itself Lynor Finanzas, never Vault', () => {
  for (const file of shipped) assert.doesNotMatch(read(file), /\b(Vault|VAULT)\b/, file)
  const manifest = JSON.parse(read('../../public/manifest.webmanifest'))
  assert.equal(manifest.name, 'Lynor Finanzas')
  assert.equal(manifest.short_name, 'Lynor Finanzas')
  assert.match(read('../../index.html'), /<title>Lynor Finanzas \|/)
  assert.match(read('../views/Login.vue'), /'Bienvenido a Lynor Finanzas'/)
})
