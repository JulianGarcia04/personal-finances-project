import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedDateKey } from "./http";
import { ImportRejection, statementRowDate } from "./pocketImports";

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
