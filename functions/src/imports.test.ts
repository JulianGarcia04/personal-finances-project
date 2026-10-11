import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import {
  IMPORT_SERVER_ERROR,
  ImportRejection,
  MAX_STATEMENT_ROWS,
  pocketStatementRequestSchema,
  statementImportIdSchema,
  statementImportMarkerId,
  statementRequestHash,
  toImportHttpsError
} from "./pocketImports";

const row = { date: "2026-10-10T12:00:00.000Z", description: "Row", amount: -5, categoryId: "" };
const base = {
  workspaceId: "ws-1",
  accountId: "acc-1",
  expectedCurrency: "COP",
  statementImportId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  rows: [row]
};

test("statementImportId accepts UUIDs and safe tokens of 8-128 chars", () => {
  assert.equal(statementImportIdSchema.safeParse(base.statementImportId).success, true);
  assert.equal(statementImportIdSchema.safeParse("abc_DEF-12").success, true);
  assert.equal(statementImportIdSchema.safeParse("a".repeat(128)).success, true);
});

test("statementImportId rejects short, long, non-string and unsafe values", () => {
  for (const value of ["short", "a".repeat(129), 12345678, null, "has space here", "slash/inside", "dots.....", ""]) {
    assert.equal(statementImportIdSchema.safeParse(value).success, false, `accepted ${String(value)}`);
  }
});

test("request schema requires a statementImportId", () => {
  assert.equal(pocketStatementRequestSchema.safeParse(base).success, true);
  const { statementImportId: _omit, ...withoutId } = base;
  assert.equal(pocketStatementRequestSchema.safeParse(withoutId).success, false);
});

test("request schema caps the number of rows", () => {
  const atCap = { ...base, rows: Array.from({ length: MAX_STATEMENT_ROWS }, () => row) };
  const overCap = { ...base, rows: Array.from({ length: MAX_STATEMENT_ROWS + 1 }, () => row) };
  assert.equal(pocketStatementRequestSchema.safeParse(atCap).success, true);
  assert.equal(pocketStatementRequestSchema.safeParse(overCap).success, false);
});

test("marker id scopes the import id by workspace", () => {
  assert.equal(statementImportMarkerId("ws-1", "abcdefgh"), "ws-1_abcdefgh");
  assert.notEqual(statementImportMarkerId("ws-1", "abcdefgh"), statementImportMarkerId("ws-2", "abcdefgh"));
});

test("request hash is stable for identical payloads and changes with content", () => {
  const parsed = pocketStatementRequestSchema.parse(base);
  assert.equal(statementRequestHash(parsed), statementRequestHash(pocketStatementRequestSchema.parse({ ...base })));
  assert.notEqual(statementRequestHash(parsed), statementRequestHash({ ...parsed, accountId: "acc-2" }));
  assert.notEqual(
    statementRequestHash(parsed),
    statementRequestHash({ ...parsed, rows: [{ ...row, amount: -6 }] })
  );
  // The import id itself is the lookup key, not part of the fingerprint.
  assert.equal(statementRequestHash(parsed), statementRequestHash({ ...parsed, statementImportId: "other-id-123" }));
});

test("HttpsError passes through unchanged", () => {
  const original = new HttpsError("permission-denied", "No");
  assert.equal(toImportHttpsError(original), original);
});

test("domain rejections map to failed-precondition with their message", () => {
  const mapped = toImportHttpsError(new ImportRejection("El saldo disponible no puede ser negativo."));
  assert.equal(mapped.code, "failed-precondition");
  assert.equal(mapped.message, "El saldo disponible no puede ser negativo.");
});

test("transient Firestore errors map to aborted or unavailable", () => {
  const withCode = (code: number | string) => Object.assign(new Error("raw firestore detail"), { code });
  assert.equal(toImportHttpsError(withCode(10)).code, "aborted");
  assert.equal(toImportHttpsError(withCode("aborted")).code, "aborted");
  assert.equal(toImportHttpsError(withCode(14)).code, "unavailable");
  assert.equal(toImportHttpsError(withCode(4)).code, "unavailable");
  assert.equal(toImportHttpsError(withCode(8)).code, "unavailable");
  assert.doesNotMatch(toImportHttpsError(withCode(10)).message, /raw firestore detail/);
});

test("Firestore invalid-argument maps to invalid-argument without leaking details", () => {
  const mapped = toImportHttpsError(Object.assign(new Error("Document exceeds 1048576 bytes"), { code: 3 }));
  assert.equal(mapped.code, "invalid-argument");
  assert.doesNotMatch(mapped.message, /1048576/);
});

test("unexpected errors map to a generic internal error", () => {
  const mapped = toImportHttpsError(new Error("secret stack detail"));
  assert.equal(mapped.code, "internal");
  assert.equal(mapped.message, IMPORT_SERVER_ERROR);
  assert.equal(toImportHttpsError("weird").code, "internal");
});
