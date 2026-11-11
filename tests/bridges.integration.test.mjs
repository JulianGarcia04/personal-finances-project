// Bridge accounts and shared expenses against the real stores and Firestore rules (emulators).
// Run through `node tests/pockets.imports.emulators.mjs`, which starts the emulators.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { createPocketFixture } from './pockets.fixtures.mjs'

let fixture
let sequence = 0
const date = new Date('2026-11-10T12:00:00')
const denied = error => error?.code === 'permission-denied'

before(async () => {
  fixture = await createPocketFixture()
})

after(async () => {
  await fixture?.close()
})

/** Seeds a bridge in the fixture workspace that mirrors into a second workspace of the same user. */
async function seedBridge({ debt = 0 } = {}) {
  const { adminDb, identity, workspaceId, accountsStore, authStore } = fixture
  authStore.activeWorkspaceId = workspaceId
  const userId = identity.user.uid
  const key = `bridge-${Date.now()}-${++sequence}`
  const mirrorWorkspaceId = `${key}-mirror`
  const ids = {
    bank: `${key}-bank`,
    bridge: `${key}-bridge`,
    source: `${key}-source`,
    receivable: `${key}-receivable`,
    to: `${key}-to`
  }
  await adminDb.collection('workspaces').doc(mirrorWorkspaceId).set({
    id: mirrorWorkspaceId, name: 'Personal', ownerId: userId, members: [userId], currency: 'COP'
  })
  const account = (id, data) => adminDb.collection('accounts').doc(id).set({
    userId, limit: 0, currency: 'COP', statementClosingDay: null, paymentDueDay: null, createdAt: new Date(), ...data
  })
  await account(ids.bank, { workspaceId, name: 'Bank', type: 'savings', balance: 1_000 })
  await account(ids.bridge, {
    workspaceId, name: 'Bridge', type: 'checking', balance: -debt,
    mirror: { workspaceId: mirrorWorkspaceId, accountId: ids.receivable, sourceAccountId: ids.source }
  })
  await account(ids.source, { workspaceId: mirrorWorkspaceId, name: 'Card', type: 'credit', balance: -debt })
  await account(ids.receivable, { workspaceId: mirrorWorkspaceId, name: 'Receivable', type: 'checking', balance: debt })
  await account(ids.to, { workspaceId: mirrorWorkspaceId, name: 'Personal bank', type: 'savings', balance: 500 })
  await accountsStore.fetchAccounts()
  return { ids, mirrorWorkspaceId }
}

async function balances(ids) {
  const entries = await Promise.all(Object.entries(ids).map(async ([name, id]) => {
    const snap = await fixture.adminDb.collection('accounts').doc(id).get()
    return [name, snap.data().balance]
  }))
  return Object.fromEntries(entries)
}

async function transactionsTouching(ids) {
  const touching = await Promise.all(Object.values(ids).flatMap(id => [
    fixture.adminDb.collection('transactions').where('accountId', '==', id).get(),
    fixture.adminDb.collection('transactions').where('toAccountId', '==', id).get()
  ]))
  const byId = new Map(touching.flatMap(snapshot => snapshot.docs.map(snap => [snap.id, snap.data()])))
  return [...byId.entries()].map(([id, data]) => ({ id, ...data }))
}

async function storedTransaction(id) {
  const snap = await fixture.adminDb.collection('transactions').doc(id).get()
  return snap.exists ? { id: snap.id, ...snap.data() } : undefined
}

function addSharedExpense(ids, amount = 300, extra = {}) {
  return fixture.transactionsStore.addTransaction({
    accountId: ids.bridge, amount, description: 'Mercado', categoryId: 'food', date, type: 'expense', ...extra
  })
}

