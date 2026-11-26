import type { Category, Transaction, TransactionType } from '../types.ts'
import { DEFAULT_MONTHLY_BUDGET_ID, budgetIdToPersist, canAssignBudget, canCarryBudget, type LinkableBudget } from './budgets.ts'
import { referencesDeletedAccount } from './deletedAccountHistory.ts'
import { canDeleteMirrorTransaction, isSettlementCandidate } from './mirror.ts'
import { budgetOfTransaction } from './transactionClassification.ts'

/** Firestore accepts at most 500 writes per batch; each chunk commits all-or-nothing. */
export const BULK_EDIT_BATCH_LIMIT = 500

/** What a bulk edit changes; an omitted field stays as it is. */
export interface BulkEditRequest {
  categoryId?: string
  // DEFAULT_MONTHLY_BUDGET_ID moves the movements to the base monthly budget.
  budgetId?: string
}

/** The only fields a bulk edit writes. The base monthly budget is stored as null. */
export interface BulkEditPatch {
  categoryId?: string
  budgetId?: string | null
}

export interface BulkEditUpdate {
  id: string
  // Type the plan saw; local rows are patched only while they keep it.
  type: TransactionType
  patch: BulkEditPatch
}

export type BulkEditSkipReason =
  | 'unavailable'        // no longer loaded, or from another workspace
  | 'locked-settlement'  // settlements and their reversals keep their own flow
  | 'deleted-account'    // history of a deleted account is read-only
  | 'mirror-transfer'    // the transfer twin of a shared expense carries no budget
  | 'no-budget-type'     // transfers, loans and loan payments carry no budget
  | 'linked-account'     // a linked account's movements keep its budget
  | 'stale-budget'       // the rules refuse edits that keep a missing or foreign budget
  | 'unchanged'          // already has the requested values

export interface BulkEditPlan {
  updates: BulkEditUpdate[]
  skipped: Array<{ id: string; reason: BulkEditSkipReason }>
}

export interface BulkEditContext {
  workspaceId: string
  accounts: ReadonlyArray<{ id: string }>
  // Workspace whose accounts are fully loaded and active; null while loading or switching.
  loadedAccountsWorkspaceId: string | null
  // Every budget of the workspace, archived included (links and existing references).
  budgets: readonly LinkableBudget[]
  categories: ReadonlyArray<Pick<Category, 'id' | 'type'>>
}

export const BULK_CATEGORY_SINGLE_TYPE_MESSAGE = 'Para cambiar la categoría, selecciona solo gastos o solo ingresos.'

/** Type a category change applies to: every selected movement is an expense, or every one is an income. */
export const bulkCategoryType = (rows: ReadonlyArray<Pick<Transaction, 'type'>>): 'expense' | 'income' | null => {
  const type = rows[0]?.type
  if (type !== 'expense' && type !== 'income') return null
  return rows.every(row => row.type === type) ? type : null
}

const isLockedSettlement = (transaction: Transaction): boolean =>
  !canDeleteMirrorTransaction(transaction) || transaction.settlementType != null || isSettlementCandidate(transaction)

/**
 * Which selected movements take the requested category and/or budget, and why the others are
 * skipped. A row takes the whole request or nothing; fields it already has are not written.
 * Throws a user-facing error when the request itself cannot apply (nothing chosen, a category
 * for a mixed selection or of another type, or a budget that is not the base or an active one).
 */
export const planBulkTransactionEdit = (
  request: BulkEditRequest,
  transactionIds: readonly string[],
  transactions: readonly Transaction[],
  context: BulkEditContext
): BulkEditPlan => {
  const { categoryId, budgetId } = request
  if (categoryId === undefined && budgetId === undefined) {
    throw new Error('Elige una categoría o un presupuesto para cambiar.')
  }
  const byId = new Map(transactions.map(transaction => [transaction.id, transaction]))
  const available = transactionIds
    .map(id => byId.get(id))
    .filter((transaction): transaction is Transaction => !!transaction && transaction.workspaceId === context.workspaceId)

  if (categoryId !== undefined) {
    const type = bulkCategoryType(available)
    if (!type) throw new Error(BULK_CATEGORY_SINGLE_TYPE_MESSAGE)
    // Rules do not check a category's existence or type, so the client does.
    const category = context.categories.find(candidate => candidate.id === categoryId)
    if (!category || (category.type !== type && category.type !== 'both')) {
      throw new Error('La categoría elegida ya no está disponible. Elige otra.')
    }
  }
  if (budgetId !== undefined && budgetId !== DEFAULT_MONTHLY_BUDGET_ID &&
      !context.budgets.some(budget => budget.id === budgetId && !budget.archived)) {
    throw new Error('El presupuesto elegido ya no está disponible. Elige otro.')
  }

  const knownBudgetIds = new Set([DEFAULT_MONTHLY_BUDGET_ID, ...context.budgets.map(budget => budget.id)])
  const plan: BulkEditPlan = { updates: [], skipped: [] }
  const skip = (id: string, reason: BulkEditSkipReason) => { plan.skipped.push({ id, reason }) }

  for (const id of transactionIds) {
    const transaction = byId.get(id)
    if (!transaction || transaction.workspaceId !== context.workspaceId) { skip(id, 'unavailable'); continue }
    if (isLockedSettlement(transaction)) { skip(id, 'locked-settlement'); continue }
    if (referencesDeletedAccount(transaction, context.accounts, context.loadedAccountsWorkspaceId)) {
      skip(id, 'deleted-account')
      continue
    }

    const patch: BulkEditPatch = {}
    if (budgetId !== undefined) {
      if (transaction.mirrorOf && transaction.type === 'transfer') { skip(id, 'mirror-transfer'); continue }
      if (!canCarryBudget(transaction.type)) { skip(id, 'no-budget-type'); continue }
      if (!canAssignBudget(context.budgets, transaction.accountId, budgetId)) { skip(id, 'linked-account'); continue }
      if (budgetOfTransaction(transaction) !== budgetId) patch.budgetId = budgetIdToPersist(transaction.type, budgetId)
    }
    if (categoryId !== undefined && transaction.categoryId !== categoryId) {
      // Any edit that keeps a reference to a budget that no longer exists is refused by the rules.
      const keptBudgetId = budgetOfTransaction(transaction)
      if (!('budgetId' in patch) && keptBudgetId !== null && !knownBudgetIds.has(keptBudgetId)) {
        skip(id, 'stale-budget')
        continue
      }
      patch.categoryId = categoryId
    }
    if (Object.keys(patch).length === 0) { skip(id, 'unchanged'); continue }
    plan.updates.push({ id, type: transaction.type, patch })
  }
  return plan
}

