import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertCategoryFor,
  budgetAlertLedgerId,
  budgetForCategory,
  categorySpendForMonth,
  evaluateBudgetThresholds,
  monthKey
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
  assert.equal(budgetAlertLedgerId("ws1", "2026-10", "food"), "ws1_2026-10_food");
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

test("category spend counts only expenses of that category in the month", () => {
  const rows = [
    expense(100),
    expense(50, { categoryId: "fun" }),
    { type: "income", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    { type: "transfer", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    { type: "loan", amount: 999, categoryId: "food", currency: "COP", date: OCTOBER_DATE() },
    expense(70, { date: new Date("2026-09-20T17:00:00.000Z") })
  ];
  assert.equal(categorySpendForMonth(rows, "food", OCTOBER, { timeZone: BOGOTA, primaryCurrency: "COP", exchangeRates: {} }), 100);
});

test("category spend uses the local month of the configured time zone", () => {
  // 2026-11-01T03:00Z is still October 31 in Bogota (UTC-5).
  const rows = [expense(40, { date: new Date("2026-11-01T03:00:00.000Z") })];
  const options = { timeZone: BOGOTA, primaryCurrency: "COP", exchangeRates: {} };
  assert.equal(categorySpendForMonth(rows, "food", OCTOBER, options), 40);
  assert.equal(categorySpendForMonth(rows, "food", { year: 2026, month: 10 }, options), 0);
});

test("category spend splits installment purchases per month", () => {
  const rows = [expense(600, { date: new Date("2026-08-10T17:00:00.000Z"), installments: 6 })];
  assert.equal(categorySpendForMonth(rows, "food", OCTOBER, { timeZone: BOGOTA, primaryCurrency: "COP", exchangeRates: {} }), 100);
});

test("category spend converts currencies with workspace rates (1:1 when missing)", () => {
  const rows = [expense(10, { currency: "USD" }), expense(5, { currency: "EUR" }), expense(1000)];
  const total = categorySpendForMonth(rows, "food", OCTOBER, {
    timeZone: BOGOTA,
    primaryCurrency: "COP",
    exchangeRates: { USD: 4000 }
  });
  assert.equal(total, 10 * 4000 + 5 + 1000);
});

test("alertCategoryFor only returns expenses with a share in the evaluated month", () => {
  const options = { timeZone: BOGOTA };
  assert.equal(alertCategoryFor(expense(10), OCTOBER, options), "food");
  assert.equal(alertCategoryFor(undefined, OCTOBER, options), null);
  assert.equal(alertCategoryFor({ ...expense(10), type: "transfer" }, OCTOBER, options), null);
  assert.equal(alertCategoryFor({ ...expense(10), type: "income" }, OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(10, { categoryId: "" }), OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(10, { date: new Date("2026-09-10T17:00:00.000Z") }), OCTOBER, options), null);
  assert.equal(alertCategoryFor(expense(0), OCTOBER, options), null);
});

function OCTOBER_DATE() {
  return new Date("2026-10-05T17:00:00.000Z");
}
