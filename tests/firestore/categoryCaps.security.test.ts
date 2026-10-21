import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
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
if (!emulator || configuredProject !== projectId) throw new Error('Category-cap tests require the demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`Category-cap tests refuse non-isolated emulator ${emulator}`)

const suiteId = `category-caps-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const terminated = await Promise.allSettled(databases.map(db => terminate(db)))
  const deleted = await Promise.allSettled(apps.map(app => deleteApp(app)))
  const failures = [...terminated, ...deleted].filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up category-cap Firebase clients')
})
const client = (actor, uid) => {
  const app = initializeApp({ projectId }, `${suiteId}-${actor}`)
  apps.push(app)
  const db = getFirestore(app)
  databases.push(db)
  connectFirestoreEmulator(db, host, Number(portText), uid ? {
    mockUserToken: { sub: uid, user_id: uid, firebase: { sign_in_provider: 'custom' } }
  } : undefined)
  return db
}
const memberId = `${suiteId}-member`
const outsiderId = `${suiteId}-outsider`
const dualId = `${suiteId}-dual-member`
const member = client('member', memberId)
const outsider = client('outsider', outsiderId)
const dual = client('dual-member', dualId)
const anonymous = client('anonymous')
const ws = `${suiteId}-workspace`
const foreignWs = `${suiteId}-foreign-workspace`
const outsiderWs = `${suiteId}-outsider-workspace`
const budgetId = `${suiteId}-budget`
const outsiderBudgetId = `${suiteId}-outsider-budget`
const outsiderCategoryId = `${suiteId}-outsider-category`
const categoryId = `${suiteId}-expense-category`
const bothCategoryId = `${suiteId}-both-category`
const incomeCategoryId = `${suiteId}-income-category`
const globalCategoryId = `${suiteId}-global-expense`
const globalBothCategoryId = `${suiteId}-global-both`
const globalIncomeCategoryId = `${suiteId}-global-income`
const foreignCategoryId = `${suiteId}-foreign-category`
const missingWorkspaceCategoryId = `${suiteId}-missing-workspace-category`
const legacyCategoryId = `${suiteId}-legacy-user-category`
const capRef = doc(member, 'budgets', budgetId, 'categoryCaps', categoryId)
const allowed = operation => assert.doesNotReject(operation)
const denied = operation => assert.rejects(operation, error => {
  assert.equal(error.code, 'permission-denied')
  return true
})
const unique = label => `${suiteId}-${label}-${randomUUID()}`
const categoryRef = (database, id) => doc(database, 'categories', id)
const capRefFor = (database, budget, category) => doc(database, 'budgets', budget, 'categoryCaps', category)
const workspaceData = (workspaceId = ws, ownerId = memberId, members = [memberId, dualId]) => ({
  id: workspaceId, name: 'Synthetic category-cap workspace', ownerId, members, currency: 'USD',
  budgetIncome: 1000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
  budgetAllocations: { [`${suiteId}-goal`]: 25 }, categoryBudgets: { [`${suiteId}-legacy`]: 40 },
  exchangeRates: { EUR: 1.1 }, createdAt: serverTimestamp()
})
const rawBudget = (workspaceId = ws) => ({
  workspaceId, kind: 'monthly', name: 'Synthetic budget', capCurrency: 'USD', archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp()
})
const createBudget = async (id = unique('budget'), database = member, workspaceId = ws) => {
  const ref = doc(database, 'budgets', id)
  await setDoc(ref, rawBudget(workspaceId))
  return ref
}
const validCap = (database, budget, category, amount = 12.5) =>
  setDoc(capRefFor(database, budget, category), { amount })
const assertPrivilegedTarget = () => {
  if (configuredProject !== projectId || host !== '127.0.0.1' || Number(portText) !== 8185) {
    throw new Error('Privileged fixtures are restricted to demo-vault-b2 at 127.0.0.1:8185')
  }
}
const privilegedDocument = async (collectionName, id, fields) => {
  assertPrivilegedTarget()
  const encode = value => value === null ? { nullValue: null } :
    value instanceof Date ? { timestampValue: value.toISOString() } :
      Array.isArray(value) ? { arrayValue: { values: value.map(encode) } } :
        value && typeof value === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } } :
          typeof value === 'boolean' ? { booleanValue: value } :
            typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) }
  const response = await fetch(`http://${host}:${portText}/v1/projects/${projectId}/databases/(default)/documents/${collectionName}/${id}`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encode(value)])) })
  })
  if (!response.ok) throw new Error(`Privileged ${collectionName} fixture failed (${response.status}): ${await response.text()}`)
}
const privilegedCategory = (id, fields) => privilegedDocument('categories', id, fields)