/** Updates split into write batches of at most BULK_EDIT_BATCH_LIMIT. */
export const chunkBulkEditUpdates = (updates: readonly BulkEditUpdate[], size = BULK_EDIT_BATCH_LIMIT): BulkEditUpdate[][] => {
  const chunks: BulkEditUpdate[][] = []
  for (let start = 0; start < updates.length; start += size) chunks.push(updates.slice(start, start + size))
  return chunks
}

// Why rows are skipped, as [one, several] so the count and the verb agree.
const SKIP_REASON_TEXT: Record<BulkEditSkipReason, [string, string]> = {
  unavailable: ['ya no está disponible', 'ya no están disponibles'],
  'locked-settlement': ['es una liquidación o reversión', 'son liquidaciones o reversiones'],
  'deleted-account': ['es de una cuenta eliminada', 'son de cuentas eliminadas'],
  'mirror-transfer': [
    'es la transferencia de un gasto compartido, que no lleva presupuesto',
    'son transferencias de gastos compartidos, que no llevan presupuesto'
  ],
  'no-budget-type': [
    'es una transferencia o un préstamo, que no lleva presupuesto',
    'son transferencias o préstamos, que no llevan presupuesto'
  ],
  'linked-account': ['es de una cuenta ligada a otro presupuesto', 'son de cuentas ligadas a otro presupuesto'],
  'stale-budget': [
    'tiene un presupuesto que ya no existe; cámbiale también el presupuesto',
    'tienen un presupuesto que ya no existe; cámbiales también el presupuesto'
  ],
  unchanged: ['ya tenía ese valor', 'ya tenían ese valor']
}

/** "N cambiarán. M se omitirán: …" for the confirmation, reasons in order of first appearance. */
export const describeBulkEditPlan = (plan: BulkEditPlan): string => {
  const changing = plan.updates.length
  const head = changing === 0
    ? 'Ningún movimiento cambiará.'
    : changing === 1 ? '1 movimiento cambiará.' : `${changing} movimientos cambiarán.`
  if (plan.skipped.length === 0) return head
  const counts = new Map<BulkEditSkipReason, number>()
  for (const { reason } of plan.skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  const reasons = [...counts].map(([reason, count]) => `${count} ${SKIP_REASON_TEXT[reason][count === 1 ? 0 : 1]}`)
  const skipped = plan.skipped.length
  return `${head} ${skipped} ${skipped === 1 ? 'se omitirá' : 'se omitirán'}: ${reasons.join('; ')}.`
}

/** Result toast: how many were updated and skipped, or how many failed and stay selected. */
export const describeBulkEditOutcome = ({ planned, written, skipped }: { planned: number; written: number; skipped: number }): string => {
  const failed = planned - written
  if (failed > 0) {
    const retry = failed === 1
      ? 'No se pudo guardar 1 movimiento; sigue seleccionado para que lo intentes de nuevo.'
      : `No se pudieron guardar ${failed} movimientos; siguen seleccionados para que lo intentes de nuevo.`
    if (written === 0) return retry
    return `Se actualizaron ${written} de ${planned} movimientos. ${failed === 1
      ? 'No se pudo guardar 1; sigue seleccionado para que lo intentes de nuevo.'
      : `No se pudieron guardar ${failed}; siguen seleccionados para que lo intentes de nuevo.`}`
  }
  const done = written === 1 ? 'Se actualizó 1 movimiento.' : `Se actualizaron ${written} movimientos.`
  if (skipped === 0) return done
  return `${done} ${skipped} ${skipped === 1 ? 'se omitió' : 'se omitieron'}.`
}
