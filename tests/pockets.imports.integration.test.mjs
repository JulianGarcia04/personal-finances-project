import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { createPocketFixture, functionsRequire } from './pockets.fixtures.mjs'

let fixture

before(async () => {
  fixture = await createPocketFixture()
})

after(async () => {
  await fixture?.close()
})

function row(amount, description = 'Imported statement movement', categoryId = '') {
  return {
    date: '2026-10-10T12:00:00.000Z',
    description,
    amount,
    categoryId
  }
}

function request(workspaceId, accountId, rows, expectedCurrency = 'COP') {
  return { workspaceId, accountId, expectedCurrency, rows }
}

async function transactionCount(adminDb, workspaceId) {
  return (await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size
}

test('extracted Admin import helper validates membership and commits all related cashflows together', async () => {
  const { accountsStore, adminDb, identity, outsiderAuth, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Admin import parent', type: 'checking', balance: 1_000, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Admin import pocket', type: 'savings', balance: 300, currency: 'COP', parentAccountId: parent.id
  })
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const { importWorkspacePocketStatement } = functionsRequire('./lib/pocketImports.js')

  const result = await importWorkspacePocketStatement(adminDb, {
    ...request(workspaceId, pocket.id, [row(50), row(-20)]),
    userId: identity.user.uid
  })

  assert.equal(result.balance, 330)
  assert.equal(result.transactions.length, 2)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 2)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 330)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 700)
  await assert.rejects(importWorkspacePocketStatement(adminDb, {
    ...request(workspaceId, pocket.id, [row(1)]),
    userId: outsiderAuth.currentUser.uid
  }))
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 2)
})

test('callable rejects invalid later rows, spoofed ownership, foreign categories, and insufficient funds without writes', async () => {
  const { accountsStore, adminDb, functions, identity, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Rollback import parent', type: 'checking', balance: 200, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Rollback import pocket', type: 'savings', balance: 10, currency: 'COP', parentAccountId: parent.id
  })
  const callable = httpsCallable(functions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const beforeBalance = (await adminDb.collection('accounts').doc(pocket.id).get()).data().balance

  await assert.rejects(callable(request(workspaceId, pocket.id, [row(5), { ...row(0), date: 'invalid' }])))
  await assert.rejects(callable({ ...request(workspaceId, pocket.id, [row(5)]), userId: 'spoofed-user' }))
  await assert.rejects(callable({ ...request(workspaceId, pocket.id, [row(5)]), type: 'transfer', toAccountId: parent.id }))
  await assert.rejects(callable(request(workspaceId, 'missing-import-account', [row(5)])))
  await assert.rejects(callable(request('foreign-workspace', pocket.id, [row(5)])))
  await assert.rejects(callable(request(workspaceId, pocket.id, [row(5)], 'USD')))

  await adminDb.collection('categories').doc('foreign-import-category').set({
    workspaceId: 'another-workspace', name: 'Foreign', type: 'expense'
  })
  await assert.rejects(callable(request(workspaceId, pocket.id, [row(5, 'Foreign category', 'foreign-import-category')])))
  await assert.rejects(callable(request(workspaceId, pocket.id, [row(-11)])))

  await adminDb.collection('accounts').doc(parent.id).update({ childAccountIds: [] })
  await assert.rejects(callable(request(workspaceId, parent.id, [row(1)])))
  await adminDb.collection('accounts').doc(parent.id).update({ childAccountIds: [pocket.id] })
  await adminDb.collection('accounts').doc(pocket.id).update({ workspaceId: 'another-workspace' })
  await assert.rejects(callable(request(workspaceId, pocket.id, [row(1)])))
  await adminDb.collection('accounts').doc(pocket.id).update({ workspaceId })

  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, beforeBalance)
})

