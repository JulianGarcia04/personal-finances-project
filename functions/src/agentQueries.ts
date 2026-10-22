import { AgentToolError, buildDateContext, NameMaps } from "./agentTools";
import { CardBilling, cardBillingOf, paymentMonthIndex, YearMonth, zonedDateKey, zonedWallClockToInstant, zonedYearMonth } from "./http";
import {
  AlertScope,
  LinkedBudgetLookup,
  monthlyExpenseTotal,
  monthlyIncomeTotal,
  scopeFunding,
  scopeTotalSpend,
  selfFundedBudgetIds,
  SpendOptions
} from "./budgetAlerts";

// Pure period aggregation for the chat agent (getFinancialSummary /
// getWorkspaceSettings). No firebase-admin here: callers pass plain rows.
//
// Semantics are ported from the app dashboard so the agent and the KPIs agree:
// - Income: `type === 'income'`, full |amount| in the local month of its date
//   (src/views/Dashboard.vue getMoMData, L455-479).
// - Expenses: `type === 'expense'`, installment purchases split per month to the
//   cent (src/lib/installments.ts expenseAmountForMonth / prorateInstallmentCents).
//   On a credit card with both billing days, installment i falls in the month the
//   statement containing the purchase is paid, plus i (getPaymentBucket).
// - transfer, loan and loan_payment are neither income nor spend (Dashboard only
//   reads 'income'/'expense'). A bridge expense's local leg is a normal expense
//   and its mirror leg is a transfer (src/stores/transactionsStore.ts
//   addMirroredExpense L629-662), so type filtering already handles mirrors.
// - Currency: src/stores/goalsStore.ts convertToPrimary (L46-50), 1:1 fallback.
// - savingsRate: Dashboard.vue L544-548; percent change: getMoMData L476-477.

export type SummaryPreset =
  | "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "this_year" | "last_year";
export type SummaryGroupBy = "category" | "account" | "month" | "day" | "none";
export type SummaryType = "expense" | "income" | "all";

export interface SummaryTransaction {
  id: string;
  type: string;
  amount: number;
  date: Date;
  currency?: string | null;
  accountId?: string | null;
  categoryId?: string | null;
  description?: string | null;
  installments?: number | null;
  [key: string]: unknown;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DAY_MS = 86_400_000;

const round2 = (value: number) => Math.round(value * 100) / 100;

// --- Currency ------------------------------------------------------------------

/** Port of goalsStore.convertToPrimary: blank/primary as-is, missing or zero rate → 1:1 (flagged). */
export function convertToPrimary(
  amount: number,
  currency: string | null | undefined,
  primaryCurrency: string,
  rates: Record<string, number>
): { value: number; missingRate: boolean } {
  if (!currency || currency === primaryCurrency) return { value: amount, missingRate: false };
  const rate = Number(rates[currency]);
  return rate ? { value: amount * rate, missingRate: false } : { value: amount, missingRate: true };
}

// --- Periods -------------------------------------------------------------------

interface DayKey { year: number; month: number; day: number }

function keyParts(key: string): DayKey {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month: month - 1, day };
}

function utcKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftKey(key: string, days: number): string {
  const { year, month, day } = keyParts(key);
  return utcKey(Date.UTC(year, month, day) + days * DAY_MS);
}

const monthLabel = (year: number, month: number) => `${MONTHS[month]} de ${year}`;

export interface ResolvedPeriod {
  start: string;
  end: string;
  label: string;
  startInstant: Date;
  endExclusive: Date;
  /** How the previous period is derived. */
  kind: "days" | "month" | "year" | "months";
  /** Calendar months covered (only for whole-month periods). */
  months?: number;
}

function makePeriod(start: string, end: string, timeZone: string, kind: ResolvedPeriod["kind"], label?: string, months?: number): ResolvedPeriod {
  const s = keyParts(start);
  const e = keyParts(end);
  return {
    start,
    end,
    label: label ?? (start === end ? start : `${start} a ${end}`),
    startInstant: zonedWallClockToInstant(s.year, s.month, s.day, 0, timeZone),
    endExclusive: zonedWallClockToInstant(e.year, e.month, e.day + 1, 0, timeZone),
    kind,
    months
  };
}

