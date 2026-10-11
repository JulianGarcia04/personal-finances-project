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
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, arrayUnion
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
let workspaceId
let outsiderWorkspaceId

async function signUp(label) {
  const app = initializeApp({
    apiKey: 'emulator-only-fixture-key',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    appId: `1:123456789:web:${label}`
  }, `${label}-${Date.now()}-${Math.random()}`)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
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

test('only the owner can delete the workspace', async () => {
  await assert.rejects(deleteDoc(doc(member.db, 'workspaces', workspaceId)), denied)
  await deleteDoc(doc(owner.db, 'workspaces', workspaceId))
  assert.equal((await adminDb.collection('workspaces').doc(workspaceId).get()).exists, false)
})
