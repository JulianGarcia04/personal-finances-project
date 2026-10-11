import { z } from "zod";
import { HttpError, zonedDateKey, zonedWallClockToInstant } from "./http";

// Pure helpers for the chat agent's tools: date context, date parsing, amount
// signs, lean tool rows and fail-soft tool execution. No firebase-admin here so
// they can be unit tested with `node --test`.

/** A user-facing (Spanish) tool failure that is safe to hand back to the model. */
export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

export const GENERIC_TOOL_ERROR = "No se pudo completar la operación. Inténtalo de nuevo o reformula la solicitud.";

// --- Local calendar dates ----------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateKey(value: string): { year: number; month: number; day: number } {
  const match = DATE_ONLY.exec(value);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const probe = new Date(Date.UTC(year, month, day));
    if (probe.getUTCFullYear() === year && probe.getUTCMonth() === month && probe.getUTCDate() === day) {
      return { year, month, day };
    }
  }
  throw new AgentToolError(`Fecha inválida "${value}". Usa el formato YYYY-MM-DD con una fecha real.`);
}

/** Date-only string → local noon in `timeZone` (same convention as the app's date inputs). */
export function parseLocalDate(value: string, timeZone: string): Date {
  const { year, month, day } = parseDateKey(value);
  return zonedWallClockToInstant(year, month, day, 12, timeZone);
}

/** Inclusive local day range → [start, endExclusive) instants; missing bounds stay open. */
export function localDayRange(
  startKey: string | undefined,
  endKey: string | undefined,
  timeZone: string
): { start: Date | null; endExclusive: Date | null } {
  const start = startKey ? parseDateKey(startKey) : null;
  const end = endKey ? parseDateKey(endKey) : null;
  if (startKey && endKey && startKey > endKey) {
    throw new AgentToolError("La fecha inicial no puede ser posterior a la fecha final.");
  }
  return {
    start: start ? zonedWallClockToInstant(start.year, start.month, start.day, 0, timeZone) : null,
    endExclusive: end ? zonedWallClockToInstant(end.year, end.month, end.day + 1, 0, timeZone) : null
  };
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function keyFromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface DateRange { start: string; end: string }

export interface DateContext {
  today: string;
  weekday: string;
  yesterday: string;
  monthName: string;
  thisWeek: DateRange;
  thisMonth: DateRange;
  lastMonth: DateRange;
  thisYear: DateRange;
}

/** Relative periods ("hoy", "esta semana" lunes-domingo, "mes pasado"...) as local YYYY-MM-DD keys. */
export function buildDateContext(now: Date, timeZone: string): DateContext {
  const { year, month, day } = parseDateKey(zonedDateKey(now, timeZone));
  const todayUtc = Date.UTC(year, month, day);
  const dayMs = 86_400_000;
  const weekdayIndex = new Date(todayUtc).getUTCDay();
  const mondayUtc = todayUtc - ((weekdayIndex + 6) % 7) * dayMs;
  return {
    today: keyFromUtc(todayUtc),
    weekday: WEEKDAYS[weekdayIndex],
    yesterday: keyFromUtc(todayUtc - dayMs),
    monthName: `${MONTHS[month]} de ${year}`,
    thisWeek: { start: keyFromUtc(mondayUtc), end: keyFromUtc(mondayUtc + 6 * dayMs) },
    thisMonth: { start: keyFromUtc(Date.UTC(year, month, 1)), end: keyFromUtc(Date.UTC(year, month + 1, 0)) },
    lastMonth: { start: keyFromUtc(Date.UTC(year, month - 1, 1)), end: keyFromUtc(Date.UTC(year, month, 0)) },
    thisYear: { start: `${year}-01-01`, end: `${year}-12-31` }
  };
}

/** Context block for the system prompt: current date, time zone, currency and data conventions. */
export function buildAgentContextBlock({ now, timeZone, currency }: { now: Date; timeZone: string; currency: string }): string {
  const d = buildDateContext(now, timeZone);
  return `
      CONTEXTO ACTUAL (úsalo para toda referencia temporal):
      - Hoy es ${d.weekday} ${d.today}. Zona horaria del usuario: ${timeZone}. Mes en curso: ${d.monthName}.
      - Rangos ya resueltos (YYYY-MM-DD, inclusivos): hoy ${d.today}; ayer ${d.yesterday}; esta semana (lunes a domingo) ${d.thisWeek.start} a ${d.thisWeek.end}; este mes ${d.thisMonth.start} a ${d.thisMonth.end}; mes pasado ${d.lastMonth.start} a ${d.lastMonth.end}; este año ${d.thisYear.start} a ${d.thisYear.end}.
      - Moneda principal del usuario (la del panel de control): ${currency}. Cada cuenta y transacción tiene su propia moneda; no sumes montos de monedas distintas como si fueran la misma.

      CONVENCIONES DE LOS DATOS:
      - En las transacciones guardadas, los gastos (expense) y préstamos dados (loan) tienen monto negativo; ingresos (income), pagos de préstamo recibidos (loan_payment) y transferencias (transfer) tienen monto positivo. Las transferencias y los préstamos no son gasto ni ingreso.
      - Al crear movimientos envía siempre el monto en valor absoluto (positivo); el servidor aplica el signo según el tipo.
      - Tarjetas de crédito: saldo negativo = deuda; cupo disponible = límite + saldo.
      - Bolsillos (cuentas con cuenta principal): su saldo está separado del de la cuenta principal; el total de la cuenta es principal + bolsillos.
      - Cuentas puente (compartidas): saldo negativo = lo que este workspace le debe a quien pagó.
      - Las compras a cuotas guardan el monto total en la fecha de compra.

      REGLAS DE FECHAS:
      - Convierte "hoy", "ayer", "esta semana", "este mes", "mes pasado", "este año" o fechas relativas a fechas concretas (YYYY-MM-DD) con los rangos anteriores ANTES de llamar herramientas.
      - Nunca respondas que no puedes consultar un periodo sin antes intentarlo con las herramientas (por ejemplo listTransactions con startDate y endDate).
  `;
}

// --- Amounts -----------------------------------------------------------------

export type MovementType = "income" | "expense" | "transfer" | "loan" | "loan_payment";

/** Absolute amount → the app's signed convention (expense/loan negative, everything else positive). */
export function signedAmount(amount: number, type: MovementType): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) {
    throw new AgentToolError("El monto debe ser un número distinto de cero.");
  }
  return type === "expense" || type === "loan" ? -Math.abs(value) : Math.abs(value);
}

