---
name: about-project
description: Provides complete context, architecture details, database schemas, coding conventions, and setup instructions for the Vault personal finance project. Use this skill when you need to understand the structural layout, codebase conventions, security rules, or local run workflows of Vault.
---

# Skill: Vault Personal Finance Project Context & Architecture

This skill provides an in-depth reference of the **Vault** personal finance monorepo workspace. Use it to understand the directory structure, technology stack, database schemas, security configurations, coding guidelines, and local emulator setup.

---

## 🚀 Architectural Overview

Vault is a premium personal finance manager built using a decoupled client-server architecture in a **pnpm Workspaces** monorepo. It features a **Multi-Player (Workspaces)** architecture allowing users to share finances.

```
vault-personal-finances (Root)
├── apps/views/components (src/)  # Frontend Vue 3 + Vite
├── functions/                    # Backend Firebase Cloud Functions v2 + Genkit
├── firestore.rules               # Firestore security rules
├── storage.rules                 # Firebase Storage security rules
└── pnpm-workspace.yaml           # pnpm Monorepo configuration
```

### Technology Stack
* **Frontend:** Vue 3 SFC (`<script setup lang="ts">`), Vite, Tailwind CSS v4 (native `@tailwindcss/vite` integration), TypeScript, Pinia, Zod, Chart.js, and Lucide Vue Next.
* **Backend:** Firebase Cloud Functions v2 in TypeScript, Firebase Auth, Firestore, Firebase Storage, and Google Genkit (for Gemini AI Statement parsing).
* **Dependency Management:** `pnpm` workspaces.

---

## 🔒 Security & Data Models

### Firestore Security Rules
* `/users/{userId}`: Only the authenticated owner can read/write.
* `/workspaces/{workspaceId}`: Users can create workspaces. Members can read/update. Only the owner can delete.
* `/accounts/{accountId}`: Only workspace members (`isWorkspaceMember(resource.data.workspaceId)`) can read, update, or delete.
* `/transactions/{transactionId}`: Only workspace members can read, update, or delete.
* `/categories/{categoryId}`: Users can read categories that belong to their workspace OR global categories (`workspaceId == null`).
* `/goals/{goalId}`: Only workspace members can read, update, or delete.
* `/chats/{chatId}`: Only workspace members can read, update, or delete.

### Storage Rules
* File uploads (like receipts) are stored under `/workspaces/{workspaceId}/receipts/*`. Only workspace members can read or write these files.

### Firestore Composite Indexes (`firestore.indexes.json`)
* The **frontend** queries by `workspaceId`; the **agent backend** queries by `userId`. Both paths must stay indexed.
* `transactions`: `workspaceId ASC + date DESC` and `chats`: `workspaceId ASC + updatedAt DESC` (frontend lists).
* `transactions` by `userId` (agent tools): `userId+date`, `userId+accountId+date`, `userId+type+date`, `userId+accountId+type+date` (all `date DESC`). Required by `listTransactions`/`getExpensesByCategory` in production (emulator ignores missing indexes).
* Deploy indexes with `firebase deploy --only firestore:indexes`.

### Firestore Database Schemas

#### 1. `/users/{userId}`
* `uid`: string (Firebase Auth UID)
* `email`: string
* `displayName`: string
* `country`: string | null (e.g. "CO", "MX", "ES", "US", "CL", "AR", "PE")
* `currency`: string | null (e.g. "COP", "MXN", "EUR", "USD", "CLP", "ARS", "PEN")
* `activeWorkspaceId`: string | null (Current workspace UI context)
* `workspaces`: string[] (Array of workspace IDs the user belongs to)
* `createdAt`: timestamp

