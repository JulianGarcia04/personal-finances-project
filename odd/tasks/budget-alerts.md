# Budget category alerts by email

## Objective
Email workspace members when a monthly category budget (`workspaces/{id}.categoryBudgets`) is about to be reached (>= 80%) or reached (>= 100%), so they know to stop spending in that category.

## Problem / Why
Category caps exist but nothing warns the user; overspending is only visible if they open the app.

## Scope
- Firestore trigger on `transactions` writes: recompute month-to-date spend for the affected category, compare with its budget, email once per (workspace, category, month, threshold).
- Email via own Cloud Function + `nodemailer` over Gmail SMTP (app password as Functions secret). NOT the Firebase "Trigger Email" extension: Firebase Extensions shut down 2027-03-31 (extensions.dev).
- HTML email template versioned in repo (Spanish user-facing copy, matches app UI language).
- Server-only dedupe ledger so each threshold notifies once per month.
- Settings toggle to enable/disable alerts (default on).

## Constraints
- Spend computation must match how the app already computes category spend vs budget (sign, transfers excluded, currency conversion with workspace `exchangeRates`).
- SMTP credentials never reach the client or logs.
- Firestore rules: dedupe ledger server-only.

## Tasks
- [x] T1 Pure alert logic (threshold evaluation, month key, spend aggregation) + unit tests (RED first).
- [x] T2 Trigger + mailer (nodemailer, secrets, template, dedupe ledger, rules) + tests.
- [x] T3 Settings toggle (workspace field) + docs (README/AGENTS env vars).

## Delivery strategy
ask-on-risk. Forecast ~400-550 authored lines.

## Route declaration
- T1-T3: delegated direct (writer trigger: 2+ non-trivial files).

## Progress / evidence
- T1 (delegated writer): `functions/src/budgetAlerts.ts` + `budgetAlerts.test.ts`. RED observed (`pnpm --filter functions test`: TS2307 cannot find module './budgetAlerts'), then GREEN (100/100 pass, 15 new). Spend semantics mirror `transactionsStore.spendingByCategoryThisMonth` (expenses only, |amount|, installments split per month, `convertToPrimary` 1:1 fallback); reuses server ports `http.ts expenseAmountForMonth` and `agentQueries.ts convertToPrimary`. 100% implies 80% (single email); notified thresholds never re-alert within the month.

- T2 (delegated writer): `notifyBudgetThreshold` (onDocumentWritten `transactions/{id}`, retry + `isEventTooOld` guard, secrets `SMTP_USER`/`SMTP_PASS`), `mailer.ts` (nodemailer Gmail, optional `ALERTS_FROM`, skips with a warning when secrets are missing), `templates/budgetAlert.ts` (Spanish copy, HTML-escaped names), server-only ledger `budgetAlerts/{workspaceId}_{YYYY-MM}_{categoryId}` claimed in a Firestore transaction before sending; claim released on send failure so the retry re-sends. Rules: `budgetAlerts` deny-all. RED observed (TS2305/TS2307 missing exports/modules), then GREEN: `pnpm --filter functions test` 109/109; `pnpm test:emulators:rules` 34/34 (no new rules test: `tests/` outside the authorized surface).
- Decisions: time zone and primary currency from the workspace owner's profile (`timeZoneForCountry(country)`, `resolvePrimaryCurrency`), America/Bogota / COP fallbacks; only the current local month is evaluated; recipients = all `workspace.members` (profile email, Auth fallback) in one message.

- T3 (delegated writer): `goalsStore.budgetAlertsEnabled` (absent → true) + `saveBudgetAlertsEnabled`; toggle in Settings → Workspace (same switch markup as the AI importer toggle, reverts on save error); `budgetAlertsEnabled` added to `workspaceSettingsKeys()` in firestore.rules; AGENTS.md documents `functions/.secret.local` for emulators, `firebase functions:secrets:set SMTP_USER|SMTP_PASS` for production, Gmail app password and optional `ALERTS_FROM`. README.md is a 5-line Vite stub with no setup section, so it was left unchanged. No runnable RED for the Vue toggle (no component test harness); checks: `pnpm exec vue-tsc --noEmit` exit 0, `pnpm --filter functions test` 109/109, `pnpm test:emulators:rules` 34/34.

## Commits
- T1 `acb1804` feat(functions): add pure budget threshold alert logic
- T2 `0775742` feat(functions): email members when a category budget hits 80% or 100%
- T3 `b49b32a` feat(settings): add budget alert email toggle and SMTP setup docs
- Parent spot check: `pnpm --filter functions test` 109/109 pass.