// --- Lean rows -----------------------------------------------------------------

export interface NameMaps {
  accounts: Map<string, string>;
  categories: Map<string, string>;
}

function toDate(value: any): Date | null {
  const date = value?.toDate ? value.toDate() : value != null ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** The fields the model needs from a transaction, with names instead of ids. */
export function toLeanTransaction(id: string, data: Record<string, any>, names: NameMaps, timeZone: string): Record<string, unknown> {
  const date = toDate(data.date);
  const amount = Number(data.amount) || 0;
  const row: Record<string, unknown> = {
    id,
    date: date ? zonedDateKey(date, timeZone) : null,
    description: data.description ?? "",
    type: data.type ?? null,
    amount,
    currency: data.currency ?? null,
    categoryName: data.categoryId ? names.categories.get(data.categoryId) ?? "Desconocida" : null,
    accountName: names.accounts.get(data.accountId) ?? "Cuenta desconocida"
  };
  if (data.toAccountId) row.toAccountName = names.accounts.get(data.toAccountId) ?? "Cuenta desconocida";
  if (Number.isInteger(data.installments) && data.installments > 1) {
    row.installments = data.installments;
    row.installmentAmount = Math.round((amount / data.installments) * 100) / 100;
  }
  return row;
}

// --- Fail-soft tool execution -------------------------------------------------

const MEMBERSHIP_ERROR = "El usuario no pertenece al workspace activo.";
const PERMISSION_CODES = new Set<unknown>([7, 16, "permission-denied", "unauthenticated"]);

function isAuthError(error: any): boolean {
  if (error instanceof HttpError) return error.status === 401 || error.status === 403;
  return PERMISSION_CODES.has(error?.code) || error?.message === MEMBERSHIP_ERROR;
}

function modelFacingMessage(error: any): string {
  if (error instanceof AgentToolError) return error.message;
  // Plain Errors carry the domain's Spanish messages (e.g. pockets.ts); infrastructure
  // errors (with a `code`) and programming errors (TypeError...) stay generic.
  if (error instanceof Error && error.constructor === Error && error.message && (error as any).code === undefined) {
    return error.message.slice(0, 300);
  }
  return GENERIC_TOOL_ERROR;
}

/**
 * Wraps a tool body: validates the input with the strict schema and turns any
 * failure into `{ error }` for the model, so one bad call never fails the chat.
 * Auth/permission problems still throw (as HttpError 403 unless already HttpError).
 */
export function safeTool<S extends z.ZodTypeAny, R>(
  name: string,
  schema: S,
  fn: (input: z.output<S>) => Promise<R>
): (input: unknown) => Promise<R | { error: string }> {
  return async (input) => {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "entrada"}: ${issue.message}`).join("; ");
      return { error: `Parámetros inválidos para ${name}: ${issues}` };
    }
    try {
      return await fn(parsed.data);
    } catch (error) {
      if (isAuthError(error)) {
        throw error instanceof HttpError ? error : new HttpError(403, "No tienes acceso al workspace activo.");
      }
      console.error(`Tool ${name} failed:`, error);
      return { error: modelFacingMessage(error) };
    }
  };
}

const BOUND_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems",
  "additionalProperties"
]);

/**
 * Model-facing JSON schema without value bounds. Genkit rejects tool input that
 * fails its schema by throwing (failing the whole chat), so bounds are enforced
 * inside `safeTool` instead, where violations become `{ error }`.
 */
export function relaxJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (BOUND_KEYWORDS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value).map(([prop, sub]) => [prop, relaxJsonSchema(sub)]));
    } else if (key === "enum" || key === "required") {
      out[key] = value;
    } else {
      out[key] = relaxJsonSchema(value);
    }
  }
  return out;
}

// --- Final answer guard ---------------------------------------------------------

export const EMPTY_ANSWER_FALLBACK = "No pude generar una respuesta, intenta reformular la pregunta.";

/** Tools that change data; only their `success: true` outputs back a claimed action. */
export const WRITE_TOOLS = new Set([
  "createAccount", "createTransaction", "deleteTransaction", "createGoal", "updateGoalAmount", "saveCategoryBudgets"
]);

interface MessageLike {
  role?: string;
  content?: Array<{ toolResponse?: { name?: string; output?: unknown } } & Record<string, unknown>>;
}

/** Names of write tools that returned `success: true` in these generation messages. */
export function succeededWriteTools(messages: readonly MessageLike[] | undefined): string[] {
  const names: string[] = [];
  for (const message of messages ?? []) {
    for (const part of message?.content ?? []) {
      const response = part?.toolResponse;
      const output = response?.output as { success?: unknown } | null | undefined;
      if (response?.name && WRITE_TOOLS.has(response.name) && output && typeof output === "object" && output.success === true) {
        names.push(response.name);
      }
    }
  }
  return names;
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const ACTION_REQUEST = /\b(registr|anot|agreg|anad|crea|crear|elimin|borr|guard|actualiz|transfier|abon)/;
const NEGATED_ACTION = /\bno (he|hemos|pude|puedo|se pudo|fue posible|logre|se guardo|se registro)\b/;
// "He creado una propuesta/tabla..." describes the answer itself, not a saved change.
const ANSWER_ARTIFACT = String.raw`(?!\s+(?:una?|el|la|este|esta)\s+(?:propuesta|plan|resumen|tabla|lista|borrador))`;
// A question asking to confirm a pending change means nothing was claimed as done.
const PENDING_CONFIRMATION = /¿[^?]*\b(confirm\w*|procedo|(quieres|deseas|prefieres) que (?:\w+ )?(guarde|registre|cree|elimine|borre|actualice|aplique))\b/;
const CLAIMED_ACTION = new RegExp([
  String.raw`\b(he|hemos|ya)\s+(registrado|creado${ANSWER_ARTIFACT}|eliminado|borrado|guardado|actualizado|agregado|anadido|anotado|transferido)\b`,

  String.raw`\blisto\b`,
  String.raw`\b(fue|ha sido|quedo|quedaron|fueron)\s+(registrad|cread|eliminad|borrad|guardad|actualizad|agregad|anotad)[oa]s?\b`
].join("|"));

// First-person preterite needs its accent: "guardé" is a claim, "que guarde" is not.
const CLAIMED_PRETERITE = /(?<![\p{L}])(registré|eliminé|borré|guardé|actualicé|agregué|añadí|anoté|transferí)(?![\p{L}])/u;

// "Voy a consultar…", "espera un momento": the turn ended before the lookup it announces.
const PENDING_LOOKUP = new RegExp([
  String.raw`\b(voy a|procedo a|dejame|permiteme|primero) (consultar|revisar|buscar|analizar|obtener|verificar|calcular|mirar|ver)\b`,
  String.raw`\bestoy (consultando|revisando|buscando|analizando|calculando|verificando)\b`,
  String.raw`\b(espera|esperame|dame|un) (un )?(momento|segundo|instante)\b`
].join("|"));

function calledAnyTool(messages: readonly MessageLike[] | undefined): boolean {
  return (messages ?? []).some(message => (message?.content ?? []).some(part => part && "toolRequest" in part && part.toolRequest));
}

export type AnswerReason = "empty" | "unbacked_action" | "pending_lookup";

export type AnswerCheck =
  | { ok: true; writes: string[] }
  | { ok: false; reason: AnswerReason; retryable: boolean; writes: string[] };

/**
 * Decides whether the agent's final answer can be returned: it must not be empty,
 * and when the user asked for a change it must not claim one that no write tool
 * backed in this generation, nor announce a lookup it never made. Retries only
 * happen when nothing was written (a full retry would duplicate the write).
 */
export function checkAgentAnswer({ userText, text, messages }: {
  userText: string;
  text: string | undefined;
  messages: readonly MessageLike[] | undefined;
}): AnswerCheck {
  const writes = succeededWriteTools(messages);
  const answer = fold(text ?? "").trim();
  if (!answer) return { ok: false, reason: "empty", retryable: writes.length === 0, writes };
  const claimsAction = (CLAIMED_ACTION.test(answer) || CLAIMED_PRETERITE.test((text ?? "").normalize("NFC").toLowerCase())) &&
    !NEGATED_ACTION.test(answer) && !PENDING_CONFIRMATION.test(answer);
  if (writes.length === 0 && claimsAction && ACTION_REQUEST.test(fold(userText))) {
    return { ok: false, reason: "unbacked_action", retryable: true, writes };
  }
  if (writes.length === 0 && !calledAnyTool(messages) && PENDING_LOOKUP.test(answer)) {
    return { ok: false, reason: "pending_lookup", retryable: true, writes };
  }
  return { ok: true, writes };
}

/** System note appended on the retry after an unbacked action claim. */
export const UNBACKED_ACTION_NOTE = `
      NOTA CORRECTIVA: en un intento anterior respondiste que habías realizado una acción sin que ninguna herramienta de escritura la confirmara. Si el usuario pidió registrar, crear, actualizar o eliminar algo y tienes los datos necesarios, llama ahora a la herramienta correspondiente (categoryId es opcional). Si falta un dato imprescindible, pregúntalo. Nunca afirmes que algo se guardó si la herramienta no devolvió success: true.
  `;

/** System note appended on the retry after an announced lookup with no tool call. */
export const PENDING_LOOKUP_NOTE = `
      NOTA CORRECTIVA: en un intento anterior anunciaste que ibas a consultar datos ("voy a consultar", "espera un momento") y terminaste sin llamar ninguna herramienta. No anuncies consultas: llama ahora mismo a las herramientas necesarias y responde con los resultados.
  `;

/** User-facing replacement when the answer cannot be returned as is (never empty). */
export function fallbackAnswer(reason: Exclude<AnswerReason, "pending_lookup">, writes: readonly string[]): string {
  if (reason === "unbacked_action") {
    return "No pude completar la acción: no se guardó ningún cambio. Intenta de nuevo indicando los datos (monto, cuenta y fecha).";
  }
  if (writes.length > 0) {
    return "La operación se completó, pero no pude generar el resumen de la respuesta. Revisa los cambios en la app.";
  }
  return EMPTY_ANSWER_FALLBACK;
}

const CONFIRMATION_REQUEST = /confirm|\b(quieres|deseas|prefieres|te gustaria) que (?:\w+ )?(elimine|borre|guarde|aplique|actualice)\b/;
const REFUSAL = /^\W*(no|nop|cancela|cancelar|mejor no|todavia no|aun no)\b/;

/**
 * Server-side gate for destructive tools: `confirmed: true` only counts when the
 * assistant's previous message asked for confirmation and the user's reply is not
 * a refusal. A single "elimina X" request is never its own confirmation.
 */
export function userConfirmedPendingAction(messages: ReadonlyArray<{ role: string; content: string }>): boolean {
  if (messages.length < 2) return false;
  const reply = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  if (reply.role !== "user" || (previous.role !== "model" && previous.role !== "assistant")) return false;
  return CONFIRMATION_REQUEST.test(fold(previous.content)) && !REFUSAL.test(fold(reply.content).trim());
}
