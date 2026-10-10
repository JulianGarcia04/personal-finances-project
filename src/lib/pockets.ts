import type { Account, TransactionType } from '../types.ts'

export interface AccountPocketTotals {
  availableBalance: number
  pocketBalance: number
  totalBalance: number
}

export interface PocketOpeningPlan {
  parentBalanceAfter: number
  pocketBalance: number
  totalBalanceBefore: number
  totalBalanceAfter: number
  openingTransactionAmount: number | null
}

export interface PocketMovement {
  accountId: string
  amount: number
  type: TransactionType
  toAccountId?: string | null
}

export type AccountBalanceDeltas = Record<string, number>

export function isPocketAccount(account: Pick<Account, 'parentAccountId'>): boolean {
  return typeof account.parentAccountId === 'string' && account.parentAccountId.length > 0
}

export function isPocketRelatedAccount(account: Pick<Account, 'parentAccountId' | 'childAccountIds'>): boolean {
  return isPocketAccount(account) || (account.childAccountIds?.length ?? 0) > 0
}

export function getTransactionAccountDeltas(movement: PocketMovement): AccountBalanceDeltas {
  const { accountId, amount, type, toAccountId } = movement
  if (!accountId || !Number.isFinite(amount)) throw new Error('El movimiento de bolsillo no es válido.')

  const deltas: AccountBalanceDeltas = { [accountId]: 0 }
  if (type === 'transfer') {
    if (!toAccountId || toAccountId === accountId || amount <= 0) {
      throw new Error('La transferencia de bolsillo debe tener cuentas distintas y un monto positivo.')
    }
    deltas[accountId] = -amount
    deltas[toAccountId] = (deltas[toAccountId] ?? 0) + amount
  } else if (type === 'income' || type === 'expense') {
    deltas[accountId] = amount
  } else {
    throw new Error('Este tipo de movimiento no está disponible para bolsillos.')
  }
  return deltas
}

export function getTransactionReplacementDeltas(
  before: PocketMovement | null,
  after: PocketMovement | null
): AccountBalanceDeltas {
  const deltas: AccountBalanceDeltas = {}
  const add = (movement: PocketMovement | null, direction: 1 | -1) => {
    if (!movement) return
    for (const [accountId, delta] of Object.entries(getTransactionAccountDeltas(movement))) {
      deltas[accountId] = (deltas[accountId] ?? 0) + delta * direction
    }
  }
  add(before, -1)
  add(after, 1)
  return Object.fromEntries(Object.entries(deltas).filter(([, delta]) => delta !== 0))
}

export function getAccountPocketTotals(parentId: string, accounts: Account[]): AccountPocketTotals {
  const parent = accounts.find(account => account.id === parentId)
  if (!parent || isPocketAccount(parent)) throw new Error('No se encontró una cuenta bancaria principal válida.')

  const pocketBalance = accounts
    .filter(account => account.parentAccountId === parentId)
    .reduce((total, account) => total + account.balance, 0)

  return {
    availableBalance: parent.balance,
    pocketBalance,
    totalBalance: parent.balance + pocketBalance
  }
}

export function planPocketOpening(
  parent: Account,
  amount: number,
  activeWorkspaceId: string,
  requestedCurrency?: string
): PocketOpeningPlan {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('El monto inicial debe ser finito y mayor o igual a cero.')
  if (!Number.isFinite(parent.balance)) throw new Error('El saldo disponible de la cuenta principal no es válido.')
  if (!['checking', 'savings'].includes(parent.type)) throw new Error('Solo una cuenta bancaria o de ahorros puede contener bolsillos.')
  if (isPocketAccount(parent)) throw new Error('No se permiten bolsillos anidados.')
  if (parent.workspaceId !== activeWorkspaceId) throw new Error('La cuenta principal pertenece a otro workspace.')
  if (parent.mirror) throw new Error('Una cuenta espejo no puede contener bolsillos.')
  if (!parent.currency || (requestedCurrency && requestedCurrency !== parent.currency)) {
    throw new Error('El bolsillo debe usar la misma moneda de la cuenta principal.')
  }
  if (amount > parent.balance) throw new Error('El saldo disponible es insuficiente para abrir el bolsillo.')

  const parentBalanceAfter = parent.balance - amount
  return {
    parentBalanceAfter,
    pocketBalance: amount,
    totalBalanceBefore: parent.balance,
    totalBalanceAfter: parentBalanceAfter + amount,
    openingTransactionAmount: amount === 0 ? null : amount
  }
}
