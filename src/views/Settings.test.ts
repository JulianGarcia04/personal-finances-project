import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const settings = readFileSync(fileURLToPath(new URL('./Settings.vue', import.meta.url)), 'utf8')
const legal = readFileSync(fileURLToPath(new URL('./Legal.vue', import.meta.url)), 'utf8')

test('settings has a data tab that downloads the active workspace as JSON', () => {
  assert.match(settings, /type SettingsTab = [^\n]*'data'/)
  assert.match(settings, /id: 'data', label: 'Tus datos'/)
  assert.match(settings, /<template v-else-if="activeTab === 'data'">[\s\S]*@click="handleExport"/)

  const handler = settings.slice(settings.indexOf('const handleExport = async'))
  assert.match(handler.slice(0, 1200), /fetchWorkspaceExport\(db, authStore\.activeWorkspaceId, authStore\.user\.uid\)/)
  assert.match(handler.slice(0, 1200), /new Blob\(\[JSON\.stringify\(data, null, 2\)\], \{ type: 'application\/json' \}\)/)
  assert.match(handler.slice(0, 1200), /exportFileName\(/)
})

test('data tab links both legal documents and legal pages return to it', () => {
  const tab = settings.slice(settings.indexOf(`<template v-else-if="activeTab === 'data'">`))
  assert.match(tab, /to="\/terminos"/)
  assert.match(tab, /to="\/privacidad"/)
  assert.match(legal, /\{ name: 'Settings', query: \{ tab: 'data' \} \}/)
})

test('existing settings tabs are unchanged', () => {
  for (const id of ['workspace', 'regional', 'categories', 'ai']) {
    assert.match(settings, new RegExp(`id: '${id}', label: `))
  }
})
