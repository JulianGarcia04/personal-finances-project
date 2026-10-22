import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertCategoryFor,
  budgetAlertLedgerId,
  budgetForCategory,
  capInReportingCurrency,
  categorySpendForScope,
  countsTowardMonthlySpend,
  countsTowardScopeTotal,
  incomeReference,
  incomeChangeAlertScope,
  monthlyExpenseTotal,
  monthlyIncomeTotal,
  scopeFundsTotal,
  scopeTotalSpend,
  selfFundedBudgetIds,
  TOTAL_ALERT_SUBJECT,
  evaluateBudgetThresholds,
  monthKey,
  resolveAlertBudgetId,
  spendFieldsChanged
} from "./budgetAlerts";

const BOGOTA = "America/Bogota";
const OCTOBER = { year: 2026, month: 9 };

const expense = (amount: number, extra: Record<string, unknown> = {}) => ({
  type: "expense",
  amount: -Math.abs(amount),
  categoryId: "food",
  currency: "COP",
  date: new Date("2026-10-10T17:00:00.000Z"),
  ...extra
});

test("monthKey and ledger id are stable and zero-padded", () => {
  assert.equal(monthKey({ year: 2026, month: 0 }), "2026-01");
  assert.equal(monthKey(OCTOBER), "2026-10");
  // The default budget keeps the pre-multiple-budgets id so existing ledgers stay valid.
  assert.equal(budgetAlertLedgerId("ws1", "default-monthly", "2026-10", "food"), "ws1_2026-10_food");
  assert.equal(budgetAlertLedgerId("ws1", "house", "2026-10", "food"), "ws1_house_2026-10_food");
  assert.equal(budgetAlertLedgerId("ws1", "trip", "event", "food"), "ws1_trip_event_food");
});

test("budgetForCategory only accepts positive finite budgets", () => {
  assert.equal(budgetForCategory({ food: 500 }, "food"), 500);
  assert.equal(budgetForCategory({ food: 0 }, "food"), 0);
  assert.equal(budgetForCategory({ food: -10 }, "food"), 0);
  assert.equal(budgetForCategory({ food: "abc" as unknown as number }, "food"), 0);
  assert.equal(budgetForCategory({}, "food"), 0);
  assert.equal(budgetForCategory(undefined, "food"), 0);
});

test("below 80% notifies nothing", () => {
  assert.deepEqual(evaluateBudgetThresholds(79.99, 100, []), { threshold: null, claim: [] });
});

test("reaching 80% notifies the warning threshold", () => {
  assert.deepEqual(evaluateBudgetThresholds(80, 100, []), { threshold: 80, claim: [80] });
});

test("jumping from below 80% to 100% sends only the 100% alert and claims both", () => {
  assert.deepEqual(evaluateBudgetThresholds(150, 100, []), { threshold: 100, claim: [80, 100] });
});

test("crossing 100% after the 80% alert sends the 100% alert", () => {
  assert.deepEqual(evaluateBudgetThresholds(100, 100, [80]), { threshold: 100, claim: [100] });
});

test("already notified thresholds never alert again", () => {
  assert.deepEqual(evaluateBudgetThresholds(90, 100, [80]), { threshold: null, claim: [] });
  assert.deepEqual(evaluateBudgetThresholds(300, 100, [80, 100]), { threshold: null, claim: [] });
});

test("edits or deletes that lower spend do not re-alert", () => {
  // Spend dropped back below 80% after both alerts: nothing is sent or un-claimed.
  assert.deepEqual(evaluateBudgetThresholds(10, 100, [80, 100]), { threshold: null, claim: [] });
  // Spend dropped but is still over 80%: still nothing new.
  assert.deepEqual(evaluateBudgetThresholds(85, 100, [80]), { threshold: null, claim: [] });
});

test("zero or absent budget never alerts", () => {
  assert.deepEqual(evaluateBudgetThresholds(1000, 0, []), { threshold: null, claim: [] });
  assert.deepEqual(evaluateBudgetThresholds(1000, Number.NaN, []), { threshold: null, claim: [] });
});

const DEFAULT_SCOPE = { id: "default-monthly", kind: "monthly" as const };
const COP_OPTIONS = { timeZone: BOGOTA, reportingCurrency: "COP", exchangeRates: {} };

