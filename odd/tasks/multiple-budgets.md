# Multiple budgets without hiding financial obligations

Implement exclusive monthly and event budgets while retaining the existing category limits, full credit debt, and all-budget estimated monthly allocations.

## Authority and baseline

- The user authorized the reviewed MVP, a separate feature branch, and local work-unit commits.
- No push, PR, release, deployment, destructive Git operation, or unrelated change is authorized.
- Branch: `feat/multiple-budgets`.
- Starting commit: `dd3ca55a9766ab4e25e709031be219abde675418`.
- Preserve pre-existing edits in `.atl/skill-registry.md` and `.atl/.skill-registry.cache.json`; never stage them.
- RDD reads on (global). Each code candidate is one work unit against its previous commit, not the accumulated branch.

## Scope and accepted rules

- Each expense belongs to one operating budget. Its category remains independent.
- Monthly budgets use existing calendar-month installment allocation from the transaction month.
- Event/project totals count the full assigned purchase principal once, including early bookings.
- Global estimated monthly allocations include every expense budget, including archived budgets; never add event committed totals to installments.
- Preserve a protected default monthly budget backed by authoritative legacy `categoryBudgets`.
- Legacy, unassigned, imported, and AI-created expenses resolve to that default without bulk rewriting history.
- Create, edit, and archive additional budgets. Archive preserves assignments, history, and remaining obligations.
- Budget-only reassignment changes classification, never balances, debt, dates, receipts, installments, or mirror links.
- Reassignment restates past and future budget attribution; it does not restate financial totals.
- Validate same-workspace budget references even for members of multiple workspaces.
- Keep goal funding, `budgetAllocations`, the 50/30/20 planner, and existing global expense limits separate.
- Use clearly labeled reporting currency and current manual FX semantics; flag missing rates and do not silently relabel stored caps.

## Work units

- [x] **B1 — Allocation core**: exclusive membership/default fallback, monthly/event/category aggregation, prototype-safe rollups and deterministic checks; commit `a118876cb36f7d82a026827ab76e6123ec4bf7c6`, native approval acknowledged.
- [x] **B2M — Parent contracts**: strict draft/record/patch types and validation; 42 tests/build passed; commit `f6e197bf450f3570b49dbfa338afe702615a4e01`, native approval acknowledged.
- [x] **B2S — Parent CRUD security**: independent raw 5/5, combined 9/9, full 42/42/build; scoped commit `dc9e0fbc6fdc6465673164fdbac1a2b1851e02f6`; native `review-e699046ea5a67bde` approved, exact acknowledgement burned. R2-001 readability suggestion remains a separate follow-up.
- [x] **B2P — Parent SDK persistence**: captured-workspace helper and isolated service suite; writer + independent combined 9/9/full 42/42/build; scoped commit `84d2a33f99f8ac4b2b432a86e3575179d2a78dfd`; native `review-497212a444122912` approved + burned, post-ack ASSESS derived closed/consumed. Thin adapter remains B4.
- [ ] **B2C-A — Cap admission policy** (in progress: independent verification and scoped commit/review)
  - Keep the complete38-line post-state policy with scalar/schema/finite/category/member attacks, representative archive+cap and invalidated-category+cap regressions. Core suite39 tests (38 original +1 representative); estimate366–388 lines including tracking.
  - Observed original valid-member CREATE RED after successful demo bootstrap, extended pre-policy8/44 passed36 failed, final focused44/44 GREEN. Aggregate RED retained; extracted writer checks passed core39/39, lifecycle6/6, combined54/54, full42/42, build1823 modules, whitespace and4-port teardown. A368 lines /L215 estimated incl tracking; Independent verifier reran all checks successfully with guard/teardown readback; commits/native closure pending.
- [ ] **B2C-L — Cap retained-history lifecycle** (pending after A)
  - Separate self-contained tests/firestore/categoryCaps.lifecycle.security.test.ts:6 original lifecycle/fixture/no-count-limit cases, independent namespace/guards/full cleanup, no rules changes; estimate208–250 lines. Preserve all44 originals across A/L without test-file imports or weaker intermediate policy.
