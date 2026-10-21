import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import {
  collection, connectFirestoreEmulator, deleteDoc, deleteField, doc, getDoc, getDocs,
  getFirestore, query, serverTimestamp, setDoc, setLogLevel, terminate, updateDoc, where, writeBatch
} from 'firebase/firestore'

setLogLevel('silent')
const projectId = 'demo-vault-b2'
const emulator = process.env.FIRESTORE_EMULATOR_HOST
const configuredProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
if (!emulator || configuredProject !== projectId) throw new Error('Budget-reference tests require the demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`Budget-reference tests refuse non-isolated emulator ${emulator}`)

const runId = `budget-references-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const terminated = await Promise.allSettled(databases.map(db => terminate(db)))
  const deleted = await Promise.allSettled(apps.map(app => deleteApp(app)))
  const failures = [...terminated, ...deleted].filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up budget-reference Firebase clients')
})
const client = (actor, uid) => {
  const app = initializeApp({ projectId }, `${runId}-${actor}`)
  apps.push(app)
  const db = getFirestore(app)
  databases.push(db)
  connectFirestoreEmulator(db, host, Number(portText), uid ? { mockUserToken: {
    sub: uid, user_id: uid, firebase: { sign_in_provider: 'custom' }
  } } : undefined)
  return db
}
const dualId = `${runId}-dual`
const memberId = `${runId}-member`
const dual = client('dual', dualId)
const member = client('member', memberId)
const outsider = client('outsider', `${runId}-outsider`)
const anonymous = client('anonymous')
const wsA = `${runId}-workspace-a`
const wsB = `${runId}-workspace-b`
const id = label => `${runId}-${label}-${randomUUID()}`
const transactionRef = (transactionId, db = dual) => doc(db, 'transactions', transactionId)
const budgetRef = (budgetId, db = dual) => doc(db, 'budgets', budgetId)
const dataOf = async ref => (await getDoc(ref)).data()
const list = async (name, workspaceId, db = dual) => {
  const result = await getDocs(query(collection(db, name), where('workspaceId', '==', workspaceId)))
  return result.docs.map(snapshot => [snapshot.id, snapshot.data()]).sort(([a], [b]) => a.localeCompare(b))
}
const rawBudget = (workspaceId = wsA) => ({
  workspaceId, kind: 'monthly', name: 'Synthetic reference budget', capCurrency: 'USD', archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp()
})
const rawTransaction = (extra = {}) => ({
  workspaceId: wsA, userId: dualId, accountId: `${runId}-account-a`, amount: -17, currency: 'USD',
  type: 'expense', categoryId: `${runId}-category`, description: 'Synthetic reference purchase',
  date: new Date('2026-10-01T00:00:00Z'), createdAt: serverTimestamp(), ...extra
})
const createBudget = async (workspaceId = wsA) => {
  const ref = budgetRef(id('budget'))
  await setDoc(ref, rawBudget(workspaceId))
  return ref
}
const createTransaction = async (extra = {}) => {
  const ref = transactionRef(id('transaction'))
  await setDoc(ref, rawTransaction(extra))
  return ref
}
// Observe through the public SDK, including collection counts and financial fixtures.
const state = async () => Promise.all([
  dataOf(doc(dual, 'workspaces', wsA)), dataOf(doc(dual, 'workspaces', wsB)),
  dataOf(doc(dual, 'accounts', `${runId}-account-a`)), dataOf(doc(dual, 'accounts', `${runId}-account-b`)),
  list('budgets', wsA), list('budgets', wsB), list('transactions', wsA), list('transactions', wsB)
])
const deniedUnchanged = async operation => {
  const before = await state()
  await assert.rejects(operation, error => {
    assert.equal(error.code, 'permission-denied')
    return true
  })
  assert.deepEqual(await state(), before)
}
let activeBudget
let foreignBudget
const privilegedWorkspace = async (workspaceId, fields) => {
  if (configuredProject !== projectId || host !== '127.0.0.1' || Number(portText) !== 8185) {
    throw new Error('Privileged fixtures are restricted to demo-vault-b2 at 127.0.0.1:8185')
  }
  const encode = value => value instanceof Date ? { timestampValue: value.toISOString() } :
    value === null ? { nullValue: null } :
      Array.isArray(value) ? { arrayValue: { values: value.map(encode) } } :
        value && typeof value === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } } :
          typeof value === 'boolean' ? { booleanValue: value } :
            typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) }
  const response = await fetch(`http://${host}:${portText}/v1/projects/${projectId}/databases/(default)/documents/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)])) })
  })
  if (!response.ok) throw new Error(`Privileged workspace fixture failed (${response.status}): ${await response.text()}`)
}
before(async () => {
  for (const [workspaceId, members, suffix] of [[wsA, [dualId, memberId], 'a'], [wsB, [dualId], 'b']]) {
    await privilegedWorkspace(workspaceId, {
      id: workspaceId, name: 'Synthetic reference workspace', ownerId: dualId, members, currency: 'USD',
      categoryBudgets: { legacy: 40 }, budgetAllocations: { goal: 20 }, exchangeRates: { EUR: 1.1 },
      budgetIncome: 1000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
      createdAt: new Date('2026-10-01T00:00:00.000Z')
    })
    await setDoc(doc(dual, 'accounts', `${runId}-account-${suffix}`), {
      workspaceId, userId: dualId, type: 'checking', balance: 420, currency: 'USD', createdAt: serverTimestamp()
    })
  }
  activeBudget = await createBudget()
  foreignBudget = await createBudget(wsB)
})

