// Accounting integrity integration tests against real stores and Firestore rules (emulators).
// Run through `node tests/pockets.imports.emulators.mjs`, which starts the emulators.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { after, before } from 'node:test'
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore'
import { canTransferBetweenAccounts } from '../src/lib/pockets.ts'
import { createPocketFixture } from './pockets.fixtures.mjs'

const requireFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { Timestamp: AdminTimestamp } = requireFunctions('firebase-admin/firestore')

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

test('S3: deleting a reversed settlement or reversal entry is blocked on client, server (pocket), and Firestore rules', async () => {
  const { adminDb, db, identity, workspaceId, accountsStore, transactionsStore, authStore } = fixture
  authStore.activeWorkspaceId = workspaceId
  const userId = identity.user.uid

  const runScenario = async (withPocket) => {
    const key = `s3-${withPocket ? 'pocket' : 'plain'}-${Date.now()}-${++sequence}`
    const mirrorWorkspaceId = `${key}-mirror`
    await adminDb.collection('workspaces').doc(mirrorWorkspaceId).set({
      id: mirrorWorkspaceId, name: 'Personal', ownerId: userId, members: [userId], currency: 'COP'
    })
    const ids = {
      from: `${key}-from`,
      fromPocket: withPocket ? `${key}-from-pocket` : null,
      bridge: `${key}-bridge`,
      source: `${key}-source`,
      receivable: `${key}-receivable`,
      to: `${key}-to`
    }
    const seed = (id, data) => adminDb.collection('accounts').doc(id).set({
      userId, limit: 0, currency: 'COP', statementClosingDay: null, paymentDueDay: null, createdAt: new Date(), ...data
    })
    await seed(ids.from, {
      workspaceId, name: 'From', type: 'savings', balance: 1_000,
      ...(withPocket ? { childAccountIds: [ids.fromPocket] } : {})
    })
    if (withPocket) {
      await seed(ids.fromPocket, {
        workspaceId, name: 'Pocket', type: 'savings', balance: 200,
        parentAccountId: ids.from, pocketActivity: true, openingAllocationId: null
      })
    }
    await seed(ids.bridge, {
      workspaceId, name: 'Bridge', type: 'checking', balance: -300,
      mirror: { workspaceId: mirrorWorkspaceId, accountId: ids.receivable, sourceAccountId: ids.source }
    })
    await seed(ids.source, { workspaceId: mirrorWorkspaceId, name: 'Card', type: 'credit', balance: -300 })
    await seed(ids.receivable, { workspaceId: mirrorWorkspaceId, name: 'Receivable', type: 'checking', balance: 300 })
    await seed(ids.to, { workspaceId: mirrorWorkspaceId, name: 'Personal Bank', type: 'savings', balance: 500 })

    await accountsStore.fetchAccounts()
    await transactionsStore.settleMirror({
      bridgeAccountId: ids.bridge, amount: 150, fromAccountId: ids.from, toAccountId: ids.to, date
    })
    await transactionsStore.fetchTransactions()
    const settlementLeg = transactionsStore.transactions.find(
      tx => tx.accountId === ids.from && tx.toAccountId === ids.bridge && tx.type === 'transfer'
    )
    assert.ok(settlementLeg, 'settlement leg should exist')

    await transactionsStore.reverseSettlement(settlementLeg.id)
    await transactionsStore.fetchTransactions()
    const reversedLeg = transactionsStore.transactions.find(tx => tx.id === settlementLeg.id)
    assert.ok(reversedLeg?.reversedBy, 'settlement must be marked reversedBy')
    const reversalId = reversedLeg.reversedBy

    const beforeBalances = {
      from: await storedBalance(ids.from),
      bridge: await storedBalance(ids.bridge),
      receivable: await storedBalance(ids.receivable),
      to: await storedBalance(ids.to)
    }
    assert.deepEqual(beforeBalances, { from: 1_000, bridge: -300, receivable: 300, to: 500 })

    // Deleting the already-reversed settlement must fail in store AND direct rules;
    // clearing reversedBy/reversedAt via updateDoc must also fail (no 2-step bypass).
    await assert.rejects(transactionsStore.deleteTransaction(settlementLeg.id), /revertida/i)
    await assert.rejects(deleteDoc(doc(db, 'transactions', settlementLeg.id)), denied)
    await assert.rejects(
      updateDoc(doc(db, 'transactions', settlementLeg.id), { reversedBy: null, reversedAt: null }),
      denied
    )

    // Deleting the reversal leg must fail in store AND direct rules
    await assert.rejects(transactionsStore.deleteTransaction(reversalId), /reversión/i)
    await assert.rejects(deleteDoc(doc(db, 'transactions', reversalId)), denied)

    // All 4 balances and both docs must remain completely untouched
    assert.deepEqual({
      from: await storedBalance(ids.from),
      bridge: await storedBalance(ids.bridge),
      receivable: await storedBalance(ids.receivable),
      to: await storedBalance(ids.to)
    }, beforeBalances)
    assert.equal((await adminDb.collection('transactions').doc(settlementLeg.id).get()).exists, true)
    assert.equal((await adminDb.collection('transactions').doc(reversalId).get()).exists, true)
  }

  await runScenario(false)
  await runScenario(true)
})

