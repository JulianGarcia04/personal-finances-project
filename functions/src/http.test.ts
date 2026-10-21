import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_SERVER_ERROR,
  HttpError,
  apiKeyBodySchema,
  cardBillingOf,
  chatBodySchema,
  expenseAmountForMonth,
  expensePeriod,
  parseBody,
  parseStatementBodySchema,
  paymentMonthIndex,
  storedDateValue,
  timeZoneForCountry,
  verifyBearerToken,
  zonedDateKey,
  zonedYearMonth
} from "./http";

const authError = (code: string) => Object.assign(new Error(code), { code });

test("verifyBearerToken rejects a missing or malformed header with 401", async () => {
  const verify = async () => ({ uid: "u1" });
  for (const header of [undefined, "", "Basic abc", "Bearer "]) {
    await assert.rejects(verifyBearerToken(header, verify), (err: unknown) => {
      return err instanceof HttpError && err.status === 401;
    });
  }
});

test("verifyBearerToken maps invalid, expired and revoked tokens to 401", async () => {
  for (const code of ["auth/argument-error", "auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token", "auth/user-disabled"]) {
    await assert.rejects(
      verifyBearerToken("Bearer bad", async () => { throw authError(code); }),
      (err: unknown) => err instanceof HttpError && err.status === 401
    );
  }
});

test("verifyBearerToken rethrows unexpected verification failures untouched", async () => {
  const failure = authError("auth/internal-error");
  await assert.rejects(verifyBearerToken("Bearer t", async () => { throw failure; }), (err) => err === failure);
});

test("verifyBearerToken returns the uid of a valid token", async () => {
  assert.equal(await verifyBearerToken("Bearer good", async (token) => ({ uid: `uid-${token}` })), "uid-good");
});

test("HttpError keeps its status and the generic message is Spanish", () => {
  assert.equal(new HttpError(400, "x").status, 400);
  assert.match(GENERIC_SERVER_ERROR, /error interno/i);
});

test("chatBodySchema rejects empty, oversized and badly shaped histories with 400", () => {
  const bad = [
    {},
    { messages: [] },
    { messages: "hola" },
    { messages: [{ role: "user", content: 1 }] },
    { messages: [{ role: "system", content: "hola" }] },
    { messages: [{ role: "user", content: "hola" }, { role: "assistant", content: "hey" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "x".repeat(4001) }] },
    { messages: Array.from({ length: 51 }, () => ({ role: "user", content: "hola" })) }
  ];
  for (const body of bad) {
    assert.throws(() => parseBody(chatBodySchema, body), (err: unknown) => err instanceof HttpError && err.status === 400, JSON.stringify(body).slice(0, 80));
  }
});

test("chatBodySchema accepts the frontend shape and normalizes roles", () => {
  const body = parseBody(chatBodySchema, {
    messages: [
      { role: "user", content: "hola" },
      { role: "assistant", content: "x".repeat(8000) },
      { role: "user", content: "¿cuánto gasté?" }
    ],
    useDefaultKey: true
  });
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "model", "user"]);
  assert.equal(body.useDefaultKey, true);
});

test("apiKeyBodySchema trims and bounds the key", () => {
  assert.equal(parseBody(apiKeyBodySchema, { apiKey: "  AIzaSyAbcdef123  " }).apiKey, "AIzaSyAbcdef123");
  for (const apiKey of [undefined, 123, { a: 1 }, "short", "x".repeat(201)]) {
    assert.throws(() => parseBody(apiKeyBodySchema, { apiKey }), (err: unknown) => err instanceof HttpError && err.status === 400);
  }
});

test("parseStatementBodySchema requires text or pdfBase64 strings", () => {
  assert.equal(parseBody(parseStatementBodySchema, { text: "linea", useDefaultKey: false }).text, "linea");
  assert.ok(parseBody(parseStatementBodySchema, { pdfBase64: "JVBERi0=" }).pdfBase64);
  for (const body of [{}, { text: "  " }, { text: 5 }, { pdfBase64: ["a"] }, { text: "a", useDefaultKey: "yes" }, null]) {
    assert.throws(() => parseBody(parseStatementBodySchema, body), (err: unknown) => err instanceof HttpError && err.status === 400);
  }
});

test("timeZoneForCountry maps known countries and falls back to Bogota", () => {
  assert.equal(timeZoneForCountry("CO"), "America/Bogota");
  assert.equal(timeZoneForCountry("ES"), "Europe/Madrid");
  assert.equal(timeZoneForCountry(undefined), "America/Bogota");
  assert.equal(timeZoneForCountry("ZZ"), "America/Bogota");
});

