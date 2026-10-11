// HTTP-level tests for the deployed-shape functions (functions/lib/index.js) on the
// auth+firestore+functions emulators. Only paths that never reach Gemini are covered.
// Run through the launcher (it provides a test-only env without real keys):
//   pnpm --filter functions build && node tests/functions.http.emulators.mjs
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))
const projectId = process.env.GCLOUD_PROJECT ?? ''

assert.match(projectId, /^demo-/, 'tests must run against a demo project only')
for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  assert.match(process.env[name] ?? '', /^(127\.0\.0\.1|localhost):\d+$/, `${name} must use loopback`)
}
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'ambient Google credentials are not allowed')

const authBase = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`
const functionsBase = `http://127.0.0.1:5001/${projectId}/us-central1`
const runId = `${Date.now()}`

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore } = requireFunctions('firebase-admin/firestore')

let app
let db
const users = {}

async function signUp(label) {
  const email = `${label}-${runId}@example.test`
  const response = await fetch(`${authBase}/accounts:signUp?key=emulator-only-fixture-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'emulator-only-password', returnSecureToken: true })
  })
  const body = await response.json()
  assert.equal(response.status, 200, `auth emulator sign-up failed: ${JSON.stringify(body)}`)
  return { uid: body.localId, idToken: body.idToken, email }
}

async function call(name, { token, body } = {}) {
  const response = await fetch(`${functionsBase}/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body ?? {})
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: response.status, body: json }
}

const userMessage = [{ role: 'user', content: 'Hola' }]

// Known defect (follow-up outside this suite's scope): the functions emulator proxies
// `firebase-admin` and returns `admin.firestore` as a bound function, which drops its
// static members, so `admin.firestore.FieldValue` is undefined inside emulated handlers
// (production is unaffected). index.ts should import FieldValue/Timestamp/FieldPath from
// "firebase-admin/firestore". Until then these tests run and report as TODO.
const EMULATOR_FIELDVALUE_TODO = 'index.ts uses admin.firestore.FieldValue, undefined under the functions emulator proxy'

before(async () => {
  app = initializeApp({ projectId }, `functions-http-${runId}`)
  db = getFirestore(app)
  users.owner = await signUp('owner')
  users.member = await signUp('member')
  users.outsider = await signUp('outsider')
  users.invitee = await signUp('invitee')

  users.workspaceId = `ws-${runId}`
  users.foreignWorkspaceId = `ws-foreign-${runId}`
  await db.collection('workspaces').doc(users.workspaceId).set({
    name: 'Casa', ownerId: users.owner.uid, members: [users.owner.uid, users.member.uid], currency: 'COP'
  })
  await db.collection('workspaces').doc(users.foreignWorkspaceId).set({
    name: 'Ajeno', ownerId: users.owner.uid, members: [users.owner.uid], currency: 'COP'
  })
  await db.collection('users').doc(users.owner.uid).set({ activeWorkspaceId: users.workspaceId, workspaces: [users.workspaceId, users.foreignWorkspaceId] })
  await db.collection('users').doc(users.member.uid).set({ activeWorkspaceId: users.workspaceId, workspaces: [users.workspaceId] })
  // Forged pointer: the outsider is not a member of the workspace it claims as active.
  await db.collection('users').doc(users.outsider.uid).set({ activeWorkspaceId: users.foreignWorkspaceId, workspaces: [] })
  await db.collection('users').doc(users.invitee.uid).set({ activeWorkspaceId: null, workspaces: [] })

  // Wait until the real handler answers (405 for GET); a 404 means the functions failed to load.
  let lastStatus
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      lastStatus = (await fetch(`${functionsBase}/chatWithAgent`, { method: 'GET' })).status
      if (lastStatus === 405) return
    } catch {
      lastStatus = 'unreachable'
    }
    await new Promise(done => setTimeout(done, 500))
  }
  throw new Error(`chatWithAgent handler is not loaded in the functions emulator (last status: ${lastStatus})`)
})

after(async () => {
  await deleteApp(app)
})

test('chatWithAgent rejects a request without a bearer token with 401', async () => {
  const { status, body } = await call('chatWithAgent', { body: { messages: userMessage } })
  assert.equal(status, 401)
  assert.equal(typeof body.error, 'string')
})

test('chatWithAgent rejects an invalid bearer token with 401', async () => {
  const { status } = await call('chatWithAgent', { token: 'not-a-token', body: { messages: userMessage } })
  assert.equal(status, 401)
})