test('authenticated callable accepts more than five hundred rows and long statement descriptions', async () => {
  const { accountsStore, adminDb, functions, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Large import parent', type: 'checking', balance: 2_000, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Large import pocket', type: 'savings', balance: 1_000, currency: 'COP', parentAccountId: parent.id
  })
  const longDescription = 'Detailed bank statement line '.repeat(8)
  const rows = Array.from({ length: 501 }, (_, index) => row(0.01, index === 0 ? longDescription : `Row ${index}`))
  const callable = httpsCallable(functions, 'importPocketStatement')

  const result = await callable(request(workspaceId, pocket.id, rows))
  const data = result.data
  assert.equal(data.transactions.length, 501)
  assert.ok(data.transactions.every(transaction => typeof transaction.id === 'string'))
  const stored = await adminDb.collection('transactions').where('accountId', '==', pocket.id).get()
  assert.equal(stored.size, 501)
  assert.ok(stored.docs.some(snapshot => snapshot.data().description.length >= 100))
  assert.ok(Math.abs((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance - 1005.01) < 1e-8)
})

test('callable request-size document failure leaves the account and history unchanged', async () => {
  const { accountsStore, adminDb, functions, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Quota import parent', type: 'checking', balance: 50, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Quota import pocket', type: 'savings', balance: 10, currency: 'COP', parentAccountId: parent.id
  })
  const callable = httpsCallable(functions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const beforeBalance = (await adminDb.collection('accounts').doc(pocket.id).get()).data().balance
  const overDocumentLimit = row(1, 'x'.repeat(1_050_000))

  let quotaError
  try {
    await callable(request(workspaceId, pocket.id, [overDocumentLimit]))
  } catch (error) {
    quotaError = error
  }
  assert.ok(quotaError, 'Firestore must reject the over-document-limit statement')
  assert.match(quotaError.message, /size|maximum|exceed|quota|bytes|1048576/i)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, beforeBalance)
})

test('callable denies outsiders and signed-out clients; a workspace switch suppresses stale local publication', async () => {
  const { accountsStore, adminDb, auth, authStore, functions, identity, outsiderFunctions, outsiderAuth, workspaceId, transactionsStore } = fixture
  const parent = await accountsStore.addAccount({ name: 'Auth import parent', type: 'checking', balance: 400, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Auth import pocket', type: 'savings', balance: 200, currency: 'COP', parentAccountId: parent.id
  })
  const data = request(workspaceId, pocket.id, [row(3, 'Captured workspace import')])
  const outsiderCall = httpsCallable(outsiderFunctions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  await assert.rejects(outsiderCall(data))
  const malformedBearer = await fetch('http://127.0.0.1:5001/demo-vault-pockets/us-central1/importPocketStatement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer malformed-token' },
    body: JSON.stringify({ data })
  })
  assert.equal(malformedBearer.ok, false)

  await signOut(auth)
  try {
    await assert.rejects(httpsCallable(functions, 'importPocketStatement')(data))
  } finally {
    await signInWithEmailAndPassword(auth, identity.user.email, 'emulator-password-123')
  }

  const localBalanceBefore = accountsStore.getAccountById(pocket.id).balance
  const localTransactionCount = transactionsStore.transactions.length
  const pending = transactionsStore.addTransactionsBatch(pocket.id, [{
    date: data.rows[0].date,
    description: data.rows[0].description,
    amount: data.rows[0].amount,
    categorySuggestion: 'Unknown'
  }])
  authStore.activeWorkspaceId = 'workspace-switched-during-import'
  let imported
  try {
    imported = await pending
  } finally {
    authStore.activeWorkspaceId = workspaceId
  }
  assert.equal(imported.length, 1)
  assert.equal(accountsStore.getAccountById(pocket.id).balance, localBalanceBefore)
  assert.equal(transactionsStore.transactions.length, localTransactionCount)
  assert.equal((await transactionCount(adminDb, workspaceId)), beforeCount + 1)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, localBalanceBefore + 3)
})

test('concurrent callable imports cannot spend the same available pocket balance twice', async () => {
  const { accountsStore, adminDb, functions, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Concurrent import parent', type: 'checking', balance: 100, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Concurrent import pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id
  })
  const callable = httpsCallable(functions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const results = await Promise.allSettled([
    callable(request(workspaceId, pocket.id, [row(-60)])),
    callable(request(workspaceId, pocket.id, [row(-60)]))
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected'])
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 40)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 1)
})

