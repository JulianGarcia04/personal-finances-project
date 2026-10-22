import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
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

test('statement import applies mixed income and expense rows atomically to pockets and their parent bank', async () => {
  const { accountsStore, transactionsStore, adminDb, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Statement import parent', type: 'checking', balance: 1_000, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Statement import pocket', type: 'savings', balance: 300, currency: 'COP', parentAccountId: parent.id
  })
  const beforeTransactions = await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  const rows = [
    { date: '2026-10-10T10:00:00.000Z', description: 'Statement income', amount: 50, categorySuggestion: 'Income' },
    { date: '2026-10-10T11:00:00.000Z', description: 'Statement expense', amount: -20, categorySuggestion: 'Food' }
  ]

  const results = await Promise.allSettled([
    transactionsStore.addTransactionsBatch(pocket.id, rows),
    transactionsStore.addTransactionsBatch(parent.id, rows)
  ])
  const [parentAfter, pocketAfter, afterTransactions] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').doc(pocket.id).get(),
    adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  ])

  assert.deepEqual({
    outcomes: results.map(result => result.status),
    parentBalance: parentAfter.data().balance,
    pocketBalance: pocketAfter.data().balance,
    newTransactionCount: afterTransactions.size - beforeTransactions.size,
    importedTypes: results.flatMap(result => result.status === 'fulfilled' ? result.value.map(tx => tx.type) : [])
  }, {
    outcomes: ['fulfilled', 'fulfilled'],
    parentBalance: 730,
    pocketBalance: 330,
    newTransactionCount: 4,
    importedTypes: ['income', 'expense', 'income', 'expense']
  })
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
    date: 'not-a-date', description: 'Invalid imported pocket expense', amount: -5,
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

test('legacy Admin movements reject invalid transfers and cashflow signs without writes', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
  const source = await accountsStore.addAccount({ name: 'Legacy ledger source', type: 'checking', balance: 500, currency: 'COP' })
  const target = await accountsStore.addAccount({ name: 'Legacy ledger target', type: 'savings', balance: 100, currency: 'COP' })
  const foreign = await accountsStore.addAccount({ name: 'Legacy ledger USD', type: 'checking', balance: 40, currency: 'USD' })
  const balanceOf = async id => (await adminDb.collection('accounts').doc(id).get()).data().balance
  const countTransactions = async () => (await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size
  const transactionsBefore = await countTransactions()
  const create = movement => mutateWorkspaceTransaction(adminDb, {
    kind: 'created', userId: identity.user.uid, workspaceId,
    movement: { description: 'Legacy invalid movement', categoryId: '', ...movement }
  })

  for (const movement of [
    { accountId: source.id, toAccountId: source.id, amount: 50, type: 'transfer' },
    { accountId: source.id, toAccountId: foreign.id, amount: 5, type: 'transfer' },
    { accountId: source.id, toAccountId: target.id, amount: -50, type: 'transfer' },
    { accountId: source.id, toAccountId: null, amount: 50, type: 'transfer' },
    { accountId: source.id, amount: 50, type: 'expense' },
    { accountId: source.id, amount: -50, type: 'income' },
    { accountId: source.id, amount: 0, type: 'income' }
  ]) {
    await assert.rejects(create(movement), undefined, JSON.stringify(movement))
  }
  assert.equal(await countTransactions(), transactionsBefore)
  assert.equal(await balanceOf(source.id), 500)
  assert.equal(await balanceOf(target.id), 100)
  assert.equal(await balanceOf(foreign.id), 40)

  const transfer = await create({ accountId: source.id, toAccountId: target.id, amount: 50, type: 'transfer' })
  assert.equal(await balanceOf(source.id), 450)
  assert.equal(await balanceOf(target.id), 150)
  await assert.rejects(mutateWorkspaceTransaction(adminDb, {
    kind: 'updated', userId: identity.user.uid, workspaceId, transactionId: transfer.id,
    movement: { accountId: source.id, toAccountId: source.id, amount: 50, type: 'transfer', description: 'Same account edit', categoryId: '' }
  }))
  assert.equal(await balanceOf(source.id), 450)
  await mutateWorkspaceTransaction(adminDb, { kind: 'deleted', userId: identity.user.uid, workspaceId, transactionId: transfer.id })
  assert.equal(await balanceOf(source.id), 500)
  assert.equal(await balanceOf(target.id), 100)
})

test('legacy Admin balances are rounded to cents', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
  const account = await accountsStore.addAccount({ name: 'Legacy rounding', type: 'checking', balance: 0, currency: 'USD' })
  for (const amount of [0.1, 0.2]) {
    await mutateWorkspaceTransaction(adminDb, {
      kind: 'created', userId: identity.user.uid, workspaceId,
      movement: { accountId: account.id, amount, type: 'income', description: 'Cents', categoryId: '' }
    })
  }
  assert.equal((await adminDb.collection('accounts').doc(account.id).get()).data().balance, 0.3)
})

