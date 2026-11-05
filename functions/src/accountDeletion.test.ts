import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELETE_CONFIRMATION, planWorkspaceExit } from './accountDeletion'

test('the last member deletes the workspace', () => {
  assert.deepEqual(planWorkspaceExit({ ownerId: 'alice', members: ['alice'] }, 'alice'), { kind: 'delete' })
})

test('an owner with other members leaves and the oldest remaining member becomes the owner', () => {
  // members keeps join order: the creator first, invitees appended.
  assert.deepEqual(
    planWorkspaceExit({ ownerId: 'alice', members: ['alice', 'carol', 'bob'] }, 'alice'),
    { kind: 'leave', members: ['carol', 'bob'], transferTo: 'carol' }
  )
})

test('a member who does not own the workspace only leaves it', () => {
  assert.deepEqual(
    planWorkspaceExit({ ownerId: 'bob', members: ['bob', 'alice', 'carol'] }, 'alice'),
    { kind: 'leave', members: ['bob', 'carol'], transferTo: null }
  )
})

test('a workspace the user does not belong to is left alone', () => {
  assert.deepEqual(planWorkspaceExit({ ownerId: 'bob', members: ['bob'] }, 'alice'), { kind: 'not-member' })
})

test('the confirmation word is ELIMINAR', () => {
  assert.equal(DELETE_CONFIRMATION, 'ELIMINAR')
})
