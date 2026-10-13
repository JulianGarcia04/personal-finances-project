import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc
} from 'firebase/firestore'
import {
  buildBudgetCategoryCapsRecord,
  createBudgetCategoryCapsPersistence,
  decodeBudgetCategoryCap
} from '../../src/lib/budgetCategoryCapsPersistence.ts'

setLogLevel('silent')
const projectId = 'demo-vault-b2'
const emulator = process.env.FIRESTORE_EMULATOR_HOST
const configuredProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
if (!emulator || configuredProject !== projectId) throw new Error('Category-cap persistence tests require demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`Category-cap persistence tests refuse non-isolated emulator ${emulator}`)

const suiteId = `category-cap-persistence-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const terminated = await Promise.allSettled(databases.map(db => terminate(db)))
  const deleted = await Promise.allSettled(apps.map(app => deleteApp(app)))
  const failures = [...terminated, ...deleted].filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up category-cap persistence Firebase clients')
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
const workspaceId = `${suiteId}-workspace`
const foreignWorkspaceId = `${suiteId}-foreign-workspace`
const outsiderWorkspaceId = `${suiteId}-outsider-workspace`
const budgetId = `${suiteId}-budget`
const foreignBudgetId = `${suiteId}-foreign-budget`
const outsiderBudgetId = `${suiteId}-outsider-budget`
const categoryId = `${suiteId}-expense-category`
const bothCategoryId = `${suiteId}-both-category`
const incomeCategoryId = `${suiteId}-income-category`
const foreignCategoryId = `${suiteId}-foreign-category`
const accountId = `${suiteId}-account`
const transactionId = `${suiteId}-transaction`
const workspaceRef = (database, id) => doc(database, 'workspaces', id)
const budgetRef = (database, id) => doc(database, 'budgets', id)
const categoryRef = (database, id) => doc(database, 'categories', id)
const capRef = (database, budget, category) => doc(database, 'budgets', budget, 'categoryCaps', category)
const unique = label => `${suiteId}-${label}-${randomUUID()}`
const permissionDenied = operation => assert.rejects(operation, error => {
  assert.equal(error.code, 'permission-denied')
  return true
})
const workspaceData = (id, ownerId, members) => ({
  id, name: 'Synthetic cap persistence workspace', ownerId, members, currency: 'USD',
  budgetIncome: 1000, budgetNeedsPercent: 50, budgetWantsPercent: 30, budgetSavingsPercent: 20,
  budgetAllocations: { [`${suiteId}-goal`]: 25 }, categoryBudgets: { [`${suiteId}-legacy`]: 40 },
  exchangeRates: { EUR: 1.1 }, createdAt: serverTimestamp()
})
const rawBudget = (workspace = workspaceId) => ({
  workspaceId: workspace, kind: 'monthly', name: 'Synthetic cap persistence budget', capCurrency: 'USD', archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp()
})
const createBudget = async (database, id, workspace = workspaceId) => {
  const ref = budgetRef(database, id)
  await setDoc(ref, rawBudget(workspace))
  return ref
}
const assertPrivilegedTarget = () => {
  if (configuredProject !== projectId || host !== '127.0.0.1' || Number(portText) !== 8185) {
    throw new Error('Privileged fixtures are restricted to demo-vault-b2 at 127.0.0.1:8185')
  }
}
const privilegedDocument = async (path, values) => {
  assertPrivilegedTarget()
  const encode = value => value instanceof Date ? { timestampValue: value.toISOString() } :
    value === null ? { nullValue: null } : typeof value === 'boolean' ? { booleanValue: value } :
      typeof value === 'number' ? { doubleValue: value } : { stringValue: value }
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encode(value)]))
  const urlPath = path.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(`http://${host}:${portText}/v1/projects/${projectId}/databases/(default)/documents/${urlPath}`, {
    method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields })
  })
  if (!response.ok) throw new Error(`Privileged fixture failed (${response.status}): ${await response.text()}`)
}

