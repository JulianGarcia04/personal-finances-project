import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { httpsCallable } from 'firebase/functions'
import { createPocketFixture, functionsRequire } from './pockets.fixtures.mjs'

let fixture
let sequence = 0

before(async () => {
  fixture = await createPocketFixture()
})

after(async () => {
  await fixture?.close()
})

const settlementDate = new Date('2026-10-21T12:00:00')

/**
 * Seeds a bridge in the fixture workspace that owes `debt` to a mirror workspace,
 * optionally giving the paying (`from`) or receiving (`to`) account a pocket.
 */
async function seedBridge({ fromPocket = 0, toPocket = 0, fromBalance = 1_000, toBalance = 500, debt = 300 } = {}) {
  const { adminDb, identity, workspaceId, accountsStore } = fixture
  const userId = identity.user.uid
  const key = `settle-${Date.now()}-${++sequence}`
  const mirrorWorkspaceId = `${key}-mirror`
  const ids = {
    from: `${key}-from`,
    fromPocket: `${key}-from-pocket`,
    bridge: `${key}-bridge`,
    source: `${key}-source`,
    receivable: `${key}-receivable`,
    to: `${key}-to`,
    toPocket: `${key}-to-pocket`
  }
  await adminDb.collection('workspaces').doc(mirrorWorkspaceId).set({
    id: mirrorWorkspaceId, name: 'Mirror workspace', ownerId: userId, members: [userId], currency: 'COP'
  })
  const account = (id, data) => adminDb.collection('accounts').doc(id).set({
    userId, limit: 0, currency: 'COP', statementClosingDay: null, paymentDueDay: null, createdAt: new Date(), ...data
  })
  const pocket = (id, parentAccountId, wsId, balance) => account(id, {
    workspaceId: wsId, name: 'Pocket', type: 'savings', balance, parentAccountId,
    childAccountIds: [], pocketActivity: true, openingAllocationId: null
  })
  await account(ids.from, {
    workspaceId, name: 'Paying bank', type: 'savings', balance: fromBalance,
    ...(fromPocket ? { childAccountIds: [ids.fromPocket] } : {})
  })
  if (fromPocket) await pocket(ids.fromPocket, ids.from, workspaceId, fromPocket)
  await account(ids.bridge, {
    workspaceId, name: 'Bridge', type: 'checking', balance: -debt,
    mirror: { workspaceId: mirrorWorkspaceId, accountId: ids.receivable, sourceAccountId: ids.source }
  })
  await account(ids.source, { workspaceId: mirrorWorkspaceId, name: 'Card', type: 'credit', balance: -debt })
  await account(ids.receivable, { workspaceId: mirrorWorkspaceId, name: 'Receivable', type: 'checking', balance: debt })
  await account(ids.to, {
    workspaceId: mirrorWorkspaceId, name: 'Receiving bank', type: 'savings', balance: toBalance,
    ...(toPocket ? { childAccountIds: [ids.toPocket] } : {})
  })
  if (toPocket) await pocket(ids.toPocket, ids.to, mirrorWorkspaceId, toPocket)
  await accountsStore.fetchAccounts()
  return { ids, mirrorWorkspaceId }
}

async function balances(ids) {
  const entries = await Promise.all(Object.entries(ids).map(async ([name, id]) => {
    const snap = await fixture.adminDb.collection('accounts').doc(id).get()
    return [name, snap.exists ? snap.data().balance : undefined]
  }))
  return Object.fromEntries(entries)
}

async function accountData(id) {
  return (await fixture.adminDb.collection('accounts').doc(id).get()).data()
}

/** Returns the settlement leg recorded in the bridge workspace and its mirror twin. */
async function settlementLegs(ids) {
  const local = await fixture.adminDb.collection('transactions')
    .where('toAccountId', '==', ids.bridge).where('settlementType', '==', 'settlement').get()
  assert.equal(local.size, 1)
  const twin = await fixture.adminDb.collection('transactions').doc(local.docs[0].data().mirrorOf).get()
  return { local: { id: local.docs[0].id, ...local.docs[0].data() }, twin: { id: twin.id, ...twin.data() } }
}

async function transactionCount(ids) {
  const touching = await Promise.all(Object.values(ids).flatMap(id => [
    fixture.adminDb.collection('transactions').where('accountId', '==', id).get(),
    fixture.adminDb.collection('transactions').where('toAccountId', '==', id).get()
  ]))
  return new Set(touching.flatMap(snapshot => snapshot.docs.map(doc => doc.id))).size
}

function settle(ids, amount) {
  return fixture.transactionsStore.settleMirror({
    bridgeAccountId: ids.bridge, amount, fromAccountId: ids.from, toAccountId: ids.to, date: settlementDate
  })
}

