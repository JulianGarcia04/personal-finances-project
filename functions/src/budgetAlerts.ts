import { cardBillingByAccount, type CardLedgerTransaction } from "./cardStatements";
import {
  CardBilling,
  cardBillingOf,
  expenseAmountForMonth,
  ImputationBasis,
  storedDateValue,
  workspaceCardBasis,
  YearMonth,
  zonedYearMonth
} from "./http";
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
//   the card month of billed credit cards (src/lib/installments.ts expenseAmountForMonth, server
//   port http.ts expenseAmountForMonth) by the basis the workspace owner chose for budgets
//   (alertCardBilling); event scopes count the full assigned principal once
//   (src/lib/budgets.ts eventBudgetCommittedAllocation);
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
/** Ledger slot of a budget's spending vs the income assigned to it. */
export const FUNDS_ALERT_SUBJECT = "__funds";

export type BillingLookup = (accountId?: string | null) => CardBilling | null;

type AlertAccount = { id: string; [key: string]: unknown };

/**
 * Transaction types the alerts read for a workspace. Pagos also reads loans and loan payments,
 * because the card ledger counts every charge and credit on a card (cardStatements.ts).
 */
export function alertTransactionTypes(basis: ImputationBasis): string[] {
  const types = ["expense", "income", "transfer"];
  return basis === "payment" ? [...types, "loan", "loan_payment"] : types;
}

/** Credit cards whose purchases bill by statement (cardBillingOf). */
function billingCardIds(accounts: readonly AlertAccount[]): Set<string> {
  return new Set(accounts.filter((account) => cardBillingOf(account) !== null).map((account) => account.id));
}

/**
 * Card billing of the alerts, by the basis the workspace owner chose for budgets
 * (workspaceCardBasis, Consumo by default). Consumo counts card purchases in their statement
 * cycle month. Pagos counts them when their statement is paid: payments made early count in the
 * month they were made and only the unpaid rest in the payment month (cardStatements.ts, like the
 * app's createCardBillingLookup). `ledgerInput` holds the workspace's transactions (whole history,
 * every type) and the owner's time zone; only Pagos reads it.
 */
export function alertCardBilling(
  workspace: Record<string, any> | null | undefined,
  accounts: AlertAccount[],
  ledgerInput?: { transactions: readonly Record<string, any>[]; timeZone: string }
): { basis: ImputationBasis; billingFor: BillingLookup } {
  const basis = workspaceCardBasis(workspace);
  let billing: Map<string, CardBilling>;
  if (basis === "payment" && ledgerInput) {
    const cards = billingCardIds(accounts);
    const movements = ledgerInput.transactions.filter((tx) =>
      cards.has(tx.accountId) || (tx.type === "transfer" && cards.has(tx.toAccountId)));
    billing = cardBillingByAccount(accounts, basis, {
      transactions: movements as CardLedgerTransaction[],
      timeZone: ledgerInput.timeZone
    });
  } else {
    billing = cardBillingByAccount(accounts, basis);
  }
  return { basis, billingFor: (accountId) => (accountId ? billing.get(accountId) ?? null : null) };
}

/**
 * Account a movement credits in the card ledger (cardStatements.ts): the destination of a
 * transfer, or the account of any other non-expense movement with a positive amount (a refund, a
 * loan repayment). Null for charges and anything else.
 */
export function creditedAccountOf(tx: Record<string, any> | undefined): string | null {
  if (!tx) return null;
  if (tx.type === "transfer") {
    return typeof tx.toAccountId === "string" && tx.toAccountId && tx.toAccountId !== tx.accountId ? tx.toAccountId : null;
  }
  if (tx.type === "expense" || typeof tx.amount !== "number" || !(tx.amount > 0)) return null;
  return typeof tx.accountId === "string" && tx.accountId ? tx.accountId : null;
}

/**
 * Billing cards a write credits, before or after it, when that moves what the alerts count. Under
 * Pagos a payment or credit on a card moves its statements' spending into the month it was made,
 * so creating, editing or deleting one can push a budget over a threshold. Under Consumo card
 * payments move nothing (none).
 */
