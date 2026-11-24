// Firestore access-control rules proof for users and workspaces.
// Run inside the emulators (demo project only), e.g. with the cached Firebase CLI:
//   emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/access-control.rules.test.mjs"
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth'
import {
  getFirestore, connectFirestoreEmulator, terminate,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, arrayUnion, serverTimestamp,
  deleteField, writeBatch, runTransaction
} from 'firebase/firestore'

const projectId = 'demo-vault-access'
const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

function assertLoopback(value, port, name) {
  assert.ok(value, `${name} emulator host must be configured`)
  const [host, rawPort] = value.split(':')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host), `${name} emulator must use loopback`)
  assert.equal(Number(rawPort), port, `${name} emulator port must match the local fixture`)
}

assert.equal(process.env.GCLOUD_PROJECT, projectId, 'tests must run against the demo project only')
assertLoopback(process.env.FIRESTORE_EMULATOR_HOST, 8080, 'Firestore')
assertLoopback(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9099, 'Auth')
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'ambient Google credentials are not allowed')
const rulesPath = resolve(repositoryRoot, 'tests/firestore.rules')
assert.equal(realpathSync(rulesPath), resolve(repositoryRoot, 'firestore.rules'), 'test rules must resolve to the repository rules')
assert.match(readFileSync(rulesPath, 'utf8'), /match \/workspaces\/\{workspaceId\}/)

const denied = error => error?.code === 'permission-denied'
const apps = []
let adminApp
let adminDb
let owner
let member
let outsider
let anonymous
let workspaceId
let outsiderWorkspaceId

function clientApp(label) {
  const app = initializeApp({
    apiKey: 'emulator-only-fixture-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    appId: `1:123456789:web:${label}`
  }, `${label}-${Date.now()}-${Math.random()}`)
  apps.push(app)
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  return { app, db }
}

async function signUp(label) {
  const { app, db } = clientApp(label)
  const auth = getAuth(app)
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  const credential = await createUserWithEmailAndPassword(auth, `${label}-${Date.now()}@example.test`, 'emulator-password-123')
  return { uid: credential.user.uid, db }
}

before(async () => {
  const admin = requireFunctions('firebase-admin')
  adminApp = admin.initializeApp({ projectId }, `access-${Date.now()}`)
  adminDb = adminApp.firestore()
  owner = await signUp('owner')
  member = await signUp('member')
  outsider = await signUp('outsider')
  anonymous = clientApp('anonymous')
  workspaceId = `ws-${owner.uid}`
  outsiderWorkspaceId = `ws-${outsider.uid}`
  await adminDb.collection('workspaces').doc(workspaceId).set({
    id: workspaceId, name: 'Shared', ownerId: owner.uid, members: [owner.uid, member.uid], currency: 'USD'
  })
  await adminDb.collection('workspaces').doc(outsiderWorkspaceId).set({
    id: outsiderWorkspaceId, name: 'Outsider', ownerId: outsider.uid, members: [outsider.uid], currency: 'USD'
  })
  for (const [user, active, list] of [
    [owner, workspaceId, [workspaceId]],
    [member, workspaceId, [workspaceId]],
    [outsider, outsiderWorkspaceId, [outsiderWorkspaceId]]
  ]) {
    await adminDb.collection('users').doc(user.uid).set({
      uid: user.uid, email: `${user.uid}@example.test`, displayName: user.uid,
      activeWorkspaceId: active, workspaces: list
    })
  }
})

after(async () => {
  for (const app of apps) {
    await terminate(getFirestore(app))
    await deleteApp(app)
  }
  await adminApp?.delete()
})

test('a user can read their own user doc', async () => {
  const snap = await getDoc(doc(owner.db, 'users', owner.uid))
  assert.equal(snap.data().uid, owner.uid)
})

test('a user cannot read the user doc of someone outside their workspace', async () => {
  await assert.rejects(getDoc(doc(outsider.db, 'users', owner.uid)), denied)
  await assert.rejects(getDoc(doc(owner.db, 'users', outsider.uid)), denied)
})

test('a user cannot list the users collection', async () => {
  await assert.rejects(getDocs(collection(outsider.db, 'users')), denied)
})

