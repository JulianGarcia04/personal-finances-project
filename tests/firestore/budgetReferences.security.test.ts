import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import * as firestoreSdk from 'firebase/firestore'
import {
  collection, connectFirestoreEmulator, deleteDoc, deleteField, doc, getDoc, getDocs,
  getFirestore, query, serverTimestamp, setDoc, setLogLevel, terminate, updateDoc, where, writeBatch
} from 'firebase/firestore'
import { createPinia, disposePinia } from 'pinia'
import ts from 'typescript'

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
    await deniedUnchanged(() => updateDoc(transactionRef(ref.id, actor), { amount: -20, budgetId: activeBudget.id }))
    await deniedUnchanged(() => deleteDoc(transactionRef(ref.id, actor)))
  }
  // A member of workspace A alone cannot edit a workspace B movement, budget or not.
  const inB = await createTransaction({ workspaceId: wsB, accountId: `${runId}-account-b` })
  await deniedUnchanged(() => updateDoc(transactionRef(inB.id, member), { amount: -20, budgetId: foreignBudget.id }))
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

test('expenses and income can carry explicit additional or default-monthly references', async () => {
  for (const budgetId of [activeBudget.id, 'default-monthly']) {
    const created = await createTransaction({ type: 'income', amount: 17, budgetId })
    assert.equal((await dataOf(created)).budgetId, budgetId)
    const ref = await createTransaction({ type: 'income', amount: 17 })
    await updateDoc(ref, { budgetId })
    assert.equal((await dataOf(ref)).budgetId, budgetId)
  }
  const foreign = await createTransaction({ type: 'income', amount: 17 })
  await deniedUnchanged(() => updateDoc(foreign, { budgetId: foreignBudget.id }))
})

test('transfers cannot carry explicit additional or default-monthly references', async () => {
  for (const budgetId of [activeBudget.id, 'default-monthly']) {
    await deniedUnchanged(() => setDoc(transactionRef(id('transfer')), rawTransaction({ type: 'transfer', budgetId })))
    const ref = await createTransaction({ type: 'transfer' })
    await deniedUnchanged(() => updateDoc(ref, { budgetId }))
  }
  const assigned = await createTransaction({ budgetId: activeBudget.id })
  await deniedUnchanged(() => updateDoc(assigned, { type: 'transfer' }))
  for (const type of ['loan', 'loan_payment']) {
    for (const budgetId of [activeBudget.id, 'default-monthly']) {
      await deniedUnchanged(() => setDoc(transactionRef(id(type)), rawTransaction({ type, budgetId })))
    }
  }
  const income = await createTransaction({ type: 'income', amount: 17, budgetId: activeBudget.id })
  await deniedUnchanged(() => updateDoc(income, { type: 'loan_payment' }))
  await deniedUnchanged(() => updateDoc(income, { type: 'loan_payment', budgetId: 'default-monthly', amount: 18 }))
})

test('transaction workspace identity cannot change or be removed even for dual members', async () => {
  const ref = await createTransaction()
  for (const workspaceId of [wsB, null, deleteField()]) {
    await deniedUnchanged(() => updateDoc(ref, { workspaceId }))
  }
  await deniedUnchanged(() => updateDoc(ref, { workspaceId: wsB, accountId: `${runId}-account-b`, amount: -20, budgetId: foreignBudget.id }))
  await deniedUnchanged(() => updateDoc(ref, { workspaceId: deleteField(), budgetId: activeBudget.id }))
})

// S7 (D1): "Guardar" saves the chosen budget in the same write as the edit. Next to other fields a
// budget change passes exactly the budget-only checks, so the field decides alone whether it may change.
test('S7: a chosen budget may accompany any edit the field allows alone, and only a valid budget', async () => {
  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  const outcome = async operation => {
    try {
      await operation()
      return 'allowed'
    } catch (error) {
      assert.equal(error.code, 'permission-denied')
      return 'denied'
    }
  }
  const outcomes = {}
  for (const [field, value] of [
    ['amount', -99], ['accountId', `${runId}-account-b`], ['currency', 'EUR'],
    ['date', new Date('2026-11-01T00:00:00Z')], ['categoryId', 'different-category'],
    ['description', 'Mixed edit'], ['receiptUrl', 'https://example.invalid/receipt'], ['notes', 'Mixed notes'],
    ['installments', 3], ['toAccountId', `${runId}-account-b`], ['mirrorTransactionId', 'different-mirror'],
    ['createdAt', new Date('2020-01-01T00:00:00Z')], ['userId', memberId], ['updatedAt', serverTimestamp()]
  ]) {
    const alone = await outcome(async () => updateDoc(await createTransaction(), { [field]: value }))
    const combined = await createTransaction()
    const withBudget = await outcome(() => updateDoc(combined, { budgetId: activeBudget.id, [field]: value }))
    assert.equal(withBudget, alone, `${field} with a valid budget`)
    if (withBudget === 'allowed') assert.equal((await dataOf(combined)).budgetId, activeBudget.id)
    const invalid = await createTransaction()
    for (const budgetId of [archived.id, foreignBudget.id, id('missing'), 'path/segment']) {
      await deniedUnchanged(() => updateDoc(invalid, { budgetId, [field]: value }))
    }
    outcomes[field] = alone
  }
  // The edits "Guardar" sends are among the allowed ones.
  for (const field of ['amount', 'date', 'categoryId', 'description', 'receiptUrl', 'notes', 'installments', 'userId']) {
    assert.equal(outcomes[field], 'allowed', field)
  }
  const ref = await createTransaction({ budgetId: activeBudget.id })
  await updateDoc(ref, { amount: -40, notes: 'Back to default', budgetId: deleteField() })
  assert.deepEqual([(await dataOf(ref)).amount, 'budgetId' in (await dataOf(ref))], [-40, false])
})

