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
      - Moneda principal del workspace: ${currency}. Cada cuenta y transacción tiene su propia moneda; no sumes montos de monedas distintas como si fueran la misma.

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