#### 2. `/workspaces/{workspaceId}`
* `id`: string
* `name`: string
* `ownerId`: string
* `members`: string[] (Array of user UIDs)
* `currency`: string
* `expenseLimit`: number | undefined (optional global monthly expense limit)
* `budgetIncome`: number | undefined (50/30/20 planner: declared monthly income)
* `budgetNeedsPercent` / `budgetWantsPercent` / `budgetSavingsPercent`: number | undefined (50/30/20 split, must sum 100)
* `budgetAllocations`: Record<goalId, number> | undefined (funds assigned per goal)
* `categoryBudgets`: Record<categoryId, number> | undefined (recurring monthly budget limit per category)
* `exchangeRates`: Record<currencyCode, number> | undefined (manual FX rates → primary currency, for multi-currency KPI consolidation)
* `createdAt`: timestamp

> Note: Budget/FX config lives **inline on the workspace doc** (no separate collection). It is read/written by `goalsStore` via `loadBudgetSettings` / `saveBudgetSettings`. Workspace members already have `update` permission, so no rules change is required.

#### 3. `/accounts/{accountId}`
* `id`: string
* `workspaceId`: string (FK to workspace)
* `userId`: string (creator)
* `name`: string (e.g., "Tarjeta Visa Oro")
* `type`: "checking" | "savings" | "credit" | "cash"
* `balance`: number (current available balance)
* `limit`: number (credit card limit, default 0)
* `currency`: string (e.g., "USD", "COP", "EUR")
* `createdAt`: timestamp

#### 4. `/transactions/{transactionId}`
* `id`: string
* `workspaceId`: string (FK to workspace)
* `userId`: string (creator)
* `accountId`: string (FK to origin account)
* `amount`: number (negative for expenses, positive for income)
* `description`: string
* `categoryId`: string (FK to category, empty for transfers)
* `date`: timestamp (transaction date)
* `type`: "income" | "expense" | "transfer"
* `toAccountId`: string | null (FK to destination account, for transfers)
* `statementImportId`: string | null (optional, tracks statement parser origin)
* `receiptUrl`: string | null (optional, download URL for receipt uploaded to Storage)
* `notes`: string | null (optional free-text notes/observations, max 500 chars, included in client-side search)
* `currency`: string (copied from account)
* `embedding`: number[] | null (optional, 768-dimension semantic vector from text-embedding-004)
* `createdAt`: timestamp

#### 5. `/categories/{categoryId}`
* `id`: string
* `workspaceId`: string | null (null for global defaults)
* `userId`: string (creator)
* `name`: string
* `icon`: string (Lucide icon name)
* `color`: string (HEX color code)
* `type`: "income" | "expense" | "both"

#### 6. `/goals/{goalId}`
* `id`: string
* `workspaceId`: string (FK to workspace)
* `userId`: string (creator)
* `name`: string (e.g., "Comprar Carro")
* `targetAmount`: number
* `currentAmount`: number
* `currency`: string (e.g., "COP", "USD", "EUR")
* `targetDate`: timestamp
* `createdAt`: timestamp

---

## 🛠️ Codebase Conventions & Design System

### 1. Types & Validation (Zod)
* Always import and use the TypeScript interfaces from `src/types.ts`.
* Validate client-side forms and API inputs using the Zod schemas from `src/schemas.ts` before initiating network/database transactions.

### 2. Frontend Style (Obsidian Dark)
* Background is Obsidian Dark (`#0b0f19`).
* Components use glassmorphism borders (`border-white/5` or `border-white/10`) with `backdrop-blur` overlays.
* Accents utilize Emerald green (`#10b981`) for positive numbers/incomes, Rose pink (`#f43f5e`) for expenses/deletes, and Amber/Gold (`#fbbf24`) for AI features/settings.