test('S3: setAccountMirror enforces zero balance, distinct workspaces, matching currency, and preserves no-op edits', async () => {
  const { adminDb, db, identity, workspaceId, accountsStore } = fixture
  const userId = identity.user.uid
  const otherWs = `s3-mirror-ws-${Date.now()}-${++sequence}`
  await adminDb.collection('workspaces').doc(otherWs).set({
    id: otherWs, name: 'Otro WS', ownerId: userId, members: [userId], currency: 'COP'
  })

  const nonZero = await seedAccount({ name: 'Con saldo', balance: 500, currency: 'COP' })
  const clean = await seedAccount({ name: 'Puente limpio', balance: 0, currency: 'COP' })
  const localOther = await seedAccount({ name: 'Local otro', balance: 0, currency: 'COP' })
  const remoteSource = await seedAccount({ workspaceId: otherWs, name: 'Tarjeta remota', type: 'credit', balance: 0, currency: 'COP' })
  const remoteRec = await seedAccount({ workspaceId: otherWs, name: 'Por cobrar COP', balance: 0, currency: 'COP' })
  const remoteUsd = await seedAccount({ workspaceId: otherWs, name: 'Por cobrar USD', balance: 0, currency: 'USD' })
  await accountsStore.fetchAccounts()

  const validMirror = { workspaceId: otherWs, sourceAccountId: remoteSource.id, accountId: remoteRec.id }

  // Cannot enable mirror on non-zero balance (store & rules), nor create non-zero mirrored account directly
  await assert.rejects(accountsStore.setAccountMirror(nonZero.id, validMirror), /saldo distinto de cero/i)
  await assert.rejects(updateDoc(doc(db, 'accounts', nonZero.id), { mirror: validMirror }), denied)
  await assert.rejects(
    setDoc(doc(db, 'accounts', `direct-nonzero-mirror-${++sequence}`), {
      workspaceId, userId, name: 'Bad bridge', type: 'checking', balance: 100, limit: 0, currency: 'COP',
      mirror: validMirror, createdAt: new Date()
    }),
    denied
  )
  // Cannot bypass mirror target validation via direct Firestore updateDoc on a zero-balance account
  await assert.rejects(
    updateDoc(doc(db, 'accounts', clean.id), {
      mirror: { workspaceId: otherWs, sourceAccountId: remoteSource.id, accountId: remoteUsd.id }
    }),
    denied
  )
  await assert.rejects(
    updateDoc(doc(db, 'accounts', clean.id), {
      mirror: { workspaceId, sourceAccountId: nonZero.id, accountId: localOther.id }
    }),
    denied
  )

  // Cannot mirror to same workspace or mismatched currency
  await assert.rejects(
    accountsStore.setAccountMirror(clean.id, { workspaceId, sourceAccountId: nonZero.id, accountId: localOther.id }),
    /otro workspace/i
  )
  await assert.rejects(
    accountsStore.setAccountMirror(clean.id, { workspaceId: otherWs, sourceAccountId: remoteSource.id, accountId: remoteUsd.id }),
    /misma moneda/i
  )

  // Can enable mirror on clean zero-balance account with valid same-currency remote targets
  await accountsStore.setAccountMirror(clean.id, validMirror)
  assert.deepEqual((await adminDb.collection('accounts').doc(clean.id).get()).data().mirror, validMirror)

  // Give the bridge debt (-200): no-op setAccountMirror (name edit flow) succeeds, re-pointing fails
  await adminDb.collection('accounts').doc(clean.id).update({ balance: -200 })
  await accountsStore.fetchAccounts()
  await accountsStore.setAccountMirror(clean.id, validMirror)
  await assert.rejects(
    accountsStore.setAccountMirror(clean.id, { workspaceId: otherWs, sourceAccountId: remoteRec.id, accountId: remoteSource.id }),
    /saldo distinto de cero/i
  )
  await assert.rejects(accountsStore.setAccountMirror(clean.id, null), /saldo distinto de cero/i)
})

