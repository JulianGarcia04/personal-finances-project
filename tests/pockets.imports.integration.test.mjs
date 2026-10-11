import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { randomUUID } from 'node:crypto'
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

function request(workspaceId, accountId, rows, expectedCurrency = 'COP', statementImportId = randomUUID()) {
  return { workspaceId, accountId, expectedCurrency, statementImportId, rows }
}

function withDeadline(promise, label, timeoutMs = 20_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function transactionCount(adminDb, workspaceId) {
  return (await adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()).size
}

async function readPocketRaceState(adminDb, workspaceId, parentId) {
  const [parent, children, transactions] = await Promise.all([
    adminDb.collection('accounts').doc(parentId).get(),
    adminDb.collection('accounts').where('workspaceId', '==', workspaceId).where('parentAccountId', '==', parentId).get(),
    adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  ])
  const childIds = new Set(children.docs.map(snapshot => snapshot.id))
  const relevant = transactions.docs.filter(snapshot => {
    const data = snapshot.data()
    return data.accountId === parentId || childIds.has(data.toAccountId)
  })
  return {
    parentExists: parent.exists,
    parentBalance: parent.data()?.balance ?? null,
    parentWorkspaceId: parent.data()?.workspaceId ?? null,
    parentUserId: parent.data()?.userId ?? null,
    parentUpdateTime: parent.updateTime?.toDate().toISOString() ?? null,
    registryIds: parent.data()?.childAccountIds ?? [],
    children: children.docs.map(snapshot => ({
      id: snapshot.id,
      balance: snapshot.data().balance,
      workspaceId: snapshot.data().workspaceId,
      userId: snapshot.data().userId
    })),
    allocationCount: relevant.filter(snapshot => snapshot.data().pocketAllocation === true).length,
    importCount: relevant.filter(snapshot => String(snapshot.data().description).startsWith('pocket-before-import ') ||
      String(snapshot.data().description).startsWith('import-before-pocket ')).length
  }
}

function describeOutcome(result) {
  if (result.status === 'fulfilled') {
    const value = result.value
    return {
      status: result.status,
      accountId: value?.id ?? null,
      resultCount: Array.isArray(value) ? value.length : null
    }
  }
  return {
    status: result.status,
    errorName: result.reason?.name ?? null,
    errorCode: result.reason?.code ?? null,
    errorMessage: (result.reason?.message ?? String(result.reason)).slice(0, 180)
  }
}

async function runOrderedPocketImportRace(order) {
  const { accountsStore, adminDb, identity, transactionsStore, transactionBarrier, workspaceId } = fixture
  const parent = await accountsStore.addAccount({
    name: `Concurrent hierarchy import root ${order}`,
    type: 'checking',
    balance: 1_000,
    currency: 'COP'
  })
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const beforeParentSnapshot = await adminDb.collection('accounts').doc(parent.id).get()
  transactionBarrier.reset()
  const barrierKind = order === 'pocket-before-import' ? 'pocket-opening' : 'ordinary-import'
  const hold = transactionBarrier.holdNext(barrierKind)
  const operations = {}
  let harnessError = null
  let barrierHeldEvent = null
  let interleavedReadback = null

  try {
    if (order === 'pocket-before-import') {
      operations.pocket = accountsStore.addAccount({
        name: `Pocket opened during import ${order}`,
        type: 'savings',
        balance: 300,
        currency: 'COP',
        parentAccountId: parent.id
      })
      barrierHeldEvent = await withDeadline(hold.reached, `${order} opening transaction barrier`)
      operations.imported = transactionsStore.addTransactionsBatch(parent.id, [
        { date: '2026-10-10T12:00:00.000Z', description: `${order} income`, amount: 50, categorySuggestion: 'Income' },
        { date: '2026-10-10T13:00:00.000Z', description: `${order} expense`, amount: -20, categorySuggestion: 'Expense' }
      ])
      await withDeadline(Promise.allSettled([operations.imported]), `${order} import commit`)
      interleavedReadback = await readPocketRaceState(adminDb, workspaceId, parent.id)
      hold.release()
    } else {
      operations.imported = transactionsStore.addTransactionsBatch(parent.id, [
        { date: '2026-10-10T12:00:00.000Z', description: `${order} income`, amount: 50, categorySuggestion: 'Income' },
        { date: '2026-10-10T13:00:00.000Z', description: `${order} expense`, amount: -20, categorySuggestion: 'Expense' }
      ])
      barrierHeldEvent = await withDeadline(hold.reached, `${order} import transaction barrier`)
      operations.pocket = accountsStore.addAccount({
        name: `Pocket opened during import ${order}`,
        type: 'savings',
        balance: 300,
        currency: 'COP',
        parentAccountId: parent.id
      })
      await withDeadline(Promise.allSettled([operations.pocket]), `${order} opening commit`)
      interleavedReadback = await readPocketRaceState(adminDb, workspaceId, parent.id)
      hold.release()
    }
  } catch (error) {
    harnessError = { name: error?.name ?? null, message: error?.message ?? String(error) }
  } finally {
    hold.release()
    transactionBarrier.releaseAll()
  }

  const settled = await withDeadline(Promise.allSettled(Object.values(operations)), `${order} operation settlement`)
  const afterCount = await transactionCount(adminDb, workspaceId)
  const [parentSnapshot, childrenSnapshot, transactionSnapshot] = await Promise.all([
    adminDb.collection('accounts').doc(parent.id).get(),
    adminDb.collection('accounts').where('workspaceId', '==', workspaceId).where('parentAccountId', '==', parent.id).get(),
    adminDb.collection('transactions').where('workspaceId', '==', workspaceId).get()
  ])
  const childDocs = childrenSnapshot.docs
  const relevantTransactions = transactionSnapshot.docs.filter(snapshot => {
    const data = snapshot.data()
    return data.accountId === parent.id || data.toAccountId === childDocs[0]?.id
  })
  const importTransactions = relevantTransactions
    .filter(snapshot => String(snapshot.data().description).startsWith(`${order} `))
    .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
  const openingAllocations = relevantTransactions
    .filter(snapshot => snapshot.data().pocketAllocation === true)
    .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
  const parentData = parentSnapshot.data()
  const childData = childDocs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
  const localParent = accountsStore.getAccountById(parent.id)
  const localPocketIds = accountsStore.accounts
    .filter(account => account.parentAccountId === parent.id)
    .map(account => account.id)
  const events = transactionBarrier.events()
  transactionBarrier.reset()

  return {
    order,
    workspaceId,
    userId: identity.user.uid,
    parentId: parent.id,
    beforeTransactionCount: beforeCount,
    afterTransactionCount: afterCount,
    beforeParentUpdateTime: beforeParentSnapshot.updateTime?.toDate().toISOString() ?? null,
    afterParentUpdateTime: parentSnapshot.updateTime?.toDate().toISOString() ?? null,
    parent: parentData,
    children: childData,
    localState: {
      parentBalance: localParent?.balance ?? null,
      childAccountIds: localParent?.childAccountIds ?? [],
      pocketIds: localPocketIds,
      totals: fixture.pockets.getAccountPocketTotals(parent.id, accountsStore.accounts)
    },
    importTransactions,
    openingAllocations,
    outcomes: settled.map(describeOutcome),
    barrierHeldEvent,
    interleavedReadback,
    callbackAttempts: events,
    harnessError
  }
}

function summarizeRaceScenario(scenario) {
  const parentReads = event => event.reads.find(read => read.path === `accounts/${scenario.parentId}`) ?? null
  const summarizeAttempt = event => ({
    invocationId: event.invocationId,
    attempt: event.attempt,
    kind: event.kind,
    outcome: event.outcome,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage?.slice(0, 180) ?? null,
    readParent: parentReads(event),
    readWorkspaceMembers: event.reads.find(read => read.path === `workspaces/${scenario.workspaceId}`)?.members ?? null,
    stagedParentBalance: event.writes.find(write => write.path === `accounts/${scenario.parentId}`)?.balance ?? null,
    callbackResult: event.callbackResult
  })
  const transactions = [...scenario.importTransactions, ...scenario.openingAllocations]

  return {
    order: scenario.order,
    harnessError: scenario.harnessError,
    identity: {
      expectedUserId: scenario.userId,
      parentUserIdMatches: scenario.parent.userId === scenario.userId,
      childUserIdsMatch: scenario.children.every(child => child.userId === scenario.userId),
      transactionUserIdsMatch: transactions.every(transaction => transaction.userId === scenario.userId),
      expectedWorkspaceId: scenario.workspaceId,
      parentWorkspaceMatches: scenario.parent.workspaceId === scenario.workspaceId,
      childWorkspaceIdsMatch: scenario.children.every(child => child.workspaceId === scenario.workspaceId),
      transactionWorkspaceIdsMatch: transactions.every(transaction => transaction.workspaceId === scenario.workspaceId),
      observedMembership: scenario.callbackAttempts.flatMap(event => event.reads)
        .find(read => read.path === `workspaces/${scenario.workspaceId}`)?.members?.includes(scenario.userId) ?? null
    },
    outcomes: scenario.outcomes,
    intermediate: scenario.interleavedReadback,
    durable: {
      transactionCountDelta: scenario.afterTransactionCount - scenario.beforeTransactionCount,
      parentBalance: scenario.parent.balance,
      parentUpdateTime: scenario.afterParentUpdateTime,
      childCount: scenario.children.length,
      registryIds: scenario.parent.childAccountIds ?? [],
      allocationCount: scenario.openingAllocations.length,
      importCount: scenario.importTransactions.length
    },
    localState: scenario.localState,
    heldCallback: scenario.barrierHeldEvent ? summarizeAttempt(scenario.barrierHeldEvent) : null,
    callbackAttempts: scenario.callbackAttempts.map(summarizeAttempt)
  }
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
  await assert.rejects(callable(request(workspaceId, pocket.id, [row(-11)])), error =>
    error.code === 'functions/failed-precondition' && /negativo/.test(error.message))

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

test('callable rejects statements above the row cap without writes', async () => {
  const { accountsStore, adminDb, functions, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Capped import parent', type: 'checking', balance: 100, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Capped import pocket', type: 'savings', balance: 10, currency: 'COP', parentAccountId: parent.id
  })
  const callable = httpsCallable(functions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const rows = Array.from({ length: 1_001 }, (_, index) => row(0.01, `Row ${index}`))

  await assert.rejects(callable(request(workspaceId, pocket.id, rows)), error =>
    error.code === 'functions/invalid-argument' && /1000/.test(error.message))
  await assert.rejects(callable({ ...request(workspaceId, pocket.id, [row(1)]), statementImportId: 'bad id!' }), error =>
    error.code === 'functions/invalid-argument')
  const { statementImportId: _omitted, ...withoutId } = request(workspaceId, pocket.id, [row(1)])
  await assert.rejects(callable(withoutId), error => error.code === 'functions/invalid-argument')
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 10)
})

test('a retried statementImportId replays the first result without writing twice', async () => {
  const { accountsStore, adminDb, functions, workspaceId } = fixture
  const parent = await accountsStore.addAccount({ name: 'Idempotent import parent', type: 'checking', balance: 500, currency: 'COP' })
  const pocket = await accountsStore.addAccount({
    name: 'Idempotent import pocket', type: 'savings', balance: 100, currency: 'COP', parentAccountId: parent.id
  })
  const callable = httpsCallable(functions, 'importPocketStatement')
  const beforeCount = await transactionCount(adminDb, workspaceId)
  const data = request(workspaceId, pocket.id, [row(25, 'Retried deposit'), row(-5, 'Retried fee')])

  const first = await callable(data)
  const second = await callable(data)
  assert.deepEqual(second.data, first.data)
  assert.equal(first.data.balance, 120)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 2)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 120)
  const stored = await adminDb.collection('transactions').where('accountId', '==', pocket.id).get()
  assert.deepEqual(stored.docs.map(snapshot => snapshot.data().statementImportId), [data.statementImportId, data.statementImportId])

  const concurrentData = request(workspaceId, pocket.id, [row(-10, 'Double click')])
  const concurrent = await Promise.all([callable(concurrentData), callable(concurrentData)])
  assert.deepEqual(concurrent[1].data, concurrent[0].data)
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 3)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 110)

  await assert.rejects(callable({ ...data, rows: [row(99, 'Different statement')] }), error =>
    error.code === 'functions/failed-precondition')
  assert.equal(await transactionCount(adminDb, workspaceId), beforeCount + 3)
  assert.equal((await adminDb.collection('accounts').doc(pocket.id).get()).data().balance, 110)
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
  assert.equal(quotaError.code, 'functions/invalid-argument')
  assert.match(quotaError.message, /excede|tamaño/i)
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

