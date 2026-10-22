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
  await deniedUnchanged(() => updateDoc(income, { budgetId: 'default-monthly', amount: 18 }))
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
  const bridge = await createAccount({ mirror })
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
  // Without a type switch the budget still cannot change together with ledger fields.
  const kept = await createTransaction({ budgetId: activeBudget.id })
  await deniedUnchanged(() => updateDoc(kept, { amount: -30, budgetId: deleteField() }))
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
