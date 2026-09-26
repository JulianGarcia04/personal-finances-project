# Transfer neutral display

## Objective
Render `transfer` transactions with a neutral visual treatment so they are not confused with income (green `+`) or expenses (red `-`).

## Problem
Transaction rows in `src/views/Transactions.vue` (table row ~L180, mobile card ~L274) and `src/views/Dashboard.vue` (recent transactions ~L309) decide color and sign prefix from `tx.amount >= 0` only. A transfer between own accounts therefore looks like income or an expense, and the destination account is never shown.

## Why
User cannot tell whether a movement actually reduces their net worth.

## Scope
- New pure helper in `src/lib/transactionDisplay.ts` with tests (`src/lib/transactionDisplay.test.ts`, node:test + assert/strict, same style as `installments.test.ts`).
- Wire helper into the three render sites above.
- Transfers: amber color (`text-accent-amber`), no `+`/`-` prefix, absolute amount, secondary line `Origen → Destino` using account names.
- Income/expense/loan/loan_payment: unchanged sign-based rendering.

## Out of scope
- Persistence sign changes, KPI math (already filters by type), settlement logic.

## Constraints
- Strict TDD: observe RED before implementation, then GREEN, then refactor.
- Runner: `pnpm test` (node --test). Build check: `pnpm build` (vue-tsc + vite).
- Spanish UI copy preserved; code/comments in English.

## Tasks
- [x] T1 Helper `getTransactionDisplay(tx, resolveAccountName)` returning `{ tone: 'income'|'expense'|'transfer', amountClass, prefix, amount, route?: string }` — RED test first, then GREEN.
- [x] T2 Wire helper into `Transactions.vue` table row and mobile card, and `Dashboard.vue` recent list; show route line for transfers.
- [x] T3 Verify: `pnpm test` green, `pnpm build` green.

## Acceptance criteria
- Transfer rows show amber amount with no sign prefix and a `A → B` line.
- Income rows still green `+`, expense rows still red.
- All tests and build pass.

## Progress / evidence
- T1 RED: `pnpm test` → `ERR_MODULE_NOT_FOUND` for `src/lib/transactionDisplay.ts`; 20 pre-existing tests still passed, 1 new suite failed as expected (module missing).
- T1 GREEN: created `src/lib/transactionDisplay.ts` with `getTransactionDisplay`. `pnpm test` → `tests 27, pass 27, fail 0`.
- T2: wired `displayOf(tx)` (calls `getTransactionDisplay(tx, getAccountName)`) into `src/views/Transactions.vue` table amount cell (~L181-184), mobile card amount (~L275-278), and `src/views/Dashboard.vue` recent transactions list (~L309-314). Added route line (`Origen → Destino`) for transfers in all three spots.
- T3: `pnpm test` → `tests 27, pass 27, fail 0`. `pnpm build` → `vue-tsc --noEmit && vite build` succeeded, `✓ built in 504ms`, no type errors. `git status --short` shows only expected files touched (`src/views/Dashboard.vue`, `src/views/Transactions.vue`, new `src/lib/transactionDisplay.ts`/`.test.ts`); `.atl/*` changes are pre-existing/untouched by this task.

## Next step
Done — feature complete, ready for review. No further steps planned.
