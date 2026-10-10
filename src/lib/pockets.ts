import type { Account } from '../types.ts'

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

export function isPocketAccount(account: Pick<Account, 'parentAccountId'>): boolean {
  return typeof account.parentAccountId === 'string' && account.parentAccountId.length > 0
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
