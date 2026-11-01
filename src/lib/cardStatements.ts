import {
  getInstallmentCount,
  getPaymentBucket,
  prorateInstallmentCents,
  type CardBilling
} from './installments.ts'

// Ledger of one credit card for the "Pagos del mes" budget view. Every charge on the card
// (expense installments, transfers out, other debits) belongs to the statement paid in its
// payment month. Every credit (transfers in, refunds, cashback) pays statements oldest
// first, in date order, and counts in the month it was made. What is still unpaid of a
// statement counts in its payment month. So money paid early, like a transfer in October
// for the statement due in November, counts in October and not again in November.

export interface CardLedgerTransaction {
  type: string
  amount: number
  date: Date
  installments?: number | null
  accountId?: string | null
  toAccountId?: string | null
}

export interface CardLedgerAccount {
  id: string
  balance?: number | null
}

export interface CardStatementLedger {
  // Share of the statement paid in `paymentBucket` that counts in `targetBucket`
  // (buckets are year * 12 + month).
  weight: (paymentBucket: number, targetBucket: number) => number
  // Still unpaid of every statement paid up to `paymentBucket`, overdue ones included.
  pendingThrough: (paymentBucket: number) => number
}

const monthBucket = (date: Date) => date.getFullYear() * 12 + date.getMonth()
const cents = (value: number) => Math.round(value * 100)

interface Statement {
  totalCents: number
  remainingCents: number
  paidByMonth: Map<number, number>
}

export const buildCardStatementLedger = (
  account: CardLedgerAccount,
  billing: CardBilling,
  transactions: readonly CardLedgerTransaction[]
): CardStatementLedger => {
  const statements = new Map<number, Statement>()
  const credits: { bucket: number; time: number; cents: number }[] = []
  let ledgerDeltaCents = 0

  const charge = (bucket: number, amountCents: number) => {
    if (amountCents <= 0) return
    const statement = statements.get(bucket) ?? { totalCents: 0, remainingCents: 0, paidByMonth: new Map() }
    statement.totalCents += amountCents
    statement.remainingCents += amountCents
    statements.set(bucket, statement)
  }

  for (const transaction of transactions) {
    const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date)
    if (Number.isNaN(date.getTime()) || !Number.isFinite(transaction.amount)) continue
    const amountCents = Math.abs(cents(transaction.amount))
    const fromCard = transaction.accountId === account.id
    const toCard = transaction.type === 'transfer' && transaction.toAccountId === account.id
    if (!fromCard && !toCard) continue

    if (transaction.type === 'transfer') {
      if (fromCard && toCard) continue
      if (fromCard) {
        ledgerDeltaCents -= amountCents
        charge(getPaymentBucket(date, billing), amountCents)
      } else {
        ledgerDeltaCents += amountCents
        credits.push({ bucket: monthBucket(date), time: date.getTime(), cents: amountCents })
      }
    } else if (transaction.amount < 0 || transaction.type === 'expense') {
      ledgerDeltaCents -= amountCents
      const first = getPaymentBucket(date, billing)
      const installments = getInstallmentCount(transaction.installments)
      for (let index = 0; index < installments; index++) {
        charge(first + index, cents(prorateInstallmentCents(transaction.amount, installments, index)))
      }
    } else {
      ledgerDeltaCents += amountCents
      credits.push({ bucket: monthBucket(date), time: date.getTime(), cents: amountCents })
    }
  }

  // Debt or credit the card already had before its first recorded movement.
  const balanceCents = cents(Number(account.balance ?? 0))
  const openingCents = Number.isFinite(balanceCents) ? balanceCents - ledgerDeltaCents : 0
  const buckets = [...statements.keys()]
  const earliest = buckets.length > 0 ? Math.min(...buckets) : 0
  if (openingCents < 0) charge(earliest - 1, -openingCents)
  else if (openingCents > 0) credits.push({ bucket: earliest - 1, time: -Infinity, cents: openingCents })

  const ordered = [...statements.entries()].sort(([a], [b]) => a - b).map(([, statement]) => statement)
  credits.sort((a, b) => a.time - b.time)
  let next = 0
  for (const credit of credits) {
    let left = credit.cents
    while (left > 0 && next < ordered.length) {
      const statement = ordered[next]
      const applied = Math.min(left, statement.remainingCents)
      if (applied > 0) {
        statement.remainingCents -= applied
        statement.paidByMonth.set(credit.bucket, (statement.paidByMonth.get(credit.bucket) ?? 0) + applied)
        left -= applied
      }
      if (statement.remainingCents === 0) next++
    }
  }

  return {
    weight: (paymentBucket, targetBucket) => {
      const statement = statements.get(paymentBucket)
      if (!statement || statement.totalCents === 0) return paymentBucket === targetBucket ? 1 : 0
      const paid = statement.paidByMonth.get(targetBucket) ?? 0
      const unpaid = paymentBucket === targetBucket ? statement.remainingCents : 0
      return (paid + unpaid) / statement.totalCents
    },
    pendingThrough: paymentBucket => {
      let pendingCents = 0
      for (const [bucket, statement] of statements) {
        if (bucket <= paymentBucket) pendingCents += statement.remainingCents
      }
      return pendingCents / 100
    }
  }
}