- [ ] **B2C-P — Category-cap SDK persistence** (pending after C-S): new captured-workspace helper/service suite, strict decoder and prototype-safe maps; no approved parent-helper/contracts edits. Optional chunked replacement is separate later work if needed, not false atomicity.
- [ ] **B2R — Expense reference isolation** (pending): same-workspace references, getAfter archive semantics, immutable workspace identity, classification-only diff guards, and adversarial tests.
- [ ] **B3 — Balance-neutral expense assignment** (pending): isolated classification update and transaction selectors, preserving every financial field and existing entry defaults.
- [ ] **B4 — Management and truthful reporting** (pending): thin workspace/baseline adapter, budget controls in Goals, global estimated allocation reporting in Dashboard, compatible UX, docs, and functional checks.

Each work unit closes only after its outcome and applicable checks are observed, with a Conventional Commit on the feature branch. Keep tests and behavior docs with the unit. The parent commits; writers do not.

## Acceptance examples

- A synthetic 900-unit purchase in three installments assigned to an event shows 900 committed and approximately 300 in each applicable global month; full credit debt is unchanged.
- An event assignment removes that purchase from recurring limits without changing its category or global monthly allocation.
- Monthly budgets include only their own expenses; unassigned legacy expenses remain in the protected baseline.
- Event bookings before the planned event date are retained.
- Archiving keeps history and remaining installment allocations visible.
- Reassignment never invokes balance reversal/reapplication or changes mirror relationships.
- Cross-workspace assignments fail even when the actor belongs to both workspaces.
- Card repayment transfers add no second expense cost.
- Budget/FX edits retain goal progress, planner settings, and legacy category limits.

## Verification and execution

- Baseline verifier `muzncluc-3-x6yz` settled: Node `v24.15.0`, pnpm `11.1.3`; `pnpm test` passed 25 tests (0 failures); `pnpm build` passed (1,823 modules, no observed warnings).
- Firestore preflight resolved: Firebase CLI `15.33.0` reported the existing default database as `STANDARD`, `FIRESTORE_NATIVE`, location `nam5`; source uses `getFirestore(app)` without a database ID. No live financial records were accessed.
- Known baseline environmental failures: none observed.
- B1 writer and correction settled: initial RED (new module absent), then 8/8 focused tests and 33/33 full tests/build. Regression `muzqqj6v-7-oxy3` observed meaningful RED (8 passes/1 failure: inherited constructor value), GREEN/final 9/9, `pnpm test` 34/34, and build passed (1,823 modules). Public API unchanged; own-property checks/safe definition preserve plain-record numeric rollups. Two files: 278 source/test lines. Parent narrowly spot-checked the correction.
- B2M/B2P/B2C/B2R: split the estimated 650-900-line persistence/security area into validated contracts, parent persistence, category caps and reference isolation. B2M writer `mv011gy2-8-ujbn` settled: RED missing export; GREEN/post-refactor 9/9 focused; full tests 42/42; build passed (1,823 modules), Git whitespace check passed. Three files: +199/-1, legacy planner unchanged. Parent spot-checked strict shapes, finite caps, reserved ID and clear semantics. B2P introduces isolated demo-project CRUD verification; no security or deployed behavior is claimed.
- Initial B2P writer observed raw policy RED, then isolated demo-vault-b2 GREEN 8/8. Source/test/config totals +458; stopped before full tests/build. Initial timeout from open SDK channels was resolved with terminate/owned-run cleanup; final emulator shut down normally. Raw finite predicate accepted Number.MAX_VALUE and denied NaN/infinities. This is partial evidence, not closure; complete outsider update/delete and split checks next.
- Security-test preparation: installed Firebase SDK supports emulator mock identities without a new test dependency. Java `26.0.1` is available; no listeners were observed on candidate ports `8185`, `4415`, `4515`. These are prerequisite observations only; no emulator/security test has run.
- Category-cap check `muzojn17-6-hr7b` settled: store each additional cap under `/budgets/{id}/categoryCaps/{categoryId}`, inheriting parent denomination and assembling maps only in memory. This preserves overall-only/category-only/both without a cap-count product limit; verify finite predicates and post-batch constraints in raw SDK tests. Do not claim undocumented map-value quantification. Chunked writes must report partial failures honestly.
- B3: prove budget-only changes cannot mutate ledger fields; verify manual/import/AI defaults and mirrored-expense handling.
- B4: tests/build plus functional UI checks when available. Record any unavailable runner or emulator as a blocker, not a pass.
- Native review: inspect authority before each candidate when RDD is on; candidate consent and exact provider routing remain separate from implementation authority.
- B1 local commit contains exactly the two allocation files plus this locator (363 lines), excluding `.atl`. Native `review-c8fdc65e768a6d84` approved; exact acknowledgement returned `authority: burned`, consumed revision `sha256:76055ef47bee86940aa645d9066a15228963ebea1413950f94258b4faa223fe5`. Post-ack ASSESS derived `consumed: true`, outcome `closed`, no separate verifier. Persistence, selectors and deployed behavior remain unimplemented.
- B2M commit `f6e197bf450f3570b49dbfa338afe702615a4e01` contains three contract files plus tracking (216 diff lines). Native `review-ee2b5228c82be4c1` approved without returned advisories; exact acknowledgement burned revision `sha256:83ee0e41a7c8898f64cab9da342831a19adc743289b50277461fb74f8d178854`. ASSESS derived consumed/closed, no separate verifier. SDK/rules/emulator behavior is still pending.
- Separate later follow-up: non-blocking native advisory `R3-001`, reliability, `src/lib/budgets.ts:28`, WARNING/informational. Detailed message was not returned; inspect the converter boundary during later reporting integration, not as a B1 correction or review rerun.
- If native review declines/is unavailable, use native ASSESS and its verifier plan; functional checks still apply.
- Keep writes single-threaded and delegate nontrivial multi-file units with narrow allowed edit surfaces.
- Aim for reviewable work units around 400 changed lines; split by behavior or surface an overage, never compress code/tests to fit.

