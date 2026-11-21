import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedDateKey } from "./http";
import {
  ImportRejection,
  pocketStatementRequestSchema,
  statementImportMarkerId,
  statementImportReceipt,
  statementRequestHash,
  statementRowDate
} from "./pocketImports";

const BOGOTA = "America/Bogota";

test("a date-only statement row stays on its calendar day in the user's time zone", () => {
  const date = statementRowDate("2026-10-01", BOGOTA);

  assert.equal(zonedDateKey(date, BOGOTA), "2026-10-01");
  assert.equal(date.toISOString(), "2026-10-01T17:00:00.000Z");
});

test("date-only statement rows keep month-end and year boundaries", () => {
  assert.equal(zonedDateKey(statementRowDate("2026-10-31", BOGOTA), BOGOTA), "2026-10-31");
  assert.equal(zonedDateKey(statementRowDate("2026-12-31", BOGOTA), BOGOTA), "2026-12-31");
  assert.equal(zonedDateKey(statementRowDate("2027-01-01", "Europe/Madrid"), "Europe/Madrid"), "2027-01-01");
});

test("statement rows with a time component keep the instant sent by the client", () => {
  assert.equal(statementRowDate("2026-10-10T12:00:00.000Z", BOGOTA).toISOString(), "2026-10-10T12:00:00.000Z");
});

test("a date-only statement row that is not a real calendar day is rejected", () => {
  assert.throws(() => statementRowDate("2026-02-30", BOGOTA), ImportRejection);
});

test("keyed imports accept transfer rows and fingerprint their target, classification, and counterparty", () => {
  const request = {
    workspaceId: "workspace-1",
    accountId: "visa",
    expectedCurrency: "COP",
    statementImportId: "statement-key-123",
    rows: [{
      date: "2026-10-10",
      description: "Pago tarjeta",
      amount: 150_000,
      categoryId: "",
      type: "transfer" as const,
      counterpartyAccountId: "bank"
    }]
  };

  assert.equal(pocketStatementRequestSchema.safeParse(request).success, true);
  const fingerprint = statementRequestHash(request);
  assert.notEqual(statementRequestHash({ ...request, accountId: "another-card" }), fingerprint);
  assert.notEqual(statementRequestHash({
    ...request,
    rows: [{ ...request.rows[0], counterpartyAccountId: "another-bank" }]
  }), fingerprint);
  assert.notEqual(statementRequestHash({
    ...request,
    rows: [{ ...request.rows[0], type: "expense", counterpartyAccountId: undefined }]
  }), fingerprint);
  assert.notEqual(
    statementImportMarkerId("workspace-1", request.statementImportId),
    statementImportMarkerId("workspace-2", request.statementImportId)
  );
});

test("statement import receipts store row ids, not row payloads, so they stay small", () => {
  const description = "x".repeat(3_000);
  const transactions = Array.from({ length: 1_000 }, (_, index) => ({
    id: `tx-${index}`,
    date: "2026-10-01T17:00:00.000Z",
    amount: -1,
    type: "expense" as const,
    accountId: "bank",
    toAccountId: null,
    categoryId: "food",
    description,
    currency: "COP",
    createdAt: "2026-10-01T17:00:00.000Z"
  }));
  const receipt = statementImportReceipt({
    accountId: "bank",
    balance: 0,
    delta: -1_000,
    createdAt: "2026-10-01T17:00:00.000Z",
    balances: { bank: 0 },
    transactionIds: transactions.map(row => row.id),
    transactions
  });

  assert.equal(Object.hasOwn(receipt, "transactions"), false);
  assert.deepEqual(receipt.transactionIds, transactions.map(row => row.id));
  assert.deepEqual(receipt.balances, { bank: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 100_000);
});
