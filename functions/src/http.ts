import { z } from "zod";

// Pure request helpers shared by the HTTP functions. Kept free of firebase-admin
// so they can be unit tested with `node --test` without emulators.

export const GENERIC_SERVER_ERROR = "Ocurrió un error interno. Inténtalo de nuevo más tarde.";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

interface JsonResponse {
  status(code: number): { json(body: unknown): unknown };
}

/** Sends an HttpError as-is; anything else is logged and answered with a generic 500. */
export function sendError(res: JsonResponse, error: unknown, context: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`Error en ${context}:`, error);
  res.status(500).json({ error: GENERIC_SERVER_ERROR });
}

// firebase-admin error codes that mean "the caller's token is not acceptable".
const UNAUTHORIZED_TOKEN_CODES = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found"
]);

/** Extracts and verifies a `Bearer` token; token problems become 401, infrastructure failures are rethrown. */
export async function verifyBearerToken(
  authorization: string | undefined,
  verify: (token: string) => Promise<{ uid: string }>
): Promise<string> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) {
    throw new HttpError(401, "No autorizado. Token de autenticación ausente.");
  }
  try {
    return (await verify(token)).uid;
  } catch (error: any) {
    if (UNAUTHORIZED_TOKEN_CODES.has(error?.code)) {
      throw new HttpError(401, "Sesión inválida o expirada. Vuelve a iniciar sesión.");
    }
    throw error;
  }
}