test('pointing activeWorkspaceId at a foreign workspace does not grant profile reads', async () => {
  await updateDoc(doc(outsider.db, 'users', outsider.uid), { activeWorkspaceId: workspaceId })
  try {
    await assert.rejects(getDoc(doc(outsider.db, 'users', owner.uid)), denied)
  } finally {
    await updateDoc(doc(outsider.db, 'users', outsider.uid), { activeWorkspaceId: outsiderWorkspaceId })
  }
})

test('members of the active workspace can read each other profiles', async () => {
  const snap = await getDoc(doc(member.db, 'users', owner.uid))
  assert.equal(snap.data().uid, owner.uid)
})

test('a member cannot rewrite members or ownerId', async () => {
  const ref = doc(member.db, 'workspaces', workspaceId)
  await assert.rejects(updateDoc(ref, { ownerId: member.uid }), denied)
  await assert.rejects(updateDoc(ref, { members: [member.uid] }), denied)
  await assert.rejects(updateDoc(ref, { members: arrayUnion(outsider.uid) }), denied)
  const stored = (await adminDb.collection('workspaces').doc(workspaceId).get()).data()
  assert.equal(stored.ownerId, owner.uid)
  assert.deepEqual(stored.members, [owner.uid, member.uid])
})

test('the owner cannot rewrite members from the client either', async () => {
  await assert.rejects(updateDoc(doc(owner.db, 'workspaces', workspaceId), { members: arrayUnion(outsider.uid) }), denied)
})

test('a member can still update budget and limit settings', async () => {
  const ref = doc(member.db, 'workspaces', workspaceId)
  await updateDoc(ref, { expenseLimit: 500 })
  await updateDoc(ref, {
    budgetIncome: 1000,
    budgetNeedsPercent: 50,
    budgetWantsPercent: 30,
    budgetSavingsPercent: 20,
    budgetAllocations: {},
    categoryBudgets: { food: 100 },
    exchangeRates: { USD: 1 }
  })
  const stored = (await adminDb.collection('workspaces').doc(workspaceId).get()).data()
  assert.equal(stored.expenseLimit, 500)
  assert.deepEqual(stored.categoryBudgets, { food: 100 })
})

test('a member can toggle budget alerts and confirm legacy cap units in the same workspace update', async () => {
  const ref = doc(member.db, 'workspaces', workspaceId)
  await updateDoc(ref, { budgetAlertsEnabled: false })
  await updateDoc(ref, { budgetAlertsEnabled: true, categoryBudgetCurrency: 'COP' })
  // The categoryBudgetCurrency guard still applies alongside the alert toggle.
  await assert.rejects(updateDoc(ref, { budgetAlertsEnabled: false, categoryBudgetCurrency: 'USD' }), denied)
  const stored = (await adminDb.collection('workspaces').doc(workspaceId).get()).data()
  assert.equal(stored.budgetAlertsEnabled, true)
  assert.equal(stored.categoryBudgetCurrency, 'COP')
})

test('S10: a member can update exchangeRatesBaseCurrency with a valid ISO-3 code or null, rejecting malformed values', async () => {
  const ref = doc(member.db, 'workspaces', workspaceId)
  await updateDoc(ref, { exchangeRates: { USD: 4000 }, exchangeRatesBaseCurrency: 'COP' })
  await updateDoc(ref, { exchangeRates: {}, exchangeRatesBaseCurrency: null })
  await assert.rejects(updateDoc(ref, { exchangeRatesBaseCurrency: 'cop' }), denied)
  await assert.rejects(updateDoc(ref, { exchangeRatesBaseCurrency: 'INVALID' }), denied)
  await assert.rejects(updateDoc(ref, { exchangeRatesBaseCurrency: 123 }), denied)
})

// S6 card basis: each test resets the shared workspace so it does not depend on test order.
const seedWorkspace = fields => adminDb.collection('workspaces').doc(workspaceId).set({
  id: workspaceId, name: 'Shared', ownerId: owner.uid, members: [owner.uid, member.uid], currency: 'USD', expenseLimit: 100, ...fields
})
const storedWorkspace = async () => (await adminDb.collection('workspaces').doc(workspaceId).get()).data()
const workspaceRef = user => doc(user.db, 'workspaces', workspaceId)

