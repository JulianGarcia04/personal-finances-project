# Backend audit fixes

## Objective
Fix every defect found in the 2026-10-11 backend audit (functions, Firestore/Storage rules, embeddings pipeline) so the backend is secure, consistent, and cost-bounded.

## Problem
Audit found: cross-tenant read/write through `chatWithAgent` trusting a user-writable `activeWorkspaceId` while `users/*` is world-readable to signed-in users; unrestricted workspace updates (members/owner rewrite); unbounded Gemini spend on the project key; ledger bugs in the legacy (non-pocket) path of `mutateWorkspaceTransaction` (same-account transfer adds money, no currency/amount/destination checks, mirror half-delete); non-atomic invites; 500s for auth/validation errors leaking raw messages; float drift; import without idempotency; hardcoded encryption fallback; and an embeddings pipeline where 337/534 transactions (pre 2026-08-21) have no vector, vectors go stale on edit, failures are swallowed, and 3072-float vectors are downloaded by every frontend listener.

## Why
Security (cross-tenant financial data), money correctness, cost control, and AI search quality.

## Scope
`functions/src/**`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `functions/package.json`, frontend callers only where a backend contract changes (`src/stores/*`, `src/views/Agent.vue`, `src/views/Settings.vue`), tests under `tests/` and `functions/src/**/*.test.ts`, new scripts under `scripts/`.
Out of scope: UI redesign, deploying, running production migrations (each needs explicit user authorization).

## Constraints
- Code/comments English; user-facing API error strings stay Spanish (existing convention).
- No production writes, deploys, or `gcloud`/`firebase` mutations without explicit authorization.
- Keep the pocket path contract (`pockets.ts`) and its emulator tests green.

## Decisions (defaults chosen, revisit on request)
- Only the workspace owner may invite; membership/owner changes go through functions, not client writes.
- Default (project) Gemini key gets a per-user daily quota (env-configurable; default 50 agent turns, 10 statement parses); user-provided keys are not quota-limited. `maxInstances` set on every function.
- `ENCRYPTION_SECRET` fails closed; legacy-secret ciphertexts are still decryptable and re-encrypted on next save.
- Embeddings move to a server-only collection `transactionEmbeddings/{transactionId}` (clients denied), regenerated on create/relevant update, deleted with the transaction; backfill via script.
- Pending, needs user/infra action: App Check (needs reCAPTCHA provisioning); agent write-tool confirmation UX (prompt-injection mitigation beyond membership scoping).

## Acceptance criteria
- A user cannot read another user's `users` doc nor make the agent act on a workspace they are not a member of.
- Members cannot change `members`/`ownerId`; owner-only invite is atomic.
- Legacy-path transfers: same account, mixed currency, non-positive amount, missing destination are rejected; mirror delete removes/reverses both legs or is rejected.
- Bad token → 401; bad body → 400; 500 bodies are generic.
- Every function has `maxInstances`; default-key usage is quota-limited and size-capped.
- Embeddings stored outside transaction docs, refreshed on edit, retried on failure; backfill script exists (dry-run by default).
- `pnpm --filter functions build`, `pnpm test`, `pnpm build`, emulator suites pass.

## Checks
- `pnpm --filter functions build`; `pnpm test`; `pnpm build`; `node tests/pockets.imports.emulators.mjs`; new focused tests per task; `git diff --check`.

## Tasks
- [x] T1 Access control: membership check in `chatWithAgent`; `users/{id}` read owner-only (+ shared-workspace reads if frontend needs them); workspace update field allowlist; `inviteToWorkspace` owner-only, atomic, generic response; any client member/owner writes moved to functions. Route: delegated (rules + functions + frontend callers).
- [x] T2 Request hardening: zod body validation, 401 mapping, generic 500s, empty `messages`, `apiKey` type/length, unified default-key getter, `listTransactions` cap, `saveCategoryBudgets` dotted update + category validation, `getExpensesByCategory` date filter + user timezone, remove `dotenv`. Route: delegated.
- [x] T3 Ledger correctness: legacy transfer validation, mirror-pair delete, 2-decimal rounding of balances in pockets/imports. Route: delegated.
- [ ] T4 Imports + storage: `statementImportId` idempotency, row cap, transient error mapping; storage rules size/content-type limits. Route: delegated.
- [ ] T5 Cost + secrets: `maxInstances` everywhere, message/PDF size caps, per-user daily quota for default key, `ENCRYPTION_SECRET` fail-closed with legacy decrypt. Route: delegated.
- [ ] T6 Embeddings pipeline: separate collection, shared text builder (with category), `taskType`, create/update trigger with retry + idempotency, cleanup on delete, `semanticSearch`/`indexTransactions` on new collection, backfill/migration script (dry-run default, not executed). Route: delegated.
- [ ] T7 Runtime + closure: verify Node 20 deprecation and upgrade engines if warranted; functions test script; full checks. Route: delegated.
- [ ] T8 App Check (user asked to leave for last): reCAPTCHA Enterprise/v3 provider in frontend + `enforceAppCheck`/`consumeAppCheckToken` on functions; needs user to provision the reCAPTCHA key in console. Route: delegated after key provided.

## Delivery
Forecast > 400 authored lines → PR slicing strategy to be confirmed with the user before any PR (work-unit commits per task on `fix/backend-audit`). Deploy and production backfill pending explicit authorization.

