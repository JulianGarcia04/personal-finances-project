# Account pockets with conserved bank totals

## Objective

Allow named pockets beneath bank accounts, such as Nu cajitas and Bancolombia bolsillos, without double-counting existing money.

## Confirmed intent

- The bank balance currently recorded in Vault **includes** the money already held in its pockets (user confirmation).
- Creating a pocket with an initial amount must split that amount from the parent's available balance, not increase the combined bank balance or net worth.
- Moving existing money between a bank and its pockets is a neutral transfer, not income or expense.
- Show available money, pocket money, and the combined bank total distinctly.

## Scope and constraints

- Preserve legacy account IDs, balances, transaction references, and workspace isolation.
- Use a one-level hierarchy; eligible parents are ordinary checking/savings accounts. Currency and workspace must match.
- Make funded initialization and pocket movement, edit, and reversal atomic; reject insufficient funds without partial writes.
- Protect hierarchy integrity, parent metadata changes, and deletion dependencies in all supported client and Admin write paths.
- Do not silently delete financial history, cascade-delete funded pockets, or reuse expense-based goal contributions for pocket allocation.
- Preserve existing mirrors, credit cards, loans, installment behavior, and unrelated ordinary-account paths.
- Pockets retain the existing savings-account income/expense/transfer semantics; do not silently make them transfer-only. Internal allocation conserves total wealth, whereas actual income or expenses change it normally. Transfers involving a pocket must use matching currencies.
- Technical documentation and identifiers are English. Existing Spanish UI copy should remain consistent with the current app.
- User authorized configuration-only Firestore metadata lookup for `vault-41b34` using the existing local Firebase CLI session. This lookup is complete; no financial-document access, remote writes, live balance migration, deploy, push, PR creation, or merge is authorized.
- Verified target: `projects/vault-41b34/databases/(default)`, edition **STANDARD**, type **FIRESTORE_NATIVE**, location **nam5**. Use the Firestore skill's Standard edition references; do not infer edition from the client SDK.
- Resolve any additional consequential product gaps before implementation; do not silently restrict pocket transaction capabilities merely to reduce scope.

## Delivery and recovery

- Feature branch: `feat/account-pockets`.
- Branch point / initial reviewed boundary: `8877aa2746525ba46806024616d7f7e71a8ee05c`.
- Last reviewed boundary: **`7ef188dd602523dfd2e2f130bb4261a59facda2b`**, AP-01 approved and exactly acknowledged.
- Delivery strategy: `ask-on-risk`.
- Chain strategy: **`feature-branch-chain`**, explicitly selected by the user (option 1). Keep the full feature isolated until completion and verification.
- Revised forecast: approximately **3,650–4,300 authored additions + deletions**, excluding generated output and this tracking document. AP-01 is 1,503 lines and AP-02 is 1,392; a required import-compatibility boundary and hierarchy UI remain. Earlier 1,100–1,550 and 2,150–2,400 estimates underestimated actual persistence/rules proof and import compatibility. These are planning estimates, not code-size caps.
- Running committed implementation/proof authored count: **1,503**. AP-01's committed tracking document adds 104 lines, so native candidate assessment counts **1,607** total changed lines.
- Planned local slice branches: `feat/account-pockets-01-lifecycle` → `feat/account-pockets`; `feat/account-pockets-02-movements` → `feat/account-pockets-01-lifecycle`; `feat/account-pockets-02b-import` → `feat/account-pockets-02-movements`; `feat/account-pockets-03-ui` → `feat/account-pockets-02b-import`.
- Current implementation slice: **`feat/account-pockets-02-movements`**, created from AP-01 commit `7ef188dd602523dfd2e2f130bb4261a59facda2b`. AP-01 remains on `feat/account-pockets-01-lifecycle`. Planned first child PR boundary is `8877aa2746525ba46806024616d7f7e71a8ee05c..7ef188dd602523dfd2e2f130bb4261a59facda2b`; PRs are not created and no remote publishing or merge is authorized.
- RDD: **on, decided by default**, observed through `gentle-ai review mode status`.
- Each task requires observed checks and a Conventional Commit on the feature branch. No AI attribution or Co-Authored-By trailer.
- Source-mutating normalization must precede functional verification and native candidate freeze. Follow only native review continuations and candidate-specific consent.
- One bounded slicing pass observed **1,503 authored lines** for AP-01 (1,447 additions, 56 deletions): 862 production/rules and 641 local proof. Keep the already-verified cohesive lifecycle boundary. A 147-line domain split leaves 1,356 lines; separating Admin coverage requires new edits to retain immediate bypass guards. No straightforward verified partition with every slice ≤400 was found. Stop reshaping; recommend explicit **`size:exception`** acceptance before any future PR containing this boundary. No PR or size exception is approved by this local commit.
- One bounded AP-02 slicing pass observed **1,392 authored lines** (1,283 additions, 109 deletions). Keep the verified movement boundary: create/edit/reversal share combined deltas, client/Admin mutation helpers, correlated rules, and overlapping/concurrent proof. An 81-line domain split leaves 1,311 lines; separating shared operations requires new intermediate candidates and proof. No straightforward safe as-is all-≤400 partition was found. Recommend explicit **`size:exception`** acceptance for a future AP-02 PR; no PR is authorized.
- Engram mirror: **pending** under `odd/account-pockets/tasks`; mutation tools are blocked by a runtime-session-resolution hook. Keep this complete local document and retry synchronization only when available.

