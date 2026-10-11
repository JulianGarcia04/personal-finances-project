import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetStatus,
  convertToPrimary,
  monthlyAverages,
  resolvePeriod,
  summarize,
  SummaryTransaction
} from "./agentQueries";
import { AgentToolError, NameMaps } from "./agentTools";

const TZ = "America/Bogota";
// Sunday 2026-10-11 15:00 in Bogotá.
const NOW = new Date("2026-10-11T15:00:00-05:00");
const RATES = { USD: 4000 };
const NAMES: NameMaps = {
  accounts: new Map([["bank", "Banco"], ["usd", "Cuenta USD"], ["card", "Visa"], ["bridge", "Puente"], ["eur", "Cuenta EUR"]]),
  categories: new Map([["food", "Comida"], ["tech", "Tecnología"], ["fun", "Ocio"], ["salary", "Salario"]])
};

const tx = (id: string, type: string, amount: number, iso: string, extra: Partial<SummaryTransaction> = {}): SummaryTransaction => ({
  id, type, amount, date: new Date(iso), currency: "COP", accountId: "bank", categoryId: "", description: id, ...extra
});

const ROWS: SummaryTransaction[] = [
  // Local midnight on Oct 1 → October.
  tx("salaryOct", "income", 5_000_000, "2026-10-01T05:00:00Z", { categoryId: "salary" }),
  tx("salarySep", "income", 4_000_000, "2026-09-01T17:00:00Z", { categoryId: "salary" }),
  tx("market", "expense", -120_000, "2026-10-05T17:00:00Z", { categoryId: "food" }),
  tx("usdDinner", "expense", -50, "2026-10-10T17:00:00Z", { categoryId: "food", currency: "USD", accountId: "usd" }),
  tx("eurGame", "expense", -20, "2026-10-11T17:00:00Z", { categoryId: "fun", currency: "EUR", accountId: "eur" }),
  // 3 installments: Sep 15, Oct 15, Nov 15 (100k each).
  tx("laptop", "expense", -300_000, "2026-09-15T17:00:00Z", { categoryId: "tech", accountId: "card", installments: 3 }),
  // UTC midnight on Oct 1 = Sep 30 19:00 in Bogotá → September.
  tx("utcMidnight", "expense", -40_000, "2026-10-01T00:00:00Z", { categoryId: "food" }),
  // Sunday Oct 4 23:30 local → last week, but October.
  tx("sundayNight", "expense", -10_000, "2026-10-05T04:30:00Z", { categoryId: "food" }),
  tx("transfer", "transfer", 1_000_000, "2026-10-03T17:00:00Z", { toAccountId: "usd" }),
  tx("loan", "loan", -500_000, "2026-10-04T17:00:00Z"),
  tx("loanBack", "loan_payment", 200_000, "2026-10-06T17:00:00Z"),
  // Bridge expense: local leg is a normal expense, the mirror leg is a transfer.
  tx("bridgeLeg", "expense", -60_000, "2026-10-08T17:00:00Z", { categoryId: "food", accountId: "bridge", mirrorOf: "mirrorLeg" }),
  tx("mirrorLeg", "transfer", 60_000, "2026-10-08T17:00:00Z", { mirrorOf: "bridgeLeg", toAccountId: "card" }),
  tx("lastYear", "expense", -70_000, "2025-12-20T17:00:00Z", { categoryId: "food" })
];

const run = (input: Parameters<typeof resolvePeriod>[0], extra: Partial<Parameters<typeof summarize>[1]> = {}) =>
  summarize(ROWS, {
    period: resolvePeriod(input, NOW, TZ),
    now: NOW,
    timeZone: TZ,
    primaryCurrency: "COP",
    exchangeRates: RATES,
    names: NAMES,
    ...extra
  });

test("convertToPrimary mirrors the frontend: primary/blank as-is, rate multiplies, missing or zero rate is 1:1", () => {
  assert.deepEqual(convertToPrimary(10, "COP", "COP", RATES), { value: 10, missingRate: false });
  assert.deepEqual(convertToPrimary(10, "", "COP", RATES), { value: 10, missingRate: false });
  assert.deepEqual(convertToPrimary(10, "USD", "COP", RATES), { value: 40_000, missingRate: false });
  assert.deepEqual(convertToPrimary(10, "EUR", "COP", RATES), { value: 10, missingRate: true });
  assert.deepEqual(convertToPrimary(10, "EUR", "COP", { EUR: 0 }), { value: 10, missingRate: true });
});

