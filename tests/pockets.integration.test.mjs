import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { collection, deleteDoc, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
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

test('client income into a pocket records the movement and balance atomically', async () => {
  const { accountsStore, transactionsStore, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Pocket income parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Pocket income', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parent.id
  })

  const created = await transactionsStore.addTransaction({
    accountId: pocket.id,
    amount: 50,
    description: 'Interest credited',
    categoryId: 'interest',
    date: new Date('2026-10-01T12:00:00.000Z'),
    type: 'income'
  })

  const [storedTransaction, storedPocket] = await Promise.all([
    adminDb.collection('transactions').doc(created.id).get(),
    adminDb.collection('accounts').doc(pocket.id).get()
  ])
  assert.equal(storedTransaction.data().type, 'income')
  assert.equal(storedPocket.data().balance, 50)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 500)
})

test('client edits and reversals update overlapping pocket accounts atomically', async () => {
  const { accountsStore, transactionsStore, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Movement parent', type: 'checking', balance: 900, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Movement pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id })
  const expense = await transactionsStore.addTransaction({
    accountId: pocket.id, amount: -40, description: 'Pocket expense', categoryId: 'food',
    date: new Date('2026-10-02T12:00:00.000Z'), type: 'expense'
  })
  const transfer = await transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: parent.id, amount: 30, description: 'Return to available',
    categoryId: '', date: new Date('2026-10-03T12:00:00.000Z'), type: 'transfer'
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 30)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 830)

  await transactionsStore.updateTransaction(transfer.id, {
    accountId: parent.id, toAccountId: pocket.id, amount: 20, description: 'Move back',
    categoryId: '', date: new Date('2026-10-04T12:00:00.000Z'), type: 'transfer'
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 80)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 780)

  await transactionsStore.deleteTransaction(transfer.id)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 60)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)
  await transactionsStore.deleteTransaction(expense.id)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().pocketActivity, true)
})

test('rules reject transaction-only amount edits after a legitimate linked pocket edit', async () => {
  const { accountsStore, transactionsStore, db, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Stale marker parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Stale marker pocket', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parent.id })
  const date = new Date('2026-10-05T12:00:00.000Z')
  const created = await transactionsStore.addTransaction({
    accountId: pocket.id, amount: 50, description: 'Initial pocket income', categoryId: 'income', date, type: 'income'
  })
  await transactionsStore.updateTransaction(created.id, {
    accountId: pocket.id, amount: 40, description: 'Legitimately edited pocket income', categoryId: 'income', date, type: 'income'
  })

  const [markedAccount, editedTransaction] = await Promise.all([
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').doc(created.id).get()
  ])
  assert.equal(markedAccount.data().lastPocketMovementId, created.id)
  assert.equal(markedAccount.data().lastPocketMovementType, 'updated')
  assert.equal(editedTransaction.data().amount, 40)

  await assert.rejects(updateDoc(doc(db, 'transactions', created.id), { amount: 30 }),
    error => error?.code === 'permission-denied')

  const [storedAccount, storedTransaction] = await Promise.all([
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').doc(created.id).get()
  ])
  assert.equal(storedAccount.data().balance, 40)
  assert.equal(storedTransaction.data().amount, 40)

  await updateDoc(doc(db, 'transactions', created.id), { description: 'Metadata-only edit' })
  const [metadataAccount, metadataTransaction] = await Promise.all([
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').doc(created.id).get()
  ])
  assert.equal(metadataAccount.data().balance, 40)
  assert.equal(metadataTransaction.data().description, 'Metadata-only edit')
})

test('rules reject a transaction-only edit piggybacking on another linked movement', async () => {
  const { accountsStore, transactionsStore, db, adminDb } = fixture
  const parent = await accountsStore.addAccount({ name: 'Piggyback parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Piggyback pocket', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parent.id })
  const date = new Date('2026-10-06T12:00:00.000Z')
  const linked = await transactionsStore.addTransaction({
    accountId: pocket.id, amount: 40, description: 'Linked income', categoryId: 'income', date, type: 'income'
  })
  const unlinked = await transactionsStore.addTransaction({
    accountId: pocket.id, amount: 60, description: 'Unlinked income', categoryId: 'income', date, type: 'income'
  })

  const batch = writeBatch(db)
  batch.update(doc(db, 'accounts', pocket.id), {
    balance: 110,
    lastPocketMovementId: linked.id,
    lastPocketMovementType: 'updated'
  })
  batch.update(doc(db, 'transactions', linked.id), { amount: 50 })
  batch.update(doc(db, 'transactions', unlinked.id), { amount: 70 })
  let batchError
  try {
    await batch.commit()
  } catch (error) {
    batchError = error
  }

  const [storedAccount, storedLinked, storedUnlinked] = await Promise.all([
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').doc(linked.id).get(),
    adminDb.collection('transactions').doc(unlinked.id).get()
  ])
  assert.deepEqual({
    balance: storedAccount.data().balance,
    markerId: storedAccount.data().lastPocketMovementId,
    markerType: storedAccount.data().lastPocketMovementType,
    linkedAmount: storedLinked.data().amount,
    unlinkedAmount: storedUnlinked.data().amount,
    error: batchError?.code
  }, {
    balance: 100,
    markerId: unlinked.id,
    markerType: 'created',
    linkedAmount: 40,
    unlinkedAmount: 60,
    error: 'permission-denied'
  })
})

test('client movement results stay scoped to the workspace captured before awaits', async () => {
  const { accountsStore, transactionsStore, authStore, adminDb, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Captured movement parent', type: 'checking', balance: 100, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Captured movement pocket', type: 'savings', balance: 0, currency: 'COP', parentAccountId: parent.id })
  const pending = transactionsStore.addTransaction({
    accountId: pocket.id, amount: 10, description: 'Captured income', categoryId: 'income',
    date: new Date(), type: 'income'
  })
  authStore.activeWorkspaceId = 'switched-workspace'
  const created = await pending

  assert.equal(created.workspaceId, workspaceId)
  assert.equal((await adminDb.collection('transactions').doc(created.id).get()).data().workspaceId, workspaceId)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 10)
  assert.equal(accountsStore.getAccountById(pocket.id).balance, 0)
  assert.equal(transactionsStore.transactions.some(transaction => transaction.id === created.id), false)
  authStore.activeWorkspaceId = workspaceId
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchTransactions()
  assert.equal(accountsStore.getAccountById(pocket.id).balance, 10)
})