## Tasks

- [x] **AP-01 — Safely initialize and maintain named pockets.**
  - Outcome: hierarchy contracts, inclusive-balance initialization, atomic persistence, compatible AI creation, edit/deletion guards, and matching security policy.
  - Route: **delegated direct**. Trigger: multiple non-trivial model/store/backend/rules files and research preparing writes.
  - Candidate surfaces: `src/types.ts`, `src/schemas.ts`, `src/lib/pockets.ts`, `src/lib/pockets.test.ts`, `src/stores/accountsStore.ts`, `functions/src/index.ts`, `functions/src/pockets.ts`, `firestore.rules`, `tests/firebase.pockets.json`, `tests/pockets.integration.test.mjs`, `tests/pockets.fixtures.mjs`, `tests/firestore.rules`.
  - Proof: domain RED → GREEN → REFACTOR; local-only client/Admin/store/rules scenarios; full unit tests and both builds.
  - Progress: **complete: implemented, functionally verified, locally committed, natively approved, and exactly acknowledged**. Client and extracted Admin paths atomically debit available parent funds, create the pocket and child registry entry, and create a neutral allocation transfer only when funded. Safe empty deletion and temporary unsupported-operation guards protect the intermediate private branch until AP-02. No UI is exposed yet.
  - Authored count: **1,503** (1,447 additions, 56 deletions), excluding this tracking document, original `.atl` edits, and generated output. `tests/firestore.rules` contributes one symlink line, not a duplicate rules file.
  - Rollback boundary: restore the five existing source/rules paths and remove the seven new AP-01 entries listed above; preserve this document and original `.atl` changes. Reverse dependent units first once AP-02/AP-03 exist. Persisted pockets outside disposable fixtures would require a separate data-compatibility assessment, never blind balance recombination or history deletion.
  - Commit: **`7ef188dd602523dfd2e2f130bb4261a59facda2b`**. Normalized staged and committed tree both `59c84fccf2350115714506001511a1b4325fc9dd`; commit hooks did not change candidate bytes. Native committed-only assessment: **medium / executable_change**, due because `slice_budget_reached`; user granted review, native reliability review approved without findings, exact acknowledgement burned authority. Earlier untracked-inventory assessment was **high / unassessable**, never approval or a risk downgrade.
  - Baseline proof: `pnpm test` exited 0 (**27 passed**); `pnpm build` and `pnpm --filter functions build` exited 0. Functions build warned about local Node 24 versus configured Node 20.
  - RED proof: `node --test src/lib/pockets.test.ts` exited 1, **3 failures / 4 tests**, on deliberately unimplemented helpers. Baseline actual-store integration ignored `parentAccountId` and failed funded-initialization conservation. These are behavior RED observations, not rules proof from the invalid missing-rules run.
  - Harness blocker: rules path `../firestore.rules` was rejected as outside the config project directory; `firestore.rules` resolved to missing `tests/firestore.rules`. The emulator then defaulted to allow-all, so its forged-write result is **not valid security evidence**. Do not claim rules RED or PASS from that run.
  - Additional edit surface **explicitly authorized by the user (option 1 / Sí)**: `tests/firestore.rules` as a relative symlink to `../firestore.rules`. Created and verified against the root file (`cmp` exit 0). The authenticated outsider canary was denied and Admin readback confirmed no document was created; actual rules loaded in Standard edition.
  - Fixture cleanup fixed within the authorized surface: replaced incompatible `app.delete()` with modular `deleteApp(app)`; emulators shut down cleanly.
  - GREEN / closure proof: `node --test src/lib/pockets.test.ts` exit 0 (**4/4**); `pnpm test` exit 0 (**31/31**); `pnpm build` exit 0; `pnpm --filter functions build` exit 0 (known Node 24 / configured Node 20 warning); exact demo Auth/Firestore command below exit 0 (**9/9**); `git diff --check` exit 0. No source-mutating normalizer is configured. Parent structural readback completed; a separate read-only spot verifier reran the helper and demo harness commands, both with the same passing counts.
  - Runtime proof covers funded/zero creation, rollback/readback, invalid parents/metadata, forged hierarchy/registry, outsider access, deletion guards, concurrent openings, captured workspace, Admin parity, and ordinary-account regression paths. Full Gemini/Genkit callbacks were intentionally not invoked; the extracted Admin helper and shared operation guard were exercised directly and actual callback wiring compiled.
