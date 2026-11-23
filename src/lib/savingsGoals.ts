import type { Account, Goal } from '../types.ts'
import { groupAccountsByPocket, isPocketAccount } from './pockets.ts'
import { roundMoney } from './money.ts'

export interface SavingsGoalProgressTransaction {
  get(reference: unknown): Promise<{
    exists(): boolean
    data(): Record<string, unknown> | undefined
  }>
  update(reference: unknown, patch: Record<string, unknown>): void
}

export type SavingsGoalProgressTransactionRunner = <Value>(
  update: (transaction: SavingsGoalProgressTransaction) => Promise<Value>
) => Promise<Value>

export function isSavingsGoalAccountLinkable(
  requestedAccount: Account,
  accounts: readonly Account[],
  workspaceId: string | null | undefined,
  currency: string
): boolean {
  const account = accounts.find(candidate => candidate.id === requestedAccount.id)
  if (!account) return false
  if (!workspaceId || account.workspaceId !== workspaceId || account.currency !== currency ||
      account.type === 'credit' || account.mirror || typeof account.balance !== 'number' ||
      !Number.isFinite(account.balance)) return false
  if (account.parentAccountId !== undefined && account.parentAccountId !== null &&
      (typeof account.parentAccountId !== 'string' || !account.parentAccountId.trim())) return false

  const groups = groupAccountsByPocket([...accounts], workspaceId)
  if (isPocketAccount(account)) {
    return groups.some(group => group.pockets.some(pocket => pocket.id === account.id))
  }

  if (account.childAccountIds?.length) {
    const actualChildren = groups.find(group => group.account.id === account.id)?.pockets.map(pocket => pocket.id) ?? []
    return account.childAccountIds.length === actualChildren.length &&
      account.childAccountIds.every(id => actualChildren.includes(id))
  }
  return true
}

/** Resolve goal progress from its real linked account, or the stored virtual amount. */
export function getSavingsGoalProgressAmount(
  goal: Pick<Goal, 'currentAmount' | 'currency' | 'workspaceId' | 'linkedAccountId'>,
  accounts: readonly Account[],
  activeWorkspaceId: string | null | undefined
): number | null {
  if (!Object.hasOwn(goal, 'linkedAccountId') || goal.linkedAccountId === null) {
    const currentAmount = Number(goal.currentAmount)
    return roundMoney(Number.isFinite(currentAmount) ? currentAmount : 0)
  }

  if (typeof goal.linkedAccountId !== 'string' || !goal.linkedAccountId.trim()) return null
  const account = accounts.find(candidate => candidate.id === goal.linkedAccountId)
  if (!account || account.workspaceId !== goal.workspaceId ||
      !isSavingsGoalAccountLinkable(account, accounts, activeWorkspaceId, goal.currency)) return null

  const balance = Number(account.balance)
  return Number.isFinite(balance) ? roundMoney(balance) : null
}

export async function updateVirtualGoalAmountAtomically(options: {
  runTransaction: SavingsGoalProgressTransactionRunner
  goalReference: unknown
  workspaceId: string
  amount: number
  mode: 'set' | 'contribute'
}): Promise<number> {
  const { runTransaction, goalReference, workspaceId, amount, mode } = options
  if (!workspaceId) throw new Error('Workspace no inicializado')
  if (!Number.isFinite(amount) || (mode === 'contribute' ? amount <= 0 : amount < 0)) {
    throw new Error('El monto de la meta no es válido.')
  }

  const normalizedAmount = roundMoney(amount)
  if (mode === 'contribute' && normalizedAmount <= 0) throw new Error('El monto de la meta no es válido.')

  return runTransaction(async transaction => {
    const snapshot = await transaction.get(goalReference)
    if (!snapshot.exists()) throw new Error('La meta de ahorro no existe en el workspace activo.')

    const goal = snapshot.data() ?? {}
    if (goal.workspaceId !== workspaceId) {
      throw new Error('La meta de ahorro no existe en el workspace activo.')
    }
    if (Object.hasOwn(goal, 'linkedAccountId') && goal.linkedAccountId !== null) {
      throw new Error('La meta está vinculada a una cuenta; su progreso se actualiza con transferencias.')
    }

    const storedAmount = Number(goal.currentAmount ?? 0)
    const currentAmount = roundMoney(Number.isFinite(storedAmount) ? storedAmount : 0)
    const nextAmount = mode === 'contribute'
      ? roundMoney(currentAmount + normalizedAmount)
      : normalizedAmount

    transaction.update(goalReference, { currentAmount: nextAmount })
    return nextAmount
  })
}