test("zonedYearMonth buckets by the user's local month, not UTC", () => {
  // 2026-03-01T03:00Z is still February 28 in Bogota (UTC-5).
  assert.deepEqual(zonedYearMonth(new Date("2026-03-01T03:00:00Z"), "America/Bogota"), { year: 2026, month: 1 });
  assert.deepEqual(zonedYearMonth(new Date("2026-03-01T03:00:00Z"), "Europe/Madrid"), { year: 2026, month: 2 });
});

test("expensePeriod starts at local midnight of the first analysed month", () => {
  const period = expensePeriod(new Date("2026-10-11T12:00:00Z"), 3, "America/Bogota");
  assert.equal(period.start.toISOString(), "2026-08-01T05:00:00.000Z");
  assert.deepEqual(period.months, [
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
    { year: 2026, month: 9 }
  ]);
  const madrid = expensePeriod(new Date("2026-01-15T12:00:00Z"), 2, "Europe/Madrid");
  assert.equal(madrid.start.toISOString(), "2025-11-30T23:00:00.000Z");
  assert.deepEqual(madrid.months, [{ year: 2025, month: 11 }, { year: 2026, month: 0 }]);
});

test("storedDateValue reads Timestamps unchanged and legacy date-only strings as local noon", () => {
  const instant = new Date("2026-10-15T02:00:00.000Z");
  assert.equal(storedDateValue({ toDate: () => instant }, "America/Bogota"), instant);
  assert.equal(storedDateValue("2026-10-01", "America/Bogota").toISOString(), "2026-10-01T17:00:00.000Z");
  assert.equal(zonedDateKey(storedDateValue("2027-01-01", "Europe/Madrid"), "Europe/Madrid"), "2027-01-01");
});

test("storedDateValue keeps the standard parsing for other values", () => {
  assert.equal(storedDateValue("2026-10-10T12:00:00.000Z", "America/Bogota").toISOString(), "2026-10-10T12:00:00.000Z");
  assert.equal(storedDateValue(Date.UTC(2026, 9, 10), "America/Bogota").toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(storedDateValue("2026-02-30", "America/Bogota").getTime(), new Date("2026-02-30").getTime());
});

test("expenseAmountForMonth reads a legacy date-only string as that local calendar day", () => {
  const legacy = { type: "expense", amount: -90, date: "2026-10-01" };
  assert.equal(expenseAmountForMonth(legacy, 2026, 9, "America/Bogota"), 90);
  assert.equal(expenseAmountForMonth(legacy, 2026, 8, "America/Bogota"), 0);
});

test("expenseAmountForMonth uses the zoned month and spreads installments", () => {
  const lateNight = { type: "expense", amount: -90, date: new Date("2026-03-01T03:00:00Z") };
  assert.equal(expenseAmountForMonth(lateNight, 2026, 1, "America/Bogota"), 90);
  assert.equal(expenseAmountForMonth(lateNight, 2026, 2, "America/Bogota"), 0);
  const split = { type: "expense", amount: -100, installments: 3, date: new Date("2026-01-10T15:00:00Z") };
  assert.equal(expenseAmountForMonth(split, 2026, 0, "America/Bogota"), 33.34);
  assert.equal(expenseAmountForMonth(split, 2026, 2, "America/Bogota"), 33.33);
  assert.equal(expenseAmountForMonth(split, 2026, 3, "America/Bogota"), 0);
  assert.equal(expenseAmountForMonth({ ...split, type: "income" }, 2026, 0, "America/Bogota"), 0);
});

// --- Credit-card payment months (port of src/lib/installments.ts) ---

const BOGOTA = "America/Bogota";
// Local noon in Bogotá (UTC-5) of the given calendar day.
const bogotaNoon = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day, 17));
const sharesFrom = (data: Record<string, any>, billing: { statementClosingDay: number; paymentDueDay: number } | null, year: number, month: number, count: number) =>
  Array.from({ length: count }, (_, offset) => {
    const index = year * 12 + month + offset;
    return expenseAmountForMonth(data, Math.floor(index / 12), index % 12, BOGOTA, billing);
  });

