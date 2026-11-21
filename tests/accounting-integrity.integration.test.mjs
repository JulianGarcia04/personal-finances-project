// Accounting integrity integration tests against real stores and Firestore rules (emulators).
// Run through `node tests/pockets.imports.emulators.mjs`, which starts the emulators.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { createPocketFixture } from './pockets.fixtures.mjs'

let fixture
let sequence = 0
const date = new Date('2026-11-15T12:00:00')
const denied = error => error?.code === 'permission-denied'

before(async () => {
  fixture = await createPocketFixture()
})

after(async () => {
  await fixture?.close()
})

async function seedAccount(overrides = {}) {
  const { adminDb, identity, workspaceId } = fixture
  const id = `acct-int-${Date.now()}-${++sequence}`
  const data = {
    workspaceId,
    userId: identity.user.uid,
    name: `Cuenta ${sequence}`,
    type: 'checking',
    balance: 0,
    limit: 0,
    currency: 'COP',
    statementClosingDay: null,
    paymentDueDay: null,
    createdAt: new Date(),
    ...overrides
  }
  await adminDb.collection('accounts').doc(id).set(data)
  return { id, ...data }
}

async function storedBalance(accountId) {
  const snap = await fixture.adminDb.collection('accounts').doc(accountId).get()
  return snap.data().balance
}

async function storedCurrency(accountId) {
  const snap = await fixture.adminDb.collection('accounts').doc(accountId).get()
  return snap.data().currency
}

test('S1: ordinary cross-currency transfers are blocked in store (add & update) and Firestore rules while same-currency transfers work', async () => {
  const { db, identity, workspaceId, accountsStore, transactionsStore } = fixture
  const copA = await seedAccount({ name: 'Banco COP A', balance: 1_000, currency: 'COP' })
  const copB = await seedAccount({ name: 'Banco COP B', balance: 500, currency: 'COP' })
  const usd = await seedAccount({ name: 'Banco USD', balance: 100, currency: 'USD' })
  await accountsStore.fetchAccounts()

  // Store addTransaction rejects cross-currency transfer and leaves balances intact
  await assert.rejects(
    transactionsStore.addTransaction({
      accountId: copA.id, toAccountId: usd.id, amount: 200,
      description: 'Cross currency', categoryId: '', date, type: 'transfer'
    }),
    /misma moneda/i
  )
  assert.equal(await storedBalance(copA.id), 1_000)
  assert.equal(await storedBalance(usd.id), 100)

  // Same-currency transfer still succeeds
  const validTransfer = await transactionsStore.addTransaction({
    accountId: copA.id, toAccountId: copB.id, amount: 200,
    description: 'Same currency', categoryId: '', date, type: 'transfer'
  })
  assert.equal(await storedBalance(copA.id), 800)
  assert.equal(await storedBalance(copB.id), 700)

  // Store updateTransaction rejects retargeting into a different currency
  await assert.rejects(
    transactionsStore.updateTransaction(validTransfer.id, {
      accountId: copA.id, toAccountId: usd.id, amount: 200,
      description: 'Retargeted cross currency', categoryId: '', date, type: 'transfer'
    }),
    /misma moneda/i
  )
  assert.equal(await storedBalance(copA.id), 800)
  assert.equal(await storedBalance(copB.id), 700)
  assert.equal(await storedBalance(usd.id), 100)

  // Firestore rules reject direct cross-currency transfer creation, forged currency, and update
  await assert.rejects(
    setDoc(doc(db, 'transactions', `direct-xcurr-${++sequence}`), {
      workspaceId, userId: identity.user.uid, accountId: copA.id, toAccountId: usd.id,
      amount: 50, description: 'Direct xcurr', categoryId: '', date, type: 'transfer',
      receiptUrl: null, notes: null, installments: 1, currency: 'COP', createdAt: new Date()
    }),
    denied
  )
  await assert.rejects(
    setDoc(doc(db, 'transactions', `direct-forged-curr-${++sequence}`), {
      workspaceId, userId: identity.user.uid, accountId: copA.id, toAccountId: copB.id,
      amount: 50, description: 'Forged currency', categoryId: '', date, type: 'transfer',
      receiptUrl: null, notes: null, installments: 1, currency: 'USD', createdAt: new Date()
    }),
    denied
  )
  await assert.rejects(
    updateDoc(doc(db, 'transactions', validTransfer.id), { toAccountId: usd.id }),
    denied
  )

  // Legacy cross-currency transfer (seeded via admin) still allows metadata-only edits,
  // while rejecting financial changes (amount/accounts).
  const legacyId = `legacy-xcurr-${++sequence}`
  await fixture.adminDb.collection('transactions').doc(legacyId).set({
    workspaceId, userId: identity.user.uid, accountId: copA.id, toAccountId: usd.id,
    amount: 100, description: 'Legacy xcurr', categoryId: '', date, type: 'transfer',
    receiptUrl: null, notes: null, installments: 1, currency: 'COP', createdAt: new Date()
  })
  await transactionsStore.fetchTransactions()
  await transactionsStore.updateTransaction(legacyId, {
    accountId: copA.id, toAccountId: usd.id, amount: 100,
    description: 'Legacy xcurr renamed', categoryId: '', date, type: 'transfer', receiptUrl: null, notes: 'Audit note'
  })
  assert.equal((await fixture.adminDb.collection('transactions').doc(legacyId).get()).data().description, 'Legacy xcurr renamed')
  assert.equal(await storedBalance(copA.id), 800)
  assert.equal(await storedBalance(usd.id), 100)
  await assert.rejects(
    transactionsStore.updateTransaction(legacyId, {
      accountId: copA.id, toAccountId: usd.id, amount: 150,
      description: 'Legacy xcurr amount edit', categoryId: '', date, type: 'transfer'
    }),
    /misma moneda/i
  )
})

