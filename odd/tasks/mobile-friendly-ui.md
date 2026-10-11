# Mobile-friendly UI

## Objective
Make the whole web app fully usable from a phone (360–430px wide, iOS Safari / Android Chrome).

## Problem
Audit (2026-10-10) found blocking issues: Transactions selection bar invisible on mobile, Accounts card actions hover-only, every input at 14px (iOS zoom on focus), `100vh` layouts break the Agent chat on iOS. Plus 9 copy-pasted centered modals with scrolling-away close buttons, tap targets of 16–32px, overflowing money values, no safe-area handling, drawer that does not close on route change.

## Scope
All views (`Login`, `Dashboard`, `Accounts`, `Transactions`, `Goals`, `Import`, `Agent`, `Settings`), app shell (`App.vue`, `Sidebar.vue`), `index.html`, `src/style.css`, new shared UI components under `src/components/ui/`.
Out of scope: business logic, stores, Firestore, functions. Desktop layout must not regress.

## Constraints
- Vue 3 `<script setup lang="ts">` + Tailwind v4 (`@theme` in `src/style.css`). UI copy stays Spanish (existing convention); code/comments English.
- No new dependencies.
- Desktop (`lg:`) behavior preserved.

## Acceptance criteria
- No horizontal page scroll at 360px on any view.
- All interactive controls ≥ 44px tap area on mobile; no hover-only actions on touch devices.
- Inputs ≥ 16px font on mobile; amount fields use `inputmode="decimal"`.
- Modals render as bottom sheets on mobile with sticky header (close) and sticky footer (actions), `dvh` max height, safe-area padding, close on backdrop/Esc.
- Bottom tab nav on mobile (< lg) with safe-area padding; drawer/"Más" closes on route change.
- `pnpm build` passes.

## Checks
- `pnpm build` (vue-tsc + vite) per task.
- `pnpm test` (existing node tests) at closure.
- Test-first exception: presentational Tailwind/markup changes have no meaningful runnable RED test in this repo (no component test runner); verification is build + browser check at 390px.

## Tasks
- [x] T1 Foundation: `index.html` meta (viewport-fit=cover, interactive-widget, theme-color), `style.css` utilities (hover-device variant, `.tap`, `.field`, safe-area/dvh helpers, shared `animate-scale-up`, `custom-scrollbar`/`scrollbar-thin`, glow hover gated by hover:hover, background-attachment fix), `App.vue` (dvh, overflow-x-clip, safe-area padding), new `src/components/ui/BaseSheet.vue`. Route: delegated.
- [ ] T2 Navigation: `Sidebar.vue` drawer fixes (close on route change/Esc, scroll lock, overflow-y, safe-area, click-outside workspace menu, 44px buttons) + mobile bottom tab bar (Inicio, Transacciones, Cuentas, Metas, Más). Route: delegated.
- [ ] T3 Transactions: selection bar out of `hidden md:block` panel, modals → BaseSheet, amount inputmode, filters collapsible on mobile, tap targets, hover-device actions, truncation. Route: delegated.
- [ ] T4 Accounts: actions visible on touch, net worth/pocket totals wrap, label sizes, tap targets, inputs, responsive grids, modals → BaseSheet, break-all ids. Route: delegated.
- [ ] T5 Dashboard + Goals: min-w-0/shrink fixes, responsive chart heights/legend, tap targets, title sizes; Goals rows, modals → BaseSheet, inputs, sliders. Route: delegated.
- [ ] T6 Import + Agent + Settings + Login: action rows stack, mobile copy, inputs; Agent dvh/safe-area/auto-resize textarea/bubble wrapping/header; Settings tap targets, `bg-slate-955` fix, swatches, exchange row; Login inputs/autocomplete/dvh. Route: delegated.
- [ ] T7 Verification: `pnpm build`, `pnpm test`, browser check at 390px of each view. Route: delegated.

## Progress
- 2026-10-10: Branch `feat/mobile-friendly-ui` created from main. Audit done (explorer). Route: all tasks delegated (writer trigger: 2+ non-trivial files per task).
- 2026-10-10: T1 done (delegated writer). `index.html`: viewport-fit=cover + interactive-widget=resizes-content, theme-color, body min-h-dvh. `style.css`: `hover-device` custom variant; `@utility` `tap` (44x44), `pt-safe`/`pb-safe`/`pl-safe`/`pr-safe`, `field` (16px mobile, sm:14px, min-h-11, same look as existing view inputs), `scrollbar-thin`, `custom-scrollbar`; global `animate-scale-up`; `.sheet-*` transition for BaseSheet; glow-card hover and `background-attachment: fixed` gated by `(hover: hover)`. `App.vue`: min-h-dvh, overflow-x-clip, main min-w-0 and per-axis padding (fixes sm:p-6 overriding the mobile top offset) with top = 5rem + safe-area-top and bottom = 5.5rem + safe-area-bottom below lg. New `src/components/ui/BaseSheet.vue` (props `open`, `title?`, `size?: 'md'|'lg'`, `panelClass?`; emits `close`; slots default/`header`/`footer`) and `src/components/ui/useBodyScrollLock.ts` (ref-counted). Check: `pnpm build` passed.

## Next step
T1 + T2.
