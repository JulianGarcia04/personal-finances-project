import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASSWORD_RESET_NOTICE,
  authErrorMessage,
  buildPersonalWorkspace,
  buildUserProfile,
  resolveDisplayName
} from './authProfile.ts'

const now = new Date('2026-10-29T15:00:00.000Z')

test('personal workspace keeps the shape email signup always created', () => {
  assert.deepEqual(buildPersonalWorkspace('uid-1', 'ws-1', now), {
    id: 'ws-1',
    name: 'Personal',
    ownerId: 'uid-1',
    members: ['uid-1'],
    currency: 'USD',
    createdAt: '2026-10-29T15:00:00.000Z'
  })
})

test('user profile points at the personal workspace', () => {
  assert.deepEqual(
    buildUserProfile({ uid: 'uid-1', email: 'ana@example.com', displayName: 'Ana', workspaceId: 'ws-1', now }),
    {
      uid: 'uid-1',
      email: 'ana@example.com',
      displayName: 'Ana',
      currency: 'USD',
      createdAt: now,
      activeWorkspaceId: 'ws-1',
      workspaces: ['ws-1']
    }
  )
})

test('display name falls back to the email prefix, then to Usuario', () => {
  assert.equal(resolveDisplayName('Ana Gómez', 'ana@example.com'), 'Ana Gómez')
  assert.equal(resolveDisplayName(null, 'ana@example.com'), 'ana')
  assert.equal(resolveDisplayName('', null), 'Usuario')
})

test('existing auth error messages are unchanged', () => {
  assert.equal(authErrorMessage({ code: 'auth/invalid-credential' }), 'Correo o contraseña incorrectos.')
  assert.equal(authErrorMessage({ code: 'auth/email-already-in-use' }), 'El correo electrónico ya está registrado.')
  assert.equal(authErrorMessage({ code: 'auth/weak-password' }), 'La contraseña debe tener al menos 6 caracteres.')
  assert.equal(authErrorMessage({ code: 'auth/other', message: 'Boom' }), 'Boom')
  assert.equal(authErrorMessage({}), 'Ocurrió un error inesperado.')
})

test('closing or replacing the Google popup is not an error', () => {
  assert.equal(authErrorMessage({ code: 'auth/popup-closed-by-user' }), '')
  assert.equal(authErrorMessage({ code: 'auth/cancelled-popup-request' }), '')
})

test('Google and recovery failures get actionable messages', () => {
  assert.match(authErrorMessage({ code: 'auth/popup-blocked' }), /ventana/)
  assert.match(authErrorMessage({ code: 'auth/account-exists-with-different-credential' }), /contraseña/)
  assert.equal(authErrorMessage({ code: 'auth/invalid-email' }), 'El correo electrónico no es válido.')
  assert.match(authErrorMessage({ code: 'auth/too-many-requests' }), /Demasiados intentos/)
})

test('password reset notice does not reveal whether the email exists', () => {
  assert.equal(PASSWORD_RESET_NOTICE, 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.')
})

test('user profile carries the consent record when given', () => {
  const legalConsent = { termsVersion: 'v', privacyVersion: 'v', method: 'signup-checkbox', acceptedAt: 'ts' }
  const profile = buildUserProfile({ uid: 'uid-1', email: null, displayName: 'Ana', workspaceId: 'ws-1', now, legalConsent })
  assert.deepEqual(profile.legalConsent, legalConsent)
})