test('the app refuses income, loans and transfers on or to a bridge, leaving balances and history untouched', async () => {
  const { ids } = await seedBridge({ debt: 300 })
  const before = await balances(ids)
  const base = { amount: 100, description: 'Not a shared expense', categoryId: '', date }
  for (const movement of [
    { ...base, accountId: ids.bridge, type: 'income', categoryId: 'salary' },
    { ...base, accountId: ids.bridge, type: 'loan' },
    { ...base, accountId: ids.bridge, type: 'loan_payment' },
    { ...base, accountId: ids.bridge, type: 'transfer', toAccountId: ids.bank },
    { ...base, accountId: ids.bank, type: 'transfer', toAccountId: ids.bridge }
  ]) {
    await assert.rejects(
      fixture.transactionsStore.addTransaction(movement),
      /cuenta puente solo admite gastos compartidos/,
      `${movement.type} from ${movement.accountId}`
    )
  }
  assert.deepEqual(await balances(ids), before)
  assert.deepEqual(await transactionsTouching(ids), [])
})

test('Firestore rules refuse unmirrored movements written straight onto, to or into a bridge', async () => {
  const { ids } = await seedBridge({ debt: 300 })
  const { db, identity, workspaceId } = fixture
  const plain = data => ({
    workspaceId, userId: identity.user.uid, amount: 100, description: 'Direct write', categoryId: '',
    date, type: 'income', toAccountId: null, receiptUrl: null, notes: null, installments: 1,
    currency: 'COP', createdAt: new Date(), ...data
  })
  const write = (suffix, data) => setDoc(doc(db, 'transactions', `${ids.bridge}-${suffix}`), plain(data))

  await assert.rejects(write('income', { accountId: ids.bridge, categoryId: 'salary' }), denied)
  await assert.rejects(write('expense', { accountId: ids.bridge, type: 'expense', amount: -100, categoryId: 'food' }), denied)
  await assert.rejects(write('to-bridge', { accountId: ids.bank, type: 'transfer', toAccountId: ids.bridge }), denied)
  await assert.rejects(write('fake-twin', {
    accountId: ids.bridge, type: 'expense', amount: -100, categoryId: 'food', mirrorOf: `${ids.bridge}-missing`
  }), denied)

  // A plain movement elsewhere still saves and edits, but cannot be moved onto the bridge.
  const movedRef = doc(db, 'transactions', `${ids.bridge}-moved`)
  await setDoc(movedRef, plain({ accountId: ids.bank, categoryId: 'salary' }))
  await assert.rejects(updateDoc(movedRef, { accountId: ids.bridge }), denied)
  await assert.rejects(updateDoc(movedRef, { type: 'transfer', categoryId: '', toAccountId: ids.bridge }), denied)
  await assert.rejects(updateDoc(movedRef, { mirrorOf: `${ids.bridge}-missing` }), denied)
  await updateDoc(movedRef, { description: 'Edited elsewhere' })
  assert.equal((await storedTransaction(`${ids.bridge}-moved`)).description, 'Edited elsewhere')
})

test('shared expenses, settlements and their reversals still reach the bridge through the app', async () => {
  const { ids } = await seedBridge()
  const store = fixture.transactionsStore

  const expense = await addSharedExpense(ids)
  assert.deepEqual(await balances(ids), { bank: 1_000, bridge: -300, source: -300, receivable: 300, to: 500 })
  assert.equal((await storedTransaction(expense.mirrorOf)).mirrorOf, expense.id)

  await store.settleMirror({ bridgeAccountId: ids.bridge, amount: 100, fromAccountId: ids.bank, toAccountId: ids.to, date })
  assert.deepEqual(await balances(ids), { bank: 900, bridge: -200, source: -300, receivable: 200, to: 600 })

  const settlement = (await transactionsTouching(ids))
    .find(tx => tx.settlementType === 'settlement' && tx.toAccountId === ids.bridge)
  await store.reverseSettlement(settlement.id)
  assert.deepEqual(await balances(ids), { bank: 1_000, bridge: -300, source: -300, receivable: 300, to: 500 })
})