test("resolvePeriod resolves presets in local time with Monday-Sunday weeks", () => {
  const keys = (input: Parameters<typeof resolvePeriod>[0]) => {
    const p = resolvePeriod(input, NOW, TZ);
    return [p.start, p.end];
  };
  assert.deepEqual(keys({ preset: "today" }), ["2026-10-11", "2026-10-11"]);
  assert.deepEqual(keys({ preset: "yesterday" }), ["2026-10-10", "2026-10-10"]);
  assert.deepEqual(keys({ preset: "this_week" }), ["2026-10-05", "2026-10-11"]);
  assert.deepEqual(keys({ preset: "last_week" }), ["2026-09-28", "2026-10-04"]);
  assert.deepEqual(keys({ preset: "this_month" }), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(keys({ preset: "last_month" }), ["2026-09-01", "2026-09-30"]);
  assert.deepEqual(keys({ preset: "this_year" }), ["2026-01-01", "2026-12-31"]);
  assert.deepEqual(keys({ preset: "last_year" }), ["2025-01-01", "2025-12-31"]);
  assert.deepEqual(keys({}), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(keys({ lastCompleteMonths: 3 }), ["2026-07-01", "2026-09-30"]);
  const month = resolvePeriod({ preset: "this_month" }, NOW, TZ);
  assert.equal(month.label, "octubre de 2026");
  assert.equal(month.startInstant.toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(month.endExclusive.toISOString(), "2026-11-01T05:00:00.000Z");
});

test("resolvePeriod rejects ambiguous or invalid ranges", () => {
  assert.throws(() => resolvePeriod({ preset: "today", startDate: "2026-10-01" }, NOW, TZ), AgentToolError);
  assert.throws(() => resolvePeriod({ startDate: "2026-10-05", endDate: "2026-10-01" }, NOW, TZ), AgentToolError);
  assert.throws(() => resolvePeriod({ endDate: "2026-10-01" }, NOW, TZ), AgentToolError);
  assert.throws(() => resolvePeriod({ startDate: "ayer" }, NOW, TZ), AgentToolError);
});

test("this_month matches the dashboard: installment share, currency conversion, transfers/loans/mirror legs excluded", () => {
  const s = run({ preset: "this_month" });
  assert.deepEqual(s.period, { start: "2026-10-01", end: "2026-10-31", label: "octubre de 2026" });
  assert.equal(s.currency, "COP");
  // 120k + 50 USD (200k) + 20 EUR (1:1) + laptop 100k + bridge 60k + sunday 10k
  assert.deepEqual(s.totals, { income: 5_000_000, expenses: 490_020, net: 4_509_980, savingsRate: 90.2, upcomingInstallments: 100_000 });
  assert.ok(s.notes.some(note => note.includes("EUR") && note.includes("1:1")));
  assert.ok(s.notes.some(note => note.includes("transferencias")));
  assert.equal(s.comparison, undefined);
});

test("transaction stored at UTC midnight on the 1st belongs to the previous local month", () => {
  const s = run({ preset: "last_month" });
  assert.deepEqual(s.totals, { income: 4_000_000, expenses: 140_000, net: 3_860_000, savingsRate: 96.5, upcomingInstallments: 0 });
  const day = run({ startDate: "2026-10-01", endDate: "2026-10-01" });
  assert.equal(day.totals.income, 5_000_000);
  assert.equal(day.totals.expenses, 0);
});

test("week boundaries are Monday 00:00 local", () => {
  const thisWeek = run({ preset: "this_week" });
  assert.equal(thisWeek.totals.expenses, 380_020);
  assert.equal(thisWeek.totals.income, 0);
  assert.equal(thisWeek.totals.savingsRate, 0);
  const lastWeek = run({ preset: "last_week" });
  assert.equal(lastWeek.totals.expenses, 50_000);
  assert.equal(lastWeek.totals.income, 5_000_000);
  assert.equal(run({ preset: "today" }).totals.expenses, 20);
  assert.equal(run({ preset: "yesterday" }).totals.expenses, 200_000);
});

test("groupBy category sorts by expenses and counts transactions", () => {
  const s = run({ preset: "this_month" }, { groupBy: "category" });
  assert.deepEqual(s.groups.map(g => [g.key, g.name, g.expenses, g.income, g.count]), [
    ["food", "Comida", 390_000, 0, 4],
    ["tech", "Tecnología", 100_000, 0, 1],
    ["fun", "Ocio", 20, 0, 1],
    ["salary", "Salario", 0, 5_000_000, 1]
  ]);
  assert.equal(s.groups[0].net, -390_000);
});

test("groupBy month spreads installments across this_year, chronologically", () => {
  const s = run({ preset: "this_year" }, { groupBy: "month" });
  assert.deepEqual(s.totals, { income: 9_000_000, expenses: 730_020, net: 8_269_980, savingsRate: 91.9, upcomingInstallments: 200_000 });
  assert.deepEqual(s.groups.map(g => [g.key, g.expenses, g.income]), [
    ["2026-09", 140_000, 4_000_000],
    ["2026-10", 490_020, 5_000_000],
    ["2026-11", 100_000, 0]
  ]);
  assert.equal(s.groups[1].name, "octubre de 2026");
});

test("filters by account, category and type", () => {
  assert.equal(run({ preset: "this_month" }, { accountId: "card" }).totals.expenses, 100_000);
  assert.equal(run({ preset: "this_month" }, { categoryId: "food" }).totals.expenses, 390_000);
  const onlyExpenses = run({ preset: "this_month" }, { type: "expense" });
  assert.equal(onlyExpenses.totals.income, 0);
  assert.equal(onlyExpenses.totals.expenses, 490_020);
  assert.equal(run({ preset: "this_month" }, { type: "income" }).totals.expenses, 0);
});

test("topExpenses lists the largest converted expense shares", () => {
  const s = run({ preset: "this_month" }, { topN: 2 });
  assert.equal(s.topExpenses.length, 2);
  assert.deepEqual(s.topExpenses[0], {
    id: "usdDinner", date: "2026-10-10", description: "usdDinner", amount: 200_000,
    originalAmount: 50, originalCurrency: "USD", categoryName: "Comida", accountName: "Cuenta USD"
  });
  assert.equal(s.topExpenses[1].id, "market");
  const withInstallment = run({ preset: "this_month" }, { accountId: "card" });
  assert.equal(withInstallment.topExpenses[0].installmentsInfo, "cuota 2 de 3 (compra total 300000 COP)");
});

test("comparison uses the previous calendar month and the dashboard percent formula", () => {
  const s = run({ preset: "this_month" }, { compareWithPrevious: true });
  assert.deepEqual(s.comparison, {
    period: { start: "2026-09-01", end: "2026-09-30", label: "septiembre de 2026" },
    totals: { income: 4_000_000, expenses: 140_000, net: 3_860_000, savingsRate: 96.5, upcomingInstallments: 0 },
    deltas: {
      income: { diff: 1_000_000, percent: 25 },
      expenses: { diff: 350_020, percent: 250 },
      net: { diff: 649_980, percent: 17 }
    }
  });
  const year = run({ preset: "this_year" }, { compareWithPrevious: true });
  assert.equal(year.comparison?.period.start, "2025-01-01");
  assert.equal(year.comparison?.totals.expenses, 70_000);
  const week = run({ preset: "this_week" }, { compareWithPrevious: true });
  assert.equal(week.comparison?.period.start, "2026-09-28");
  assert.deepEqual(week.comparison?.deltas.income, { diff: -5_000_000, percent: -100 });
  const custom = run({ startDate: "2026-10-01", endDate: "2026-10-03" }, { compareWithPrevious: true });
  assert.deepEqual([custom.comparison?.period.start, custom.comparison?.period.end], ["2026-09-28", "2026-09-30"]);
});

test("monthlyAverages divides by complete months only (M4)", () => {
  const avg = monthlyAverages(ROWS, { months: 3, now: NOW, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES });
  assert.deepEqual(avg.period, { start: "2026-07-01", end: "2026-09-30", label: "julio de 2026 a septiembre de 2026 (3 meses completos)" });
  assert.equal(avg.averages?.months, 3);
  assert.equal(avg.averages?.expensesPerMonth, 46_666.67);
  assert.equal(avg.averages?.incomePerMonth, 1_333_333.33);
  const tech = avg.groups.find(g => g.key === "tech");
  assert.equal(tech?.monthlyAverageExpenses, 33_333.33);
  // The current partial month never enters the average.
  assert.equal(avg.groups.find(g => g.key === "fun"), undefined);
});

test("buildBudgetStatus compares category budgets and the expense limit with the month's spend", () => {
  const month = run({ preset: "this_month" }, { groupBy: "category" });
  const status = buildBudgetStatus({
    categoryBudgets: { food: 300_000, tech: 150_000, ghost: 50_000 },
    expenseLimit: 400_000,
    summary: month,
    names: NAMES
  });
  assert.deepEqual(status.categories, [
    { categoryId: "food", categoryName: "Comida", limit: 300_000, spent: 390_000, remaining: -90_000, percentUsed: 130, exceeded: true },
    { categoryId: "tech", categoryName: "Tecnología", limit: 150_000, spent: 100_000, remaining: 50_000, percentUsed: 67, exceeded: false },
    { categoryId: "ghost", categoryName: "Categoría desconocida", limit: 50_000, spent: 0, remaining: 50_000, percentUsed: 0, exceeded: false }
  ]);
  assert.deepEqual(status.totals, { budget: 500_000, spent: 490_000, percentUsed: 80 });
  assert.deepEqual(status.expenseLimit, { limit: 400_000, spent: 490_020, remaining: -90_020, percentUsed: 123, exceeded: true });
  assert.equal(buildBudgetStatus({ categoryBudgets: {}, expenseLimit: 0, summary: month, names: NAMES }).expenseLimit, null);
});
