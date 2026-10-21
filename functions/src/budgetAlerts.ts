import { CardBilling, expenseAmountForMonth, storedDateValue, YearMonth, zonedYearMonth } from "./http";
import { DEFAULT_MONTHLY_BUDGET_ID } from "./legacyCategoryBudgets";

// Pure budget-alert logic for the notifyBudgetThreshold trigger. No firebase-admin here.
//
// Spend vs cap semantics mirror the app's category comparison, src/lib/budgetReporting.ts
// reportBudgetScope (used by src/views/Dashboard.vue budgetSummary and src/views/Goals.vue
// baselineBudgetReport):
// - every expense belongs to one operating budget: `budgetId`, or the protected default
//   monthly budget when absent (src/lib/budgets.ts resolveBudgetId). The default budget's
//   caps are workspaces/{id}.categoryBudgets; additional budgets keep theirs in
//   budgets/{id}/categoryCaps/{categoryId}.amount;
// - only `type === 'expense'` with a categoryId counts; income, transfers (including card
//   repayments and mirror legs), loans and loan payments are ignored;
// - monthly scopes count this month's share, installments split to the cent and imputed to
//   the card statement payment month for billed credit cards (src/lib/installments.ts
//   expenseAmountForMonth, server port http.ts expenseAmountForMonth); event scopes count
//   the full assigned principal once (src/lib/budgets.ts eventBudgetCommittedAllocation);
// - currency: expenses and the cap are converted to the reporting currency with the manual
//   workspace `exchangeRates` (source -> reporting). A missing/invalid rate or an
//   unconfirmed cap currency makes the comparison unknown (null): no 1:1 fallback.
// The browser buckets months in its local time zone; the server uses an explicit zone
// (see notifyBudgetThreshold for how it is chosen).

export const BUDGET_ALERTS_COLLECTION = "budgetAlerts";
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];
/** Ledger slot (in place of a category id) for alerts on a budget's overall cap. */
export const TOTAL_ALERT_SUBJECT = "__total";

export type BillingLookup = (accountId?: string | null) => CardBilling | null;

/** Operating budget whose category cap an expense counts against. */
export interface AlertScope {
  id: string;
  kind: "monthly" | "event";
}

export interface SpendOptions {
  timeZone: string;
  reportingCurrency: string;
  exchangeRates: Record<string, number>;
  billingFor?: BillingLookup;
}

/** Operating budget of an expense: its budgetId, or the protected default monthly budget. */
export function resolveAlertBudgetId(budgetId: unknown): string {
  return typeof budgetId === "string" && budgetId ? budgetId : DEFAULT_MONTHLY_BUDGET_ID;
}

