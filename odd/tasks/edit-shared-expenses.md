# Feature: Edit shared expenses and keep bridge accounts expense-only

Objective: let a user edit a shared (bridge) expense end to end across both workspaces, and stop bridge accounts from holding movements that are never mirrored.
Branch: `feat/edit-shared-expenses` (from `main`). Delivery strategy: `ask-on-risk`. Test runners: `pnpm test` (node --test), `pnpm test:functions`, `pnpm test:emulators` (Firestore rules + real stores on emulators).

## Specs

- **S1 — Edit a shared expense end to end.** The user asked: "si yo edito ese movimiento se va a ver reflejado ese cambio de punta a punta, no habrá desface o incongruencias en la información ?". Editing either leg of a shared-expense pair (the bridge expense or its mirror transfer) updates both legs and the three balances (bridge, source, receivable) in one atomic write. Amount, date and description apply to both legs; category, notes, receipt, installments and member apply to the edited leg only. The pair keeps the accounts stored on its legs, not the bridge's current mirror configuration.
- **S2 — What stays non-editable.** Movement type and accounts of a shared expense are not editable (user: "bueno dejemoslo así, tenes razón no hay posibilidad de que haya un ingreso en una cuenta puente"). Settlement pairs keep their reversal flow; pairs touching pocket accounts stay blocked. The edit form locks type and accounts for a shared expense and says the change also applies in the other workspace.
- **S3 — A bridge account only holds shared expenses.** Income, transfers, loans and loan payments cannot be recorded on, moved onto, or sent to a bridge account; settlements keep using their own flow. Enforced in the app store, the new-movement form, the server mutation used by the agent, and Firestore rules.
- **S4 — Rules keep both legs together.** Firestore rules reject a movement referencing a bridge unless it is a reciprocal mirror leg (shared expense, settlement or reversal) written with its twin, and reject editing one leg of a shared expense without its twin changing to the same amount, date and description. Structure fields (type, accounts, currency, links) of a mirror leg are immutable; reversal markers and budget-only updates keep working.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S3, S4 (create/move-onto guard) | inline | done | RED on base rules/store: 2 new emulator tests failed (58/60); GREEN: emulators 60/60, `pnpm test` 376/376, `pnpm test:functions` 215/215, `pnpm build` ok. Commit `fix(bridges): keep bridge accounts expense-only` |
| T2 | S1, S2, S4 (pair edit) | inline | pending | |

Route evidence: both tasks touch `src/stores/transactionsStore.ts`, `firestore.rules` and the same emulator tests, so they are not disjoint units; no writer trigger applies. Risk: item 2 (security rules) → one independent verifier at the feature end.

## Log

- **L1 (2026-11-11, user, verbatim):** "sí, implementa todo" — answering: "¿Lo implemento todo (la edición más la corrección del bug)?"
- **L2:** Earlier turns: "y si creamos la funcionalidad de que se pueda editar, que tan dificil es ? o nivel negocio sería buena opción ?"; "yo digo que el tipo de movimiento también deberia ser editable ya que muchas veces se me olvida cambiar de gasto a ingreso"; then "bueno dejemoslo así, tenes razón no hay posibilidad de que haya un ingreso en una cuenta puente".
- **L3 (evidence):** `updateTransaction` refuses any leg with `mirrorOf` (`src/stores/transactionsStore.ts:1445`); deleting a pair also deletes the receipt from Storage. `addTransaction` mirrors only `type === 'expense'` on a bridge; income/transfer/loan on a bridge are saved unmirrored and desync bridge vs receivable. The agent (`functions/src/agentContext.ts:254`) only blocks expenses on bridges; `mutateWorkspaceTransaction` has no bridge guard on its legacy path. Rules (`normalTransactionReferencesRoots`, `isValidTransactionUpdate`) accept both. Statement imports already refuse bridges.