test('client cashflows change wealth, internal transfers stay neutral, and rejected moves leave no writes', async () => {
  const { accountsStore, transactionsStore, adminDb, workspaceId } = fixture
  const totalBefore = accountsStore.netWorthByCurrency.COP ?? 0
  const parent = await accountsStore.addAccount({ name: 'Cashflow parent', type: 'checking', balance: 1_000, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Cashflow pocket', type: 'savings', balance: 300, currency: 'COP', parentAccountId: parent.id })
  const date = new Date()
  const foodCategory = `cashflow-food-${Date.now()}`

  await transactionsStore.addTransaction({
    accountId: pocket.id, amount: 40, description: 'Interest', categoryId: 'interest', date, type: 'income'
  })
  await transactionsStore.addTransaction({
    accountId: pocket.id, amount: -15, description: 'Coffee', categoryId: foodCategory, date, type: 'expense'
  })
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 1_025)
  assert.equal(transactionsStore.spendingByCategoryThisMonth()[foodCategory], 15)

  await transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: parent.id, amount: 25, description: 'Return to available',
    categoryId: '', date, type: 'transfer'
  })
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 1_025)
  assert.equal(transactionsStore.spendingByCategoryThisMonth()[foodCategory], 15)

  const sameCurrencyBank = await accountsStore.addAccount({ name: 'Other COP bank', type: 'checking', balance: 100, currency: 'COP' })
  await transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: sameCurrencyBank.id, amount: 10, description: 'Transfer to another bank',
    categoryId: '', date, type: 'transfer'
  })
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 1_125)
  assert.equal(transactionsStore.spendingByCategoryThisMonth()[foodCategory], 15)

  const usd = await accountsStore.addAccount({ name: 'USD account', type: 'checking', balance: 100, currency: 'USD' })
  const credit = await accountsStore.addAccount({ name: 'Credit account', type: 'credit', balance: 0, limit: 500, currency: 'COP' })
  const foreignWorkspaceId = `movement-foreign-${Date.now()}`
  await adminDb.collection('workspaces').doc(foreignWorkspaceId).set({
    id: foreignWorkspaceId, name: 'Foreign movement workspace', ownerId: 'other-user', members: ['other-user'], currency: 'COP'
  })
  const foreignAccountId = `movement-foreign-account-${Date.now()}`
  await adminDb.collection('accounts').doc(foreignAccountId).set({
    workspaceId: foreignWorkspaceId, userId: 'other-user', name: 'Foreign bank', type: 'checking',
    balance: 100, limit: 0, currency: 'COP'
  })
  const beforeTransactions = await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  const beforeBalances = await Promise.all([parent.id, pocket.id, sameCurrencyBank.id, usd.id].map(id => adminDb.collection('accounts').doc(id).get()))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: usd.id, amount: 10, description: 'Wrong currency',
    categoryId: '', date, type: 'transfer'
  }))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: foreignAccountId, amount: 10, description: 'Foreign workspace',
    categoryId: '', date, type: 'transfer'
  }))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: credit.id, amount: 10, description: 'Credit destination',
    categoryId: '', date, type: 'transfer'
  }))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, toAccountId: 'missing-account', amount: 10, description: 'Missing destination',
    categoryId: '', date, type: 'transfer'
  }))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, amount: -10, description: 'Unsupported loan', categoryId: '', date, type: 'loan'
  }))
  await assert.rejects(transactionsStore.addTransaction({
    accountId: pocket.id, amount: -301, description: 'Overspend', categoryId: 'food', date, type: 'expense'
  }))
  const [afterTransactions, afterBalances] = await Promise.all([
    adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get(),
    Promise.all([parent.id, pocket.id, sameCurrencyBank.id, usd.id].map(id => adminDb.collection('accounts').doc(id).get()))
  ])
  assert.equal(afterTransactions.size, beforeTransactions.size)
  assert.deepEqual(afterBalances.map(snapshot => snapshot.data().balance), beforeBalances.map(snapshot => snapshot.data().balance))
})

