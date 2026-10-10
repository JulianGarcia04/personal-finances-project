import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { collection, deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore'
import { createPocketFixture, functionsRequire } from './pockets.fixtures.mjs'

let fixture

before(async () => {
  fixture = await createPocketFixture()
})

after(async () => {
  await fixture?.close()
})

test('client pocket creation conserves the existing stored account total', async () => {
  const { accountsStore, workspaceId } = fixture
  const parent = await accountsStore.addAccount({
    name: 'Main bank',
    type: 'checking',
    balance: 1_000,
    currency: 'COP'
  })

  const pocket = await accountsStore.addAccount({
    name: 'Travel',
    type: 'savings',
    balance: 300,
    currency: 'COP',
    parentAccountId: parent.id
  })

  assert.equal(pocket.parentAccountId, parent.id)
  assert.equal(accountsStore.getAccountById(parent.id)?.balance, 700)
  assert.equal(accountsStore.netWorthByCurrency.COP, 1_000)
  assert.equal(pocket.workspaceId, workspaceId)
})

test('rules reject an unregistered or nonexistent parent relationship', async () => {
  const { accountsStore, db, identity, workspaceId, adminDb } = fixture

  await assert.rejects(
    setDoc(doc(db, 'accounts', 'forged-pocket'), {
      workspaceId,
      userId: identity.user.uid,
      name: 'Forged pocket',
      type: 'savings',
      balance: 10,
      limit: 0,
      currency: 'COP',
      parentAccountId: 'missing-parent',
      childAccountIds: [],
      pocketActivity: false,
      openingAllocationId: null,
      createdAt: new Date()
    }),
    (error) => error?.code === 'permission-denied'
  )

  const validParent = await accountsStore.addAccount({ name: 'Forged target', type: 'checking', balance: 10, currency: 'COP' })
  const forgedValidParentRef = doc(db, 'accounts', 'forged-valid-parent-child')
  await assert.rejects(setDoc(forgedValidParentRef, {
    workspaceId,
    userId: identity.user.uid,
    name: 'Unregistered child',
    type: 'savings',
    balance: 0,
    limit: 0,
    currency: 'COP',
    parentAccountId: validParent.id,
    childAccountIds: [],
    pocketActivity: false,
    openingAllocationId: null,
    createdAt: new Date()
  }), error => error?.code === 'permission-denied')
  assert.equal((await adminDb.collection('accounts').doc(forgedValidParentRef.id).get()).exists, false)
})

test('zero-balance pocket creation is atomic and can be detached while unused', async () => {
  const { accountsStore, adminDb } = fixture
  const totalBefore = accountsStore.netWorthByCurrency.COP || 0
  const parent = await accountsStore.addAccount({ name: 'Zero parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Empty pocket', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parent.id
  })

  assert.equal(pocket.balance, 0)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 500)
  assert.equal((await adminDb.collection('transactions').where('accountId', '==', parent.id).get()).size, 0)
  await accountsStore.deleteAccount(pocket.id)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).exists, false)
  assert.deepEqual((await adminDb.collection('accounts').doc(parent.id).get()).data().childAccountIds, [])
})

test('invalid funding rejects before child, transaction, or parent writes', async () => {
  const { accountsStore, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Limited parent', type: 'checking', balance: 50, currency: 'COP' })
  for (const amount of [51, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(accountsStore.addAccount({
      name: 'Rejected pocket', type: 'savings', balance: amount, currency: 'COP', parentAccountId: parent.id
    }))
  }
  assert.equal((await adminDb.collection('accounts').where('parentAccountId', '==', parent.id).get()).size, 0)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 50)
  assert.equal((await adminDb.collection('transactions').where('accountId', '==', parent.id).get()).size, 0)
})

test('invalid parents, currency conflicts, and nested pockets are rejected', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const credit = await accountsStore.addAccount({ name: 'Credit', type: 'credit', balance: 0, limit: 100, currency: 'COP' })
  const cash = await accountsStore.addAccount({ name: 'Cash', type: 'cash', balance: 100, currency: 'COP' })
  const bank = await accountsStore.addAccount({ name: 'Eligible', type: 'checking', balance: 100, currency: 'COP' })
  const mirror = await accountsStore.addAccount({ name: 'Mirror', type: 'checking', balance: 100, currency: 'COP' })
  await accountsStore.setAccountMirror(mirror.id, {
    workspaceId: 'another-workspace', accountId: 'receivable', sourceAccountId: 'source'
  })
  const pocket = await accountsStore.addAccount({ name: 'Child', type: 'savings', balance: 0, currency: 'COP', parentAccountId: bank.id })

  for (const parentId of [credit.id, cash.id, mirror.id, pocket.id]) {
    await assert.rejects(accountsStore.addAccount({
      name: 'Invalid child', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parentId
    }))
  }
  await assert.rejects(accountsStore.addAccount({
    name: 'Wrong currency', type: 'savings', balance: 0, currency: 'USD', parentAccountId: bank.id
  }))
  await assert.rejects(accountsStore.addAccount({
    name: 'Conflicting credit metadata', type: 'savings', balance: 0, currency: 'COP',
    statementClosingDay: 0, parentAccountId: bank.id
  }))

  const foreignWorkspaceId = `foreign-${identity.user.uid}`
  await adminDb.collection('workspaces').doc(foreignWorkspaceId).set({
    id: foreignWorkspaceId,
    name: 'Foreign workspace',
    ownerId: identity.user.uid,
    members: [identity.user.uid],
    currency: 'COP'
  })
  const foreignParentId = `foreign-parent-${identity.user.uid}`
  await adminDb.collection('accounts').doc(foreignParentId).set({
    workspaceId: foreignWorkspaceId,
    userId: identity.user.uid,
    name: 'Foreign parent',
    type: 'checking',
    balance: 100,
    limit: 0,
    currency: 'COP'
  })
  assert.notEqual(foreignWorkspaceId, workspaceId)
  await assert.rejects(accountsStore.addAccount({
    name: 'Foreign child', type: 'savings', balance: 1, currency: 'COP', parentAccountId: foreignParentId
  }))
  assert.equal((await adminDb.collection('accounts').where('parentAccountId', '==', foreignParentId).get()).size, 0)
})

