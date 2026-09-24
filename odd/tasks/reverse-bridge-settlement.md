# Feature: Auditable reversal of a workspace bridge settlement

## Objective
Let a user correct a bridge settlement entered against the wrong account, so Vault's projected account balances match the user's real bank activity while retaining an auditable ledger history.

## Problem and rationale
A workspace bridge settlement updates the balances of accounts in both workspaces. If the user selects the wrong account, the resulting projections are wrong. The existing generic deletion restores balances but hard-deletes both linked settlement rows, losing the audit trail and offering no settlement-specific safety checks.

## Accepted behavior and scope
- Add an explicit **Revert settlement** action for valid workspace-bridge settlement records.
- Reversal is accounting-only: it does not move, return, or initiate real-world money.
- Preserve the original settlement records and add linked compensating records; mark the original pair reversed atomically and idempotently.
- Restore the app balances and bridge balance to the pre-settlement state, leaving the amount outstanding again. The user can then record the already-completed real payment with the correct accounts as a separate settlement.
- Support legacy settlements only when their paired records can be identified and validated unambiguously; fail closed otherwise.
- Keep the settlement change limited to reversals. Do not alter bridge sharing, bank integrations, generic transaction deletion, or other workspace behaviors.
- The user additionally authorized a bounded investigation and fix for the existing failure at `src/lib/loan.test.ts:13`, so the full test suite can pass. Keep this separate from settlement behavior: `loan` is a negative outgoing amount; `loan_payment` remains positive incoming money. Update schema sign validation and store normalization consistently.

## Constraints and risks
- A settlement has two transfer records across two workspaces and updates four accounts. Both workspace memberships are required; every document update must succeed or none may persist.
- Do not treat every reciprocal `mirrorOf` transfer as a settlement: other mirrored activity uses that link too.
- Validate both reciprocal links, transaction types, account/workspace associations, amounts, currencies, and reversal state before applying any balance delta.
- A retry or concurrent second reversal must not apply balance changes twice.
- The UI must clearly state that this only corrects Vault's accounting and does not undo the real bank transfer.
- Preserve unrelated pre-existing local changes in `.atl/` and `.gitignore`; never stage them.

## Route and delivery
- Route: delegated direct implementation, one bounded writer.
- Trigger evidence: settlement implementation required coordinated changes to types, Firestore transaction logic, transaction-history UI, and tests. A separate read-only mapper identified the loan sign mismatch and exact three-file fix surface; the multi-file loan fix will use one bounded writer.
- Parent owns product scope, this feature document, task/memory reconciliation, branch, verification, review assessment, and delivery.
- Delivery strategy: `ask-on-risk` (default); after the authorized loan fix the measured source diff is 568 authored changed lines (560 additions and 8 deletions, excluding the tracking document and pre-existing user changes). The settlement portion alone measured 555 lines before the loan fix.
- Chain strategy: `feature-branch-chain`, explicitly selected by the user after the measured diff exceeded about 400 lines. Apply a coherent review-slice plan; do not split by file type or code-golf. If no cohesive slice fits, report the smallest honest count and a size-exception recommendation rather than forcing a split.
- Local chain plan: tracker `feat/reverse-bridge-settlement` carries the loan-sign fix and this task record; child `feat/reverse-bridge-settlement-01-domain` adds settlement types/planner/tests (~263 lines); child `feat/reverse-bridge-settlement-02-integration` adds the Firestore-store and transaction-history wiring (~292 source lines plus final task-document evidence). Measure actual each slice before commit.
- Delivery authorization: the user explicitly authorized a direct push to `main` and deployment. No PR is requested.
- Branch: `feat/reverse-bridge-settlement` (created from the default `main` branch).
- Work-unit commit 1 is on the tracker branch: `241ee702d254aa88da640cd5d669eec632b9f2f8` — `fix(loans): keep loan outflows negative`. Its commit-local diff is 94 insertions and 4 deletions (98 changed lines), including the task record.
- Post-commit verifier confirmed the commit scope and passed loan 3/3, full suite 25/25, and build; commands ran against the current worktree, not an isolated checkout.
- Work-unit commit 2 is on `feat/reverse-bridge-settlement-01-domain`: `540f24d78a310876fd953709d72dd61048b0d400` — `feat(bridges): model settlement reversals`. Its commit-local diff is 262 insertions and 1 deletion across types, planner, and planner tests.
- Independent verifier found no blocking issue in commit 2 and passed mirror 12/12, full suite 25/25, and build against the current worktree (not isolated). It noted several implemented rejection branches lack focused tests; Firestore behavior is not integration-tested.
- Work-unit commit 3 is on `feat/reverse-bridge-settlement-02-integration`: `be8ffd5511a5b18be404975602b400e33304be29` — `feat(bridges): wire settlement reversal`. Its commit-local diff is 299 insertions and 9 deletions across the store, UI, and task record.
- Independent verifier found no blocking issue: the transaction validates/reads before writes, commits compensations, markers, and balances atomically, and concurrent retries fail closed. Loan 3/3, mirror 12/12, full suite 25/25, and build passed against the current worktree, which matched HEAD.
- Direct push completed: `origin/main` advanced from `ca658c954b58de6f68629b163c656d1f71cacf46` to `cf25c4a0e5cef45a6281aa0fd45275cb19f6cad5`; no PR was created.
- Firebase Hosting deployment completed for project `vault-41b34` with `--only hosting`; build passed, 31 `dist` files deployed, and `https://vault-41b34.web.app/` served the expected app HTML. Functions and database/storage rules were not deployed.

