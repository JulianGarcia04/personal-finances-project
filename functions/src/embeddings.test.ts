import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmbeddingText,
  decideEmbeddingSync,
  documentEmbeddingInput,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  hashEmbeddingText,
  isEmbeddable,
  isEventTooOld,
  isPermanentGeminiError,
  queryEmbeddingInput,
  toVectorArray
} from "./embeddings";
import { zonedDateKey } from "./http";

const fakeTimestamp = (iso: string) => ({ toDate: () => new Date(iso) });

test("zonedDateKey formats the local calendar day", () => {
  // 03:00Z on the 12th is still the 11th in Bogota (UTC-5).
  assert.equal(zonedDateKey(new Date("2026-10-12T03:00:00Z"), "America/Bogota"), "2026-10-11");
  assert.equal(zonedDateKey(new Date("2026-10-12T05:00:00Z"), "America/Bogota"), "2026-10-12");
});

test("buildEmbeddingText keeps a legacy date-only string on its Bogota calendar day", () => {
  const text = buildEmbeddingText({ description: "Taxi", type: "expense", amount: 15000, currency: "COP", date: "2026-10-01" });
  assert.equal(text, "Descripción: Taxi. Tipo: gasto. Monto: -15000 COP. Fecha: 2026-10-01.");
});

test("buildEmbeddingText signs amounts by type and uses the Bogota date", () => {
  const text = buildEmbeddingText(
    { description: "Almuerzo", type: "expense", amount: 25000, currency: "COP", date: fakeTimestamp("2026-10-12T03:00:00Z") },
    { categoryName: "Comida", accountName: "Visa Oro" }
  );
  assert.equal(text, "Descripción: Almuerzo. Tipo: gasto. Monto: -25000 COP. Fecha: 2026-10-11. Categoría: Comida. Cuenta: Visa Oro.");

  const income = buildEmbeddingText({ description: "Salario", type: "income", amount: -1500.5, currency: "USD" });
  assert.equal(income, "Descripción: Salario. Tipo: ingreso. Monto: 1500.5 USD.");

  const transfer = buildEmbeddingText({ description: "Ahorro", type: "transfer", amount: -100, currency: "EUR" });
  assert.equal(transfer, "Descripción: Ahorro. Tipo: transferencia. Monto: 100 EUR.");
});

test("buildEmbeddingText tolerates missing or invalid fields and includes notes", () => {
  assert.equal(
    buildEmbeddingText({ date: "not-a-date", notes: "  regalo de cumpleaños  " }),
    "Descripción: . Monto: 0. Notas: regalo de cumpleaños."
  );
  assert.equal(buildEmbeddingText({ amount: 0.1 + 0.2, type: "expense" }), "Descripción: . Tipo: gasto. Monto: -0.3.");
});

test("embedding inputs use the gemini-embedding-2 retrieval prefixes", () => {
  assert.equal(documentEmbeddingInput("Descripción: X."), "title: none | text: Descripción: X.");
  assert.equal(queryEmbeddingInput("ropa"), "task: search result | query: ropa");
});

test("hashEmbeddingText is a stable sha256 hex digest", () => {
  const hash = hashEmbeddingText("abc");
  assert.equal(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(hashEmbeddingText("abd"), hash);
});

test("isEventTooOld rejects events older than the max age and unparsable times", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assert.equal(isEventTooOld("2026-10-11T11:30:00Z", now), false);
  assert.equal(isEventTooOld("2026-10-11T10:59:59Z", now), true);
  assert.equal(isEventTooOld("garbage", now), true);
  assert.equal(isEventTooOld("2026-10-11T11:00:00Z", now, 2 * 60 * 60 * 1000), false);
});

test("isEmbeddable excludes mirror legs and docs without workspace", () => {
  assert.equal(isEmbeddable({ workspaceId: "w1" }), true);
  assert.equal(isEmbeddable({ workspaceId: "w1", mirrorOf: "t0" }), false);
  assert.equal(isEmbeddable({}), false);
  assert.equal(isEmbeddable(undefined), false);
});

test("decideEmbeddingSync covers delete, skip and embed", () => {
  const fresh = { workspaceId: "w1", textHash: "h1", model: EMBEDDING_MODEL, dim: EMBEDDING_DIM };
  const tx = { workspaceId: "w1" };

  assert.deepEqual(decideEmbeddingSync(undefined, fresh, undefined), { action: "delete", reason: "deleted" });
  assert.deepEqual(decideEmbeddingSync(undefined, undefined, undefined), { action: "skip", reason: "absent" });
  assert.deepEqual(decideEmbeddingSync({ workspaceId: "w1", mirrorOf: "t0" }, fresh, undefined), { action: "delete", reason: "not-embeddable" });
  assert.deepEqual(decideEmbeddingSync({ workspaceId: "w1", mirrorOf: "t0" }, undefined, undefined), { action: "skip", reason: "not-embeddable" });
  assert.deepEqual(decideEmbeddingSync(tx, fresh, "h1"), { action: "skip", reason: "unchanged" });
  assert.deepEqual(decideEmbeddingSync(tx, fresh, "h2"), { action: "embed" });
  assert.deepEqual(decideEmbeddingSync(tx, { ...fresh, model: "text-embedding-004" }, "h1"), { action: "embed" });
  assert.deepEqual(decideEmbeddingSync(tx, { ...fresh, dim: 768 }, "h1"), { action: "embed" });
  assert.deepEqual(decideEmbeddingSync({ workspaceId: "w2" }, fresh, "h1"), { action: "embed" });
  assert.deepEqual(decideEmbeddingSync(tx, undefined, "h1"), { action: "embed" });
});

test("isPermanentGeminiError treats 4xx (except 408/429) as permanent", () => {
  assert.equal(isPermanentGeminiError({ status: 400 }), true);
  assert.equal(isPermanentGeminiError({ status: 403 }), true);
  assert.equal(isPermanentGeminiError({ status: 429 }), false);
  assert.equal(isPermanentGeminiError({ status: 408 }), false);
  assert.equal(isPermanentGeminiError({ status: 503 }), false);
  assert.equal(isPermanentGeminiError(new Error("fetch failed")), false);
});

test("toVectorArray reads Firestore vectors and plain arrays", () => {
  assert.deepEqual(toVectorArray({ toArray: () => [1, 2] }), [1, 2]);
  assert.deepEqual(toVectorArray([3, 4]), [3, 4]);
  assert.equal(toVectorArray(null), null);
  assert.equal(toVectorArray("x"), null);
});