test('rules protect hierarchy metadata and reject unsupported sequential pocket transactions', async () => {
  const { accountsStore, db, adminDb, workspaceId, identity } = fixture
  const parent = await accountsStore.addAccount({ name: 'Protected parent', type: 'checking', balance: 800, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Funded pocket', type: 'savings', balance: 200, currency: 'COP', parentAccountId: parent.id
  })
  const forgedId = `forged-${Date.now()}`

  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), { childAccountIds: [forgedId] }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), { currency: 'USD' }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), { type: 'credit' }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), { workspaceId: 'foreign-workspace' }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), {
    mirror: { workspaceId: 'foreign-workspace', accountId: 'receivable', sourceAccountId: 'source' }
  }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', parent.id), { balance: 590 }), error => error?.code === 'permission-denied')
  await assert.rejects(deleteDoc(doc(db, 'accounts', parent.id)), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', pocket.id), { parentAccountId: forgedId }), error => error?.code === 'permission-denied')
  await assert.rejects(updateDoc(doc(db, 'accounts', pocket.id), { currency: 'USD' }), error => error?.code === 'permission-denied')
  await assert.rejects(deleteDoc(doc(db, 'accounts', pocket.id)), error => error?.code === 'permission-denied')
  await assert.rejects(accountsStore.deleteAccount(pocket.id))

  const txRef = doc(collection(db, 'transactions'))
  await assert.rejects(setDoc(txRef, {
    workspaceId,
    userId: identity.user.uid,
    accountId: parent.id,
    amount: 10,
    description: 'Unsupported legacy mutation',
    categoryId: '',
    date: new Date(),
    type: 'expense',
    toAccountId: null,
    currency: 'COP',
    createdAt: new Date()
  }), error => error?.code === 'permission-denied')
  assert.equal((await adminDb.collection('transactions').doc(txRef.id).get()).exists, false)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 600)

  const ordinary = await accountsStore.addAccount({ name: 'Transaction target', type: 'checking', balance: 10, currency: 'COP' })
  const existingTx = doc(collection(db, 'transactions'))
  await setDoc(existingTx, {
    workspaceId,
    userId: identity.user.uid,
    accountId: ordinary.id,
    amount: 1,
    description: 'Legacy transaction',
    categoryId: '',
    date: new Date(),
    type: 'expense',
    toAccountId: null,
    currency: 'COP',
    createdAt: new Date()
  })
  await assert.rejects(updateDoc(existingTx, { accountId: pocket.id }), error => error?.code === 'permission-denied')
  assert.equal((await adminDb.collection('transactions').doc(existingTx.id).get()).data().accountId, ordinary.id)
})

test('store captures the initiating workspace and suppresses stale local publication', async () => {
  const { accountsStore, authStore, adminDb, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Captured parent', type: 'checking', balance: 100, currency: 'COP' })
  const promise = accountsStore.addAccount({
    name: 'Captured pocket', type: 'savings', balance: 10, currency: 'COP', parentAccountId: parent.id
  })
  authStore.activeWorkspaceId = 'switched-workspace'
  const pocket = await promise
  assert.equal(pocket.workspaceId, workspaceId)
  assert.equal(accountsStore.getAccountById(pocket.id), undefined)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().workspaceId, workspaceId)
  authStore.activeWorkspaceId = workspaceId
})