test('settles a bridge into a receiving account that has pockets', async () => {
  const { ids, mirrorWorkspaceId } = await seedBridge({ toPocket: 200 })

  await settle(ids, 120)

  assert.deepEqual(await balances(ids), {
    from: 880, fromPocket: undefined, bridge: -180, source: -300, receivable: 180, to: 620, toPocket: 200
  })
  const { local, twin } = await settlementLegs(ids)
  assert.equal(local.workspaceId, fixture.workspaceId)
  assert.equal(local.accountId, ids.from)
  assert.equal(local.amount, 120)
  assert.equal(local.categoryId, '')
  assert.equal(local.type, 'transfer')
  assert.equal(local.description, 'Liquidación de Bridge')
  assert.equal(local.notes, 'Reembolso pagado desde Paying bank')
  assert.equal(local.date.toDate().getTime(), settlementDate.getTime())
  assert.equal(twin.workspaceId, mirrorWorkspaceId)
  assert.equal(twin.accountId, ids.receivable)
  assert.equal(twin.toAccountId, ids.to)
  assert.equal(twin.settlementType, 'settlement')
  assert.equal(twin.notes, 'Reembolso recibido en Receiving bank')
  assert.equal(twin.mirrorOf, local.id)
  const to = await accountData(ids.to)
  assert.equal(to.lastPocketMovementId, twin.id)
  assert.equal(to.lastPocketMovementType, 'created')
  assert.equal(fixture.accountsStore.getAccountById(ids.bridge)?.balance, -180)
})

test('settles a bridge paid from an account that has pockets', async () => {
  const { ids } = await seedBridge({ fromPocket: 400 })

  await settle(ids, 300)

  assert.deepEqual(await balances(ids), {
    from: 700, fromPocket: 400, bridge: 0, source: -300, receivable: 0, to: 800, toPocket: undefined
  })
  const { local } = await settlementLegs(ids)
  const from = await accountData(ids.from)
  assert.equal(from.lastPocketMovementId, local.id)
  assert.equal(from.lastPocketMovementType, 'created')
})

test('refuses a settlement that would leave the available balance of an account with pockets negative', async () => {
  const { ids } = await seedBridge({ fromPocket: 400, fromBalance: 100 })
  const before = await balances(ids)

  await assert.rejects(settle(ids, 300), /no puede ser negativo/)

  assert.deepEqual(await balances(ids), before)
  assert.equal(await transactionCount(ids), 0)
})

test('a pocket itself cannot pay or receive a settlement', async () => {
  const { ids } = await seedBridge({ fromPocket: 400, toPocket: 200 })
  const before = await balances(ids)

  await assert.rejects(fixture.transactionsStore.settleMirror({
    bridgeAccountId: ids.bridge, amount: 100, fromAccountId: ids.from, toAccountId: ids.toPocket, date: settlementDate
  }), /bolsillo/)
  await assert.rejects(fixture.transactionsStore.settleMirror({
    bridgeAccountId: ids.bridge, amount: 100, fromAccountId: ids.fromPocket, toAccountId: ids.to, date: settlementDate
  }), /bolsillo/)

  assert.deepEqual(await balances(ids), before)
  assert.equal(await transactionCount(ids), 0)
})

test('refuses a bridge mirrored to its own workspace when an account has pockets', async () => {
  const { ids } = await seedBridge({ fromPocket: 100 })
  await fixture.adminDb.collection('accounts').doc(ids.receivable).update({ workspaceId: fixture.workspaceId })
  await fixture.adminDb.collection('accounts').doc(ids.bridge).update({ 'mirror.workspaceId': fixture.workspaceId })
  await fixture.accountsStore.fetchAccounts()
  const before = await balances(ids)

  await assert.rejects(fixture.transactionsStore.settleMirror({
    bridgeAccountId: ids.bridge, amount: 100, fromAccountId: ids.from, toAccountId: ids.from, date: settlementDate
  }), /otro workspace/)

  assert.deepEqual(await balances(ids), before)
  assert.equal(await transactionCount(ids), 0)
})

