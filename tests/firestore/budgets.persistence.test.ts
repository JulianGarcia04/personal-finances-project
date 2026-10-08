import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deleteApp, initializeApp } from 'firebase/app'
import { after, before, test } from 'node:test'
import { Timestamp, connectFirestoreEmulator, doc, getDoc, getFirestore, serverTimestamp, setDoc, setLogLevel, terminate } from 'firebase/firestore'
import { createBudgetPersistence, decodeOperatingBudgetRecord } from '../../src/lib/budgetPersistence.ts'

setLogLevel('silent')
const projectId = 'demo-vault-b2'
const emulator = process.env.FIRESTORE_EMULATOR_HOST
const configuredProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT
if (!emulator || configuredProject !== projectId) throw new Error('B2P tests require the demo-vault-b2 Firestore emulator')
const [host, portText] = emulator.split(':')
if (host !== '127.0.0.1' || Number(portText) !== 8185) throw new Error(`B2P tests refuse non-isolated emulator ${emulator}`)

const runId = `b2p-${randomUUID()}`
const apps = []
const databases = []
after(async () => {
  const results = await Promise.allSettled(databases.map(terminate))
  await Promise.allSettled(apps.map(deleteApp))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Failed to terminate B2P Firestore clients')
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
const dual = client('dual-member', dualId)
const ws = { member: `${runId}-ws-member`, dualA: `${runId}-ws-a`, dualB: `${runId}-ws-b` }
const id = label => `${runId}-${label}`
const workspaceData = (workspaceId, uid) => ({
  id: workspaceId, name: 'Synthetic workspace', ownerId: uid, members: [uid], currency: 'USD',
  createdAt: serverTimestamp(), budgetIncome: 5000, budgetNeedsPercent: 50,
  budgetWantsPercent: 30, budgetSavingsPercent: 20, budgetAllocations: { goal: 25 },
  categoryBudgets: { food: 400 }, exchangeRates: { EUR: 1.1 }
})
const ledgerId = id('ledger')
let workspaceBaseline
let ledgerBaseline

before(async () => {
  await setDoc(doc(member, 'workspaces', ws.member), workspaceData(ws.member, memberId))
  await setDoc(doc(dual, 'workspaces', ws.dualA), workspaceData(ws.dualA, dualId))
  await setDoc(doc(dual, 'workspaces', ws.dualB), workspaceData(ws.dualB, dualId))
  await setDoc(doc(member, 'transactions', ledgerId), {
    workspaceId: ws.member, accountId: id('account'), amount: -123.45,
    type: 'expense', description: 'Synthetic ledger fixture', date: Timestamp.fromDate(new Date('2025-01-02T00:00:00Z'))
  })
  workspaceBaseline = (await getDoc(doc(member, 'workspaces', ws.member))).data()
  ledgerBaseline = (await getDoc(doc(member, 'transactions', ledgerId))).data()
})

test('injected service creates, reads, lists, patches, clears, and archives budgets', async () => {
  const service = createBudgetPersistence(member, ws.member)
  const monthly = await service.create({ kind: 'monthly', name: 'Monthly', capCurrency: 'USD', totalLimit: 0 })
  assert.equal(monthly.archived, false)
  assert.equal(monthly.totalLimit, 0)
  const createdAt = (await getDoc(doc(member, 'budgets', monthly.id))).data().createdAt
  await service.patch(monthly.id, { name: 'Renamed', totalLimit: null })
  assert.equal((await service.read(monthly.id)).name, 'Renamed')
  const afterPatch = (await getDoc(doc(member, 'budgets', monthly.id))).data()
  assert.equal(Object.hasOwn(afterPatch, 'totalLimit'), false)
  assert.equal(afterPatch.createdAt.seconds, createdAt.seconds)
  assert.equal(afterPatch.createdAt.nanoseconds, createdAt.nanoseconds)

  const event = await service.create({
    kind: 'event', name: 'Event', capCurrency: 'EUR', totalLimit: 12.5,
    startDate: new Date('2025-04-10T00:00:00Z'), endDate: new Date('2025-04-12T00:00:00Z')
  })
  await assert.rejects(service.patch(event.id, { endDate: new Date('2025-04-09T00:00:00Z') }))
  assert.equal((await service.read(event.id)).endDate.toISOString(), '2025-04-12T00:00:00.000Z')
  await service.patch(event.id, { startDate: null, totalLimit: null })
  const cleared = (await getDoc(doc(member, 'budgets', event.id))).data()
  assert.equal(Object.hasOwn(cleared, 'startDate'), false)
  assert.equal(Object.hasOwn(cleared, 'totalLimit'), false)

  assert.equal((await service.archive(monthly.id)).archived, true)
  assert.equal((await service.archive(monthly.id)).archived, true)
  await assert.rejects(service.patch(monthly.id, { name: 'Archived edit' }))
  assert.equal((await service.read(monthly.id)).archived, true)
  const listed = await service.list()
  assert.ok(listed.some(budget => budget.id === monthly.id && budget.archived))
  assert.deepEqual(listed.map(budget => budget.name), [...listed.map(budget => budget.name)].sort((a, b) => a.localeCompare(b)))
  await assert.rejects(service.read('default-monthly'))
  await assert.rejects(service.read('../bad'))
})

test('captured workspace rejects foreign budget IDs for dual members', async () => {
  const serviceA = createBudgetPersistence(dual, ws.dualA)
  const serviceB = createBudgetPersistence(dual, ws.dualB)
  const budgetA = await serviceA.create({ kind: 'monthly', name: 'A', capCurrency: 'USD' })
  const budgetB = await serviceB.create({ kind: 'event', name: 'B', capCurrency: 'EUR' })
  await assert.rejects(serviceA.read(budgetB.id), /different workspace/)
  await assert.rejects(serviceA.patch(budgetB.id, { name: 'cross-workspace' }), /different workspace/)
  await assert.rejects(serviceA.archive(budgetB.id), /different workspace/)
  assert.deepEqual((await serviceA.list()).map(budget => budget.id), [budgetA.id])
  assert.deepEqual((await serviceB.list()).map(budget => budget.id), [budgetB.id])
  await assert.rejects(serviceA.create({ kind: 'monthly', name: 'Invalid', capCurrency: 'usd' }))
})

test('decoder rejects malformed, spoofed, foreign, and non-chronological records', () => {
  const base = {
    workspaceId: ws.member, kind: 'event', name: 'Fixture', capCurrency: 'USD', archived: false,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(2)
  }
  assert.throws(() => decodeOperatingBudgetRecord(id('decode'), { ...base, createdAt: new Date() }, ws.member))
  assert.throws(() => decodeOperatingBudgetRecord(id('decode'), { ...base, id: 'spoofed' }, ws.member))
  assert.throws(() => decodeOperatingBudgetRecord(id('decode'), base, ws.dualA))
  assert.throws(() => decodeOperatingBudgetRecord('default-monthly', base, ws.member))
  assert.throws(() => decodeOperatingBudgetRecord(id('decode'), {
    ...base, startDate: Timestamp.fromMillis(3000), endDate: Timestamp.fromMillis(2000)
  }, ws.member))
  assert.throws(() => decodeOperatingBudgetRecord(id('decode'), { ...base, unknown: true }, ws.member))
})

test('budget operations leave synthetic settings and ledger records unchanged', async () => {
  assert.deepEqual((await getDoc(doc(member, 'workspaces', ws.member))).data(), workspaceBaseline)
  assert.deepEqual((await getDoc(doc(member, 'transactions', ledgerId))).data(), ledgerBaseline)
})