- [ ] **AP-02 — Make pocket movements and reversals atomic.**
  - Progress: **implemented and functionally verified on the isolated second child branch; commit/native disposition pending**. Atomic client and extracted Admin paths support single income, expense, transfer, edits with combined overlapping-account deltas, and reversal. Opening allocations preserve original transfer identity/endpoints; deleting one clears its child pointer while retaining activity history.
  - Outcome: neutral pocket funding/withdrawal, ordinary pocket income/expense support, combined edit/reversal deltas, conserved internal-transfer totals, sufficient-funds checks, workspace/currency validation, and client/Admin parity.
  - Route: **delegated direct**. Trigger: non-trivial transaction store and Admin callback changes with integration proof.
  - Candidate surfaces: `src/types.ts`, `src/schemas.ts`, `src/lib/pockets.ts`, `src/lib/pockets.test.ts`, `src/stores/accountsStore.ts`, `src/stores/transactionsStore.ts`, `functions/src/index.ts`, `functions/src/pockets.ts`, `firestore.rules`, `tests/pockets.integration.test.mjs`, `tests/pockets.fixtures.mjs`. Shared types/schema and account mutation guards are authorized only where needed to support the same atomic pocket transaction behavior, not for unrelated refactoring.
  - Proof: RED → GREEN → REFACTOR; atomic failure, concurrency, edit/reversal, KPI neutrality, and ordinary-account regression scenarios; full unit tests and both builds.
  - Actual edited paths: `firestore.rules`, `functions/src/index.ts`, `functions/src/pockets.ts`, `src/lib/pockets.test.ts`, `src/lib/pockets.ts`, `src/stores/transactionsStore.ts`, `src/types.ts`, `tests/pockets.fixtures.mjs`, `tests/pockets.integration.test.mjs`; **1,392 authored lines**, generated output and tracker excluded.
  - RED: new actual-store pocket income failed permission-denied while 9 AP-01 cases passed; overlapping pocket-transfer edits then exposed a 1,000-expression rules-evaluation limit and undefined `data.id`. Actual loaded rules and outsider canary preceded these observations.
  - Fixes: pass the transaction document ID explicitly, correlate after-state endpoint links, and narrow opening-allocation edit rules. Targeted edit/reversal turned GREEN; forged opening endpoints now deny normally rather than relying on an expression-ceiling error. Corrected a mirror-helper import and retained `createdAt` on updates.
  - Closure: `node --test src/lib/pockets.test.ts` exit 0 (**6/6**); `pnpm test` exit 0 (**33/33**); frontend and functions builds exit 0 (known Node 24 / configured Node 20 warning); exact demo Auth/Firestore command below exit 0 (**18/18**); `git diff --check` exit 0. No configured mutating normalizer. Independent parent spot reran helper and integration commands, **6/6** and **18/18**, with verified rules symlink, outsider denial/readback, unchanged source, and clean emulator shutdown.
  - Runtime coverage: real cashflow and KPI treatment; neutral parent/pocket and external same-currency transfers; rollback for insufficient funds, foreign workspace, wrong currency, credit/missing/loan cases; ordinary add/edit/delete and ordinary↔pocket edits; captured workspace suppression; overlap, concurrent expense integrity, allocation edit/reversal, Admin parity, hierarchy denial, and AP-01 regressions. Full Gemini callbacks were intentionally unexecuted; extracted Admin helpers ran and wiring compiled.
  - Temporary limitation: `addTransactionsBatch` rejects both a pocket and a parent bank with children **before any write**. This is tested integrity protection, NOT accepted permanent import behavior. Required AP-02B below closes the compatibility gap before overall completion.
  - Rollback: restore only the nine AP-02 implementation/proof paths to `7ef188dd602523dfd2e2f130bb4261a59facda2b` before dependents land; preserve `.atl` and tracker. Persisted pocket movement records require data-compatibility assessment, never history erasure or blind reversal. Commit and committed-only native assessment remain **pending**.