test('S7: budget-only batch assignment is unchanged: valid budgets apply together, an invalid one rejects the batch', async () => {
  const refs = [await createTransaction(), await createTransaction({ type: 'income', amount: 17 }), await createTransaction({ budgetId: 'default-monthly' })]
  const assign = budgetId => {
    const batch = writeBatch(dual)
    for (const ref of refs) batch.update(ref, { budgetId })
    return batch.commit()
  }
  await assign(activeBudget.id)
  for (const ref of refs) assert.equal((await dataOf(ref)).budgetId, activeBudget.id)
  await assign(null)
  for (const ref of refs) assert.equal((await dataOf(ref)).budgetId, null)
  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  for (const budgetId of [archived.id, foreignBudget.id]) await deniedUnchanged(() => assign(budgetId))
  const transfer = await createTransaction({ type: 'transfer', amount: 17, toAccountId: `${runId}-account-a` })
  await deniedUnchanged(() => updateDoc(transfer, { budgetId: activeBudget.id }))
})

test('absent/null/default representation changes apply alone or with an edit, while same-value resend is an ordinary edit', async () => {
  for (const old of ['absent', null, 'default-monthly']) {
    for (const next of ['absent', null, 'default-monthly']) {
      if (old === next) continue
      for (const extra of [{}, { notes: 'Mixed representation edit' }]) {
        const ref = await createTransaction(old === 'absent' ? {} : { budgetId: old })
        const patch = { budgetId: next === 'absent' ? deleteField() : next }
        const before = await dataOf(ref)
        const expected = { ...before, ...extra }
        if (next === 'absent') delete expected.budgetId
        else expected.budgetId = next
        await updateDoc(ref, { ...patch, ...extra })
        assert.deepEqual(await dataOf(ref), expected)
      }
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
  await deniedUnchanged(() => setDoc(transactionRef(id('archived-income')), rawTransaction({ type: 'income', amount: 17, budgetId: parent.id })))
  const income = await createTransaction({ type: 'income', amount: 17 })
  await deniedUnchanged(() => updateDoc(income, { budgetId: parent.id }))
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

// Server-side link lock (S2): an account linked to an active budget stores linkedBudgetId, and its
// expenses and income must carry that budget.
const accountRef = (accountId, db = dual) => doc(db, 'accounts', accountId)
const rawAccount = (extra = {}) => ({
  workspaceId: wsA, userId: dualId, name: 'Synthetic linked account', type: 'checking', balance: 100,
  limit: 0, currency: 'USD', createdAt: serverTimestamp(), ...extra
})
const createAccount = async (extra = {}) => {
  const ref = accountRef(id('account'))
  await setDoc(ref, rawAccount(extra))
  return ref
}
// Links an existing account to a new budget atomically, as the client does.
const createLinkedBudget = async accountIds => {
  const budget = budgetRef(id('linked-budget'))
  const batch = writeBatch(dual)
  batch.set(budget, { ...rawBudget(), linkedAccountIds: accountIds })
  for (const accountId of accountIds) batch.update(accountRef(accountId), { linkedBudgetId: budget.id })
  await batch.commit()
  return budget
}
const privilegedDocument = async (path, fields) => {
  if (configuredProject !== projectId || host !== '127.0.0.1' || Number(portText) !== 8185) {
    throw new Error('Privileged fixtures are restricted to demo-vault-b2 at 127.0.0.1:8185')
  }
  const encode = value => value instanceof Date ? { timestampValue: value.toISOString() } :
    value === null ? { nullValue: null } :
      Array.isArray(value) ? { arrayValue: { values: value.map(encode) } } :
        value && typeof value === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } } :
          typeof value === 'boolean' ? { booleanValue: value } :
            typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) }
  const response = await fetch(`http://${host}:${portText}/v1/projects/${projectId}/databases/(default)/documents/${path}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)])) })
  })
  if (!response.ok) throw new Error(`Privileged fixture failed (${response.status}): ${await response.text()}`)
}

// Budgets are never deleted by the client; a deleted parent can only come from outside the app.
const createDeletedBudget = async () => {
  const budget = await createBudget()
  if (configuredProject !== projectId || host !== '127.0.0.1' || Number(portText) !== 8185) {
    throw new Error('Privileged fixtures are restricted to demo-vault-b2 at 127.0.0.1:8185')
  }
  const response = await fetch(`http://${host}:${portText}/v1/projects/${projectId}/databases/(default)/documents/budgets/${budget.id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer owner' }
  })
  if (!response.ok) throw new Error(`Privileged delete failed (${response.status}): ${await response.text()}`)
  return budget.id
}

test('an account link requires an active same-workspace budget that lists the account', async () => {
  const account = await createAccount()
  const listing = await createBudget()
  await updateDoc(listing, { linkedAccountIds: [account.id], updatedAt: serverTimestamp() })
  const notListing = await createBudget()
  const foreign = budgetRef(id('foreign-listing'))
  await setDoc(foreign, { ...rawBudget(wsB), linkedAccountIds: [account.id] })
  const archived = await createBudget()
  await updateDoc(archived, { linkedAccountIds: [account.id], updatedAt: serverTimestamp() })
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  for (const linkedBudgetId of [notListing.id, foreign.id, archived.id, id('missing'), 'default-monthly', 'path/segment', '', 12, null]) {
    await deniedUnchanged(() => updateDoc(account, { linkedBudgetId }))
    await deniedUnchanged(() => setDoc(accountRef(id('linked-create')), rawAccount({ linkedBudgetId })))
  }
  await updateDoc(account, { linkedBudgetId: listing.id })
  assert.equal((await dataOf(account)).linkedBudgetId, listing.id)
  // Ordinary edits keep the link, and removing it is always allowed.
  await updateDoc(account, { name: 'Renamed linked account' })
  await updateDoc(account, { linkedBudgetId: deleteField() })
  assert.equal('linkedBudgetId' in (await dataOf(account)), false)
})

test('a budget and the accounts it links are created together in one batch', async () => {
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  assert.equal((await dataOf(account)).linkedBudgetId, budget.id)
  const created = accountRef(id('created-linked'))
  const other = budgetRef(id('created-budget'))
  const batch = writeBatch(dual)
  batch.set(other, { ...rawBudget(), linkedAccountIds: [created.id] })
  batch.set(created, rawAccount({ linkedBudgetId: other.id }))
  await batch.commit()
  assert.equal((await dataOf(created)).linkedBudgetId, other.id)
})

