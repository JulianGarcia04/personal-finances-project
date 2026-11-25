import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingLookbackStart,
  budgetBreakdownQueries,
  buildBudgetStatus,
  cardBillingByAccount,
  computeNetWorth,
  convertToPrimary,
  getSavingsGoalProgressAmount,
  isSavingsGoalAccountLinkable,
  monthlyAverages,
  resolvePeriod,
  summarize,
  SummaryTransaction,
  type SavingsGoalAccountSnapshot
} from "./agentQueries";
import { AgentToolError, NameMaps } from "./agentTools";
import { buildAgentTools } from "./agentContext";
import { expenseAmountForMonth } from "./http";

const TZ = "America/Bogota";
// Sunday 2026-10-11 15:00 in Bogotá.
const NOW = new Date("2026-10-11T15:00:00-05:00");
const RATES = { USD: 4000 };
const NAMES: NameMaps = {
  accounts: new Map([["bank", "Banco"], ["usd", "Cuenta USD"], ["card", "Visa"], ["bridge", "Puente"], ["eur", "Cuenta EUR"]]),
  categories: new Map([["food", "Comida"], ["tech", "Tecnología"], ["fun", "Ocio"], ["salary", "Salario"]])
};

test("agent goal progress keeps legacy goals virtual and reads a validated linked account's live balance", () => {
  const accounts = new Map([
    ["goal-account", { workspaceId: "workspace-a", type: "savings", balance: 84, currency: "COP" }],
    ["checking", { workspaceId: "workspace-a", type: "checking", balance: 100, currency: "COP" }],
    ["rounding", { workspaceId: "workspace-a", type: "checking", balance: 1.005, currency: "COP" }]
  ]);
  const legacyGoal = { currentAmount: 12, currency: "COP" };
  const linkedGoal = { currentAmount: 1, currency: "COP", linkedAccountId: "goal-account" };

  assert.equal(getSavingsGoalProgressAmount(legacyGoal, "workspace-a", accounts), 12);
  assert.equal(getSavingsGoalProgressAmount(linkedGoal, "workspace-a", accounts), 84);
  assert.equal(getSavingsGoalProgressAmount(linkedGoal, "workspace-b", accounts), null);
  assert.equal(getSavingsGoalProgressAmount({ linkedAccountId: "rounding", currency: "COP" }, "workspace-a", accounts), 1.01);
  assert.equal(getSavingsGoalProgressAmount({ currentAmount: 1.005 }, "workspace-a", accounts), 1.01);
});

test("agent goal links accept valid pockets and reject wrong-workspace, wrong-currency, credit, bridge, and malformed pockets", () => {
  const parent = { workspaceId: "workspace-a", type: "checking", currency: "COP", childAccountIds: ["pocket"] };
  const pocket = { workspaceId: "workspace-a", type: "savings", currency: "COP", parentAccountId: "parent", balance: 60 };
  const accounts = new Map<string, SavingsGoalAccountSnapshot>([["parent", parent], ["pocket", pocket]]);

  assert.equal(isSavingsGoalAccountLinkable("pocket", "COP", "workspace-a", accounts), true);
  assert.equal(isSavingsGoalAccountLinkable("pocket", "USD", "workspace-a", accounts), false);
  assert.equal(isSavingsGoalAccountLinkable("pocket", "COP", "workspace-b", accounts), false);
  assert.equal(isSavingsGoalAccountLinkable("pocket", "COP", "workspace-a", new Map<string, SavingsGoalAccountSnapshot>([
    ["pocket", { ...pocket, balance: Number.NaN }]
  ])), false);
  assert.equal(isSavingsGoalAccountLinkable("pocket", "COP", "workspace-a", new Map<string, SavingsGoalAccountSnapshot>([
    ["pocket", { ...pocket, balance: "60" }]
  ])), false);
  assert.equal(isSavingsGoalAccountLinkable("card", "COP", "workspace-a", new Map<string, SavingsGoalAccountSnapshot>([
    ["card", { workspaceId: "workspace-a", type: "credit", currency: "COP", balance: -60 }]
  ])), false);
  assert.equal(isSavingsGoalAccountLinkable("bridge", "COP", "workspace-a", new Map<string, SavingsGoalAccountSnapshot>([
    ["bridge", { workspaceId: "workspace-a", type: "checking", currency: "COP", mirror: { workspaceId: "workspace-b" } }]
  ])), false);
  assert.equal(isSavingsGoalAccountLinkable("pocket", "COP", "workspace-a", new Map<string, SavingsGoalAccountSnapshot>([
    ["pocket", { ...pocket, parentAccountId: "missing" }]
  ])), false);
});

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
  assert.deepEqual(status.totals, { budget: 500_000, spent: 490_000, percentUsed: 98 });
  assert.deepEqual(status.expenseLimit, { limit: 400_000, spent: 490_020, remaining: -90_020, percentUsed: 123, exceeded: true });
  assert.equal(buildBudgetStatus({ categoryBudgets: {}, expenseLimit: 0, summary: month, names: NAMES }).expenseLimit, null);
});

test("P1 S3: getWorkspaceSettings reports the base monthly cap separately from all-budget totals", async () => {
  const assigns = ["extra-monthly", "event", "archived-event"].map(budgetId =>
    tx(budgetId, "expense", -100_000, "2026-10-08T17:00:00Z", { categoryId: "food", budgetId })
  );
  const rows = ROWS.map(row => row.id === "market" ? { ...row, budgetId: "default-monthly" } : row);
  const workspace = { expenseLimit: 500_000, categoryBudgets: { food: 100 }, categoryBudgetCurrency: "USD", exchangeRates: RATES };
  const snapshots = (entries: [string, object][]) => entries.map(([id, data]) => ({ id, data: () => data }));
  const collections = {
    transactions: snapshots([...rows, ...assigns].map(row => [row.id, row])),
    categories: snapshots([...NAMES.categories].map(([id, name]) => [id, { name }])),
    // Balance as its movements leave it (300,000 charged, 60,000 received): cash flow reads it for the card ledger.
    accounts: snapshots([["card", { type: "credit", name: "Visa", statementClosingDay: 25, paymentDueDay: 5, balance: -240_000 }]])
  };
  // Stub the queries with local snapshots. Dates and duplicate rows are still handled by the real tool.
  const db = { collection(name: keyof typeof collections) {
    const query = {
      where: () => query,
      orderBy: () => query,
      get: async () => ({ docs: collections[name] ?? [] }),
      doc: () => ({ get: async () => ({ data: () => workspace }) })
    };
    return query;
  } } as unknown as Parameters<typeof buildAgentTools>[0];
  const tools = buildAgentTools(db, {
    workspaceId: "workspace-a", userId: "user-a", primaryCurrency: "COP", timeZone: TZ, now: () => NOW
  });
  const settings = await tools.find(tool => tool.name === "getWorkspaceSettings")!.run({});
  assert.ok(settings && typeof settings === "object" && "currentMonth" in settings);
  assert.deepEqual(settings.currentMonth, {
    period: { start: "2026-10-01", end: "2026-10-31", label: "octubre de 2026" },
    totals: { income: 5_000_000, expenses: 790_020, net: 4_209_980, savingsRate: 84.2, upcomingInstallments: 0 },
    expenseLimit: { limit: 500_000, spent: 490_020, remaining: 9_980, percentUsed: 98, exceeded: false },
    categoryBudgets: [
      { categoryId: "food", categoryName: "Comida", limit: 400_000, spent: 390_000, remaining: 10_000, percentUsed: 98, exceeded: false }
    ],
    categoryBudgetTotals: { budget: 400_000, spent: 390_000, percentUsed: 98 }
  });
});