- [ ] **AP-02B — Restore atomic imports for pockets and their parent banks.**
  - Why: existing Import confirmation calls `addTransactionsBatch`; becoming pocket-related must not permanently disable a bank's import capability or make the planned pocket selector unusable.
  - Outcome: bounded authenticated bulk validation of membership, hierarchy, currency and every row; all imported records and aggregate balance effects commit together, or no writes occur. Preserve ordinary import behavior and later individual edit/reversal of imported rows.
  - Route: **delegated direct**. Trigger: client/server/schema integration with actual-store/Admin/import proof.
  - Candidate surfaces: `src/stores/transactionsStore.ts`, `src/schemas.ts`, `functions/src/index.ts`, `functions/src/pockets.ts`, `tests/pockets.fixtures.mjs`, `tests/pockets.integration.test.mjs`, `src/views/Import.vue`. Derive any exact isolated callable handler path before authorizing the writer; no implementation yet.
  - Approach: prefer server bulk atomicity over per-row client loops (partial imports) or a new aggregate client-rules protocol (current singular `lastPocketMovementId` cannot link every row). This adds a callable dependency, not authority to deploy or execute it remotely.
  - Proof: RED for successful mixed income/expense import into pocket and parent bank; GREEN plus invalid-row/insufficient-funds zero-write rollback, unauthorized workspace, ordinary regression, and subsequent edit/reversal; full unit tests/builds and isolated emulator checks. Applicable callable handler/transport proof must be defined before implementation, without Gemini or ambient credentials.
  - Progress, commit identity, authored count, native assessment: **pending**.
- [ ] **AP-03 — Expose the bank hierarchy and usable account selectors.**
  - Outcome: pocket creation and money movement, grouped bank/pocket display, clear available versus total balances, unambiguous selector labels, and user-facing documentation. Goals must present the available-funds constraint without suggesting its existing overdraft confirmation can override pocket/parent safeguards; existing goal progress persistence remains outside this feature's atomic-transaction scope.
  - Route: **delegated direct**. Trigger: coordinated changes across account, dashboard, transaction, import, and goal views.
  - Candidate surfaces: `src/lib/pockets.ts`, `src/lib/pockets.test.ts`, `src/views/Accounts.vue`, `src/views/Dashboard.vue`, `src/views/Transactions.vue`, `src/views/Import.vue`, `src/views/Goals.vue`, `docs/account-pockets.md`.
  - Proof: grouping/label/selection tests and full unit tests/builds; local UI smoke for funded creation, movement, reversal, reload, and workspace switching.
  - Runtime harness, rollback scope, commit identity, authored count, and native assessment: **pending**.

