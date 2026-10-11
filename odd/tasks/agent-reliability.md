# AI agent reliability

## Objective
Make `chatWithAgent` answer realistic financial questions correctly (time-scoped summaries, multi-currency totals, budgets, CRUD with relative dates) and never fail silently or with a generic 500.

## Problem
Incident 2026-10-11: "Dáme un resumen de mis gastos de este mes" → agent said it cannot. Audit of 37 intents: ~9 OK; several silently WRONG. Verified causes (functions/src/index.ts unless noted):
- C1 No current date/timezone in the system prompt (~L773-802).
- C2 No period aggregation: `listTransactions` has no date filter (~L382); `getExpensesByCategory` returns one merged rolling window, no period bounds, no per-month split, "months back" description hides that months=1 = current month (http.ts `expensePeriod`).
- H1 Genkit 1.36 rethrows any non-interrupt tool error (`@genkit-ai/ai/lib/generate/resolve-tool-requests.js:152`) → whole chat 500.
- H2 Expenses must be negative (pockets.ts) but the prompt only explains loan signs.
- H3 Currency ignored: sums mix currencies; no `exchangeRates` access; `createTransaction` has no currency.
- H4 Workspace settings (`categoryBudgets`, `expenseLimit`, `budgetIncome`, `budgetAllocations`, `exchangeRates`) unreachable.
- H5 Agent-created expenses on bridge (mirror) accounts skip mirror replication (frontend `addMirroredExpense`).
- H6 `new Date('YYYY-MM-DD')` = UTC midnight → previous day 19:00 in Bogotá (createTransaction ~L444, createGoal ~L529).
- M1 `maxTurns` unset → Genkit default 5 (`lib/generate/action.js:365`); exceeding throws.
- M2 `listTransactions(accountId)` ignores incoming transfers (`toAccountId`).
- M3 Tool rows return raw ids + whole doc spread; no names.
- M4 `monthlyAverage` divides including the partial current month → biased low.
- M6 Destructive tools run without server-side confirmation; tool data not marked untrusted.
- M7 Obsolete prompt guideline 4 + chips "¿Tengo transacciones sin indexar?" / "Indexa mis transacciones ahora" (`Agent.vue:314-315`) and `indexTransactions` tool (backfill done, trigger keeps vectors fresh).
- M8 Error bubbles saved as assistant messages and resent as model turns (`Agent.vue:477-485`, `toBackendMessages` L290-296).
- LOW: renderer lacks tables/headings/numbered lists (`Agent.vue:499-520`); prompt uses `users.currency` instead of workspace currency; inconsistent semanticSearch return shape; no temperature; prompt promises "actualizar cuentas" with no tool.

## Scope
`functions/src/index.ts`, new `functions/src/agentQueries.ts` (+ tests), `functions/src/http.ts` helpers, `src/views/Agent.vue`, tests under `functions/src/*.test.ts` and `tests/`, `scripts/agent-eval.mjs`, `.agents/skills/about-project/SKILL.md`.
Out of scope: embeddings pipeline (M5 shared-expense legs excluded from semantic search → follow-up), bridge mirror replication on the server (agent rejects instead), deploying before all WUs pass.

## Constraints
- Code/comments English; prompt, tool descriptions and user-facing strings Spanish.
- No new runtime deps unless unavoidable (markdown renderer: hand-rolled, sanitized).
- No production writes; emulator `demo-*` projects only. Deploy only at the end (user authorized 2026-10-11).

## Acceptance criteria
- Prompt states today's date, weekday, timezone, current month, workspace currency, amount sign and balance conventions.
- "este mes / mes pasado / hoy / esta semana / este año / entre fechas" resolve to exact local-time ranges with explicit period bounds in tool output.
- Totals convert currencies with workspace `exchangeRates` (1:1 fallback flagged), prorate installments like the dashboard, exclude loans/transfers from spend.
- Tool failures come back to the model as `{error}`; chat never 500s on a tool validation error; `maxTurns` 8.
- Deterministic tests cover every aggregation preset with a fixed `now`; manual LLM eval script exists.

## Checks
`pnpm --filter functions build`; `pnpm test:functions`; `pnpm test`; `pnpm build`; `pnpm test:emulators`; `git diff --check`.

## Tasks
- [x] WU1 Prompt context + tool correctness: C1, H1, H2, H5, H6, M1, M2, M3, M6, M7 (server side), prompt cleanup, workspace currency. Route: delegated (writer trigger: index.ts + new agentTools.ts/test + http.ts + indexes).
- [x] WU2 Aggregation: `getFinancialSummary` (presets/date range, groupBy category|account|month, currency conversion, installment proration, period bounds, comparison), `getWorkspaceSettings` (budgets vs actual, expenseLimit, declared income), optional `getCreditCardStatus`; fix M4; pure functions in `agentQueries.ts`. Route: delegated.
- [x] WU3 Frontend: chips for new capabilities, M8 errors out of history, markdown tables/headings/numbered lists (sanitized). Route: delegated.
- [ ] WU4 Regression eval: deterministic fixtures (mixed currency, installments across months, transfers, loans, bridge expense, UTC-midnight-on-1st, fixed now) + emulator tool tests + `scripts/agent-eval.mjs` (37 questions, asserts tool calls/args and numbers; manual, never CI). Route: delegated.
- [ ] Deploy functions + hosting; smoke check logs. Route: inline.