before(async () => {
  await setDoc(workspaceRef(member, workspaceId), workspaceData(workspaceId, memberId, [memberId, dualId]))
  await setDoc(workspaceRef(dual, foreignWorkspaceId), workspaceData(foreignWorkspaceId, dualId, [dualId]))
  await setDoc(workspaceRef(outsider, outsiderWorkspaceId), workspaceData(outsiderWorkspaceId, outsiderId, [outsiderId]))
  await createBudget(member, budgetId)
  await createBudget(dual, foreignBudgetId, foreignWorkspaceId)
  await createBudget(outsider, outsiderBudgetId, outsiderWorkspaceId)
  await setDoc(categoryRef(member, categoryId), { workspaceId, type: 'expense', userId: memberId })
  await setDoc(categoryRef(member, bothCategoryId), { workspaceId, type: 'both', userId: memberId })
  await setDoc(categoryRef(member, incomeCategoryId), { workspaceId, type: 'income', userId: memberId })
  await setDoc(categoryRef(dual, foreignCategoryId), { workspaceId: foreignWorkspaceId, type: 'expense', userId: dualId })
  await setDoc(doc(member, 'accounts', accountId), {
    id: accountId, workspaceId, userId: memberId, name: 'Synthetic account', type: 'checking', balance: 420,
    currency: 'USD', createdAt: serverTimestamp()
  })
  await setDoc(doc(member, 'transactions', transactionId), {
    id: transactionId, workspaceId, userId: memberId, accountId, amount: -17, description: 'Synthetic ledger fixture',
    categoryId, date: new Date('2026-10-08T00:00:00.000Z'), type: 'expense', currency: 'USD', createdAt: serverTimestamp()
  })
  await setDoc(capRef(member, budgetId, categoryId), { amount: 9 })
})

test('set/read/list/remove round-trip exact scalar caps without changing parent or financial data', async () => {
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  const refs = [budgetRef(member, budgetId), workspaceRef(member, workspaceId), doc(member, 'accounts', accountId), doc(member, 'transactions', transactionId)]
  const beforeState = await Promise.all(refs.map(async ref => (await getDoc(ref)).data()))
  await caps.set(budgetId, categoryId, 12.5)
  assert.equal(await caps.read(budgetId, categoryId), 12.5)
  assert.deepEqual(await caps.list(budgetId), { [categoryId]: 12.5 })
  assert.deepEqual((await getDoc(capRef(member, budgetId, categoryId))).data(), { amount: 12.5 })
  assert.equal(await caps.read(budgetId, unique('missing-cap')), undefined)
  assert.deepEqual(await caps.list(budgetId), { [categoryId]: 12.5 })
  const afterState = await Promise.all(refs.map(async ref => (await getDoc(ref)).data()))
  assert.deepEqual(afterState, beforeState)
  await caps.remove(budgetId, categoryId)
  assert.equal(await caps.read(budgetId, categoryId), undefined)
  assert.deepEqual(await caps.list(budgetId), {})
})

test('finite nonnegative amounts include zero, fractions, and Number.MAX_VALUE', async () => {
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  for (const amount of [0, 0.125, Number.MAX_VALUE]) {
    await caps.set(budgetId, categoryId, amount)
    assert.equal(await caps.read(budgetId, categoryId), amount)
  }
  for (const amount of [-1, NaN, Infinity, -Infinity, '12', null, undefined]) {
    await assert.rejects(caps.set(budgetId, categoryId, amount), /finite nonnegative number/)
  }
})

test('strict cap decoder accepts only an own finite nonnegative amount field', () => {
  assert.equal(decodeBudgetCategoryCap({ amount: 0 }), 0)
  assert.equal(decodeBudgetCategoryCap({ amount: Number.MAX_VALUE }), Number.MAX_VALUE)
  let getterInvoked = false
  const getterAmount = Object.defineProperty({}, 'amount', {
    enumerable: true,
    get: () => {
      getterInvoked = true
      return 12.5
    }
  })
  assert.throws(() => decodeBudgetCategoryCap(getterAmount))
  assert.equal(getterInvoked, false)
  const hiddenAmount = Object.defineProperty({}, 'amount', {
    value: 12.5,
    enumerable: false
  })
  assert.throws(() => decodeBudgetCategoryCap(hiddenAmount))
  const inherited = Object.create({ amount: 12.5 })
  for (const wire of [null, [], {}, inherited, { amount: '12' }, { amount: -1 }, { amount: NaN }, { amount: Infinity },
    { amount: 1, id: 'identity' }, { amount: 1, workspaceId }, { amount: 1, currency: 'USD' }, { amount: 1, values: {} }]) {
    assert.throws(() => decodeBudgetCategoryCap(wire))
  }
})