test('legacy absent/null references retain member CRUD and workspace queries for every transaction type', async () => {
  for (const type of ['expense', 'income', 'transfer']) {
    for (const extra of [{}, { budgetId: null }]) {
      const ref = await createTransaction({ type, ...extra })
      await updateDoc(ref, { description: 'Ordinary edit', amount: -19 })
      assert.equal((await dataOf(ref)).description, 'Ordinary edit')
      assert.ok((await list('transactions', wsA, member)).some(([key]) => key === ref.id))
      await deleteDoc(ref)
      assert.ok(!(await list('transactions', wsA)).some(([key]) => key === ref.id))
    }
  }
})

test('active same-workspace and virtual default references preserve financial data on creation and reassignment', async () => {
  const financialBefore = (await state()).slice(0, 4)
  const ref = await createTransaction({ budgetId: activeBudget.id })
  const before = await dataOf(ref)
  await updateDoc(ref, { budgetId: 'default-monthly' })
  assert.deepEqual(await dataOf(ref), { ...before, budgetId: 'default-monthly' })
  await updateDoc(ref, { budgetId: activeBudget.id })
  assert.deepEqual(await dataOf(ref), before)
  assert.deepEqual((await state()).slice(0, 4), financialBefore)
  await deleteDoc(ref)
})

test('outsider and anonymous access retain existing transaction authorization', async () => {
  const ref = await createTransaction({ budgetId: activeBudget.id })
  for (const actor of [outsider, anonymous]) {
    await deniedUnchanged(() => getDoc(transactionRef(ref.id, actor)))
    await deniedUnchanged(() => list('transactions', wsA, actor))
    await deniedUnchanged(() => setDoc(transactionRef(id('outsider-create'), actor), rawTransaction({ budgetId: activeBudget.id })))
    await deniedUnchanged(() => updateDoc(transactionRef(ref.id, actor), { budgetId: null }))
    await deniedUnchanged(() => deleteDoc(transactionRef(ref.id, actor)))
  }
})

test('a member of both workspaces cannot assign a foreign budget on create or update', async () => {
  await deniedUnchanged(() => setDoc(transactionRef(id('foreign-create')), rawTransaction({ budgetId: foreignBudget.id })))
  const ref = await createTransaction()
  await deniedUnchanged(() => updateDoc(ref, { budgetId: foreignBudget.id }))
})

test('explicit references reject missing parents and malformed IDs on both create and update', async () => {
  const ref = await createTransaction()
  for (const budgetId of [id('missing'), '', '.', '..', 'path/segment', 12, true, [], { id: activeBudget.id }]) {
    await deniedUnchanged(() => setDoc(transactionRef(id('invalid-create')), rawTransaction({ budgetId })))
    await deniedUnchanged(() => updateDoc(ref, { budgetId }))
  }
})

test('only expenses can carry explicit additional or default-monthly references', async () => {
  for (const type of ['income', 'transfer']) {
    for (const budgetId of [activeBudget.id, 'default-monthly']) {
      await deniedUnchanged(() => setDoc(transactionRef(id('non-expense')), rawTransaction({ type, budgetId })))
      const ref = await createTransaction({ type })
      await deniedUnchanged(() => updateDoc(ref, { budgetId }))
    }
  }
  const assigned = await createTransaction({ budgetId: activeBudget.id })
  await deniedUnchanged(() => updateDoc(assigned, { type: 'income' }))
})

test('transaction workspace identity cannot change or be removed even for dual members', async () => {
  const ref = await createTransaction()
  for (const workspaceId of [wsB, null, deleteField()]) {
    await deniedUnchanged(() => updateDoc(ref, { workspaceId }))
  }
})

test('budget reassignment cannot accompany any ledger, installment, receipt or mirror-field mutation', async () => {
  const ref = await createTransaction()
  for (const [field, value] of [
    ['amount', -99], ['accountId', `${runId}-account-b`], ['currency', 'EUR'],
    ['date', new Date('2026-11-01T00:00:00Z')], ['categoryId', 'different-category'],
    ['description', 'Mixed edit'], ['receiptUrl', 'https://example.invalid/receipt'], ['notes', 'Mixed notes'],
    ['installments', 3], ['toAccountId', `${runId}-account-b`], ['mirrorTransactionId', 'different-mirror'],
    ['createdAt', new Date('2020-01-01T00:00:00Z')], ['userId', memberId], ['updatedAt', serverTimestamp()]
  ]) {
    await deniedUnchanged(() => updateDoc(ref, { budgetId: activeBudget.id, [field]: value }))
  }
})