test('bridge and pocket-related accounts cannot be linked to a budget', async () => {
  const mirror = { workspaceId: wsB, accountId: `${runId}-account-b`, sourceAccountId: `${runId}-account-a` }
  const bridgeId = id('bridge-account')
  await privilegedDocument(`accounts/${bridgeId}`, {
    workspaceId: wsA, userId: dualId, name: 'Bridge', type: 'checking', balance: 0, limit: 0, currency: 'USD',
    mirror, createdAt: new Date('2026-10-01T00:00:00Z')
  })
  const bridge = accountRef(bridgeId)
  const budget = await createBudget()
  await updateDoc(budget, { linkedAccountIds: [bridge.id], updatedAt: serverTimestamp() })
  await deniedUnchanged(() => updateDoc(bridge, { linkedBudgetId: budget.id }))
  const linked = await createAccount()
  await createLinkedBudget([linked.id])
  await deniedUnchanged(() => updateDoc(linked, { mirror }))

  const parentId = id('pocket-parent')
  const pocketId = id('pocket')
  await privilegedDocument(`accounts/${parentId}`, {
    workspaceId: wsA, userId: dualId, name: 'Parent', type: 'savings', balance: 50, limit: 0, currency: 'USD',
    childAccountIds: [pocketId], createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`accounts/${pocketId}`, {
    workspaceId: wsA, userId: dualId, name: 'Pocket', type: 'savings', balance: 0, limit: 0, currency: 'USD',
    parentAccountId: parentId, childAccountIds: [], pocketActivity: false, openingAllocationId: null,
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  const pocketBudget = await createBudget()
  await updateDoc(pocketBudget, { linkedAccountIds: [parentId, pocketId], updatedAt: serverTimestamp() })
  await deniedUnchanged(() => updateDoc(accountRef(parentId), { linkedBudgetId: pocketBudget.id }))
  await deniedUnchanged(() => updateDoc(accountRef(pocketId), { linkedBudgetId: pocketBudget.id }))
})

test('expenses and income of a linked account must carry its budget on creation', async () => {
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  for (const [type, amount] of [['expense', -17], ['income', 17]]) {
    for (const extra of [{}, { budgetId: null }, { budgetId: 'default-monthly' }, { budgetId: activeBudget.id }]) {
      await deniedUnchanged(() => setDoc(transactionRef(id('unlocked-create')), rawTransaction({ accountId: account.id, type, amount, ...extra })))
    }
    const ref = await createTransaction({ accountId: account.id, type, amount, budgetId: budget.id })
    assert.equal((await dataOf(ref)).budgetId, budget.id)
  }
  const transfer = await createTransaction({ accountId: account.id, type: 'transfer', amount: 17, toAccountId: `${runId}-account-a` })
  assert.equal('budgetId' in (await dataOf(transfer)), false)
})

test('moving a movement into a linked account carries the linked budget in the same write', async () => {
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  const ref = await createTransaction()
  await deniedUnchanged(() => updateDoc(ref, { accountId: account.id }))
  await deniedUnchanged(() => updateDoc(ref, { accountId: account.id, budgetId: activeBudget.id }))
  await updateDoc(ref, { accountId: account.id, amount: -18, budgetId: budget.id })
  assert.deepEqual([(await dataOf(ref)).accountId, (await dataOf(ref)).budgetId], [account.id, budget.id])
  // A transfer into an expense of the linked account also takes the budget.
  const transfer = await createTransaction({ type: 'transfer', amount: 17, toAccountId: account.id })
  await deniedUnchanged(() => updateDoc(transfer, { type: 'expense', amount: -17, toAccountId: null, accountId: account.id }))
  await updateDoc(transfer, { type: 'expense', amount: -17, toAccountId: null, accountId: account.id, budgetId: budget.id })
  assert.equal((await dataOf(transfer)).budgetId, budget.id)
})

test('a type change drops the budget in the same write as the financial edit', async () => {
  const toTransfer = await createTransaction({ type: 'income', amount: 17, budgetId: activeBudget.id })
  await updateDoc(toTransfer, { type: 'transfer', toAccountId: `${runId}-account-a`, amount: 20, budgetId: deleteField() })
  assert.equal('budgetId' in (await dataOf(toTransfer)), false)
  const switched = await createTransaction({ budgetId: activeBudget.id })
  await updateDoc(switched, { type: 'income', amount: 17, budgetId: deleteField() })
  assert.deepEqual([(await dataOf(switched)).type, 'budgetId' in (await dataOf(switched))], ['income', false])
  // Without a type switch the user's choice may travel with ledger fields (S7).
  const kept = await createTransaction({ budgetId: activeBudget.id })
  await updateDoc(kept, { amount: -30, budgetId: deleteField() })
  assert.deepEqual([(await dataOf(kept)).amount, 'budgetId' in (await dataOf(kept))], [-30, false])
  // Leaving the linked account's movement without its budget is still locked.
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  const linkedIncome = await createTransaction({ accountId: account.id, type: 'income', amount: 17, budgetId: budget.id })
  await deniedUnchanged(() => updateDoc(linkedIncome, { type: 'expense', amount: -17, budgetId: deleteField() }))
  await updateDoc(linkedIncome, { type: 'expense', amount: -17 })
  assert.equal((await dataOf(linkedIncome)).budgetId, budget.id)
})

test('movements of a linked account can only be reassigned to its budget, while legacy edits stay allowed', async () => {
  const account = await createAccount()
  const legacy = await createTransaction({ accountId: account.id })
  const budget = await createLinkedBudget([account.id])
  await updateDoc(legacy, { description: 'Legacy edit on a linked account' })
  assert.equal((await dataOf(legacy)).description, 'Legacy edit on a linked account')
  for (const budgetId of [activeBudget.id, 'default-monthly', null]) {
    await deniedUnchanged(() => updateDoc(legacy, { budgetId }))
  }
  await updateDoc(legacy, { budgetId: budget.id })
  assert.equal((await dataOf(legacy)).budgetId, budget.id)
  await deniedUnchanged(() => updateDoc(legacy, { budgetId: activeBudget.id }))
})

test('archiving the linked budget frees its accounts', async () => {
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  await updateDoc(budget, { archived: true, updatedAt: serverTimestamp() })
  const ref = await createTransaction({ accountId: account.id })
  await updateDoc(ref, { budgetId: activeBudget.id })
  assert.equal((await dataOf(ref)).budgetId, activeBudget.id)
  await updateDoc(account, { linkedBudgetId: deleteField() })
})

test('S6: credit cards cannot be linked to a budget, linked accounts cannot become credit cards, and linked accounts cannot be deleted until unlinked', async () => {
  const credit = await createAccount({ type: 'credit', balance: 0, limit: 1000 })
  const budget = await createBudget()
  await updateDoc(budget, { linkedAccountIds: [credit.id], updatedAt: serverTimestamp() })
  await deniedUnchanged(() => updateDoc(credit, { linkedBudgetId: budget.id }))
  await deniedUnchanged(() => setDoc(accountRef(id('credit-linked-create')), rawAccount({ type: 'credit', balance: 0, limit: 1000, linkedBudgetId: budget.id })))

  const checking = await createAccount({ type: 'checking', balance: 0 })
  const linkedBudget = await createLinkedBudget([checking.id])
  await deniedUnchanged(() => updateDoc(checking, { type: 'credit' }))
  await deniedUnchanged(() => deleteDoc(checking))
  // Unlinking frees the account for deletion.
  await updateDoc(checking, { linkedBudgetId: deleteField() })
  await updateDoc(linkedBudget, { linkedAccountIds: deleteField(), updatedAt: serverTimestamp() })
  await deleteDoc(checking)
  assert.ok(!(await list('accounts', wsA)).some(([key]) => key === checking.id))
})

test('S7: an edit of a linked account keeps its budget; a different chosen budget is refused', async () => {
  const account = await createAccount()
  const budget = await createLinkedBudget([account.id])
  const ref = await createTransaction({ accountId: account.id, budgetId: budget.id })
  for (const budgetId of [activeBudget.id, 'default-monthly', null, deleteField()]) {
    await deniedUnchanged(() => updateDoc(ref, { amount: -25, notes: 'Linked edit', budgetId }))
  }
  await updateDoc(ref, { amount: -25, notes: 'Linked edit', budgetId: budget.id })
  assert.deepEqual([(await dataOf(ref)).amount, (await dataOf(ref)).budgetId], [-25, budget.id])
})

test('S7: a pocket movement edit changes its budget in the same write as its balance', async () => {
  const parentId = id('budget-pocket-parent')
  const pocketId = id('budget-pocket')
  const movementId = id('budget-pocket-movement')
  await privilegedDocument(`accounts/${parentId}`, {
    workspaceId: wsA, userId: dualId, name: 'Parent', type: 'savings', balance: 100, limit: 0, currency: 'USD',
    childAccountIds: [pocketId], createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`accounts/${pocketId}`, {
    workspaceId: wsA, userId: dualId, name: 'Pocket', type: 'savings', balance: 50, limit: 0, currency: 'USD',
    parentAccountId: parentId, childAccountIds: [], pocketActivity: true, openingAllocationId: null,
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`transactions/${movementId}`, {
    workspaceId: wsA, userId: dualId, accountId: pocketId, toAccountId: null, amount: -10, type: 'expense',
    categoryId: `${runId}-category`, description: 'Pocket purchase', currency: 'USD',
    date: new Date('2026-10-02T12:00:00Z'), createdAt: new Date('2026-10-02T12:00:00Z')
  })
  const edit = (budgetId, amount) => {
    const batch = writeBatch(dual)
    batch.update(transactionRef(movementId), { amount, budgetId })
    batch.update(accountRef(pocketId), {
      balance: 50 + (amount + 10), lastPocketMovementId: movementId, lastPocketMovementType: 'updated', pocketActivity: true
    })
    return batch.commit()
  }
  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  for (const budgetId of [archived.id, foreignBudget.id, await createDeletedBudget()]) await deniedUnchanged(() => edit(budgetId, -15))
  await edit(activeBudget.id, -15)
  assert.deepEqual([(await dataOf(transactionRef(movementId))).amount, (await dataOf(transactionRef(movementId))).budgetId], [-15, activeBudget.id])
  assert.equal((await dataOf(accountRef(pocketId))).balance, 45)

  // A pocket transfer and the pocket's opening allocation never take a budget.
  const pocketTransferId = id('budget-pocket-transfer')
  await privilegedDocument(`transactions/${pocketTransferId}`, {
    workspaceId: wsA, userId: dualId, accountId: pocketId, toAccountId: `${runId}-account-a`, amount: 5, type: 'transfer',
    categoryId: '', description: 'Pocket transfer', currency: 'USD',
    date: new Date('2026-10-02T12:00:00Z'), createdAt: new Date('2026-10-02T12:00:00Z')
  })
  const openingId = id('budget-pocket-opening')
  await privilegedDocument(`transactions/${openingId}`, {
    workspaceId: wsA, userId: dualId, accountId: parentId, toAccountId: pocketId, amount: 50, type: 'transfer',
    categoryId: '', description: 'Opening allocation', currency: 'USD', pocketAllocation: true,
    date: new Date('2026-10-01T12:00:00Z'), createdAt: new Date('2026-10-01T12:00:00Z')
  })
  for (const movement of [pocketTransferId, openingId]) {
    for (const budgetId of [activeBudget.id, 'default-monthly']) {
      await deniedUnchanged(() => updateDoc(transactionRef(movement), { description: 'Renamed', budgetId }))
    }
  }
})

// One shared expense: the expense leg on a bridge in workspace A, its transfer twin in workspace B.
const createSharedExpense = async () => {
  const bridgeId = id('budget-bridge')
  const receivableId = id('budget-receivable')
  const expenseLegId = id('budget-shared-expense')
  const transferLegId = id('budget-shared-transfer')
  const legDate = new Date('2026-10-03T12:00:00Z')
  await privilegedDocument(`accounts/${bridgeId}`, {
    workspaceId: wsA, userId: dualId, name: 'Bridge', type: 'checking', balance: -30, limit: 0, currency: 'USD',
    mirror: { workspaceId: wsB, accountId: receivableId, sourceAccountId: `${runId}-account-b` },
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`accounts/${receivableId}`, {
    workspaceId: wsB, userId: dualId, name: 'Receivable', type: 'checking', balance: 30, limit: 0, currency: 'USD',
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`transactions/${expenseLegId}`, {
    workspaceId: wsA, userId: dualId, accountId: bridgeId, toAccountId: null, amount: -30, type: 'expense',
    categoryId: `${runId}-category`, description: 'Shared dinner', currency: 'USD', mirrorOf: transferLegId,
    date: legDate, createdAt: legDate
  })
  await privilegedDocument(`transactions/${transferLegId}`, {
    workspaceId: wsB, userId: dualId, accountId: `${runId}-account-b`, toAccountId: receivableId, amount: 30,
    type: 'transfer', categoryId: '', description: 'Shared dinner', currency: 'USD', mirrorOf: expenseLegId,
    date: legDate, createdAt: legDate
  })
  return { expenseLeg: transactionRef(expenseLegId), transferLeg: transactionRef(transferLegId) }
}
const editBothLegs = (legs, expensePatch, transferPatch) => {
  const batch = writeBatch(dual)
  batch.update(legs.expenseLeg, expensePatch)
  batch.update(legs.transferLeg, transferPatch)
  return batch.commit()
}

test('S7: a shared expense edit changes the expense leg budget together with both legs', async () => {
  const legs = await createSharedExpense()
  await deniedUnchanged(() => editBothLegs(legs, { amount: -40, budgetId: foreignBudget.id }, { amount: 40 }))
  await updateDoc(legs.expenseLeg, { notes: 'Own field', budgetId: activeBudget.id })
  await editBothLegs(legs, { amount: -40, budgetId: null }, { amount: 40 })
  const [expenseLeg, transferLeg] = [await dataOf(legs.expenseLeg), await dataOf(legs.transferLeg)]
  assert.deepEqual([expenseLeg.amount, expenseLeg.budgetId, expenseLeg.notes, transferLeg.amount], [-40, null, 'Own field', 40])
  // Changing the shared date on both legs may carry the budget too.
  const nextDate = new Date('2026-10-04T12:00:00Z')
  await editBothLegs(legs, { date: nextDate, budgetId: activeBudget.id }, { date: nextDate })
  assert.equal((await dataOf(legs.expenseLeg)).budgetId, activeBudget.id)
})

test('S7: a budget never reaches the transfer leg or excuses a broken shared expense pair', async () => {
  const legs = await createSharedExpense()
  // The transfer leg never carries a budget, alone or in the pair edit.
  await deniedUnchanged(() => updateDoc(legs.transferLeg, { budgetId: activeBudget.id }))
  for (const budgetId of [foreignBudget.id, 'default-monthly']) {
    await deniedUnchanged(() => editBothLegs(legs, { amount: -40 }, { amount: 40, budgetId }))
  }
  // The pair rules still hold when the expense leg also changes its budget.
  const budgetId = activeBudget.id
  await deniedUnchanged(() => updateDoc(legs.expenseLeg, { amount: -40, budgetId }))
  await deniedUnchanged(() => editBothLegs(legs, { amount: -40, budgetId }, { amount: 41 }))
  await deniedUnchanged(() => editBothLegs(legs, { amount: 40, budgetId }, { amount: -40 }))
  await deniedUnchanged(() => updateDoc(legs.expenseLeg, { date: new Date('2026-10-04T12:00:00Z'), budgetId }))
  await deniedUnchanged(() => updateDoc(legs.expenseLeg, { description: 'Other', budgetId }))
})

test('S7: a deleted budget is refused next to an edit, and a movement can leave it in the same write', async () => {
  const deleted = await createDeletedBudget()
  for (const [type, amount] of [['expense', -20], ['income', 20]]) {
    const ref = await createTransaction(type === 'income' ? { type, amount: 17 } : {})
    await deniedUnchanged(() => updateDoc(ref, { amount, budgetId: deleted }))
  }
  const stale = transactionRef(id('deleted-parent'))
  await privilegedDocument(`transactions/${stale.id}`, {
    workspaceId: wsA, userId: dualId, accountId: `${runId}-account-a`, amount: -17, currency: 'USD', type: 'expense',
    categoryId: `${runId}-category`, description: 'Stale reference', budgetId: deleted,
    date: new Date('2026-10-01T00:00:00Z'), createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await updateDoc(stale, { amount: -22, budgetId: deleteField() })
  assert.deepEqual([(await dataOf(stale)).amount, 'budgetId' in (await dataOf(stale))], [-22, false])
})

test('S7: loans never take a budget next to an edit, and an expense becoming a loan must drop its budget', async () => {
  for (const [type, amount] of [['loan', -17], ['loan_payment', 17]]) {
    const ref = await createTransaction({ type, amount, categoryId: '' })
    await deniedUnchanged(() => updateDoc(ref, { amount: amount * 2, budgetId: activeBudget.id }))
    await deniedUnchanged(() => updateDoc(ref, { notes: 'Loan note', budgetId: 'default-monthly' }))
    const unassigned = await createTransaction()
    await deniedUnchanged(() => updateDoc(unassigned, { type, amount, categoryId: '', budgetId: activeBudget.id }))
    const kept = await createTransaction({ budgetId: activeBudget.id })
    await deniedUnchanged(() => updateDoc(kept, { type, amount, categoryId: '' }))
    await updateDoc(kept, { type, amount, categoryId: '', budgetId: deleteField() })
    assert.deepEqual([(await dataOf(kept)).type, 'budgetId' in (await dataOf(kept))], [type, false])
  }
})

test('S7: a type change may set a new active budget in the same write, never an archived or foreign one', async () => {
  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  const toIncome = { type: 'income', amount: 17 }
  const toExpense = { type: 'expense', amount: -17, toAccountId: null, categoryId: `${runId}-category` }
  const transfer = () => createTransaction({ type: 'transfer', amount: 17, toAccountId: `${runId}-account-a`, categoryId: '' })
  const expense = await createTransaction()
  await deniedUnchanged(() => updateDoc(expense, { ...toIncome, budgetId: archived.id }))
  await deniedUnchanged(() => updateDoc(expense, { ...toIncome, budgetId: foreignBudget.id }))
  const fromTransfer = await transfer()
  await deniedUnchanged(() => updateDoc(fromTransfer, { ...toExpense, budgetId: foreignBudget.id }))
  await deniedUnchanged(() => updateDoc(fromTransfer, { ...toExpense, budgetId: archived.id }))
  await updateDoc(expense, { ...toIncome, budgetId: activeBudget.id })
  await updateDoc(fromTransfer, { ...toExpense, budgetId: activeBudget.id })
  assert.deepEqual([(await dataOf(expense)).budgetId, (await dataOf(fromTransfer)).budgetId], [activeBudget.id, activeBudget.id])
})

// S9: the Transactions bulk edit writes only categoryId and/or budgetId, in one writeBatch per chunk.
const commitBulkEdit = rows => {
  const batch = writeBatch(dual)
  for (const [ref, patch] of rows) batch.update(ref, patch)
  return batch.commit()
}

test('S9: a bulk edit batch of category and budget updates applies together, and one invalid row rejects the whole batch', async () => {
  const expense = await createTransaction()
  const income = await createTransaction({ type: 'income', amount: 17, budgetId: activeBudget.id })
  const categoryOnly = await createTransaction({ budgetId: activeBudget.id })
  const before = await Promise.all([expense, income, categoryOnly].map(dataOf))
  await commitBulkEdit([
    [expense, { categoryId: 'bulk-category', budgetId: activeBudget.id }],
    [income, { budgetId: null }],
    [categoryOnly, { categoryId: 'bulk-category' }]
  ])
  assert.deepEqual(await dataOf(expense), { ...before[0], categoryId: 'bulk-category', budgetId: activeBudget.id })
  assert.deepEqual(await dataOf(income), { ...before[1], budgetId: null })
  assert.deepEqual(await dataOf(categoryOnly), { ...before[2], categoryId: 'bulk-category' })

  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  const transfer = await createTransaction({ type: 'transfer', amount: 17, toAccountId: `${runId}-account-a`, categoryId: '' })
  const account = await createAccount()
  const linked = await createLinkedBudget([account.id])
  const linkedRow = await createTransaction({ accountId: account.id, budgetId: linked.id })
  const stale = transactionRef(id('bulk-stale'))
  await privilegedDocument(`transactions/${stale.id}`, {
    workspaceId: wsA, userId: dualId, accountId: `${runId}-account-a`, amount: -17, currency: 'USD', type: 'expense',
    categoryId: `${runId}-category`, description: 'Stale reference', budgetId: await createDeletedBudget(),
    date: new Date('2026-10-01T00:00:00Z'), createdAt: new Date('2026-10-01T00:00:00Z')
  })
  const valid = await createTransaction()
  const target = await createTransaction()
  for (const [label, invalid] of [
    ['transfer with a budget', [transfer, { budgetId: activeBudget.id }]],
    ['linked account leaving its budget', [linkedRow, { categoryId: 'bulk-category', budgetId: activeBudget.id }]],
    ['archived budget', [target, { categoryId: 'bulk-category', budgetId: archived.id }]],
    ['foreign budget', [target, { categoryId: 'bulk-category', budgetId: foreignBudget.id }]],
    ['category next to a deleted budget', [stale, { categoryId: 'bulk-category' }]]
  ]) {
    await deniedUnchanged(() => commitBulkEdit([[valid, { categoryId: 'bulk-category', budgetId: activeBudget.id }], invalid]))
    assert.equal((await dataOf(valid)).categoryId, `${runId}-category`, label)
  }
  // The same row alone moves to its linked budget, and the stale one takes a category with a new budget.
  await commitBulkEdit([[stale, { categoryId: 'bulk-category', budgetId: activeBudget.id }], [valid, { budgetId: activeBudget.id }]])
  assert.deepEqual([(await dataOf(stale)).budgetId, (await dataOf(valid)).budgetId], [activeBudget.id, activeBudget.id])
})

test('S9: a bulk edit changes a pocket movement and the expense leg of a shared expense alone, never the twin', async () => {
  const parentId = id('bulk-pocket-parent')
  const pocketId = id('bulk-pocket')
  const movementId = id('bulk-pocket-movement')
  await privilegedDocument(`accounts/${parentId}`, {
    workspaceId: wsA, userId: dualId, name: 'Parent', type: 'savings', balance: 100, limit: 0, currency: 'USD',
    childAccountIds: [pocketId], createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`accounts/${pocketId}`, {
    workspaceId: wsA, userId: dualId, name: 'Pocket', type: 'savings', balance: 50, limit: 0, currency: 'USD',
    parentAccountId: parentId, childAccountIds: [], pocketActivity: true, openingAllocationId: null,
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`transactions/${movementId}`, {
    workspaceId: wsA, userId: dualId, accountId: pocketId, toAccountId: null, amount: -10, type: 'expense',
    categoryId: `${runId}-category`, description: 'Pocket purchase', currency: 'USD',
    date: new Date('2026-10-02T12:00:00Z'), createdAt: new Date('2026-10-02T12:00:00Z')
  })
  const legs = await createSharedExpense()
  const pocketBefore = await dataOf(accountRef(pocketId))
  const transferBefore = await dataOf(legs.transferLeg)

  await commitBulkEdit([
    [transactionRef(movementId), { categoryId: 'bulk-category', budgetId: activeBudget.id }],
    [legs.expenseLeg, { categoryId: 'bulk-category', budgetId: activeBudget.id }]
  ])
  const [movement, expenseLeg] = [await dataOf(transactionRef(movementId)), await dataOf(legs.expenseLeg)]
  assert.deepEqual([movement.categoryId, movement.budgetId, movement.amount], ['bulk-category', activeBudget.id, -10])
  assert.deepEqual([expenseLeg.categoryId, expenseLeg.budgetId, expenseLeg.amount], ['bulk-category', activeBudget.id, -30])
  assert.deepEqual(await dataOf(accountRef(pocketId)), pocketBefore, 'no balance or marker changes')
  assert.deepEqual(await dataOf(legs.transferLeg), transferBefore, 'the twin is untouched')

  // The transfer twin never takes a budget, so a batch that includes it is refused whole.
  await deniedUnchanged(() => commitBulkEdit([
    [legs.expenseLeg, { budgetId: null }],
    [legs.transferLeg, { budgetId: activeBudget.id }]
  ]))
})

// S9: the real store's bulkEditTransactions, writing through this emulator as the dual member.
const storeScript = ts.transpile(readFileSync(new URL('../../src/stores/transactionsStore.ts', import.meta.url), 'utf8'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
})
const requireFromStores = createRequire(new URL('../../src/stores/transactionsStore.ts', import.meta.url))
const loadRealStore = (t, accounts) => {
  const accountsStore = { accounts, loadedWorkspaceId: wsA, getAccountById: accountId => accounts.find(account => account.id === accountId), fetchAccounts: async () => true }
  const storeModule = {}
  new Function('exports', 'require', storeScript)(storeModule, moduleId => {
    if (moduleId === '@/lib/firebase') return { db: dual, auth: { currentUser: { uid: dualId } }, storage: {}, functions: {} }
    if (moduleId === './authStore') return { useAuthStore: () => ({ activeWorkspaceId: wsA }) }
    if (moduleId === './accountsStore') return { useAccountsStore: () => accountsStore }
    if (moduleId === 'firebase/firestore') return firestoreSdk
    if (moduleId === 'firebase/functions' || moduleId === 'firebase/storage') return {}
    return requireFromStores(moduleId.startsWith('@/') ? `../${moduleId.slice(2)}.ts` : moduleId)
  })
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  return storeModule.useTransactionsStore(pinia)
}
// The rows as the store keeps them after a load.
const loadRows = refs => Promise.all(refs.map(async ref => {
  const data = await dataOf(ref)
  return { ...data, id: ref.id, date: data.date.toDate() }
}))

test('S9: the store\'s bulk edits commit mixed selections and leave skipped rows, the shared-expense twin and pocket balances untouched', async t => {
  const parentId = id('bulk-store-parent')
  const pocketId = id('bulk-store-pocket')
  await privilegedDocument(`accounts/${parentId}`, {
    workspaceId: wsA, userId: dualId, name: 'Parent', type: 'savings', balance: 100, limit: 0, currency: 'USD',
    childAccountIds: [pocketId], createdAt: new Date('2026-10-01T00:00:00Z')
  })
  await privilegedDocument(`accounts/${pocketId}`, {
    workspaceId: wsA, userId: dualId, name: 'Pocket', type: 'savings', balance: 50, limit: 0, currency: 'USD',
    parentAccountId: parentId, childAccountIds: [], pocketActivity: true, openingAllocationId: null,
    createdAt: new Date('2026-10-01T00:00:00Z')
  })
  // Rows only a privileged writer can leave behind: pocket movements and stale or archived references.
  const privilegedRow = async extra => {
    const ref = transactionRef(id('bulk-store-row'))
    await privilegedDocument(`transactions/${ref.id}`, {
      workspaceId: wsA, userId: dualId, accountId: `${runId}-account-a`, amount: -17, currency: 'USD',
      type: 'expense', categoryId: `${runId}-category`, description: 'Privileged row',
      date: new Date('2026-10-01T00:00:00Z'), createdAt: new Date('2026-10-01T00:00:00Z'), ...extra
    })
    return ref
  }
  const linkedAccount = await createAccount()
  const linkedBudget = await createLinkedBudget([linkedAccount.id])
  const archived = await createBudget()
  await updateDoc(archived, { archived: true, updatedAt: serverTimestamp() })
  const deletedId = await createDeletedBudget()
  const legs = await createSharedExpense()
  const rows = {
    base: await createTransaction(),
    income: await createTransaction({ type: 'income', amount: 17 }),
    active: await createTransaction({ budgetId: activeBudget.id }),
    literal: await createTransaction({ budgetId: 'default-monthly' }),
    archivedRow: await privilegedRow({ budgetId: archived.id }),
    stale: await privilegedRow({ budgetId: deletedId }),
    foreign: await privilegedRow({ budgetId: foreignBudget.id }),
    pocketExpense: await privilegedRow({ accountId: pocketId, toAccountId: null, amount: -10 }),
    pocketIncome: await privilegedRow({ accountId: pocketId, toAccountId: null, amount: 10, type: 'income' }),
    shared: legs.expenseLeg,
    transfer: await createTransaction({ type: 'transfer', amount: 17, toAccountId: `${runId}-account-a`, categoryId: '' }),
    loan: await createTransaction({ type: 'loan', amount: -17, categoryId: '' }),
    linked: await createTransaction({ accountId: linkedAccount.id, budgetId: linkedBudget.id }),
    linkedLegacy: await privilegedRow({ accountId: linkedAccount.id })
  }
  const nameOf = Object.fromEntries(Object.entries(rows).map(([name, ref]) => [ref.id, name]))
  const accounts = [`${runId}-account-a`, linkedAccount.id, parentId, pocketId, (await dataOf(legs.expenseLeg)).accountId].map(accountId => ({ id: accountId }))
  const budgets = [
    { id: activeBudget.id, name: 'Active', archived: false },
    { id: archived.id, name: 'Archived', archived: true },
    { id: linkedBudget.id, name: 'Linked', archived: false, linkedAccountIds: [linkedAccount.id] }
  ]
  const pocketAccountsBefore = await Promise.all([parentId, pocketId].map(accountId => dataOf(accountRef(accountId))))
  const twinBefore = await dataOf(legs.transferLeg)

  // Runs one request through a freshly loaded store; every row must end as before plus its planned patch.
  const run = async (request, names) => {
    const before = Object.fromEntries(await Promise.all(Object.entries(rows).map(async ([name, ref]) => [name, await dataOf(ref)])))
    const store = loadRealStore(t, accounts)
    store.transactions = await loadRows(Object.values(rows))
    store.categories = [{ id: 'bulk-a', type: 'expense' }, { id: 'bulk-b', type: 'expense' }, { id: 'bulk-i', type: 'income' }]
    const outcome = await store.bulkEditTransactions(request, names.map(name => rows[name].id), budgets)
    assert.deepEqual(outcome.failed, [], `${JSON.stringify(request)} commits`)
    const patches = new Map(outcome.plan.updates.map(update => [update.id, update.patch]))
    for (const [name, ref] of Object.entries(rows)) {
      assert.deepEqual(await dataOf(ref), { ...before[name], ...patches.get(ref.id) }, `${name} after ${JSON.stringify(request)}`)
    }
    assert.deepEqual(await dataOf(legs.transferLeg), twinBefore, 'the shared-expense twin is untouched')
    return Object.fromEntries([
      ...outcome.plan.skipped.map(skip => [nameOf[skip.id], skip.reason]),
      ...outcome.plan.updates.map(update => [nameOf[update.id], update.patch])
    ])
  }
  const all = Object.keys(rows)
  const expenses = ['base', 'active', 'literal', 'archivedRow', 'stale', 'foreign', 'pocketExpense', 'shared', 'linked', 'linkedLegacy']
  const intoActive = { budgetId: activeBudget.id }
  const skippedByBudget = { transfer: 'no-budget-type', loan: 'no-budget-type', linked: 'linked-account', linkedLegacy: 'linked-account' }

  assert.deepEqual(await run(intoActive, all), {
    ...Object.fromEntries(['base', 'income', 'literal', 'archivedRow', 'stale', 'foreign', 'pocketExpense', 'pocketIncome', 'shared']
      .map(name => [name, intoActive])),
    active: 'unchanged', ...skippedByBudget
  })
  assert.deepEqual(await run({ budgetId: 'default-monthly' }, all), {
    ...Object.fromEntries(['base', 'income', 'active', 'literal', 'archivedRow', 'stale', 'foreign', 'pocketExpense', 'pocketIncome', 'shared']
      .map(name => [name, { budgetId: null }])),
    ...skippedByBudget
  })

  // Put back the archived, deleted and foreign references for the category requests.
  for (const [name, budgetId] of [['archivedRow', archived.id], ['stale', deletedId], ['foreign', foreignBudget.id]]) {
    await privilegedDocument(`transactions/${rows[name].id}?updateMask.fieldPaths=budgetId`, { budgetId })
  }
  assert.deepEqual(await run({ categoryId: 'bulk-a' }, expenses), {
    ...Object.fromEntries(['base', 'active', 'literal', 'archivedRow', 'pocketExpense', 'shared', 'linked', 'linkedLegacy']
      .map(name => [name, { categoryId: 'bulk-a' }])),
    stale: 'stale-budget', foreign: 'stale-budget'
  })
  assert.deepEqual(await run({ categoryId: 'bulk-b', budgetId: activeBudget.id }, expenses), {
    ...Object.fromEntries(['base', 'active', 'literal', 'archivedRow', 'stale', 'foreign', 'pocketExpense', 'shared']
      .map(name => [name, { categoryId: 'bulk-b', budgetId: activeBudget.id }])),
    linked: 'linked-account', linkedLegacy: 'linked-account'
  })
  assert.deepEqual(await run({ categoryId: 'bulk-i', budgetId: activeBudget.id }, ['income', 'pocketIncome']), {
    income: { categoryId: 'bulk-i', budgetId: activeBudget.id }, pocketIncome: { categoryId: 'bulk-i', budgetId: activeBudget.id }
  })
  assert.deepEqual(await Promise.all([parentId, pocketId].map(accountId => dataOf(accountRef(accountId)))), pocketAccountsBefore, 'pocket balances and markers never change')
})

test('S9: a store chunk the server refuses for a stale row changes nothing and is reported whole, while the full chunk before it commits', async t => {
  const deletedId = await createDeletedBudget()
  // 502 rows: a full chunk of 500, then a chunk of two whose second row turns stale on the server.
  const refs = Array.from({ length: 502 }, (_, index) => transactionRef(id(`bulk-chunk-${index}`)))
  for (let start = 0; start < refs.length; start += 251) {
    const batch = writeBatch(dual)
    for (const ref of refs.slice(start, start + 251)) batch.set(ref, rawTransaction())
    await batch.commit()
  }
  const store = loadRealStore(t, [{ id: `${runId}-account-a` }])
  store.transactions = await loadRows(refs)
  store.categories = [{ id: 'bulk-c', type: 'expense' }]
  // After this client loaded it, another member's edit leaves the last row pointing at a deleted budget.
  await privilegedDocument(`transactions/${refs[501].id}?updateMask.fieldPaths=budgetId`, { budgetId: deletedId })

  const outcome = await store.bulkEditTransactions({ categoryId: 'bulk-c' }, refs.map(ref => ref.id), [{ id: activeBudget.id, name: 'Active', archived: false }])

  assert.deepEqual(outcome.written, refs.slice(0, 500).map(ref => ref.id))
  assert.deepEqual(outcome.failed.map(failure => [failure.ids, failure.error.code]), [[[refs[500].id, refs[501].id], 'permission-denied']])
  const expected = [...Array(500).fill('bulk-c'), `${runId}-category`, `${runId}-category`]
  assert.deepEqual((await Promise.all(refs.map(dataOf))).map(data => data.categoryId), expected)
  assert.deepEqual(store.transactions.map(tx => tx.categoryId), expected, 'only the committed chunk changes local rows')
})
