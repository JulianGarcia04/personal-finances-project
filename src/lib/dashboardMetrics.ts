// Pure, framework-free Dashboard KPI math. Every function receives `now` and
// amounts already converted to the primary currency, so results are deterministic.
import type { InstallmentTransaction } from './installments.ts'
import { expenseAmountForMonth } from './installments.ts'

export const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

// A calendar month bounded to days 1..uptoDay (inclusive).
export interface MonthPeriod {
  year: number;
  month: number;
  uptoDay: number;
}

// Month-over-month comparison aligned by elapsed days: day 1..N of the current
// month vs day 1..min(N, lastDay) of the previous month.
export const alignedMonthPeriods = (now: Date): { current: MonthPeriod; previous: MonthPeriod } => {
  const day = now.getDate()
  const previousDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const previousYear = previousDate.getFullYear()
  const previousMonth = previousDate.getMonth()
  return {
    current: { year: now.getFullYear(), month: now.getMonth(), uptoDay: day },
    previous: {
      year: previousYear,
      month: previousMonth,
      uptoDay: Math.min(day, daysInMonth(previousYear, previousMonth))
    }
  }
}

export const isDateInPeriod = (date: Date, period: MonthPeriod) =>
  date.getFullYear() === period.year &&
  date.getMonth() === period.month &&
  date.getDate() <= period.uptoDay

// Installment-aware expense for a bounded period. Each monthly installment is
// imputed on the purchase's day-of-month (clamped to the month's last day).
export const expenseAmountInPeriod = (transaction: InstallmentTransaction, period: MonthPeriod) => {
  const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date)
  if (Number.isNaN(date.getTime())) return 0
  const imputedDay = Math.min(date.getDate(), daysInMonth(period.year, period.month))
  if (imputedDay > period.uptoDay) return 0
  return expenseAmountForMonth(transaction, period.year, period.month)
}

// Rounded % change; an empty previous period reads as +100% (or 0% when both are empty).
export const percentChange = (current: number, previous: number) => {
  if (previous === 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

// The `count` full calendar months before `now`, newest first.
export const previousFullMonths = (now: Date, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 1 - index, 1)
    return { year: date.getFullYear(), month: date.getMonth(), days: daysInMonth(date.getFullYear(), date.getMonth()) }
  })

export interface RunwayInput {
  liquidBalance: number;
  // Expenses of recent full months; months with no expenses are treated as "no history".
  history: { expenses: number; days: number }[];
  monthToDateExpenses: number;
  dayOfMonth: number;
}

// Days the liquid balance lasts at the historical daily burn.
// Burn = total expenses / total days of full months with activity; falls back to the
// current-month pace when there is no history. Returns null when there is no burn (infinite).
export const runwayDays = ({ liquidBalance, history, monthToDateExpenses, dayOfMonth }: RunwayInput): number | null => {
  const active = history.filter(month => month.expenses > 0)
  const historyDays = active.reduce((sum, month) => sum + month.days, 0)
  const dailyBurn = historyDays > 0
    ? active.reduce((sum, month) => sum + month.expenses, 0) / historyDays
    : dayOfMonth > 0 ? monthToDateExpenses / dayOfMonth : 0

  if (dailyBurn <= 0) return null
  if (liquidBalance <= 0) return 0
  return Math.round(liquidBalance / dailyBurn)
}

export interface CardPaymentInput {
  // Amount of the statement being paid; null when the card has no closing day configured.
  statementAmount: number | null;
  // Current outstanding debt on the card (positive number).
  debt: number;
  dueDate: Date;
}

// Card payments still pending this month: statements due between today and month end,
// each capped by the current debt so a card that was already paid is not counted twice.
export const committedCardPayments = (cards: CardPaymentInput[], now: Date) =>
  cards.reduce((sum, card) => {
    if (card.statementAmount === null) return sum
    const dueThisMonth = card.dueDate.getFullYear() === now.getFullYear() && card.dueDate.getMonth() === now.getMonth()
    if (!dueThisMonth) return sum
    return sum + Math.max(0, Math.min(card.statementAmount, card.debt))
  }, 0)

export interface SpendableResult {
  amount: number;
  perDay: number;
  daysLeft: number;
  isDeficit: boolean;
}

// "Disponible para gastar": available cash minus card payments still due this month.
// Negative values are reported as a deficit (not clamped); per-day is 0 in that case.
export const spendableUntilMonthEnd = (
  { availableBalance, committed, now }: { availableBalance: number; committed: number; now: Date }
): SpendableResult => {
  const daysLeft = daysInMonth(now.getFullYear(), now.getMonth()) - now.getDate() + 1
  const amount = availableBalance - committed
  return {
    amount,
    perDay: amount > 0 ? amount / daysLeft : 0,
    daysLeft,
    isDeficit: amount < 0
  }
}

// Month-end expense projection: purchases made this month extrapolated at the current
// daily pace, plus installments of earlier purchases already imputed to this month.
export const projectMonthEndExpenses = (
  { paceExpensesToDate, committedExpenses, now }: { paceExpensesToDate: number; committedExpenses: number; now: Date }
) => {
  const elapsed = now.getDate()
  const total = daysInMonth(now.getFullYear(), now.getMonth())
  return (paceExpensesToDate / elapsed) * total + committedExpenses
}

// Credit card debt (negative balance = debt) and utilization of the total limit.
export const cardDebtSummary = (cards: { balance: number; limit: number }[]) => {
  const debt = cards.reduce((sum, card) => sum + Math.max(0, -card.balance), 0)
  const limit = cards.reduce((sum, card) => sum + Math.max(0, card.limit || 0), 0)
  return { debt, limit, utilization: limit > 0 ? Math.round((debt / limit) * 100) : null }
}

export const utilizationLevel = (utilization: number | null): 'ok' | 'warn' | 'alert' => {
  if (utilization === null || utilization <= 30) return 'ok'
  return utilization > 70 ? 'alert' : 'warn'
}

// Money you can spend right away: top-level checking and cash accounts. Savings,
// pockets (money set aside), credit cards and mirror bridge accounts are excluded.
export const isSpendableAccount = (
  account: { type: string; parentAccountId?: string | null; mirror?: unknown }
) => (account.type === 'checking' || account.type === 'cash') && !account.parentAccountId && !account.mirror

export interface ProjectionCheck {
  projected: number;
  cap: number;
  exceeds: boolean;
}

// Compare like with like: the projection of budgeted categories against the budget
// total, and the projection of all spending against the workspace expense limit.
// A check is null when its cap is not configured.
export const projectionChecks = (
  { budgetedProjection, budgetTotal, totalProjection, expenseLimit }:
  { budgetedProjection: number; budgetTotal: number; totalProjection: number; expenseLimit: number }
): { budget: ProjectionCheck | null; limit: ProjectionCheck | null } => {
  const check = (projected: number, cap: number): ProjectionCheck | null =>
    cap > 0 ? { projected, cap, exceeds: projected > cap } : null
  return {
    budget: check(budgetedProjection, budgetTotal),
    limit: check(totalProjection, expenseLimit)
  }
}

// Per-card debt and utilization (null without a limit), highest utilization first;
// cards without a limit go last.
export const cardDebtRows = <T extends { id: string; name: string; balance: number; limit: number }>(cards: T[]) =>
  cards
    .map(card => {
      const debt = Math.max(0, -card.balance)
      const limit = Math.max(0, card.limit || 0)
      return { id: card.id, name: card.name, debt, limit, utilization: limit > 0 ? Math.round((debt / limit) * 100) : null }
    })
    .sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))