test("category spend counts only expenses of that category in the month", () => {
  const rows = [
    expense(100),
    expense(50, { categoryId: "fun" }),
    { type: "income", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    { type: "transfer", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    { type: "loan", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    expense(70, { date: new Date("2026-09-20T17:00:00.000Z") })
  ];
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, COP_OPTIONS), 100);
});

test("category spend uses the local month of the configured time zone", () => {
  // 2026-11-01T03:00Z is still October 31 in Bogota (UTC-5).
  const rows = [expense(40, { date: new Date("2026-11-01T03:00:00.000Z") })];
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, COP_OPTIONS), 40);
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, { year: 2026, month: 10 }, COP_OPTIONS), 0);
});

test("legacy date-only strings are local calendar days, not UTC midnight", () => {
  // new Date("2026-11-01") is Oct 31 19:00 in Bogota; the app reads it as November 1.
  const rows = [expense(40, { date: "2026-11-01" })];
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, COP_OPTIONS), 0);
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, { year: 2026, month: 10 }, COP_OPTIONS), 40);
});

test("category spend splits installment purchases per month", () => {
  const rows = [expense(600, { date: new Date("2026-08-10T17:00:00.000Z"), installments: 6 })];
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, COP_OPTIONS), 100);
});

test("billed card installments count in the statement payment month", () => {
  // Closing day 25, due day 10: a Sep 28 purchase closes Oct 25 and is paid in November.
  const card = { statementClosingDay: 25, paymentDueDay: 10 };
  const billingFor = (accountId?: string | null) => (accountId === "visa" ? card : null);
  const rows = [
    expense(300, { accountId: "visa", installments: 3, date: new Date("2026-09-28T17:00:00.000Z") }),
    expense(90, { accountId: "cash", installments: 3, date: new Date("2026-09-28T17:00:00.000Z") })
  ];
  const options = { ...COP_OPTIONS, billingFor };
  // October: only the cash installment (calendar month + 1); the card's first share is November.
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, options), 30);
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, { year: 2026, month: 10 }, options), 130);
});

test("category spend converts currencies with manual rates and is unknown when a rate is missing", () => {
  const rows = [expense(10, { currency: "USD" }), expense(1000)];
  assert.equal(
    categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, { ...COP_OPTIONS, exchangeRates: { USD: 4000 } }),
    10 * 4000 + 1000
  );
  // No 1:1 fallback: the app hides incomplete totals, so no alert can be evaluated.
  assert.equal(categorySpendForScope([...rows, expense(5, { currency: "EUR" })], "food", DEFAULT_SCOPE, OCTOBER, {
    ...COP_OPTIONS, exchangeRates: { USD: 4000 }
  }), null);
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, { ...COP_OPTIONS, exchangeRates: { USD: 0 } }), null);
});

test("default budget spend includes unassigned and default expenses only", () => {
  const rows = [
    expense(100),
    expense(20, { budgetId: null }),
    expense(5, { budgetId: "default-monthly" }),
    expense(999, { budgetId: "trip" })
  ];
  assert.equal(categorySpendForScope(rows, "food", DEFAULT_SCOPE, OCTOBER, COP_OPTIONS), 125);
});

test("additional monthly budget spend counts only its own expenses in the month", () => {
  const scope = { id: "house", kind: "monthly" as const };
  const rows = [
    expense(100),
    expense(40, { budgetId: "house" }),
    expense(60, { budgetId: "house", installments: 2, date: new Date("2026-09-10T17:00:00.000Z") }),
    expense(70, { budgetId: "house", date: new Date("2026-09-20T17:00:00.000Z") })
  ];
  assert.equal(categorySpendForScope(rows, "food", scope, OCTOBER, COP_OPTIONS), 70);
});

test("event budget spend is the full committed principal regardless of month", () => {
  const scope = { id: "trip", kind: "event" as const };
  const rows = [
    expense(900, { budgetId: "trip", installments: 3, date: new Date("2026-06-10T17:00:00.000Z") }),
    expense(100, { budgetId: "trip" }),
    expense(50),
    expense(10, { budgetId: "trip", categoryId: "fun" })
  ];
  assert.equal(categorySpendForScope(rows, "food", scope, OCTOBER, COP_OPTIONS), 1000);
});