## TDD and checks
- TDD: **on**, explicitly selected by the user for this feature; strict RED then GREEN. No project-level TDD setting was found.
- Test runner: `pnpm test` (`node --test src/**/*.test.ts` from the root package).
- RED: writer reports `pnpm test` failed after adding the reversal test and before production edits because the reversal planner was not exported; the same run showed the loan-sign failure below.
- Focused GREEN: writer and independent verifier report `node --test src/lib/mirror.test.ts` passed, 12/12. Post-commit verifiers for domain and integration slices reran this successfully.
- Loan-fix RED: writer reports `node --test src/lib/loan.test.ts` failed before production edits because `TransactionSchema` rejected negative `loan` (1 failure).
- Loan-fix GREEN: writer reports the same targeted command passed after edits (3/3), with sign regressions for `loan` and `loan_payment`. The post-commit integration verifier reran this successfully.
- Full suite: writer and independent verifier report `pnpm test` passed, 25/25. Post-commit verifiers for all three work-unit commits reran it successfully against the current worktree.
- Build: writer and independent verifier report `pnpm build` passed; Vite transformed 1,823 modules. Post-commit verifiers for all three work-unit commits reran it successfully against the current worktree.
- Coverage limitations: loan schema cases are directly tested, but `normalizeTransactionAmount` lacks a direct unit test; writer avoided exposing the internal helper. Some planner rejection branches lack focused tests. No authenticated two-workspace emulator fixture covers Firestore writes/concurrency, and UI behavior was not tested interactively.
- Work-unit rollback boundary: the feature's source and test files listed under the implementation task below, plus this feature document; preserve all unrelated working-tree changes.

## Acceptance criteria
1. A valid bridge settlement can be reversed from the transaction history, with a confirmation that explains the accounting-only effect.
2. Reversal preserves the original pair, adds compensating paired transfers, updates both workspaces' account balances and the bridge balance atomically, and marks the original pair reversed.
3. Repeated/concurrent attempts, broken or mismatched pairs, non-settlement pairs, and already-reversed pairs fail without duplicate balance changes.
4. Valid older settlement rows can be reversed only through strict legacy validation; ambiguous rows do not expose an unsafe action.
5. The user can then record the correct account selection separately, without implying or causing another real-world payment.
6. Focused reversal and loan tests pass; the schema accepts negative `loan`, rejects positive `loan`, accepts positive `loan_payment`, and rejects negative `loan_payment`; `normalizeTransactionAmount` keeps loan outflows negative; the full `pnpm test` suite and production build pass.