## Evidence

| Unit | Functional evidence | Local work-unit commit | Review/independent evidence |
| --- | --- | --- | --- |
| B1 | Regression RED; GREEN/final 9 focused + 34 full tests/build passed | `a118876cb36f7d82a026827ab76e6123ec4bf7c6` | Approved/acknowledged `review-c8fdc65e768a6d84`; ASSESS derived closed |
| B2M | RED missing export; GREEN/refactor 9 focused; full 42/42 + build passed | `f6e197bf450f3570b49dbfa338afe702615a4e01` | Approved/acknowledged `review-ee2b5228c82be4c1`; ASSESS derived closed |
| B2S | Original RED; writer + independent raw 5/5, combined 9/9, full 42/42 + build | `dc9e0fbc6fdc6465673164fdbac1a2b1851e02f6` (276 diff lines) | `review-e699046ea5a67bde` approved + burned; post-ack ASSESS unassessable from future untracked SDK, separate high-risk verifier already passed |
| B2P | Writer + independent combined 9/9, full 42/42 + build; timestamp/scope/clear checks | `84d2a33f99f8ac4b2b432a86e3575179d2a78dfd` (271 diff lines) | `review-497212a444122912` approved + burned; ASSESS derived closed/consumed |
| B2C-S | Settled read-only map; privileged global bootstrap/child/batch RED-GREEN still unobserved | Pending | Pending |
| B2C-P | Settled read-only map; service/prototype/retained-history checks still unobserved | Pending | Pending |
| B2R | Reference/archive/diff-guard security pending | Pending | Pending |
| B3 | Pending | Pending | Pending |
| B4 | Pending | Pending | Pending |

## Non-goals

No interest schedule, statement/payment reconciliation, historical FX/cap snapshots, split expense membership, AI auto-assignment, import overhaul, savings-goal redesign, or new navigation.

## Next step

HEAD84d2a33; four earlier units closed. A314test+38rules+tracking<400; L199test+tracking<400. Writer AND independent verifier: focused39/39+6/6, combined54/54, full42/42, build1823, whitespace/4-port owned shutdown passed. ASSESS unassessable from untracked scope/native unknown => independent high-risk plan satisfied, no closure invented. Parent commits A rules+core+tracking ONLY against84d2a33, L stays future untracked; native committed-slice review follows under enabled user switch. A/L tasks notdone until exact disposition/commit evidence. Structural extraction preserves44 originals+1 regression and observed aggregateRED. Ignored log/dist generated by checks, untouched, initialignored state unknown. .atl untouched/unstaged, config/SDK/refs/UI/prod/publication excluded. Old metadata ec1c consent expired without invocation/lineage, no replay/decline/approval/maintenance.