test('S6: the owner can set the card basis the first time, flip it, set it via merge, repeat it, and replace an invalid stored value', async () => {
  await seedWorkspace({})
  await updateDoc(workspaceRef(owner), { budgetCardBasis: 'payment' })
  assert.equal((await storedWorkspace()).budgetCardBasis, 'payment')
  await updateDoc(workspaceRef(owner), { budgetCardBasis: 'payment' })
  await setDoc(workspaceRef(owner), { budgetCardBasis: 'consumption' }, { merge: true })
  assert.equal((await storedWorkspace()).budgetCardBasis, 'consumption')
  await seedWorkspace({ budgetCardBasis: 'garbage' })
  await updateDoc(workspaceRef(owner), { budgetCardBasis: 'payment' })
  assert.equal((await storedWorkspace()).budgetCardBasis, 'payment')
})

test('S6: a member cannot set, change or delete the card basis', async () => {
  await seedWorkspace({})
  await assert.rejects(updateDoc(workspaceRef(member), { budgetCardBasis: 'payment' }), denied)
  assert.equal((await storedWorkspace()).budgetCardBasis, undefined)
  await seedWorkspace({ budgetCardBasis: 'payment' })
  await assert.rejects(updateDoc(workspaceRef(member), { budgetCardBasis: 'consumption' }), denied)
  await assert.rejects(updateDoc(workspaceRef(member), { budgetCardBasis: deleteField() }), denied)
  assert.equal((await storedWorkspace()).budgetCardBasis, 'payment')
})

test('S6: a member cannot smuggle the card basis with an allowed settings key, a merge, a batch or a transaction', async () => {
  await seedWorkspace({ budgetCardBasis: 'consumption' })
  await assert.rejects(updateDoc(workspaceRef(member), { expenseLimit: 7, budgetCardBasis: 'payment' }), denied)
  await assert.rejects(updateDoc(workspaceRef(member), { budgetAlertsEnabled: false, budgetCardBasis: 'payment' }), denied)
  await assert.rejects(setDoc(workspaceRef(member), { budgetCardBasis: 'payment' }, { merge: true }), denied)
  const batch = writeBatch(member.db)
  batch.update(workspaceRef(member), { expenseLimit: 8 })
  batch.update(workspaceRef(member), { budgetCardBasis: 'payment' })
  await assert.rejects(batch.commit(), denied)
  await assert.rejects(runTransaction(member.db, async transaction => {
    await transaction.get(workspaceRef(member))
    transaction.update(workspaceRef(member), { budgetCardBasis: 'payment' })
  }), denied)
  const stored = await storedWorkspace()
  assert.equal(stored.budgetCardBasis, 'consumption')
  assert.equal(stored.expenseLimit, 100)
})

test('S6: the owner cannot store an invalid, null, non-string, nested or deleted card basis', async () => {
  await seedWorkspace({ budgetCardBasis: 'consumption' })
  for (const value of ['monthly', 'Payment', 'PAYMENT', '', ' payment', null, 1, 0, true, ['payment'], { v: 'payment' }, arrayUnion('payment')]) {
    await assert.rejects(updateDoc(workspaceRef(owner), { budgetCardBasis: value }), denied, `value ${JSON.stringify(value)}`)
  }
  await assert.rejects(updateDoc(workspaceRef(owner), { 'budgetCardBasis.kind': 'payment' }), denied)
  await assert.rejects(updateDoc(workspaceRef(owner), { budgetCardBasis: deleteField() }), denied)
  assert.equal((await storedWorkspace()).budgetCardBasis, 'consumption')
})

test('S6: the owner cannot combine the card basis with ownerId, members, another settings key or an unknown key', async () => {
  await seedWorkspace({ budgetCardBasis: 'consumption' })
  for (const extra of [
    { ownerId: member.uid }, { members: arrayUnion(outsider.uid) }, { members: [owner.uid] },
    { expenseLimit: 9 }, { budgetAlertsEnabled: false }, { name: 'Renamed' }, { currency: 'EUR' }, { somethingNew: true }
  ]) {
    await assert.rejects(updateDoc(workspaceRef(owner), { budgetCardBasis: 'payment', ...extra }), denied, `extra ${Object.keys(extra)}`)
  }
  const stored = await storedWorkspace()
  assert.equal(stored.budgetCardBasis, 'consumption')
  assert.equal(stored.ownerId, owner.uid)
  assert.deepEqual(stored.members, [owner.uid, member.uid])
  assert.equal(stored.expenseLimit, 100)
  assert.equal(stored.name, 'Shared')
})

