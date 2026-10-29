import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPORT_COLLECTIONS, buildWorkspaceExport, exportFileName, normalizeForExport } from './dataExport.ts'

const timestamp = (iso: string) => ({ toDate: () => new Date(iso), seconds: 1, nanoseconds: 0 })

test('timestamps and dates become ISO strings at any depth', () => {
  assert.deepEqual(
    normalizeForExport({
      createdAt: timestamp('2026-10-01T05:00:00.000Z'),
      date: new Date('2026-10-02T05:00:00.000Z'),
      installments: [{ dueAt: timestamp('2026-11-01T05:00:00.000Z'), amount: 10 }],
      note: null,
      tags: ['a']
    }),
    {
      createdAt: '2026-10-01T05:00:00.000Z',
      date: '2026-10-02T05:00:00.000Z',
      installments: [{ dueAt: '2026-11-01T05:00:00.000Z', amount: 10 }],
      note: null,
      tags: ['a']
    }
  )
})

test('export holds every workspace collection, the profile and the caps of each budget', () => {
  assert.deepEqual([...EXPORT_COLLECTIONS], ['accounts', 'transactions', 'categories', 'goals', 'budgets', 'chats'])

  const collections = Object.fromEntries(EXPORT_COLLECTIONS.map((name) => [name, []])) as Record<(typeof EXPORT_COLLECTIONS)[number], { id: string }[]>
  collections.transactions = [{ id: 't1', date: timestamp('2026-10-03T05:00:00.000Z') } as { id: string }]
  collections.budgets = [{ id: 'b1' }, { id: 'b2' }]

  const result = buildWorkspaceExport({
    now: new Date('2026-10-29T15:00:00.000Z'),
    workspace: { id: 'ws-1', name: 'Casa' },
    profile: { uid: 'uid-1', email: 'ana@example.com' },
    collections,
    budgetCategoryCaps: { b1: [{ id: 'food', amount: 100 }] }
  })

  assert.equal(result.format, 'vault-export')
  assert.equal(result.formatVersion, 1)
  assert.equal(result.exportedAt, '2026-10-29T15:00:00.000Z')
  assert.deepEqual(result.workspace, { id: 'ws-1', name: 'Casa' })
  assert.deepEqual(result.profile, { uid: 'uid-1', email: 'ana@example.com' })
  assert.deepEqual(result.transactions, [{ id: 't1', date: '2026-10-03T05:00:00.000Z' }])
  assert.deepEqual(result.budgets, [
    { id: 'b1', categoryCaps: [{ id: 'food', amount: 100 }] },
    { id: 'b2', categoryCaps: [] }
  ])
  for (const name of EXPORT_COLLECTIONS) assert.ok(Array.isArray(result[name]), name)
})

test('file name uses the workspace name and the local calendar day', () => {
  assert.equal(exportFileName('Mi Casa & Co', new Date(2026, 9, 29, 23, 30)), 'vault-mi-casa-co-2026-10-29.json')
  assert.equal(exportFileName('   ', new Date(2026, 0, 5)), 'vault-workspace-2026-01-05.json')
})
