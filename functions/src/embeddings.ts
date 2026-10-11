// Transaction embeddings: text building, Gemini embedding, and the sync core shared by
// the Firestore trigger, the agent tools and scripts/backfill-embeddings.mjs (via lib/).
import { createHash } from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DocumentData, FieldValue, Firestore } from "firebase-admin/firestore";
import { zonedDateKey } from "./http";

export const EMBEDDING_MODEL = "gemini-embedding-2";
/**
 * Default (and normalized) output size of gemini-embedding-2. Firestore vector values (and
 * vector indexes) cap at 2048 dims, so vectors are stored as plain number[] and ranked in memory.
 */
export const EMBEDDING_DIM = 3072;
/** Server-only collection keyed by transaction id; clients are denied in firestore.rules. */
export const EMBEDDINGS_COLLECTION = "transactionEmbeddings";
export const EMBEDDING_TIME_ZONE = "America/Bogota";
/** Trigger events older than this are dropped so a retried failure cannot loop forever. */
export const MAX_EVENT_AGE_MS = 60 * 60 * 1000;

export type EmbedTask = "document" | "query";
/** Returns the embedding of an already-prefixed input. */
export type EmbedFn = (input: string) => Promise<number[]>;

/** A failure that retrying cannot fix (bad key, rejected input, unexpected dimension). */
export class PermanentEmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentEmbeddingError";
  }
}

const TYPE_LABELS: Record<string, string> = { expense: "gasto", income: "ingreso", transfer: "transferencia" };

export interface EmbeddingNames {
  categoryName?: string;
  accountName?: string;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function signedAmount(type: unknown, amount: unknown): number {
  const magnitude = Math.round(Math.abs(Number(amount) || 0) * 100) / 100;
  if (type === "expense") return magnitude === 0 ? 0 : -magnitude;
  return magnitude;
}

/** Canonical text that represents a transaction for semantic search. */
export function buildEmbeddingText(tx: DocumentData, names: EmbeddingNames = {}): string {
  const parts = [`Descripción: ${String(tx.description ?? "").trim()}.`];
  const typeLabel = TYPE_LABELS[tx.type] ?? (typeof tx.type === "string" && tx.type ? tx.type : "");
  if (typeLabel) parts.push(`Tipo: ${typeLabel}.`);
  const currency = typeof tx.currency === "string" && tx.currency ? ` ${tx.currency}` : "";
  parts.push(`Monto: ${signedAmount(tx.type, tx.amount)}${currency}.`);
  const date = toDate(tx.date);
  if (date) parts.push(`Fecha: ${zonedDateKey(date, EMBEDDING_TIME_ZONE)}.`);
  if (names.categoryName) parts.push(`Categoría: ${names.categoryName}.`);
  if (names.accountName) parts.push(`Cuenta: ${names.accountName}.`);
  const notes = typeof tx.notes === "string" ? tx.notes.trim().slice(0, 500) : "";
  if (notes) parts.push(`Notas: ${notes}.`);
  return parts.join(" ");
}

// gemini-embedding-2 rejects `taskType`; retrieval intent goes in the text as documented
// prefixes (https://ai.google.dev/gemini-api/docs/embeddings).
export function documentEmbeddingInput(text: string): string {
  return `title: none | text: ${text}`;
}

export function queryEmbeddingInput(query: string): string {
  return `task: search result | query: ${query}`;
}

export function hashEmbeddingText(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isEventTooOld(eventTime: string, now: Date = new Date(), maxAgeMs: number = MAX_EVENT_AGE_MS): boolean {
  const time = Date.parse(eventTime);
  return Number.isNaN(time) || now.getTime() - time > maxAgeMs;
}

/** Mirror legs duplicate their source and are never embedded. */
export function isEmbeddable(tx: DocumentData | undefined): tx is DocumentData {
  return !!tx && typeof tx.workspaceId === "string" && tx.workspaceId.length > 0 && !tx.mirrorOf;
}

export type EmbeddingDecision =
  | { action: "delete"; reason: "deleted" | "not-embeddable" }
  | { action: "skip"; reason: "absent" | "not-embeddable" | "unchanged" }
  | { action: "embed" };

export function decideEmbeddingSync(
  tx: DocumentData | undefined,
  existing: DocumentData | undefined,
  textHash: string | undefined
): EmbeddingDecision {
  if (!tx) return existing ? { action: "delete", reason: "deleted" } : { action: "skip", reason: "absent" };
  if (!isEmbeddable(tx)) {
    return existing ? { action: "delete", reason: "not-embeddable" } : { action: "skip", reason: "not-embeddable" };
  }
  const fresh = existing
    && existing.textHash === textHash
    && existing.model === EMBEDDING_MODEL
    && existing.dim === EMBEDDING_DIM
    && existing.workspaceId === tx.workspaceId;
  return fresh ? { action: "skip", reason: "unchanged" } : { action: "embed" };
}

export function isPermanentGeminiError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function createGeminiEmbedder(apiKey: string): EmbedFn {
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: EMBEDDING_MODEL });
  return async (input) => {
    let values: number[] | undefined;
    try {
      const result = await model.embedContent({ content: { role: "user", parts: [{ text: input }] } });
      values = result.embedding?.values;
    } catch (error) {
      if (isPermanentGeminiError(error)) {
        throw new PermanentEmbeddingError("Gemini rechazó la solicitud de embeddings.", { cause: error });
      }
      throw error;
    }
    if (!values?.length) throw new Error("La respuesta de embeddings no contiene valores válidos.");
    if (values.length !== EMBEDDING_DIM) {
      throw new PermanentEmbeddingError(`Dimensión de embedding inesperada: ${values.length}.`);
    }
    return values;
  };
}

