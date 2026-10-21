import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import {
  Timestamp,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc,
  where
} from 'firebase/firestore'

setLogLevel('silent')
const projectId = 'demo-vault-b2'
const emulator = process.env.FIRESTORE_EMULATOR_HOST
const configuredProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
if (!emulator || configuredProject !== projectId) throw new Error('B2S tests require the demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`B2S tests refuse non-isolated emulator ${emulator}`)

const runId = `b2s-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const terminated = await Promise.allSettled(databases.map(db => terminate(db)))
  const deleted = await Promise.allSettled(apps.map(app => deleteApp(app)))
  const failures = [...terminated, ...deleted].filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to clean up B2S Firebase clients')
})
const client = (actor, uid) => {
  const app = initializeApp({ projectId }, `${runId}-${actor}`)
  apps.push(app)
  const db = getFirestore(app)
  databases.push(db)
  connectFirestoreEmulator(db, host, Number(portText), uid ? {
    mockUserToken: { sub: uid, user_id: uid, firebase: { sign_in_provider: 'custom' } }
  } : undefined)
  return db
}
const memberId = `${runId}-member`
const dualId = `${runId}-dual`
const member = client('member', memberId)
const outsider = client('outsider', `${runId}-outsider`)
const dual = client('dual-member', dualId)
const anonymous = client('anonymous')
const ws = { member: `${runId}-ws-member`, dualA: `${runId}-ws-a`, dualB: `${runId}-ws-b` }
const id = label => `${runId}-${label}`
const allowed = operation => assert.doesNotReject(operation)
const denied = operation => assert.rejects(operation, error =>
  error.code === 'permission-denied' || /PERMISSION_DENIED/.test(error.message)
)
const workspaceData = (workspaceId, uid) => ({
  id: workspaceId, name: 'Synthetic workspace', ownerId: uid, members: [uid], currency: 'USD', createdAt: serverTimestamp()
})
const rawBudget = (workspaceId, extra = {}) => ({
  workspaceId, kind: 'monthly', name: 'Synthetic budget', capCurrency: 'USD', archived: false,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra
})
const writeRaw = (db, budgetId, data) => setDoc(doc(db, 'budgets', budgetId), data)

before(async () => {
  await setDoc(doc(member, 'workspaces', ws.member), workspaceData(ws.member, memberId))
  await setDoc(doc(dual, 'workspaces', ws.dualA), workspaceData(ws.dualA, dualId))
  await setDoc(doc(dual, 'workspaces', ws.dualB), workspaceData(ws.dualB, dualId))
})

test('members can create, update, read, and query only their workspace budgets', async () => {
  const own = doc(member, 'budgets', id('member-budget'))
  await allowed(setDoc(own, rawBudget(ws.member)))
  await allowed(updateDoc(own, { name: 'Member update', updatedAt: serverTimestamp() }))
  assert.equal((await getDoc(own)).data().name, 'Member update')
  const memberResults = await getDocs(query(collection(member, 'budgets'), where('workspaceId', '==', ws.member)))
  assert.ok(memberResults.docs.some(snapshot => snapshot.id === own.id))

  const dualA = doc(dual, 'budgets', id('dual-a-budget'))
  const dualB = doc(dual, 'budgets', id('dual-b-budget'))
  await allowed(setDoc(dualA, rawBudget(ws.dualA)))
  await allowed(setDoc(dualB, rawBudget(ws.dualB)))
  assert.deepEqual((await getDocs(query(collection(dual, 'budgets'), where('workspaceId', '==', ws.dualA)))).docs.map(doc => doc.id), [dualA.id])
  assert.deepEqual((await getDocs(query(collection(dual, 'budgets'), where('workspaceId', '==', ws.dualB)))).docs.map(doc => doc.id), [dualB.id])
})

test('outsider and anonymous CRUD/query attempts are denied with valid payloads', async () => {
  const ref = doc(member, 'budgets', id('protected-budget'))
  await allowed(setDoc(ref, rawBudget(ws.member)))
  for (const [actor, name] of [[outsider, 'outsider'], [anonymous, 'anonymous']]) {
    await denied(getDoc(doc(actor, 'budgets', ref.id)))
    await denied(getDocs(query(collection(actor, 'budgets'), where('workspaceId', '==', ws.member))))
    await denied(writeRaw(actor, id(`create-${name}`), rawBudget(ws.member)))
    await denied(updateDoc(doc(actor, 'budgets', ref.id), { name: 'Valid attempted edit', updatedAt: serverTimestamp() }))
    await denied(deleteDoc(doc(actor, 'budgets', ref.id)))
  }
  await denied(getDocs(collection(dual, 'budgets')))
  await denied(deleteDoc(ref))
})

test('finite nonnegative limits accept absent, zero, fractional, and large finite values only', async () => {
  for (const [label, extra] of [
    ['absent', {}], ['zero', { totalLimit: 0 }], ['fraction', { totalLimit: 0.125 }],
    ['large-finite', { totalLimit: Number.MAX_VALUE }]
  ]) await allowed(writeRaw(member, id(label), rawBudget(ws.member, extra)))

  for (const [label, value] of [
    ['nan', Number.NaN], ['positive-infinity', Infinity], ['negative-infinity', -Infinity],
    ['string', '10'], ['null', null], ['map', { value: 1 }], ['negative', -0.01]
  ]) await denied(writeRaw(member, id(label), rawBudget(ws.member, { totalLimit: value })))

  const ref = doc(member, 'budgets', id('limit-update'))
  await allowed(setDoc(ref, rawBudget(ws.member, { totalLimit: 12 })))
  for (const value of [Number.NaN, Infinity, -Infinity, '12', null, { value: 1 }, -1]) {
    await denied(updateDoc(ref, { totalLimit: value, updatedAt: serverTimestamp() }))
  }
  await allowed(updateDoc(ref, { totalLimit: deleteField(), updatedAt: serverTimestamp() }))
  assert.equal(Object.hasOwn((await getDoc(ref)).data(), 'totalLimit'), false)
})

test('create and update enforce exact shape, required fields, immutability, and chronology', async () => {
  for (const [label, extra] of [
    ['blank-name', { name: '   ' }], ['long-name', { name: 'x'.repeat(101) }], ['wrong-name-type', { name: 1 }],
    ['bad-currency', { capCurrency: 'usd' }], ['wrong-currency-type', { capCurrency: 3 }],
    ['wrong-kind', { kind: 'annual' }], ['wrong-workspace-type', { workspaceId: { id: 'bad' } }],
    ['archived-create', { archived: true }], ['wrong-archive-type', { archived: 'false' }],
    ['null-date', { startDate: null }], ['stale-created-at', { createdAt: Timestamp.fromMillis(1) }],
    ['bad-updated-at', { updatedAt: 'not-a-timestamp' }], ['extra-map', { metadata: { arbitrary: true } }],
    ['monthly-date', { startDate: Timestamp.fromMillis(0) }], ['wrong-workspace', { workspaceId: ws.dualA }]
  ]) await denied(writeRaw(member, id(label), rawBudget(ws.member, extra)))

  for (const field of ['workspaceId', 'kind', 'name', 'capCurrency', 'archived', 'createdAt', 'updatedAt']) {
    const data = rawBudget(ws.member)
    delete data[field]
    await denied(writeRaw(member, id(`missing-${field}`), data))
  }

  const ref = doc(member, 'budgets', id('immutable'))
  await allowed(setDoc(ref, rawBudget(ws.member, { totalLimit: 10 })))
  for (const [field, value] of [
    ['workspaceId', ws.dualA], ['kind', 'event'], ['capCurrency', 'EUR'], ['createdAt', Timestamp.fromMillis(1)]
  ]) await denied(updateDoc(ref, { [field]: value, updatedAt: serverTimestamp() }))
  for (const field of ['workspaceId', 'kind', 'name', 'capCurrency', 'archived', 'createdAt', 'updatedAt']) {
    const changes = { [field]: deleteField() }
    if (field !== 'updatedAt') changes.updatedAt = serverTimestamp()
    await denied(updateDoc(ref, changes))
  }
  await denied(updateDoc(ref, { updatedAt: Timestamp.fromMillis(1) }))
  await denied(updateDoc(ref, { name: '   ', updatedAt: serverTimestamp() }))

  const eventRef = doc(member, 'budgets', id('event-order'))
  await allowed(setDoc(eventRef, rawBudget(ws.member, {
    kind: 'event', startDate: Timestamp.fromDate(new Date('2025-04-10T00:00:00Z')),
    endDate: Timestamp.fromDate(new Date('2025-04-12T00:00:00Z'))
  })))
  await denied(writeRaw(member, id('reversed-event'), rawBudget(ws.member, {
    kind: 'event', startDate: Timestamp.fromDate(new Date('2025-04-12T00:00:00Z')),
    endDate: Timestamp.fromDate(new Date('2025-04-10T00:00:00Z'))
  })))
  await denied(updateDoc(eventRef, {
    endDate: Timestamp.fromDate(new Date('2025-04-09T00:00:00Z')), updatedAt: serverTimestamp()
  }))
})

test('default identity is reserved and archived budgets are readable but terminal', async () => {
  await denied(writeRaw(member, 'default-monthly', rawBudget(ws.member)))
  await denied(writeRaw(member, id('spoof'), rawBudget(ws.member, {
    id: 'forged', isDefault: true, categoryCaps: { food: 10 }, budgetAllocations: { goal: 5 }, balance: 1
  })))

  const ref = doc(member, 'budgets', id('archive-terminal'))
  await allowed(setDoc(ref, rawBudget(ws.member)))
  await allowed(updateDoc(ref, { archived: true, updatedAt: serverTimestamp() }))
  assert.equal((await getDoc(ref)).data().archived, true)
  await denied(updateDoc(ref, { archived: false, updatedAt: serverTimestamp() }))
  await denied(updateDoc(ref, { name: 'Archived edit', updatedAt: serverTimestamp() }))
  await denied(updateDoc(ref, { archived: true, name: 'Mixed archive edit', updatedAt: serverTimestamp() }))
  await denied(deleteDoc(ref))
})