test('S2: editing account currency is blocked when balance is non-zero or movements exist, and allowed on a clean empty account', async () => {
  const { db, accountsStore, transactionsStore } = fixture
  const emptyAcc = await seedAccount({ name: 'Nueva vacía', balance: 0, currency: 'COP' })
  const fundedAcc = await seedAccount({ name: 'Con saldo', balance: 500, currency: 'COP' })
  const zeroWithHistory = await seedAccount({ name: 'Cero con historial', balance: 0, currency: 'COP' })
  await accountsStore.fetchAccounts()

  // Seed a pair of income + expense on zeroWithHistory so balance returns to 0 with history
  await transactionsStore.addTransaction({
    accountId: zeroWithHistory.id, amount: 100, description: 'Ingreso', categoryId: 'salary', date, type: 'income'
  })
  await transactionsStore.addTransaction({
    accountId: zeroWithHistory.id, amount: -100, description: 'Gasto', categoryId: 'food', date, type: 'expense'
  })
  assert.equal(await storedBalance(zeroWithHistory.id), 0)

  // Clean zero-balance account rejects single-write bypasses (currency + balance / mirror / invalid format)
  await assert.rejects(updateDoc(doc(db, 'accounts', emptyAcc.id), { currency: 'USD', balance: 100 }), denied)
  await assert.rejects(updateDoc(doc(db, 'accounts', emptyAcc.id), { currency: 'bad' }), denied)
  await assert.rejects(updateDoc(doc(db, 'accounts', emptyAcc.id), {
    currency: 'USD',
    mirror: { workspaceId: 'ws-other', accountId: 'rec', sourceAccountId: 'src' }
  }), denied)
  assert.equal(await storedCurrency(emptyAcc.id), 'COP')

  // Clean zero-balance account with no transactions CAN change currency
  await accountsStore.updateAccount(emptyAcc.id, {
    name: 'Nueva en USD', type: 'checking', limit: 0, currency: 'USD'
  })
  assert.equal(await storedCurrency(emptyAcc.id), 'USD')

  // Non-zero balance account CANNOT change currency (store AND direct Firestore rules)
  await assert.rejects(
    accountsStore.updateAccount(fundedAcc.id, {
      name: 'Con saldo', type: 'checking', limit: 0, currency: 'USD'
    }),
    /saldo/i
  )
  await assert.rejects(
    updateDoc(doc(db, 'accounts', fundedAcc.id), { currency: 'USD' }),
    denied
  )
  assert.equal(await storedCurrency(fundedAcc.id), 'COP')

  // Zero-balance account with historical transactions CANNOT change currency in store
  await assert.rejects(
    accountsStore.updateAccount(zeroWithHistory.id, {
      name: 'Cero con historial', type: 'checking', limit: 0, currency: 'USD'
    }),
    /movimientos/i
  )
  assert.equal(await storedCurrency(zeroWithHistory.id), 'COP')

  // Same-currency name/limit edit STILL works on funded account
  await accountsStore.updateAccount(fundedAcc.id, {
    name: 'Con saldo renombrada', type: 'checking', limit: 0, currency: 'COP'
  })
  assert.equal((await fixture.adminDb.collection('accounts').doc(fundedAcc.id).get()).data().name, 'Con saldo renombrada')
})
