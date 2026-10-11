import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AgentToolError,
  buildAgentContextBlock,
  buildDateContext,
  GENERIC_TOOL_ERROR,
  localDayRange,
  parseLocalDate,
  relaxJsonSchema,
  safeTool,
  signedAmount,
  toLeanTransaction
} from "./agentTools";
import { HttpError, zonedDateKey } from "./http";

const BOGOTA = "America/Bogota";
const MADRID = "Europe/Madrid";

test("parseLocalDate maps a date-only string to local noon in the user's time zone", () => {
  assert.equal(parseLocalDate("2026-10-01", BOGOTA).toISOString(), "2026-10-01T17:00:00.000Z");
  assert.equal(parseLocalDate("2026-07-15", MADRID).toISOString(), "2026-07-15T10:00:00.000Z");
  // The stored instant always reads back as the same local calendar day.
  assert.equal(zonedDateKey(parseLocalDate("2026-03-01", BOGOTA), BOGOTA), "2026-03-01");
});

test("parseLocalDate rejects relative words, impossible dates and other formats", () => {
  for (const value of ["hoy", "2026-02-30", "2026-13-01", "01/10/2026", "2026-10-01T10:00:00Z", ""]) {
    assert.throws(() => parseLocalDate(value, BOGOTA), AgentToolError, value);
  }
});

test("localDayRange returns inclusive local day bounds as [start, endExclusive)", () => {
  const range = localDayRange("2026-10-01", "2026-10-31", BOGOTA);
  assert.equal(range.start?.toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(range.endExclusive?.toISOString(), "2026-11-01T05:00:00.000Z");
  assert.deepEqual(localDayRange(undefined, undefined, BOGOTA), { start: null, endExclusive: null });
  assert.throws(() => localDayRange("2026-10-31", "2026-10-01", BOGOTA), AgentToolError);
});

test("signedAmount applies the sign from the movement type and tolerates signed input", () => {
  assert.equal(signedAmount(50000, "expense"), -50000);
  assert.equal(signedAmount(-50000, "expense"), -50000);
  assert.equal(signedAmount(200, "loan"), -200);
  assert.equal(signedAmount(-1200, "income"), 1200);
  assert.equal(signedAmount(300, "loan_payment"), 300);
  assert.equal(signedAmount(-75, "transfer"), 75);
  for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => signedAmount(bad, "expense"), AgentToolError);
  }
});

