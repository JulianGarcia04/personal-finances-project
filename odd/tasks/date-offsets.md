# Date offsets
Store, read and pre-fill calendar dates in local time so every movement lands on the day and month the user chose, and align installment imputation with credit-card billing.
Branch: `fix/date-offsets` (from `main` @ `e937a06`) → `main` · Delivery: work-unit commits only; push, merge and deployment not requested · Strategy: `ask-on-risk` (forecast ~250 authored lines, under budget) · RDD: off (clone-local) · Checks: `pnpm test`, `pnpm test:functions`, `pnpm build`.

## Specs
- S1: "Quiero que revises TODOS los kpis de la pestaña principal y me digas si debería mostrar los valores que debería mostrar... hay algún desface en alguno de ellos ? quiero que le hagas una auditoria"
- S2: "y las fechas quiero que revises si todo se muestra en la fecha correcta"
- S3: "sí, corrige las fechas primero"
- S4: "los pagos de las compras hechas a cuotas tienen un desfase, ya que no se sincroniza con la fecha de corte, ya que si hice una compra el mes pasado a 3 cuotas, la primera cuota la pagaria este mes o el otro dependiendo de la fecha de corte."
- S5: User selected "Mes de pago (Recomendado)": each installment of a credit-card purchase counts in the month its statement payment is due, including 1-installment purchases.
- S6: User selected "Actualizar y correrlo (Recomendado)" for `tests/agent.tools.emulator.test.mjs`, then: "cuando termina quiero que hagas merge y deploy". Authorized: local merge into `main` and Firebase deployment of affected services to the sole configured project after the emulator follow-up succeeds. Then: "sí, también haz push a GitHub" → push merged `main` to `origin`.

## Acceptance criteria
- A1: A `YYYY-MM-DD` value parsed anywhere in the client or server keeps the same calendar day in America/Bogota (and any UTC-11..UTC+11 zone): imported statement rows, pocket statement rows, goal deadlines and legacy string dates read back from Firestore.
- A2: Every date input default and edit pre-fill shows the local calendar day: after 19:00 in Colombia the default is still today, and editing a movement stored in the evening keeps its day.
- A3: No change to stored formats for already-correct paths (manual create/edit, transfers, card payments, agent tools) and no data migration.
- A4: For an expense on a credit card with `statementClosingDay` and `paymentDueDay`, installment i is imputed to the payment month of the statement that contains the purchase, plus i months; this applies to 1-installment purchases too. Example: closing 25, due 10, purchase 28 Sep at 3 installments → Nov, Dec, Jan. Cards without both days, non-card accounts and bridge accounts keep calendar-month imputation. "Compras registradas" keeps full purchases by purchase date. Client KPIs, budgets, Goals planner and the agent backend use the same rule. The card statement widget (`expenseAmountForCycle`) is unchanged.

## Tasks
- [x] T1 — S2–S3, A1, A3 — Commit: `76ab6b7`. Evidence: helper RED 1/4 → GREEN; producer test RED 0/1 → GREEN; server read-back/import RED → GREEN. Also covers `http.ts` `storedDateValue`, `agentTools.ts`, `embeddings.ts`, `mirror.ts` after the approved surface expansion. — Add a shared local date helper and use it for date-only parsing: AI statement import review (`transactionsStore.ts:1177`), pocket statement import (`functions/src/pocketImports.ts:135`), legacy string read-back (`transactionsStore.ts:421`, `goalsStore.ts:393`) and goal deadline creation (`Goals.vue`). Route: delegated (2+ non-trivial files across client and functions). Test-first: helper RED under `TZ=America/Bogota`.
- [x] T2 — S2–S3, A2 — Commit: `023bdfb`. Evidence: `toLocalDateKey` RED ('2026-11-01') → GREEN; Transactions/Goals view tests RED → GREEN. — Replace `toISOString()` date keys with local date keys for form defaults and edit pre-fills (`Transactions.vue:1177,1204,1386,1425,1510-1511,1535`, `Accounts.vue:977`, `Goals.vue:898`). Route: delegated (same writer as T1, separate commit). Test-first: date-key helper RED under `TZ=America/Bogota` at 20:30.
- [x] T3 — S4–S5, A4 — Commits: `08d05b5` (client rule, callers, projection split) and `fb4b829` (agent backend parity). Evidence: installments RED 9/17 → GREEN 17/17; `splitMonthEndExpenses` RED → GREEN; server build RED → 110/110. Pending: `tests/agent.tools.emulator.test.mjs` expectations (outside surface, not run). — Impute card installments to the statement payment month. Callers: `budgets.ts:45,81`, `dashboardMetrics.ts:39`, `Dashboard.vue:613`, `Goals.vue:690`, `transactionsStore.ts:328`, server `functions/src/http.ts:220` and `functions/src/agentQueries.ts:211-227`. Route: delegated (10+ files across client and functions), starts after T1/T2 because it shares `transactionsStore.ts` and `Goals.vue`. Test-first: payment-month RED in `installments.test.ts`. Consequence to handle: the month-end projection must not extrapolate amounts already billed from earlier purchases.

