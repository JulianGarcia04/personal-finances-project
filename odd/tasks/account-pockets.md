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
- Delivery strategy: `ask-on-risk`.
- Chain strategy: **`feature-branch-chain`**, explicitly selected by the user (option 1). Keep the full feature isolated until completion and verification.
- Revised forecast: approximately **2,150–2,400 authored additions + deletions**, excluding generated output and this tracking document. The original 1,100–1,550 estimate underestimated the actual persistence/rules proof. These are planning estimates, not code-size caps.
- Running committed authored count: **0**.
- Planned local slice branches: `feat/account-pockets-01-lifecycle` → `feat/account-pockets`; `feat/account-pockets-02-movements` → `feat/account-pockets-01-lifecycle`; `feat/account-pockets-03-ui` → `feat/account-pockets-02-movements`.
- Current implementation slice: `feat/account-pockets-01-lifecycle`. Commit ranges and actual authored counts remain pending. PRs are not created; no remote publishing or merge is authorized.
- RDD: **on, decided by default**, observed through `gentle-ai review mode status`.
- Each task requires observed checks and a Conventional Commit on the feature branch. No AI attribution or Co-Authored-By trailer.
- Source-mutating normalization must precede functional verification and native candidate freeze. Follow only native review continuations and candidate-specific consent.
- One bounded slicing pass observed **1,503 authored lines** for AP-01 (1,447 additions, 56 deletions): 862 production/rules and 641 local proof. Keep the already-verified cohesive lifecycle boundary. A 147-line domain split leaves 1,356 lines; separating Admin coverage requires new edits to retain immediate bypass guards. No straightforward verified partition with every slice ≤400 was found. Stop reshaping; recommend explicit **`size:exception`** acceptance before any future PR containing this boundary. No PR or size exception is approved by this local commit.
- Engram mirror: **pending** under `odd/account-pockets/tasks`; mutation tools are blocked by a runtime-session-resolution hook. Keep this complete local document and retry synchronization only when available.

## Tasks

- [ ] **AP-01 — Safely initialize and maintain named pockets.**
  - Outcome: hierarchy contracts, inclusive-balance initialization, atomic persistence, compatible AI creation, edit/deletion guards, and matching security policy.
  - Route: **delegated direct**. Trigger: multiple non-trivial model/store/backend/rules files and research preparing writes.
  - Candidate surfaces: `src/types.ts`, `src/schemas.ts`, `src/lib/pockets.ts`, `src/lib/pockets.test.ts`, `src/stores/accountsStore.ts`, `functions/src/index.ts`, `functions/src/pockets.ts`, `firestore.rules`, `tests/firebase.pockets.json`, `tests/pockets.integration.test.mjs`, `tests/pockets.fixtures.mjs`, `tests/firestore.rules`.
  - Proof: domain RED → GREEN → REFACTOR; local-only client/Admin/store/rules scenarios; full unit tests and both builds.
  - Progress: **implemented and functionally verified; work-unit commit and native review disposition pending**. Client and extracted Admin paths atomically debit available parent funds, create the pocket and child registry entry, and create a neutral allocation transfer only when funded. Safe empty deletion and temporary unsupported-operation guards protect the intermediate private branch until AP-02. No UI is exposed yet.
  - Authored count: **1,503** (1,447 additions, 56 deletions), excluding this tracking document, original `.atl` edits, and generated output. `tests/firestore.rules` contributes one symlink line, not a duplicate rules file.
  - Rollback boundary: restore the five existing source/rules paths and remove the seven new AP-01 entries listed above; preserve this document and original `.atl` changes. Reverse dependent units first once AP-02/AP-03 exist. Persisted pockets outside disposable fixtures would require a separate data-compatibility assessment, never blind balance recombination or history deletion.
  - Commit identity and committed-only native assessment: **pending**. Current-worktree assessment exited 1 with **high / unassessable**, because untracked files require explicit inventory declaration; this is not a review or approval and never lowers risk.
  - Baseline proof: `pnpm test` exited 0 (**27 passed**); `pnpm build` and `pnpm --filter functions build` exited 0. Functions build warned about local Node 24 versus configured Node 20.
  - RED proof: `node --test src/lib/pockets.test.ts` exited 1, **3 failures / 4 tests**, on deliberately unimplemented helpers. Baseline actual-store integration ignored `parentAccountId` and failed funded-initialization conservation. These are behavior RED observations, not rules proof from the invalid missing-rules run.
  - Harness blocker: rules path `../firestore.rules` was rejected as outside the config project directory; `firestore.rules` resolved to missing `tests/firestore.rules`. The emulator then defaulted to allow-all, so its forged-write result is **not valid security evidence**. Do not claim rules RED or PASS from that run.
  - Additional edit surface **explicitly authorized by the user (option 1 / Sí)**: `tests/firestore.rules` as a relative symlink to `../firestore.rules`. Created and verified against the root file (`cmp` exit 0). The authenticated outsider canary was denied and Admin readback confirmed no document was created; actual rules loaded in Standard edition.
  - Fixture cleanup fixed within the authorized surface: replaced incompatible `app.delete()` with modular `deleteApp(app)`; emulators shut down cleanly.
  - GREEN / closure proof: `node --test src/lib/pockets.test.ts` exit 0 (**4/4**); `pnpm test` exit 0 (**31/31**); `pnpm build` exit 0; `pnpm --filter functions build` exit 0 (known Node 24 / configured Node 20 warning); exact demo Auth/Firestore command below exit 0 (**9/9**); `git diff --check` exit 0. No source-mutating normalizer is configured. Parent structural readback completed; a separate read-only spot verifier reran the helper and demo harness commands, both with the same passing counts.
  - Runtime proof covers funded/zero creation, rollback/readback, invalid parents/metadata, forged hierarchy/registry, outsider access, deletion guards, concurrent openings, captured workspace, Admin parity, and ordinary-account regression paths. Full Gemini/Genkit callbacks were intentionally not invoked; the extracted Admin helper and shared operation guard were exercised directly and actual callback wiring compiled.
