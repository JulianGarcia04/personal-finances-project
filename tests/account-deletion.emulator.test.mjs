// Account deletion core against the Firestore and Auth emulators, with a fake Storage deleter.
// Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/account-deletion.emulator.test.mjs"
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')
assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Auth emulator must use loopback')

const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app')
const { getFirestore } = requireFunctions('firebase-admin/firestore')
const { getAuth } = requireFunctions('firebase-admin/auth')
const { ACCOUNT_DELETIONS_COLLECTION, deleteUserAccount } = requireFunctions('./lib/accountDeletion.js')

let app
let db
let auth

before(() => {
  app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, `account-deletion-${Date.now()}`)
  db = getFirestore(app)
  auth = getAuth(app)
})

after(async () => {
  await deleteApp(app)
})

function deps(storagePrefixes) {
  return {
    db,
    deleteStoragePrefix: async prefix => { storagePrefixes.push(prefix) },
    deleteAuthUser: uid => auth.deleteUser(uid)
  }
}

const exists = async path => (await db.doc(path).get()).exists
const data = async path => (await db.doc(path).get()).data()

/** Every document of a workspace in the collections deletion must purge, plus a budget cap. */
async function seedWorkspaceData(workspaceId, userId) {
  const docs = {
    [`accounts/${workspaceId}-bank`]: { workspaceId, userId, name: 'Banco', type: 'savings', balance: 100, currency: 'COP' },
    [`transactions/${workspaceId}-tx`]: { workspaceId, userId, accountId: `${workspaceId}-bank`, amount: -10, type: 'expense', currency: 'COP' },
    [`categories/${workspaceId}-food`]: { workspaceId, name: 'Comida' },
    [`goals/${workspaceId}-goal`]: { workspaceId, userId, name: 'Viaje' },
    [`budgets/${workspaceId}-budget`]: { workspaceId, name: 'Mensual' },
    [`budgets/${workspaceId}-budget/categoryCaps/${workspaceId}-food`]: { amount: 50 },
    [`chats/${workspaceId}-chat`]: { workspaceId, userId, messages: [] },
    [`transactionEmbeddings/${workspaceId}-tx`]: { workspaceId },
    [`budgetAlerts/${workspaceId}_2026-11`]: { workspaceId },
    [`statementImports/${workspaceId}_import`]: { workspaceId, userId }
  }
  await Promise.all(Object.entries(docs).map(([path, value]) => db.doc(path).set(value)))
  return Object.keys(docs)
}

async function seedUser(uid, workspaces) {
  await auth.createUser({ uid, email: `${uid}@example.test` })
  await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, activeWorkspaceId: workspaces[0], workspaces })
}

