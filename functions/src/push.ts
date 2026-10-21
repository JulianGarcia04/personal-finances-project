// Firebase Cloud Messaging web push for budget alerts. firebase-admin is injected
// (types only here) so this module is unit-testable without emulators.
// Token contract (written by the web client): users/{uid}/pushTokens/{token}
// with { token, userAgent, createdAt }. Tokens are never logged.
import type { BatchResponse, MulticastMessage } from "firebase-admin/messaging";
import { budgetAlertCopy, BudgetAlertEmailInput } from "./templates/budgetAlert";

/** FCM caps sendEachForMulticast at 500 tokens per call. */
export const FCM_MULTICAST_LIMIT = 500;
export const PUSH_TOKENS_SUBCOLLECTION = "pushTokens";
export const BUDGET_ALERT_PUSH_PATH = "/goals";

/**
 * Error codes that mean the token itself is dead and its doc should be deleted.
 * `messaging/invalid-argument` is deliberately excluded: FCM also returns it for
 * payload problems, so deleting on it could wipe valid tokens.
 */
const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token"
]);

export type PushPayload = Omit<MulticastMessage, "tokens">;

export interface BudgetAlertPushInput extends BudgetAlertEmailInput {
  workspaceId: string;
  categoryId: string;
  /** Operating budget id; sent only for additional (non-default) budgets. */
  budgetId?: string;
  /** Public app origin (https). When absent the client resolves `data.link`. */
  appUrl?: string;
}

export interface PushTokenEntry {
  token: string;
  /** Every token doc holding this token (the same device may be registered by several members). */
  refs: Array<{ delete(): Promise<unknown> }>;
}

export interface PushFirestore {
  collection(path: string): {
    get(): Promise<{ docs: Array<{ id: string; get(field: string): unknown; ref: { delete(): Promise<unknown> } }> }>;
  };
}

export interface PushMessaging {
  sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
}

export interface PushSendResult {
  tokens: number;
  sent: number;
  failed: number;
  removed: number;
}

/** Absolute https URL for `path` on `appUrl`, or null when appUrl is missing/invalid/not https. */
function absoluteHttpsLink(appUrl: string | undefined, path: string): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(path, appUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function buildBudgetAlertPush(input: BudgetAlertPushInput): PushPayload {
  const { reached, percent, overspend, scope, subject, money } = budgetAlertCopy(input);
  const amounts = `${money(input.spent)} de ${money(input.budget)}`;
  const body = reached
    ? `Llevas ${amounts}${overspend > 0 ? ` (te pasaste por ${money(overspend)})` : ""}. ${scope}`
    : `Llevas ${amounts} (${percent} %). ${scope}`;
  const payload: PushPayload = {
    notification: { title: subject, body },
    // FCM data values must be strings.
    data: {
      link: BUDGET_ALERT_PUSH_PATH,
      workspaceId: input.workspaceId,
      categoryId: input.categoryId,
      threshold: String(input.threshold),
      ...(input.budgetId ? { budgetId: input.budgetId } : {})
    }
  };
  const link = absoluteHttpsLink(input.appUrl, BUDGET_ALERT_PUSH_PATH);
  if (link) payload.webpush = { fcmOptions: { link } };
  return payload;
}

/** Tokens whose send failed because the token is unregistered or malformed. */
export function invalidTokensFromResponse(tokens: readonly string[], response: Pick<BatchResponse, "responses">): string[] {
  return tokens.filter((_, index) => {
    const result = response.responses[index];
    return !!result && !result.success && INVALID_TOKEN_CODES.has(result.error?.code ?? "");
  });
}

/** Unique, non-empty string uids from workspaces/{id}.members. */
export function memberUidsOf(members: unknown): string[] {
  if (!Array.isArray(members)) return [];
  return [...new Set(members.filter((uid): uid is string => typeof uid === "string" && uid.length > 0))];
}

/** Every registered token of the members, deduped. A member whose read fails is skipped. */
export async function loadPushTokens(memberUids: readonly string[], firestore: PushFirestore): Promise<PushTokenEntry[]> {
  const byToken = new Map<string, PushTokenEntry>();
  const snapshots = await Promise.all(memberUids.map((uid) =>
    firestore.collection(`users/${uid}/${PUSH_TOKENS_SUBCOLLECTION}`).get().catch(() => null)));
  for (const snapshot of snapshots) {
    for (const doc of snapshot?.docs ?? []) {
      const stored = doc.get("token");
      const token = typeof stored === "string" && stored ? stored : doc.id;
      const entry = byToken.get(token) ?? { token, refs: [] };
      entry.refs.push(doc.ref);
      byToken.set(token, entry);
    }
  }
  return [...byToken.values()];
}

/** Sends in chunks of 500 and deletes dead tokens. Never throws. */
export async function sendPushToTokens(
  entries: readonly PushTokenEntry[],
  payload: PushPayload,
  messaging: PushMessaging
): Promise<PushSendResult> {
  const result: PushSendResult = { tokens: entries.length, sent: 0, failed: 0, removed: 0 };
  for (let start = 0; start < entries.length; start += FCM_MULTICAST_LIMIT) {
    const chunk = entries.slice(start, start + FCM_MULTICAST_LIMIT);
    const tokens = chunk.map((entry) => entry.token);
    let response: BatchResponse;
    try {
      response = await messaging.sendEachForMulticast({ ...payload, tokens });
    } catch {
      result.failed += chunk.length;
      continue;
    }
    result.sent += response.successCount;
    result.failed += response.failureCount;
    const invalid = new Set(invalidTokensFromResponse(tokens, response));
    const deletions = chunk
      .filter((entry) => invalid.has(entry.token))
      .map(async (entry) => {
        const outcomes = await Promise.allSettled(entry.refs.map((ref) => ref.delete()));
        return outcomes.every((outcome) => outcome.status === "fulfilled");
      });
    result.removed += (await Promise.all(deletions)).filter(Boolean).length;
  }
  return result;
}

export async function sendPushToMembers(
  memberUids: readonly string[],
  payload: PushPayload,
  deps: { firestore: PushFirestore; messaging: PushMessaging }
): Promise<PushSendResult> {
  return sendPushToTokens(await loadPushTokens(memberUids, deps.firestore), payload, deps.messaging);
}

export interface BudgetAlertDeliveryPlan {
  /** Claim the threshold in the ledger (only when at least one channel can deliver). */
  claim: boolean;
  email: boolean;
  push: boolean;
}

/** Which channels deliver a newly reached threshold; no channel means no claim. */
export function planBudgetAlertDelivery(input: { smtpConfigured: boolean; pushTokenCount: number }): BudgetAlertDeliveryPlan {
  const email = input.smtpConfigured;
  const push = input.pushTokenCount > 0;
  return { claim: email || push, email, push };
}
