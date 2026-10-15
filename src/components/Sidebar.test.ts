import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const sidebar = readFileSync(fileURLToPath(new URL('./Sidebar.vue', import.meta.url)), 'utf8')
const workspaceSwitch = sidebar.match(/const switchWorkspace = async \(workspaceId: string\) => \{([\s\S]*?)\n\}/)?.[1] ?? ''

test('workspace switching reloads budget settings alongside operational workspace data', () => {
  assert.match(workspaceSwitch, /goalsStore\.loadBudgetSettings\(\)/)
  assert.match(workspaceSwitch, /Promise\.all\(/)
})
