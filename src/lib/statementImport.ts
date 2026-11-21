import { parseDateOnly } from './dates.ts'
import type { AccountType } from '../types.ts'

export type StatementImportType = 'expense' | 'income' | 'transfer'

export interface RawParsedStatementRow {
  date?: unknown
  description?: unknown
  amount?: unknown
  categorySuggestion?: unknown
  type?: unknown
}

export interface NormalizedStatementRow {
  date: string
  description: string
  amount: number
  categorySuggestion: string
  type: StatementImportType
  counterpartyAccountId: string
}

export interface DuplicateCandidateTransaction {
  id: string
  accountId: string
  toAccountId?: string | null
  type: string
  amount: number
  date: Date
  description?: string
}

const VALID_TYPES = new Set<StatementImportType>(['expense', 'income', 'transfer'])

const STATEMENT_IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

/**
 * Returns the caller's idempotency key, or `null` when none was supplied. A supplied key that
 * does not match the server contract is rejected so a retry never degrades into a duplicate write.
 */
export const resolveStatementImportId = (value: unknown): string | null => {
  if (value === undefined) return null
  if (typeof value !== 'string' || !STATEMENT_IMPORT_ID_PATTERN.test(value)) {
    throw new Error('El identificador de importación no es válido.')
  }
  return value
}

/**
 * Normalizes a Gemini-parsed statement row for review. On credit cards, positive rows (card
 * payments / abonos) default to `transfer` so repaying a card never fabricates fake `income`.
 */
export const normalizeParsedStatementRow = (
  raw: RawParsedStatementRow,
  targetAccountType?: AccountType | string
): NormalizedStatementRow => {
  const numericAmount = Number(raw.amount)
  const amount = Number.isFinite(numericAmount) ? numericAmount : 0
  const rawType = typeof raw.type === 'string' && VALID_TYPES.has(raw.type as StatementImportType)
    ? (raw.type as StatementImportType)
    : null

  let type: StatementImportType
  if (targetAccountType === 'credit' && amount > 0) {
    // Credit card payments/abonos are transfers by default; genuine refunds/cashback can still be switched in UI.
    type = 'transfer'
  } else if (rawType) {
    type = rawType
  } else {
    type = amount > 0 ? 'income' : 'expense'
  }

  const signedAmount = type === 'expense'
    ? -Math.abs(amount)
    : type === 'income'
      ? Math.abs(amount)
      : amount

  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    amount: signedAmount,
    categorySuggestion: typeof raw.categorySuggestion === 'string' ? raw.categorySuggestion : 'Otros',
    type,
    counterpartyAccountId: ''
  }
}

export interface TransferDirectionPlan {
  accountId: string
  toAccountId: string
  amount: number
  targetDelta: number
  counterpartyDelta: number
}

/**
 * Maps a statement transfer row's sign (relative to `targetAccountId`) into canonical transfer
 * endpoints (`accountId -> toAccountId`, positive `amount`) and per-account balance deltas.
 */
export const planTransferDirection = (
  targetAccountId: string,
  counterpartyAccountId: string,
  signedAmount: number
): TransferDirectionPlan => {
  const amount = Math.abs(signedAmount)
  if (signedAmount > 0) {
    // Inflow into targetAccount from counterpartyAccount (e.g. bank paying a credit card).
    return {
      accountId: counterpartyAccountId,
      toAccountId: targetAccountId,
      amount,
      targetDelta: amount,
      counterpartyDelta: -amount
    }
  }
  // Outflow from targetAccount into counterpartyAccount (e.g. bank statement showing card payment).
  return {
    accountId: targetAccountId,
    toAccountId: counterpartyAccountId,
    amount,
    targetDelta: -amount,
    counterpartyDelta: amount
  }
}

const localDayStartMs = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Flags an existing transaction touching `accountId` with matching absolute amount (within 0.01)
 * and calendar date within ±1 day. Matches incoming transfers (`toAccountId === accountId`) too.
 */
export const findPotentialDuplicate = <T extends DuplicateCandidateTransaction>(
  row: { date: string; amount: number; type: StatementImportType; description?: string },
  accountId: string,
  existingTransactions: readonly T[]
): T | null => {
  if (!accountId || !row.date || !Number.isFinite(row.amount) || row.amount === 0) return null
  const rowDate = parseDateOnly(row.date)
  if (Number.isNaN(rowDate.getTime())) return null
  const rowDayMs = localDayStartMs(rowDate)
  const absAmount = Math.abs(row.amount)

  for (const tx of existingTransactions) {
    const touchesAccount = tx.accountId === accountId || (tx.type === 'transfer' && tx.toAccountId === accountId)
    if (!touchesAccount) continue
    if (Math.abs(Math.abs(tx.amount) - absAmount) > 0.01) continue
    const txDate = tx.date instanceof Date ? tx.date : new Date(tx.date)
    if (Number.isNaN(txDate.getTime())) continue
    if (Math.abs(localDayStartMs(txDate) - rowDayMs) > ONE_DAY_MS) continue

    if (row.type === tx.type) return tx
    if (row.type === 'transfer') {
      // Catch legacy/previously-imported payment rows recorded as income (positive) or expense (negative).
      if (row.amount > 0 && tx.type === 'income') return tx
      if (row.amount < 0 && tx.type === 'expense') return tx
    }
  }
  return null
}

/** Deterministic Firestore doc ID for idempotent ordinary statement imports. */
export const statementImportDocId = (workspaceId: string, statementImportId: string, index: number): string =>
  `stmt_${workspaceId}_${statementImportId}_${index}`