test('reverses a settlement that touched an account with pockets', async () => {
  const { ids } = await seedBridge({ toPocket: 200 })
  await settle(ids, 120)
  const { local, twin } = await settlementLegs(ids)
  const leg = fixture.transactionsStore.transactions.find(tx => tx.id === local.id)
  assert.ok(leg)
  assert.equal(await fixture.transactionsStore.canReverseSettlement(leg), true)

  await fixture.transactionsStore.reverseSettlement(local.id)

  assert.deepEqual(await balances(ids), {
    from: 1_000, fromPocket: undefined, bridge: -300, source: -300, receivable: 300, to: 500, toPocket: 200
  })
  const paidAfter = (await fixture.adminDb.collection('transactions').doc(local.id).get()).data()
  const receivedAfter = (await fixture.adminDb.collection('transactions').doc(twin.id).get()).data()
  const paidReversal = (await fixture.adminDb.collection('transactions').doc(paidAfter.reversedBy).get()).data()
  const receivedReversal = (await fixture.adminDb.collection('transactions').doc(receivedAfter.reversedBy).get()).data()
  assert.equal(paidReversal.settlementType, 'reversal')
  assert.equal(paidReversal.reversalOf, local.id)
  assert.equal(paidReversal.accountId, ids.bridge)
  assert.equal(paidReversal.toAccountId, ids.from)
  assert.equal(receivedReversal.reversalOf, twin.id)
  assert.equal(receivedReversal.accountId, ids.to)
  assert.equal(receivedReversal.toAccountId, ids.receivable)
  assert.equal(receivedReversal.mirrorOf, paidAfter.reversedBy)
  assert.equal((await accountData(ids.to)).lastPocketMovementId, receivedAfter.reversedBy)
  assert.equal(fixture.transactionsStore.reversibleSettlementIds.includes(local.id), false)
})

test('refuses to reverse a settlement whose money already moved into a pocket', async () => {
  const { ids } = await seedBridge({ toPocket: 200 })
  await settle(ids, 120)
  const { local } = await settlementLegs(ids)
  // The receiving bank moved almost everything into its pocket after the settlement.
  await fixture.adminDb.collection('accounts').doc(ids.to).update({ balance: 20 })
  await fixture.adminDb.collection('accounts').doc(ids.toPocket).update({ balance: 800 })
  const before = await balances(ids)
  const transactionsBefore = await transactionCount(ids)

  await assert.rejects(fixture.transactionsStore.reverseSettlement(local.id), /no puede ser negativo/)

  assert.deepEqual(await balances(ids), before)
  assert.equal(await transactionCount(ids), transactionsBefore)
  assert.equal((await fixture.adminDb.collection('transactions').doc(local.id).get()).data().reversedBy, undefined)
})

test('deletes a settlement pair that touched an account with pockets', async () => {
  const { ids } = await seedBridge({ fromPocket: 400, toPocket: 200 })
  await settle(ids, 300)
  const { local, twin } = await settlementLegs(ids)

  await fixture.transactionsStore.deleteTransaction(local.id)

  assert.deepEqual(await balances(ids), {
    from: 1_000, fromPocket: 400, bridge: -300, source: -300, receivable: 300, to: 500, toPocket: 200
  })
  assert.equal((await fixture.adminDb.collection('transactions').doc(local.id).get()).exists, false)
  assert.equal((await fixture.adminDb.collection('transactions').doc(twin.id).get()).exists, false)
  assert.equal(fixture.transactionsStore.transactions.some(tx => tx.id === local.id), false)
  assert.equal((await accountData(ids.from)).lastPocketMovementType, 'deleted')
})

test('settlements without pockets keep working through the existing client path', async () => {
  const { ids } = await seedBridge()

  await settle(ids, 100)

  assert.deepEqual(await balances(ids), {
    from: 900, fromPocket: undefined, bridge: -200, source: -300, receivable: 200, to: 600, toPocket: undefined
  })
  for (const id of [ids.from, ids.bridge, ids.receivable, ids.to]) {
    assert.equal((await accountData(id)).lastPocketMovementId, undefined)
  }
  const { local } = await settlementLegs(ids)
  await fixture.transactionsStore.deleteTransaction(local.id)
  assert.deepEqual(await balances(ids), {
    from: 1_000, fromPocket: undefined, bridge: -300, source: -300, receivable: 300, to: 500, toPocket: undefined
  })
})

test('the settlement callable refuses users outside the workspaces and leaves balances untouched', async () => {
  const { ids } = await seedBridge({ toPocket: 200 })
  const before = await balances(ids)
  const request = {
    action: 'settle', workspaceId: fixture.workspaceId, bridgeAccountId: ids.bridge, receivableAccountId: ids.receivable,
    fromAccountId: ids.from, toAccountId: ids.to, amount: 100, date: settlementDate.getTime(), expectedBridgeBalance: -300
  }

  await assert.rejects(httpsCallable(fixture.outsiderFunctions, 'bridgeSettlement')(request), error =>
    error.code === 'functions/failed-precondition' && /workspace/.test(error.message))
  const { settleBridge } = functionsRequire('./lib/settlements.js')
  await assert.rejects(settleBridge(fixture.adminDb, { ...request, userId: 'not-a-member' }), /workspace/)

  assert.deepEqual(await balances(ids), before)
  assert.equal(await transactionCount(ids), 0)
})
