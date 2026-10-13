import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  serverTimestamp,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc,
  writeBatch
} from 'firebase/firestore'

setLogLevel('silent')
const projectId = 'demo-vault-b2'
const emulator = process.env.FIRESTORE_EMULATOR_HOST
const configuredProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
if (!emulator || configuredProject !== projectId) throw new Error('Category-cap lifecycle tests require the demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`Category-cap lifecycle tests refuse non-isolated emulator ${emulator}`)

const suiteId = `category-cap-lifecycle-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const terminated = await Promise.allSettled(databases.map(db => terminate(db)))
  const deleted = await Promise.allSettled(apps.map(app => deleteApp(app)))
  const failures = [...terminated, ...deleted].filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up category-cap lifecycle Firebase clients')
})
const client = (actor, uid) => {
  const app = initializeApp({ projectId }, `${suiteId}-${actor}`)
  apps.push(app)
  const db = getFirestore(app)
  databases.push(db)
  connectFirestoreEmulator(db, host, Number(portText), { mockUserToken: {
    sub: uid, user_id: uid, firebase: { sign_in_provider: 'custom' }
  } })
  return db
}
const memberId = `${suiteId}-member`
const member = client('member', memberId)
const workspaceId = `${suiteId}-workspace`
const expenseCategoryId = `${suiteId}-expense-category`
const bothCategoryId = `${suiteId}-both-category`
const allowed = operation => assert.doesNotReject(operation)
const denied = operation => assert.rejects(operation, error => {
  assert.equal(error.code, 'permission-denied')
  return true
})
const unique = label => `${suiteId}-${label}-${randomUUID()}`
const categoryRef = id => doc(member, 'categories', id)
const capRef = (budgetId, categoryId) => doc(member, 'budgets', budgetId, 'categoryCaps', categoryId)
const workspaceData = () => ({
  id: workspaceId, name: 'Synthetic lifecycle workspace', ownerId: memberId, members: [memberId], currency: 'USD',
  budgetIncome: 1000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
  budgetAllocations: { [`${suiteId}-goal`]: 25 }, categoryBudgets: { [`${suiteId}-legacy`]: 40 },
  exchangeRates: { EUR: 1.1 }, createdAt: serverTimestamp()
})
const rawBudget = () => ({
  workspaceId, kind: 'monthly', name: 'Synthetic lifecycle budget', capCurrency: 'USD', archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp()
})
const createBudget = async (id = unique('budget')) => {
  const ref = doc(member, 'budgets', id)
  await setDoc(ref, rawBudget())
  return ref
}

before(async () => {
  await setDoc(doc(member, 'workspaces', workspaceId), workspaceData())
  await setDoc(categoryRef(expenseCategoryId), { workspaceId, type: 'expense', userId: memberId })
  await setDoc(categoryRef(bothCategoryId), { workspaceId, type: 'both', userId: memberId })
  await setDoc(doc(member, 'accounts', `${suiteId}-account`), {
    id: `${suiteId}-account`, workspaceId, userId: memberId, name: 'Synthetic lifecycle account',
    type: 'checking', balance: 420, currency: 'USD', createdAt: serverTimestamp()
  })
  await setDoc(doc(member, 'transactions', `${suiteId}-transaction`), {
    id: `${suiteId}-transaction`, workspaceId, userId: memberId, accountId: `${suiteId}-account`,
    amount: -17, description: 'Synthetic lifecycle ledger fixture', categoryId: expenseCategoryId,
    date: new Date('2026-10-08T00:00:00.000Z'), type: 'expense', currency: 'USD', createdAt: serverTimestamp()
  })
})

test('active orphan caps remain readable and can be removed without their category', async () => {
  const budget = unique('orphan-budget')
  const category = unique('orphan-category')
  await createBudget(budget)
  const cap = capRef(budget, category)
  await setDoc(categoryRef(category), { workspaceId, type: 'expense', userId: memberId })
  await allowed(setDoc(cap, { amount: 24 }))
  await allowed(deleteDoc(categoryRef(category)))
  assert.equal((await getDoc(cap)).exists(), true)
  assert.equal((await getDocs(collection(member, 'budgets', budget, 'categoryCaps'))).size, 1)
  await allowed(deleteDoc(cap))

  const batchBudget = unique('orphan-delete-batch-budget')
  const batchCategory = unique('orphan-delete-batch-category')
  await createBudget(batchBudget)
  const batchCap = capRef(batchBudget, batchCategory)
  await setDoc(categoryRef(batchCategory), { workspaceId, type: 'expense', userId: memberId })
  await allowed(setDoc(batchCap, { amount: 25 }))
  const batch = writeBatch(member)
  batch.delete(categoryRef(batchCategory))
  batch.delete(batchCap)
  await allowed(batch.commit())
})

test('a valid archived parent remains readable and denies every cap mutation', async () => {
  const budget = unique('archived-budget')
  const parent = await createBudget(budget)
  const existing = capRef(budget, expenseCategoryId)
  await setDoc(existing, { amount: 12 })
  await allowed(updateDoc(parent, { archived: true, updatedAt: serverTimestamp() }))
  assert.equal((await getDoc(existing)).exists(), true)
  assert.equal((await getDocs(collection(member, 'budgets', budget, 'categoryCaps'))).size, 1)
  await denied(setDoc(capRef(budget, bothCategoryId), { amount: 13 }))
  await denied(updateDoc(existing, { amount: 14 }))
  await denied(deleteDoc(existing))
})

test('an archived orphan cap cannot be removed', async () => {
  const budget = unique('archived-orphan-budget')
  const category = unique('archived-orphan-category')
  const parent = await createBudget(budget)
  const cap = capRef(budget, category)
  await setDoc(categoryRef(category), { workspaceId, type: 'expense', userId: memberId })
  await allowed(setDoc(cap, { amount: 19 }))
  await allowed(deleteDoc(categoryRef(category)))
  await allowed(updateDoc(parent, { archived: true, updatedAt: serverTimestamp() }))
  await denied(deleteDoc(cap))
})

test('archive plus cap create, update, or delete is denied using valid parent data', async () => {
  for (const operation of ['create', 'update', 'delete']) {
    const budget = unique(`archive-${operation}-budget`)
    const parent = await createBudget(budget)
    const existing = capRef(budget, expenseCategoryId)
    if (operation !== 'create') await setDoc(existing, { amount: 12 })
    const batch = writeBatch(member)
    batch.update(parent, { archived: true, updatedAt: serverTimestamp() })
    if (operation === 'create') batch.set(capRef(budget, bothCategoryId), { amount: 13 })
    if (operation === 'update') batch.update(existing, { amount: 14 })
    if (operation === 'delete') batch.delete(existing)
    await denied(batch.commit())
    assert.equal((await getDoc(parent)).data().archived, false)
    if (operation !== 'create') assert.equal((await getDoc(existing)).data().amount, 12)
  }
})

test('cap access leaves parent audit, event dates, totals, currency, and other financial fixtures unchanged', async () => {
  const budget = unique('preserved-event-budget')
  const parent = doc(member, 'budgets', budget)
  const startDate = new Date('2026-10-01T00:00:00.000Z')
  const endDate = new Date('2027-10-01T00:00:00.000Z')
  await setDoc(parent, { ...rawBudget(), kind: 'event', totalLimit: 500, startDate, endDate })
  const workspace = doc(member, 'workspaces', workspaceId)
  const account = doc(member, 'accounts', `${suiteId}-account`)
  const transaction = doc(member, 'transactions', `${suiteId}-transaction`)
  const before = {
    budget: (await getDoc(parent)).data(), workspace: (await getDoc(workspace)).data(),
    account: (await getDoc(account)).data(), transaction: (await getDoc(transaction)).data()
  }
  await allowed(setDoc(capRef(budget, expenseCategoryId), { amount: 45.5 }))
  const after = {
    budget: (await getDoc(parent)).data(), workspace: (await getDoc(workspace)).data(),
    account: (await getDoc(account)).data(), transaction: (await getDoc(transaction)).data()
  }
  assert.equal(after.budget.workspaceId, before.budget.workspaceId)
  assert.equal(after.budget.kind, before.budget.kind)
  assert.equal(after.budget.capCurrency, before.budget.capCurrency)
  assert.equal(after.budget.totalLimit, before.budget.totalLimit)
  assert.equal(after.budget.startDate.toMillis(), before.budget.startDate.toMillis())
  assert.equal(after.budget.endDate.toMillis(), before.budget.endDate.toMillis())
  assert.equal(after.budget.createdAt.toMillis(), before.budget.createdAt.toMillis())
  assert.equal(after.budget.updatedAt.toMillis(), before.budget.updatedAt.toMillis())
  for (const field of ['budgetIncome', 'budgetNeedsPercent', 'budgetWantsPercent', 'budgetSavingsPercent', 'budgetAllocations', 'categoryBudgets', 'exchangeRates']) {
    assert.deepEqual(after.workspace[field], before.workspace[field])
  }
  assert.deepEqual(after.account, before.account)
  assert.deepEqual(after.transaction, before.transaction)
})

test('category-cap children have no arbitrary count ceiling', async () => {
  const budget = unique('many-caps-budget')
  await createBudget(budget)
  const categories = Array.from({ length: 12 }, () => unique('many-caps-category'))
  for (const category of categories) {
    await setDoc(categoryRef(category), { workspaceId, type: 'expense', userId: memberId })
  }
  for (const category of categories) await allowed(setDoc(capRef(budget, category), { amount: 1 }))
})