test('ordinary unpocketed income and expense retain their existing transaction path', async () => {
  const { accountsStore, transactionsStore, adminDb } = fixture
  const account = await accountsStore.addAccount({ name: 'Ordinary transaction account', type: 'checking', balance: 50, currency: 'COP' })
  const income = await transactionsStore.addTransaction({
    accountId: account.id, amount: 10, description: 'Ordinary income', categoryId: 'income',
    date: new Date(), type: 'income'
  })
  const expense = await transactionsStore.addTransaction({
    accountId: account.id, amount: -5, description: 'Ordinary expense', categoryId: 'ordinary-food',
    date: new Date(), type: 'expense'
  })
  await transactionsStore.updateTransaction(income.id, {
    accountId: account.id, amount: 15, description: 'Updated ordinary income', categoryId: 'income',
    date: new Date(), type: 'income', receiptUrl: null, notes: null, installments: 1
  })
  await transactionsStore.deleteTransaction(expense.id)
  const [accountAfter, storedIncome, storedExpense] = await Promise.all([
    adminDb.collection('accounts').doc(account.id).get(),
    adminDb.collection('transactions').doc(income.id).get(),
    adminDb.collection('transactions').doc(expense.id).get()
  ])
  assert.equal(accountAfter.data().balance, 65)
  assert.equal(storedIncome.data().type, 'income')
  assert.equal(storedIncome.data().amount, 15)
  assert.equal(storedExpense.exists, false)
  assert.equal('lastPocketMovementId' in accountAfter.data(), false)
})

test('editing a normal transaction into and out of a pocket applies combined deltas', async () => {
  const { accountsStore, transactionsStore, adminDb } = fixture
  const totalBefore = accountsStore.netWorthByCurrency.COP ?? 0
  const parent = await accountsStore.addAccount({ name: 'Cross-boundary parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Cross-boundary pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id })
  const ordinary = await accountsStore.addAccount({ name: 'Cross-boundary ordinary', type: 'checking', balance: 100, currency: 'COP' })
  const date = new Date()

  const ordinaryIncome = await transactionsStore.addTransaction({
    accountId: ordinary.id, amount: 20, description: 'Before pocket', categoryId: 'income', date, type: 'income'
  })
  await transactionsStore.updateTransaction(ordinaryIncome.id, {
    accountId: pocket.id, amount: 30, description: 'Into pocket', categoryId: 'income', date, type: 'income'
  })
  assert.equal((await adminDb.collection('accounts').doc(ordinary.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 130)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 630)
  await transactionsStore.deleteTransaction(ordinaryIncome.id)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)

  const pocketIncome = await transactionsStore.addTransaction({
    accountId: pocket.id, amount: 10, description: 'Before ordinary', categoryId: 'income', date, type: 'income'
  })
  await transactionsStore.updateTransaction(pocketIncome.id, {
    accountId: ordinary.id, amount: 15, description: 'Out of pocket', categoryId: 'income', date, type: 'income'
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(ordinary.id).get()).data().balance, 115)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 615)
  await transactionsStore.deleteTransaction(pocketIncome.id)
  assert.equal((await adminDb.collection('accounts').doc(ordinary.id).get()).data().balance, 100)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 600)
})