test("expenseAmountForMonth: closing 25, due 10, 28 Sep at 3 installments is paid in Nov, Dec and Jan", () => {
  const purchase = { type: "expense", amount: -300_000, installments: 3, date: bogotaNoon(2026, 8, 28) };
  assert.deepEqual(sharesFrom(purchase, { statementClosingDay: 25, paymentDueDay: 10 }, 2026, 8, 6), [0, 0, 100_000, 100_000, 100_000, 0]);
});

test("expenseAmountForMonth: closing 25, due 10, 20 Sep at 3 installments is paid in Oct, Nov and Dec", () => {
  const purchase = { type: "expense", amount: -300_000, installments: 3, date: bogotaNoon(2026, 8, 20) };
  assert.deepEqual(sharesFrom(purchase, { statementClosingDay: 25, paymentDueDay: 10 }, 2026, 8, 5), [0, 100_000, 100_000, 100_000, 0]);
});

test("expenseAmountForMonth: closing 5, due 20, 28 Sep at 3 installments is paid in Oct, Nov and Dec", () => {
  const purchase = { type: "expense", amount: -300_000, installments: 3, date: bogotaNoon(2026, 8, 28) };
  assert.deepEqual(sharesFrom(purchase, { statementClosingDay: 5, paymentDueDay: 20 }, 2026, 8, 5), [0, 100_000, 100_000, 100_000, 0]);
});

test("expenseAmountForMonth: closing 25, due 10, a single-installment purchase on 28 Sep is paid in Nov", () => {
  const purchase = { type: "expense", amount: -300_000, date: bogotaNoon(2026, 8, 28) };
  assert.deepEqual(sharesFrom(purchase, { statementClosingDay: 25, paymentDueDay: 10 }, 2026, 8, 4), [0, 0, 300_000, 0]);
  // Without billing days the same purchase keeps its calendar month.
  assert.deepEqual(sharesFrom(purchase, null, 2026, 8, 4), [300_000, 0, 0, 0]);
});

test("expenseAmountForMonth reads the closing day in the user's time zone", () => {
  // 26 Sep 03:00 UTC is still 25 Sep (the closing day) in Bogotá: paid in Oct, not Nov.
  const lateNight = { type: "expense", amount: -50, date: new Date("2026-09-26T03:00:00Z") };
  assert.deepEqual(sharesFrom(lateNight, { statementClosingDay: 25, paymentDueDay: 10 }, 2026, 8, 3), [0, 50, 0]);
});

test("expenseAmountForMonth crosses the December to January boundary for card payments", () => {
  const purchase = { type: "expense", amount: -70, installments: 2, date: bogotaNoon(2026, 11, 28) };
  assert.deepEqual(sharesFrom(purchase, { statementClosingDay: 25, paymentDueDay: 10 }, 2026, 11, 4), [0, 0, 35, 35]);
});

test("paymentMonthIndex adds a month unless the due day comes after the closing day", () => {
  const index = (year: number, month: number) => year * 12 + month;
  assert.equal(paymentMonthIndex(2026, 8, 25, { statementClosingDay: 25, paymentDueDay: 10 }), index(2026, 9));
  assert.equal(paymentMonthIndex(2026, 8, 26, { statementClosingDay: 25, paymentDueDay: 10 }), index(2026, 10));
  assert.equal(paymentMonthIndex(2026, 9, 5, { statementClosingDay: 5, paymentDueDay: 20 }), index(2026, 9));
  assert.equal(paymentMonthIndex(2026, 8, 15, { statementClosingDay: 15, paymentDueDay: 15 }), index(2026, 9));
  // Closing 30, due 31: February's statement (closing and due clamped to the 28th) is paid in February.
  assert.equal(paymentMonthIndex(2026, 1, 10, { statementClosingDay: 30, paymentDueDay: 31 }), index(2026, 1));
});

test("cardBillingOf only returns billing days for regular credit cards with both days set", () => {
  const visa = { type: "credit", statementClosingDay: 25, paymentDueDay: 10 };
  assert.deepEqual(cardBillingOf(visa), { statementClosingDay: 25, paymentDueDay: 10 });
  assert.equal(cardBillingOf({ ...visa, type: "checking" }), null);
  assert.equal(cardBillingOf({ ...visa, paymentDueDay: null }), null);
  assert.equal(cardBillingOf({ ...visa, statementClosingDay: 0 }), null);
  assert.equal(cardBillingOf({ ...visa, paymentDueDay: 32 }), null);
  assert.equal(cardBillingOf({ ...visa, mirror: { workspaceId: "w", accountId: "a", sourceAccountId: "s" } }), null);
  assert.equal(cardBillingOf(undefined), null);
});