function monthsPeriod(year: number, month: number, count: number, timeZone: string, label?: string): ResolvedPeriod {
  const start = utcKey(Date.UTC(year, month, 1));
  const end = utcKey(Date.UTC(year, month + count, 0));
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + count - 1, 1));
  const defaultLabel = count === 1
    ? monthLabel(first.getUTCFullYear(), first.getUTCMonth())
    : `${monthLabel(first.getUTCFullYear(), first.getUTCMonth())} a ${monthLabel(last.getUTCFullYear(), last.getUTCMonth())}`;
  return makePeriod(start, end, timeZone, count === 1 ? "month" : "months", label ?? defaultLabel, count);
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
function checkKey(value: string): string {
  const parts = keyParts(value);
  if (!DATE_KEY.test(value) || utcKey(Date.UTC(parts.year, parts.month, parts.day)) !== value) {
    throw new AgentToolError(`Fecha inválida "${value}". Usa el formato YYYY-MM-DD con una fecha real.`);
  }
  return value;
}

export interface PeriodInput {
  preset?: SummaryPreset;
  startDate?: string;
  endDate?: string;
  /** Last N complete calendar months (the current partial month excluded). */
  lastCompleteMonths?: number;
}

/** Resolves a preset, an inclusive local date range or N complete months; defaults to this_month. */
export function resolvePeriod(input: PeriodInput, now: Date, timeZone: string): ResolvedPeriod {
  const selectors = [input.preset, input.startDate || input.endDate, input.lastCompleteMonths].filter(v => v !== undefined && v !== "");
  if (selectors.length > 1) {
    throw new AgentToolError("Usa solo una forma de periodo: preset, startDate/endDate o lastCompleteMonths.");
  }
  const today = zonedDateKey(now, timeZone);
  const { year, month } = keyParts(today);

  if (input.lastCompleteMonths !== undefined) {
    const count = input.lastCompleteMonths;
    const base = monthsPeriod(year, month - count, count, timeZone);
    // Always "months" so averages apply even for a single complete month.
    return { ...base, kind: "months", label: `${base.label} (${count === 1 ? "1 mes completo" : `${count} meses completos`})` };
  }
  if (input.startDate || input.endDate) {
    if (!input.startDate) throw new AgentToolError("Falta startDate: indica la fecha inicial del periodo.");
    const start = checkKey(input.startDate);
    const end = checkKey(input.endDate || today);
    if (start > end) throw new AgentToolError("La fecha inicial no puede ser posterior a la fecha final.");
    return makePeriod(start, end, timeZone, "days");
  }

  const ctx = buildDateContext(now, timeZone);
  switch (input.preset ?? "this_month") {
    case "today": return makePeriod(today, today, timeZone, "days", `hoy (${today})`);
    case "yesterday": return makePeriod(ctx.yesterday, ctx.yesterday, timeZone, "days", `ayer (${ctx.yesterday})`);
    case "this_week": return makePeriod(ctx.thisWeek.start, ctx.thisWeek.end, timeZone, "days", `esta semana (${ctx.thisWeek.start} a ${ctx.thisWeek.end})`);
    case "last_week": {
      const start = shiftKey(ctx.thisWeek.start, -7);
      const end = shiftKey(ctx.thisWeek.start, -1);
      return makePeriod(start, end, timeZone, "days", `semana pasada (${start} a ${end})`);
    }
    case "this_month": return monthsPeriod(year, month, 1, timeZone);
    case "last_month": return monthsPeriod(year, month - 1, 1, timeZone);
    case "this_year": return makePeriod(`${year}-01-01`, `${year}-12-31`, timeZone, "year", String(year), 12);
    case "last_year": return makePeriod(`${year - 1}-01-01`, `${year - 1}-12-31`, timeZone, "year", String(year - 1), 12);
    default: throw new AgentToolError("Periodo no reconocido.");
  }
}

/** Previous calendar month/year/N months for calendar periods; otherwise the equal-length range just before. */
export function previousPeriod(period: ResolvedPeriod, timeZone: string): ResolvedPeriod {
  const start = keyParts(period.start);
  if (period.kind === "month" || period.kind === "months") {
    const count = period.months ?? 1;
    return monthsPeriod(start.year, start.month - count, count, timeZone);
  }
  if (period.kind === "year") {
    const y = start.year - 1;
    return makePeriod(`${y}-01-01`, `${y}-12-31`, timeZone, "year", String(y), 12);
  }
  const end = keyParts(period.end);
  const length = (Date.UTC(end.year, end.month, end.day) - Date.UTC(start.year, start.month, start.day)) / DAY_MS + 1;
  return makePeriod(shiftKey(period.start, -length), shiftKey(period.start, -1), timeZone, "days");
}