test('S4: ordinary transaction updates are atomic, concurrent/stale deletes do not double-reverse, and balances round cleanly', async () => {
  const { adminDb, identity, workspaceId, accountsStore, transactionsStore } = fixture
  const userId = identity.user.uid
  const accA = await seedAccount({ name: 'Atomic A', balance: 1_000, currency: 'COP' })
  const linkedAcc = await seedAccount({ name: 'Atomic Linked', balance: 500, currency: 'COP' })
  const budgetId = `s4-budget-${Date.now()}-${++sequence}`
  await adminDb.collection('budgets').doc(budgetId).set({
    workspaceId, kind: 'monthly', name: 'S4 Linked', capCurrency: 'COP',
    archived: false, linkedAccountIds: [linkedAcc.id], createdAt: new Date(), updatedAt: new Date()
  })
  await adminDb.collection('accounts').doc(linkedAcc.id).update({ linkedBudgetId: budgetId })
  await accountsStore.fetchAccounts()

  // 1. Failed updateTransaction (Firestore rule rejects moving into linked account without its budget)
  // MUST leave all balances completely unchanged (no pre-write balance corruption).
  const tx = await transactionsStore.addTransaction({
    accountId: accA.id, amount: -100, description: 'Compra inicial', categoryId: 'food', date, type: 'expense'
  })
  assert.equal(await storedBalance(accA.id), 900)

  await assert.rejects(
    transactionsStore.updateTransaction(tx.id, {
      accountId: linkedAcc.id, amount: -250, description: 'Movida sin presupuesto',
      categoryId: 'food', date, type: 'expense', receiptUrl: null
    }),
    denied
  )
  assert.equal(await storedBalance(accA.id), 900)
  assert.equal(await storedBalance(linkedAcc.id), 500)

  // 2. Stale-cache delete reverses the STORED amount, and deleting an already-deleted tx is a no-op
  await adminDb.collection('transactions').doc(tx.id).update({ amount: -300 })
  await adminDb.collection('accounts').doc(accA.id).update({ balance: 700 })
  // Pinia still caches amount -100; deleteTransaction must reverse stored -300 -> 1000.
  await transactionsStore.deleteTransaction(tx.id)
  assert.equal(await storedBalance(accA.id), 1_000)

  // Re-insert stale copy in Pinia and delete again (already gone in Firestore -> must NOT double-reverse)
  transactionsStore.transactions.push({ ...tx, amount: -300 })
  await transactionsStore.deleteTransaction(tx.id)
  assert.equal(await storedBalance(accA.id), 1_000)

  // 3. Fractional cent arithmetic produces exact 0 without IEEE-754 float drift
  const floatAcc = await seedAccount({ name: 'Float USD', balance: 0.3, currency: 'USD' })
  await accountsStore.fetchAccounts()
  await transactionsStore.addTransaction({
    accountId: floatAcc.id, amount: -0.1, description: 'Fee 1', categoryId: 'food', date, type: 'expense'
  })
  await transactionsStore.addTransaction({
    accountId: floatAcc.id, amount: -0.2, description: 'Fee 2', categoryId: 'food', date, type: 'expense'
  })
  assert.equal(await storedBalance(floatAcc.id), 0)
  assert.equal(accountsStore.getAccountById(floatAcc.id)?.balance, 0)
  void userId
})

