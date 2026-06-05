---
name: about-project
description: Provides complete context, architecture details, database schemas, coding conventions, and setup instructions for the Vault personal finance project. Use this skill when you need to understand the structural layout, codebase conventions, security rules, or local run workflows of Vault.
---

# Skill: Vault Personal Finance Project Context & Architecture

This skill provides an in-depth reference of the **Vault** personal finance monorepo workspace. Use it to understand the directory structure, technology stack, database schemas, security configurations, coding guidelines, and local emulator setup.

---

## 🚀 Architectural Overview

Vault is a premium personal finance manager built using a decoupled client-server architecture in a **pnpm Workspaces** monorepo:

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
* `/accounts/{accountId}`: Only the owner (`resource.data.userId == request.auth.uid`) can read, update, or delete. Owners can create accounts where they are designated as the owner.
* `/transactions/{transactionId}`: Restricts all reads, writes, and deletions to the authenticated owner.
* `/categories/{categoryId}`: Users can read categories that belong to them OR global categories (`userId == null`). Only the owner can write/delete their custom categories.

### Storage Rules
* File uploads are restricted to `/users/{userId}/*` where only the authenticated owner can read or write files.

### Firestore Database Schemas

#### 1. `/users/{userId}`
* `uid`: string (Firebase Auth UID)
* `email`: string
* `displayName`: string
* `createdAt`: timestamp

#### 2. `/accounts/{accountId}`
* `id`: string
* `userId`: string (FK to user)
* `name`: string (e.g., "Tarjeta Visa Oro")
* `type`: "checking" | "savings" | "credit" | "cash"
* `balance`: number (current available balance)
* `limit`: number (credit card limit, default 0)
* `currency`: string (e.g., "USD", "COP", "EUR")
* `createdAt`: timestamp

#### 3. `/transactions/{transactionId}`
* `id`: string
* `userId`: string
* `accountId`: string (FK to origin account)
* `amount`: number (negative for expenses, positive for income)
* `description`: string
* `categoryId`: string (FK to category, empty for transfers)
* `date`: timestamp (transaction date)
* `type`: "income" | "expense" | "transfer"
* `toAccountId`: string | null (FK to destination account, for transfers)
* `statementImportId`: string | null (optional, tracks statement parser origin)
* `receiptUrl`: string | null (optional, download URL for receipt uploaded to Storage)
* `currency`: string (copied from account)
* `createdAt`: timestamp

#### 4. `/categories/{categoryId}`
* `id`: string
* `userId`: string | null (null for global defaults)
* `name`: string
* `icon`: string (Lucide icon name)
* `color`: string (HEX color code)
* `type`: "income" | "expense" | "both"

---

## 🛠️ Codebase Conventions & Design System

### 1. Types & Validation (Zod)
* Always import and use the TypeScript interfaces from [src/types.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/types.ts).
* Validate client-side forms and API inputs using the Zod schemas from [src/schemas.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/schemas.ts) before initiating network/database transactions.

### 2. Frontend Style (Obsidian Dark)
* Background is Obsidian Dark (`#0b0f19`).
* Components use glassmorphism borders (`border-white/5` or `border-white/10`) with `backdrop-blur` overlays.
* Accents utilize Emerald green (`#10b981`) for positive numbers/incomes, Rose pink (`#f43f5e`) for expenses/deletes, and Amber/Gold (`#fbbf24`) for AI features/settings.

### 3. Pinia Stores
* [authStore.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/stores/authStore.ts): Manages Firebase user session.
* [accountsStore.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/stores/accountsStore.ts): Manages bank/credit account state.
* [transactionsStore.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/stores/transactionsStore.ts): Handles transaction history, batch inserts, receipt uploads, and Firestore sync.
* [settingsStore.ts](file:///Users/juliangarcia/Documents/personal-projects.nosync/personal-finances-project/src/stores/settingsStore.ts): Manages Gemini API integration, user API key encryption, and AI toggle settings.

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