test('Admin delete refuses one leg of a mirror pair and leaves both legs and balances intact', async () => {
  const { accountsStore, adminDb, identity, workspaceId } = fixture
  const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
  const bridge = await accountsStore.addAccount({ name: 'Mirror bridge', type: 'checking', balance: 300, currency: 'COP' })
  const otherWorkspaceId = `mirror-other-${Date.now()}`
  const localRef = adminDb.collection('transactions').doc()
  const twinRef = adminDb.collection('transactions').doc()
  const base = { userId: identity.user.uid, amount: -60, description: 'Shared expense', categoryId: '', type: 'expense',
    toAccountId: null, currency: 'COP', installments: 1, date: new Date() }
  await localRef.set({ ...base, workspaceId, accountId: bridge.id, mirrorOf: twinRef.id })
  await twinRef.set({ ...base, workspaceId: otherWorkspaceId, accountId: 'mirror-receivable', mirrorOf: localRef.id })
  const referencedOnlyRef = adminDb.collection('transactions').doc()
  const referrerRef = adminDb.collection('transactions').doc()
  await referencedOnlyRef.set({ ...base, workspaceId, accountId: bridge.id })
  await referrerRef.set({ ...base, workspaceId: otherWorkspaceId, accountId: 'mirror-receivable', mirrorOf: referencedOnlyRef.id })

  for (const transactionId of [localRef.id, referencedOnlyRef.id]) {
    await assert.rejects(
      mutateWorkspaceTransaction(adminDb, { kind: 'deleted', userId: identity.user.uid, workspaceId, transactionId }),
      /desde la app/
    )
  }
  for (const ref of [localRef, twinRef, referencedOnlyRef, referrerRef]) assert.equal((await ref.get()).exists, true)
  assert.equal((await adminDb.collection('accounts').doc(bridge.id).get()).data().balance, 300)
})

