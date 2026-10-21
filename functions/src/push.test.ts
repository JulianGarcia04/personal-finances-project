import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetAlertPush,
  invalidTokensFromResponse,
  loadPushTokens,
  memberUidsOf,
  planBudgetAlertDelivery,
  PushFirestore,
  PushMessaging,
  sendPushToMembers,
  sendPushToTokens
} from "./push";

const baseInput = {
  categoryName: "Mercado",
  workspaceName: "Casa",
  spent: 850_000,
  budget: 1_000_000,
  currency: "COP",
  monthLabel: "octubre de 2026",
  workspaceId: "ws1",
  categoryId: "food"
};

/** In-memory users/{uid}/pushTokens/{token} store that records deletions. */
function fakeFirestore(tokensByUid: Record<string, string[]>, options: { failGetFor?: string } = {}) {
  const deleted: string[] = [];
  const firestore: PushFirestore = {
    collection(path: string) {
      const uid = path.split("/")[1];
      return {
        async get() {
          if (uid === options.failGetFor) throw new Error("unavailable");
          return {
            docs: (tokensByUid[uid] ?? []).map((token) => ({
              id: token,
              get: (field: string) => (field === "token" ? token : undefined),
              ref: { delete: async () => { deleted.push(`${path}/${token}`); } }
            }))
          };
        }
      };
    }
  };
  return { firestore, deleted };
}

type Outcome = "ok" | string; // error code otherwise

function fakeMessaging(outcomeFor: (token: string) => Outcome = () => "ok", options: { throwOnCall?: number } = {}) {
  const calls: Array<{ tokens: string[]; message: Record<string, unknown> }> = [];
  const messaging: PushMessaging = {
    async sendEachForMulticast(message) {
      calls.push({ tokens: message.tokens, message: message as unknown as Record<string, unknown> });
      if (options.throwOnCall === calls.length) throw new Error("fcm down");
      const responses = message.tokens.map((token) => {
        const outcome = outcomeFor(token);
        return outcome === "ok"
          ? { success: true, messageId: `m-${token}` }
          : { success: false, error: { code: outcome, message: outcome } as any };
      });
      const successCount = responses.filter((r) => r.success).length;
      return { responses, successCount, failureCount: responses.length - successCount };
    }
  };
  return { messaging, calls };
}

test("80% push says the cap is near, with spend, budget and percent", () => {
  const push = buildBudgetAlertPush({ ...baseInput, threshold: 80 });
  assert.match(push.notification!.title!, /cerca del tope de Mercado \(85 %\)/);
  assert.match(push.notification!.body!, /Llevas .*850\.000.* de .*1\.000\.000/);
  assert.match(push.notification!.body!, /Casa · octubre de 2026/);
  assert.deepEqual(push.data, { link: "/goals", workspaceId: "ws1", categoryId: "food", threshold: "80" });
  const named = buildBudgetAlertPush({ ...baseInput, threshold: 80, budgetId: "house", budgetName: "Hogar" });
  assert.equal(named.data!.budgetId, "house");
  assert.match(named.notification!.title!, /Mercado \(Hogar\)/);
  assert.match(named.notification!.body!, /Casa · Hogar · octubre de 2026/);
});

test("100% push says the cap was reached and shows the overspend", () => {
  const push = buildBudgetAlertPush({ ...baseInput, threshold: 100, spent: 1_200_000 });
  assert.match(push.notification!.title!, /Ya alcanzaste el tope de Mercado/);
  assert.match(push.notification!.body!, /te pasaste por .*200\.000/);
  assert.equal(push.data!.threshold, "100");
});

test("push title matches the email subject copy", async () => {
  const { renderBudgetAlertEmail } = await import("./templates/budgetAlert");
  for (const threshold of [80, 100] as const) {
    const push = buildBudgetAlertPush({ ...baseInput, threshold });
    assert.equal(push.notification!.title, renderBudgetAlertEmail({ ...baseInput, threshold }).subject);
  }
});

test("push sets an absolute https click link only when an app URL is available", () => {
  assert.equal(buildBudgetAlertPush({ ...baseInput, threshold: 80 }).webpush, undefined);
  assert.equal(buildBudgetAlertPush({ ...baseInput, threshold: 80, appUrl: "not a url" }).webpush, undefined);
  assert.equal(buildBudgetAlertPush({ ...baseInput, threshold: 80, appUrl: "http://insecure.example" }).webpush, undefined);
  const push = buildBudgetAlertPush({ ...baseInput, threshold: 80, appUrl: "https://vault.example.app/" });
  assert.equal(push.webpush?.fcmOptions?.link, "https://vault.example.app/goals");
  assert.equal(push.data!.link, "/goals");
});

test("invalidTokensFromResponse keeps only unregistered or invalid tokens", () => {
  const tokens = ["a", "b", "c", "d", "e"];
  const response = {
    successCount: 1,
    failureCount: 4,
    responses: [
      { success: true, messageId: "1" },
      { success: false, error: { code: "messaging/registration-token-not-registered" } as any },
      { success: false, error: { code: "messaging/invalid-registration-token" } as any },
      { success: false, error: { code: "messaging/internal-error" } as any },
      { success: false, error: { code: "messaging/invalid-argument" } as any }
    ]
  };
  assert.deepEqual(invalidTokensFromResponse(tokens, response), ["b", "c"]);
});