test("buildDateContext resolves relative periods in the user's local calendar", () => {
  // 2026-10-11T03:00Z is Saturday 2026-10-10 22:00 in Bogota.
  const ctx = buildDateContext(new Date("2026-10-11T03:00:00Z"), BOGOTA);
  assert.equal(ctx.today, "2026-10-10");
  assert.equal(ctx.weekday, "sábado");
  assert.equal(ctx.yesterday, "2026-10-09");
  assert.deepEqual(ctx.thisWeek, { start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(ctx.thisMonth, { start: "2026-10-01", end: "2026-10-31" });
  assert.equal(ctx.monthName, "octubre de 2026");
  assert.deepEqual(ctx.lastMonth, { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(ctx.thisYear, { start: "2026-01-01", end: "2026-12-31" });
});

test("buildDateContext handles year and week boundaries", () => {
  const monday = buildDateContext(new Date("2026-01-05T15:00:00Z"), BOGOTA);
  assert.equal(monday.weekday, "lunes");
  assert.deepEqual(monday.thisWeek, { start: "2026-01-05", end: "2026-01-11" });
  assert.deepEqual(monday.lastMonth, { start: "2025-12-01", end: "2025-12-31" });

  const sunday = buildDateContext(new Date("2026-03-01T15:00:00Z"), BOGOTA);
  assert.equal(sunday.weekday, "domingo");
  assert.deepEqual(sunday.thisWeek, { start: "2026-02-23", end: "2026-03-01" });
  assert.deepEqual(sunday.lastMonth, { start: "2026-02-01", end: "2026-02-28" });
  assert.equal(sunday.yesterday, "2026-02-28");
});

test("buildAgentContextBlock states date, time zone, currency and sign conventions", () => {
  const block = buildAgentContextBlock({ now: new Date("2026-10-11T03:00:00Z"), timeZone: BOGOTA, currency: "COP" });
  for (const fragment of ["2026-10-10", "sábado", BOGOTA, "COP", "octubre de 2026", "2026-10-05", "2026-09-01", "negativ", "positiv"]) {
    assert.ok(block.includes(fragment), `missing ${fragment}`);
  }
});

test("toLeanTransaction returns only named, local-dated fields", () => {
  const names = {
    accounts: new Map([["a1", "Nu"], ["a2", "Ahorros"]]),
    categories: new Map([["c1", "Comida"]])
  };
  const date = { toDate: () => new Date("2026-10-01T03:00:00Z") };
  const expense = toLeanTransaction("t1", {
    accountId: "a1", amount: -90000, description: "Mercado", type: "expense", categoryId: "c1",
    currency: "COP", date, installments: 3, workspaceId: "w1", userId: "u1", notes: "x", receiptUrl: "y"
  }, names, BOGOTA);
  assert.deepEqual(expense, {
    id: "t1", date: "2026-09-30", description: "Mercado", type: "expense", amount: -90000, currency: "COP",
    categoryName: "Comida", accountName: "Nu", installments: 3, installmentAmount: -30000
  });

  const transfer = toLeanTransaction("t2", {
    accountId: "a1", toAccountId: "a2", amount: 100, description: "Ahorro", type: "transfer", categoryId: "",
    currency: "COP", date, installments: 1
  }, names, BOGOTA);
  assert.deepEqual(transfer, {
    id: "t2", date: "2026-09-30", description: "Ahorro", type: "transfer", amount: 100, currency: "COP",
    categoryName: null, accountName: "Nu", toAccountName: "Ahorros"
  });
});

test("safeTool returns domain errors to the model instead of throwing", async () => {
  const schema = z.object({ installments: z.number().int().min(1).max(60) });
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const ok = safeTool("t", schema, async ({ installments }) => ({ installments }));
    assert.deepEqual(await ok({ installments: 3 }), { installments: 3 });

    const invalid = await ok({ installments: 99 });
    assert.ok("error" in invalid && /installments/.test(invalid.error));

    const domain = safeTool("t", schema, async () => { throw new AgentToolError("La cuenta no existe."); });
    assert.deepEqual(await domain({ installments: 1 }), { error: "La cuenta no existe." });

    const plain = safeTool("t", schema, async () => { throw new Error("La transacción no existe."); });
    assert.deepEqual(await plain({ installments: 1 }), { error: "La transacción no existe." });

    const infra = safeTool("t", schema, async () => { throw Object.assign(new Error("9 FAILED_PRECONDITION: index https://..."), { code: 9 }); });
    assert.deepEqual(await infra({ installments: 1 }), { error: GENERIC_TOOL_ERROR });

    const bug = safeTool("t", schema, async () => { throw new TypeError("Cannot read properties of undefined"); });
    assert.deepEqual(await bug({ installments: 1 }), { error: GENERIC_TOOL_ERROR });
    assert.ok(logged.length >= 4);
  } finally {
    console.error = originalError;
  }
});

test("safeTool keeps throwing auth and permission errors", async () => {
  const schema = z.object({});
  const http = safeTool("t", schema, async () => { throw new HttpError(403, "No."); });
  await assert.rejects(http({}), (err: unknown) => err instanceof HttpError && err.status === 403);

  const denied = safeTool("t", schema, async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); });
  await assert.rejects(denied({}), (err: unknown) => err instanceof HttpError && err.status === 403);

  const notMember = safeTool("t", schema, async () => { throw new Error("El usuario no pertenece al workspace activo."); });
  await assert.rejects(notMember({}), (err: unknown) => err instanceof HttpError && err.status === 403);
});

test("relaxJsonSchema keeps types, enums, required and descriptions but drops bounds", () => {
  const relaxed = relaxJsonSchema({
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: {
      amount: { type: "number", exclusiveMinimum: 0, description: "Monto" },
      installments: { type: "integer", minimum: 1, maximum: 60 },
      type: { type: "string", enum: ["income", "expense"], minLength: 1 },
      items: { type: "array", minItems: 1, items: { type: "object", properties: { v: { type: "number", maximum: 3 } } } }
    }
  });
  assert.deepEqual(relaxed, {
    type: "object",
    required: ["amount"],
    properties: {
      amount: { type: "number", description: "Monto" },
      installments: { type: "integer" },
      type: { type: "string", enum: ["income", "expense"] },
      items: { type: "array", items: { type: "object", properties: { v: { type: "number" } } } }
    }
  });
});