before(async () => {
  await privilegedDocument('workspaces', ws, { ...workspaceData(), createdAt: new Date('2026-10-09T12:00:00.000Z') })
  await setDoc(doc(dual, 'workspaces', foreignWs), workspaceData(foreignWs, dualId, [dualId]))
  await setDoc(doc(outsider, 'workspaces', outsiderWs), workspaceData(outsiderWs, outsiderId, [outsiderId]))
  await setDoc(doc(member, 'budgets', budgetId), rawBudget())
  await setDoc(doc(outsider, 'budgets', outsiderBudgetId), rawBudget(outsiderWs))
  await setDoc(categoryRef(outsider, outsiderCategoryId), { workspaceId: outsiderWs, type: 'expense', userId: outsiderId })
  await setDoc(categoryRef(member, categoryId), { workspaceId: ws, type: 'expense', userId: memberId })
  await setDoc(categoryRef(member, bothCategoryId), { workspaceId: ws, type: 'both', userId: memberId })
  await setDoc(categoryRef(member, incomeCategoryId), { workspaceId: ws, type: 'income', userId: memberId })
  await setDoc(categoryRef(dual, foreignCategoryId), { workspaceId: foreignWs, type: 'expense', userId: dualId })
  await privilegedCategory(globalCategoryId, { workspaceId: null, type: 'expense', userId: memberId })
  await privilegedCategory(globalBothCategoryId, { workspaceId: null, type: 'both', userId: memberId })
  await privilegedCategory(globalIncomeCategoryId, { workspaceId: null, type: 'income', userId: memberId })
  await privilegedCategory(missingWorkspaceCategoryId, { type: 'expense', userId: memberId })
  await privilegedCategory(legacyCategoryId, { type: 'expense', userId: memberId })
  const auditTime = new Date('2026-10-09T12:00:00.000Z')
  await privilegedDocument('budgets', 'default-monthly', {
    ...rawBudget(ws), createdAt: auditTime, updatedAt: auditTime
  })
})

test('a workspace member can create a scalar cap for an expense category', async () => {
  await allowed(setDoc(capRef, { amount: 12.5 }))
})

for (const [label, category] of [
  ['local expense', categoryId], ['local both', bothCategoryId],
  ['global expense', globalCategoryId], ['global both', globalBothCategoryId]
]) {
  test(`members can create and update a cap for ${label} categories`, async () => {
    const budget = unique('eligible-budget')
    await createBudget(budget)
    const ref = capRefFor(member, budget, category)
    await allowed(setDoc(ref, { amount: 12.5 }))
    await allowed(updateDoc(ref, { amount: 18 }))
  })
}

for (const [label, amount] of [
  ['zero', 0], ['fraction', 0.125], ['largest finite number', Number.MAX_VALUE]
]) {
  test(`finite nonnegative ${label} caps are accepted on create and update`, async () => {
    const budget = unique('finite-budget')
    await createBudget(budget)
    const ref = capRefFor(member, budget, categoryId)
    await allowed(setDoc(ref, { amount }))
    await allowed(updateDoc(ref, { amount }))
  })
}

for (const [label, amount] of [
  ['negative', -1], ['NaN', NaN], ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['string', '12'], ['null', null], ['map', { value: 12 }]
]) {
  test(`invalid ${label} amounts are denied on create and update`, async () => {
    const existingBudget = unique('invalid-update-budget')
    const createBudgetId = unique('invalid-create-budget')
    await createBudget(existingBudget)
    await createBudget(createBudgetId)
    const existing = capRefFor(member, existingBudget, categoryId)
    const attemptedCreate = capRefFor(member, createBudgetId, categoryId)
    await allowed(setDoc(existing, { amount: 10 }))
    await denied(setDoc(attemptedCreate, { amount }))
    await denied(updateDoc(existing, { amount }))
  })
}

for (const [label, fields] of [
  ['unknown field', { unexpected: true }], ['identity fields', { id: categoryId, userId: memberId }],
  ['workspace field', { workspaceId: ws }], ['currency field', { currency: 'USD' }],
  ['map field', { metadata: { source: 'test' } }]
]) {
  test(`category caps reject ${label} fields on create and update`, async () => {
    const existingBudget = unique('shape-update-budget')
    const createBudgetId = unique('shape-create-budget')
    await createBudget(existingBudget)
    await createBudget(createBudgetId)
    const existing = capRefFor(member, existingBudget, categoryId)
    await allowed(setDoc(existing, { amount: 10 }))
    await denied(setDoc(capRefFor(member, createBudgetId, categoryId), { amount: 11, ...fields }))
    await denied(updateDoc(existing, fields))
  })
}

test('category cap amount is required and cannot be removed by update', async () => {
  const budget = unique('required-amount-budget')
  await createBudget(budget)
  const ref = capRefFor(member, budget, categoryId)
  await allowed(setDoc(ref, { amount: 10 }))
  await denied(setDoc(capRefFor(member, budget, bothCategoryId), {}))
  await denied(updateDoc(ref, { amount: deleteField() }))
})

for (const [label, category] of [
  ['income', incomeCategoryId], ['global income', globalIncomeCategoryId],
  ['foreign workspace', foreignCategoryId], ['missing workspace', missingWorkspaceCategoryId],
  ['legacy userId only', legacyCategoryId], ['missing category', unique('absent-category')]
]) {
  test(`cap creation is denied for ${label} categories`, async () => {
    const budget = unique('ineligible-budget')
    await createBudget(budget)
    await denied(setDoc(capRefFor(member, budget, category), { amount: 12 }))
  })
}

