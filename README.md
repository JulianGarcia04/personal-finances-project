# Vue 3 + Vite

This template should help get you started developing with Vue 3 in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about IDE Support for Vue in the [Vue Docs Scaling up Guide](https://vuejs.org/guide/scaling-up/tooling.html#ide-support).

## Budget security tests

Use Node.js 24 and a process-local JDK 21 for the verified local test profile:

```sh
pnpm test
JAVA_HOME="/path/to/jdk-21" PATH="/path/to/jdk-21/bin:$PATH" pnpm test:budgets:security
```

`pnpm test` retains application unit tests and includes the budget-runner configuration regressions. The security command starts only Firestore for `demo-vault-b2` using `firebase.budgets.test.json`; ports 8185, 4415, 4515 and 9150 must be free. It never selects the production project.

Security files remain process-isolated but run one at a time (`--test-concurrency=1`), with a 15-second default test-execution bound (`--test-timeout=15000`). All security cases, SDK actors and fixture assertions are unchanged. See the [Node.js test-runner options](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency).

These controls reduce overlapping clients and expose stalled tests; they are not a proven fix for emulator gRPC framing faults. A separate overall supervisor is still needed to bound emulator startup and teardown. A timeout is a failed/incomplete check, not a reason to retry automatically.

## Expense budget classification API

`transactionsStore.assignExpenseBudget(transactionId, budgetId)` changes only an expense's `budgetId`. Pass an additional budget ID, `default-monthly`, or `null` to return to the protected default. It does not invoke normal financial editing, reverse balances, change installments/receipts/dates, or update a mirrored counterpart. Firestore rules still validate the actual budget workspace and archive state.

The action requires the authenticated active workspace. It updates local classification only after persistence succeeds and only while the same user/workspace and an expense row remain current; refreshed financial fields are preserved. `expensesForBudget(budgetId)` selects current-workspace expenses and resolves legacy absent/null membership without rewriting records. Manual, imported and AI entry paths remain unchanged.

## Operating budget management, reporting, and legacy cap units

- **Protected monthly baseline (`default-monthly`)**: Unassigned, legacy, imported, and AI-created expenses resolve to the protected monthly baseline backed by `categoryBudgets`. Each workspace explicitly confirms `categoryBudgetCurrency` once in **Presupuestos & Metas** (`/goals`); stored cap amounts are never converted or silently relabeled when the display currency changes.
- **Additional monthly and event/project budgets**: **Presupuestos & Metas** (`/goals`) supports creating, editing, and archiving additional `monthly` and `event` budgets with fixed `capCurrency` and optional `totalLimit` and per-category caps (`/budgets/{id}/categoryCaps/{categoryId}`). Archiving preserves existing assignments, history, and remaining installment obligations. Expenses and income can be assigned to a budget; income assigned to a budget and transfers into its linked accounts (minus transfers out) are its funds (available = funds − spending; a transfer's direction comes from its accounts, never its stored sign) and stays out of the month's income, and a budget with funds keeps its spending out of the month's spending vs income. A budget can link accounts (`linkedAccountIds`): every movement of a linked account belongs to that budget. Workspace switching in `Sidebar.vue` reloads budget settings for the active workspace.
- **Expense-only reassignment controls**: **Transacciones** (`/transactions`) renders budget reassignment controls only for persisted expenses across desktop rows, mobile cards, and the edit modal, invoking `transactionsStore.assignExpenseBudget` without mutating balances, credit-card debt, dates, receipts, installments, or mirror links. Archived budgets remain visible as disabled options only on expenses already assigned to them.
- **Truthful Dashboard reporting**: **Dashboard** (`/`) reports the protected monthly baseline in its confirmed unit (suppressing incomplete cross-currency comparisons when manual exchange rates are missing) and reports calendar-month estimated installment allocations across all budgets (including archived and event budgets) without adding event principal totals on top of monthly installments.
