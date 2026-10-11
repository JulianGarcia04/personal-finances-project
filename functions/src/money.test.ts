import { test } from "node:test";
import assert from "node:assert/strict";
import { roundMoney } from "./money";

test("roundMoney removes binary float drift from sums", () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(100.1 - 100), 0.1);
  assert.equal(roundMoney(1_000_000.07 + 0.01), 1_000_000.08);
});

test("roundMoney rounds half away from zero symmetrically", () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(-1.005), -1.01);
  assert.equal(roundMoney(2.344), 2.34);
  assert.equal(roundMoney(-2.344), -2.34);
});

test("roundMoney never returns negative zero and keeps non-finite values", () => {
  assert.ok(Object.is(roundMoney(-0.001), 0));
  assert.ok(Object.is(roundMoney(-0), 0));
  assert.ok(Number.isNaN(roundMoney(Number.NaN)));
  assert.equal(roundMoney(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});