test("capInReportingCurrency keeps nominal caps and never relabels them", () => {
  assert.equal(capInReportingCurrency(500, "COP", "COP", {}), 500);
  assert.equal(capInReportingCurrency(100, "USD", "COP", { USD: 4000 }), 400_000);
  // Unconfirmed legacy cap units disable the comparison (Dashboard/Goals do the same).
  assert.equal(capInReportingCurrency(500, null, "COP", {}), null);
  assert.equal(capInReportingCurrency(100, "USD", "COP", {}), null);
  assert.equal(capInReportingCurrency(100, "USD", "COP", { USD: -1 }), null);
});

test("resolveAlertBudgetId maps unassigned expenses to the protected default budget", () => {
  assert.equal(resolveAlertBudgetId(undefined), "default-monthly");
  assert.equal(resolveAlertBudgetId(null), "default-monthly");
  assert.equal(resolveAlertBudgetId(""), "default-monthly");
  assert.equal(resolveAlertBudgetId("trip"), "trip");
});

test("alertCategoryFor only returns expenses of the scope with a share in the evaluated month", () => {
  const options = { timeZone: BOGOTA };
  assert.equal(alertCategoryFor(expense(10), DEFAULT_SCOPE, OCTOBER, options), "food");
  assert.equal(alertCategoryFor(undefined, DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor({ ...expense(10), type: "transfer" }, DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor({ ...expense(10), type: "income" }, DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(10, { categoryId: "" }), DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(10, { date: new Date("2026-09-10T17:00:00.000Z") }), DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(0), DEFAULT_SCOPE, OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(10, { budgetId: "trip" }), DEFAULT_SCOPE, OCTOBER, options), null);
});

test("alertCategoryFor follows card payment months and event principal", () => {
  const card = { statementClosingDay: 25, paymentDueDay: 10 };
  const late = expense(10, { accountId: "visa", date: new Date("2026-09-28T17:00:00.000Z") });
  assert.equal(alertCategoryFor(late, DEFAULT_SCOPE, OCTOBER, { timeZone: BOGOTA }), null);
  assert.equal(alertCategoryFor(late, DEFAULT_SCOPE, { year: 2026, month: 10 }, { timeZone: BOGOTA, billingFor: () => card }), "food");
  const booking = expense(10, { budgetId: "trip", date: new Date("2026-03-01T17:00:00.000Z") });
  assert.equal(alertCategoryFor(booking, { id: "trip", kind: "event" }, OCTOBER, { timeZone: BOGOTA }), "food");
});

function OCTOBER_DATE() {
  return new Date("2026-10-05T17:00:00.000Z");
}

test("spendFieldsChanged ignores edits that cannot change category spend", () => {
  const base = expense(10, { description: "Pan", notes: null });
  assert.equal(spendFieldsChanged(base, { ...base, description: "Pan integral", notes: "x" }), false);
  assert.equal(spendFieldsChanged(base, { ...base, date: new Date(base.date.getTime()) }), false);
  assert.equal(spendFieldsChanged(base, { ...base, amount: -20 }), true);
  assert.equal(spendFieldsChanged(base, { ...base, categoryId: "fun" }), true);
  assert.equal(spendFieldsChanged(base, { ...base, currency: "USD" }), true);
  assert.equal(spendFieldsChanged(base, { ...base, installments: 3 }), true);
  assert.equal(spendFieldsChanged(base, { ...base, budgetId: "trip" }), true);
  assert.equal(spendFieldsChanged(base, { ...base, accountId: "visa" }), true);
  assert.equal(spendFieldsChanged(base, { ...base, date: new Date("2026-10-11T17:00:00.000Z") }), true);
  assert.equal(spendFieldsChanged({ ...base, type: "transfer" }, base), true);
  assert.equal(spendFieldsChanged(undefined, base), true);
});

const HOGAR = { id: "hogar", kind: "monthly" as const };
const VIAJE = { id: "viaje", kind: "event" as const };

test("scope total spend counts every expense of the budget in the month, categorized or not", () => {
  const txs = [
    expense(100, { budgetId: "hogar" }),
    expense(50, { budgetId: "hogar", categoryId: "fun" }),
    expense(30, { budgetId: "hogar", categoryId: undefined }),
    expense(999, { budgetId: "otro" }),
    expense(999),
    expense(999, { budgetId: "hogar", date: new Date("2026-09-10T17:00:00.000Z") }),
    { type: "income", amount: 999, budgetId: "hogar", currency: "COP", date: new Date("2026-10-10T17:00:00.000Z") }
  ];
  assert.equal(scopeTotalSpend(txs, HOGAR, OCTOBER, COP_OPTIONS), 180);
});

test("event scope total is the full committed principal and unknown when a rate is missing", () => {
  const txs = [
    expense(100, { budgetId: "viaje", date: new Date("2026-01-10T17:00:00.000Z") }),
    expense(20, { budgetId: "viaje", categoryId: "fun" })
  ];
  assert.equal(scopeTotalSpend(txs, VIAJE, OCTOBER, COP_OPTIONS), 120);
  assert.equal(scopeTotalSpend([...txs, expense(5, { budgetId: "viaje", currency: "USD" })], VIAJE, OCTOBER, COP_OPTIONS), null);
});

test("countsTowardScopeTotal only accepts expenses of the scope with a share in the period", () => {
  const options = { timeZone: BOGOTA };
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "hogar", categoryId: undefined }), HOGAR, OCTOBER, options), true);
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "otro" }), HOGAR, OCTOBER, options), false);
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "hogar", date: new Date("2026-09-10T17:00:00.000Z") }), HOGAR, OCTOBER, options), false);
  assert.equal(countsTowardScopeTotal(undefined, HOGAR, OCTOBER, options), false);
});