## Out of scope (reported, not authorized)
Audit findings D3–D13 (savings-rate clamp, goal contributions as expenses, donut zero buckets, projection currency mix, paid statement in spendable, silent FX fallback, same-day sort tie-break, year in recent dates). Existing transactions already stored one day early by past imports are not migrated.

## Log
### L1 — Audit result
Read-only audit confirmed D1 (date-only strings parsed as UTC midnight → previous day 19:00 in Bogota) and D2 (`toISOString().substring(0,10)` defaults → tomorrow after 19:00; edit pre-fill shifts evening timestamps +1 day). Parent reproduced both with `TZ=America/Bogota node`. Agent tool paths already use `parseLocalDate` (`functions/src/agentTools.ts:35`); manual saves use `new Date(d + 'T12:00:00')`.

### L2 — Routing
T1 and T2 touch 6+ non-trivial files across client and functions → one delegated writer, two work-unit commits. T3 waits for S4 product decision; current `installments.ts` imputes installment i to purchase calendar month + i by deliberate design (comment in `creditCycle.ts:1-5`), while `expenseAmountForCycle` already buckets by closing day for the card statement widget.

### L3 — Installment rule decision
After a clarification request ("explicame mejor") the user chose payment-month imputation for all card purchases (S5). Forecast rises to ~650 authored lines across T1–T3, above the ~400 delivery budget; no PR has been requested, so the chain-strategy question is deferred until delivery is requested.