export function alertCardCredits(
  basis: ImputationBasis,
  before: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
  accounts: readonly AlertAccount[]
): string[] {
  if (basis !== "payment") return [];
  const cards = billingCardIds(accounts);
  const credited = [creditedAccountOf(before), creditedAccountOf(after)]
    .filter((accountId): accountId is string => accountId !== null && cards.has(accountId));
  return [...new Set(credited)];
}

/**
 * Whether the trigger can stop before reading anything else: a write that only moves money
 * between accounts no active budget links (skipsUnlinkedTransferWrite) and credits no billing
 * card that counts (alertCardCredits).
 */
export function skipsAlertWrite(
  before: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
  linkedBudgetOf: LinkedBudgetLookup,
  cardCredits: readonly string[]
): boolean {
  return cardCredits.length === 0 && skipsUnlinkedTransferWrite(before, after, linkedBudgetOf);
}

/**
 * Budgets and categories a payment or credit on the given cards can push over a threshold: those
 * of every expense on those cards with a share in the evaluated month. Budget id -> categories of
 * those expenses (empty when they are all uncategorized), in first-seen order.
 */
export function cardCreditAlertScopes(
  expenses: Iterable<Record<string, any>>,
  cardIds: readonly string[],
  month: YearMonth,
  options: { timeZone: string; billingFor?: BillingLookup }
): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  if (cardIds.length === 0) return scopes;
  const cards = new Set(cardIds);
  for (const tx of expenses) {
    if (typeof tx.accountId !== "string" || !cards.has(tx.accountId)) continue;
    if (!countsTowardMonthlySpend(tx, month, options)) continue;
    const budgetId = resolveAlertBudgetId(tx.budgetId);
    const categories = scopes.get(budgetId) ?? [];
    if (typeof tx.categoryId === "string" && tx.categoryId && !categories.includes(tx.categoryId)) categories.push(tx.categoryId);
    scopes.set(budgetId, categories);
  }
  return scopes;
}

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

/** Active budget each account is linked to, or null. */
export type LinkedBudgetLookup = (accountId: string) => string | null;

/**
 * How a transfer moves a budget's funds, by the accounts it touches (never by its stored sign,
 * which older records may hold negative): into a linked account adds, out of it subtracts, and
 * between two accounts of the same budget the money never leaves it.
 * Port of src/lib/budgets.ts transferFundsDelta.
 */
export function transferFundsDelta(tx: Record<string, any>, budgetId: string, linkedBudgetOf: LinkedBudgetLookup): number {
  if (tx.type !== "transfer" || typeof tx.accountId !== "string" || typeof tx.toAccountId !== "string") return 0;
  const from = linkedBudgetOf(tx.accountId);
  const to = linkedBudgetOf(tx.toAccountId);
  if (from === to) return 0;
  const amount = Math.abs(Number(tx.amount) || 0);
  if (to === budgetId) return amount;
  if (from === budgetId) return -amount;
  return 0;
}

/** Whether a transfer enters or leaves an account linked to an active budget. */
export function transferTouchesLinkedAccount(tx: Record<string, any> | undefined, linkedBudgetOf: LinkedBudgetLookup): boolean {
  if (!tx || tx.type !== "transfer") return false;
  return [tx.accountId, tx.toAccountId].some((accountId) => typeof accountId === "string" && linkedBudgetOf(accountId) !== null);
}

/**
 * A write whose every side is a transfer and none touches a linked account moves no income,
 * spending or funds, so the alert trigger can stop before reading anything else.
 */
export function skipsUnlinkedTransferWrite(
  before: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
  linkedBudgetOf: LinkedBudgetLookup
): boolean {
  const sides = [before, after].filter((tx): tx is Record<string, any> => tx !== undefined);
  return sides.length > 0 && sides.every((tx) => tx.type === "transfer" && !transferTouchesLinkedAccount(tx, linkedBudgetOf));
}

/** Budgets a transfer moves funds between (the linked budgets of its two accounts, when they differ). */
function transferBudgetIds(tx: Record<string, any> | undefined, linkedBudgetOf?: LinkedBudgetLookup): string[] {
  if (!tx || tx.type !== "transfer" || !linkedBudgetOf || typeof tx.accountId !== "string" || typeof tx.toAccountId !== "string") return [];
  const from = linkedBudgetOf(tx.accountId);
  const to = linkedBudgetOf(tx.toAccountId);
  if (from === to) return [];
  return [from, to].filter((id): id is string => id !== null);
}

