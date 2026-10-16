import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardBillingOf,
  createCardBillingLookup,
  expenseAmountForDate,
  expenseAmountForMonth,
  getCycleBucket,
  getMonthlyInstallmentAmount,
  getPaymentBucket
} from './installments.ts'
import { getStatementClosingForDueDate } from './creditCycle.ts'

test('distribuye una compra en cuotas durante los meses siguientes', () => {
  const transaction = {
    type: 'expense',
    amount: -600,
    date: new Date(2026, 7, 10),
    installments: 6
  }

  assert.equal(expenseAmountForMonth(transaction, 2026, 7), 100)
  assert.equal(expenseAmountForMonth(transaction, 2027, 0), 100)
  assert.equal(expenseAmountForMonth(transaction, 2027, 1), 0)
  assert.equal(getMonthlyInstallmentAmount(transaction.amount, transaction.installments), 100)
})

test('las compras sin cuotas se imputan solo en su mes', () => {
  const transaction = {
    type: 'expense',
    amount: -250,
    date: new Date(2026, 7, 10)
  }

  assert.equal(expenseAmountForMonth(transaction, 2026, 7), 250)
  assert.equal(expenseAmountForMonth(transaction, 2026, 8), 0)
})

// --- Credit-card payment months ---

const card = (statementClosingDay: number, paymentDueDay: number) => ({ statementClosingDay, paymentDueDay })
const purchase = (date: Date, amount: number, installments = 1) => ({ type: 'expense', amount, date, installments })
// Amount imputed to each of `count` consecutive calendar months starting at (year, month).
const sharesFrom = (
  transaction: ReturnType<typeof purchase>,
  billing: ReturnType<typeof card> | null,
  year: number,
  month: number,
  count: number
) => Array.from({ length: count }, (_, offset) => {
  const date = new Date(year, month + offset, 1)
  return expenseAmountForMonth(transaction, date.getFullYear(), date.getMonth(), billing)
})

test('closing 25, due 10: a purchase on 28 Sep at 3 installments is paid in Nov, Dec and Jan', () => {
  const visa = card(25, 10)
  const transaction = purchase(new Date(2026, 8, 28), -300_000, 3)
  // Sep, Oct, Nov, Dec, Jan, Feb
  assert.deepEqual(sharesFrom(transaction, visa, 2026, 8, 6), [0, 0, 100_000, 100_000, 100_000, 0])
})

test('closing 25, due 10: a purchase on 20 Sep at 3 installments is paid in Oct, Nov and Dec', () => {
  const transaction = purchase(new Date(2026, 8, 20), -300_000, 3)
  assert.deepEqual(sharesFrom(transaction, card(25, 10), 2026, 8, 5), [0, 100_000, 100_000, 100_000, 0])
})

test('closing 5, due 20: a purchase on 28 Sep at 3 installments is paid in Oct, Nov and Dec', () => {
  const transaction = purchase(new Date(2026, 8, 28), -300_000, 3)
  assert.deepEqual(sharesFrom(transaction, card(5, 20), 2026, 8, 5), [0, 100_000, 100_000, 100_000, 0])
})

test('closing 25, due 10: a single-installment purchase on 28 Sep is paid in Nov', () => {
  const transaction = purchase(new Date(2026, 8, 28), -300_000)
  assert.deepEqual(sharesFrom(transaction, card(25, 10), 2026, 8, 4), [0, 0, 300_000, 0])
  assert.equal(expenseAmountForDate(transaction, new Date(2026, 10, 15), card(25, 10)), 300_000)
  assert.equal(expenseAmountForDate(transaction, new Date(2026, 8, 30), card(25, 10)), 0)
})

test('a purchase on the closing day belongs to that statement', () => {
  // Closing 25, due 10: 25 Sep closes in Sep and is paid in Oct.
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 8, 25), -50), card(25, 10), 2026, 8, 3), [0, 50, 0])
  // Closing 5, due 20: 5 Oct closes and is paid in Oct; 6 Oct waits for Nov.
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 9, 5), -50), card(5, 20), 2026, 9, 2), [50, 0])
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 9, 6), -50), card(5, 20), 2026, 9, 2), [0, 50])
})

test('a due day equal to the closing day pays the statement in the following month', () => {
  const sameDay = card(15, 15)
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 8, 15), -80), sameDay, 2026, 8, 3), [0, 80, 0])
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 8, 16), -80), sameDay, 2026, 8, 3), [0, 0, 80])
})

test('closing day 31 or 30 clamps to the end of short months', () => {
  // Closing 31, due 10: 28 Feb closes with February and is paid in March; 1 Mar waits for April.
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 1, 28), -40), card(31, 10), 2026, 1, 3), [0, 40, 0])
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 2, 1), -40), card(31, 10), 2026, 1, 3), [0, 0, 40])
  // Closing 30, due 5: 30 Apr closes with April (paid in May); 28 Feb closes with February (paid in March).
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 3, 30), -40), card(30, 5), 2026, 3, 3), [0, 40, 0])
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 1, 28), -40), card(30, 5), 2026, 1, 3), [0, 40, 0])
  // Closing 29, due 10 in a leap year: 29 Feb 2028 closes with February.
  assert.deepEqual(sharesFrom(purchase(new Date(2028, 1, 29), -40), card(29, 10), 2028, 1, 3), [0, 40, 0])
})