// --- Contributions -------------------------------------------------------------

interface Contribution {
  tx: SummaryTransaction;
  kind: "income" | "expense";
  instant: Date;
  /** Positive amount in the transaction's currency. */
  amount: number;
  installmentIndex: number;
  installments: number;
  /** The instant is a scheduled share date (later installment or card due date), not the purchase. */
  scheduled: boolean;
  /** Imputed to a card statement payment month. */
  billed: boolean;
}

const installmentCount = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : 1);

/** Port of prorateInstallmentCents (src/lib/installments.ts L17-22). */
function prorateCents(total: number, installments: number, index: number): number {
  const totalCents = Math.round(Math.abs(total) * 100);
  const base = Math.floor(totalCents / installments);
  return (base + (index < totalCents % installments ? 1 : 0)) / 100;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * Income at its date; expenses as one share per installment. Share k falls on the
 * purchase's local day k months later (clamped to month end), so whole-month
 * periods match expenseAmountForMonth exactly and shorter periods get a date.
 * With card `billing`, share k falls at local noon of the (clamped) payment due day
 * of the statement payment month + k.
 */
function contributions(tx: SummaryTransaction, timeZone: string, billing?: CardBilling | null): Contribution[] {
  if (Number.isNaN(tx.date.getTime())) return [];
  if (tx.type === "income") {
    return [{ tx, kind: "income", instant: tx.date, amount: Math.abs(Number(tx.amount) || 0), installmentIndex: 0, installments: 1, scheduled: false, billed: false }];
  }
  if (tx.type !== "expense") return [];
  const installments = installmentCount(tx.installments);
  const local = keyParts(zonedDateKey(tx.date, timeZone));
  const paymentMonth = billing ? paymentMonthIndex(local.year, local.month, local.day, billing) : null;
  return Array.from({ length: installments }, (_, index) => {
    let instant = tx.date;
    if (paymentMonth !== null && billing) {
      const year = Math.floor((paymentMonth + index) / 12);
      const month = (paymentMonth + index) % 12;
      instant = zonedWallClockToInstant(year, month, Math.min(billing.paymentDueDay, daysInMonth(year, month)), 12, timeZone);
    } else if (index > 0) {
      const month = local.month + index;
      instant = zonedWallClockToInstant(local.year, month, Math.min(local.day, daysInMonth(local.year, month)), 12, timeZone);
    }
    return {
      tx,
      kind: "expense" as const,
      instant,
      amount: prorateCents(Number(tx.amount) || 0, installments, index),
      installmentIndex: index,
      installments,
      scheduled: paymentMonth !== null || index > 0,
      billed: paymentMonth !== null
    };
  });
}

/** Billing days by account id for the workspace's regular credit cards (see cardBillingOf). */
export function cardBillingByAccount(accounts: { id: string; [key: string]: unknown }[]): Map<string, CardBilling> {
  const billing = new Map<string, CardBilling>();
  for (const account of accounts) {
    const days = cardBillingOf(account);
    if (days) billing.set(account.id, days);
  }
  return billing;
}

/**
 * Earliest purchase instant whose card payment can fall at or after `start`: a statement
 * closes at most one month after the purchase and is paid at most one month later, so the
 * local start of the month two months before `start`'s month.
 */
export function billingLookbackStart(start: Date, timeZone: string): Date {
  const { year, month } = zonedYearMonth(start, timeZone);
  return zonedWallClockToInstant(year, month - 2, 1, 0, timeZone);
}

// --- Summary -------------------------------------------------------------------

export interface SummaryTotals {
  income: number;
  expenses: number;
  net: number;
  savingsRate: number;
  /** Future installment shares (after now) already included in expenses. */
  upcomingInstallments: number;
}

export interface SummaryGroup {
  key: string;
  name: string;
  income: number;
  expenses: number;
  net: number;
  count: number;
  monthlyAverageExpenses?: number;
}

export interface TopExpense {
  id: string;
  date: string;
  description: string;
  amount: number;
  originalAmount: number;
  originalCurrency: string;
  categoryName: string | null;
  accountName: string;
  installmentsInfo?: string;
}

export interface FinancialSummary {
  period: { start: string; end: string; label: string };
  currency: string;
  totals: SummaryTotals;
  groups: SummaryGroup[];
  topExpenses: TopExpense[];
  averages?: { months: number; incomePerMonth: number; expensesPerMonth: number };
  comparison?: {
    period: { start: string; end: string; label: string };
    totals: SummaryTotals;
    deltas: Record<"income" | "expenses" | "net", { diff: number; percent: number }>;
  };
  notes: string[];
  /** Per-budget view (S9); only with `budgetBreakdown`, whole calendar months and no account/category filter. */
  byBudget?: BudgetBreakdown;
}

/** Raw budget document fields the breakdown reads (budgets/{id}). */
export interface SummaryBudget {
  id: string;
  name?: unknown;
  kind?: unknown;
  archived?: unknown;
  linkedAccountIds?: unknown;
}

/**
 * Extra reads byBudget needs beyond the period's rows: all-time rows of active event budgets (their
 * figures are all-time), assigned income of archived event budgets (it still makes them self-funded,
 * so their spending leaves the month's, like the client and the alert trigger), and the workspace's
 * transfers only when an active event budget links accounts.
 */
export function budgetBreakdownQueries(budgets: SummaryBudget[]): { eventIds: string[]; archivedEventIds: string[]; transfers: boolean } {
  const events = budgets.filter(budget => budget.kind === "event");
  const active = events.filter(budget => budget.archived === false);
  return {
    eventIds: active.map(budget => budget.id),
    archivedEventIds: events.filter(budget => budget.archived !== false).map(budget => budget.id),
    transfers: active.some(budget => Array.isArray(budget.linkedAccountIds) && budget.linkedAccountIds.length > 0)
  };
}

export interface BudgetBreakdownRow {
  id: string;
  name: string;
  kind: AlertScope["kind"];
  /**
   * Assigned income plus transfers into its linked accounts minus out (negative when more left than
   * came in); null without any funding inflow in the period, or when a manual rate is missing.
   */
  funds: number | null;
  spent: number | null;
  available: number | null;
}

export interface BudgetBreakdown {
  /** Income of the period's months not assigned to an additional budget. */
  monthlyIncome: number | null;
  /** Spending of the period's months without budgets paid by their own funds. */
  monthlyExpense: number | null;
  /** Active additional budgets with funds or spending (event budgets: all time; monthly: the period). */
  budgets: BudgetBreakdownRow[];
  /** Some figure is null because a manual exchange rate is missing. */
  incomplete: boolean;
  notes: string[];
}

export interface SummaryOptions {
  period: ResolvedPeriod;
  now: Date;
  timeZone: string;
  primaryCurrency: string;
  exchangeRates: Record<string, number>;
  names: NameMaps;
  groupBy?: SummaryGroupBy;
  type?: SummaryType;
  accountId?: string;
  categoryId?: string;
  compareWithPrevious?: boolean;
  topN?: number;
  /** Billing days by account id; expenses on these cards count in their payment months. */
  cardBilling?: ReadonlyMap<string, CardBilling>;
  /**
   * Adds `byBudget`: the workspace's budgets (archived included, for self-funding kinds) and
   * extra rows outside the period that event budgets need (their all-time income, expenses and
   * transfers). Extra rows never feed the existing totals.
   */
  budgetBreakdown?: { budgets: SummaryBudget[]; extraRows?: SummaryTransaction[] };
}

const categoryName = (id: string | null | undefined, names: NameMaps) =>
  id ? names.categories.get(id) ?? "Categoría desconocida" : "Sin categoría";

function groupKey(c: Contribution, groupBy: SummaryGroupBy, names: NameMaps, timeZone: string): [string, string] {
  if (groupBy === "category") return [c.tx.categoryId || "sin-categoria", categoryName(c.tx.categoryId, names)];
  if (groupBy === "account") return [c.tx.accountId || "sin-cuenta", names.accounts.get(c.tx.accountId ?? "") ?? "Cuenta desconocida"];
  const day = zonedDateKey(c.instant, timeZone);
  if (groupBy === "day") return [day, day];
  const { year, month } = keyParts(day);
  return [day.slice(0, 7), monthLabel(year, month)];
}

const percentChange = (current: number, previous: number) =>
  previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / Math.abs(previous)) * 100);