/** Manual source -> reporting rate (port of budgetReporting.ts lookupRate); null when missing/invalid. */
function manualRate(currency: unknown, reportingCurrency: string, rates: Record<string, number>): number | null {
  if (currency === reportingCurrency) return 1;
  if (typeof currency !== "string" || !Object.prototype.hasOwnProperty.call(rates ?? {}, currency)) return null;
  const rate = rates[currency];
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Nominal cap in its stored denomination, converted to the reporting currency; null when not comparable. */
export function capInReportingCurrency(
  amount: number,
  capCurrency: string | null,
  reportingCurrency: string,
  rates: Record<string, number>
): number | null {
  if (capCurrency === null) return null;
  const rate = manualRate(capCurrency, reportingCurrency, rates);
  return rate === null ? null : amount * rate;
}

/** "YYYY-MM" for a 0-based YearMonth. */
export function monthKey({ year, month }: YearMonth): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * Server-only dedupe ledger doc id: one per (workspace, budget, period, category). `period` is
 * the month key for monthly budgets and "event" for event budgets. The default budget keeps
 * the original `{workspace}_{month}_{category}` id so ledgers written before multiple budgets
 * still dedupe.
 */
export function budgetAlertLedgerId(workspaceId: string, budgetId: string, period: string, categoryId: string): string {
  return budgetId === DEFAULT_MONTHLY_BUDGET_ID
    ? `${workspaceId}_${period}_${categoryId}`
    : `${workspaceId}_${budgetId}_${period}_${categoryId}`;
}

/** Category cap amount, or 0 when absent/invalid (no alerts). */
export function budgetForCategory(categoryBudgets: Record<string, unknown> | null | undefined, categoryId: string): number {
  const value = Number(categoryBudgets?.[categoryId]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** This expense's contribution to its scope: month share (monthly) or full principal (event). */
function scopeAmount(tx: Record<string, any>, scope: AlertScope, month: YearMonth, timeZone: string, billingFor?: BillingLookup): number {
  if (scope.kind === "event") return Math.abs(Number(tx.amount) || 0);
  return expenseAmountForMonth(tx, month.year, month.month, timeZone, billingFor?.(tx.accountId) ?? null);
}

/**
 * Category of an expense of `scope` that counts in the evaluated period, i.e. a write that can
 * change that category's spend against the scope's cap. Null for deletes, non-expenses, other
 * budgets or other months.
 */
export function alertCategoryFor(
  tx: Record<string, any> | undefined,
  scope: AlertScope,
  month: YearMonth,
  options: { timeZone: string; billingFor?: BillingLookup }
): string | null {
  if (!tx || tx.type !== "expense") return null;
  if (typeof tx.categoryId !== "string" || !tx.categoryId) return null;
  if (resolveAlertBudgetId(tx.budgetId) !== scope.id) return null;
  return scopeAmount(tx, scope, month, options.timeZone, options.billingFor) > 0 ? tx.categoryId : null;
}

/**
 * Spend of one category in one scope, converted to the reporting currency and rounded to
 * cents. Null when any contributing expense lacks a valid manual rate (the app shows no total).
 */
export function categorySpendForScope(
  transactions: Iterable<Record<string, any>>,
  categoryId: string,
  scope: AlertScope,
  month: YearMonth,
  options: SpendOptions
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense" || tx.categoryId !== categoryId) continue;
    if (resolveAlertBudgetId(tx.budgetId) !== scope.id) continue;
    const amount = scopeAmount(tx, scope, month, options.timeZone, options.billingFor);
    if (amount === 0) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    if (rate === null) return null;
    total += amount * rate;
  }
  return Math.round(total * 100) / 100;
}

/** Whether an expense feeds an additional budget's overall cap (`totalLimit`) in the evaluated period. */
export function countsTowardScopeTotal(
  tx: Record<string, any> | undefined,
  scope: AlertScope,
  month: YearMonth,
  options: { timeZone: string; billingFor?: BillingLookup }
): boolean {
  if (!tx || tx.type !== "expense") return false;
  if (resolveAlertBudgetId(tx.budgetId) !== scope.id) return false;
  return scopeAmount(tx, scope, month, options.timeZone, options.billingFor) > 0;
}

/**
 * Spend of a whole operating budget (every category, uncategorized included), like
 * budgetReporting.ts reportBudgetScope totalComparison. Null when a manual rate is missing.
 */
export function scopeTotalSpend(
  transactions: Iterable<Record<string, any>>,
  scope: AlertScope,
  month: YearMonth,
  options: SpendOptions
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense" || resolveAlertBudgetId(tx.budgetId) !== scope.id) continue;
    const amount = scopeAmount(tx, scope, month, options.timeZone, options.billingFor);
    if (amount === 0) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    if (rate === null) return null;
    total += amount * rate;
  }
  return Math.round(total * 100) / 100;
}

// Workspace-wide "spending vs income" alert (the default budget's overall cap). Mirrors the
// real month totals in src/views/Goals.vue realMonthTotals: every expense's month share (any
// budget, card installments in their payment month) against income registered in the month.

/** Whether an expense (any budget) has a share in the evaluated month. */
export function countsTowardMonthlySpend(
  tx: Record<string, any> | undefined,
  month: YearMonth,
  options: { timeZone: string; billingFor?: BillingLookup }
): boolean {
  if (!tx || tx.type !== "expense") return false;
  return expenseAmountForMonth(tx, month.year, month.month, options.timeZone, options.billingFor?.(tx.accountId) ?? null) > 0;
}

/** Month share of every expense, converted; null when a manual rate is missing. */
export function monthlyExpenseTotal(
  transactions: Iterable<Record<string, any>>,
  month: YearMonth,
  options: SpendOptions
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    const amount = expenseAmountForMonth(tx, month.year, month.month, options.timeZone, options.billingFor?.(tx.accountId) ?? null);
    if (amount === 0) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    if (rate === null) return null;
    total += amount * rate;
  }
  return Math.round(total * 100) / 100;
}

/** Income registered in the local month, converted; null when a manual rate is missing. */
export function monthlyIncomeTotal(
  transactions: Iterable<Record<string, any>>,
  month: YearMonth,
  options: SpendOptions
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "income") continue;
    const date = storedDateValue(tx.date, options.timeZone);
    if (Number.isNaN(date.getTime())) continue; // malformed date: skip, like expenseAmountForMonth
    const local = zonedYearMonth(date, options.timeZone);
    if (local.year !== month.year || local.month !== month.month) continue;
    const amount = Math.abs(Number(tx.amount) || 0);
    if (amount === 0) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    if (rate === null) return null;
    total += amount * rate;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Income the month's spending is compared with: the larger of the planner's monthly income
 * (workspaces.budgetIncome) and the income actually registered, so a month with extra income
 * widens the margin while an early month (salary not yet registered) still has the planner as
 * floor. Either alone when the other is absent/unknown; null when neither is positive.
 */
export function incomeReference(plannerIncome: unknown, realIncome: number | null): number | null {
  const planner = Number(plannerIncome);
  const candidates = [Number.isFinite(planner) ? planner : 0, realIncome ?? 0].filter((value) => value > 0);
  return candidates.length === 0 ? null : Math.max(...candidates);
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

function timeOf(value: any): number | null {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : value == null ? null : new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
}

/** True when a write may change category spend (so edits to description/notes/receipt are skipped). */
export function spendFieldsChanged(before: Record<string, any> | undefined, after: Record<string, any> | undefined): boolean {
  if (!before || !after) return true;
  return before.type !== after.type ||
    before.categoryId !== after.categoryId ||
    (before.budgetId ?? null) !== (after.budgetId ?? null) ||
    (before.accountId ?? null) !== (after.accountId ?? null) ||
    Number(before.amount) !== Number(after.amount) ||
    (before.currency ?? null) !== (after.currency ?? null) ||
    (before.installments ?? null) !== (after.installments ?? null) ||
    timeOf(before.date) !== timeOf(after.date);
}
