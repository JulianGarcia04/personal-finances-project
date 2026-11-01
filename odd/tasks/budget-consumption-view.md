# Budget consumption view (purchase cycle vs payment month)
Budgets count credit-card purchases in the month they are consumed (statement cycle), with a UI switch to see the payment-month view; alerts follow consumption.
Branch: `feat/budget-consumption-view` → `main` · Delivery: ask-on-risk · Runner: `pnpm test` (Vitest), `pnpm test:functions`, `pnpm build`.

## Specs
- S1: Budgets need two answers: "¿cuánto consumí?" and "¿cuánto tengo que pagar?". User: "considero que la UI deberia tener la opción de mostras las dos informaciones para responder las dos preguntas".
- S2: "Consumo del mes" view (default): a credit-card expense counts in the month of the statement cycle that contains the purchase (closing day rule, `getCycleBucket`), installments "una cuota por mes empezando ese mes (obviamente teniendo en cuenta la fecha de corte)". Confirmed examples (closing 30, due 15): 15-oct, 1 cuota → October; 31-oct, 1 cuota → November; 15-oct, 12 cuotas → 1/12 from October through September.
- S3: "Pagos del mes" view: the current rule (statement payment month), unchanged.
- S4: Non-card accounts, cards without both billing days, and mirror bridge accounts keep calendar-month imputation in both views.
- S5: The switch applies to budget surfaces (Goals: additional budget cards, protected baseline budget, planner "Gasto real del mes"; Dashboard budget widgets). Dashboard cash-flow KPIs and charts stay on the payment month. The choice is remembered per device.
- S6: UI clarity: each view states in one line what it counts, so card payments of earlier purchases are not a surprise. User: "cuando revisé mi presupuesto y todo vi en la UI que ya tenia plata gastada pero nunca se me ocurrió que eso fuera porque son pagos de tarjeta de credito".
- S7: Email and push budget alerts (`notifyBudgetThreshold`) use the consumption rule (S2).
- Assumption: the AI advisor's budget answers are unchanged in this feature (follow-up).

## Tasks
- T1 [done] — S2–S4 — Client imputation basis in `src/lib/installments.ts` (lookup carries the basis) with tests. Route: inline. Commit: `e5c7a6c`. RED 2/4 new tests failing → GREEN 21/21.
- T2 [done] — S1, S5–S6 — Budget view switch (per-device), wire Goals and Dashboard budget surfaces, copy per view, tests. Route: inline. Commit: `e5c7a6c`. budgetBasis RED (module missing) → GREEN 3/3; pnpm test 342/342; pnpm build exit 0.
- T3 [done] — S7 — Server port in `functions/src/http.ts`, alerts use consumption, tests, AGENTS.md alert docs. Route: inline. Commit: `69e066d`. RED (TS2554/TS2305) → GREEN; pnpm test:functions 201/201.

## Log
- L1 (2026-11-01, verbatim): "Quiero que revisemo el como se relacionan el presupuesto mensual protegido con los gastos... Ya que veo que lo gastos se marcan según la fecha del gasto, es decir que si yo gasté 15 octubre en una categoria, en mi presupuesto va salir ese presupuesto lleno hasta el 15 de noviembre, en vez de se mes vigente... Entonces revisemos eso y por que está así ? y que solución le podemos dar ?"
- L2: Cause found: commit 08d05b5 imputes card expenses to the statement payment month (`getPaymentBucket`) everywhere, budgets included. No rolling 30-day window exists anywhere.
- L3 (verbatim): "una cuota por mes empezando ese mes (obviamente teniendo en cuenta la fecha de corte)"; alerts follow consumption (proposed, not objected).
- L4 (verbatim): "si, impleméntalo ... revisa la UI si es clara o no y también revisa si porque el presupuesto cuenta 1 mes desde que se hizo el movimiento en vez del mes efectivo en el presupuesto"
- L5: UI review: no budget surface explained that card purchases counted in the payment month (only "Los gastos sin presupuesto asignado permanecen aquí"), which matches L4. Added the switch with a hint per view in Goals and a caption on the 3 Dashboard budget widgets. Not checked visually in the running app.
- L6: Risk: item 3 (shared helpers expenseAmountForMonth / createCardBillingLookup / cardBillingByAccount also feed cash flow and the advisor; default 'payment' keeps their output, pinned by tests). RDD off (clone_local). Independent verifier launched against fc2bf61..69e066d.
- L7: Independent verifier: S1–S7 PASS, no blockers. Default/payment output identical to fc2bf61 on client and server (differential probes, 0 diff lines); server/client consumption parity 0 diff. Advisories (not change-caused): month-end projection "Categorías con presupuesto" stays on the payment month (cash-flow KPI per S5); alerts only evaluate the current local month, so a purchase landing in next month's cycle is evaluated on the next write in that month (same gap existed with the payment month); "Ahorro real del mes" follows the switch. Parent spot check: pnpm test 342/342. Verifier scratch removed. Feature closed; Engram mirror pending (multiple active sessions).
