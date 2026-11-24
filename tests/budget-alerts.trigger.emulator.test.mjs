// Budget alert trigger end to end against the Firestore emulator: the real notifyBudgetThreshold
// handler (functions/lib/index.js, `.run`) under the workspace card basis (Consumo / Pagos).
// SMTP gets fake values and nodemailer's transport is replaced by a recorder, so no mail leaves
// the machine. Dates are relative to the current month in Bogotá; each trigger event happens now
// (the trigger drops events older than an hour) and is evaluated in that same month.
// Requires `pnpm --filter functions build`. Run (demo project only):
//   firebase emulators:exec --project demo-vault-access --only auth,firestore \
//     --config tests/firebase.pockets.json "node --test tests/budget-alerts.trigger.emulator.test.mjs"
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const requireFunctions = createRequire(resolve(repositoryRoot, 'functions/package.json'))

assert.match(process.env.GCLOUD_PROJECT ?? '', /^demo-/, 'tests must run against a demo project only')
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):\d+$/, 'Firestore emulator must use loopback')

// Fake credentials so the trigger "configures" SMTP; the recorder below receives every mail.
process.env.SMTP_USER = 'alerts-test@example.test'
process.env.SMTP_PASS = 'not-a-secret'
const sent = []
const nodemailer = requireFunctions('nodemailer')
nodemailer.createTransport = () => ({
  sendMail: async mail => {
    sent.push(mail.subject)
    return { messageId: 'recorded' }
  }
})

const index = requireFunctions('./lib/index.js')
const admin = requireFunctions('firebase-admin')
const { Timestamp, FieldValue } = requireFunctions('firebase-admin/firestore')
const { zonedWallClockToInstant, zonedYearMonth } = requireFunctions('./lib/http.js')
const db = admin.firestore()

const TIME_ZONE = 'America/Bogota'
const runId = `${Date.now()}`
const current = zonedYearMonth(new Date(), TIME_ZONE)
/** Noon in Bogotá on `day` of the current month plus `monthOffset`. */
const at = (monthOffset, day) => zonedWallClockToInstant(current.year, current.month + monthOffset, day, 12, TIME_ZONE)
const MONTH = `${current.year}-${String(current.month + 1).padStart(2, '0')}`

const NEAR_85 = 'Estás cerca del tope de Comida (Presupuesto mensual) (85 %)'
const NEAR_90 = 'Estás cerca del tope de Comida (Presupuesto mensual) (90 %)'
const REACHED = 'Ya alcanzaste el tope de Comida (Presupuesto mensual)'
const ledgerRow = (notified, lastSpent) => ({ subject: 'food', month: MONTH, notified, lastSpent, budget: 100_000 })

after(async () => {
  await admin.app().delete()
})

