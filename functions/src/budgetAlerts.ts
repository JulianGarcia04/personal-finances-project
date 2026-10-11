import { convertToPrimary } from "./agentQueries";
import { expenseAmountForMonth, YearMonth } from "./http";

// Pure budget-alert logic for the notifyBudgetThreshold trigger. No firebase-admin here.
//
// Spend semantics mirror the app's "spent this month vs categoryBudgets" view
// (src/stores/transactionsStore.ts spendingByCategoryThisMonth L316-327, used by
// src/views/Goals.vue L549-553 and src/views/Dashboard.vue L751-757):
// - only `type === 'expense'` with a categoryId counts; income, transfer, loan and
//   loan_payment are ignored (bridge mirror legs are transfers, so they are excluded too);
// - the amount is |amount| (expenses are stored negative), installment purchases split
//   per month to the cent (src/lib/installments.ts expenseAmountForMonth, server port in
//   http.ts expenseAmountForMonth);
// - currency: goalsStore.convertToPrimary (L46-50) with workspace `exchangeRates`,
//   1:1 when a rate is missing (server port in agentQueries.ts convertToPrimary).
// The browser buckets months in its local time zone; the server uses an explicit zone
// (see notifyBudgetThreshold for how it is chosen).

export const BUDGET_ALERTS_COLLECTION = "budgetAlerts";
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];

export interface SpendOptions {
  timeZone: string;
  primaryCurrency: string;
  exchangeRates: Record<string, number>;
}

/** "YYYY-MM" for a 0-based YearMonth. */
export function monthKey({ year, month }: YearMonth): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Server-only dedupe ledger doc id: one per (workspace, month, category). */
export function budgetAlertLedgerId(workspaceId: string, month: string, categoryId: string): string {
  return `${workspaceId}_${month}_${categoryId}`;
}

/** Monthly budget of a category, or 0 when absent/invalid (no alerts). */
export function budgetForCategory(categoryBudgets: Record<string, unknown> | null | undefined, categoryId: string): number {
  const value = Number(categoryBudgets?.[categoryId]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Category of an expense that has a share in `month`, i.e. a write that can change that
 * category's spend for the month. Null for deletes, non-expenses or other months.
 */
export function alertCategoryFor(
  tx: Record<string, any> | undefined,
  month: YearMonth,
  options: { timeZone: string }
): string | null {
  if (!tx || tx.type !== "expense") return null;
  if (typeof tx.categoryId !== "string" || !tx.categoryId) return null;
  return expenseAmountForMonth(tx, month.year, month.month, options.timeZone) > 0 ? tx.categoryId : null;
}

/** Spend of one category in one local month, converted to the primary currency and rounded to cents. */
export function categorySpendForMonth(
  transactions: Iterable<Record<string, any>>,
  categoryId: string,
  month: YearMonth,
  options: SpendOptions
): number {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense" || tx.categoryId !== categoryId) continue;
    const amount = expenseAmountForMonth(tx, month.year, month.month, options.timeZone);
    if (amount === 0) continue;
    total += convertToPrimary(amount, tx.currency, options.primaryCurrency, options.exchangeRates).value;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Highest threshold newly reached and every threshold to mark as notified.
 * Reaching 100% implies 80%, so a jump past both sends a single (100%) alert.
 * Thresholds already notified never alert again in the month, even if spend dips and rises.
 */
export function evaluateBudgetThresholds(
  spent: number,
  budget: number,
  notified: readonly number[]
): { threshold: BudgetThreshold | null; claim: BudgetThreshold[] } {
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(spent)) return { threshold: null, claim: [] };
  // spent * 100 >= threshold * budget avoids float division drift.
  const reached = BUDGET_ALERT_THRESHOLDS.filter((threshold) => spent * 100 >= threshold * budget);
  if (reached.length === 0) return { threshold: null, claim: [] };
  const highest = reached[reached.length - 1];
  if (notified.includes(highest)) return { threshold: null, claim: [] };
  return { threshold: highest, claim: reached.filter((threshold) => !notified.includes(threshold)) };
}
