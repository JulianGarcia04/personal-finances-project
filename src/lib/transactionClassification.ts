import type { Transaction } from '../types.ts'
import { canCarryBudget, resolveBudgetId } from './budgets.ts'

export interface ExpenseBudgetAssignmentContext {
  getUserId(): string | null
  getWorkspaceId(): string | null
  findTransaction(transactionId: string): Transaction | undefined
  writePatch(transactionId: string, patch: { budgetId: string | null }): Promise<void>
}

const assertSegment = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('/') || value === '.' || value === '..' || /^__.*__$/.test(value)) {
    throw new Error(`Invalid ${label} ID`)
  }
}

/** The persistence port must write only this scalar patch, never reverse balances. */
export const createExpenseBudgetAssigner = (context: ExpenseBudgetAssignmentContext) =>
  async (transactionId: string, budgetId: string | null): Promise<void> => {
    const userId = context.getUserId()
    const workspaceId = context.getWorkspaceId()
    if (!userId) throw new Error('User is not authenticated')
    if (!workspaceId) throw new Error('Workspace is not initialized')
    assertSegment(workspaceId, 'workspace')
    assertSegment(transactionId, 'transaction')
    if (budgetId !== null) assertSegment(budgetId, 'budget')

    const transaction = context.findTransaction(transactionId)
    if (!transaction) throw new Error('Transaction not found')
    if (transaction.workspaceId !== workspaceId) throw new Error('Transaction belongs to a different workspace')
    if (!canCarryBudget(transaction.type)) throw new Error('Only expenses and income can be assigned to operating budgets')
    const type = transaction.type

    // Firestore rules validate the actual parent's workspace and archive state.
    await context.writePatch(transactionId, { budgetId })

    // A completed write must not leak into another user's/workspace's projection.
    if (context.getUserId() !== userId || context.getWorkspaceId() !== workspaceId) return
    const current = context.findTransaction(transactionId)
    if (current?.workspaceId === workspaceId && current.type === type) {
      // Re-find and patch, rather than restoring stale financial fields after a refresh.
      current.budgetId = budgetId
    }
  }

export const selectBudgetExpenses = (transactions: readonly Transaction[], budgetId: string): Transaction[] => {
  assertSegment(budgetId, 'budget')
  return transactions.filter(transaction =>
    transaction.type === 'expense' && resolveBudgetId(transaction.budgetId) === budgetId,
  )
}