/** One workspace (owner only) with a 100,000 Comida cap, a bank, cash and a Visa closing 25 and due 5. */
function workspace(prefix, basis) {
  const id = name => `alerts-${runId}-${prefix}-${name}`
  const tx = data => ({
    workspaceId: id('ws'), userId: id('owner'), currency: 'COP', installments: 1, toAccountId: null, categoryId: '', ...data,
    accountId: data.accountId && id(data.accountId),
    ...(data.toAccountId ? { toAccountId: id(data.toAccountId) } : {}),
    ...(data.categoryId ? { categoryId: id(data.categoryId) } : {}),
    date: Timestamp.fromDate(data.date)
  })
  const ledger = async () => {
    const snap = await db.collection('budgetAlerts').where('workspaceId', '==', id('ws')).get()
    return snap.docs
      .map(doc => ({
        subject: String(doc.get('categoryId')).replace(`alerts-${runId}-${prefix}-`, ''),
        month: doc.get('month'),
        notified: [...doc.get('notified')].sort((a, b) => a - b),
        lastSpent: doc.get('lastSpent'),
        budget: doc.get('budget')
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject))
  }
  return {
    ledger,
    async seed(transactions, balances = {}) {
      const batch = db.batch()
      batch.set(db.collection('users').doc(id('owner')), { email: `${id('owner')}@example.test`, country: 'CO', currency: 'COP' })
      batch.set(db.collection('workspaces').doc(id('ws')), {
        name: prefix, ownerId: id('owner'), members: [id('owner')], currency: 'COP',
        categoryBudgets: { [id('food')]: 100_000 }, categoryBudgetCurrency: 'COP',
        ...(basis ? { budgetCardBasis: basis } : {})
      })
      batch.set(db.collection('categories').doc(id('food')), { workspaceId: id('ws'), name: 'Comida', type: 'expense' })
      const accounts = {
        bank: { type: 'checking', balance: 1_000_000 },
        cash: { type: 'cash', balance: 500_000 },
        visa: { type: 'credit', balance: 0, statementClosingDay: 25, paymentDueDay: 5, limit: 5_000_000 }
      }
      for (const [key, data] of Object.entries(accounts)) {
        batch.set(db.collection('accounts').doc(id(key)), {
          ...data, balance: balances[key] ?? data.balance, workspaceId: id('ws'), userId: id('owner'), name: key, currency: 'COP'
        })
      }
      for (const [key, data] of Object.entries(transactions)) batch.set(db.collection('transactions').doc(id(key)), tx(data))
      await batch.commit()
    },
    /** Writes (or deletes, with null) a transaction and the balances the app would move, then runs the trigger once. */
    async write(key, data, balanceDeltas = {}) {
      const ref = db.collection('transactions').doc(id(key))
      const beforeSnap = await ref.get()
      const batch = db.batch()
      if (data) batch.set(ref, tx(data))
      else batch.delete(ref)
      for (const [account, delta] of Object.entries(balanceDeltas)) {
        batch.update(db.collection('accounts').doc(id(account)), { balance: FieldValue.increment(delta) })
      }
      await batch.commit()
      const before = beforeSnap.exists ? beforeSnap.data() : undefined
      const afterData = data ? (await ref.get()).data() : undefined
      const snapshot = value => ({ exists: value !== undefined, data: () => value })
      const mailsBefore = sent.length
      await index.notifyBudgetThreshold.run({
        params: { transactionId: id(key) },
        time: new Date().toISOString(),
        data: { before: snapshot(before), after: snapshot(afterData) }
      })
      return { mails: sent.slice(mailsBefore), ledger: await ledger() }
    },
    /** What the owner's switch writes: only the workspace document, which no trigger watches. */
    async setBasis(value) {
      await db.collection('workspaces').doc(id('ws')).update({ budgetCardBasis: value })
      return ledger()
    }
  }
}

test('Consumo (no basis set): card purchases count in their cycle month and card payments or loan repayments alert nothing, as before', async () => {
  const w = workspace('consumo')
  await w.seed({ c0: { type: 'expense', amount: -70_000, accountId: 'cash', categoryId: 'food', date: at(0, 2) } }, { cash: 430_000 })

  // 70,000 cash + 20,000 on the Visa (statement cycle of this month) = 90 %.
  assert.deepEqual(
    await w.write('v1', { type: 'expense', amount: -20_000, accountId: 'visa', categoryId: 'food', date: at(0, 3) }, { visa: -20_000 }),
    { mails: [NEAR_90], ledger: [ledgerRow([80], 90_000)] }
  )
  assert.deepEqual(
    await w.write('p1', { type: 'transfer', amount: 50_000, accountId: 'bank', toAccountId: 'visa', date: at(0, 20) }, { bank: -50_000, visa: 50_000 }),
    { mails: [], ledger: [ledgerRow([80], 90_000)] }
  )
  // 95 %: the 80 % threshold is already claimed.
  assert.deepEqual(
    await w.write('v2', { type: 'expense', amount: -5_000, accountId: 'visa', categoryId: 'food', date: at(0, 21) }, { visa: -5_000 }),
    { mails: [], ledger: [ledgerRow([80], 90_000)] }
  )
  assert.deepEqual(
    await w.write('c1', { type: 'expense', amount: -10_000, accountId: 'cash', categoryId: 'food', date: at(0, 22) }, { cash: -10_000 }),
    { mails: [REACHED], ledger: [ledgerRow([80, 100], 105_000)] }
  )
  assert.deepEqual(
    await w.write('l1', { type: 'loan_payment', amount: 10_000, accountId: 'visa', date: at(0, 22) }, { visa: 10_000 }),
    { mails: [], ledger: [ledgerRow([80, 100], 105_000)] }
  )
  assert.deepEqual(await w.write('c1', null, { cash: 10_000 }), { mails: [], ledger: [ledgerRow([80, 100], 105_000)] })
})

test('Pagos: an early card payment and a loan repayment on the card move spending into this month and alert once per threshold', async () => {
  const w = workspace('pagos', 'payment')
  // This month's purchase is on the statement due on the 5th of next month: nothing counts yet.
  await w.seed({ v0: { type: 'expense', amount: -100_000, accountId: 'visa', categoryId: 'food', date: at(0, 3) } }, { visa: -100_000 })

  assert.deepEqual(
    await w.write('p1', { type: 'transfer', amount: 85_000, accountId: 'bank', toAccountId: 'visa', date: at(0, 20) }, { bank: -85_000, visa: 85_000 }),
    { mails: [NEAR_85], ledger: [ledgerRow([80], 85_000)] }
  )
  // A purchase this month adds nothing yet (its statement is due next month): no re-fire.
  assert.deepEqual(
    await w.write('v1', { type: 'expense', amount: -1_000, accountId: 'visa', categoryId: 'food', date: at(0, 21) }, { visa: -1_000 }),
    { mails: [], ledger: [ledgerRow([80], 85_000)] }
  )
  // 16,000 more paid now (loan repaid onto the card): 101,000 of the statement counts this month.
  assert.deepEqual(
    await w.write('l1', { type: 'loan_payment', amount: 16_000, accountId: 'visa', date: at(0, 22) }, { visa: 16_000 }),
    { mails: [REACHED], ledger: [ledgerRow([80, 100], 101_000)] }
  )
})

test('changing the card basis alerts nothing; the next write uses the new basis and claimed thresholds never fire again', async () => {
  const w = workspace('switch')
  // Last month's purchase: Consumo counts it last month, Pagos in this month (statement due on the 5th).
  await w.seed({ v0: { type: 'expense', amount: -100_000, accountId: 'visa', categoryId: 'food', date: at(-1, 10) } }, { visa: -100_000 })

  assert.deepEqual(
    await w.write('c0', { type: 'expense', amount: -1_000, accountId: 'cash', categoryId: 'food', date: at(0, 21) }, { cash: -1_000 }),
    { mails: [], ledger: [] }
  )
  const mailsBeforeSwitch = sent.length
  assert.deepEqual(await w.setBasis('payment'), [])
  assert.equal(sent.length, mailsBeforeSwitch)
  assert.deepEqual(
    await w.write('c1', { type: 'expense', amount: -1_000, accountId: 'cash', categoryId: 'food', date: at(0, 22) }, { cash: -1_000 }),
    { mails: [REACHED], ledger: [ledgerRow([80, 100], 102_000)] }
  )
  assert.deepEqual(await w.setBasis('consumption'), [ledgerRow([80, 100], 102_000)])
  await w.setBasis('payment')
  assert.deepEqual(
    await w.write('c2', { type: 'expense', amount: -1_000, accountId: 'cash', categoryId: 'food', date: at(0, 23) }, { cash: -1_000 }),
    { mails: [], ledger: [ledgerRow([80, 100], 102_000)] }
  )
})

test('no Firestore trigger watches the workspace document, so a basis change alone sends nothing', () => {
  const triggers = Object.entries(index)
    .filter(([, fn]) => fn?.__endpoint?.eventTrigger)
    .map(([name, fn]) => ({
      name,
      document: fn.__endpoint.eventTrigger.eventFilterPathPatterns?.document ?? fn.__endpoint.eventTrigger.eventFilters?.document
    }))
  assert.ok(
    triggers.some(trigger => trigger.name === 'notifyBudgetThreshold' && trigger.document === 'transactions/{transactionId}'),
    JSON.stringify(triggers)
  )
  assert.deepEqual(triggers.filter(trigger => String(trigger.document).startsWith('workspaces/')), [])
})