## Tasks and progress
- [x] `RBS-1` — Explore existing bridge-settlement representation, workspace security, and generic deletion behavior. Evidence: delegated read-only mapping of `src/lib/mirror.ts`, `src/stores/transactionsStore.ts`, `src/types.ts`, `src/views/Transactions.vue`, and `firestore.rules`.
- [x] `RBS-2` — Clarify correction semantics and TDD mode. User confirmed that the account projections are wrong after an incorrect account selection, selected implementation, and explicitly chose strict TDD. Correction affects Vault's ledger only; no actual bank transfer is initiated.
- [x] `RBS-3` — Add a failing test for settlement-reversal validation/planning behavior before implementation. Writer reports the focused RED and GREEN evidence above.
- [x] `RBS-4` — Implement atomic, idempotent, auditable settlement reversal with safe legacy classification. Writer reports implementation in the store and helper.
- [x] `RBS-5` — Add transaction-history affordance, confirmation, and reversed-state presentation with accounting-only wording. Writer reports implementation in `src/views/Transactions.vue`.
- [x] `RBS-6` — Map the authorized `src/lib/loan.test.ts:13` failure. Evidence: `loan` is expected negative but schema treats all non-expense types as positive; store normalizer also forces `loan` positive.
- [x] `RBS-7` — Add failing loan sign regression tests, then align schema sign validation and store normalization. Writer reports strict RED then GREEN.
- [x] `RBS-8` — Independently verify all changed behavior, focused/full tests, and build. Evidence: loan 3/3, mirror 12/12, full suite 25/25, build passed; no blocking code defect found. Record the untested normalizer and Firestore emulator paths as limitations.
- [x] `RBS-9` — Complete the selected local feature-branch chain without artificial splitting. The tracker, domain-planner, and store/UI integration slices are committed and pushed to `main`; unrelated working-tree changes remain unstaged and outside the chain.
- [x] `RBS-10` — Record the commit identities, independent checks, coverage limitations, direct push to `main`, and successful Hosting deployment. No PR was requested.

## Authorized implementation surfaces
### Settlement reversal
- `src/types.ts`
- `src/stores/transactionsStore.ts`
- `src/views/Transactions.vue`
- `src/lib/mirror.ts`
- `src/lib/mirror.test.ts`
- `src/stores/transactionsStore.test.ts` (new file only if needed for focused store behavior)

### User-authorized loan-test fix
- `src/lib/loan.test.ts`
- `src/schemas.ts` (transaction type sign validation)
- `src/stores/transactionsStore.ts`, limited to `normalizeTransactionAmount` and its direct usage if needed
- No other loan-related paths are authorized.

## Current status and next step
The implementation chain is on `main`: tracker `feat/reverse-bridge-settlement` at `241ee702d254aa88da640cd5d669eec632b9f2f8`, domain child `feat/reverse-bridge-settlement-01-domain` at `540f24d78a310876fd953709d72dd61048b0d400`, and integration child `feat/reverse-bridge-settlement-02-integration` at `be8ffd5511a5b18be404975602b400e33304be29`; delivery-record commit `cf25c4a0e5cef45a6281aa0fd45275cb19f6cad5` is the pushed `main` tip. Independent verification found no blockers; loan 3/3, mirror 12/12, full suite 25/25, and production build passed (checks ran on current worktrees, not isolated checkouts). Hosting deploy to `vault-41b34` completed and the site returned expected HTML at `https://vault-41b34.web.app/`; only Hosting was deployed. Native assessments remained unassessable/schema-incompatible and were followed by independent verification. Coverage limits: no direct normalizer unit test, some planner rejection paths untested, no authenticated two-workspace Firestore emulator or interactive UI test. No PR was created. Existing `.atl/.skill-registry.cache.json`, `.atl/skill-registry.md`, and `.gitignore` remain untouched and unstaged.