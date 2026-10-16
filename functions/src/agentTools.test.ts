import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  AgentToolError,
  buildAgentContextBlock,
  buildDateContext,
  checkAgentAnswer,
  EMPTY_ANSWER_FALLBACK,
  fallbackAnswer,
  GENERIC_TOOL_ERROR,
  succeededWriteTools,
  userConfirmedPendingAction,
  localDayRange,
  parseLocalDate,
  relaxJsonSchema,
  safeTool,
  signedAmount,
  toLeanTransaction
} from "./agentTools";
import { resolvePrimaryCurrency } from "./agentContext";
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

test("buildAgentContextBlock explains that card purchases count in their statement payment month", () => {
  const block = buildAgentContextBlock({ now: new Date("2026-10-11T15:00:00-05:00"), timeZone: BOGOTA, currency: "COP" });
  assert.match(block, /tarjeta de crédito que tiene día de corte y de pago cuentan en el mes en que se paga el extracto/);
});

test("toLeanTransaction keeps a legacy date-only string on its local calendar day", () => {
  const names = { accounts: new Map([["a1", "Nu"]]), categories: new Map<string, string>() };
  const row = toLeanTransaction("t1", { accountId: "a1", amount: -5, type: "expense", date: "2026-10-01" }, names, BOGOTA);
  assert.equal(row.date, "2026-10-01");
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

test("resolvePrimaryCurrency uses the dashboard source: users.currency with a COP fallback", () => {
  assert.equal(resolvePrimaryCurrency({ currency: "USD" }), "USD");
  assert.equal(resolvePrimaryCurrency({ currency: "" }), "COP");
  assert.equal(resolvePrimaryCurrency(null), "COP");
  assert.match(buildAgentContextBlock({ now: new Date("2026-10-11T15:00:00-05:00"), timeZone: "America/Bogota", currency: "USD" }), /Moneda principal del usuario \(la del panel de control\): USD/);
});

const toolTurn = (name: string, output: unknown) => ({ role: "tool", content: [{ toolResponse: { name, output } }] });
const requestTurn = (name: string) => ({ role: "model", content: [{ toolRequest: { name, input: {} } }] });

test("succeededWriteTools lists only write tools that returned success", () => {
  const messages = [
    { role: "user", content: [{ text: "Registra un gasto" }] },
    requestTurn("listAccounts"),
    toolTurn("listAccounts", { accounts: [] }),
    toolTurn("createTransaction", { error: "El registro contiene un bolsillo inválido." }),
    toolTurn("deleteTransaction", { needsConfirmation: true, summary: {} }),
    toolTurn("createGoal", { success: true, id: "g1" }),
    { role: "model", content: [{ text: "Listo" }] }
  ];
  assert.deepEqual(succeededWriteTools(messages), ["createGoal"]);
  assert.deepEqual(succeededWriteTools([]), []);
  assert.deepEqual(succeededWriteTools(undefined), []);
});

test("checkAgentAnswer flags empty answers and retries only when nothing was written", () => {
  assert.deepEqual(checkAgentAnswer({ userText: "¿Cómo van mis metas?", text: "  \n", messages: [] }), { ok: false, reason: "empty", retryable: true, writes: [] });
  const written = [toolTurn("createTransaction", { success: true, id: "t1" })];
  // Retrying after a successful write would duplicate the movement.
  assert.deepEqual(checkAgentAnswer({ userText: "Registra 20000 en taxi", text: "", messages: written }), { ok: false, reason: "empty", retryable: false, writes: ["createTransaction"] });
});

test("checkAgentAnswer rejects a claimed action that no write tool backs", () => {
  const readOnly = [toolTurn("listAccounts", { accounts: [] }), toolTurn("listCategories", [])];
  for (const text of [
    "He registrado tu gasto de 20.000 COP en taxi.",
    "¡Listo! Registré el gasto en Efectivo.",
    "Listo, tu meta fue creada.",
    "He eliminado la transacción.",
    "He guardado los presupuestos.",
    "He actualizado el monto de tu meta.",
    "He registrado tu gasto. ¿Quieres algo más?",
    "Guardé tu meta de ahorro."
  ]) {
    assert.deepEqual(
      checkAgentAnswer({ userText: "Ayer gasté 20.000 en taxi, pagué en efectivo. Regístralo.", text, messages: readOnly }),
      { ok: false, reason: "unbacked_action", retryable: true, writes: [] },
      text
    );
  }
});

test("checkAgentAnswer accepts backed actions, questions, failures reported honestly and read-only requests", () => {
  const userText = "Registra un gasto de 20000 en taxi ayer";
  const backed = [toolTurn("createTransaction", { success: true, id: "t1" })];
  assert.deepEqual(checkAgentAnswer({ userText, text: "He registrado tu gasto.", messages: backed }), { ok: true, writes: ["createTransaction"] });
  for (const text of [
    "¿En qué cuenta lo pagaste?",
    "No pude registrar el gasto: la cuenta no existe.",
    "Encontré el gasto. ¿Confirmas que quieres eliminarlo?"
  ]) {
    assert.deepEqual(checkAgentAnswer({ userText, text, messages: [] }), { ok: true, writes: [] }, text);
  }
  // Not an action request: past-tense wording about existing data is fine.
  assert.deepEqual(
    checkAgentAnswer({ userText: "¿Cuánto gasté este mes?", text: "Este mes has registrado gastos por 500.000 COP.", messages: [] }),
    { ok: true, writes: [] }
  );
});

test("checkAgentAnswer does not treat proposals awaiting confirmation as completed actions", () => {
  const userText = "Ayúdame a crear presupuestos mensuales por categoría según mis gastos reales";
  for (const text of [
    "He creado una propuesta de presupuestos basada en tus promedios:\n\n| Categoría | Límite |\n|---|---|\n| Comida | 300.000 |",
    "Listo, aquí tienes la propuesta. ¿Quieres que guarde estos presupuestos?",
    "He preparado este plan. ¿Confirmas que lo guarde?",
    // Subjunctive "guarde" (a question) is not the preterite "guardé" (a claim).
    "He revisado tus gastos. **Te gustaría que guarde estos nuevos presupuestos?** Si es así, confirma.",
    "Si quieres, puedo hacer que registre la meta cuando confirmes."
  ]) {
    assert.deepEqual(checkAgentAnswer({ userText, text, messages: [] }), { ok: true, writes: [] }, text);
  }
});

test("fallbackAnswer never returns empty text and is honest about writes", () => {
  assert.equal(fallbackAnswer("empty", []), EMPTY_ANSWER_FALLBACK);
  assert.match(fallbackAnswer("empty", ["createTransaction"]), /se completó/);
  assert.match(fallbackAnswer("unbacked_action", []), /no se guardó ningún cambio/i);
});

test("userConfirmedPendingAction requires a confirmation request right before the user's reply", () => {
  const ask = { role: "model", content: "Encontré **Mercado Éxito**, -200.000 COP. ¿Confirmas que quieres eliminarlo?" };
  assert.equal(userConfirmedPendingAction([{ role: "user", content: "Elimina el gasto 'Mercado Éxito'" }, ask, { role: "user", content: "Sí, elimínalo" }]), true);
  assert.equal(userConfirmedPendingAction([ask, { role: "user", content: "Confirmo" }]), true);
  assert.equal(userConfirmedPendingAction([{ role: "assistant", content: "¿Quieres que guarde estos presupuestos?" }, { role: "user", content: "dale" }]), true);
  // A single request is not a confirmation, nor a reply to an unrelated answer or a refusal.
  assert.equal(userConfirmedPendingAction([{ role: "user", content: "Elimina el gasto 'Mercado Éxito' de hoy, confirmado" }]), false);
  assert.equal(userConfirmedPendingAction([{ role: "model", content: "Tu saldo es 100.000 COP." }, { role: "user", content: "Sí, elimínalo" }]), false);
  assert.equal(userConfirmedPendingAction([ask, { role: "user", content: "No, déjalo así" }]), false);
  assert.equal(userConfirmedPendingAction([]), false);
});

test("checkAgentAnswer retries an announced lookup that called no tool", () => {
  const userText = "Ayúdame a crear presupuestos mensuales por categoría según mis gastos reales";
  for (const text of [
    "¡Claro que sí! Para ayudarte, primero necesito conocer tus gastos promedio. Voy a consultar tus gastos de los últimos 3 meses completos. Por favor, espera un momento.",
    "Déjame revisar tus movimientos.",
    "Un momento, por favor, estoy consultando tus cuentas.",
    "Permíteme buscar esa transacción."
  ]) {
    assert.deepEqual(checkAgentAnswer({ userText, text, messages: [] }), { ok: false, reason: "pending_lookup", retryable: true, writes: [] }, text);
  }
});

test("checkAgentAnswer accepts lookup wording once a tool ran, and plain answers without tools", () => {
  const userText = "¿Cómo van mis metas?";
  const ran = [requestTurn("listGoals"), toolTurn("listGoals", [])];
  assert.deepEqual(checkAgentAnswer({ userText, text: "Voy a revisar tus metas: no tienes metas activas.", messages: ran }), { ok: true, writes: [] });
  assert.deepEqual(checkAgentAnswer({ userText: "¿Qué es el 4x1000?", text: "El 4x1000 es el GMF, un impuesto del 0,4 %.", messages: [] }), { ok: true, writes: [] });
});