for (const channel of ['client', 'server']) {
  for (const hasPockets of [false, true]) {
    test(`${channel} card payments preserve create/edit/delete balances ${hasPockets ? 'with pockets' : 'without pockets'}`, async () => {
      const { accountsStore, transactionsStore, db, adminDb, identity, workspaceId } = fixture
      const { mutateWorkspaceTransaction } = functionsRequire('./lib/pockets.js')
      const bank = await accountsStore.addAccount({ name: 'Payment savings', type: 'savings', balance: 1_000, currency: 'COP' })
      const pocket = hasPockets
        ? await accountsStore.addAccount({ name: 'Reserved savings', type: 'savings', balance: 200, currency: 'COP', parentAccountId: bank.id })
        : null
      const card = await accountsStore.addAccount({ name: 'Payment card', type: 'credit', balance: -500, limit: 2_000, currency: 'COP' })
      const accountIds = [bank.id, card.id, ...(pocket ? [pocket.id] : [])]
      const movement = {
        accountId: bank.id, toAccountId: card.id, amount: 100, type: 'transfer',
        description: 'Credit-card payment', categoryId: '', date: new Date('2026-10-16T12:00:00.000Z'),
        receiptUrl: null, notes: null, installments: 1
      }
      const mutate = async (kind, transactionId, next) => channel === 'client'
        ? kind === 'created' ? transactionsStore.addTransaction(next)
          : kind === 'updated' ? transactionsStore.updateTransaction(transactionId, next)
            : transactionsStore.deleteTransaction(transactionId)
        : mutateWorkspaceTransaction(adminDb, {
          kind, transactionId, userId: identity.user.uid, workspaceId, ...(next ? { movement: next } : {})
        })
      const snapshot = async () => {
        const accounts = await Promise.all(accountIds.map(id => getDoc(doc(db, 'accounts', id))))
        const transactions = await getDocs(query(collection(db, 'transactions'), where('workspaceId', '==', workspaceId)))
        return {
          accounts: accounts.map(account => account.data()),
          transactions: transactions.docs.map(transaction => ({ id: transaction.id, ...transaction.data() }))
            .sort((a, b) => a.id.localeCompare(b.id))
        }
      }
      const before = await snapshot()
      const initialBankBalance = hasPockets ? 800 : 1_000
      const assertBalances = async (paid) => {
        const state = await snapshot()
        assert.deepEqual(state.accounts.map(account => account.balance), [
          initialBankBalance - paid, -500 + paid, ...(pocket ? [200] : [])
        ])
        assert.equal(state.accounts.reduce((total, account) => total + account.balance, 0), 500)
        assert.equal(state.accounts[1].limit + state.accounts[1].balance, 1_500 + paid)
        await accountsStore.fetchAccounts()
        assert.deepEqual(accountIds.map(id => accountsStore.getAccountById(id)?.balance), state.accounts.map(account => account.balance))
        return state
      }
      const created = await mutate('created', undefined, movement)
      const afterCreate = await assertBalances(100)
      const stored = await getDoc(doc(db, 'transactions', created.id))
      assert.equal(stored.exists(), true)
      assert.deepEqual({
        workspaceId: stored.data().workspaceId, accountId: stored.data().accountId,
        toAccountId: stored.data().toAccountId, type: stored.data().type,
        amount: stored.data().amount, currency: stored.data().currency, categoryId: stored.data().categoryId
      }, { workspaceId, accountId: bank.id, toAccountId: card.id, type: 'transfer', amount: 100, currency: 'COP', categoryId: '' })
      assert.equal(afterCreate.transactions.length, before.transactions.length + 1)
      assert.deepEqual(afterCreate.transactions.filter(tx => tx.type !== 'transfer'), before.transactions.filter(tx => tx.type !== 'transfer'))

      if (pocket) {
        for (const invalid of [
          { ...movement, accountId: pocket.id },
          { ...movement, accountId: card.id, toAccountId: pocket.id },
          { ...movement, amount: 701 }
        ]) {
          const unchanged = await snapshot()
          await assert.rejects(mutate('created', undefined, invalid), /bolsillo|tarjeta|saldo/i)
          assert.deepEqual(await snapshot(), unchanged)
        }
        const unchanged = await snapshot()
        await assert.rejects(mutate('updated', created.id, { ...movement, accountId: pocket.id }), /bolsillo|tarjeta/i)
        await assert.rejects(updateDoc(doc(db, 'transactions', created.id), { amount: 101 }), error => error?.code === 'permission-denied')
        assert.deepEqual(await snapshot(), unchanged)

        const forged = doc(collection(db, 'transactions'))
        const batch = writeBatch(db)
        batch.set(forged, { ...stored.data(), accountId: pocket.id, amount: 10 })
        batch.update(doc(db, 'accounts', pocket.id), {
          balance: 190, pocketActivity: true, lastPocketMovementId: forged.id, lastPocketMovementType: 'created'
        })
        batch.update(doc(db, 'accounts', card.id), {
          balance: -390, lastPocketMovementId: forged.id, lastPocketMovementType: 'created'
        })
        await assert.rejects(batch.commit(), error => error?.code === 'permission-denied')
        assert.deepEqual(await snapshot(), unchanged)
      }

      await mutate('updated', created.id, { ...movement, amount: 150 })
      const afterEdit = await assertBalances(150)
      assert.equal((await getDoc(doc(db, 'transactions', created.id))).data().amount, 150)
      assert.equal(afterEdit.transactions.length, afterCreate.transactions.length)
      await mutate('deleted', created.id)
      const afterDelete = await assertBalances(0)
      assert.equal(afterDelete.transactions.some(transaction => transaction.id === created.id), false)
      assert.deepEqual(afterDelete.transactions, before.transactions)
      if (pocket) assert.deepEqual(afterDelete.accounts[2], before.accounts[2])
    })
  }
}

for (const attack of ['created', 'updated', 'relinked', 'deleted']) {
  test(`rules reject forged root-card payment ${attack} without exact linked effects`, async () => {
    const { accountsStore, transactionsStore, db, workspaceId, identity } = fixture
    const bank = await accountsStore.addAccount({ name: 'Guarded payment bank', type: 'savings', balance: 1_000, currency: 'COP' })
    const pocket = await accountsStore.addAccount({ name: 'Guarded reserve', type: 'savings', balance: 200, currency: 'COP', parentAccountId: bank.id })
    const card = await accountsStore.addAccount({ name: 'Guarded card', type: 'credit', balance: -500, limit: 2_000, currency: 'COP' })
    const otherCard = await accountsStore.addAccount({ name: 'Other guarded card', type: 'credit', balance: -500, limit: 2_000, currency: 'COP' })
    const movement = {
      accountId: bank.id, toAccountId: card.id, amount: 100, type: 'transfer',
      description: 'Guarded card payment', categoryId: '', date: new Date('2026-10-16T12:00:00.000Z')
    }
    const created = attack === 'created' ? null : await transactionsStore.addTransaction(movement)
    const transactionRef = created ? doc(db, 'transactions', created.id) : doc(collection(db, 'transactions'))
    const accountIds = [bank.id, pocket.id, card.id, otherCard.id]
    const snapshot = async () => ({
      accounts: await Promise.all(accountIds.map(async id => (await getDoc(doc(db, 'accounts', id))).data())),
      transactions: (await getDocs(query(collection(db, 'transactions'), where('workspaceId', '==', workspaceId))))
        .docs.map(transaction => ({ id: transaction.id, ...transaction.data() })).sort((a, b) => a.id.localeCompare(b.id))
    })
    const before = await snapshot()
    const batch = writeBatch(db)
    if (attack === 'created') {
      batch.set(transactionRef, { ...movement, workspaceId, userId: identity.user.uid, currency: 'COP', createdAt: new Date() })
    } else if (attack === 'deleted') batch.delete(transactionRef)
    else batch.update(transactionRef, { amount: 150, ...(attack === 'relinked' ? { toAccountId: otherCard.id } : {}) })
    batch.update(doc(db, 'accounts', bank.id), {
      balance: attack === 'created' ? 700 : attack === 'deleted' ? 800 : 650,
      lastPocketMovementId: transactionRef.id,
      lastPocketMovementType: attack === 'relinked' ? 'updated' : attack
    })
    // A childless root must not bypass linked effects by omitting current markers.
    batch.update(doc(db, 'accounts', card.id), {
      balance: attack === 'created' ? -250 : attack === 'deleted' ? -650 : attack === 'relinked' ? -500 : -350
    })
    if (attack === 'relinked') batch.update(doc(db, 'accounts', otherCard.id), { balance: -250 })
    await assert.rejects(batch.commit(), error => error?.code === 'permission-denied')
    assert.deepEqual(await snapshot(), before, 'rejected batches must preserve every account, transaction and transaction count')
    if (created) await transactionsStore.deleteTransaction(created.id)
  })
}