test('S5: server-created pocket movements (nanosecond createdAt) stay editable and deleting an empty pocket updates parent cache', async () => {
  const { adminDb, identity, workspaceId, accountsStore, transactionsStore } = fixture
  const userId = identity.user.uid
  const parent = await seedAccount({ name: 'Parent S5', type: 'savings', balance: 500, currency: 'COP' })
  const otherBank = await seedAccount({ name: 'Other S5', type: 'checking', balance: 200, currency: 'COP' })
  await accountsStore.fetchAccounts()

  // Empty pocket delete must remove pocket ID from parent.childAccountIds in Pinia immediately
  const emptyPocket = await accountsStore.addPocket({
    name: 'Empty S5', balance: 0, currency: 'COP', parentAccountId: parent.id
  })
  assert.ok(accountsStore.getAccountById(parent.id)?.childAccountIds?.includes(emptyPocket.id))
  await accountsStore.deleteAccount(emptyPocket.id)
  assert.equal(accountsStore.getAccountById(emptyPocket.id), undefined)
  assert.equal(accountsStore.getAccountById(parent.id)?.childAccountIds?.includes(emptyPocket.id), false)
  assert.equal(
    canTransferBetweenAccounts(
      accountsStore.getAccountById(parent.id),
      accountsStore.getAccountById(otherBank.id),
      accountsStore.accounts
    ),
    true
  )

  // Pocket transaction created with microsecond precision Timestamp (Firestore stores µs; JS Date truncates to ms)
  const fundedPocket = await accountsStore.addPocket({
    name: 'Funded S5', balance: 200, currency: 'COP', parentAccountId: parent.id
  })
  const nanoTxId = `s5-nano-tx-${Date.now()}-${++sequence}`
  const nanoCreatedAt = new AdminTimestamp(1_760_000_000, 123_456_000)
  await adminDb.collection('transactions').doc(nanoTxId).set({
    workspaceId, userId, accountId: fundedPocket.id, amount: -50,
    description: 'Server imported pocket expense', categoryId: 'food',
    date: AdminTimestamp.fromDate(date), type: 'expense', toAccountId: null,
    receiptUrl: null, notes: null, installments: 1, currency: 'COP',
    createdAt: nanoCreatedAt
  })
  await adminDb.collection('accounts').doc(fundedPocket.id).update({ balance: 150 })
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchTransactions()

  // Client edit must preserve original sub-millisecond createdAt instead of failing permission-denied
  await transactionsStore.updateTransaction(nanoTxId, {
    accountId: fundedPocket.id, amount: -75, description: 'Edited pocket expense',
    categoryId: 'food', date, type: 'expense', receiptUrl: null, notes: 'Fixed'
  })
  const afterSnap = await adminDb.collection('transactions').doc(nanoTxId).get()
  assert.equal(afterSnap.data().amount, -75)
  assert.equal(afterSnap.data().description, 'Edited pocket expense')
  assert.equal(afterSnap.data().createdAt.nanoseconds, 123_456_000)
  assert.equal(await storedBalance(fundedPocket.id), 125)

  // Client-SDK 2-decimal pocket arithmetic (0.3 - 0.1 - 0.2 === 0) must pass rules and avoid float drift
  const usdParent = await seedAccount({ name: 'USD Parent S5', type: 'savings', balance: 1, currency: 'USD' })
  await accountsStore.fetchAccounts()
  const usdPocket = await accountsStore.addPocket({
    name: 'USD Float Pocket', balance: 0.3, currency: 'USD', parentAccountId: usdParent.id
  })
  await transactionsStore.addTransaction({
    accountId: usdPocket.id, amount: -0.1, description: 'Pocket fee 1', categoryId: 'food', date, type: 'expense'
  })
  await transactionsStore.addTransaction({
    accountId: usdPocket.id, amount: -0.2, description: 'Pocket fee 2', categoryId: 'food', date, type: 'expense'
  })
  assert.equal(await storedBalance(usdPocket.id), 0)
  assert.equal(accountsStore.getAccountById(usdPocket.id)?.balance, 0)
})