test('payment months cross the December to January year boundary', () => {
  // Closing 25, due 10: 20 Dec closes in Dec (paid Jan); 28 Dec closes in Jan (paid Feb, Mar).
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 11, 20), -70), card(25, 10), 2026, 11, 3), [0, 70, 0])
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 11, 28), -70, 2), card(25, 10), 2026, 11, 4), [0, 0, 35, 35])
  // Closing 5, due 20: 28 Dec closes on 5 Jan and is paid on 20 Jan.
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 11, 28), -70), card(5, 20), 2026, 11, 3), [0, 70, 0])
})

test('the payment month matches the card statement widget closing for the same due date', () => {
  const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()
  const pairs = [[25, 10], [5, 20], [15, 15], [31, 10], [28, 5], [10, 25], [1, 1], [31, 31]]
  for (const [closing, due] of pairs) {
    for (let offset = 0; offset < 400; offset += 3) {
      const date = new Date(2026, 0, 1 + offset)
      const billing = card(closing, due)
      const paymentBucket = getPaymentBucket(date, billing)
      const paymentYear = Math.floor(paymentBucket / 12)
      const paymentMonth = paymentBucket % 12
      const dueDate = new Date(paymentYear, paymentMonth, Math.min(due, daysInMonth(paymentYear, paymentMonth)))
      const widgetClosing = getStatementClosingForDueDate(closing, dueDate)
      assert.equal(
        widgetClosing.getFullYear() * 12 + widgetClosing.getMonth(),
        getCycleBucket(date, closing),
        `closing ${closing}, due ${due}, purchase ${date.toDateString()}`
      )
    }
  }
})

test('a short month that clamps closing and due onto the same date still pays its own statement that month (closing 30, due 31)', () => {
  // February 2026: the statement closes on the 28th (clamped from 30) and is due on the 28th
  // (clamped from 31). The configured due day is after the closing day, so February's
  // statement is paid in February and every statement keeps exactly one payment month.
  const billing = card(30, 31)
  assert.deepEqual(sharesFrom(purchase(new Date(2026, 1, 10), -60), billing, 2026, 0, 3), [0, 60, 0])
  // The widget lookup for a 28 Feb due date resolves to January's closing instead.
  assert.equal(getStatementClosingForDueDate(30, new Date(2026, 1, 28)).getMonth(), 0)
  const paymentMonths = Array.from({ length: 12 }, (_, month) => getPaymentBucket(new Date(2026, month, 1), billing))
  assert.equal(new Set(paymentMonths).size, 12)
  assert.deepEqual(paymentMonths, Array.from({ length: 12 }, (_, month) => 2026 * 12 + month))
})

test('card installments keep cent-exact proration in payment months', () => {
  const transaction = purchase(new Date(2026, 8, 28), -100_000, 3)
  assert.deepEqual(sharesFrom(transaction, card(25, 10), 2026, 10, 3), [33_333.34, 33_333.33, 33_333.33])
})

test('income stays outside installment imputation even on a card with billing days', () => {
  const income = { type: 'income', amount: 500, date: new Date(2026, 8, 28) }
  assert.equal(expenseAmountForMonth(income, 2026, 10, card(25, 10)), 0)
})

test('without billing days a card purchase keeps calendar-month imputation', () => {
  const transaction = purchase(new Date(2026, 8, 28), -300_000, 3)
  assert.deepEqual(sharesFrom(transaction, null, 2026, 8, 4), [100_000, 100_000, 100_000, 0])
  assert.deepEqual(sharesFrom(transaction, undefined as never, 2026, 8, 4), [100_000, 100_000, 100_000, 0])
})

test('cardBillingOf only returns billing days for regular credit cards with both days set', () => {
  const base = { id: 'visa', type: 'credit', statementClosingDay: 25, paymentDueDay: 10 }
  assert.deepEqual(cardBillingOf(base), { statementClosingDay: 25, paymentDueDay: 10 })
  assert.equal(cardBillingOf({ ...base, type: 'checking' }), null)
  assert.equal(cardBillingOf({ ...base, paymentDueDay: null }), null)
  assert.equal(cardBillingOf({ ...base, statementClosingDay: undefined }), null)
  assert.equal(cardBillingOf({ ...base, statementClosingDay: 0 }), null)
  assert.equal(cardBillingOf({ ...base, paymentDueDay: 32 }), null)
  assert.equal(cardBillingOf({ ...base, paymentDueDay: 10.5 }), null)
  assert.equal(cardBillingOf({ ...base, mirror: { workspaceId: 'w', accountId: 'a', sourceAccountId: 's' } }), null)
  assert.equal(cardBillingOf(undefined), null)
})

test('createCardBillingLookup resolves billing by account id and falls back to null', () => {
  const lookup = createCardBillingLookup([
    { id: 'visa', type: 'credit', statementClosingDay: 25, paymentDueDay: 10 },
    { id: 'master', type: 'credit', statementClosingDay: 25, paymentDueDay: null },
    { id: 'bank', type: 'checking' }
  ])
  assert.deepEqual(lookup('visa'), { statementClosingDay: 25, paymentDueDay: 10 })
  assert.equal(lookup('master'), null)
  assert.equal(lookup('bank'), null)
  assert.equal(lookup('missing'), null)
  assert.equal(lookup(undefined), null)
  assert.equal(lookup(null), null)
})