## Progress
- 2026-10-11: branch `fix/backend-audit` from `main` (e6f8c26). RDD off (clone-local), no native review.
- Engram mirror `odd/backend-audit/tasks`: PENDING (mem_save refused: multiple active runtime sessions).
- Delivery strategy: ask-on-risk (default); chain strategy to confirm before PR.
- T1 done (delegated writer; trigger: 2+ non-trivial files across rules/functions/frontend) — commit `b93d4ae`. Decisions: `users/{id}` is `get`-only for the owner or for a co-member of the requester's *active* workspace (both uids checked in the workspace doc, so a forged `activeWorkspaceId` grants nothing; `list` denied) — keeps `fetchActiveWorkspaceProfiles` working without a new function. Workspace create requires `ownerId == uid` and `members == [uid]`; member updates limited to `expenseLimit`, `budget*`, `budgetAllocations`, `categoryBudgets`, `exchangeRates`; `members`/`ownerId` server-only (frontend has no leave/remove flow, so no client transition allowed). `chatWithAgent` 403s when caller is not in the active workspace's `members`. `inviteToWorkspace` owner-only (403), single `runTransaction` (owner re-check, `arrayUnion` + `set(..., {merge:true})` on invitee), generic 200 message for unknown/already-member emails; `workspacesStore.inviteUser` returns the server message and Settings shows it. Evidence: RED `tests/access-control.rules.test.mjs` 3/11 pass on old rules → GREEN 11/11; `pnpm --filter functions build` exit 0 (Node 20 engine warning); `pnpm build` exit 0; `pnpm test` 48/48; `node tests/pockets.imports.emulators.mjs` 31/31; `git diff --check` clean. chatWithAgent/invite changes are build-verified only (no functions test runner yet; T7). Deploy rules + functions + frontend together.
- T2 done (delegated writer; trigger: functions + new helper module + tests + frontend caller) — commit `fix(functions): validate requests and map auth errors` (hash: the commit that adds this line; see `git log -- functions/src/http.ts`). New `functions/src/http.ts` (pure, unit-tested): `verifyBearerToken` (missing/malformed header and `auth/argument-error|id-token-expired|id-token-revoked|invalid-id-token|user-disabled|user-not-found` → 401; other verify failures rethrown → 500), `sendError` (HttpError → its status/message; anything else logged + generic Spanish 500), zod schemas for all four endpoints (incl. `inviteToWorkspace`; chat: 1–50 messages, roles `user|assistant|model` normalized to `user|model`, user ≤4000 chars, assistant ≤16000, last must be a non-blank user turn; apiKey trimmed 10–200; parseStatement needs non-blank `text` or `pdfBase64`, `useDefaultKey` boolean), country→IANA timezone map (fallback America/Bogota), Intl-based local month bucketing. `chatWithAgent` uses `getDefaultGeminiApiKey()`; `listTransactions` caps limit at 1–100; `getExpensesByCategory` queries `date >= local start of first month` plus `installments > 1` rows (older installment purchases still contribute), counts only rows with in-period spend, buckets in the user's timezone; new composite index `transactions(workspaceId, type, installments)`. `saveCategoryBudgets` validates every categoryId is a `categories` doc of the active workspace (`getAll`) and writes `FieldPath('categoryBudgets', id)` updates (delete for ≤0), deduped. `dotenv` import/config removed; dependency kept in `functions/package.json` because removing it needs a `pnpm-lock.yaml` update (outside this task's edit surface) — follow-up. Agent.vue sends the last 40 messages starting at a user turn, clipped to 4000/8000 chars, textarea `maxlength=4000`; settingsStore unchanged (already surfaces `error`). Evidence: RED `pnpm --filter functions build` failed (`./http` missing) → GREEN `node --test functions/lib/http.test.js` 13/13; `pnpm --filter functions build` exit 0; `pnpm build` exit 0; `pnpm test` 48/48; `node tests/pockets.imports.emulators.mjs` 31/31; `git diff --check` clean. Endpoint/tool wiring is build-verified only (no HTTP-level functions tests; T7).
- T3 done (delegated writer; trigger: functions ledger + new helper + unit and emulator tests) — commit `fix(ledger): validate legacy transfers and round balances` (hash: see `git log -- functions/src/money.ts`). Legacy (unpocketed) path of `mutateWorkspaceTransaction` now runs `assertLegacyMovement` on the new movement: amount finite and non-zero; transfers need an existing distinct destination with the same (non-empty) currency and amount > 0; signed convention kept from the app/agent schema (`income`/`loan_payment` > 0, `expense`/`loan` < 0); unknown types rejected. `legacyDeltas` accumulates per account (same-account transfer nets 0). Mirror pairs: rejected, not pair-deleted — legs live in two workspaces (bridge/receivable, settlements and reversals with `settlementType`), so the agent cannot reverse the twin within its membership scope; any update/delete whose doc has `mirrorOf`, `settlementType`, or is referenced by another doc's `mirrorOf` (queried inside the transaction) throws a Spanish error pointing to the app. New `functions/src/money.ts` `roundMoney` (cents, half away from zero, no -0); applied to movement amounts, pocket and legacy balances (before the `< 0` check), pocket opening parent balance, and import delta/next balance. Frontend has no balance rounding helper (only cents math in `src/lib/installments.ts`), so the server convention is new; historical legacy docs from the old same-account bug are not repaired. Evidence: RED build failed (`./money` missing, `assertLegacyMovement`/`legacyDeltas` not exported) and emulator suite 31/34 (3 new ledger tests failing: same-account transfer accepted, 0.30000000000000004 balance, mirror leg deleted) → GREEN `node --test functions/lib/*.test.js` 19/19; `pnpm --filter functions build` exit 0 (Node 20 engine warning); `pnpm build` exit 0; `pnpm test` 48/48; `node tests/pockets.imports.emulators.mjs` 34/34; `git diff --check` clean. New emulator tests live in `tests/pockets.integration.test.mjs` (the launcher's file list is outside the edit surface).

## Next step
T4.