test('S6: outsiders and unauthenticated clients cannot read or set the card basis', async () => {
  await seedWorkspace({ budgetCardBasis: 'consumption' })
  await assert.rejects(updateDoc(workspaceRef(outsider), { budgetCardBasis: 'payment' }), denied)
  await assert.rejects(updateDoc(workspaceRef(anonymous), { budgetCardBasis: 'payment' }), denied)
  await assert.rejects(getDoc(workspaceRef(anonymous)), denied)
  assert.equal((await storedWorkspace()).budgetCardBasis, 'consumption')
})

test('S6: every member settings key still updates while a valid or invalid card basis is stored, including a same-value basis echo', async () => {
  const updates = {
    expenseLimit: 5, budgetIncome: 1000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
    budgetAllocations: { a: 1 }, categoryBudgets: { food: 1 }, exchangeRates: { USD: 1 },
    exchangeRatesBaseCurrency: 'COP', categoryBudgetCurrency: 'COP', budgetAlertsEnabled: false
  }
  for (const basis of ['payment', 'garbage']) {
    await seedWorkspace({ budgetCardBasis: basis })
    for (const [key, value] of Object.entries(updates)) await updateDoc(workspaceRef(member), { [key]: value })
    await updateDoc(workspaceRef(member), { expenseLimit: 6, budgetCardBasis: basis })
    await updateDoc(workspaceRef(owner), { expenseLimit: 7 })
    const stored = await storedWorkspace()
    assert.equal(stored.budgetCardBasis, basis)
    assert.equal(stored.expenseLimit, 7)
    assert.equal(stored.budgetAlertsEnabled, false)
  }
})

test('an outsider cannot read or update the workspace', async () => {
  const ref = doc(outsider.db, 'workspaces', workspaceId)
  await assert.rejects(getDoc(ref), denied)
  await assert.rejects(updateDoc(ref, { expenseLimit: 1 }), denied)
})

test('workspace creation must be owned by and only contain the creator', async () => {
  await assert.rejects(setDoc(doc(outsider.db, 'workspaces', `bad-owner-${outsider.uid}`), {
    name: 'Bad', ownerId: owner.uid, members: [outsider.uid], currency: 'USD', createdAt: new Date().toISOString()
  }), denied)
  await assert.rejects(setDoc(doc(outsider.db, 'workspaces', `bad-members-${outsider.uid}`), {
    name: 'Bad', ownerId: outsider.uid, members: [outsider.uid, owner.uid], currency: 'USD', createdAt: new Date().toISOString()
  }), denied)
  const goodId = `good-${outsider.uid}`
  await setDoc(doc(outsider.db, 'workspaces', goodId), {
    id: goodId, name: 'Personal', ownerId: outsider.uid, members: [outsider.uid], currency: 'USD', createdAt: new Date().toISOString()
  })
})

test('statement import markers are server-only', async () => {
  const markerId = `${workspaceId}_client-probe-1234`
  await adminDb.collection('statementImports').doc(markerId).set({ workspaceId, requestHash: 'x' })
  await assert.rejects(getDoc(doc(owner.db, 'statementImports', markerId)), denied)
  await assert.rejects(getDocs(collection(member.db, 'statementImports')), denied)
  await assert.rejects(setDoc(doc(member.db, 'statementImports', `${workspaceId}_forged-12345`), { workspaceId }), denied)
  await assert.rejects(deleteDoc(doc(owner.db, 'statementImports', markerId)), denied)
})

