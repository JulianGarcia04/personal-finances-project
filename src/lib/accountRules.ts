import type { Account } from '../types.ts'
import { isPocketAccount, isPocketRelatedAccount } from './pockets.ts'

/**
 * Returns the user-facing reason an account's currency cannot be edited, or null when changing
 * currency is safe (no pockets, no bridge mirror, no budget link, zero balance, and no history).
 */
export function getAccountCurrencyLockReason(
  account: Pick<Account, 'balance' | 'parentAccountId' | 'childAccountIds' | 'mirror' | 'linkedBudgetId'>,
  hasTransactions: boolean
): string | null {
  if (isPocketAccount(account) || isPocketRelatedAccount(account)) {
    return 'No puedes cambiar la moneda de un bolsillo ni de una cuenta que tiene bolsillos.'
  }
  if (account.mirror) {
    return 'No puedes cambiar la moneda de una cuenta puente.'
  }
  if (account.linkedBudgetId) {
    return 'No puedes cambiar la moneda de una cuenta ligada a un presupuesto.'
  }
  if (Number(account.balance) !== 0) {
    return 'No puedes cambiar la moneda mientras la cuenta tenga saldo distinto de cero.'
  }
  if (hasTransactions) {
    return 'No puedes cambiar la moneda de una cuenta que ya tiene movimientos registrados.'
  }
  return null
}
