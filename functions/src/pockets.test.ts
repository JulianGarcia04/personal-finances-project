import { test } from "node:test";
import assert from "node:assert/strict";
import { FieldValue } from "firebase-admin/firestore";
import type * as admin from "firebase-admin";
import { mutateWorkspaceTransaction } from "./pockets";

type Data = Record<string, unknown>;
type DocRef = { kind: "doc"; collection: string; id: string };
type QueryRef = { kind: "query"; collection: string; field: string; value: unknown; limit: (n: number) => QueryRef };

// Minimal in-memory Firestore: document reads, equality queries and transactional writes.
const fakeDb = (seed: Record<string, Data>) => {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, { ...data }]));
  let nextId = 0;
  const snapshot = (ref: DocRef) => {
    const data = docs.get(`${ref.collection}/${ref.id}`);
    return { id: ref.id, exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  };
  const query = (collection: string, field: string, value: unknown): QueryRef => {
    const ref: QueryRef = { kind: "query", collection, field, value, limit: () => ref };
    return ref;
  };
  const db = {
    collection: (collection: string) => ({
      doc: (id?: string): DocRef => ({ kind: "doc", collection, id: id ?? `generated-${++nextId}` }),
      where: (field: string, _op: string, value: unknown) => query(collection, field, value)
    }),
    runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
      const writes: Array<() => void> = [];
      const merge = (ref: DocRef, data: Data) => {
        const path = `${ref.collection}/${ref.id}`;
        const next = { ...(docs.get(path) ?? {}) };
        for (const [key, value] of Object.entries(data)) {
          if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete next[key];
          else next[key] = value;
        }
        docs.set(path, next);
      };
      const result = await callback({
        get: async (ref: DocRef | QueryRef) => {
          if (ref.kind === "doc") return snapshot(ref);
          const matches = [...docs.entries()]
            .filter(([path, data]) => path.startsWith(`${ref.collection}/`) && data[ref.field] === ref.value)
            .map(([path, data]) => ({ id: path.split("/")[1], data: () => ({ ...data }) }));
          return { empty: matches.length === 0, docs: matches };
        },
        create: (ref: DocRef, data: Data) => writes.push(() => merge(ref, data)),
        update: (ref: DocRef, data: Data) => writes.push(() => merge(ref, data)),
        delete: (ref: DocRef) => writes.push(() => docs.delete(`${ref.collection}/${ref.id}`))
      });
      writes.forEach(write => write());
      return result;
    }
  };
  return { db: db as unknown as admin.firestore.Firestore, read: (path: string) => docs.get(path) };
};

const fixtures = (budget: Data | null, accountExtra: Data = { linkedBudgetId: "casa" }) => ({
  "users/u1": { activeWorkspaceId: "ws" },
  "workspaces/ws": { members: ["u1"] },
  "accounts/cash": { workspaceId: "ws", type: "cash", balance: 100, currency: "USD", ...accountExtra },
  "accounts/bank": { workspaceId: "ws", type: "checking", balance: 100, currency: "USD" },
  ...(budget ? { "budgets/casa": budget } : {})
});

const create = (db: admin.firestore.Firestore, movement: Data) => mutateWorkspaceTransaction(db, {
  kind: "created",
  userId: "u1",
  workspaceId: "ws",
  movement: { accountId: "cash", description: "Agent movement", date: new Date("2026-10-20T12:00:00Z"), ...movement } as never
});

test("agent expenses and income of a linked account carry its active budget", async () => {
  for (const [type, amount] of [["expense", -20], ["income", 20]] as const) {
    const { db, read } = fakeDb(fixtures({ workspaceId: "ws", archived: false }));
    const { id } = await create(db, { type, amount, categoryId: "food" });
    assert.equal(read(`transactions/${id}`)?.budgetId, "casa");
    assert.equal(read("accounts/cash")?.balance, 100 + amount);
  }
});