## Next step
Parent: native review assessment of the three work-unit commits; manual smoke test with real Gmail app password.

---

# Phase 2: push notifications (FCM)

Branch `feat/budget-alerts-push` (from main 08ba2be). Runner: `pnpm --filter functions test`, `pnpm exec vue-tsc --noEmit`, `pnpm test:emulators:rules`.

## Specs
- S1 "vamos a hacerlo por correo con mi correo personal pero también vamos a usar cloud messaging": the same budget threshold alerts (80% / 100%) are delivered by email (Gmail SMTP, unchanged) AND by Firebase Cloud Messaging web push.
- S2 (assumption) Push opt-in per device from Configuración: request browser permission, register FCM token in `users/{uid}/pushTokens/{token}` ({token, userAgent, createdAt}); user can disable on that device (delete token).
- S3 (assumption) Server sends push to every workspace member's registered tokens after claiming the threshold; push failures never block or undo the email; invalid/unregistered tokens are deleted.
- S4 Requires a web app manifest + `firebase-messaging-sw.js` service worker; iOS only receives push when installed to the home screen.
- S5 VAPID public key provided via `VITE_FIREBASE_VAPID_KEY`; push UI hidden/disabled with explanation when missing or unsupported.

## Tasks
- P1 client: SW, manifest, push lib, Settings UI, rules for pushTokens — delegated (parallel writer, unit A).
- P2 server: FCM send in notifyBudgetThreshold + invalid token cleanup + tests — delegated (parallel writer, unit B).
- P3 independent verify (Risk item 2: firestore rules/permissions) + docs.

## Log
- L1 (2026-10-20) "bueno vamos a hacerlo por correo con mi correo personal pero también vamos a usar cloud messaging"
- Route: parallel writers (two independent units, disjoint edit surfaces, contract = token doc path/shape fixed in S2).
- Commits: P2 `5d004d4` (server push), P1 `4811b88` (client push + rules, App.vue foreground listener wired by parent), docs `c5c6707`.
- Seam check (parent): vue-tsc OK, vite build OK, functions 125/125. Rules 37/37 (writer + verifier).
- P3 independent verify (Risk item 2): S1-S5 PASS; no security blockers. Blocker B1 (shared browser: push token cached per browser not per user, logout kept registration) fixed in next commit: storage scoped to uid, logout unregisters device. No frontend unit runner -> no RED; checked by vue-tsc + build.
- Advisories accepted/not done: A1 no per-user token cap; A2 revoked permission leaves token doc until FCM prunes it; A3 click focuses open tab without navigating to /goals; A4 APP_URL origin must match hosting origin; A5 lock screen shows amounts; A6 SW pins gstatic firebase 12.14.0.
- Behavior notes: email first then push (no duplicate push on retry; if email always fails, no push). Threshold claimed for push-only (no SMTP) won't email later that month.
- Next step: user decides merge/push/deploy; user generates VAPID key + Gmail app password.

---