test('cap maps preserve prototype-sensitive keys as own enumerable properties on a plain record', async () => {
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  for (const id of ['constructor', 'toString']) {
    await setDoc(categoryRef(member, id), { workspaceId, type: 'expense', userId: memberId })
    await caps.set(budgetId, id, 3)
  }
  const listed = await caps.list(budgetId)
  assert.equal(Object.getPrototypeOf(listed), Object.prototype)
  for (const id of ['constructor', 'toString']) {
    assert.equal(Object.hasOwn(listed, id), true)
    assert.equal(Object.keys(listed).includes(id), true)
    assert.equal(listed[id], 3)
  }
  // Firestore reserves this document ID, so exercise the exact record builder list uses directly.
  const protoSensitive = buildBudgetCategoryCapsRecord([['__proto__', { amount: 4 }]])
  assert.equal(Object.getPrototypeOf(protoSensitive), Object.prototype)
  assert.equal(Object.hasOwn(protoSensitive, '__proto__'), true)
  assert.equal(Object.keys(protoSensitive).includes('__proto__'), true)
  assert.equal(protoSensitive.__proto__, 4)
})

test('archived orphan caps remain readable while archived mutations are rejected', async () => {
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  const orphanBudgetId = unique('archived-orphan-budget')
  const orphanCategoryId = unique('archived-orphan-category')
  const parent = await createBudget(member, orphanBudgetId)
  await setDoc(categoryRef(member, orphanCategoryId), { workspaceId, type: 'expense', userId: memberId })
  await caps.set(orphanBudgetId, orphanCategoryId, 19)
  await deleteDoc(categoryRef(member, orphanCategoryId))
  await updateDoc(parent, { archived: true, updatedAt: serverTimestamp() })
  assert.equal(await caps.read(orphanBudgetId, orphanCategoryId), 19)
  assert.deepEqual(await caps.list(orphanBudgetId), { [orphanCategoryId]: 19 })
  await assert.rejects(caps.set(orphanBudgetId, orphanCategoryId, 20), /Archived budgets/)
  await assert.rejects(caps.remove(orphanBudgetId, orphanCategoryId), /Archived budgets/)
})

test('captured workspace rejects foreign, missing, malformed, and default parents without empty fallbacks', async () => {
  const caps = createBudgetCategoryCapsPersistence(dual, workspaceId)
  for (const operation of [caps.read(foreignBudgetId, foreignCategoryId), caps.list(foreignBudgetId),
    caps.set(foreignBudgetId, foreignCategoryId, 2), caps.remove(foreignBudgetId, foreignCategoryId)]) {
    await assert.rejects(operation, /different workspace/)
  }
  const missing = unique('missing-parent')
  for (const operation of [caps.read(missing, categoryId), caps.list(missing), caps.set(missing, categoryId, 2), caps.remove(missing, categoryId)]) {
    await assert.rejects(operation)
  }
  const malformed = unique('malformed-parent')
  await privilegedDocument(`budgets/${malformed}`, { workspaceId, archived: false })
  for (const operation of [caps.read(malformed, categoryId), caps.list(malformed), caps.set(malformed, categoryId, 2), caps.remove(malformed, categoryId)]) {
    await assert.rejects(operation, /Malformed budget/)
  }
  await assert.rejects(caps.list('default-monthly'), /Invalid budget ID/)
})

test('unauthorized clients receive permission errors for cap read/list/set/remove', async () => {
  for (const database of [outsider, anonymous]) {
    const caps = createBudgetCategoryCapsPersistence(database, workspaceId)
    await permissionDenied(caps.read(budgetId, categoryId))
    await permissionDenied(caps.read(budgetId, unique('missing-cap')))
    await permissionDenied(caps.list(budgetId))
    await permissionDenied(caps.set(budgetId, bothCategoryId, 2))
    await permissionDenied(caps.remove(budgetId, categoryId))
  }
})

test('category eligibility stays with Firestore rules and stored malformed caps are rejected', async () => {
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  await permissionDenied(caps.set(budgetId, incomeCategoryId, 2))
  const malformedCategory = unique('malformed-cap-category')
  await privilegedDocument(`budgets/${budgetId}/categoryCaps/${malformedCategory}`, { amount: 'not-a-number' })
  await assert.rejects(caps.read(budgetId, malformedCategory))
})

test('factory and operation paths reject invalid workspace and document segments early', async () => {
  assert.throws(() => createBudgetCategoryCapsPersistence(member, ''), /Invalid workspace ID/)
  const caps = createBudgetCategoryCapsPersistence(member, workspaceId)
  for (const invalid of ['', ' ', '.', '..', 'bad/category', '__proto__']) {
    await assert.rejects(caps.read(invalid, categoryId), /Invalid budget ID/)
    await assert.rejects(caps.read(budgetId, invalid), /Invalid category ID/)
  }
  await assert.rejects(caps.read('default-monthly', categoryId), /Invalid budget ID/)
})