interface Aggregate {
  totals: SummaryTotals;
  groups: SummaryGroup[];
  top: TopExpense[];
  missingRates: Set<string>;
  /** Some expense in the period was imputed to a card statement payment month. */
  billed: boolean;
}

function aggregate(rows: SummaryTransaction[], period: ResolvedPeriod, options: SummaryOptions): Aggregate {
  const { now, timeZone, primaryCurrency, exchangeRates, names } = options;
  const groupBy = options.groupBy ?? "none";
  const type = options.type ?? "all";
  const missingRates = new Set<string>();
  let income = 0;
  let expenses = 0;
  let upcoming = 0;
  let billed = false;
  const groups = new Map<string, SummaryGroup & { ids: Set<string> }>();
  const perTx = new Map<string, { value: number; original: number; indexes: number[]; c: Contribution }>();

  for (const tx of rows) {
    if (options.accountId && tx.accountId !== options.accountId) continue;
    if (options.categoryId && tx.categoryId !== options.categoryId) continue;
    for (const c of contributions(tx, timeZone, options.cardBilling?.get(tx.accountId ?? ""))) {
      if (type !== "all" && c.kind !== type) continue;
      if (c.instant < period.startInstant || c.instant >= period.endExclusive) continue;
      const { value, missingRate } = convertToPrimary(c.amount, tx.currency, primaryCurrency, exchangeRates);
      if (missingRate && tx.currency) missingRates.add(tx.currency);
      if (c.kind === "income") income += value;
      else {
        expenses += value;
        if (c.scheduled && c.instant > now) upcoming += value;
        if (c.billed) billed = true;
        const entry = perTx.get(tx.id) ?? { value: 0, original: 0, indexes: [], c };
        entry.value += value;
        entry.original += c.amount;
        entry.indexes.push(c.installmentIndex);
        perTx.set(tx.id, entry);
      }
      if (groupBy !== "none") {
        const [key, name] = groupKey(c, groupBy, names, timeZone);
        const group = groups.get(key) ?? { key, name, income: 0, expenses: 0, net: 0, count: 0, ids: new Set<string>() };
        if (c.kind === "income") group.income += value;
        else group.expenses += value;
        group.ids.add(tx.id);
        groups.set(key, group);
      }
    }
  }

  const chronological = groupBy === "month" || groupBy === "day";
  const groupList = [...groups.values()]
    .map(({ ids, ...g }) => ({ ...g, income: round2(g.income), expenses: round2(g.expenses), net: round2(g.income - g.expenses), count: ids.size }))
    .sort((a, b) => chronological ? a.key.localeCompare(b.key) : b.expenses - a.expenses || b.income - a.income);

  const top = [...perTx.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, options.topN ?? 5)
    .map(([id, { value, original, indexes, c }]) => {
      const row: TopExpense = {
        id,
        date: zonedDateKey(c.tx.date, timeZone),
        description: String(c.tx.description ?? ""),
        amount: round2(value),
        originalAmount: round2(original),
        originalCurrency: c.tx.currency || primaryCurrency,
        categoryName: categoryName(c.tx.categoryId, names),
        accountName: names.accounts.get(c.tx.accountId ?? "") ?? "Cuenta desconocida"
      };
      if (c.installments > 1) {
        const total = `${Math.abs(Number(c.tx.amount) || 0)} ${row.originalCurrency}`;
        const first = Math.min(...indexes) + 1;
        const last = Math.max(...indexes) + 1;
        const which = first === last ? `cuota ${first}` : `cuotas ${first} a ${last}`;
        row.installmentsInfo = `${which} de ${c.installments} (compra total ${total})`;
      }
      return row;
    });

  return {
    totals: {
      income: round2(income),
      expenses: round2(expenses),
      net: round2(income - expenses),
      // Dashboard.vue L544-548: 0 without income, never negative.
      savingsRate: income === 0 ? 0 : Math.round(Math.max(0, ((income - expenses) / income) * 100) * 10) / 10,
      upcomingInstallments: round2(upcoming)
    },
    groups: groupList,
    top,
    missingRates,
    billed
  };
}