test("memberUidsOf keeps unique non-empty string uids", () => {
  assert.deepEqual(memberUidsOf(["u1", "", 3, null, "u2", "u1"]), ["u1", "u2"]);
  assert.deepEqual(memberUidsOf(undefined), []);
});

test("loadPushTokens reads every member's tokens, dedupes, and skips a member whose read fails", async () => {
  const { firestore } = fakeFirestore({ u1: ["t1", "t2"], u2: ["t2", "t3"], u3: ["t9"] }, { failGetFor: "u3" });
  const entries = await loadPushTokens(["u1", "u2", "u3"], firestore);
  assert.deepEqual(entries.map((e) => e.token), ["t1", "t2", "t3"]);
  assert.equal(entries.find((e) => e.token === "t2")!.refs.length, 2);
});

test("sendPushToMembers chunks multicast sends at 500 tokens", async () => {
  const tokens = Array.from({ length: 1001 }, (_, i) => `t${i}`);
  const { firestore } = fakeFirestore({ u1: tokens.slice(0, 600), u2: tokens.slice(600) });
  const { messaging, calls } = fakeMessaging();
  const result = await sendPushToMembers(["u1", "u2"], buildBudgetAlertPush({ ...baseInput, threshold: 80 }), { firestore, messaging });
  assert.deepEqual(calls.map((c) => c.tokens.length), [500, 500, 1]);
  assert.deepEqual(result, { tokens: 1001, sent: 1001, failed: 0, removed: 0 });
  assert.equal((calls[0].message.data as Record<string, string>).categoryId, "food");
});

test("sendPushToMembers deletes invalid token docs (for every owner) and keeps transient failures", async () => {
  const { firestore, deleted } = fakeFirestore({ u1: ["good", "gone"], u2: ["gone", "bad", "flaky"] });
  const { messaging } = fakeMessaging((token) => ({
    gone: "messaging/registration-token-not-registered",
    bad: "messaging/invalid-registration-token",
    flaky: "messaging/internal-error"
  }[token] ?? "ok"));
  const result = await sendPushToMembers(["u1", "u2"], buildBudgetAlertPush({ ...baseInput, threshold: 100 }), { firestore, messaging });
  assert.deepEqual(result, { tokens: 4, sent: 1, failed: 3, removed: 2 });
  assert.deepEqual(deleted.sort(), ["users/u1/pushTokens/gone", "users/u2/pushTokens/bad", "users/u2/pushTokens/gone"]);
});

test("push failures never throw: a failed chunk counts as failed and later chunks still send", async () => {
  const tokens = Array.from({ length: 501 }, (_, i) => `t${i}`);
  const { firestore, deleted } = fakeFirestore({ u1: tokens });
  const { messaging, calls } = fakeMessaging(() => "ok", { throwOnCall: 1 });
  const result = await sendPushToMembers(["u1"], buildBudgetAlertPush({ ...baseInput, threshold: 80 }), { firestore, messaging });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { tokens: 501, sent: 1, failed: 500, removed: 0 });
  assert.deepEqual(deleted, []);
});

test("push failures never throw: token cleanup errors are swallowed", async () => {
  const firestore: PushFirestore = {
    collection: () => ({
      get: async () => ({
        docs: [{ id: "gone", get: () => "gone", ref: { delete: async () => { throw new Error("denied"); } } }]
      })
    })
  };
  const { messaging } = fakeMessaging(() => "messaging/registration-token-not-registered");
  const result = await sendPushToTokens(await loadPushTokens(["u1"], firestore), buildBudgetAlertPush({ ...baseInput, threshold: 80 }), messaging);
  assert.deepEqual(result, { tokens: 1, sent: 0, failed: 1, removed: 0 });
});

test("sendPushToTokens with no tokens does not call FCM", async () => {
  const { messaging, calls } = fakeMessaging();
  const result = await sendPushToTokens([], buildBudgetAlertPush({ ...baseInput, threshold: 80 }), messaging);
  assert.equal(calls.length, 0);
  assert.deepEqual(result, { tokens: 0, sent: 0, failed: 0, removed: 0 });
});

test("delivery plan: SMTP and tokens -> claim, email and push", () => {
  assert.deepEqual(planBudgetAlertDelivery({ smtpConfigured: true, pushTokenCount: 2 }), { claim: true, email: true, push: true });
});

test("delivery plan: SMTP without tokens -> claim and email only", () => {
  assert.deepEqual(planBudgetAlertDelivery({ smtpConfigured: true, pushTokenCount: 0 }), { claim: true, email: true, push: false });
});

test("delivery plan: tokens without SMTP -> claim and push only", () => {
  assert.deepEqual(planBudgetAlertDelivery({ smtpConfigured: false, pushTokenCount: 1 }), { claim: true, email: false, push: true });
});

test("delivery plan: neither SMTP nor tokens -> no claim", () => {
  assert.deepEqual(planBudgetAlertDelivery({ smtpConfigured: false, pushTokenCount: 0 }), { claim: false, email: false, push: false });
});
