# Launch readiness (phase 1: launch blockers before billing)
Close the non-billing launch blockers found in the SaaS readiness review so Vault can open a private beta.
Branch: `feat/launch-readiness` → `main` · Delivery: ask-on-risk; no push, merge or deploy without the user's request · Runner: `pnpm test` (node:test), `pnpm build` (vue-tsc + vite).

## Specs

Source: the assistant's roadmap step 1, "Bloqueantes sin cobro: legal, login, borrar y exportar datos, analítica, landing con lista de espera", accepted by the user with "okey prosigamos" (L2).

- **S1 Password recovery.** Roadmap gap: "No hay entrada con Google ni recuperación de contraseña." The login screen offers password recovery by email (Firebase `sendPasswordResetEmail`). The response does not reveal whether the email is registered.
- **S2 Google sign-in.** Same roadmap gap as S1. Login and signup offer "Continuar con Google". A first Google sign-in creates the same personal workspace and profile that email signup creates; later sign-ins reuse them.
- **S3 Legal consent.** Roadmap gap: "la Ley 1581 de 2012 (habeas data) exige política de tratamiento de datos, autorización del usuario y términos de uso." Public pages for the data-processing policy and the terms of use. Signup requires explicit acceptance, and the profile records the accepted document versions with a server timestamp. Assumption: the data controller's identity (legal name, ID number, address, contact email) stays as clearly marked placeholders until the user provides it; the text needs legal review before public launch.
- **S4 Data export.** Roadmap gap: "También faltan borrar la cuenta y exportar los datos." A signed-in user can download the active workspace's data from Settings.
- **S5 Account deletion.** Same roadmap gap as S4. Blocked: product decision on what happens to shared workspaces the user owns or belongs to.
- **S6 Measurement.** Roadmap gap: "no hay analítica ni monitoreo de errores." Blocked: provider choice and accounts.
- **S7 Landing.** Roadmap gap: "el router solo tiene /login y la app. No hay página pública ni página de precios." Blocked: first customer segment (question asked in L1 reply, unanswered).

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1, S2 | inline | implemented, verifier pending | RED 6 fail → GREEN 12/12 (`src/lib/authProfile.test.ts`, `src/views/Login.test.ts`); `pnpm test` 235/235; `pnpm build` OK; Risk: item 2 (auth) |
| T2 | S3 | inline | done | RED 6 fail → GREEN 22/22 (`src/lib/legal.test.ts`, `src/lib/authProfile.test.ts`, `src/views/Login.test.ts`); `pnpm test` 245/245; `pnpm build` OK; UI checked at 390px (register consent, `/privacidad` draft banner); Risk: item 2 (consent recorded at account creation) |
| T3 | S4 | inline | done (fetch not run against Firestore yet) | RED 3 fail → GREEN 6/6 (`src/lib/dataExport.test.ts`, `src/views/Settings.test.ts`); `pnpm test` 251/251; `pnpm build` OK; read-only, same `workspaceId` queries the stores use; Risk: none |
| T4 | S5 | inline | blocked (decision) | |
| T5 | S6 | inline | blocked (accounts) | |
| T6 | S7 | inline | blocked (decision) | |

Route evidence: each unit is one understood change under ~400 lines with no parallel independent unit launched alongside it, so no Writer trigger fires.

## Log

- **L1 (2026-10-28, user):** "quiero que centrar a vault como un sass entonces revisemos eso y validemos que le faltaria para ser un sass competitivo... revisas productos similares y como podemos llegar a esto... la cuestión es lanzarlo al mercado"
- **L2 (2026-10-29, user):** "okey prosigamos"
- **L3:** Review findings recorded in Engram (`Vault SaaS readiness gaps and market context`). RDD is off for this clone (`clone_local`), so no native review runs. Observation outside scope: email signup creates the personal workspace with `currency: 'USD'` (`src/stores/authStore.ts:82`, `:90`), unusual for a Colombia-first launch; not changed.
- **L4 (T2):** Google sign-in records consent by unequivocal conduct (notice under the button, Decreto 1377 de 2013 art. 7); email signup by an unticked required checkbox. Accounts created before this change have no `legalConsent`; a re-consent gate for them (and for future version bumps) is a follow-up, not built. The policy says deletion is requested by email until S5 lands.