for (const [label, stageChange, applyChange] of [
  ['income transition', (batch, ref) => batch.update(ref, { type: 'income' }), ref => updateDoc(ref, { type: 'income' })],
  ['foreign-workspace transition', (batch, ref) => batch.update(ref, { workspaceId: foreignWs }), ref => updateDoc(ref, { workspaceId: foreignWs })],
  ['missing-workspace transition', (batch, ref) => batch.update(ref, { workspaceId: deleteField() }), ref => updateDoc(ref, { workspaceId: deleteField() })],
  ['legacy userId-only transition', (batch, ref) => batch.set(ref, { type: 'expense', userId: memberId }), ref => setDoc(ref, { type: 'expense', userId: memberId })],
  ['category deletion', (batch, ref) => batch.delete(ref), ref => deleteDoc(ref)]
]) {
  test(`getAfter category ${label} denies cap create and update`, async () => {
    const budget = unique('category-poststate-update-budget')
    const createBudgetId = unique('category-poststate-create-budget')
    const category = unique('category-poststate')
    await createBudget(budget)
    await createBudget(createBudgetId)
    const categoryDocument = categoryRef(member, category)
    const cap = capRefFor(member, budget, category)
    await setDoc(categoryDocument, { workspaceId: ws, type: 'expense', userId: memberId })
    await allowed(setDoc(cap, { amount: 12 }))

    const createBatch = writeBatch(member)
    stageChange(createBatch, categoryDocument)
    createBatch.set(capRefFor(member, createBudgetId, category), { amount: 13 })
    await denied(createBatch.commit())

    const updateBatch = writeBatch(member)
    stageChange(updateBatch, categoryDocument)
    updateBatch.update(cap, { amount: 14 })
    await denied(updateBatch.commit())

    await allowed(applyChange(categoryDocument))
    await denied(setDoc(capRefFor(member, createBudgetId, category), { amount: 15 }))
    await denied(updateDoc(cap, { amount: 16 }))
  })
}

test('category creation and cap creation in one batch use the eligible post-state', async () => {
  const budget = unique('category-create-batch-budget')
  const category = unique('category-create-batch')
  await createBudget(budget)
  const batch = writeBatch(member)
  batch.set(categoryRef(member, category), { workspaceId: ws, type: 'both', userId: memberId })
  batch.set(capRefFor(member, budget, category), { amount: 32 })
  await allowed(batch.commit())
})

test('getAfter rejects a cap create batched with parent archival', async () => {
  const control = await createBudget(unique('archive-control-budget'))
  await allowed(updateDoc(control, { archived: true, updatedAt: serverTimestamp() }))
  const budget = unique('archive-cap-create-budget')
  const parent = await createBudget(budget)
  const batch = writeBatch(member)
  batch.update(parent, { archived: true, updatedAt: serverTimestamp() })
  batch.set(capRefFor(member, budget, bothCategoryId), { amount: 13 })
  await denied(batch.commit())
  assert.equal((await getDoc(parent)).data().archived, false)
})

test('default, missing, and unauthorized budget parents deny cap access', async () => {
  await denied(setDoc(capRefFor(member, 'default-monthly', categoryId), { amount: 12 }))
  await denied(setDoc(capRefFor(member, unique('missing-parent'), categoryId), { amount: 12 }))
  await denied(setDoc(capRefFor(member, outsiderBudgetId, outsiderCategoryId), { amount: 12 }))
})

test('a member cannot get or list caps under another workspace parent', async () => {
  const budget = unique('foreign-read-budget')
  const category = unique('foreign-read-category')
  await createBudget(budget, outsider, outsiderWs)
  await setDoc(categoryRef(outsider, category), { workspaceId: outsiderWs, type: 'expense', userId: outsiderId })
  await allowed(validCap(outsider, budget, category, 8))
  await denied(getDoc(capRefFor(member, budget, category)))
  await denied(getDocs(collection(member, 'budgets', budget, 'categoryCaps')))
})

test('a member of two workspaces cannot use the other workspace category under this budget', async () => {
  const budget = unique('dual-member-budget')
  await createBudget(budget)
  await denied(setDoc(capRefFor(dual, budget, foreignCategoryId), { amount: 12 }))
})

for (const [label, actor] of [['anonymous', anonymous], ['outsider', outsider]]) {
  test(`${label} cannot create, get, list, update, or delete a valid existing cap`, async () => {
    const budget = unique(`${label}-access-budget`)
    await createBudget(budget)
    const existing = capRefFor(member, budget, categoryId)
    await allowed(setDoc(existing, { amount: 12 }))
    await denied(setDoc(capRefFor(actor, budget, bothCategoryId), { amount: 13 }))
    await denied(getDoc(capRefFor(actor, budget, categoryId)))
    await denied(getDocs(collection(actor, 'budgets', budget, 'categoryCaps')))
    await denied(updateDoc(capRefFor(actor, budget, categoryId), { amount: 14 }))
    await denied(deleteDoc(capRefFor(actor, budget, categoryId)))
  })
}