### 3. Pinia Stores
* All operational stores fetch and write data scoped to `authStore.activeWorkspaceId`.
* `authStore.ts`: Manages Firebase user session and active workspace ID context.
* `workspacesStore.ts`: Manages fetching user workspaces, creating new workspaces, and inviting members.
* `accountsStore.ts`: Manages bank/credit account state within a workspace.
* `transactionsStore.ts`: Handles transaction history (with `notes`), batch inserts, receipt uploads, Firestore sync, and the `spendingByCategoryThisMonth(convert?)` getter used by category budgets.
* `settingsStore.ts`: Manages Gemini API integration, user API key encryption, and AI country/currency preferences. The primary currency for KPI consolidation comes from here (`settingsStore.currency`).
* `goalsStore.ts`: Manages savings goals **and** all workspace budget/FX config (50/30/20 planner, `categoryBudgets`, `exchangeRates`). Exposes the `convertToPrimary(amount, currency, primaryCurrency)` getter (uses manual `exchangeRates`; falls back to 1:1 when a rate is missing).
* `chatsStore.ts`: Manages the AI Chat history within a workspace.

---

## 💻 Local Emulators & Run Configuration

Vault runs entirely offline using the **Firebase Emulator Suite** and **Genkit Developer UI**.

### Command Execution (pnpm)
* Install dependencies: `pnpm install`
* Start Vite Frontend: `pnpm dev`
* Start Firebase Emulators (Auth:9099, Firestore:8080, Storage:9199, Functions:5001, SuiteUI:4000): `pnpm emulators`
* Start Genkit Developer UI (API Playground): `pnpm genkit`
* Build production bundles:
  * Frontend: `pnpm build`
  * Backend Functions: `pnpm --filter functions build`

### Environment Configuration
Backend secrets must be set in `functions/.env`:
* `GEMINI_API_KEY`: Google AI Studio API Key.
* `ENCRYPTION_SECRET`: A secure 32-character string used to encrypt/decrypt user-provided Gemini API keys.

### AI Chatbot & Tax Context Integration
* **`chatWithAgent` Cloud Function:** An interactive HTTPS Cloud Function that powers the chat page. It initializes Genkit + Gemini (`GEMINI_MODEL = "gemini-2.5-flash"`; embeddings use `text-embedding-004`). Tools are defined **inline** and capture the verified `userId` in a closure (the model never receives the uid as a parameter). Database tools: `listAccounts`, `createAccount`, `listTransactions`, `createTransaction`, `deleteTransaction`, `listCategories`, `listGoals`, `createGoal`, `updateGoalAmount`, `semanticSearchTransactions`, `indexTransactions`, `getExpensesByCategory`, `saveCategoryBudgets`.
* **Budget tools:** `getExpensesByCategory(months)` aggregates expenses by category server-side (total, count, monthly average) so the model reasons over a summary instead of hundreds of docs. `saveCategoryBudgets(budgets[])` resolves the user's `activeWorkspaceId` and writes `categoryBudgets` on the workspace doc. The system prompt enforces analyze → propose → confirm → save.
* **Country Tax Context Mapping:** Automatically maps the user's `country` to specific tax agencies and guidelines (DIAN/4x1000 in Colombia, SAT/ISR in Mexico, Hacienda/IRPF in Spain, IRS/401k in USA, SII in Chile, AFIP in Argentina, SUNAT in Peru) and injects it as localized context in the chatbot instructions.

### Budgeting, Multi-Currency & Key Feature Notes
* **Category budgets:** Recurring monthly limit per category stored in `workspace.categoryBudgets`. Real-vs-budget progress is computed client-side from `transactionsStore.spendingByCategoryThisMonth(...)`; alerts are visual (green <70% / amber <100% / red ≥100%), no push notifications. Editable in `Goals.vue` or via the AI agent.
* **Multi-currency KPIs:** No exchange-rate API. Users set manual `exchangeRates` in `Settings.vue` (one per non-primary account currency). Dashboard consolidates net worth / income / expenses / savings rate into `settingsStore.currency` via `goalsStore.convertToPrimary`. Uses the current rate for all history (no historical FX).
* **Accounts:** support create/edit/delete. Balance is **never** edited directly (only mutated by transactions via `runTransaction`). Credit cards show available credit (`limit + balance`) and utilization %.
* **Transactions view:** client-side filters (search incl. notes, account, category, type, date range), "load more" pagination (50/page), and mobile card layouts (tables collapse below `md`).