/** Period totals, groups, top expenses and optional comparison, with dashboard semantics. */
export function summarize(rows: SummaryTransaction[], options: SummaryOptions): FinancialSummary {
  const { period, timeZone } = options;
  const current = aggregate(rows, period, options);
  const notes = ["Excluye transferencias, préstamos (loan) y pagos de préstamos recibidos (loan_payment): no son gasto ni ingreso."];
  const summary: FinancialSummary = {
    period: { start: period.start, end: period.end, label: period.label },
    currency: options.primaryCurrency,
    totals: current.totals,
    groups: current.groups,
    topExpenses: current.top,
    notes
  };

  if (period.kind === "months" && period.months) {
    const months = period.months;
    summary.averages = {
      months,
      incomePerMonth: round2(current.totals.income / months),
      expensesPerMonth: round2(current.totals.expenses / months)
    };
    summary.groups = summary.groups.map(g => ({ ...g, monthlyAverageExpenses: round2(g.expenses / months) }));
    notes.push(`Promedios mensuales sobre ${months} meses completos; el mes en curso no se incluye.`);
  }

  const missing = new Set(current.missingRates);
  if (options.compareWithPrevious) {
    const previous = previousPeriod(period, timeZone);
    const before = aggregate(rows, previous, { ...options, groupBy: "none", topN: 0 });
    before.missingRates.forEach(code => missing.add(code));
    summary.comparison = {
      period: { start: previous.start, end: previous.end, label: previous.label },
      totals: before.totals,
      deltas: {
        income: { diff: round2(current.totals.income - before.totals.income), percent: percentChange(current.totals.income, before.totals.income) },
        expenses: { diff: round2(current.totals.expenses - before.totals.expenses), percent: percentChange(current.totals.expenses, before.totals.expenses) },
        net: { diff: round2(current.totals.net - before.totals.net), percent: percentChange(current.totals.net, before.totals.net) }
      }
    };
  }

  if (current.billed) {
    notes.push("Las compras con tarjeta de crédito que tiene día de corte y de pago cuentan en el mes en que se paga su extracto (cada cuota un mes después), no en la fecha de compra.");
  }
  if (current.totals.upcomingInstallments > 0) {
    notes.push(`Las compras a cuotas cuentan solo la cuota de cada mes; incluye ${current.totals.upcomingInstallments} ${options.primaryCurrency} en cuotas o pagos de tarjeta que vencen después de hoy dentro del periodo.`);
  }
  missing.forEach(code => {
    notes.push(`Tasa de cambio faltante para ${code}: se usó 1:1. Configúrala en Objetivos & Presupuesto para totales exactos.`);
  });
  const byBudget = options.budgetBreakdown && !options.accountId && !options.categoryId
    ? budgetBreakdown(rows, options, options.budgetBreakdown)
    : null;
  if (byBudget) summary.byBudget = byBudget;
  return summary;
}

