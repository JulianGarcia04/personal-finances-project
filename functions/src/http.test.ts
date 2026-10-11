import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_SERVER_ERROR,
  HttpError,
  apiKeyBodySchema,
  chatBodySchema,
  expenseAmountForMonth,
  expensePeriod,
  parseBody,
  parseStatementBodySchema,
  timeZoneForCountry,
  verifyBearerToken,
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