### L4 — T1 partial result and surface expansion
Writer returned partial: T1 implemented uncommitted (`src/lib/dates.ts` `parseDateOnly`/`toDateValue`; store import mapping and read-back; goal deadline creation; server `statementRowDate` in pocketImports using the user's country time zone; `storedDateValue` in agentContext). Observed: `TZ=America/Bogota node --test src/lib/dates.test.ts` 4/4 (parent spot check re-ran: 4/4), `pnpm test:functions` 93/93, `pnpm build` OK, `TZ=America/Bogota pnpm test` 188/189 — `tests/runner/legacyAICapImportProducer.test.ts` evaluates `addTransactionsBatch` with injected identifiers and lacks `parseDateOnly`.
User approved ("Aprobar los 5 (Recomendado)") adding `tests/runner/legacyAICapImportProducer.test.ts`, `functions/src/http.ts`, `functions/src/agentTools.ts`, `functions/src/embeddings.ts`, `src/lib/mirror.ts` and their tests, covering the remaining date-only string read-back sites (`http.ts:216`, `agentTools.ts:139-141`, `embeddings.ts:41`, `mirror.ts:164`).

### L5 — T1/T2 verification
Writer (delegated) reported after both commits: `TZ=America/Bogota node --test src/lib/dates.test.ts` 6/6, `TZ=UTC` 6/6, `TZ=America/Bogota pnpm test` 195/195, `pnpm test:functions` 95/95, `pnpm build` OK, `git diff --check` clean. Parent spot check re-ran `TZ=America/Bogota pnpm test`: 195/195; commits carry no attribution lines. `gentle-ai review assess --base-ref e937a06 --committed-only --untracked-scope=exclude`: risk medium (`executable_change` functions/src/agentContext.ts), 21 paths / 296 lines, `review_due` false (`under_budget`); RDD off → writer self-verification plus spot check is the medium-tier proof. Legacy date-only embeddings re-hash once on their next trigger; no migration.

### L6 — Migration decision
Past AI/pocket imports were stored at exactly 00:00:00.000 UTC via `Timestamp.fromDate(new Date('YYYY-MM-DD'))` (both paths share `transactionsStore.ts:1178`), which is a reliable marker. The user declined a migration: "pues el importador no se usa desde hace rato (hace dos meses) entonces no creo que sea necesario, de resto son movimiento manuales". Not verified against production data. Residual effect: imported rows from 2+ months ago keep showing one day early; only rows dated on the 1st of a month land in the previous month in history charts and runway burn.

### L7 — T3 result and verification
Rule as implemented: credit, non-mirror accounts with both days as integers 1–31; payment month = statement month if due day > closing day, else next month (configured days, not clamped); installment i at payment month + i; checked against `getStatementClosingForDueDate` over 400 days for several day pairs. Edge choice: closing 30/due 31 pays February's statement in February (the widget would map 28 Feb to January's closing). `getCycleBucket` moved to `installments.ts`. Projection: commitments from purchases before this month are added once; only this month's purchases are extrapolated. Agent summary adds a two-month expense lookback and counts card payments due after today as upcoming.
Changed behaviour: Dashboard monthly expenses, MoM, savings rate, runway, projection and checks, member split, donut/top category, 6-month bars, budget widgets; Goals baseline and planner; `spendingByCategoryThisMonth`; agent `getFinancialSummary`/`getWorkspaceSettings`. Unchanged: "Compras registradas", card statement widget, "Disponible para gastar", card debt, event/project budgets.
Writer verification: `TZ=America/Bogota pnpm test` 218/218, `TZ=UTC pnpm test` 218/218, `pnpm test:functions` 110/110, `pnpm build` OK, `git diff --check` clean. Parent spot check: installments 17/17, `pnpm test:functions` 110/110; no attribution lines. `gentle-ai review assess --base-ref 023bdfb --committed-only --untracked-scope=exclude`: medium (`executable_change` agentContext.ts), 21 paths / 939 lines, `review_due` true (`slice_budget_reached`); RDD off → native review not started; medium tier proof = writer self-verification plus spot check. Branch total exceeds the ~400-line delivery budget; slicing deferred until a PR is requested.
Known gap: `tests/agent.tools.emulator.test.mjs` Visa fixture (closing 25, due 5; laptop 10 Sep x3) now expects Oct/Nov/Dec: this_month label `'cuota 1 de 3 (compra total 300000 COP)'`, last_month expenses 210,000 → 110,000 and net 3,790,000 → 3,890,000, this_week comment Oct 5. Not edited, not run.

### L8 — Emulator follow-up
Commit `9630468` (`test(agent): update emulator expectations for card payment months`) updated `tests/agent.tools.emulator.test.mjs`: this_month label → 'cuota 1 de 3 (compra total 300000 COP)'; last_month expenses 210,000 → 110,000, net 3,790,000 → 3,890,000; compareWithPrevious comparison expenses 210,000 → 110,000, expense delta {450000, 409}, net delta {550000, 14}; this_week comment Oct 5. Observed with demo project `demo-vault-access` and project-local CLI 15.34.0 / emulator cache (no denied path touched): RED 31/34 (agent tools 13/16) → GREEN 34/34 (access-control 14/14, embeddings 4/4, agent tools 16/16), clean shutdown.

## Delivery
- Docs commit of this file, fast-forward merge of `fix/date-offsets` into `main`, push `main` to `origin`, deploy Hosting and all 6 Cloud Functions (all load `index.ts`, which imports the changed modules) to `vault-41b34`. Firestore and Storage rules unchanged.

- Done: docs commit `9b0c9b5`; `main` fast-forwarded `e937a06..9b0c9b5` and pushed to `origin`; `firebase deploy --only hosting,functions --project vault-41b34` (project-local CLI 15.34.0, project-local npm cache) exited 0 with no errors or warnings in the log: 6 functions updated (`saveUserApiKey`, `parseStatement`, `syncTransactionEmbedding`, `chatWithAgent`, `inviteToWorkspace`, `importPocketStatement`), Hosting released at https://vault-41b34.web.app. No post-deploy smoke test in the browser.

## Progress
- Feature delivered. No migration (user decision). Out-of-scope audit findings D3–D13 remain open.
- Next step: after T1/T2 return and are spot-checked, launch the T3 writer.
