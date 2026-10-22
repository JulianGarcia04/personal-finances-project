# Budget assignment UX
Objective: let users assign expenses and income to budgets at creation, link accounts to budgets, fund event budgets with income (model B), and move existing movements into a budget.
Branch: `feat/budget-assignment-ux` · Delivery: ask-on-risk (forecast ~900–1,200 lines → chained PRs) · Runner: `node --test` (`pnpm test`), functions `pnpm test:functions`, rules `pnpm test:budgets:security`.

## Specs
- S1: Creating an expense or income (`Transactions.vue` and the goal contribution in `Goals.vue`) shows a "Presupuesto" selector with active budgets plus the default monthly budget; saved through `addTransaction({ …, budgetId })`. User: "pienso que tambien los ingresos deberian estar ligado a un presupuesto".
- S2: A budget has `linkedAccountIds`. A transaction from a linked account inherits that budget at save time (selector prefilled, user may change it). An account belongs to at most one active budget; linking it to another warns. User: "si yo relaciono la cuenta con el presupuesto, entonces las transacciones que yo haga esa cuenta no se liga a ese presupuesto también (por herencia) ?"
- S3: Creating or editing an event budget offers "Mover N movimientos existentes": default-monthly expenses and income from linked accounts or capped categories, within the date range when set; preview with per-row uncheck; applied as budgetId-only updates in batches.
- S4: Microcopy in the budget form and card: "Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada".
- S5: Income with a budget is excluded from the monthly income in Budgets ("Ingreso real del mes") and from the alert income reference (`functions/src/budgetAlerts.ts`).
- S6 (model B): funds = linked income; available = funds − linked expenses; the cap stays optional and independent; budgets without linked income look as today; the card shows funds and cap bars when both exist. User: "sí, vamos con la B".
- S7: Funds alert at 80 % and 100 % by email and push, reusing the existing threshold ledger.
- S8: Every new surface must have good UI and UX, consistent with the existing glass/mobile design (BaseSheet, `.field`, `.tap`). User: "A su vez recuerda que uno de los requisitos es que tenga buen UI y buen UX"
- Out of scope: the AI agent (`chatWithAgent`) does not apply links.

## Tasks
- [x] T1 · S1, S2 · inline · rules: income `budgetId`, budget `linkedAccountIds` (list ≤ 20) + rules tests · Risk item 2 · commit: see L4
- [ ] T2 · S1, S2, S4, S8 · inline · assigner allows income; selector at creation; link UI + inheritance; microcopy
- [ ] T3 · S5, S6, S8 · inline · reporting funds/available, monthly income exclusion (client + alert), card bars · Risk item 3
- [ ] T4 · S7 · inline · funds alert in `budgetAlerts.ts` · Risk item 5
- [ ] T5 · S3, S8 · inline · preview + bulk move

## Log
- L1 (2026-10-21): "Hay un problema, yo tengo plata ahorrada pero en mis presupuestos se tienen en cuenta toda mi plata ahorrada. Entonces quiero analicemos esa parte"
- L2: Read-only prod dump of workspace mUicNHxsNURMjC24tyWg: all 17 expenses have `budgetId: null`, spent from cash accounts named like event budgets; October default-monthly total 8,104,890 vs 10,120,000 triggered a false 80 % alert. Root cause: creation form has no budget selector.
- L3: User approved plan "sí, planifícalo con 1, 2 y 3", objections (income budgets, inheritance), link stored on budget ("dejemoslo así"), model B, and "sí, arranca la implementación".
- L4: Tasks reordered so the rules change (risk item 2) lands alone first. `pnpm test:budgets:security` 78/78 pass. RED not observed first (rules edited before tests).