test('absent/null/default representation changes are budget-only mutations, while same-value resend is an ordinary edit', async () => {
  for (const old of ['absent', null, 'default-monthly']) {
    for (const next of ['absent', null, 'default-monthly']) {
      if (old === next) continue
      const ref = await createTransaction(old === 'absent' ? {} : { budgetId: old })
      const patch = { budgetId: next === 'absent' ? deleteField() : next }
      await deniedUnchanged(() => updateDoc(ref, { ...patch, notes: 'Mixed representation edit' }))
      const before = await dataOf(ref)
      const expected = { ...before }
      if (next === 'absent') delete expected.budgetId
      else expected.budgetId = next
      await updateDoc(ref, patch)
      assert.deepEqual(await dataOf(ref), expected)
    }
  }
  for (const budgetId of [null, 'default-monthly', activeBudget.id]) {
    const ref = await createTransaction({ budgetId })
    await updateDoc(ref, { budgetId, notes: 'Ordinary same-value edit' })
    assert.equal((await dataOf(ref)).notes, 'Ordinary same-value edit')
  }
})

test('archived parents retain existing references and queries but reject new assignments', async () => {
  const parent = await createBudget()
  const existing = await createTransaction({ budgetId: parent.id })
  await updateDoc(parent, { archived: true, updatedAt: serverTimestamp() })
  assert.equal((await dataOf(existing)).budgetId, parent.id)
  assert.ok((await list('transactions', wsA)).some(([key]) => key === existing.id))
  await updateDoc(existing, { notes: 'Retained historical edit', budgetId: parent.id })
  const before = await dataOf(existing)
  assert.equal(before.notes, 'Retained historical edit')
  await deniedUnchanged(() => setDoc(transactionRef(id('archived-create')), rawTransaction({ budgetId: parent.id })))
  const unassigned = await createTransaction()
  await deniedUnchanged(() => updateDoc(unassigned, { budgetId: parent.id }))
  await updateDoc(existing, { budgetId: null })
  assert.deepEqual(await dataOf(existing), { ...before, budgetId: null })
})

test('post-state parent lookup allows atomic budget creation with an expense', async () => {
  const parent = budgetRef(id('new-parent'))
  const ref = transactionRef(id('new-child'))
  const before = (await state()).slice(0, 4)
  const batch = writeBatch(dual)
  batch.set(parent, rawBudget())
  batch.set(ref, rawTransaction({ budgetId: parent.id }))
  await batch.commit()
  assert.equal((await dataOf(ref)).budgetId, parent.id)
  assert.equal((await dataOf(parent)).archived, false)
  assert.deepEqual((await state()).slice(0, 4), before)
})

test('post-state lookup rejects archive plus new assignment atomically but retains an unchanged assignment', async () => {
  for (const operation of ['create', 'update']) {
    const parent = await createBudget()
    const ref = operation === 'update' ? await createTransaction() : transactionRef(id('archive-create'))
    await deniedUnchanged(() => {
      const batch = writeBatch(dual)
      batch.update(parent, { archived: true, updatedAt: serverTimestamp() })
      if (operation === 'create') batch.set(ref, rawTransaction({ budgetId: parent.id }))
      else batch.update(ref, { budgetId: parent.id })
      return batch.commit()
    })
  }
  const parent = await createBudget()
  const ref = await createTransaction({ budgetId: parent.id })
  const batch = writeBatch(dual)
  batch.update(parent, { archived: true, updatedAt: serverTimestamp() })
  batch.update(ref, { notes: 'Retained assignment during archive' })
  await batch.commit()
  assert.equal((await dataOf(parent)).archived, true)
  assert.equal((await dataOf(ref)).notes, 'Retained assignment during archive')
})

test('ordinary edits still validate the actual workspace and existence of a retained reference', async () => {
  // Privileged REST is fixture-only: emulate historical invalid references, never authorize the asserted writes.
  for (const budgetId of [foreignBudget.id, id('missing-historical')]) {
    const ref = transactionRef(id('historical'))
    const response = await fetch(`http://${emulator}/v1/projects/${projectId}/databases/(default)/documents/transactions/${ref.id}`, {
      method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        workspaceId: { stringValue: wsA }, userId: { stringValue: dualId }, type: { stringValue: 'expense' },
        amount: { integerValue: '-17' }, budgetId: { stringValue: budgetId }
      } })
    })
    assert.equal(response.status, 200, await response.text())
    await deniedUnchanged(() => updateDoc(ref, { notes: 'Cannot preserve invalid reference' }))
    await updateDoc(ref, { budgetId: null })
    assert.equal((await dataOf(ref)).budgetId, null)
  }
})