// A root account linked to an active budget, plus a parent with one pocket.
const linkedPocketSetup = async label => {
  const { accountsStore, db, workspaceId } = fixture
  const linked = await accountsStore.addAccount({ name: `${label} linked cash`, type: 'checking', balance: 500, currency: 'COP' })
  const parent = await accountsStore.addAccount({ name: `${label} parent`, type: 'checking', balance: 400, currency: 'COP' })
  const pocket = await accountsStore.addAccount({ name: `${label} pocket`, type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id })
  const budget = doc(collection(db, 'budgets'))
  // The budget and its account link are written together, as the client does.
  const link = writeBatch(db)
  link.set(budget, {
    workspaceId, kind: 'event', name: `${label} event`, capCurrency: 'COP', archived: false,
    linkedAccountIds: [linked.id], createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  })
  link.update(doc(db, 'accounts', linked.id), { linkedBudgetId: budget.id })
  await link.commit()
  return { linked, parent, pocket, budgetId: budget.id }
}

test('a linked expense edited into pocket income leaves its budget in the same pocket write', async () => {
  const { transactionsStore, adminDb } = fixture
  const { linked, pocket, budgetId } = await linkedPocketSetup('Leave')
  const date = new Date()
  const expense = await transactionsStore.addTransaction({
    accountId: linked.id, amount: 40, description: 'Linked expense', categoryId: 'food', date, type: 'expense', budgetId
  })
  const stored = async () => (await adminDb.collection('transactions').doc(expense.id).get()).data()
  const balance = async accountId => (await adminDb.collection('accounts').doc(accountId).get()).data().balance
  assert.equal((await stored()).budgetId, budgetId)

  // The edit form passes the link of the edited account (the pocket has none).
  await transactionsStore.updateTransaction(expense.id, {
    accountId: pocket.id, amount: 30, description: 'Now pocket income', categoryId: 'food', date, type: 'income', linkedBudgetId: null
  })
  assert.equal((await stored()).type, 'income')
  assert.equal('budgetId' in (await stored()), false)
  assert.deepEqual([await balance(linked.id), await balance(pocket.id)], [500, 130])
  assert.equal('budgetId' in transactionsStore.transactions.find(transaction => transaction.id === expense.id), false)
})

test('a pocket transfer edited into an expense of a linked account takes its budget in the same pocket write', async () => {
  const { transactionsStore, adminDb } = fixture
  const { linked, parent, pocket, budgetId } = await linkedPocketSetup('Join')
  const date = new Date()
  const transfer = await transactionsStore.addTransaction({
    accountId: parent.id, toAccountId: pocket.id, amount: 40, description: 'Fill the pocket', categoryId: '', date, type: 'transfer'
  })
  const stored = async () => (await adminDb.collection('transactions').doc(transfer.id).get()).data()
  const balance = async accountId => (await adminDb.collection('accounts').doc(accountId).get()).data().balance

  await transactionsStore.updateTransaction(transfer.id, {
    accountId: linked.id, amount: 30, description: 'Linked expense', categoryId: 'food', date, type: 'expense', linkedBudgetId: budgetId
  })
  assert.deepEqual([(await stored()).type, (await stored()).budgetId], ['expense', budgetId])
  assert.deepEqual([await balance(parent.id), await balance(pocket.id), await balance(linked.id)], [300, 100, 470])
  assert.equal(transactionsStore.transactions.find(transaction => transaction.id === transfer.id)?.budgetId, budgetId)
})
