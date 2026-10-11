import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLegacyMovement, legacyDeltas } from "./pockets";

const cop = { currency: "COP" };
const usd = { currency: "USD" };

test("legacy transfers require a distinct same-currency destination and a positive amount", () => {
  const transfer = { accountId: "a", toAccountId: "b", amount: 10, type: "transfer" };
  assert.doesNotThrow(() => assertLegacyMovement(transfer, cop, cop));
  assert.throws(() => assertLegacyMovement({ ...transfer, toAccountId: null }, cop, undefined), /cuenta destino/);
  assert.throws(() => assertLegacyMovement({ ...transfer, toAccountId: "a" }, cop, cop), /distintas/);
  assert.throws(() => assertLegacyMovement(transfer, cop, usd), /misma moneda/);
  assert.throws(() => assertLegacyMovement(transfer, {}, {}), /misma moneda/);
  assert.throws(() => assertLegacyMovement({ ...transfer, amount: -10 }, cop, cop), /positivo/);
  assert.throws(() => assertLegacyMovement({ ...transfer, amount: 0 }, cop, cop), /monto/);
});

test("legacy cashflows keep the signed-amount convention of the app", () => {
  for (const type of ["income", "loan_payment"]) {
    assert.doesNotThrow(() => assertLegacyMovement({ accountId: "a", amount: 5, type }, cop));
    assert.throws(() => assertLegacyMovement({ accountId: "a", amount: -5, type }, cop), /positivo/);
  }
  for (const type of ["expense", "loan"]) {
    assert.doesNotThrow(() => assertLegacyMovement({ accountId: "a", amount: -5, type }, cop));
    assert.throws(() => assertLegacyMovement({ accountId: "a", amount: 5, type }, cop), /negativo/);
  }
  assert.throws(() => assertLegacyMovement({ accountId: "a", amount: Number.NaN, type: "income" }, cop), /monto/);
  assert.throws(() => assertLegacyMovement({ accountId: "a", amount: 5, type: "gift" }, cop), /tipo/);
});

test("legacy deltas accumulate per account instead of overwriting", () => {
  assert.deepEqual(legacyDeltas({ accountId: "a", toAccountId: "a", amount: 10, type: "transfer" }, 1), { a: 0 });
  assert.deepEqual(legacyDeltas({ accountId: "a", toAccountId: "b", amount: 10, type: "transfer" }, -1), { a: 10, b: -10 });
  assert.deepEqual(legacyDeltas({ accountId: "a", amount: -3, type: "expense" }, 1), { a: -3 });
});