## Log — merge reconciliation with origin/main (2026-10-21)
- Context: `git merge --no-commit --no-ff origin/main` brought multiple budgets (operating budgets, captured category caps, legacy cap currency confirmation, expense budget assignment, currency-aware reporting), card installments in the statement payment month, and local parsing of date-only values.
- Conflicts: `firestore.rules` keeps main's `categoryBudgetCurrency` plus this branch's `budgetAlertsEnabled` in `workspaceSettingsKeys()` (the `isValidCategoryBudgetCurrencyUpdate()` guard still applies), and keeps both the `budgetAlerts` deny-all ledger and main's `budgets`/`categoryCaps` rules. `goalsStore.ts` uses main's adapter-based load/save. `budgetAlertsEnabled` is loaded from the workspace doc in `createGoalsBudgetActions.loadBudgetSettings`, reset to true on workspace switch, and saved by `saveBudgetAlertsEnabled` through `loadGoalsRuntime`.
- Semantic change: alerts now mirror `src/lib/budgetReporting.ts reportBudgetScope`. Each expense counts against the cap of its operating budget (`budgetId`, or `default-monthly` when absent). Default budget: `workspaces.categoryBudgets` in the confirmed `categoryBudgetCurrency`. Active additional budgets: `budgets/{id}/categoryCaps/{categoryId}.amount` in `capCurrency`. Monthly budgets compare this month's share, with card installments in the statement payment month (`cardBillingByAccount` + `http.ts expenseAmountForMonth`). Event budgets compare the full committed principal. Expenses and caps are converted to the owner's primary currency with manual rates. Unconfirmed cap units or a missing or invalid rate means no alert (the old 1:1 fallback was removed). Archived budgets never alert. `budgetId` and `accountId` edits now re-evaluate the alert.
- Ledger: the default budget keeps `{ws}_{YYYY-MM}_{cat}`. Additional budgets use `{ws}_{budgetId}_{YYYY-MM|event}_{cat}`, and ledger docs now store `budgetId`. Email and push copy name non-default budgets, and event alerts have no month. Push `data.budgetId` is sent only for non-default budgets.
- Evidence: RED `pnpm --filter functions test` showed TS2305/TS2724/TS2554 (missing `categorySpendForScope`/`capInReportingCurrency`/`resolveAlertBudgetId`, new ledger id signature). GREEN: functions 160/160, root `pnpm test` 218/218, `pnpm test:emulators:rules` 38/38 (new: member toggles `budgetAlertsEnabled` with the `categoryBudgetCurrency` guard intact), `pnpm test:budgets:security` 76/76, `vue-tsc` exit 0, `pnpm build` OK. RED for the email/push copy tests was not separately observed, because the template edit landed before the first run.
- Open product questions: alerts on a budget's `totalLimit` (overall cap) are not implemented. Event-budget alerts (once per budget/category across its whole life) follow the reporting comparison but were not explicitly requested.
- (2026-10-21) Merge `e424645` (origin/main + alerts reconciled with multiple budgets; functions 160/160, rules 38/38, root 218/218, budgets security 76/76). main fast-forwarded and pushed. Deployed functions + firestore:rules + hosting to vault-41b34 (`--force` only to accept retry policy for notifyBudgetThreshold; verified all 6 deployed functions exist in source, nothing deleted). notifyBudgetThreshold created; SMTP secrets granted. Independent verifier not re-run for the reconciliation: rules delta vs origin/main is purely additive and covered by rules tests.
- Pending: real-device push + real Gmail smoke test by user.

# Phase 3: overall budget cap alerts (branch feat/budget-total-alerts)
- L (2026-10-21) "quiero que lo haga — No existen alertas por el tope total de un presupuesto, solo por categoría." / "y tambien con el presupuesto por default que hay" / "no solamente con los presupuestos creados". Decision (AskUserQuestion): default budget total = "Igual al Dashboard" (Dashboard.vue:881-895: capped categories' spend clamped per cap over sum of positive caps).
- S1 additional budgets with `totalLimit`: alert 80/100 on all scope expenses (uncategorized included), monthly share or event principal, cap in `capCurrency` (reportBudgetScope totalComparison).
- S2 default budget: alert 80/100 on dashboard usage. Ledger slot `__total`.
- Route: inline (no writer reason). RED: TS2305/TS2353 missing exports/field; GREEN functions 167/167.
- Trigger now queries all workspace expenses (was per category) and delivers category then total sequentially via deliverBudgetAlert.
- Commit `f397417`. Independent verify (Risk item 6): S1 PASS, S2 PASS, category alerts unchanged vs main (ledger ids, copy, claim/retry), no blockers; functions 167/167. Advisories: trigger wiring still has no direct test; each qualifying write reads all workspace expenses; total ledger uses `categoryId: "__total"`.
- Next step: user decides merge to main + deploy functions.
- L (2026-10-21) Requirement change: "yo digo que esa alerta debe ser con el total de los ingresos mensuales contra el total de los gastos, porque que pasa si yo gano 5 millones y la suma de mis categorias me da 6 millones, nunca me llegaria el alerta." Income source answer: "Yo digo que las dos opciones, en caso de que no tenga el planificador, entonces usa los ingresos reales (yo digo que ingresos reales es más seguro porque es decir yo registro todos los meses 5 millones en ingresos, pero este mes me llegó más plata entonces eso se extiende)".
- S2 rewritten: default budget overall alert = month's spending (every budget's expense month share, installments in payment month, archived budgets included) vs income reference = max(planner budgetIncome, income registered in the local month); either alone when the other is absent; no alert when neither. Ledger `{ws}_{YYYY-MM}___total`. Dashboard-style usage removed (never deployed).
- RED: TS2305/TS2353 (missing exports, incomeBudget field). GREEN: functions 170/170.
- Independent verify of 3553e34 (Risk item 6): all 6 checks PASS, no blockers, 170/170. Advisory A1 (income with undefined/garbage date threw RangeError, failing the whole trigger) fixed: RED 170/1 -> GREEN 171/0. Accepted advisories: missing tx currency = no alert (no 1:1, consistent with category alerts); planner income assumed in owner's primary currency; income edits alone never trigger; each current-month expense reads all workspace expenses+incomes; push data can't distinguish income vs total alert; trigger wiring still without direct test.
- Next step: user decides merge to main + push + deploy functions.