test('chatWithAgent rejects an empty message history with 400', async () => {
  const { status, body } = await call('chatWithAgent', { token: users.member.idToken, body: { messages: [] } })
  assert.equal(status, 400)
  assert.match(body.error, /messages/)
})

test('chatWithAgent returns 403 when activeWorkspaceId points to a workspace the caller is not in', async () => {
  const { status, body } = await call('chatWithAgent', {
    token: users.outsider.idToken, body: { messages: userMessage, useDefaultKey: true }
  })
  assert.equal(status, 403)
  assert.equal(body.error, 'No tienes acceso al workspace activo.')
  const quota = await db.collection('usageQuotas').where('uid', '==', users.outsider.uid).get()
  assert.equal(quota.size, 0, 'membership is checked before any quota is consumed')
})

test('chatWithAgent with the default key returns 429 once the daily quota is exhausted', async () => {
  const { status, body } = await call('chatWithAgent', {
    token: users.member.idToken, body: { messages: userMessage, useDefaultKey: true }
  })
  assert.equal(status, 429)
  assert.match(body.error, /límite diario de mensajes/)
})

test('inviteToWorkspace returns 403 for a member who is not the owner', async () => {
  const { status } = await call('inviteToWorkspace', {
    token: users.member.idToken, body: { workspaceId: users.workspaceId, email: users.invitee.email }
  })
  assert.equal(status, 403)
  const workspace = await db.collection('workspaces').doc(users.workspaceId).get()
  assert.ok(!workspace.get('members').includes(users.invitee.uid))
})

test('inviteToWorkspace answers an unknown email with the generic 200 message and no writes', async () => {
  const { status, body } = await call('inviteToWorkspace', {
    token: users.owner.idToken, body: { workspaceId: users.workspaceId, email: `nobody-${runId}@example.test` }
  })
  assert.equal(status, 200)
  assert.equal(body.success, true)
  const workspace = await db.collection('workspaces').doc(users.workspaceId).get()
  assert.deepEqual(workspace.get('members'), [users.owner.uid, users.member.uid])
})

test('inviteToWorkspace by the owner adds the invitee to the workspace and the user doc', { todo: EMULATOR_FIELDVALUE_TODO }, async () => {
  const unknown = await call('inviteToWorkspace', {
    token: users.owner.idToken, body: { workspaceId: users.workspaceId, email: `nobody-${runId}@example.test` }
  })
  const { status, body } = await call('inviteToWorkspace', {
    token: users.owner.idToken, body: { workspaceId: users.workspaceId, email: users.invitee.email }
  })
  assert.equal(status, 200)
  assert.equal(body.message, unknown.body.message, 'response does not reveal whether the email exists')
  const workspace = await db.collection('workspaces').doc(users.workspaceId).get()
  assert.ok(workspace.get('members').includes(users.invitee.uid))
  const invitee = await db.collection('users').doc(users.invitee.uid).get()
  assert.deepEqual(invitee.get('workspaces'), [users.workspaceId])
})

test('saveUserApiKey rejects a non-string apiKey with 400', async () => {
  const { status, body } = await call('saveUserApiKey', { token: users.member.idToken, body: { apiKey: 12345678901 } })
  assert.equal(status, 400)
  assert.equal(body.error, 'La API Key debe ser un texto.')
})

test('saveUserApiKey stores an encrypted key with the configured secret', { todo: EMULATOR_FIELDVALUE_TODO }, async () => {
  const plain = 'emulator-only-user-key'
  const { status } = await call('saveUserApiKey', { token: users.member.idToken, body: { apiKey: plain } })
  assert.equal(status, 200)
  const stored = await db.collection('users').doc(users.member.uid).collection('secure').doc('settings').get()
  assert.equal(typeof stored.get('encryptedApiKey'), 'string')
  assert.equal(typeof stored.get('iv'), 'string')
  assert.ok(!stored.get('encryptedApiKey').includes(plain))
})

test('parseStatement rejects oversized text with 413 before resolving a key', async () => {
  const { status, body } = await call('parseStatement', {
    token: users.member.idToken, body: { text: 'x'.repeat(200_001), useDefaultKey: true }
  })
  assert.equal(status, 413)
  assert.match(body.error, /supera el máximo/)
})

test('parseStatement with the default key returns 429 once the daily quota is exhausted', async () => {
  const { status, body } = await call('parseStatement', {
    token: users.member.idToken, body: { text: '2026-10-01 Almuerzo -20000', useDefaultKey: true }
  })
  assert.equal(status, 429)
  assert.match(body.error, /límite diario de extractos/)
})