/** Calendar months a period covers exactly (first to last day), or null for partial months. */
function wholeMonths(period: ResolvedPeriod): YearMonth[] | null {
  const start = keyParts(period.start);
  const end = keyParts(period.end);
  if (start.day !== 1 || end.day !== daysInMonth(end.year, end.month)) return null;
  const months: YearMonth[] = [];
  for (let index = start.year * 12 + start.month; index <= end.year * 12 + end.month; index++) {
    months.push({ year: Math.floor(index / 12), month: index % 12 });
  }
  return months;
}

/** Sum of per-month figures; null as soon as one is unknown (missing manual rate). */
function sumKnown(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return round2(total);
}

/**
 * Per-budget view with the server budget semantics (budgetAlerts.ts, same as the app's Budgets
 * screen): month income without income assigned to other budgets, month spending without budgets
 * self-funded in that month, and each active additional budget's funds, spending and available.
 * Conversion uses manual rates only, so a missing rate makes a figure null (never 1:1).
 */
function budgetBreakdown(
  rows: SummaryTransaction[],
  options: SummaryOptions,
  input: NonNullable<SummaryOptions["budgetBreakdown"]>
): BudgetBreakdown | null {
  const months = wholeMonths(options.period);
  if (!months) return null;
  const { primaryCurrency, timeZone } = options;
  // Blank currency means the primary one, like convertToPrimary.
  const all = new Map<string, Record<string, any>>();
  for (const row of [...rows, ...(input.extraRows ?? [])]) {
    all.set(row.id, { ...row, currency: row.currency || primaryCurrency });
  }
  const movements = [...all.values()];
  const funding = movements.filter(tx => tx.type === "income" || tx.type === "transfer");
  const spendOptions: SpendOptions = {
    timeZone,
    reportingCurrency: primaryCurrency,
    exchangeRates: options.exchangeRates,
    billingFor: accountId => (accountId ? options.cardBilling?.get(accountId) ?? null : null)
  };

  const kindOf = (budgetId: string) => {
    const kind = input.budgets.find(budget => budget.id === budgetId)?.kind;
    return kind === "monthly" || kind === "event" ? kind : undefined;
  };
  const active = input.budgets.filter((budget): budget is SummaryBudget & { kind: AlertScope["kind"] } =>
    budget.archived === false && (budget.kind === "monthly" || budget.kind === "event"));
  const links = new Map<string, string>();
  for (const budget of active) {
    if (!Array.isArray(budget.linkedAccountIds)) continue;
    for (const accountId of budget.linkedAccountIds) {
      if (typeof accountId === "string" && !links.has(accountId)) links.set(accountId, budget.id);
    }
  }
  const linkedBudgetOf: LinkedBudgetLookup = accountId => links.get(accountId) ?? null;

  const monthlyIncome = sumKnown(months.map(month => monthlyIncomeTotal(movements, month, spendOptions)));
  const monthlyExpense = sumKnown(months.map(month => monthlyExpenseTotal(movements, month, spendOptions,
    selfFundedBudgetIds(funding, month, { timeZone }, kindOf, linkedBudgetOf))));

  const budgets: BudgetBreakdownRow[] = [];
  let fundsRateMissing = false;
  for (const budget of active) {
    const scope: AlertScope = { id: budget.id, kind: budget.kind };
    // Event figures ignore the month, so one evaluation is the all-time figure.
    const evaluated = scope.kind === "event" ? months.slice(0, 1) : months;
    // Without a funding inflow in the period the budget has no funds (null), even if money went
    // out, like the client's budget cards; with one, outflows above it give negative funds.
    const fundingByMonth = evaluated.map(month => scopeFunding(funding, scope, month, spendOptions, linkedBudgetOf));
    const funded = fundingByMonth.some(entry => entry.inflows > 0);
    const funds = funded ? sumKnown(fundingByMonth.map(entry => entry.total)) : null;
    if (funded && funds === null) fundsRateMissing = true;
    const spent = sumKnown(evaluated.map(month => scopeTotalSpend(movements, scope, month, spendOptions)));
    if (!funded && spent === 0) continue;
    budgets.push({
      id: budget.id,
      name: typeof budget.name === "string" && budget.name.trim() ? budget.name.trim() : budget.id,
      kind: scope.kind,
      funds,
      spent,
      available: funds === null || spent === null ? null : round2(funds - spent)
    });
  }

  const incomplete = monthlyIncome === null || monthlyExpense === null || fundsRateMissing ||
    budgets.some(budget => budget.spent === null);
  const notes = [
    "byBudget: ingresos del periodo sin los asignados a un presupuesto (son fondos de ese presupuesto) y gastos sin los de presupuestos que se financian con sus propios fondos; los presupuestos de evento suman todo su histórico y los mensuales solo el periodo."
  ];
  if (incomplete) {
    const missing = new Set<string>();
    for (const tx of movements) {
      const rate = Number(options.exchangeRates[tx.currency]);
      if (tx.currency !== primaryCurrency && !(Number.isFinite(rate) && rate > 0)) missing.add(String(tx.currency));
    }
    notes.push(`Desglose por presupuesto incompleto: falta la tasa de cambio manual de ${[...missing].join(", ") || "alguna moneda"}; las cifras en null no se pueden calcular sin ella.`);
  }
  return { monthlyIncome, monthlyExpense, budgets, incomplete, notes };
}