test('funded opening allocations retain transfer identity through edits and clear their link on reversal', async () => {
  const { accountsStore, transactionsStore, db, adminDb } = fixture
  const totalBefore = accountsStore.netWorthByCurrency.COP ?? 0
  const parent = await accountsStore.addAccount({ name: 'Opening edit parent', type: 'checking', balance: 1_000, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Opening edit pocket', type: 'savings', balance: 300, currency: 'COP', parentAccountId: parent.id })
  await transactionsStore.fetchTransactions()
  const allocation = transactionsStore.transactions.find(transaction => transaction.id === pocket.openingAllocationId)
  assert.ok(allocation)
  assert.equal(allocation.pocketAllocation, true)

  await assert.rejects(transactionsStore.updateTransaction(allocation.id, {
    accountId: pocket.id, amount: 300, description: 'Invalid allocation direction', categoryId: '',
    date: new Date(), type: 'expense'
  }))
  await assert.rejects(updateDoc(doc(db, 'transactions', allocation.id), { toAccountId: parent.id }),
    error => error?.code === 'permission-denied')
  await transactionsStore.updateTransaction(allocation.id, {
    accountId: parent.id, toAccountId: pocket.id, amount: 250, description: 'Corrected opening allocation',
    categoryId: '', date: new Date(), type: 'transfer'
  })
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 750)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 250)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 1_000)

  await transactionsStore.deleteTransaction(allocation.id)
  const [parentAfter, pocketAfter, allocationAfter] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').doc(allocation.id).get()
  ])
  assert.equal(parentAfter.data().balance, 1_000)
  assert.equal(pocketAfter.data().balance, 0)
  assert.equal(pocketAfter.data().openingAllocationId, null)
  assert.equal(pocketAfter.data().pocketActivity, true)
  assert.equal(allocationAfter.exists, false)
})

test('concurrent pocket expenses serialize without overdraft or orphan transactions', async () => {
  const { accountsStore, transactionsStore, adminDb, workspaceId } = fixture
  const totalBefore = accountsStore.netWorthByCurrency.COP ?? 0
  const parent = await accountsStore.addAccount({ name: 'Concurrent movement parent', type: 'checking', balance: 100, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Concurrent movement pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id })
  const attempts = await Promise.allSettled([-70, -50].map((amount, index) => transactionsStore.addTransaction({
    accountId: pocket.id, amount, description: `Concurrent expense ${index}`, categoryId: 'food',
    date: new Date(), type: 'expense'
  })))
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1)
  const [parentAfter, pocketAfter, records] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  ])
  assert.ok(pocketAfter.data().balance >= 0)
  const successful = records.docs.filter(document => document.data().description.startsWith('Concurrent expense'))
  assert.equal(successful.length, 1)
  assert.equal(accountsStore.netWorthByCurrency.COP, totalBefore + 100 + successful[0].data().amount)
  assert.equal(parentAfter.data().balance + pocketAfter.data().balance, 100 + successful[0].data().amount)
})