test('deletes the account: sole workspaces go, shared ones stay with the oldest member, links are detached', async () => {
  const key = `del-${Date.now()}`
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(name => `${key}-${name}`)
  const personal = `${key}-personal` // alice alone
  const owned = `${key}-owned` // alice owns it; carol joined before bob
  const joined = `${key}-joined` // bob owns it; alice joined
  const unrelated = `${key}-unrelated` // bob alone

  await seedUser(alice, [personal, owned, joined])
  await seedUser(bob, [joined, owned, unrelated])
  await seedUser(carol, [owned])
  await db.doc(`workspaces/${personal}`).set({ id: personal, name: 'Personal', ownerId: alice, members: [alice], currency: 'COP' })
  await db.doc(`workspaces/${owned}`).set({ id: owned, name: 'Casa', ownerId: alice, members: [alice, carol, bob], currency: 'COP' })
  await db.doc(`workspaces/${joined}`).set({ id: joined, name: 'Pareja', ownerId: bob, members: [bob, alice], currency: 'COP' })
  await db.doc(`workspaces/${unrelated}`).set({ id: unrelated, name: 'Bob', ownerId: bob, members: [bob], currency: 'COP' })

  const personalDocs = await seedWorkspaceData(personal, alice)
  const ownedDocs = await seedWorkspaceData(owned, alice)
  const unrelatedDocs = await seedWorkspaceData(unrelated, bob)
  await db.doc(`categories/${key}-default`).set({ workspaceId: null, name: 'Default' })

  // A bridge in the shared workspace mirrors an expense into alice's personal workspace.
  await db.doc(`accounts/${owned}-bridge`).set({
    workspaceId: owned, userId: alice, name: 'Puente', type: 'checking', balance: -40, currency: 'COP',
    mirror: { workspaceId: personal, accountId: `${personal}-receivable`, sourceAccountId: `${personal}-card` }
  })
  await db.doc(`transactions/${owned}-bridge-expense`).set({
    workspaceId: owned, userId: alice, accountId: `${owned}-bridge`, amount: -40, type: 'expense', currency: 'COP',
    mirrorOf: `${personal}-mirror-leg`
  })
  await db.doc(`transactions/${personal}-mirror-leg`).set({
    workspaceId: personal, userId: alice, accountId: `${personal}-card`, toAccountId: `${personal}-receivable`,
    amount: 40, type: 'transfer', currency: 'COP', mirrorOf: `${owned}-bridge-expense`
  })

  await db.doc(`users/${alice}/secure/settings`).set({ encryptedApiKey: 'x', iv: 'y' })
  await db.doc(`users/${alice}/pushTokens/token-1`).set({ token: 'token-1' })
  await db.doc(`usageQuotas/${alice}_2026-11-05`).set({ uid: alice, count: 3 })
  await db.doc(`usageQuotas/${bob}_2026-11-05`).set({ uid: bob, count: 1 })

  const storagePrefixes = []
  const result = await deleteUserAccount(deps(storagePrefixes), alice)

  assert.deepEqual(result, { deletedWorkspaces: 1, leftWorkspaces: 2 })

  // The sole workspace and all of its data are gone, budget caps included.
  assert.equal(await exists(`workspaces/${personal}`), false)
  for (const path of personalDocs) assert.equal(await exists(path), false, path)
  assert.equal(await exists(`transactions/${personal}-mirror-leg`), false)
  assert.deepEqual(storagePrefixes.sort(), [`users/${alice}/`, `workspaces/${personal}/`].sort())

  // The owned shared workspace passes to the oldest remaining member and keeps alice's records.
  const ownedAfter = await data(`workspaces/${owned}`)
  assert.equal(ownedAfter.ownerId, carol)
  assert.deepEqual(ownedAfter.members, [carol, bob])
  for (const path of ownedDocs) assert.equal(await exists(path), true, path)

  // In a workspace someone else owns, alice only leaves.
  const joinedAfter = await data(`workspaces/${joined}`)
  assert.equal(joinedAfter.ownerId, bob)
  assert.deepEqual(joinedAfter.members, [bob])

  // The bridge keeps its balance as an ordinary account, and its expense no longer points at the deleted leg.
  const bridge = await data(`accounts/${owned}-bridge`)
  assert.equal(bridge.mirror, null)
  assert.equal(bridge.balance, -40)
  const expense = await data(`transactions/${owned}-bridge-expense`)
  assert.equal(expense.mirrorOf, null)
  assert.equal(expense.amount, -40)

  // Alice's own data and Auth user are gone; nobody else's data changes.
  assert.equal(await exists(`users/${alice}`), false)
  assert.equal(await exists(`users/${alice}/secure/settings`), false)
  assert.equal(await exists(`users/${alice}/pushTokens/token-1`), false)
  assert.equal(await exists(`usageQuotas/${alice}_2026-11-05`), false)
  assert.equal(await exists(`${ACCOUNT_DELETIONS_COLLECTION}/${alice}`), false)
  await assert.rejects(auth.getUser(alice), { code: 'auth/user-not-found' })

  assert.equal((await auth.getUser(bob)).uid, bob)
  assert.deepEqual((await data(`users/${bob}`)).workspaces, [joined, owned, unrelated])
  assert.equal(await exists(`usageQuotas/${bob}_2026-11-05`), true)
  assert.equal(await exists(`workspaces/${unrelated}`), true)
  for (const path of unrelatedDocs) assert.equal(await exists(path), true, path)
  assert.equal(await exists(`categories/${key}-default`), true)
})

test('a retry finishes a deletion that stopped after removing the workspace document', async () => {
  const key = `retry-${Date.now()}`
  const dana = `${key}-dana`
  const personal = `${key}-personal`
  await seedUser(dana, [personal])
  const personalDocs = await seedWorkspaceData(personal, dana)
  // The first attempt recorded the workspace and deleted its document, then failed.
  await db.doc(`${ACCOUNT_DELETIONS_COLLECTION}/${dana}`).set({ uid: dana, workspaceIds: [personal] })

  const storagePrefixes = []
  const result = await deleteUserAccount(deps(storagePrefixes), dana)

  assert.deepEqual(result, { deletedWorkspaces: 1, leftWorkspaces: 0 })
  for (const path of personalDocs) assert.equal(await exists(path), false, path)
  assert.deepEqual(storagePrefixes.sort(), [`users/${dana}/`, `workspaces/${personal}/`].sort())
  assert.equal(await exists(`users/${dana}`), false)
  assert.equal(await exists(`${ACCOUNT_DELETIONS_COLLECTION}/${dana}`), false)
  await assert.rejects(auth.getUser(dana), { code: 'auth/user-not-found' })
})
