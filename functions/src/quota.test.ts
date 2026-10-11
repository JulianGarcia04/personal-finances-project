import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "./http";
import {
  assertStatementSize,
  base64DecodedBytes,
  dailyLimit,
  MAX_STATEMENT_PDF_BYTES,
  MAX_STATEMENT_TEXT_CHARS,
  nextQuotaCount,
  parseDailyLimit,
  quotaDateKey,
  quotaDocId
} from "./quota";

test("quotaDateKey buckets by the America/Bogota calendar day", () => {
  // 2026-10-12T03:00Z is still 2026-10-11 22:00 in Bogota (UTC-5).
  assert.equal(quotaDateKey(new Date("2026-10-12T03:00:00Z")), "2026-10-11");
  assert.equal(quotaDateKey(new Date("2026-10-12T05:00:00Z")), "2026-10-12");
  assert.equal(quotaDocId("uid-1", "2026-10-11"), "uid-1_2026-10-11");
});

test("parseDailyLimit accepts non-negative integers and falls back otherwise", () => {
  assert.equal(parseDailyLimit(undefined, 50), 50);
  assert.equal(parseDailyLimit("", 50), 50);
  assert.equal(parseDailyLimit("abc", 50), 50);
  assert.equal(parseDailyLimit("-3", 50), 50);
  assert.equal(parseDailyLimit("2.5", 50), 50);
  assert.equal(parseDailyLimit(" 25 ", 50), 25);
  assert.equal(parseDailyLimit("0", 50), 0);
});

test("dailyLimit uses documented defaults and env overrides", () => {
  assert.equal(dailyLimit("chat", {}), 50);
  assert.equal(dailyLimit("parse", {}), 10);
  assert.equal(dailyLimit("chat", { DEFAULT_KEY_DAILY_CHAT_LIMIT: "5" }), 5);
  assert.equal(dailyLimit("parse", { DEFAULT_KEY_DAILY_PARSE_LIMIT: "3" }), 3);
});

test("nextQuotaCount increments until the limit and then returns 429", () => {
  assert.equal(nextQuotaCount(undefined, "chat", 2), 1);
  assert.equal(nextQuotaCount(1, "chat", 2), 2);
  assert.throws(() => nextQuotaCount(2, "chat", 2), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 429);
    assert.match(error.message, /Configuración/);
    return true;
  });
  assert.throws(() => nextQuotaCount(0, "parse", 0), (error: unknown) => error instanceof HttpError && error.status === 429);
});

test("base64DecodedBytes measures the decoded payload, ignoring data URL prefix and padding", () => {
  assert.equal(base64DecodedBytes(Buffer.from("hello").toString("base64")), 5);
  assert.equal(base64DecodedBytes(`data:application/pdf;base64,${Buffer.from("hello!").toString("base64")}`), 6);
  assert.equal(base64DecodedBytes(""), 0);
});

test("assertStatementSize enforces PDF and text caps with 413", () => {
  const is413 = (error: unknown) => error instanceof HttpError && error.status === 413;
  assertStatementSize({ text: "x".repeat(MAX_STATEMENT_TEXT_CHARS) });
  assert.throws(() => assertStatementSize({ text: "x".repeat(MAX_STATEMENT_TEXT_CHARS + 1) }), is413);
  const maxPdf = "A".repeat(Math.floor(MAX_STATEMENT_PDF_BYTES / 3) * 4);
  assertStatementSize({ pdfBase64: maxPdf });
  assert.throws(() => assertStatementSize({ pdfBase64: `${maxPdf}AAAA` }), is413);
});
