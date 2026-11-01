import { buildCardStatementLedger, type CardLedgerTransaction, type CardStatementLedger } from './cardStatements.ts'

export interface InstallmentTransaction {
  type: string;
  amount: number;
  date: Date;
  installments?: number | null;
  accountId?: string | null;
}

// Billing days of a regular credit card. Its expenses leave the user's money on the
// payment due date of the statement that contains the purchase, so installments are
// imputed to payment months instead of purchase calendar months.
export interface CardBilling {
  statementClosingDay: number;
  paymentDueDay: number;
  // 'payment' (default): the month the statement is paid, for cash flow.
  // 'consumption': the month of the statement cycle that contains the purchase, for budgets.
  basis?: ImputationBasis;
  // Payment basis only: payments already made to the card, so each statement counts in the
  // months it was actually paid and only its unpaid rest in its payment month.
  ledger?: CardStatementLedger;
}

export type ImputationBasis = 'payment' | 'consumption'

export interface BillingAccount {
  id: string;
  type: string;
  statementClosingDay?: number | null;
  paymentDueDay?: number | null;
  balance?: number | null;
  mirror?: unknown;
}

export type CardBillingLookup = (accountId?: string | null) => CardBilling | null

const isBillingDay = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 31

// Only credit cards with both days configured bill by statement; mirror bridge accounts
// and every other account keep calendar-month imputation.
export const cardBillingOf = (account?: BillingAccount | null): CardBilling | null => {
  if (!account || account.type !== 'credit' || account.mirror) return null
  const { statementClosingDay, paymentDueDay } = account
  if (!isBillingDay(statementClosingDay) || !isBillingDay(paymentDueDay)) return null
  return { statementClosingDay, paymentDueDay }
}

// With `options.transactions` the payment basis also applies the payments made to each card
// (see cardStatements.ts); without it, every statement counts whole in its payment month.
export const createCardBillingLookup = (
  accounts: readonly BillingAccount[],
  basis: ImputationBasis = 'payment',
  options: { transactions?: readonly CardLedgerTransaction[] } = {}
): CardBillingLookup => {
  const billingById = new Map<string, CardBilling>()
  for (const account of accounts) {
    const billing = cardBillingOf(account)
    if (!billing) continue
    if (basis === 'consumption') billingById.set(account.id, { ...billing, basis })
    else if (options.transactions) {
      billingById.set(account.id, { ...billing, ledger: buildCardStatementLedger(account, billing, options.transactions) })
    } else billingById.set(account.id, billing)
  }
  return accountId => (accountId ? billingById.get(accountId) ?? null : null)
}

// Bucket (year * 12 + month) of the statement closing that includes `date`: a date after
// the closing day already belongs to next month's closing. Short months need no clamping
// because no date goes past the month's last day.
export const getCycleBucket = (date: Date, cutoffDay: number): number => {
  const bucket = date.getFullYear() * 12 + date.getMonth()
  return date.getDate() > cutoffDay ? bucket + 1 : bucket
}

// Bucket of the month in which the statement containing `date` is paid: the closing
// month when the due day comes after the closing day, otherwise the month after it.
// Using the configured days (not the clamped dates) keeps every statement mapped to
// exactly one payment month.
export const getPaymentBucket = (date: Date, billing: CardBilling): number =>
  getCycleBucket(date, billing.statementClosingDay) +
  (billing.paymentDueDay > billing.statementClosingDay ? 0 : 1)

export const getInstallmentCount = (value?: number | null) => {
  const count = Number(value)
  return Number.isInteger(count) && count > 0 ? count : 1
}

export const getMonthlyInstallmentAmount = (amount: number, installments?: number | null) =>
  Math.abs(amount) / getInstallmentCount(installments)

// Work in cents so the installments add up to the original purchase amount.
export const prorateInstallmentCents = (totalAmount: number, installments: number, installmentIndex: number): number => {
  const totalCents = Math.round(Math.abs(totalAmount) * 100)
  const baseCents = Math.floor(totalCents / installments)
  const remainderCents = totalCents % installments
  return (baseCents + (installmentIndex < remainderCents ? 1 : 0)) / 100
}

// Installment i of an expense is imputed to its first month + i. The first month is, when
// `billing` is given, the card payment month (basis 'payment', the default) or the statement
// cycle month (basis 'consumption'); otherwise the purchase calendar month.
export const expenseAmountForMonth = (
  transaction: InstallmentTransaction,
  year: number,
  month: number,
  billing?: CardBilling | null
) => {
  if (transaction.type !== 'expense') return 0

  const transactionDate = transaction.date instanceof Date
    ? transaction.date
    : new Date(transaction.date)
  if (Number.isNaN(transactionDate.getTime())) return 0

  const firstMonth = billing
    ? billing.basis === 'consumption'
      ? getCycleBucket(transactionDate, billing.statementClosingDay)
      : getPaymentBucket(transactionDate, billing)
    : transactionDate.getFullYear() * 12 + transactionDate.getMonth()
  const targetMonth = year * 12 + month
  const installmentIndex = targetMonth - firstMonth
  const installments = getInstallmentCount(transaction.installments)

  if (billing?.ledger && billing.basis !== 'consumption') {
    let total = 0
    for (let index = 0; index < installments; index++) {
      const weight = billing.ledger.weight(firstMonth + index, targetMonth)
      if (weight > 0) total += prorateInstallmentCents(transaction.amount, installments, index) * weight
    }
    return Math.round(total * 100) / 100
  }

  if (installmentIndex < 0 || installmentIndex >= installments) return 0

  return prorateInstallmentCents(transaction.amount, installments, installmentIndex)
}

export const expenseAmountForDate = (
  transaction: InstallmentTransaction,
  date = new Date(),
  billing?: CardBilling | null
) => expenseAmountForMonth(transaction, date.getFullYear(), date.getMonth(), billing)
