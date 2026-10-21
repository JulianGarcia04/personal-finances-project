import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertCategoryFor,
  budgetAlertLedgerId,
  budgetForCategory,
  capInReportingCurrency,
  categorySpendForScope,
  countsTowardScopeTotal,
  defaultBudgetUsage,
  scopeTotalSpend,
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

test("default budget usage mirrors the dashboard: capped spend over the sum of positive caps", () => {
  const txs = [
    expense(150),
    expense(20, { categoryId: "fun" }),
    expense(999, { categoryId: "uncapped" }),
    expense(999, { budgetId: "hogar" })
  ];
  const caps = { food: 100, fun: 50, zero: 0 };
  assert.deepEqual(defaultBudgetUsage(txs, caps, "COP", OCTOBER, COP_OPTIONS), { spent: 120, limit: 150 });
});

test("default budget usage is unknown without confirmed cap units, positive caps or rates", () => {
  const txs = [expense(150), expense(5, { categoryId: "fun", currency: "USD" })];
  assert.equal(defaultBudgetUsage(txs, { food: 100 }, null, OCTOBER, COP_OPTIONS), null);
  assert.equal(defaultBudgetUsage(txs, { food: 0 }, "COP", OCTOBER, COP_OPTIONS), null);
  assert.equal(defaultBudgetUsage(txs, { food: 100, fun: 50 }, "COP", OCTOBER, COP_OPTIONS), null);
  assert.equal(defaultBudgetUsage(txs, { food: 100 }, "USD", OCTOBER, COP_OPTIONS), null);
});

test("countsTowardScopeTotal only accepts expenses of the scope with a share in the period", () => {
  const options = { timeZone: BOGOTA };
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "hogar", categoryId: undefined }), HOGAR, OCTOBER, options), true);
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "otro" }), HOGAR, OCTOBER, options), false);
  assert.equal(countsTowardScopeTotal(expense(10, { budgetId: "hogar", date: new Date("2026-09-10T17:00:00.000Z") }), HOGAR, OCTOBER, options), false);
  assert.equal(countsTowardScopeTotal(undefined, HOGAR, OCTOBER, options), false);
  // Default budget: only categories with a positive cap feed the dashboard total.
  const caps = { food: 100 };
  assert.equal(countsTowardScopeTotal(expense(10), DEFAULT_SCOPE, OCTOBER, { ...options, cappedCategories: caps }), true);
  assert.equal(countsTowardScopeTotal(expense(10, { categoryId: "fun" }), DEFAULT_SCOPE, OCTOBER, { ...options, cappedCategories: caps }), false);
});

test("total alerts use their own ledger slot", () => {
  assert.equal(budgetAlertLedgerId("ws", "default-monthly", "2026-10", TOTAL_ALERT_SUBJECT), "ws_2026-10___total");
  assert.equal(budgetAlertLedgerId("ws", "hogar", "event", TOTAL_ALERT_SUBJECT), "ws_hogar_event___total");
});