- [ ] **AP-02 — Make pocket movements and reversals atomic.**
  - Outcome: neutral pocket funding/withdrawal, ordinary pocket income/expense support, combined edit/reversal deltas, conserved internal-transfer totals, sufficient-funds checks, workspace/currency validation, and client/Admin parity.
  - Route: **delegated direct**. Trigger: non-trivial transaction store and Admin callback changes with integration proof.
  - Candidate surfaces: `src/lib/pockets.ts`, `src/lib/pockets.test.ts`, `src/stores/transactionsStore.ts`, `functions/src/index.ts`, `functions/src/pockets.ts`, `firestore.rules`, `tests/pockets.integration.test.mjs`, `tests/pockets.fixtures.mjs`.
  - Proof: RED → GREEN → REFACTOR; atomic failure, concurrency, edit/reversal, KPI neutrality, and ordinary-account regression scenarios; full unit tests and both builds.
  - Runtime harness, rollback scope, commit identity, authored count, and native assessment: **pending**.
- [ ] **AP-03 — Expose the bank hierarchy and usable account selectors.**
  - Outcome: pocket creation and money movement, grouped bank/pocket display, clear available versus total balances, unambiguous selector labels, and user-facing documentation.
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

## Current progress and next step

Read-only exploration and parent spot checks are complete. Authorized database configuration lookup succeeded using Firebase CLI **15.33.0**: `firestore:databases:list` returned only `(default)`; `firestore:databases:get '(default)'` confirmed Standard edition, Native mode, and `nam5`. Both commands explicitly targeted `vault-41b34`, used the existing local CLI session, and excluded alternate token/ADC environment credentials.

AP-01 lifecycle implementation, actual-rule security policy, client/Admin helper parity, and local proof are complete. The authorized rules symlink resolved the isolated-config fail-open hazard, and fixture cleanup now uses the modular SDK. Writer self-verification and parent spot reruns passed; security-negative permission-denied logs are expected. General pocket transactions and all UI remain unimplemented until AP-02/AP-03.

No work-unit commits, financial-document reads, remote writes, or migrations have occurred yet. Pre-existing `.atl/.skill-registry.cache.json` and `.atl/skill-registry.md` modifications remain untouched. The resumed writer and independent spot verifier returned terminal **completed** handoffs with exact skill paths loaded.

Next: commit only the authorized AP-01 surfaces and this document locally, then assess that committed work unit from the initial boundary and follow exact native transitions, relaying candidate-specific consent if requested. Do not treat the failed current-worktree assessment as a low-risk outcome. Record the commit and review disposition before closing AP-01. AP-02 and AP-03 remain unstarted. This tracking file is structurally checked; full Engram synchronization remains unavailable despite using the authoritative runtime session identity.