test("buildBudgetStatus converts category caps with manual FX but leaves the base expense cap in the reporting currency", () => {
  const month = run({ preset: "this_month" }, { groupBy: "category" });
  const converted = buildBudgetStatus({
    categoryBudgets: { food: 100 },
    expenseLimit: 800_000,
    summary: month,
    capCurrency: "USD",
    primaryCurrency: "COP",
    exchangeRates: { USD: 4000 },
    names: NAMES
  });
  assert.equal(converted.categories[0].limit, 400_000);
  assert.equal(converted.categories[0].percentUsed, 98);
  assert.equal(converted.totals.budget, 400_000);
  assert.deepEqual(converted.expenseLimit, { limit: 800_000, spent: 490_020, remaining: 309_980, percentUsed: 61, exceeded: false });

  // Unconfirmed capCurrency (null) or missing rate disables comparison instead of comparing 1:1.
  const unconfirmed = buildBudgetStatus({
    categoryBudgets: { food: 100 },
    expenseLimit: null,
    summary: month,
    capCurrency: null,
    primaryCurrency: "COP",
    exchangeRates: { USD: 4000 },
    names: NAMES
  });
  assert.equal(unconfirmed.categories[0].percentUsed, null);
  assert.equal(unconfirmed.categories[0].remaining, null);
  assert.equal(unconfirmed.totals.percentUsed, null);

  const missingRate = buildBudgetStatus({
    categoryBudgets: { food: 100 },
    expenseLimit: null,
    summary: month,
    capCurrency: "EUR",
    primaryCurrency: "COP",
    exchangeRates: { USD: 4000 },
    names: NAMES
  });
  assert.equal(missingRate.categories[0].percentUsed, null);
  assert.equal(missingRate.totals.percentUsed, null);

  // Zero-valued legacy caps do not inflate totals.percentUsed or mark exceeded.
  const withZeroCap = buildBudgetStatus({
    categoryBudgets: { tech: 200_000, food: 0 },
    expenseLimit: null,
    summary: month,
    capCurrency: "COP",
    primaryCurrency: "COP",
    exchangeRates: {},
    names: NAMES
  });
  assert.equal(withZeroCap.totals.percentUsed, 50);
  assert.equal(withZeroCap.categories.find(c => c.categoryId === "food")?.exceeded, false);
});

test("computeNetWorth sums every account per currency and converts each currency total like the dashboard", () => {
  const worth = computeNetWorth([
    { id: "bank", name: "Banco", type: "checking", balance: 2_000_000, currency: "COP" },
    { id: "pocket", name: "Bolsillo", type: "savings", balance: 500_000, currency: "COP", pocketOf: "Banco" },
    { id: "card", name: "Visa", type: "credit", balance: -300_000, currency: "COP" },
    { id: "bridge", name: "Puente", type: "checking", balance: -60_000, currency: "COP", bridge: true },
    { id: "usd", name: "Cuenta USD", type: "savings", balance: 1_000.5, currency: "USD" },
    { id: "eur", name: "Euros", type: "cash", balance: 10, currency: "EUR" },
    // Missing currency counts as USD (accountsStore netWorthByCurrency).
    { id: "legacy", name: "Vieja", type: "cash", balance: 1, currency: null }
  ], "COP", RATES);
  assert.equal(worth.totals.netWorth, 2_140_000 + 1_001.5 * 4000 + 10);
  assert.deepEqual(worth.totals.byCurrency, [
    { currency: "COP", balance: 2_140_000, rate: 1, inPrimary: 2_140_000 },
    { currency: "USD", balance: 1_001.5, rate: 4000, inPrimary: 4_006_000 },
    { currency: "EUR", balance: 10, rate: null, inPrimary: 10 }
  ]);
  assert.equal(worth.accounts.find(a => a.id === "usd")?.balanceInPrimary, 4_002_000);
  assert.equal(worth.accounts.find(a => a.id === "card")?.balanceInPrimary, -300_000);
  assert.equal(worth.accounts.find(a => a.id === "pocket")?.pocketOf, "Banco");
  assert.ok(worth.notes.some(note => note.includes("EUR") && note.includes("1:1")));
  assert.ok(!worth.notes.some(note => note.includes("USD") && note.includes("1:1")));
});

// --- Credit-card payment months ---

const CARD_BILLING = cardBillingByAccount([
  { id: "visa", type: "credit", statementClosingDay: 25, paymentDueDay: 10 },
  { id: "fast", type: "credit", statementClosingDay: 5, paymentDueDay: 20 },
  { id: "bank", type: "checking" }
]);
const CARD_ROWS: SummaryTransaction[] = [
  // Closing 25, due 10: statement of 25 Oct, paid on 10 Nov, 10 Dec and 10 Jan.
  tx("tv", "expense", -300_000, "2026-09-28T17:00:00Z", { accountId: "visa", installments: 3, categoryId: "tech" }),
  tx("shoes", "expense", -90_000, "2026-09-28T17:00:00Z", { accountId: "visa", categoryId: "fun" }),
  // Closing 5, due 20: statement of 5 Oct, paid on 20 Oct, 20 Nov and 20 Dec.
  tx("phone", "expense", -300_000, "2026-09-28T17:00:00Z", { accountId: "fast", installments: 3, categoryId: "tech" }),
  // 3 Oct closes on 5 Oct and is due on 20 Oct, after NOW (11 Oct).
  tx("gift", "expense", -40_000, "2026-10-03T17:00:00Z", { accountId: "fast", categoryId: "fun" })
];
const runCards = (input: Parameters<typeof resolvePeriod>[0], extra: Partial<Parameters<typeof summarize>[1]> = {}) =>
  summarize(CARD_ROWS, {
    period: resolvePeriod(input, NOW, TZ),
    now: NOW,
    timeZone: TZ,
    primaryCurrency: "COP",
    exchangeRates: RATES,
    names: NAMES,
    cardBilling: CARD_BILLING,
    ...extra
  });