test('stale ordinary client cache routes a newly pocket-related root through the atomic callable', async () => {
  const { accountsStore, adminDb, identity, transactionsStore, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Stale cache import root', type: 'checking', balance: 500, currency: 'COP' })
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const { createWorkspaceAccount } = functionsRequire('./lib/pockets.js')
  const pocket = await createWorkspaceAccount(adminDb, {
    userId: identity.user.uid,
    workspaceId,
    name: 'Admin-created child',
    type: 'savings',
    balance: 30,
    currency: 'COP',
    parentAccountId: parent.id
  })
  assert.equal(accountsStore.getAccountById(parent.id).childAccountIds, undefined)

  const imported = await transactionsStore.addTransactionsBatch(parent.id, [{
    date: '2026-10-10T12:00:00.000Z', description: 'Root after pockets appeared', amount: 10,
    categorySuggestion: 'Unknown'
  }])
  assert.equal(imported.length, 1)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 2)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 480)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 30)
})

test('a root gaining a pocket during an import keeps both atomic outcomes and the total balance', async () => {
  const { accountsStore, adminDb, transactionsStore, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Concurrent hierarchy import root', type: 'checking', balance: 1_000, currency: 'COP' })
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const importPromise = transactionsStore.addTransactionsBatch(parent.id, [
    { date: '2026-10-10T12:00:00.000Z', description: 'Racing import income', amount: 50, categorySuggestion: 'Income' },
    { date: '2026-10-10T13:00:00.000Z', description: 'Racing import expense', amount: -20, categorySuggestion: 'Expense' }
  ])
  const pocketPromise = accountsStore.addAccount({
    name: 'Pocket opened during import', type: 'savings', balance: 300, currency: 'COP', parentAccountId: parent.id
  })
  const [imported, pocket] = await Promise.all([importPromise, pocketPromise])

  assert.equal(imported.length, 2)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 3)
  const [storedParent, storedPocket] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').doc(pocket.id).get()
  ])
  assert.equal(storedParent.data().balance, 730)
  assert.equal(storedPocket.data().balance, 300)
  assert.equal(storedParent.data().balance + storedPocket.data().balance, 1_030)
})

test('ordinary batch import keeps its established balance and transaction behavior atomically', async () => {
  const { accountsStore, adminDb, transactionsStore, workspaceId } = fixture
  const account = await accountsStore.addAccount({ name: 'Ordinary batch import', type: 'checking', balance: 100, currency: 'COP' })
  await adminDb.collection('categories').doc('ordinary-import-match').set({ workspaceId, name: 'Groceries', type: 'expense' })
  await adminDb.collection('categories').doc('ordinary-import-other').set({ workspaceId, name: 'Otros', type: 'both' })
  transactionsStore.categories = [
    { id: 'ordinary-import-match', workspaceId, name: 'Groceries' },
    { id: 'ordinary-import-other', workspaceId, name: 'Otros' }
  ]
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const imported = await transactionsStore.addTransactionsBatch(account.id, [
    { date: '2026-10-10T12:00:00.000Z', description: 'Ordinary income', amount: 20, categorySuggestion: 'groceries' },
    { date: '2026-10-10T13:00:00.000Z', description: 'Ordinary expense', amount: -25, categorySuggestion: 'expense' }
  ])
  assert.equal(imported.length, 2)
  assert.equal(imported[0].categoryId, 'ordinary-import-match')
  assert.equal(imported[1].categoryId, 'ordinary-import-other')
  assert.equal((await adminDb.collection('accounts').doc(account.id).get()).data().balance, 95)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 2)
})

test('an imported pocket transaction supports later atomic edit and reversal', async () => {
  const { accountsStore, adminDb, transactionsStore } = fixture
  const parent = await accountsStore.addAccount({ name: 'Imported edit parent', type: 'checking', balance: 200, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Imported edit pocket', type: 'savings', balance: 80, currency: 'COP', parentAccountId: parent.id
  })
  const [created] = await transactionsStore.addTransactionsBatch(pocket.id, [{
    date: '2026-10-10T12:00:00.000Z', description: 'Imported income to edit', amount: 10, categorySuggestion: 'Income'
  }])
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 90)

  await transactionsStore.updateTransaction(created.id, {
    accountId: pocket.id,
    amount: 15,
    description: 'Edited imported income',
    categoryId: '',
    date: new Date('2026-10-10T12:00:00.000Z'),
    type: 'income'
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 95)
  await transactionsStore.deleteTransaction(created.id)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 80)
  assert.equal((await adminDb.collection('transactions').doc(created.id).get()).exists, false)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 120)
})