/** Category averages over the last `months` complete months (M4: the partial current month is excluded). */
export function monthlyAverages(
  rows: SummaryTransaction[],
  options: Omit<SummaryOptions, "period" | "groupBy"> & { months: number }
): FinancialSummary {
  const period = resolvePeriod({ lastCompleteMonths: options.months }, options.now, options.timeZone);
  return summarize(rows, { ...options, period, groupBy: "category" });
}

// --- Budgets -------------------------------------------------------------------

export interface BudgetStatus {
  categories: { categoryId: string; categoryName: string; limit: number; spent: number; remaining: number; percentUsed: number; exceeded: boolean }[];
  totals: { budget: number; spent: number; percentUsed: number };
  expenseLimit: { limit: number; spent: number; remaining: number; percentUsed: number; exceeded: boolean } | null;
}

/**
 * Budget vs actual for a month summary grouped by category. Port of the
 * Dashboard budgetSummary (Dashboard.vue L556-584): per-row percent is
 * spent/limit; the global percent caps each category at its limit.
 */
export function buildBudgetStatus({ categoryBudgets, expenseLimit, summary, names }: {
  categoryBudgets: Record<string, number>;
  expenseLimit: number | null | undefined;
  summary: FinancialSummary;
  names: NameMaps;
}): BudgetStatus {
  const spentBy = new Map(summary.groups.map(g => [g.key, g.expenses]));
  let budget = 0;
  let spentTotal = 0;
  let capped = 0;
  const categories = Object.entries(categoryBudgets)
    .map(([categoryId, rawLimit]) => {
      const limit = Number(rawLimit) || 0;
      const spent = spentBy.get(categoryId) ?? 0;
      budget += limit;
      spentTotal += spent;
      capped += Math.min(spent, limit);
      return {
        categoryId,
        categoryName: names.categories.get(categoryId) ?? "Categoría desconocida",
        limit,
        spent,
        remaining: round2(limit - spent),
        percentUsed: limit > 0 ? Math.round((spent / limit) * 100) : 0,
        exceeded: spent > limit
      };
    })
    .sort((a, b) => b.percentUsed - a.percentUsed);

  const limit = Number(expenseLimit) || 0;
  const monthSpent = summary.totals.expenses;
  return {
    categories,
    totals: { budget: round2(budget), spent: round2(spentTotal), percentUsed: budget > 0 ? Math.round((capped / budget) * 100) : 0 },
    expenseLimit: limit > 0
      ? { limit, spent: monthSpent, remaining: round2(limit - monthSpent), percentUsed: Math.round((monthSpent / limit) * 100), exceeded: monthSpent > limit }
      : null
  };
}

