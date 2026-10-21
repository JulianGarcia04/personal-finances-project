# Bridge settlements with accounts that have pockets
Allow cross-workspace bridge settlements (and their reversal/deletion) to use root bank accounts that have pockets.
Branch: `feat/settlement-pockets` → `main` · Delivery: ask-on-risk; no push, merge or deploy requested yet · Checks: `pnpm test`, `pnpm test:functions`, `pnpm build`, emulator suites when available.

## Specs
- S1: "no se puede hacer liquidación de cuentas puentes a cuenta que tengan bolsillos quiero que se quite esa restricción"
- S2 (accepted proposal, "si hazlo como vos sugerís"): settlements that touch an account with pockets run on the server (Admin SDK), validating membership in both workspaces, exact amounts, and writing the pocket movement markers.
- S3 (accepted proposal): both sides are allowed — the paying account (active workspace) and the receiving account (mirror workspace) may be root bank accounts with pockets.
- S4 (accepted proposal): those settlements can also be reversed or deleted; the operation is refused when it would leave the available balance of an account with pockets negative.
- S5 (accepted proposal): settling directly into or from a pocket (child account) stays blocked; only the main account is allowed.
- S6 (invariant, assumption): settlements without pocket-related accounts keep the current client path and behavior unchanged.

## Tasks
- T1 [done] — S1–S6 — Server settlement path for pocket-related endpoints (settle, reverse, delete), client routing, UI selectors, tests and docs. Route: inline (one dependent behavior; mapping explorer for settlement/test infrastructure). Risk: item 1 (balances) and item 2 (server writes bypassing rules). Commits: `19e1ec6`, `1ea3d92`; independent verifier PASS S1–S6.

## Log
### L1 — Original request (verbatim, 2026-10-21)
no se puede hacer liquidación de cuentas puentes a cuenta que tengan bolsillos quiero que se quite esa restricción, obviamente sin antes decirme por que se hizo así

### L2 — Diagnosis
Restriction added in `b710dde` (make pocket movements atomic). Pocket-related balances only change via movements with `lastPocketMovementId` markers validated by firestore.rules:150-173; pocket movement shapes reject `mirrorOf` (rules:272, 297) and the server movement engine accepts a single workspace (functions/src/pockets.ts:300). Settlements are two cross-workspace `mirrorOf` transfers updating four balances, so the combination was blocked as a scope cut (transactionsStore.ts:866, :994, :1070). Removing only the client check would yield `permission-denied`.

### L3 — Authorization (verbatim, 2026-10-21)
si hazlo como vos sugerís

### L4 — Implementation and observed checks
New callable `bridgeSettlement` (functions/src/settlements.ts: settle/reverse/delete via Admin SDK) and import-free port functions/src/settlementPlan.ts of the src/lib/mirror.ts math, kept in parity by tests/runner/settlementPlan.test.ts. The client keeps its transaction path and throws `SettlementMustUseServer` when an involved account is pocket-related, then calls the callable; `deleteMirrorPair` pre-reads leg accounts to choose the route and `deleteTransaction` sends `mirrorOf` docs there before the pocket branch. Server rules: membership in both workspaces with the active one current, pocket children refused, registry vs child accounts audited, negative available balance refused on pocket-related accounts, markers stamped only on those. Accounts.vue selectors hide pockets. Delete of a pair keeps baseline semantics (no extra guards on reversal pairs).
RED: emulator suites 46 pass / 7 fail, all failing on "Las liquidaciones de cuentas puente no se pueden combinar con bolsillos."; parity test failed with ERR_MODULE_NOT_FOUND; selector test failed against the base Accounts.vue.
GREEN: `node tests/pockets.imports.emulators.mjs` 53/53; `pnpm test` 223/223; `pnpm test:functions` 171/171; `pnpm build` OK. Baseline emulator run before changes: 44/44. Commit `19e1ec6`. RDD: off (clone-local), no native review. Independent verifier launched for Risk items 1 and 2.

### L5 — Independent verification and correction
Verifier: no blockers; S1–S6 PASS with 21 extra emulator probes (authorization, exact deltas, cents, rejected-command invariance, later client pocket operations, pocket-free paths kept on the client). One correction batch: the server now refuses bridges mirrored to their own workspace (a crafted setup where `to === from` dropped a delta) and the delete rejection message names the real reason. RED 53 pass / 1 fail on the new test; GREEN emulators 54/54, `pnpm test:functions` 171/171. Commit `1ea3d92`.
Follow-ups (pre-existing at baseline, not fixed): deleting an already-reversed settlement reverts balances twice and deleting a reversal pair leaves `reversedBy` on the originals; the client path has the same same-workspace-mirror defect for accounts without pockets. Advisories kept: server rounds amounts to cents (client path does not); server does not compare `mirror.sourceAccountId`; existence of IDs is distinguishable before the membership check (random IDs). Next: push, merge and deploy (`functions:bridgeSettlement` + hosting) await the user's decision.
