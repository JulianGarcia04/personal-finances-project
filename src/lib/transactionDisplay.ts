import type { Transaction } from '../types.ts'

export interface TransactionDisplay {
  tone: 'income' | 'expense' | 'transfer'
  amountClass: string
  prefix: '+' | ''
  amount: number
  route?: string
}

type DisplayableTransaction = Pick<Transaction, 'type' | 'amount' | 'accountId' | 'toAccountId'>

// Transfers between own accounts are neutral: they don't grow or shrink net worth,
// so they get their own tone instead of being colored as income/expense by sign.
// Transfers are stored with a positive amount, but older records may still hold a
// negative one, so the displayed amount is always the absolute value.
export function getTransactionDisplay(
  tx: DisplayableTransaction,
  resolveAccountName: (id: string) => string
): TransactionDisplay {
  if (tx.type === 'transfer') {
    const route = tx.toAccountId
      ? `${resolveAccountName(tx.accountId)} → ${resolveAccountName(tx.toAccountId)}`
      : undefined

    return {
      tone: 'transfer',
      amountClass: 'text-accent-amber',
      prefix: '',
      amount: Math.abs(tx.amount),
      route
    }
  }

  const isPositive = tx.amount >= 0

  return {
    tone: isPositive ? 'income' : 'expense',
    amountClass: isPositive ? 'text-accent-emerald' : 'text-accent-rose',
    prefix: isPositive ? '+' : '',
    amount: tx.amount
  }
}