/** Reads a stored vector (number[], or a Firestore VectorValue if dims are ever reduced). */
export function toVectorArray(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (value && typeof (value as { toArray?: unknown }).toArray === "function") {
    return (value as { toArray: () => number[] }).toArray();
  }
  return null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface NameResolver {
  resolve(tx: DocumentData): Promise<EmbeddingNames>;
}

/** Category/account name lookups, cached for the lifetime of one invocation. */
export function createNameResolver(db: Firestore): NameResolver {
  const cache = new Map<string, Promise<string | undefined>>();
  const lookup = (collection: string, id: unknown, workspaceId: unknown) => {
    if (typeof id !== "string" || !id) return Promise.resolve(undefined);
    const key = `${collection}/${id}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = db.collection(collection).doc(id).get().then((snap) => {
        const data = snap.data();
        // Categories may be global (workspaceId null); never use another workspace's names.
        if (!data || (data.workspaceId && data.workspaceId !== workspaceId)) return undefined;
        return typeof data.name === "string" && data.name ? data.name : undefined;
      });
      cache.set(key, pending);
    }
    return pending;
  };
  return {
    async resolve(tx) {
      const [categoryName, accountName] = await Promise.all([
        lookup("categories", tx.categoryId, tx.workspaceId),
        lookup("accounts", tx.accountId, tx.workspaceId)
      ]);
      return { categoryName, accountName };
    }
  };
}

export interface EmbeddingPlan {
  decision: EmbeddingDecision;
  input?: string;
  textHash?: string;
  /** The transaction still carries the legacy inline `embedding` field. */
  hasLegacyField: boolean;
}

/** Reads the current embedding doc and decides what to do, without writing. */
export async function planEmbeddingSync(
  db: Firestore,
  names: NameResolver,
  transactionId: string,
  tx: DocumentData | undefined
): Promise<EmbeddingPlan> {
  const existing = (await db.collection(EMBEDDINGS_COLLECTION).doc(transactionId).get()).data();
  let input: string | undefined;
  let textHash: string | undefined;
  if (isEmbeddable(tx)) {
    input = documentEmbeddingInput(buildEmbeddingText(tx, await names.resolve(tx)));
    textHash = hashEmbeddingText(input);
  }
  return { decision: decideEmbeddingSync(tx, existing, textHash), input, textHash, hasLegacyField: tx?.embedding !== undefined };
}

export type SyncOutcome = "deleted" | "skipped" | "unchanged" | "embedded" | "superseded" | "no-key";

export interface SyncDeps {
  db: Firestore;
  names: NameResolver;
  /** Null when no Gemini key is configured (permanent: nothing is retried). */
  embed: EmbedFn | null;
}

/**
 * Brings `transactionEmbeddings/{transactionId}` in line with the given transaction state.
 * Transient Gemini/Firestore errors propagate; PermanentEmbeddingError marks non-retryable ones.
 */
export async function syncTransactionEmbedding(
  deps: SyncDeps,
  transactionId: string,
  tx: DocumentData | undefined,
  plan?: EmbeddingPlan
): Promise<SyncOutcome> {
  const { db, names } = deps;
  const resolved = plan ?? await planEmbeddingSync(db, names, transactionId, tx);
  const embeddingRef = db.collection(EMBEDDINGS_COLLECTION).doc(transactionId);
  const { decision } = resolved;

  if (decision.action === "delete") {
    await embeddingRef.delete();
    return "deleted";
  }
  if (decision.action === "skip") return decision.reason === "unchanged" ? "unchanged" : "skipped";
  if (!deps.embed) return "no-key";

  const values = await deps.embed(resolved.input!);
  const transactionRef = db.collection("transactions").doc(transactionId);
  // Re-check the live transaction so a slow or out-of-order event never overwrites a newer
  // vector or resurrects the embedding of a deleted transaction.
  const written = await db.runTransaction(async (transaction) => {
    const current = await transaction.get(transactionRef);
    const data = current.data();
    if (!isEmbeddable(data)) return false;
    const currentHash = hashEmbeddingText(documentEmbeddingInput(buildEmbeddingText(data, await names.resolve(data))));
    if (currentHash !== resolved.textHash) return false;
    transaction.set(embeddingRef, {
      transactionId,
      workspaceId: data.workspaceId,
      embedding: values,
      model: EMBEDDING_MODEL,
      dim: values.length,
      textHash: resolved.textHash,
      sourceUpdatedAt: data.updatedAt ?? data.createdAt ?? null,
      updatedAt: FieldValue.serverTimestamp()
    });
    return true;
  });
  return written ? "embedded" : "superseded";
}
