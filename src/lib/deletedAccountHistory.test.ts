import test from 'node:test'
import assert from 'node:assert/strict'
import { DELETED_ACCOUNT_HISTORY_MESSAGE, referencesDeletedAccount } from './deletedAccountHistory.ts'

const accounts = [{ id: 'bank' }, { id: 'card' }]
const movement = (over: Record<string, unknown>) => ({ workspaceId: 'ws-1', ...over })

test('a movement whose source or transfer destination was deleted is read-only history', () => {
  assert.equal(referencesDeletedAccount(movement({ type: 'expense', accountId: 'deleted' }), accounts, 'ws-1'), true)
  assert.equal(referencesDeletedAccount(movement({ type: 'income', accountId: 'deleted' }), accounts, 'ws-1'), true)
  assert.equal(referencesDeletedAccount(movement({ type: 'transfer', accountId: 'bank', toAccountId: 'deleted' }), accounts, 'ws-1'), true)
  assert.equal(referencesDeletedAccount(movement({ type: 'transfer', accountId: 'deleted', toAccountId: 'card' }), accounts, 'ws-1'), true)
  assert.equal(referencesDeletedAccount(movement({ type: 'expense', accountId: '' }), accounts, 'ws-1'), true)
  assert.match(DELETED_ACCOUNT_HISTORY_MESSAGE, /fue eliminada/)
})

test('movements whose accounts exist, are still loading, or belong to another workspace stay editable', () => {
  assert.equal(referencesDeletedAccount(movement({ type: 'expense', accountId: 'bank' }), accounts, 'ws-1'), false)
  assert.equal(referencesDeletedAccount(movement({ type: 'transfer', accountId: 'bank', toAccountId: 'card' }), accounts, 'ws-1'), false)
  // A non-transfer keeps a stale toAccountId out of the check.
  assert.equal(referencesDeletedAccount(movement({ type: 'expense', accountId: 'bank', toAccountId: 'deleted' }), accounts, 'ws-1'), false)
  assert.equal(referencesDeletedAccount(movement({ type: 'expense', accountId: 'deleted' }), accounts, null), false)
  // A row left over from the previous workspace is never judged against the new workspace's accounts.
  assert.equal(referencesDeletedAccount(movement({ workspaceId: 'ws-0', type: 'expense', accountId: 'deleted' }), accounts, 'ws-1'), false)
  assert.equal(referencesDeletedAccount({ type: 'expense', accountId: 'deleted' }, accounts, 'ws-1'), false)
})