test("agent movements skip archived, foreign or missing linked budgets, and transfers never carry one", async () => {
  for (const budget of [{ workspaceId: "ws", archived: true }, { workspaceId: "other", archived: false }, null]) {
    const { db, read } = fakeDb(fixtures(budget));
    const { id } = await create(db, { type: "expense", amount: -20, categoryId: "food" });
    assert.equal("budgetId" in (read(`transactions/${id}`) ?? {}), false);
  }
  const { db, read } = fakeDb(fixtures({ workspaceId: "ws", archived: false }));
  const { id } = await create(db, { type: "transfer", amount: 20, toAccountId: "bank" });
  assert.equal("budgetId" in (read(`transactions/${id}`) ?? {}), false);
});

test("an agent-side edit into a type without budget drops the stored budget", async () => {
  const { db, read } = fakeDb({
    ...fixtures(null, {}),
    "transactions/t1": {
      workspaceId: "ws", userId: "u1", accountId: "cash", amount: -20, type: "expense", categoryId: "food",
      description: "Budgeted", currency: "USD", budgetId: "viaje", toAccountId: null
    }
  });
  await mutateWorkspaceTransaction(db, {
    kind: "updated", userId: "u1", workspaceId: "ws", transactionId: "t1",
    movement: { accountId: "cash", type: "transfer", amount: 20, toAccountId: "bank", description: "Now a transfer", date: new Date("2026-10-20T12:00:00Z") } as never
  });
  assert.equal(read("transactions/t1")?.type, "transfer");
  assert.equal("budgetId" in (read("transactions/t1") ?? {}), false);
});

test("editing an expense between a pocket-related account and a credit card updates both balances and installments", async () => {
  const { db, read } = fakeDb({
    ...fixtures(null, {}),
    "accounts/bank": { workspaceId: "ws", type: "savings", balance: 500, currency: "USD", childAccountIds: ["pocket"] },
    "accounts/pocket": {
      workspaceId: "ws", type: "savings", balance: 100, currency: "USD",
      parentAccountId: "bank", childAccountIds: [], pocketActivity: true
    },
    "accounts/card": { workspaceId: "ws", type: "credit", balance: -200, limit: 1000, currency: "USD" }
  });
  const { id } = await mutateWorkspaceTransaction(db, {
    kind: "created", userId: "u1", workspaceId: "ws",
    movement: { accountId: "bank", type: "expense", amount: -48, categoryId: "fuel", description: "Gasolina", date: new Date("2026-10-26T12:00:00Z") } as never
  });
  assert.equal(read("accounts/bank")?.balance, 452);

  await mutateWorkspaceTransaction(db, {
    kind: "updated", userId: "u1", workspaceId: "ws", transactionId: id,
    movement: { accountId: "card", type: "expense", amount: -48, installments: 3, categoryId: "fuel", description: "Gasolina", date: new Date("2026-10-26T12:00:00Z") } as never
  });
  assert.equal(read("accounts/bank")?.balance, 500);
  assert.equal(read("accounts/card")?.balance, -248);
  assert.equal(read(`transactions/${id}`)?.accountId, "card");
  assert.equal(read(`transactions/${id}`)?.installments, 3);

  await mutateWorkspaceTransaction(db, {
    kind: "updated", userId: "u1", workspaceId: "ws", transactionId: id,
    movement: { accountId: "pocket", type: "expense", amount: -30, installments: 3, categoryId: "fuel", description: "Gasolina", date: new Date("2026-10-26T12:00:00Z") } as never
  });
  assert.equal(read("accounts/card")?.balance, -200);
  assert.equal(read("accounts/pocket")?.balance, 70);
  assert.equal(read(`transactions/${id}`)?.accountId, "pocket");
  assert.equal(read(`transactions/${id}`)?.installments, 1);

  await assert.rejects(
    mutateWorkspaceTransaction(db, {
      kind: "updated", userId: "u1", workspaceId: "ws", transactionId: id,
      movement: { accountId: "pocket", toAccountId: "card", type: "transfer", amount: 30, description: "Invalid pocket card transfer", date: new Date("2026-10-26T12:00:00Z") } as never
    }),
    /Las transferencias con tarjetas requieren cuentas principales, no bolsillos/
  );
});

