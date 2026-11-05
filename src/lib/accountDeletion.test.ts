import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACCOUNT_DELETION_CONFIRMATION, isDeletionConfirmed } from './accountDeletion.ts'

test('deletion is confirmed only by typing ELIMINAR, ignoring case and surrounding spaces', () => {
  assert.equal(ACCOUNT_DELETION_CONFIRMATION, 'ELIMINAR')
  assert.equal(isDeletionConfirmed('ELIMINAR'), true)
  assert.equal(isDeletionConfirmed('  eliminar '), true)
  assert.equal(isDeletionConfirmed(''), false)
  assert.equal(isDeletionConfirmed('ELIMINA'), false)
  assert.equal(isDeletionConfirmed('ELIMINAR CUENTA'), false)
})