## Delivery
Strategy: same as backend audit — work-unit commits on `feat/agent-reliability`, merge to main when user asks.

## Progress
- 2026-10-11: branch `feat/agent-reliability` from `main` c8a7982. RDD off (clone-local).
- 2026-10-11: WU1 done. Pure helpers in `functions/src/agentTools.ts` (date context, `parseLocalDate` = local noon like the app, `localDayRange`, `signedAmount`, `toLeanTransaction`, `safeTool`, `relaxJsonSchema`); tests RED (missing module) → GREEN 11/11. Tools registered with a bound-free JSON schema and validated inside `safeTool`, because Genkit throws on schema-invalid tool input. Auth/permission errors still throw (as 403). `listTransactions` got date range + incoming transfers (new index `workspaceId+toAccountId+date`). `indexTransactions` tool removed; delete/saveCategoryBudgets need `confirmed: true`; bridge expenses rejected; `maxTurns: 8`, temperature 0.3; prompt uses workspace currency. Checks: functions build OK; test:functions 62/62; test 48/48; build OK; test:emulators 36+18+12 pass; diff --check clean. Not covered by automated tests: live Gemini tool calling (WU4 eval).

- 2026-10-11: WU2 done (route: delegated; writer trigger: new agentQueries.ts/test + index.ts). Pure core `functions/src/agentQueries.ts`: `resolvePeriod` (presets, inclusive local ranges, `lastCompleteMonths`; Monday weeks; default this_month), `previousPeriod` (previous calendar month/year/N months, else equal-length range), `convertToPrimary` (port of goalsStore L46-50, 1:1 fallback flagged in notes), `summarize` (Dashboard getMoMData semantics: income full at its date, expenses via installment shares to the cent, transfer/loan/loan_payment excluded, mirror leg is a transfer so excluded, local bridge leg counts; share k dated purchase day + k months, so whole months equal `expenseAmountForMonth`; `upcomingInstallments` = future shares included), `monthlyAverages` + averages only over complete months (M4), `buildBudgetStatus` (port of Dashboard budgetSummary L556-584). Tools `getFinancialSummary` and `getWorkspaceSettings` (fresh workspace read, 50/30/20 split with goalsStore defaults, goal allocations with names, month budget vs actual, expenseLimit). `getExpensesByCategory` removed; prompt gained a tool-routing section and the budget flow uses `lastCompleteMonths`. Queries reuse existing indexes (`workspaceId+date DESC` with range + orderBy, `workspaceId+type+installments`); no index change. Tests RED (missing module) → GREEN 13/13. Checks: functions build OK; test:functions 75/75; test 48/48; build OK; test:emulators 36+18+12 pass; diff --check clean. Size ~850 added lines (over the 400 heuristic: pure core + fixture-exact tests). Decisions/follow-ups: currency is the workspace currency (dashboard uses `users.currency` via settingsStore — differs only if they diverge); `getCreditCardStatus` skipped (listAccounts already returns limit/available; installment debt per card is a follow-up); `.agents/skills/about-project/SKILL.md` still lists `getExpensesByCategory` (outside WU2 edit surface); `http.ts` `expensePeriod`/`expenseAmountForMonth` now unused by index.ts (kept, still unit tested).

- 2026-10-11: WU3 done (route: delegated; writer trigger: Agent.vue + new agentMarkdown.ts/test + chatsStore.ts). `src/lib/agentMarkdown.ts` `renderAgentMarkdown`: escapes all HTML (incl. quotes) first, then emits only its own tags — headings (#→h3, ##→h4, ###+→h5), ul/ol (with `start`), GFM pipe tables with alignment inside an `overflow-x-auto` wrapper, fenced code, hr, inline code, bold/italic (no snake_case or `2 * 3` false positives), http(s)-only links with `target=_blank rel="noopener noreferrer"`; NUL-delimited placeholders protect code/link spans (NUL stripped from input). Tests RED (missing module) → GREEN 17/17 (XSS: script/img, quote escaping, table-cell attribute injection, javascript:/data:/mixed-case schemes, href breakout). M8: `ChatMessage.isError` (UI-only); `chatsStore.addErrorNotice`/`clearErrorNotices` keep notices in memory; persistence filters `isError`; `toBackendMessages` drops `isError` and legacy persisted `⚠️` assistant notices; user message stays persisted; "Reintentar" button on the latest error re-sends the history; post-reply data sync failures no longer become error notices. Chips: removed index chips; added resumen/compara/presupuesto/top-5/ropa; kept patrimonio, registrar gasto, metas, consejos, crear cuenta; intro copy no longer mentions indexing. Markdown styles (tables, headings, lists, code, links) in Agent.vue using theme tokens. Checks: test 65/65; build OK; test:functions 75/75; diff --check clean; headless Chromium (cached Playwright build, raw `--screenshot`) at 358px content width: bubble scrollWidth = clientWidth (343), table wrapper scrolls (441 in 313), `<script>` rendered as text. Not covered: live chat flow in the app (needs emulators + Gemini). Follow-up: legacy persisted `⚠️` notices still display as normal assistant bubbles (only excluded from the model history).

## Next step
WU4 (regression eval: deterministic fixtures + emulator tool tests + `scripts/agent-eval.mjs`).