/**
 * Budgets paid by their own dedicated income in the evaluated period, so their spending does not
 * count against the month's regular income: a budget qualifies only when it has positive assigned
 * income (`type === 'income'` with `budgetId === budget.id` — any time for event budgets, in the
 * evaluated month for monthly budgets) AND its net funds in that period (assigned income plus
 * transfers into its linked accounts minus transfers out) remain strictly positive.
 *
 * Transfers alone (moving regular monthly salary from an unlinked account into a linked budget
 * account) fund the budget card ("Fondos") but do NOT make it self-funded, because that money
 * remained in `monthlyIncome` and excluding its expenses would erase cash outflow.
 * Unknown budgets (`kindOf` returns undefined) never qualify.
 */
export function selfFundedBudgetIds(
  funding: Iterable<Record<string, any>>,
  month: YearMonth,
  options: { timeZone: string; reportingCurrency?: string; exchangeRates?: Record<string, number> },
  kindOf: (budgetId: string) => AlertScope["kind"] | undefined,
  linkedBudgetOf?: LinkedBudgetLookup
): Set<string> {
  const hasAssignedIncome = new Set<string>();
  const hasOutflow = new Set<string>();
  const unknownRate = new Set<string>();
  const netFunds = new Map<string, number>();

  const appliesToPeriod = (budgetId: string, txDate: unknown): boolean => {
    const kind = kindOf(budgetId);
    return kind === "event" || (kind === "monthly" && inYearMonth(txDate, month, options.timeZone));
  };

  const convertAmount = (amount: number, currency: unknown): number | null => {
    if (!options.reportingCurrency) return amount;
    const rate = manualRate(currency, options.reportingCurrency, options.exchangeRates ?? {});
    return rate === null ? null : amount * rate;
  };

  const applyDelta = (budgetId: string, rawDelta: number, tx: Record<string, any>) => {
    if (budgetId === DEFAULT_MONTHLY_BUDGET_ID || rawDelta === 0) return;
    if (!appliesToPeriod(budgetId, tx.date)) return;
    if (rawDelta < 0) hasOutflow.add(budgetId);
    const converted = convertAmount(Math.abs(rawDelta), tx.currency);
    if (converted === null) {
      unknownRate.add(budgetId);
      return;
    }
    netFunds.set(budgetId, (netFunds.get(budgetId) ?? 0) + (rawDelta > 0 ? converted : -converted));
  };

  for (const tx of funding) {
    const rawAmount = Math.abs(Number(tx.amount) || 0);
    if (rawAmount <= 0) continue;

    if (tx.type === "income") {
      const budgetId = resolveAlertBudgetId(tx.budgetId);
      if (budgetId === DEFAULT_MONTHLY_BUDGET_ID) continue;
      if (!appliesToPeriod(budgetId, tx.date)) continue;
      hasAssignedIncome.add(budgetId);
      applyDelta(budgetId, rawAmount, tx);
    } else if (tx.type === "transfer" && linkedBudgetOf && typeof tx.accountId === "string" && typeof tx.toAccountId === "string") {
      const from = linkedBudgetOf(tx.accountId);
      const to = linkedBudgetOf(tx.toAccountId);
      if (from === to) continue;
      if (to) applyDelta(to, rawAmount, tx);
      if (from) applyDelta(from, -rawAmount, tx);
    }
  }

  const funded = new Set<string>();
  for (const budgetId of hasAssignedIncome) {
    // If a currency rate is missing and there are no outflows, net funds are still strictly positive.
    if (unknownRate.has(budgetId)) {
      if (!hasOutflow.has(budgetId)) funded.add(budgetId);
      continue;
    }
    if (Math.round((netFunds.get(budgetId) ?? 0) * 100) / 100 > 0) funded.add(budgetId);
  }
  return funded;
}

