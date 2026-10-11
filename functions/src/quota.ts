import type { Firestore } from "firebase-admin/firestore";
import { HttpError } from "./http";

// Cost caps for requests that spend the project's (default) Gemini key.

export type QuotaKind = "chat" | "parse";

export const DEFAULT_DAILY_LIMITS: Record<QuotaKind, number> = { chat: 50, parse: 10 };
const LIMIT_ENV_VARS: Record<QuotaKind, string> = {
  chat: "DEFAULT_KEY_DAILY_CHAT_LIMIT",
  parse: "DEFAULT_KEY_DAILY_PARSE_LIMIT"
};

/** Daily buckets follow the Colombian calendar day for every user. */
export const QUOTA_TIME_ZONE = "America/Bogota";
export const QUOTA_COLLECTION = "usageQuotas";

const QUOTA_EXCEEDED_MESSAGES: Record<QuotaKind, string> = {
  chat: "Alcanzaste el límite diario de mensajes con la API Key del proyecto. Configura tu propia API Key de Gemini en Configuración para seguir usando el asesor.",
  parse: "Alcanzaste el límite diario de extractos analizados con la API Key del proyecto. Configura tu propia API Key de Gemini en Configuración para seguir importando."
};

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar day (YYYY-MM-DD) of `now` in `timeZone`. */
export function quotaDateKey(now: Date, timeZone: string = QUOTA_TIME_ZONE): string {
  let formatter = dateKeyFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter.format(now);
}

export function quotaDocId(uid: string, dateKey: string): string {
  return `${uid}_${dateKey}`;
}

/** Non-negative integer from env, or the fallback when unset/invalid. `0` disables the default key. */
export function parseDailyLimit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Number(value);
}

export function dailyLimit(kind: QuotaKind, env: Record<string, string | undefined> = process.env): number {
  return parseDailyLimit(env[LIMIT_ENV_VARS[kind]], DEFAULT_DAILY_LIMITS[kind]);
}

/** The counter after consuming one unit, or a 429 when the limit is already reached. */
export function nextQuotaCount(current: unknown, kind: QuotaKind, limit: number): number {
  const used = typeof current === "number" && Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  if (used >= limit) throw new HttpError(429, QUOTA_EXCEEDED_MESSAGES[kind]);
  return used + 1;
}

/**
 * Atomically consumes one unit of the caller's daily default-key quota.
 * Must run BEFORE calling Gemini; a request that fails afterwards still counts.
 */
export async function consumeDefaultKeyQuota(db: Firestore, uid: string, kind: QuotaKind, now: Date = new Date()): Promise<void> {
  const limit = dailyLimit(kind);
  const dateKey = quotaDateKey(now);
  const ref = db.collection(QUOTA_COLLECTION).doc(quotaDocId(uid, dateKey));
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const next = nextQuotaCount(snapshot.get(kind), kind, limit);
    transaction.set(ref, {
      uid,
      date: dateKey,
      [kind]: next,
      updatedAt: now,
      // Lets a Firestore TTL policy on `expiresAt` purge old buckets.
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    }, { merge: true });
  });
}

// --- Statement payload size caps -------------------------------------------

export const MAX_STATEMENT_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_STATEMENT_TEXT_CHARS = 200_000;

/** Decoded byte length of a base64 payload (optionally a data URL), without decoding it. */
export function base64DecodedBytes(data: string): number {
  const commaIndex = data.startsWith("data:") ? data.indexOf(",") : -1;
  const payload = (commaIndex === -1 ? data : data.slice(commaIndex + 1)).replace(/\s+/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function assertStatementSize(input: { text?: string; pdfBase64?: string }): void {
  if (input.pdfBase64 && base64DecodedBytes(input.pdfBase64) > MAX_STATEMENT_PDF_BYTES) {
    throw new HttpError(413, "El PDF supera el tamaño máximo de 8 MB.");
  }
  if (input.text && input.text.length > MAX_STATEMENT_TEXT_CHARS) {
    throw new HttpError(413, `El texto del extracto supera el máximo de ${MAX_STATEMENT_TEXT_CHARS.toLocaleString("es-CO")} caracteres.`);
  }
}