test('S12: Firestore allows virtual and compatible linked goals, but rejects invalid linked-account shapes on create and update', async () => {
  const { adminDb, db, identity, workspaceId, accountsStore, transactionsStore, goalsStore } = fixture
  const sameCurrency = await seedAccount({ name: 'Goal checking', currency: 'COP', balance: 100 })
  const source = await seedAccount({ name: 'Goal source', currency: 'COP', balance: 200 })
  const credit = await seedAccount({ name: 'Goal card', type: 'credit', currency: 'COP', balance: -100 })
  const bridge = await seedAccount({
    name: 'Goal bridge', currency: 'COP', balance: 0,
    mirror: { workspaceId: 'other-workspace', accountId: 'receivable', sourceAccountId: 'source' }
  })
  const wrongCurrency = await seedAccount({ name: 'Goal USD', currency: 'USD', balance: 100 })
  const nonFinite = await seedAccount({ name: 'Goal invalid balance', balance: Number.NaN })
  const foreign = await seedAccount({ name: 'Foreign goal account', workspaceId: 'other-workspace', currency: 'COP', balance: 100 })
  const parent = await seedAccount({ name: 'Goal pocket parent', type: 'checking', currency: 'COP', balance: 100, childAccountIds: [] })
  const pocketId = `goal-pocket-${Date.now()}-${++sequence}`
  await adminDb.collection('accounts').doc(parent.id).update({ childAccountIds: [pocketId] })
  await adminDb.collection('accounts').doc(pocketId).set({
    workspaceId, userId: identity.user.uid, name: 'Goal pocket', type: 'savings', balance: 0,
    limit: 0, currency: 'COP', parentAccountId: parent.id, childAccountIds: [], createdAt: new Date()
  })

  const goalData = {
    workspaceId, userId: identity.user.uid, name: 'Goal', targetAmount: 1_000,
    currentAmount: 0, currency: 'COP', targetDate: date, createdAt: new Date()
  }
  const validRootGoalId = `s12-root-goal-${++sequence}`
  await setDoc(doc(db, 'goals', validRootGoalId), { ...goalData, linkedAccountId: sameCurrency.id })
  assert.equal((await adminDb.collection('goals').doc(validRootGoalId).get()).data().linkedAccountId, sameCurrency.id)

  await accountsStore.fetchAccounts()
  const contribution = await transactionsStore.addTransaction({
    accountId: source.id, toAccountId: sameCurrency.id, amount: 25,
    description: 'Aporte a meta: Goal', categoryId: '', date, type: 'transfer'
  })
  const storedContribution = (await adminDb.collection('transactions').doc(contribution.id).get()).data()
  assert.equal(storedContribution.type, 'transfer')
  assert.equal(storedContribution.accountId, source.id)
  assert.equal(storedContribution.toAccountId, sameCurrency.id)
  assert.equal(await storedBalance(source.id), 175)
  assert.equal(await storedBalance(sameCurrency.id), 125)
  assert.equal((await adminDb.collection('goals').doc(validRootGoalId).get()).data().currentAmount, 0)

  const validPocketGoalId = `s12-pocket-goal-${++sequence}`
  await setDoc(doc(db, 'goals', validPocketGoalId), { ...goalData, linkedAccountId: pocketId })
  assert.equal((await adminDb.collection('goals').doc(validPocketGoalId).get()).data().linkedAccountId, pocketId)

  const virtualGoalId = `s12-virtual-goal-${++sequence}`
  await setDoc(doc(db, 'goals', virtualGoalId), goalData)
  assert.equal((await adminDb.collection('goals').doc(virtualGoalId).get()).data().currentAmount, 0)
  const transactionCount = (await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size
  await goalsStore.contributeToGoal(virtualGoalId, 25)
  assert.equal((await adminDb.collection('goals').doc(virtualGoalId).get()).data().currentAmount, 25)
  assert.equal((await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size, transactionCount)
  assert.equal(await storedBalance(source.id), 175)

  for (const [label, linkedAccountId] of [
    ['missing', `s12-missing-${sequence}`],
    ['foreign workspace', foreign.id],
    ['wrong currency', wrongCurrency.id],
    ['invalid balance', nonFinite.id],
    ['credit card', credit.id],
    ['bridge', bridge.id]
  ]) {
    const invalidGoalId = `s12-invalid-${label.replaceAll(' ', '-')}-${++sequence}`
    await assert.rejects(setDoc(doc(db, 'goals', invalidGoalId), { ...goalData, linkedAccountId }), denied, label)
    assert.equal((await adminDb.collection('goals').doc(invalidGoalId).get()).exists, false, `${label} link must not persist`)
  }

  await assert.rejects(
    updateDoc(doc(db, 'goals', validRootGoalId), { linkedAccountId: credit.id }),
    denied
  )
  assert.equal((await adminDb.collection('goals').doc(validRootGoalId).get()).data().linkedAccountId, sameCurrency.id)
})