## Applicable checks

Baseline commands passed; repeat them for task-closure proof after implementation:

```sh
pnpm test
pnpm build
pnpm --filter functions build
```

Focused/local harness commands (AP-01 final GREEN and independent parent spot observed):

```sh
node --test src/lib/pockets.test.ts
npx -y firebase-tools@latest emulators:exec --project demo-vault-pockets --only auth,firestore --config tests/firebase.pockets.json "node --test tests/pockets.integration.test.mjs"
```

The emulator harness must fail closed outside its demo project and loopback hosts, avoid `.env` and ambient credentials, exercise actual stores and extracted Admin callbacks without Gemini, and read back success/failure state. Do not use `pnpm emulators`: its script kills existing port occupants. Preserve any existing services and report occupied ports as unavailable rather than terminating them.

Pure domain tests do not prove Firestore rules or multi-document atomicity. Deterministic runnable scenarios require observed RED before behavior implementation; report any unavailable runner explicitly.

## AP-01 native review record

- Reviewed committed range: `8877aa2746525ba46806024616d7f7e71a8ee05c..7ef188dd602523dfd2e2f130bb4261a59facda2b`; 13 files, 1,607 changed lines including the committed tracker.
- Risk: **medium**, `executable_change` in `firestore.rules`; review due because `slice_budget_reached`.
- User selected option 1 / `granted`. Exact provider-issued START, bound STATUS, reliability capture, and approved acknowledgement executed successfully.
- Native reliability reviewer inspected all 13 immutable patches, returned no findings, and established no candidate-caused severe reliability defect. This was patch-only inspection; it did not rerun the functional commands. Writer checks and the independent parent spot are separate observed proof.
- Lineage: `review-4641aef483d4f775`; target: `sha256:cd8f73ee9b24f3f14e2cbff96904b9db81d4f4cff8a9a1aa3c069ab66af64d1d`.
- Exact acknowledgement returned `gentle-ai.review-acknowledged/v1`, `action: acknowledged`, `authority: burned`; consumed revision: `sha256:7ceb1343a3b166215c193c9076d1cfea60001dd239d3d44ebfd6e9ceff1b8fad`.
- This transaction is terminal. Do not run trailing STATUS, reuse its command/authority, or restart review of its unchanged consumed candidate. The next reviewed boundary is AP-01's commit.
- Review does not authorize push, PR creation, merge, deployment, or financial-document access.

## Current progress and next step

Read-only exploration and parent spot checks are complete. Authorized database configuration lookup succeeded using Firebase CLI **15.33.0**: `firestore:databases:list` returned only `(default)`; `firestore:databases:get '(default)'` confirmed Standard edition, Native mode, and `nam5`. Both commands explicitly targeted `vault-41b34`, used the existing local CLI session, and excluded alternate token/ADC environment credentials.

AP-01 lifecycle is complete and natively acknowledged. AP-02 single-movement implementation and all closure/parent-spot checks passed. Required import compatibility and all hierarchy UI remain unimplemented in AP-02B/AP-03. Security-negative permission-denied logs are expected. Passing batch-rejection tests do not prove import capability.

AP-01 is locally committed; no financial-document reads, remote writes, or migrations have occurred. Pre-existing `.atl/.skill-registry.cache.json` and `.atl/skill-registry.md` modifications remain untouched and unstaged. The resumed writer and independent spot verifier returned terminal **completed** handoffs with exact skill paths loaded.

Next: locally commit the coherent verified AP-02 work unit plus this tracker, assess only that committed range from AP-01, and follow exact native candidate-consent/review transitions. Then complete AP-02B import compatibility before AP-03 selectors and overall delivery. Preserve original `.atl` edits and separate the pending feature capabilities from passed checks. This tracking file is structurally checked; full Engram synchronization remains unavailable despite using authoritative runtime session `01a12740-0592-7aa2-a453-08eb581844e6`.