test('extracted Admin movement helper preserves wealth and rolls back invalid reversals', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Admin movement parent', type: 'checking', balance: 900, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: 'Admin movement pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id })
  const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
  const created = await mutateWorkspaceTransaction(adminDb, {
    kind: 'created', userId: identity.user.uid, workspaceId,
    movement: { accountId: pocket.id, amount: -35, type: 'expense', description: 'Admin pocket expense', categoryId: 'food' }
  })
  const txRef = adminDb.collection('transactions').doc(created.id)
  const beforeFailedDelete = await adminDb.collection('accounts').doc(pocket.id).get()
  await assert.rejects(mutateWorkspaceTransaction(adminDb, {
    kind: 'updated', userId: identity.user.uid, workspaceId, transactionId: created.id,
    movement: { accountId: pocket.id, amount: -200, type: 'expense', description: 'Overspend edit', categoryId: 'food' }
  }))
  assert.equal((await adminDb.collection('transactions').doc(created.id).get()).exists, true)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, beforeFailedDelete.data().balance)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)

  await mutateWorkspaceTransaction(adminDb, { kind: 'deleted', userId: identity.user.uid, workspaceId, transactionId: created.id })
  assert.equal((await txRef.get()).exists, false)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)
  await assert.rejects(mutateWorkspaceTransaction(adminDb, {
    kind: 'created', userId: 'not-a-member', workspaceId,
    movement: { accountId: pocket.id, amount: 1, type: 'income', description: 'Outsider', categoryId: 'income' }
  }))

  const transfer = await mutateWorkspaceTransaction(adminDb, {
    kind: 'created', userId: identity.user.uid, workspaceId,
    movement: {
      accountId: pocket.id, toAccountId: parent.id, amount: 20, type: 'transfer',
      description: 'Admin internal allocation', categoryId: ''
    }
  })
  await mutateWorkspaceTransaction(adminDb, {
    kind: 'updated', userId: identity.user.uid, workspaceId, transactionId: transfer.id,
    movement: {
      accountId: parent.id, toAccountId: pocket.id, amount: 10, type: 'transfer',
      description: 'Admin corrected allocation', categoryId: ''
    }
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 110)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 790)
  await mutateWorkspaceTransaction(adminDb, {
    kind: 'deleted', userId: identity.user.uid, workspaceId, transactionId: transfer.id
  })
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)

  const usd = await accountsStore.addAccount({ name: 'Admin USD account', type: 'checking', balance: 100, currency: 'USD' })
  const foreignWorkspaceId = `admin-foreign-${Date.now()}`
  await adminDb.collection('workspaces').doc(foreignWorkspaceId).set({
    id: foreignWorkspaceId, name: 'Admin foreign workspace', ownerId: 'other-user', members: ['other-user'], currency: 'COP'
  })
  const foreignId = `admin-foreign-account-${Date.now()}`
  await adminDb.collection('accounts').doc(foreignId).set({
    workspaceId: foreignWorkspaceId, userId: 'other-user', name: 'Admin foreign account',
    type: 'checking', balance: 50, limit: 0, currency: 'COP'
  })
  const transactionsBeforeInvalidMoves = await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  for (const destinationId of [usd.id, foreignId]) {
    await assert.rejects(mutateWorkspaceTransaction(adminDb, {
      kind: 'created', userId: identity.user.uid, workspaceId,
      movement: {
        accountId: pocket.id, toAccountId: destinationId, amount: 5, type: 'transfer',
        description: 'Invalid Admin transfer', categoryId: ''
      }
    }))
  }
  assert.equal((await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size, transactionsBeforeInvalidMoves.size)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 100)
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)
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
  const { accountsStore, transactionsStore, db, adminDb, workspaceId, identity } = fixture
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

  const forgedPocketTx = doc(collection(db, 'transactions'))
  await assert.rejects(setDoc(forgedPocketTx, {
    workspaceId,
    userId: identity.user.uid,
    accountId: pocket.id,
    amount: 10,
    description: 'Forged pocket income without account update',
    categoryId: 'income',
    date: new Date(),
    type: 'income',
    toAccountId: null,
    currency: 'COP',
    createdAt: new Date()
  }), error => error?.code === 'permission-denied')
  assert.equal((await adminDb.collection('transactions').doc(forgedPocketTx.id).get()).exists, false)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 200)
  const beforeImport = await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  await assert.rejects(transactionsStore.addTransactionsBatch(pocket.id, [{
    date: new Date().toISOString(), description: 'Unsupported imported pocket expense', amount: -5,
    categorySuggestion: 'Food'
  }]))
  assert.equal((await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size, beforeImport.size)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 200)

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

  const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
  await mutateWorkspaceTransaction(adminDb, {
    kind: 'updated', userId: identity.user.uid, workspaceId,
    transactionId: String(pocket.openingAllocationId),
    movement: {
      accountId: parent.id, toAccountId: String(pocket.id), amount: 200, type: 'transfer',
      description: 'Admin corrected opening allocation', categoryId: ''
    }
  })
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 800)
  assert.equal((await adminDb.collection('accounts').doc(String(pocket.id)).get()).data().balance, 200)
  await mutateWorkspaceTransaction(adminDb, {
    kind: 'deleted', userId: identity.user.uid, workspaceId,
    transactionId: String(pocket.openingAllocationId)
  })
  assert.equal((await adminDb.collection('accounts').doc(parent.id).get()).data().balance, 1_000)
  const reversedPocket = (await adminDb.collection('accounts').doc(String(pocket.id)).get()).data()
  assert.equal(reversedPocket.balance, 0)
  assert.equal(reversedPocket.openingAllocationId, null)
})