test("total alerts use their own ledger slot", () => {
  assert.equal(budgetAlertLedgerId("ws", "default-monthly", "2026-10", TOTAL_ALERT_SUBJECT), "ws_2026-10___total");
  assert.equal(budgetAlertLedgerId("ws", "hogar", "event", TOTAL_ALERT_SUBJECT), "ws_hogar_event___total");
});

const income = (amount: number, extra: Record<string, unknown> = {}) => ({
  type: "income",
  amount: Math.abs(amount),
  currency: "COP",
  date: new Date("2026-10-15T17:00:00.000Z"),
  ...extra
});

test("monthly income counts only income registered in the local month, converted", () => {
  const txs = [
    income(5_000_000),
    income(100, { currency: "USD" }),
    income(999, { date: new Date("2026-09-30T17:00:00.000Z") }),
    expense(999),
    { type: "transfer", amount: 999, currency: "COP", date: new Date("2026-10-15T17:00:00.000Z") }
  ];
  assert.equal(monthlyIncomeTotal(txs, OCTOBER, { ...COP_OPTIONS, exchangeRates: { USD: 4000 } }), 5_400_000);
  assert.equal(monthlyIncomeTotal(txs, OCTOBER, COP_OPTIONS), null);
});

test("monthly income excludes income assigned to another budget", () => {
  const txs = [
    income(1_000),
    income(200, { budgetId: null }),
    income(300, { budgetId: "default-monthly" }),
    income(5_000_000, { budgetId: "ventas-casa" })
  ];
  assert.equal(monthlyIncomeTotal(txs, OCTOBER, COP_OPTIONS), 1_500);
});

test("monthly expense total counts every budget's month share", () => {
  const txs = [
    expense(100),
    expense(50, { budgetId: "hogar", categoryId: undefined }),
    expense(70, { budgetId: "viaje" }),
    expense(999, { date: new Date("2026-09-10T17:00:00.000Z") }),
    income(999)
  ];
  assert.equal(monthlyExpenseTotal(txs, OCTOBER, COP_OPTIONS), 220);
  assert.equal(monthlyExpenseTotal([...txs, expense(1, { currency: "USD" })], OCTOBER, COP_OPTIONS), null);
});

test("monthly expense total skips budgets funded by their own income", () => {
  const txs = [
    expense(100),
    expense(50, { budgetId: "hogar", categoryId: undefined }),
    expense(700, { budgetId: "ventas-casa" })
  ];
  const funded = selfFundedBudgetIds([income(5_000, { budgetId: "ventas-casa" }), income(1_000), income(10, { budgetId: "default-monthly" })]);
  assert.deepEqual([...funded], ["ventas-casa"]);
  assert.equal(monthlyExpenseTotal(txs, OCTOBER, COP_OPTIONS, funded), 150);
  assert.equal(monthlyExpenseTotal(txs, OCTOBER, COP_OPTIONS), 850);
});

test("income reference is the larger of planner and real income, falling back to either", () => {
  assert.equal(incomeReference(5_000_000, 6_000_000), 6_000_000);
  assert.equal(incomeReference(5_000_000, 1_000_000), 5_000_000);
  assert.equal(incomeReference(0, 3_000_000), 3_000_000);
  assert.equal(incomeReference(5_000_000, null), 5_000_000);
  assert.equal(incomeReference(undefined, 0), null);
  assert.equal(incomeReference(0, null), null);
});