// --- Net worth -----------------------------------------------------------------

export interface NetWorthAccount {
  id: string;
  name?: string | null;
  type?: string | null;
  balance: number;
  currency?: string | null;
  [key: string]: unknown;
}

export interface NetWorth {
  accounts: (NetWorthAccount & { balanceInPrimary: number })[];
  totals: {
    currency: string;
    netWorth: number;
    byCurrency: { currency: string; balance: number; rate: number | null; inPrimary: number }[];
  };
  notes: string[];
}

/**
 * Net worth exactly like the dashboard KPI: every account balance (pockets,
 * credit cards with negative debt, bridge accounts with negative "owed") is
 * summed per currency (missing currency → 'USD', accountsStore.ts
 * netWorthByCurrency L35-43) and each currency total is converted with
 * convertToPrimary (Dashboard.vue netWorthValue L448-451).
 */
export function computeNetWorth(
  accounts: NetWorthAccount[],
  primaryCurrency: string,
  rates: Record<string, number>
): NetWorth {
  const byCurrency = new Map<string, number>();
  const missing = new Set<string>();
  const rows = accounts.map(account => {
    const balance = Number(account.balance) || 0;
    const currency = account.currency || "USD";
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + balance);
    const { value } = convertToPrimary(balance, currency, primaryCurrency, rates);
    return { ...account, balance, balanceInPrimary: round2(value) };
  });
  let netWorth = 0;
  const currencies = [...byCurrency.entries()].map(([currency, balance]) => {
    const { value, missingRate } = convertToPrimary(balance, currency, primaryCurrency, rates);
    if (missingRate) missing.add(currency);
    netWorth += value;
    return {
      currency,
      balance: round2(balance),
      rate: currency === primaryCurrency ? 1 : missingRate ? null : Number(rates[currency]),
      inPrimary: round2(value)
    };
  });
  const notes = ["Patrimonio neto = suma de los saldos de todas las cuentas (bolsillos incluidos; deudas de tarjetas y cuentas puente restan), igual que el panel de control."];
  missing.forEach(code => {
    notes.push(`Tasa de cambio faltante para ${code}: se usó 1:1. Configúrala en Objetivos & Presupuesto para totales exactos.`);
  });
  return { accounts: rows, totals: { currency: primaryCurrency, netWorth: round2(netWorth), byCurrency: currencies }, notes };
}