test('concurrent openings cannot overdraw the parent or change combined wealth', async () => {
  const { accountsStore, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Concurrent parent', type: 'checking', balance: 100, currency: 'COP' })
  const attempts = await Promise.allSettled([1, 2].map(index => accountsStore.addAccount({
    name: `Concurrent ${index}`, type: 'savings', balance: 80, currency: 'COP', parentAccountId: parent.id
  })))
  assert.ok(attempts.some(result => result.status === 'fulfilled'))
  const [parentSnap, children, transactions] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').where('parentAccountId', '==', parent.id).get(),
    adminDb.collection('transactions').where('accountId', '==', parent.id).get()
  ])
  const parentBalance = parentSnap.data().balance
  const pocketBalance = children.docs.reduce((sum, child) => sum + child.data().balance, 0)
  assert.ok(parentBalance >= 0)
  assert.equal(parentBalance + pocketBalance, 100)
  assert.equal(transactions.size, children.size)
})

test('extracted Admin account path enforces membership and funds pockets atomically', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Admin parent', type: 'checking', balance: 1_000, currency: 'COP' })
  const { createWorkspaceAccount } = functionsRequire('./lib/pockets.js')
  const pocket = await createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Admin pocket',
    type: 'savings',
    balance: 250,
    currency: 'COP',
    parentAccountId: parent.id
  })
  const [parentSnap, pocketSnap, allocations] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').doc(String(pocket.id)).get(),
    adminDb.collection('transactions').where('accountId', '==', parent.id).get()
  ])
  assert.equal(parentSnap.data().balance, 750)
  assert.equal(pocketSnap.data().balance, 250)
  assert.equal(allocations.size, 1)
  assert.equal(allocations.docs[0].data().type, 'transfer')
  assert.equal(allocations.docs[0].data().pocketAllocation, true)

  const emptyPocket = await createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Admin empty pocket',
    type: 'savings',
    balance: 0,
    currency: 'COP',
    parentAccountId: parent.id
  })
  assert.equal((await adminDb.collection('transactions').where('accountId', '==', parent.id).get()).size, 1)
  assert.equal((await adminDb.collection('accounts').doc(String(emptyPocket.id)).get()).data().openingAllocationId, null)

  const orphanId = `admin-orphan-${Date.now()}`
  await adminDb.collection('accounts').doc(orphanId).set({
    workspaceId,
    userId: identity.user.uid,
    name: 'Admin-seeded orphan',
    type: 'savings',
    balance: 0,
    limit: 0,
    currency: 'COP',
    parentAccountId: parent.id,
    childAccountIds: [],
    pocketActivity: false,
    openingAllocationId: null
  })
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Must reject orphan registry mismatch',
    type: 'savings',
    balance: 1,
    currency: 'COP',
    parentAccountId: parent.id
  }))
  await adminDb.collection('accounts').doc(orphanId).delete()

  const { assertLegacyTransactionAccountsAreUnpocketed } = functionsRequire('./lib/pockets.js')
  const parentData = (await adminDb.collection('accounts').doc(parent.id).get()).data()
  await assert.rejects(adminDb.runTransaction(transaction => assertLegacyTransactionAccountsAreUnpocketed(
    adminDb,
    transaction,
    [{ id: parent.id, data: parentData }]
  )))
  const ordinary = await accountsStore.addAccount({ name: 'Ordinary account', type: 'checking', balance: 20, currency: 'COP' })
  const ordinaryData = (await adminDb.collection('accounts').doc(ordinary.id).get()).data()
  await adminDb.runTransaction(transaction => assertLegacyTransactionAccountsAreUnpocketed(
    adminDb,
    transaction,
    [{ id: ordinary.id, data: ordinaryData }]
  ))
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Overdraw',
    type: 'savings',
    balance: 751,
    currency: 'COP',
    parentAccountId: parent.id
  }))
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Wrong currency',
    type: 'savings',
    balance: 1,
    currency: 'USD',
    parentAccountId: parent.id
  }))
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Conflicting metadata',
    type: 'savings',
    balance: 1,
    currency: 'COP',
    limit: 1,
    parentAccountId: parent.id
  }))
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Nested pocket',
    type: 'savings',
    balance: 1,
    currency: 'COP',
    parentAccountId: String(pocket.id)
  }))
  const mirroredParent = await accountsStore.addAccount({ name: 'Admin mirror parent', type: 'checking', balance: 20, currency: 'COP' })
  await accountsStore.setAccountMirror(mirroredParent.id, {
    workspaceId: 'remote-workspace', accountId: 'receivable', sourceAccountId: 'source'
  })
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Mirrored parent child',
    type: 'savings',
    balance: 1,
    currency: 'COP',
    parentAccountId: mirroredParent.id
  }))
  await assert.rejects(createWorkspaceAccount(adminDb, {
    userId: 'not-a-member',
    workspaceId,
    name: 'Outsider',
    type: 'savings',
    balance: 1,
    currency: 'COP',
    parentAccountId: parent.id
  }))
  assert.equal((await adminDb.collection('accounts').where('parentAccountId', '==', parent.id).get()).size, 2)
})
