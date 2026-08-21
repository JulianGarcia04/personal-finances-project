export interface InstallmentTransaction {
  type: string;
  amount: number;
  date: Date;
  installments?: number | null;
}

export const getInstallmentCount = (value?: number | null) => {
  const count = Number(value)
  return Number.isInteger(count) && count > 0 ? count : 1
}

export const getMonthlyInstallmentAmount = (amount: number, installments?: number | null) =>
  Math.abs(amount) / getInstallmentCount(installments)

export const expenseAmountForMonth = (
  transaction: InstallmentTransaction,
  year: number,
  month: number
) => {
  if (transaction.type !== 'expense') return 0

  const transactionDate = transaction.date instanceof Date
    ? transaction.date
    : new Date(transaction.date)
  if (Number.isNaN(transactionDate.getTime())) return 0

  const transactionMonth = transactionDate.getFullYear() * 12 + transactionDate.getMonth()
  const targetMonth = year * 12 + month
  const installmentIndex = targetMonth - transactionMonth
  const installments = getInstallmentCount(transaction.installments)

  if (installmentIndex < 0 || installmentIndex >= installments) return 0

  // Work in cents so the installments add up to the original purchase amount.
  const totalCents = Math.round(Math.abs(transaction.amount) * 100)
  const baseCents = Math.floor(totalCents / installments)
  const remainderCents = totalCents % installments
  return (baseCents + (installmentIndex < remainderCents ? 1 : 0)) / 100
}

export const expenseAmountForDate = (
  transaction: InstallmentTransaction,
  date = new Date()
) => expenseAmountForMonth(transaction, date.getFullYear(), date.getMonth())