/** Whether a stored date falls in the given local month; malformed dates never do. */
function inYearMonth(value: unknown, month: YearMonth, timeZone: string): boolean {
  const date = storedDateValue(value, timeZone);
  if (Number.isNaN(date.getTime())) return false;
  const local = zonedYearMonth(date, timeZone);
  return local.year === month.year && local.month === month.month;
}

/** Manual source -> reporting rate (port of budgetReporting.ts lookupRate); null when missing/invalid. */
function manualRate(currency: unknown, reportingCurrency: string, rates: Record<string, number>): number | null {
  if (currency === reportingCurrency) return 1;
  if (typeof currency !== "string" || !Object.prototype.hasOwnProperty.call(rates ?? {}, currency)) return null;
  const rate = rates[currency];
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Returns workspace manual FX rates only when their explicit base currency matches `reportingCurrency`
 * (or when legacy rates have no stored base). Prevents applying rates authored for another currency.
 */
export function effectiveWorkspaceExchangeRates(
  workspace: Record<string, any> | null | undefined,
  reportingCurrency: string
): { rates: Record<string, number>; mismatchedBase: string | null } {
  const raw = workspace?.exchangeRates && typeof workspace.exchangeRates === "object" && !Array.isArray(workspace.exchangeRates)
    ? (workspace.exchangeRates as Record<string, number>)
    : {};
  const base = typeof workspace?.exchangeRatesBaseCurrency === "string" && /^[A-Z]{3}$/.test(workspace.exchangeRatesBaseCurrency)
    ? workspace.exchangeRatesBaseCurrency
    : null;
  if (base && base !== reportingCurrency && Object.keys(raw).length > 0) {
    return { rates: {}, mismatchedBase: base };
  }
  return { rates: raw, mismatchedBase: null };
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

/**
 * Month share of every expense paid by the month's income, converted; null when a manual
 * rate is missing. Expenses of self-funded budgets are skipped.
 */
export function monthlyExpenseTotal(
  transactions: Iterable<Record<string, any>>,
  month: YearMonth,
  options: SpendOptions,
  selfFunded: ReadonlySet<string> = new Set()
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense" || selfFunded.has(resolveAlertBudgetId(tx.budgetId))) continue;
    const amount = expenseAmountForMonth(tx, month.year, month.month, options.timeZone, options.billingFor?.(tx.accountId) ?? null);
    if (amount === 0) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    if (rate === null) return null;
    total += amount * rate;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Income registered in the local month, converted; null when a manual rate is missing.
 * Income assigned to another budget funds only that budget, so it is not monthly income.
 */
export function monthlyIncomeTotal(
  transactions: Iterable<Record<string, any>>,
  month: YearMonth,
  options: SpendOptions
): number | null {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "income" || resolveAlertBudgetId(tx.budgetId) !== DEFAULT_MONTHLY_BUDGET_ID) continue;
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
 * Funds movements of an operating budget: the income assigned to it plus transfers into its linked
 * accounts minus transfers out of them; all of them for an event budget and the month's for a
 * monthly one (like budgetReporting.ts funds). `inflows` counts the funding inflows (assigned income
 * or a transfer in); `total` is null when a manual rate is missing.
 */
export function scopeFunding(
  funding: Iterable<Record<string, any>>,
  scope: AlertScope,
  month: YearMonth,
  options: SpendOptions,
  linkedBudgetOf?: LinkedBudgetLookup
): { total: number | null; inflows: number } {
  let total: number | null = 0;
  let inflows = 0;
  for (const tx of funding) {
    // Assigned income adds; transfers add or subtract by the linked accounts they touch.
    const delta = tx.type === "income"
      ? (resolveAlertBudgetId(tx.budgetId) === scope.id ? Math.abs(Number(tx.amount) || 0) : 0)
      : linkedBudgetOf ? transferFundsDelta(tx, scope.id, linkedBudgetOf) : 0;
    if (delta === 0) continue;
    if (scope.kind === "monthly" && !inYearMonth(tx.date, month, options.timeZone)) continue;
    if (delta > 0) inflows += 1;
    if (total === null) continue;
    const rate = manualRate(tx.currency, options.reportingCurrency, options.exchangeRates);
    total = rate === null ? null : total + delta * rate;
  }
  return { total: total === null ? null : Math.round(total * 100) / 100, inflows };
}

/**
 * Funds of an operating budget (scopeFunding). A budget without any funding inflow in the period
 * has no funds (0), even if money was transferred out, so its funds alert stays silent; with an
 * inflow, outflows above it give real negative funds. Null when a manual rate is missing.
 */
export function scopeFundsTotal(
  funding: Iterable<Record<string, any>>,
  scope: AlertScope,
  month: YearMonth,
  options: SpendOptions,
  linkedBudgetOf?: LinkedBudgetLookup
): number | null {
  const { total, inflows } = scopeFunding(funding, scope, month, options, linkedBudgetOf);
  return inflows === 0 ? 0 : total;
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
/**
 * What an income or transfer write (create, edit or delete) can push over a threshold:
 * - the month's spending vs income, when the current month's unassigned income drops or a budget
 *   loses income (it may stop being self-funded, so its spending counts again);
 * - the funds alert of each budget whose assigned income changed (a first income can already be
 *   exceeded by the budget's spending).
 * Null when the write cannot newly cross any threshold.
 */
export function incomeChangeAlertScope(
  before: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
  month: YearMonth,
  options: { timeZone: string },
  linkedBudgetOf?: LinkedBudgetLookup
): { monthlyIncome: boolean; fundsBudgetIds: string[] } | null {
  // A transfer touching a linked account moves funds between budgets: re-check each of them and
  // the month's spending, since a budget may stop (or start) being self-funded.
  const transferBudgets = [...new Set([...transferBudgetIds(before, linkedBudgetOf), ...transferBudgetIds(after, linkedBudgetOf)])];
  const incomeBefore = before?.type === "income" ? before : undefined;
  const incomeAfter = after?.type === "income" ? after : undefined;
  if (!incomeBefore && !incomeAfter) {
    return transferBudgets.length ? { monthlyIncome: true, fundsBudgetIds: transferBudgets } : null;
  }
  const amountOf = (tx: Record<string, any> | undefined) => tx ? Math.abs(Number(tx.amount) || 0) : 0;
  const budgetOf = (tx: Record<string, any> | undefined) => tx ? resolveAlertBudgetId(tx.budgetId) : null;
  const monthlyShare = (tx: Record<string, any> | undefined) =>
    tx && budgetOf(tx) === DEFAULT_MONTHLY_BUDGET_ID && inYearMonth(tx.date, month, options.timeZone) ? amountOf(tx) : 0;
  const beforeBudgetId = budgetOf(incomeBefore);
  const afterBudgetId = budgetOf(incomeAfter);
  const assigned = (budgetId: string | null): budgetId is string => budgetId !== null && budgetId !== DEFAULT_MONTHLY_BUDGET_ID;

  const fundsBudgetIds: string[] = [];
  if (assigned(beforeBudgetId)) fundsBudgetIds.push(beforeBudgetId);
  if (assigned(afterBudgetId) && afterBudgetId !== beforeBudgetId) fundsBudgetIds.push(afterBudgetId);
  for (const budgetId of transferBudgets) if (!fundsBudgetIds.includes(budgetId)) fundsBudgetIds.push(budgetId);
  const monthlyIncome = monthlyShare(incomeAfter) < monthlyShare(incomeBefore) || assigned(beforeBudgetId) ||
    transferBudgets.length > 0;
  if (!monthlyIncome && fundsBudgetIds.length === 0) return null;
  return { monthlyIncome, fundsBudgetIds };
}

export function spendFieldsChanged(before: Record<string, any> | undefined, after: Record<string, any> | undefined): boolean {
  if (!before || !after) return true;
  return before.type !== after.type ||
    before.categoryId !== after.categoryId ||
    (before.budgetId ?? null) !== (after.budgetId ?? null) ||
    (before.accountId ?? null) !== (after.accountId ?? null) ||
    (before.toAccountId ?? null) !== (after.toAccountId ?? null) ||
    Number(before.amount) !== Number(after.amount) ||
    (before.currency ?? null) !== (after.currency ?? null) ||
    (before.installments ?? null) !== (after.installments ?? null) ||
    timeOf(before.date) !== timeOf(after.date);
}
