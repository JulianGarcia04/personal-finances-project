# Dashboard KPIs

## Objective
Make Dashboard KPIs honest and forward-looking: fix two misleading calculations and add three new KPIs that need no new persisted data.

## Problem
- `getMoMData` (`src/views/Dashboard.vue` ~L455) compares month-to-date against the full previous month, so early in the month expenses/income always look sharply down.
- `liquidityDays` (~L499) divides month-to-date expenses by the full month length (underestimates burn, inflates runway) and uses total net worth instead of liquid balance.
- Dashboard only looks backward; no answer to "how much can I still spend?" or "how will this month close?" or "how much card debt / credit utilization do I have?".

## Why
A misleading KPI is worse than no KPI. Forward-looking KPIs drive decisions.

## Scope
- Pure helpers in `src/lib/dashboardMetrics.ts` + `src/lib/dashboardMetrics.test.ts` (node:test + assert/strict, same style as `installments.test.ts`).
- Wire into `src/views/Dashboard.vue`.
- Fix 1: period-aligned MoM — compare day 1..N of current month vs day 1..min(N, lastDay) of previous month.
- Fix 2: Runway → liquid balance (checking/savings/cash, excluding credit) / average daily expense over last 3 full months (fallback to current-month pace when no history).
- KPI 1 "Disponible para gastar": income this month − expenses this month − committed (pending credit-card payments due before month end, upcoming installments this month not yet counted) − planned goal contributions if available; plus per-day amount for remaining days. Exact formula decided from existing data during exploration; document it.
- KPI 2 "Proyección de cierre": projected month-end expenses at current daily pace; flag vs budget total / workspace expense limit.
- KPI 3 "Deuda en tarjetas": total credit card debt and utilization % of total limit (warn > 30%).

## Out of scope
- Net worth history/snapshots, period selector, AI insights card, fixed vs variable, anomalies.

## Constraints
- Test-first: RED before GREEN for helpers. Runner `pnpm test`; build `pnpm build`.
- Spanish UI copy, English code/comments. Respect existing glassmorphism + mobile layout (360px).
- Multi-currency: convert via existing `convert` to primary currency.

## Tasks
- [x] T1 Helpers + tests: aligned MoM, runway, spendable, month-end projection, card debt/utilization. Route: delegated (writer; 2+ non-trivial files).
- [x] T2 Wire into Dashboard.vue: fix MoM + runway, add 3 KPI cards with hierarchy (spendable as hero). Route: delegated (same writer).
- [x] T3 Verify `pnpm test` + `pnpm build`; mobile layout check (structural only, see evidence).

## Acceptance criteria
- MoM on day N compares same N days. Runway uses liquid balance and 3-month avg.
- Three new KPIs visible, correct for multi-currency, readable at 360px.
- Tests + build green.

## Delivery
Strategy: ask-on-risk. Forecast ~350–450 authored lines.

## Formulas (decided in T1)
All inputs are converted to the primary currency with `convert` before reaching `src/lib/dashboardMetrics.ts`.
- **Aligned MoM**: day 1..N of the current month vs day 1..min(N, lastDay) of the previous month. Each monthly installment is imputed on the purchase's day-of-month (clamped to the month's last day). Transfers/loans are never income or expense (only `type === 'income' | 'expense'`).
- **Runway** = liquid balance / daily burn. Liquid = balances of non-credit, non-mirror accounts (checking/savings/cash, pockets included; pockets are separate balances, not double counted). Daily burn = expenses of the last 3 full months that had activity / their days; fallback to month-to-date expenses / elapsed days. No burn → ∞; liquid ≤ 0 → 0 days.
- **Disponible para gastar** = available cash − card payments still due this month. Available cash = liquid balance excluding pocket sub-accounts (pockets are money set aside). Card payments due this month = for each credit card whose next due date falls in the current month, min(statement amount, current debt) (the cap avoids subtracting a statement already paid). Per day = amount / days left including today. Negative is shown as a deficit (not clamped), per day 0. Income/expenses are not re-subtracted: card purchases are already in the account balances/debt, and adding them again would double count. Planned goal contributions are not modeled (no data).
- **Proyección de cierre** = (purchases dated this month / elapsed days × days in month) + installments of earlier purchases imputed to this month. Warns when it exceeds the category budget total or the workspace expense limit.
- **Deuda en tarjetas** = Σ max(0, −balance) of non-mirror credit accounts; utilization = debt / Σ limit (null when no limit). Amber > 30%, rose > 70%.

## Progress / evidence
- T1 RED: `pnpm test` → `ℹ tests 66 / pass 65 / fail 1` — `ERR_MODULE_NOT_FOUND ... src/lib/dashboardMetrics.ts` (tests written before the module).
- T1 GREEN: `pnpm test` → `ℹ tests 85 / pass 85 / fail 0`. Route: delegated writer.
- T1 commit: `0563861` feat(dashboard): add pure KPI metrics helpers with tests.
- T2 fix commit: `2cfa13d` fix(dashboard): align MoM periods and base runway on liquid balance (labels now "vs mismo periodo del mes anterior"; runway shows ∞ when no burn).
- T2 feat commit: `cbce4b5` feat(dashboard): add spendable, month-end projection and card debt KPIs (hero "Disponible para gastar" md:col-span-2; "Proyección de cierre" with budget/limit warnings; "Deuda en tarjetas" with utilization bar, hidden without credit accounts).
- T3: `pnpm test` → `ℹ tests 85 / ℹ pass 85 / ℹ fail 0`. `pnpm build` (vue-tsc --noEmit && vite build) → `✓ 1828 modules transformed.` / `✓ built in 402ms`.
- T3 mobile 360px: structural check only — new cards use `grid-cols-1` base, `min-w-0`, `truncate`, `flex-wrap` and the existing `splitMoney` wrapping pattern. Not visually verified in a browser (requires auth + emulators); pending a manual check.
- Known caveat (pre-existing): `upcomingCardPayments` statement amount uses the current billing cycle; after the closing day it reflects the next statement. The min(statement, debt) cap bounds the error.

## Next step
Manual visual check at 360px; then the user decides push/PR.
