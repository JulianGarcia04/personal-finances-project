// Ciclo de facturación de tarjetas de crédito (corte a corte), NO mes calendario.
// installments.ts reparte cuotas por mes calendario porque los presupuestos y KPIs
// (Dashboard, Goals, transactionsStore) responden "¿cuánto gasté este mes calendario?".
// Este archivo responde una pregunta distinta: "¿cuánto me van a cobrar en el próximo
// corte de esta tarjeta?". Por eso vive separado y no debe alimentar presupuestos/KPIs.
import type { InstallmentTransaction } from './installments.ts'
import { getInstallmentCount, prorateInstallmentCents } from './installments.ts'

const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

// Bucket "año*12+mes" al que pertenece una fecha según el día de corte:
// si la fecha cae después del corte, ya pertenece al ciclo del mes siguiente.
export const getCycleBucket = (date: Date, cutoffDay: number): number => {
  const bucket = date.getFullYear() * 12 + date.getMonth()
  return date.getDate() > cutoffDay ? bucket + 1 : bucket
}

export const getStatementPeriod = (
  cutoffDay: number,
  referenceDate = new Date()
): { cycleStart: Date; cycleEnd: Date } => {
  const bucket = getCycleBucket(referenceDate, cutoffDay)
  const year = Math.floor(bucket / 12)
  const month = bucket % 12

  const cycleEndDay = Math.min(cutoffDay, daysInMonth(year, month))
  const cycleEnd = new Date(year, month, cycleEndDay)

  const prevBucket = bucket - 1
  const prevYear = Math.floor(prevBucket / 12)
  const prevMonth = ((prevBucket % 12) + 12) % 12
  const prevCycleEndDay = Math.min(cutoffDay, daysInMonth(prevYear, prevMonth))
  const cycleStart = new Date(prevYear, prevMonth, prevCycleEndDay + 1)

  return { cycleStart, cycleEnd }
}

export const expenseAmountForCycle = (
  transaction: InstallmentTransaction,
  cutoffDay: number,
  referenceDate = new Date()
): number => {
  if (transaction.type !== 'expense') return 0

  const transactionDate = transaction.date instanceof Date
    ? transaction.date
    : new Date(transaction.date)
  if (Number.isNaN(transactionDate.getTime())) return 0

  const transactionBucket = getCycleBucket(transactionDate, cutoffDay)
  const targetBucket = getCycleBucket(referenceDate, cutoffDay)
  const installmentIndex = targetBucket - transactionBucket
  const installments = getInstallmentCount(transaction.installments)

  if (installmentIndex < 0 || installmentIndex >= installments) return 0

  return prorateInstallmentCents(transaction.amount, installments, installmentIndex)
}

// Próxima fecha calendario en la que cae `day` (clamped al mes), contando hoy si coincide.
export const getNextOccurrence = (day: number, referenceDate = new Date()): Date => {
  const year = referenceDate.getFullYear()
  const month = referenceDate.getMonth()
  const clampedDay = Math.min(day, daysInMonth(year, month))
  const candidate = new Date(year, month, clampedDay)

  if (candidate.getDate() === referenceDate.getDate() &&
      candidate.getMonth() === referenceDate.getMonth() &&
      candidate.getFullYear() === referenceDate.getFullYear()) {
    // Mismo día: cuenta como "próxima" ocurrencia.
    return candidate
  }
  if (candidate.getTime() > referenceDate.getTime()) return candidate

  const nextMonthDay = Math.min(day, daysInMonth(year, month + 1))
  return new Date(year, month + 1, nextMonthDay)
}

export const daysUntil = (date: Date, referenceDate = new Date()): number => {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((target.getTime() - start.getTime()) / msPerDay)
}
