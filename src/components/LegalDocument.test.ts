import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const presentational = read('./LegalDocument.vue')
const container = read('../views/Legal.vue')

test('legal document view renders from props and a back slot only', () => {
  assert.match(presentational, /defineProps<\{ document: LegalDocument; isDraft: boolean \}>\(\)/)
  assert.match(presentational, /<slot name="back" \/>/)
  assert.match(presentational, /Borrador: faltan los datos del responsable y la revisión legal\./)
  assert.doesNotMatch(presentational, /router-link|useRouter|useRoute|Store\(/)
})

test('app legal page keeps its in-app back link through the slot', () => {
  assert.match(container, /<LegalDocument :document="document" :is-draft="isDraft">/)
  assert.match(container, /<template #back>[\s\S]*<router-link[\s\S]*:to="backTarget"/)
  assert.match(container, /\{ name: 'Settings', query: \{ tab: 'data' \} \}/)
})
