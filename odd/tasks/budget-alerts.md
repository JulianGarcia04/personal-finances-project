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