test("countsTowardMonthlySpend accepts any budget's expense with a share in the month", () => {
  const options = { timeZone: BOGOTA };
  assert.equal(countsTowardMonthlySpend(expense(10, { budgetId: "hogar", categoryId: undefined }), OCTOBER, options), true);
  assert.equal(countsTowardMonthlySpend(expense(10, { date: new Date("2026-09-10T17:00:00.000Z") }), OCTOBER, options), false);
  assert.equal(countsTowardMonthlySpend(income(10), OCTOBER, options), false);
  assert.equal(countsTowardMonthlySpend(undefined, OCTOBER, options), false);
});

test("monthly income skips income with a missing or unparseable date instead of throwing", () => {
  const txs = [income(1_000), income(999, { date: undefined }), income(999, { date: "garbage" })];
  assert.equal(monthlyIncomeTotal(txs, OCTOBER, COP_OPTIONS), 1_000);
});

test("budget funds are its assigned income: all of it for an event, the month's for a monthly budget", () => {
  const incomes = [
    income(3_000, { budgetId: "ventas-casa" }),
    income(2_000, { budgetId: "ventas-casa", date: new Date("2026-08-10T17:00:00.000Z") }),
    income(9_999, { budgetId: "otro" }),
    income(9_999)
  ];
  assert.equal(scopeFundsTotal(incomes, { id: "ventas-casa", kind: "event" }, OCTOBER, COP_OPTIONS), 5_000);
  assert.equal(scopeFundsTotal(incomes, { id: "ventas-casa", kind: "monthly" }, OCTOBER, COP_OPTIONS), 3_000);
  assert.equal(scopeFundsTotal(incomes, { id: "sin-fondos", kind: "event" }, OCTOBER, COP_OPTIONS), 0);
  assert.equal(scopeFundsTotal([income(1, { budgetId: "ventas-casa", currency: "USD" })], { id: "ventas-casa", kind: "event" }, OCTOBER, COP_OPTIONS), null);
});

test("an income change re-checks the alerts it can push over a threshold", () => {
  const options = { timeZone: BOGOTA };
  // Monthly income drops: deleted, moved to a budget, lowered, or moved out of the month.
  assert.deepEqual(incomeChangeAlertScope(income(1_000), undefined, OCTOBER, options), { monthlyIncome: true, fundsBudgetId: null });
  assert.deepEqual(incomeChangeAlertScope(income(1_000), income(1_000, { budgetId: "casa" }), OCTOBER, options), { monthlyIncome: true, fundsBudgetId: null });
  assert.deepEqual(incomeChangeAlertScope(income(1_000), income(400), OCTOBER, options), { monthlyIncome: true, fundsBudgetId: null });
  assert.deepEqual(incomeChangeAlertScope(income(1_000), income(1_000, { date: new Date("2026-11-02T17:00:00.000Z") }), OCTOBER, options), { monthlyIncome: true, fundsBudgetId: null });
  // A budget's funds drop: deleted, lowered, or moved to another budget.
  assert.deepEqual(incomeChangeAlertScope(income(1_000, { budgetId: "casa" }), undefined, OCTOBER, options), { monthlyIncome: false, fundsBudgetId: "casa" });
  assert.deepEqual(incomeChangeAlertScope(income(1_000, { budgetId: "casa" }), income(1_000), OCTOBER, options), { monthlyIncome: false, fundsBudgetId: "casa" });
  assert.deepEqual(incomeChangeAlertScope(income(1_000, { budgetId: "casa" }), income(900, { budgetId: "casa" }), OCTOBER, options), { monthlyIncome: false, fundsBudgetId: "casa" });
  // Raising income, a new income, an income of another month or an expense never re-checks.
  assert.equal(incomeChangeAlertScope(undefined, income(1_000), OCTOBER, options), null);
  assert.equal(incomeChangeAlertScope(income(1_000), income(2_000), OCTOBER, options), null);
  assert.equal(incomeChangeAlertScope(income(1_000, { date: new Date("2026-09-02T17:00:00.000Z") }), undefined, OCTOBER, options), null);
  assert.equal(incomeChangeAlertScope(income(1_000), income(1_000, { description: "renamed" }), OCTOBER, options), null);
  assert.equal(incomeChangeAlertScope(expense(10), undefined, OCTOBER, options), null);
});