/** Validates a request body; the first issue message (Spanish) becomes a 400. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, result.error.issues[0]?.message || "Solicitud inválida.");
  }
  return result.data;
}

const INVALID_BODY = { invalid_type_error: "Solicitud inválida.", required_error: "Solicitud inválida." };

export const apiKeyBodySchema = z.object({
  apiKey: z.string({ invalid_type_error: "La API Key debe ser un texto.", required_error: "API Key es requerida" })
    .trim()
    .min(10, "La API Key es demasiado corta.")
    .max(200, "La API Key es demasiado larga.")
}, INVALID_BODY);

const STATEMENT_REQUIRED = "El texto del extracto o el PDF en base64 es requerido.";

export const parseStatementBodySchema = z.object({
  text: z.string({ invalid_type_error: "El texto del extracto debe ser un texto." }).optional(),
  pdfBase64: z.string({ invalid_type_error: "El PDF debe enviarse en base64." }).optional(),
  useDefaultKey: z.boolean({ invalid_type_error: "useDefaultKey debe ser booleano." }).optional()
}, INVALID_BODY).refine((body) => Boolean(body.text?.trim() || body.pdfBase64?.trim()), STATEMENT_REQUIRED);

export const MAX_CHAT_MESSAGES = 50;
export const MAX_USER_MESSAGE_CHARS = 4000;
export const MAX_MODEL_MESSAGE_CHARS = 16000;
const INVALID_MESSAGES = "El historial de mensajes (messages) es inválido.";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "model"], { errorMap: () => ({ message: INVALID_MESSAGES }) }),
  content: z.string({ invalid_type_error: INVALID_MESSAGES, required_error: INVALID_MESSAGES })
    .max(MAX_MODEL_MESSAGE_CHARS, "Un mensaje del historial es demasiado largo.")
}, { invalid_type_error: INVALID_MESSAGES }).superRefine((message, ctx) => {
  if (message.role === "user" && message.content.length > MAX_USER_MESSAGE_CHARS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `El mensaje supera el máximo de ${MAX_USER_MESSAGE_CHARS} caracteres.` });
  }
}).transform((message) => ({
  role: (message.role === "user" ? "user" : "model") as "user" | "model",
  content: message.content
}));

export const chatBodySchema = z.object({
  messages: z.array(chatMessageSchema, {
    invalid_type_error: "El historial de mensajes (messages) es requerido.",
    required_error: "El historial de mensajes (messages) es requerido."
  })
    .min(1, "El historial de mensajes (messages) es requerido.")
    .max(MAX_CHAT_MESSAGES, `El historial supera el máximo de ${MAX_CHAT_MESSAGES} mensajes.`),
  useDefaultKey: z.boolean({ invalid_type_error: "useDefaultKey debe ser booleano." }).optional()
}, INVALID_BODY).superRefine((body, ctx) => {
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "El último mensaje debe ser una pregunta del usuario." });
  }
});

export const inviteBodySchema = z.object({
  workspaceId: z.string({ invalid_type_error: "workspaceId y email son requeridos.", required_error: "workspaceId y email son requeridos." })
    .min(1, "workspaceId y email son requeridos."),
  email: z.string({ invalid_type_error: "workspaceId y email son requeridos.", required_error: "workspaceId y email son requeridos." })
    .trim()
    .min(1, "workspaceId y email son requeridos.")
}, INVALID_BODY);

// --- Time zone aware month bucketing ---------------------------------------

const DEFAULT_TIME_ZONE = "America/Bogota";
const COUNTRY_TIME_ZONES: Record<string, string> = {
  CO: "America/Bogota",
  MX: "America/Mexico_City",
  ES: "Europe/Madrid",
  US: "America/New_York",
  CL: "America/Santiago",
  AR: "America/Argentina/Buenos_Aires",
  PE: "America/Lima"
};

export function timeZoneForCountry(country: string | null | undefined): string {
  return (country && COUNTRY_TIME_ZONES[country.toUpperCase()]) || DEFAULT_TIME_ZONE;
}

export interface YearMonth {
  year: number;
  /** 0-based month, like Date#getMonth. */
  month: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(date: Date, timeZone: string): Record<string, number> {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

export function zonedYearMonth(date: Date, timeZone: string): YearMonth {
  const parts = zonedParts(date, timeZone);
  return { year: parts.year, month: parts.month - 1 };
}

/** Offset (ms) between the wall clock in `timeZone` and UTC at the given instant. */
function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of local midnight on the first day of the given month in `timeZone`. */
function zonedMonthStart({ year, month }: YearMonth, timeZone: string): Date {
  const wallClock = Date.UTC(year, month, 1);
  let instant = wallClock - timeZoneOffsetMs(wallClock, timeZone);
  const corrected = wallClock - timeZoneOffsetMs(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** The last `monthsBack` local months (current one included) and the instant the first one starts. */
export function expensePeriod(now: Date, monthsBack: number, timeZone: string): { start: Date; months: YearMonth[] } {
  const current = zonedYearMonth(now, timeZone);
  const firstIndex = current.year * 12 + current.month - monthsBack + 1;
  const months = Array.from({ length: monthsBack }, (_, offset) => ({
    year: Math.floor((firstIndex + offset) / 12),
    month: (firstIndex + offset) % 12
  }));
  return { start: zonedMonthStart(months[0], timeZone), months };
}

function toDate(value: any): Date {
  return value?.toDate ? value.toDate() : new Date(value);
}

/** Share of an expense (installments split to the cent) that falls in the given local month. */
export function expenseAmountForMonth(data: Record<string, any>, year: number, month: number, timeZone: string): number {
  if (data.type !== "expense") return 0;
  const transactionDate = toDate(data.date);
  if (Number.isNaN(transactionDate.getTime())) return 0;

  const installments = Number.isInteger(data.installments) && data.installments > 0 ? data.installments : 1;
  const start = zonedYearMonth(transactionDate, timeZone);
  const monthIndex = year * 12 + month - (start.year * 12 + start.month);
  if (monthIndex < 0 || monthIndex >= installments) return 0;

  const totalCents = Math.round(Math.abs(Number(data.amount) || 0) * 100);
  const baseCents = Math.floor(totalCents / installments);
  const remainderCents = totalCents % installments;
  return (baseCents + (monthIndex < remainderCents ? 1 : 0)) / 100;
}