test("card shares fall on the payment due date of the statement that contains the purchase", () => {
  const s = runCards({ startDate: "2026-09-01", endDate: "2027-01-31" }, { groupBy: "day" });
  assert.deepEqual(s.groups.map(g => [g.key, g.expenses]), [
    ["2026-10-20", 140_000],
    ["2026-11-10", 190_000],
    ["2026-11-20", 100_000],
    ["2026-12-10", 100_000],
    ["2026-12-20", 100_000],
    ["2027-01-10", 100_000]
  ]);
  assert.equal(s.totals.expenses, 730_000);
});

test("this_month counts card statements due this month and flags the ones due after today", () => {
  const s = runCards({ preset: "this_month" });
  assert.equal(s.totals.expenses, 140_000);
  assert.equal(s.totals.upcomingInstallments, 140_000);
  const phone = s.topExpenses.find(row => row.id === "phone");
  assert.equal(phone?.installmentsInfo, "cuota 1 de 3 (compra total 300000 COP)");
  assert.equal(phone?.date, "2026-09-28");
});

test("last_month keeps September card purchases out until their statements are due", () => {
  assert.equal(runCards({ preset: "last_month" }).totals.expenses, 0);
  // Without billing days the same rows keep calendar-month imputation.
  assert.equal(runCards({ preset: "last_month" }, { cardBilling: undefined }).totals.expenses, 290_000);
});

test("card shares clamp a day-31 due date to the end of short months", () => {
  const rows = [tx("sofa", "expense", -200_000, "2026-01-20T17:00:00Z", { accountId: "late", installments: 2 })];
  const s = summarize(rows, {
    period: resolvePeriod({ startDate: "2026-01-01", endDate: "2026-03-31" }, NOW, TZ),
    now: NOW, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES, groupBy: "day",
    cardBilling: cardBillingByAccount([{ id: "late", type: "credit", statementClosingDay: 25, paymentDueDay: 31 }])
  });
  assert.deepEqual(s.groups.map(g => [g.key, g.expenses]), [["2026-01-31", 100_000], ["2026-02-28", 100_000]]);
});

test("cardBillingByAccount keeps only regular credit cards with both billing days", () => {
  const billing = cardBillingByAccount([
    { id: "visa", type: "credit", statementClosingDay: 25, paymentDueDay: 10 },
    { id: "noDue", type: "credit", statementClosingDay: 25, paymentDueDay: null },
    { id: "bridge", type: "credit", statementClosingDay: 25, paymentDueDay: 10, mirror: { workspaceId: "w" } },
    { id: "bank", type: "checking", statementClosingDay: 25, paymentDueDay: 10 }
  ]);
  assert.deepEqual([...billing.entries()], [["visa", { statementClosingDay: 25, paymentDueDay: 10 }]]);
});

test("billingLookbackStart reaches the local start of the month two months before the period", () => {
  assert.equal(billingLookbackStart(new Date("2026-10-01T05:00:00Z"), TZ).toISOString(), "2026-08-01T05:00:00.000Z");
  assert.equal(billingLookbackStart(new Date("2027-01-05T05:00:00Z"), TZ).toISOString(), "2026-11-01T05:00:00.000Z");
});

// --- Per-budget breakdown (S9) ---------------------------------------------------

const VENTAS = { id: "ventas", name: "Ventas Casa", kind: "event", archived: false, linkedAccountIds: ["ventasAcct"] };
const BUDGET_ROWS: SummaryTransaction[] = [
  tx("salary", "income", 5_000_000, "2026-10-01T17:00:00Z", { categoryId: "salary" }),
  tx("sale", "income", 1_000_000, "2026-10-02T17:00:00Z", { budgetId: "ventas" }),
  tx("paint", "expense", -300_000, "2026-10-03T17:00:00Z", { categoryId: "fun", budgetId: "ventas" }),
  tx("market2", "expense", -120_000, "2026-10-04T17:00:00Z", { categoryId: "food" })
];

const runBudgets = (rows: SummaryTransaction[], input: Parameters<typeof resolvePeriod>[0], extra: Partial<Parameters<typeof summarize>[1]> = {}) =>
  summarize(rows, {
    period: resolvePeriod(input, NOW, TZ),
    now: NOW,
    timeZone: TZ,
    primaryCurrency: "COP",
    exchangeRates: RATES,
    names: NAMES,
    ...extra
  });