test('default-key usage quotas are server-only', async () => {
  const quotaId = `${owner.uid}_2026-10-11`
  await adminDb.collection('usageQuotas').doc(quotaId).set({ uid: owner.uid, chat: 50 })
  await assert.rejects(getDoc(doc(owner.db, 'usageQuotas', quotaId)), denied)
  await assert.rejects(getDocs(collection(owner.db, 'usageQuotas')), denied)
  await assert.rejects(setDoc(doc(owner.db, 'usageQuotas', quotaId), { uid: owner.uid, chat: 0 }), denied)
  await assert.rejects(deleteDoc(doc(owner.db, 'usageQuotas', quotaId)), denied)
})

test('transaction embeddings are server-only, even for workspace members', async () => {
  const embeddingId = `tx-${Date.now()}`
  await adminDb.collection('transactionEmbeddings').doc(embeddingId).set({ workspaceId, embedding: [0.1, 0.2], textHash: 'h' })
  await assert.rejects(getDoc(doc(owner.db, 'transactionEmbeddings', embeddingId)), denied)
  await assert.rejects(getDocs(collection(owner.db, 'transactionEmbeddings')), denied)
  await assert.rejects(setDoc(doc(member.db, 'transactionEmbeddings', embeddingId), { workspaceId, embedding: [0] }), denied)
  await assert.rejects(deleteDoc(doc(owner.db, 'transactionEmbeddings', embeddingId)), denied)
})

test('a user can register, read and delete their own push token', async () => {
  const token = `fcm-owner-${Date.now()}`
  const ref = doc(owner.db, 'users', owner.uid, 'pushTokens', token)
  await setDoc(ref, { token, userAgent: 'test-agent', createdAt: serverTimestamp() })
  assert.equal((await getDoc(ref)).data().token, token)
  assert.equal((await getDocs(collection(owner.db, 'users', owner.uid, 'pushTokens'))).size >= 1, true)
  // Re-registering the same device token keeps working.
  await setDoc(ref, { token, userAgent: 'test-agent-2', createdAt: serverTimestamp() })
  await deleteDoc(ref)
  assert.equal((await adminDb.collection('users').doc(owner.uid).collection('pushTokens').doc(token).get()).exists, false)
})

test('push tokens are private to their owner, even within a shared workspace', async () => {
  const token = `fcm-private-${Date.now()}`
  await adminDb.collection('users').doc(owner.uid).collection('pushTokens').doc(token)
    .set({ token, userAgent: 'admin', createdAt: new Date() })
  for (const other of [member, outsider]) {
    const ref = doc(other.db, 'users', owner.uid, 'pushTokens', token)
    await assert.rejects(getDoc(ref), denied)
    await assert.rejects(getDocs(collection(other.db, 'users', owner.uid, 'pushTokens')), denied)
    await assert.rejects(deleteDoc(ref), denied)
    await assert.rejects(setDoc(doc(other.db, 'users', owner.uid, 'pushTokens', `forged-${other.uid}`), {
      token: `forged-${other.uid}`, userAgent: 'x', createdAt: serverTimestamp()
    }), denied)
  }
  assert.equal((await adminDb.collection('users').doc(owner.uid).collection('pushTokens').doc(token).get()).exists, true)
})

test('push token documents must match the expected shape', async () => {
  const col = (id) => doc(owner.db, 'users', owner.uid, 'pushTokens', id)
  const id = `fcm-shape-${Date.now()}`
  await assert.rejects(setDoc(col(id), { token: 'different-token', userAgent: 'x', createdAt: serverTimestamp() }), denied)
  await assert.rejects(setDoc(col(id), { token: id, userAgent: 'x', createdAt: serverTimestamp(), extra: true }), denied)
  await assert.rejects(setDoc(col(id), { token: id, userAgent: 'x', createdAt: new Date(0) }), denied)
  await assert.rejects(setDoc(col(id), { token: id, userAgent: 'x'.repeat(1025), createdAt: serverTimestamp() }), denied)
  await assert.rejects(setDoc(col(id), { token: id, userAgent: 42, createdAt: serverTimestamp() }), denied)
})

test('only the owner can delete the workspace', async () => {
  await assert.rejects(deleteDoc(doc(member.db, 'workspaces', workspaceId)), denied)
  await deleteDoc(doc(owner.db, 'workspaces', workspaceId))
  assert.equal((await adminDb.collection('workspaces').doc(workspaceId).get()).exists, false)
})