test('pocket opening and ordinary import retain both outcomes in either commit order', async () => {
  const scenarios = [
    await runOrderedPocketImportRace('pocket-before-import'),
    await runOrderedPocketImportRace('import-before-pocket')
  ]
  const evidence = JSON.stringify(scenarios.map(summarizeRaceScenario), null, 2)
  for (const scenario of scenarios) {
    process.stdout.write(`POCKET_RACE_READBACK ${JSON.stringify(summarizeRaceScenario(scenario))}\n`)
  }

  for (const scenario of scenarios) {
    assert.equal(scenario.harnessError, null, `Barrier scheduling failed: ${evidence}`)
    assert.deepEqual(scenario.outcomes.map(result => result.status), ['fulfilled', 'fulfilled'], evidence)
    assert.equal(scenario.afterTransactionCount, scenario.beforeTransactionCount + 3, evidence)
    assert.equal(scenario.parent.workspaceId, scenario.workspaceId, evidence)
    assert.equal(scenario.parent.userId, scenario.userId, evidence)
    assert.equal(scenario.parent.balance, 730, evidence)
    assert.equal(scenario.children.length, 1, evidence)
    assert.equal(scenario.children[0].balance, 300, evidence)
    assert.equal(scenario.children[0].workspaceId, scenario.workspaceId, evidence)
    assert.equal(scenario.children[0].userId, scenario.userId, evidence)
    assert.deepEqual(scenario.parent.childAccountIds, [scenario.children[0].id], evidence)
    assert.equal(scenario.parent.balance + scenario.children.reduce((sum, child) => sum + child.balance, 0), 1_030, evidence)
    assert.equal(scenario.localState.parentBalance, 730, evidence)
    assert.deepEqual(scenario.localState.childAccountIds, [scenario.children[0].id], evidence)
    assert.deepEqual(scenario.localState.pocketIds, [scenario.children[0].id], evidence)
    assert.deepEqual(scenario.localState.totals, { availableBalance: 730, pocketBalance: 300, totalBalance: 1_030 }, evidence)
    assert.equal(scenario.importTransactions.length, 2, evidence)
    assert.deepEqual(scenario.importTransactions.map(transaction => transaction.amount).sort((a, b) => a - b), [-20, 50], evidence)
    assert.ok(scenario.importTransactions.every(transaction => transaction.workspaceId === scenario.workspaceId && transaction.userId === scenario.userId && transaction.accountId === scenario.parentId), evidence)
    assert.equal(scenario.openingAllocations.length, 1, evidence)
    assert.equal(scenario.openingAllocations[0].amount, 300, evidence)
    assert.equal(scenario.openingAllocations[0].type, 'transfer', evidence)
    assert.equal(scenario.openingAllocations[0].pocketAllocation, true, evidence)
    assert.equal(scenario.openingAllocations[0].accountId, scenario.parentId, evidence)
    assert.equal(scenario.openingAllocations[0].toAccountId, scenario.children[0].id, evidence)
    assert.equal(scenario.openingAllocations[0].workspaceId, scenario.workspaceId, evidence)
    assert.equal(scenario.openingAllocations[0].userId, scenario.userId, evidence)
    assert.ok(scenario.callbackAttempts.some(event => event.kind === 'pocket-opening' && event.outcome === 'staged'), evidence)
    assert.ok(scenario.callbackAttempts.some(event => event.kind === 'ordinary-import' && event.outcome === 'staged'), evidence)
  }
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