test("byBudget separates income assigned to a budget and spending of a self-funded budget, totals unchanged", () => {
  const s = runBudgets(BUDGET_ROWS, { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.equal(s.totals.income, 6_000_000);
  assert.equal(s.totals.expenses, 420_000);
  assert.ok(s.byBudget);
  assert.equal(s.byBudget.monthlyIncome, 5_000_000);
  assert.equal(s.byBudget.monthlyExpense, 120_000);
  assert.equal(s.byBudget.incomplete, false);
  assert.deepEqual(s.byBudget.budgets, [
    { id: "ventas", name: "Ventas Casa", kind: "event", funds: 1_000_000, spent: 300_000, available: 700_000 }
  ]);
});

test("byBudget counts a transfer from an unlinked account into a linked account as funds", () => {
  const rows = [...BUDGET_ROWS, tx("topUp", "transfer", 200_000, "2026-10-05T17:00:00Z", { accountId: "bank", toAccountId: "ventasAcct" })];
  const s = runBudgets(rows, { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.deepEqual(s.byBudget?.budgets, [
    { id: "ventas", name: "Ventas Casa", kind: "event", funds: 1_200_000, spent: 300_000, available: 900_000 }
  ]);
  assert.equal(s.totals.income, 6_000_000);
});

test("byBudget never erases monthly expenses when a budget is funded only by transfers from unlinked accounts, and ignores credit cards in linkedAccountIds", () => {
  const cardBudget = { id: "cardB", name: "Tarjeta", kind: "monthly", archived: false, linkedAccountIds: ["visaCard"] };
  const rows = [
    tx("salary", "income", 5_000_000, "2026-10-01T17:00:00Z", { categoryId: "salary" }),
    tx("move", "transfer", 1_000_000, "2026-10-02T17:00:00Z", { accountId: "bank", toAccountId: "ventasAcct" }),
    tx("spend", "expense", -1_000_000, "2026-10-03T17:00:00Z", { categoryId: "fun", budgetId: "ventas" }),
    tx("repay", "transfer", 500_000, "2026-10-04T17:00:00Z", { accountId: "bank", toAccountId: "visaCard" }),
    tx("cardSpend", "expense", -500_000, "2026-10-05T17:00:00Z", { categoryId: "food", budgetId: "cardB" })
  ];
  const s = runBudgets(rows, { preset: "this_month" }, {
    budgetBreakdown: { budgets: [VENTAS, cardBudget], creditAccountIds: new Set(["visaCard"]) }
  });
  assert.equal(s.byBudget?.monthlyIncome, 5_000_000);
  assert.equal(s.byBudget?.monthlyExpense, 1_500_000);
  // Card repayment transfer must never show up as Fondos for cardBudget.
  assert.deepEqual(s.byBudget?.budgets.find(b => b.id === "cardB"), {
    id: "cardB", name: "Tarjeta", kind: "monthly", funds: null, spent: 500_000, available: null
  });
});

test("byBudget uses all-time rows of event budgets and lists only active budgets with movements", () => {
  // Income assigned last month still funds the event budget and makes it self-funded this month.
  const older = [tx("saleSep", "income", 1_000_000, "2026-09-02T17:00:00Z", { budgetId: "ventas" })];
  const rows = BUDGET_ROWS.filter(row => row.id !== "sale");
  const budgets = [
    VENTAS,
    { id: "trip", name: "Viaje", kind: "event", archived: false },
    { id: "old", name: "Viejo", kind: "monthly", archived: true }
  ];
  const s = runBudgets(rows, { preset: "this_month" }, { budgetBreakdown: { budgets, extraRows: older } });
  assert.equal(s.totals.income, 5_000_000);
  assert.equal(s.byBudget?.monthlyExpense, 120_000);
  assert.deepEqual(s.byBudget?.budgets.map(b => [b.id, b.funds, b.spent, b.available]), [["ventas", 1_000_000, 300_000, 700_000]]);
});

test("byBudget reports no funds for a budget that only had money transferred out, and real negative funds after an inflow", () => {
  const out = tx("out", "transfer", 200_000, "2026-10-05T17:00:00Z", { accountId: "ventasAcct", toAccountId: "bank" });
  const spend = tx("paint", "expense", -300_000, "2026-10-03T17:00:00Z", { categoryId: "fun", budgetId: "ventas" });
  const outOnly = runBudgets([out, spend], { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.deepEqual(outOnly.byBudget?.budgets, [
    { id: "ventas", name: "Ventas Casa", kind: "event", funds: null, spent: 300_000, available: null }
  ]);
  assert.equal(outOnly.byBudget?.incomplete, false);
  // No inflow and no spending: nothing to report, like the client's per-budget panel.
  assert.deepEqual(runBudgets([out], { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS] } }).byBudget?.budgets, []);
  const topUp = tx("in", "transfer", 100_000, "2026-10-02T17:00:00Z", { accountId: "bank", toAccountId: "ventasAcct" });
  const overdrawn = runBudgets([topUp, out, spend], { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.deepEqual(overdrawn.byBudget?.budgets, [
    { id: "ventas", name: "Ventas Casa", kind: "event", funds: -100_000, spent: 300_000, available: -400_000 }
  ]);
});

test("byBudget treats an archived event budget funded in an earlier month as self-funded, like the client", () => {
  const archived = { id: "trip", name: "Viaje", kind: "event", archived: true };
  const rows = [
    ...BUDGET_ROWS,
    tx("tripSpend", "expense", -50_000, "2026-10-06T17:00:00Z", { categoryId: "fun", budgetId: "trip" })
  ];
  const older = [tx("tripIncome", "income", 500_000, "2026-08-02T17:00:00Z", { budgetId: "trip" })];
  const s = runBudgets(rows, { preset: "this_month" }, { budgetBreakdown: { budgets: [VENTAS, archived], extraRows: older } });
  assert.equal(s.byBudget?.monthlyExpense, 120_000);
  assert.deepEqual(s.byBudget?.budgets.map(b => b.id), ["ventas"]);
});

test("byBudget loads all-time rows of active event budgets, assigned income of archived ones, and transfers only for links", () => {
  assert.deepEqual(budgetBreakdownQueries([
    VENTAS,
    { id: "trip", kind: "event", archived: false },
    { id: "oldTrip", kind: "event", archived: true, linkedAccountIds: ["x"] },
    { id: "hogar", kind: "monthly", archived: false, linkedAccountIds: ["y"] },
    { id: "oldHogar", kind: "monthly", archived: true }
  ]), { eventIds: ["ventas", "trip"], archivedEventIds: ["oldTrip"], transfers: true });
  assert.deepEqual(budgetBreakdownQueries([{ id: "trip", kind: "event", archived: false }]),
    { eventIds: ["trip"], archivedEventIds: [], transfers: false });
  assert.deepEqual(budgetBreakdownQueries([{ id: "oldTrip", kind: "event", archived: true }]),
    { eventIds: [], archivedEventIds: ["oldTrip"], transfers: false });
  assert.deepEqual(budgetBreakdownQueries([]), { eventIds: [], archivedEventIds: [], transfers: false });
});

test("byBudget leaves existing summary fields identical for a workspace without budgets", () => {
  for (const input of [{ preset: "this_month" as const }, { lastCompleteMonths: 3 }, { preset: "this_year" as const }]) {
    const before = run(input, { compareWithPrevious: true, groupBy: "category" });
    const after = run(input, { compareWithPrevious: true, groupBy: "category", budgetBreakdown: { budgets: [] } });
    const { byBudget, ...existing } = after;
    assert.deepEqual(existing, before);
    assert.ok(byBudget);
    assert.deepEqual(byBudget.budgets, []);
  }
  assert.equal(run({ preset: "this_month" }).byBudget, undefined);
});

test("byBudget is incomplete (null figures) when a manual rate is missing, instead of using 1:1", () => {
  const s = run({ preset: "this_month" }, { budgetBreakdown: { budgets: [] } });
  // ROWS has a EUR expense without a rate.
  assert.equal(s.byBudget?.incomplete, true);
  assert.equal(s.byBudget?.monthlyIncome, 5_000_000);
  assert.equal(s.byBudget?.monthlyExpense, null);
  assert.ok(s.byBudget?.notes.some(note => note.includes("EUR")));
});

test("byBudget is only computed for whole calendar months and unfiltered summaries", () => {
  const week = runBudgets(BUDGET_ROWS, { preset: "this_week" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.equal(week.byBudget, undefined);
  const filtered = runBudgets(BUDGET_ROWS, { preset: "this_month" }, { accountId: "bank", budgetBreakdown: { budgets: [VENTAS] } });
  assert.equal(filtered.byBudget, undefined);
  const range = runBudgets(BUDGET_ROWS, { startDate: "2026-10-01", endDate: "2026-10-31" }, { budgetBreakdown: { budgets: [VENTAS] } });
  assert.equal(range.byBudget?.monthlyIncome, 5_000_000);
});

test("cardBillingByAccount tags billing with the consumption basis only when asked", () => {
  const accounts = [{ id: "visa", type: "credit", statementClosingDay: 30, paymentDueDay: 15 }];
  assert.deepEqual(cardBillingByAccount(accounts).get("visa"), { statementClosingDay: 30, paymentDueDay: 15 });
  assert.deepEqual(
    cardBillingByAccount(accounts, "consumption").get("visa"),
    { statementClosingDay: 30, paymentDueDay: 15, basis: "consumption" }
  );
});

test("cardBillingByAccount attaches each card's statement ledger on the payment basis when given its history", () => {
  const accounts = [
    { id: "visa", type: "credit", statementClosingDay: 30, paymentDueDay: 15, balance: 0 },
    { id: "bank", type: "checking", balance: 5_000 }
  ];
  const ledgerInput = {
    timeZone: "UTC",
    transactions: [
      { type: "expense", amount: -1_000, date: new Date("2026-10-10T12:00:00Z"), accountId: "visa" },
      { type: "transfer", amount: 1_000, date: new Date("2026-10-20T12:00:00Z"), accountId: "bank", toAccountId: "visa" }
    ]
  };
  const purchase = ledgerInput.transactions[0];
  const paid = cardBillingByAccount(accounts, "payment", ledgerInput).get("visa");
  // Statement due in November was paid in full in October, so the purchase counts in October.
  assert.equal(expenseAmountForMonth(purchase, 2026, 9, "UTC", paid), 1_000);
  assert.equal(expenseAmountForMonth(purchase, 2026, 10, "UTC", paid), 0);
  // Without history (or on the consumption basis) nothing changes.
  assert.equal(cardBillingByAccount(accounts, "payment").get("visa")?.ledger, undefined);
  assert.deepEqual(
    cardBillingByAccount(accounts, "consumption", ledgerInput).get("visa"),
    { statementClosingDay: 30, paymentDueDay: 15, basis: "consumption" }
  );
  assert.equal(cardBillingByAccount(accounts, "payment", ledgerInput).has("bank"), false);
});

// --- P1 S6: Asesor budget figures follow the workspace card basis ------------------

/**
 * Agent tools over local snapshots. Every query returns its whole collection (the real tools
 * still filter by date, type and card); `queries` records each filter as "collection.field op".
 */
function stubAgentTools(
  data: { workspace: Record<string, unknown>; accounts: [string, object][]; transactions: SummaryTransaction[] },
  now = NOW
) {
  const snapshots = (entries: [string, object][]) => entries.map(([id, value]) => ({ id, data: () => value }));
  const collections: Record<string, { id: string; data: () => object }[]> = {
    transactions: snapshots(data.transactions.map(row => [row.id, row])),
    categories: snapshots([...NAMES.categories].map(([id, name]) => [id, { name }])),
    accounts: snapshots(data.accounts)
  };
  const queries: string[] = [];
  const db = { collection(name: string) {
    const query = {
      where: (field: string, op: string) => {
        queries.push(`${name}.${field} ${op}`);
        return query;
      },
      orderBy: () => query,
      get: async () => ({ docs: collections[name] ?? [] }),
      doc: () => ({ get: async () => ({ data: () => data.workspace }) })
    };
    return query;
  } } as unknown as Parameters<typeof buildAgentTools>[0];
  const tools = buildAgentTools(db, { workspaceId: "workspace-a", userId: "user-a", primaryCurrency: "COP", timeZone: TZ, now: () => now });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (name: string, input: object = {}) => tools.find(tool => tool.name === name)!.run(input) as Promise<any>;
  return { call, queries };
}

// Visa closes on the 25th and is due on the 5th of the next month.
const VISA = { type: "credit", name: "Visa", statementClosingDay: 25, paymentDueDay: 5 };
const BANK_ACCOUNT: [string, object] = ["bank", { type: "checking", name: "Banco", balance: 1_000_000 }];
const CARD_HISTORY = "transactions.toAccountId in";
const CYCLE_ROWS: SummaryTransaction[] = [
  // September cycle, statement paid on Oct 5.
  tx("sepCard", "expense", -30_000, "2026-09-20T17:00:00Z", { accountId: "visa", categoryId: "food" }),
  // October cycle, statement paid on Nov 5.
  tx("octCard", "expense", -100_000, "2026-10-03T17:00:00Z", { accountId: "visa", categoryId: "food" }),
  tx("bankFood", "expense", -50_000, "2026-10-05T17:00:00Z", { categoryId: "food" })
];
const CYCLE_WORKSPACE = { expenseLimit: 500_000, categoryBudgets: { food: 200_000 }, categoryBudgetCurrency: "COP" };
// Oct 8: 60,000 into the Visa pays the statement due Oct 5 (30,000) and 30,000 of the one due Nov 5.
const EARLY_PAYMENT = tx("early", "transfer", 60_000, "2026-10-08T17:00:00Z", { accountId: "bank", toAccountId: "visa" });

test("P1 S6: under Consumo (no basis set) the Asesor counts a card purchase in its statement cycle month for budgets", async () => {
  const { call, queries } = stubAgentTools({
    workspace: CYCLE_WORKSPACE,
    accounts: [["visa", { ...VISA, balance: -130_000 }], BANK_ACCOUNT],
    transactions: CYCLE_ROWS
  });
  const settings = await call("getWorkspaceSettings");
  // The October-cycle purchase (paid in November) and the bank expense; the September-cycle
  // purchase stays in September even though its statement is paid on Oct 5.
  assert.deepEqual(settings.currentMonth.categoryBudgets, [
    { categoryId: "food", categoryName: "Comida", limit: 200_000, spent: 150_000, remaining: 50_000, percentUsed: 75, exceeded: false }
  ]);
  assert.deepEqual(settings.currentMonth.categoryBudgetTotals, { budget: 200_000, spent: 150_000, percentUsed: 75 });
  assert.deepEqual(settings.currentMonth.expenseLimit, { limit: 500_000, spent: 150_000, remaining: 350_000, percentUsed: 30, exceeded: false });
  // Cash flow counts each statement when it is paid: the one due on Oct 5 plus the bank expense.
  assert.equal(settings.currentMonth.totals.expenses, 80_000);
  assert.ok(settings.notes.some((note: string) => note.includes("base Consumo")));

  const summary = await call("getFinancialSummary", { preset: "this_month" });
  assert.equal(summary.totals.expenses, 80_000);
  assert.equal(summary.byBudget.monthlyExpense, 150_000);
  assert.ok(summary.byBudget.notes.some((note: string) => note.includes("base Consumo")));
  // Cash flow reads the card history under every basis (the payments made to each card, like the Dashboard).
  assert.ok(queries.includes(CARD_HISTORY));
});

test("P1 S6: under Pagos a statement paid early counts in the month paid, and its unpaid rest in its payment month", async () => {
  const data = {
    workspace: { ...CYCLE_WORKSPACE, budgetCardBasis: "payment" },
    accounts: [["visa", { ...VISA, balance: -70_000 }], BANK_ACCOUNT] as [string, object][],
    transactions: [...CYCLE_ROWS, EARLY_PAYMENT]
  };
  const october = stubAgentTools(data);
  const settings = await october.call("getWorkspaceSettings");
  // 30,000 of the Oct 5 statement + 30,000 paid early of the Nov 5 statement + 50,000 bank.
  assert.deepEqual(settings.currentMonth.categoryBudgets, [
    { categoryId: "food", categoryName: "Comida", limit: 200_000, spent: 110_000, remaining: 90_000, percentUsed: 55, exceeded: false }
  ]);
  assert.deepEqual(settings.currentMonth.expenseLimit, { limit: 500_000, spent: 110_000, remaining: 390_000, percentUsed: 22, exceeded: false });
  // Cash flow counts the card the same way, like the Dashboard.
  assert.equal(settings.currentMonth.totals.expenses, 110_000);
  assert.ok(settings.notes.some((note: string) => note.includes("base Pagos")));
  assert.equal((await october.call("getFinancialSummary", { preset: "this_month" })).byBudget.monthlyExpense, 110_000);
  assert.ok(october.queries.includes(CARD_HISTORY));

  // November: the 70,000 still unpaid of the Nov 5 statement.
  const november = stubAgentTools(data, new Date("2026-11-11T15:00:00-05:00"));
  const novemberSettings = await november.call("getWorkspaceSettings");
  assert.equal(novemberSettings.currentMonth.categoryBudgets[0].spent, 70_000);
  assert.equal(novemberSettings.currentMonth.expenseLimit.spent, 70_000);
  assert.equal(novemberSettings.currentMonth.totals.expenses, 70_000);
  assert.equal((await november.call("getFinancialSummary", { preset: "this_month" })).byBudget.monthlyExpense, 70_000);

  // Periods without byBudget (not whole months) still read the card history for cash flow.
  const week = stubAgentTools(data);
  await week.call("getFinancialSummary", { preset: "this_week" });
  assert.ok(week.queries.includes(CARD_HISTORY));
  // A summary of another account never uses the cards, so it reads no card history.
  const bank = stubAgentTools(data);
  await bank.call("getFinancialSummary", { preset: "this_month", accountId: "bank" });
  assert.ok(!bank.queries.includes(CARD_HISTORY));
});

test("P1 S6: the Asesor cash-flow summary is identical under both card bases", async () => {
  const transactions = [...CYCLE_ROWS, EARLY_PAYMENT];
  const accounts: [string, object][] = [["visa", { ...VISA, balance: -70_000 }], BANK_ACCOUNT];
  const withBasis = (budgetCardBasis?: string) =>
    stubAgentTools({ workspace: { ...CYCLE_WORKSPACE, ...(budgetCardBasis ? { budgetCardBasis } : {}) }, accounts, transactions }).call;
  const [consumo, explicitConsumo, pagos] = [withBasis(), withBasis("consumption"), withBasis("payment")];
  const inputs = [
    { preset: "this_month", groupBy: "category", compareWithPrevious: true },
    { preset: "last_month", groupBy: "day" },
    { preset: "this_year", groupBy: "month" },
    { lastCompleteMonths: 2, groupBy: "account" },
    { preset: "this_week", type: "expense" }
  ];
  for (const input of inputs) {
    // Everything except byBudget is cash flow.
    const [base, explicit, payment] = await Promise.all([consumo, explicitConsumo, pagos].map(async call => {
      const { byBudget, ...cashFlow } = await call("getFinancialSummary", input);
      return cashFlow;
    }));
    assert.deepEqual(explicit, base, JSON.stringify(input));
    assert.deepEqual(payment, base, JSON.stringify(input));
  }
  // The early payment counts in October under both bases, like the Dashboard.
  assert.equal((await consumo("getFinancialSummary", { preset: "this_month" })).totals.expenses, 110_000);
  const months = await Promise.all([consumo, explicitConsumo, pagos].map(async call => {
    const { period, totals } = (await call("getWorkspaceSettings")).currentMonth;
    return { period, totals };
  }));
  assert.deepEqual(months[1], months[0]);
  assert.deepEqual(months[2], months[0]);
  assert.deepEqual(months[0].totals, { income: 0, expenses: 110_000, net: -110_000, savingsRate: 0, upcomingInstallments: 0 });
});

test("P1 S6: without billing cards the Asesor budget figures are the same under both bases, as before", async () => {
  const assigns = ["extra-monthly", "event"].map(budgetId =>
    tx(budgetId, "expense", -100_000, "2026-10-08T17:00:00Z", { categoryId: "food", budgetId })
  );
  const transactions = [...ROWS.map(row => row.id === "market" ? { ...row, budgetId: "default-monthly" } : row), ...assigns];
  // The card has no billing days and the bridge is a mirror: no account bills by statement.
  const accounts: [string, object][] = [
    ["card", { type: "credit", name: "Visa", balance: -300_000 }],
    ["bridge", { type: "credit", name: "Puente", statementClosingDay: 25, paymentDueDay: 5, mirror: { workspaceId: "w" } }],
    BANK_ACCOUNT
  ];
  const workspace = { expenseLimit: 500_000, categoryBudgets: { food: 300_000, tech: 150_000 }, categoryBudgetCurrency: "COP", exchangeRates: RATES };
  const run = async (budgetCardBasis?: string) => {
    const { call, queries } = stubAgentTools({ workspace: { ...workspace, ...(budgetCardBasis ? { budgetCardBasis } : {}) }, accounts, transactions });
    const result = { settings: await call("getWorkspaceSettings"), summary: await call("getFinancialSummary", { preset: "this_month" }) };
    assert.ok(!queries.includes(CARD_HISTORY));
    return result;
  };
  const consumo = await run();
  assert.deepEqual(await run("payment"), consumo);
  assert.deepEqual(consumo.settings.currentMonth, {
    period: { start: "2026-10-01", end: "2026-10-31", label: "octubre de 2026" },
    totals: { income: 5_000_000, expenses: 690_020, net: 4_309_980, savingsRate: 86.2, upcomingInstallments: 100_000 },
    expenseLimit: { limit: 500_000, spent: 490_020, remaining: 9_980, percentUsed: 98, exceeded: false },
    categoryBudgets: [
      { categoryId: "food", categoryName: "Comida", limit: 300_000, spent: 390_000, remaining: -90_000, percentUsed: 130, exceeded: true },
      { categoryId: "tech", categoryName: "Tecnología", limit: 150_000, spent: 100_000, remaining: 50_000, percentUsed: 67, exceeded: false }
    ],
    categoryBudgetTotals: { budget: 450_000, spent: 490_000, percentUsed: 109 }
  });
  assert.ok(!consumo.settings.notes.some((note: string) => /base (Consumo|Pagos)/.test(note)));
  assert.ok(!consumo.summary.byBudget.notes.some((note: string) => /base (Consumo|Pagos)/.test(note)));
});

// --- P1 S8.4: Asesor cash flow counts card payments like the Dashboard ------------

const LEDGER_ROWS = [...CYCLE_ROWS, EARLY_PAYMENT];
// The Dashboard's cash-flow billing: payment basis with each card's statement ledger.
const LEDGER_BILLING = cardBillingByAccount(
  [{ id: "visa", ...VISA, balance: -70_000 }, { id: "bank", type: "checking" }],
  "payment",
  { transactions: LEDGER_ROWS, timeZone: TZ }
);
const runLedger = (input: Parameters<typeof resolvePeriod>[0], extra: Partial<Parameters<typeof summarize>[1]> = {}) =>
  summarize(LEDGER_ROWS, {
    period: resolvePeriod(input, NOW, TZ),
    now: NOW,
    timeZone: TZ,
    primaryCurrency: "COP",
    exchangeRates: RATES,
    names: NAMES,
    cardBilling: LEDGER_BILLING,
    ...extra
  });
/** The Dashboard's expenses of a local month: each expense's share with the ledger (http.ts port of the app helper). */
const dashboardMonthExpenses = (year: number, month: number) => LEDGER_ROWS.reduce(
  (sum, row) => sum + expenseAmountForMonth(row, year, month, TZ, LEDGER_BILLING.get(String(row.accountId)) ?? null),
  0
);

test("P1 S8.4: an early card payment moves spend into the month paid in the cash-flow summary", () => {
  const october = runLedger({ preset: "this_month" });
  // The Oct 5 statement (30,000, paid on Oct 8), 30,000 paid early of the Nov 5 statement and 50,000 at the bank.
  assert.deepEqual(october.totals, { income: 0, expenses: 110_000, net: -110_000, savingsRate: 0, upcomingInstallments: 0 });
  assert.equal(october.totals.expenses, dashboardMonthExpenses(2026, 9));
  assert.equal(october.topExpenses.find(row => row.id === "octCard")?.amount, 30_000);
  assert.ok(october.notes.some(note => note.includes("en el mes del abono")));
  // The card's 60,000 sits on the day it was paid (Oct 8); the bank expense on Oct 5.
  assert.deepEqual(runLedger({ preset: "this_month" }, { groupBy: "day" }).groups.map(g => [g.key, g.expenses]), [["2026-10-05", 50_000], ["2026-10-08", 60_000]]);

  // November keeps only the 70,000 still unpaid of the Nov 5 statement; nothing counts twice.
  const months = runLedger({ startDate: "2026-09-01", endDate: "2026-12-31" }, { groupBy: "month" });
  assert.deepEqual(months.groups.map(g => [g.key, g.expenses]), [["2026-10", 110_000], ["2026-11", 70_000]]);
  assert.equal(dashboardMonthExpenses(2026, 10), 70_000);
  const november = summarize(LEDGER_ROWS, {
    period: resolvePeriod({ preset: "this_month" }, new Date("2026-11-11T15:00:00-05:00"), TZ),
    now: new Date("2026-11-11T15:00:00-05:00"), timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES,
    cardBilling: LEDGER_BILLING, compareWithPrevious: true
  });
  assert.equal(november.totals.expenses, 70_000);
  assert.equal(november.comparison?.totals.expenses, 110_000);
});

test("P1 S8.4: card installments paid early split by month, with their share labels", () => {
  // 90,000 in 3 installments on Oct 3: statements due Nov 5, Dec 5 and Jan 5 (30,000 each). The
  // card already owed nothing; 45,000 paid on Oct 20 settles the first and half of the second.
  const rows = [
    tx("tv", "expense", -90_000, "2026-10-03T17:00:00Z", { accountId: "visa", categoryId: "tech", installments: 3 }),
    tx("tvPay", "transfer", 45_000, "2026-10-20T17:00:00Z", { accountId: "bank", toAccountId: "visa" })
  ];
  const billing = cardBillingByAccount([{ id: "visa", ...VISA, balance: -45_000 }], "payment", { transactions: rows, timeZone: TZ });
  const s = summarize(rows, {
    period: resolvePeriod({ startDate: "2026-10-01", endDate: "2027-01-31" }, NOW, TZ),
    now: NOW, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES, cardBilling: billing, groupBy: "month"
  });
  assert.deepEqual(s.groups.map(g => [g.key, g.expenses]), [["2026-10", 45_000], ["2026-12", 15_000], ["2027-01", 30_000]]);
  assert.equal(s.totals.expenses, 90_000);
  // Shares due after today stay flagged as upcoming: half of the Dec 5 statement and the Jan 5 one.
  assert.equal(s.totals.upcomingInstallments, 45_000);
  assert.equal(s.topExpenses[0].installmentsInfo, "cuotas 1 a 3 de 3 (compra total 90000 COP)");
  const october = summarize(rows, {
    period: resolvePeriod({ preset: "this_month" }, NOW, TZ),
    now: NOW, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES, cardBilling: billing
  });
  assert.equal(october.topExpenses[0].amount, 45_000);
  assert.equal(october.topExpenses[0].installmentsInfo, "cuotas 1 a 2 de 3 (compra total 90000 COP)");
});

test("P1 S8.4: per-month cash flow equals the server expenseAmountForMonth sum on billing cards with payments", () => {
  // Months June to October 2026 (NOW is Oct 11).
  const rows = [
    // Master closes on the 10th and is due on the 25th (same month).
    tx("m1", "expense", -120_000, "2026-08-12T17:00:00Z", { accountId: "master", categoryId: "tech" }),
    tx("m2", "expense", -240_000, "2026-09-05T17:00:00Z", { accountId: "master", categoryId: "food", installments: 6 }),
    tx("m3", "expense", -75_000, "2026-10-08T17:00:00Z", { accountId: "master", categoryId: "fun" }),
    tx("mp1", "transfer", 120_000, "2026-09-24T17:00:00Z", { accountId: "bank", toAccountId: "master" }),
    tx("mp2", "transfer", 100_000, "2026-10-09T17:00:00Z", { accountId: "bank", toAccountId: "master" }),
    // Diners closes on the 31st and is due on the 15th (next month): 12 installments, partial payments.
    tx("d1", "expense", -500_000, "2026-07-28T17:00:00Z", { accountId: "diners", categoryId: "tech", installments: 12 }),
    tx("d2", "expense", -45_000, "2026-10-01T17:00:00Z", { accountId: "diners", categoryId: "fun" }),
    tx("dp1", "transfer", 41_667, "2026-08-14T17:00:00Z", { accountId: "bank", toAccountId: "diners" }),
    tx("dp2", "transfer", 100_000, "2026-09-25T17:00:00Z", { accountId: "bank", toAccountId: "diners" }),
    // Closes on the 20th, due on the 5th; it had 50,000 of credit before its first movement.
    tx("p1", "expense", -60_000, "2026-06-25T17:00:00Z", { accountId: "pre", categoryId: "food" }),
    tx("p2", "expense", -30_000, "2026-08-03T17:00:00Z", { accountId: "pre", categoryId: "food", installments: 2 }),
    tx("pp", "transfer", 20_000, "2026-09-02T17:00:00Z", { accountId: "bank", toAccountId: "pre" }),
    tx("cash", "expense", -10_000, "2026-06-03T17:00:00Z", { categoryId: "food" })
  ];
  const billing = cardBillingByAccount([
    { id: "master", type: "credit", statementClosingDay: 10, paymentDueDay: 25, balance: -215_000 },
    { id: "diners", type: "credit", statementClosingDay: 31, paymentDueDay: 15, balance: -403_333 },
    { id: "pre", type: "credit", statementClosingDay: 20, paymentDueDay: 5, balance: -20_000 },
    { id: "bank", type: "checking", balance: 0 }
  ], "payment", { transactions: rows, timeZone: TZ });
  const options = { now: NOW, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES, cardBilling: billing };
  const months = [5, 6, 7, 8, 9].map(month => {
    const end = new Date(Date.UTC(2026, month + 1, 0)).getUTCDate();
    const key = `2026-${String(month + 1).padStart(2, "0")}`;
    const server = rows.reduce((sum, row) =>
      sum + expenseAmountForMonth(row, 2026, month, TZ, billing.get(String(row.accountId)) ?? null), 0);
    const summary = summarize(rows, { ...options, period: resolvePeriod({ startDate: `${key}-01`, endDate: `${key}-${end}` }, NOW, TZ) });
    return { key, summary: summary.totals.expenses, server: Math.round(server * 100) / 100 };
  });
  for (const { key, summary, server } of months) assert.equal(summary, server, key);
  assert.ok(months.every(({ server }) => server > 0));
  // One summary over the five months splits the same way.
  const grouped = summarize(rows, { ...options, groupBy: "month", period: resolvePeriod({ startDate: "2026-06-01", endDate: "2026-10-31" }, NOW, TZ) });
  assert.deepEqual(grouped.groups.map(g => [g.key, g.expenses]), months.map(({ key, server }) => [key, server]));
  // By day, paid parts sit on their payment days and add up to each month to the cent.
  const byDay = summarize(rows, { ...options, groupBy: "day", period: resolvePeriod({ startDate: "2026-06-01", endDate: "2026-10-31" }, NOW, TZ) });
  for (const { key, server } of months) {
    const days = byDay.groups.filter(g => g.key.startsWith(key)).reduce((sum, g) => sum + Math.round(g.expenses * 100), 0);
    assert.equal(days, Math.round(server * 100), key);
  }
  assert.ok(byDay.groups.some(g => g.key === "2026-09-24"), "the Sep 24 Master payment is a day of its own");
});

test("P1 S8.4: money already paid to a card never counts as upcoming and sits on the day it was paid", () => {
  // Master closes on the 10th and is due on the 25th. Today is Nov 20.
  const now = new Date("2026-11-20T12:00:00-05:00");
  // The card's balance is what its movements leave (no debt or credit from before).
  const run = (rows: SummaryTransaction[], balance: number) => summarize(rows, {
    period: resolvePeriod({ preset: "this_month" }, now, TZ), now, timeZone: TZ, primaryCurrency: "COP", exchangeRates: RATES, names: NAMES,
    groupBy: "day",
    cardBilling: cardBillingByAccount([{ id: "master", type: "credit", statementClosingDay: 10, paymentDueDay: 25, balance }], "payment", { transactions: rows, timeZone: TZ })
  });
  const pay = (amount: number) => tx("pay", "transfer", amount, "2026-11-15T17:00:00Z", { accountId: "bank", toAccountId: "master" });

  // Bought on Nov 12 (statement due Dec 25) and paid in full on Nov 15: nothing is still due.
  const paid = run([tx("buy", "expense", -100_000, "2026-11-12T17:00:00Z", { accountId: "master", categoryId: "food" }), pay(100_000)], 0);
  assert.equal(paid.totals.expenses, 100_000);
  assert.equal(paid.totals.upcomingInstallments, 0);
  assert.ok(!paid.notes.some(note => note.includes("vencen después de hoy")));
  assert.deepEqual(paid.groups.map(g => [g.key, g.expenses]), [["2026-11-15", 100_000]]);

  // Bought on Nov 2 (statement due Nov 25), 40,000 paid on Nov 15: only the unpaid 60,000 is still due.
  const partial = run([tx("buy", "expense", -100_000, "2026-11-02T17:00:00Z", { accountId: "master", categoryId: "food" }), pay(40_000)], -60_000);
  assert.equal(partial.totals.expenses, 100_000);
  assert.equal(partial.totals.upcomingInstallments, 60_000);
  assert.deepEqual(partial.groups.map(g => [g.key, g.expenses]), [["2026-11-15", 40_000], ["2026-11-25", 60_000]]);
});
