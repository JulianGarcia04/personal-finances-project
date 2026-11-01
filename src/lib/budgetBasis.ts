import { ref } from 'vue'
import type { ImputationBasis } from './installments.ts'

// How budget surfaces count credit-card expenses:
// - 'consumption' (default): the month of the statement cycle that contains the purchase,
//   which answers "how much did I consume this month?".
// - 'payment': the month the statement is paid, which answers "how much do I pay this month?".
// Remembered per device and shared by every budget surface (Goals and Dashboard widgets).
export type BudgetBasis = ImputationBasis

export const BUDGET_BASIS_KEY = 'vault.budgets.basis'

export const parseBudgetBasis = (value: unknown): BudgetBasis =>
  value === 'payment' ? 'payment' : 'consumption'

export const BUDGET_BASIS_LABELS: Record<BudgetBasis, string> = {
  consumption: 'Consumo del mes',
  payment: 'Pagos del mes'
}

export const BUDGET_BASIS_HINTS: Record<BudgetBasis, string> = {
  consumption: 'Cuenta lo que compraste este mes. Las compras con tarjeta de crédito cuentan en el mes del corte del extracto donde entran, y las compras a cuotas suman una cuota por mes desde ese corte.',
  payment: 'Cuenta lo que pagas este mes. Las compras con tarjeta de crédito cuentan cuando pagas su extracto, por eso aquí aparecen compras de meses anteriores: lo que ya transferiste a la tarjeta cuenta en el mes en que lo hiciste, y lo que falta por pagar, en el mes de pago del extracto.'
}

const readBudgetBasis = (): BudgetBasis => {
  try { return parseBudgetBasis(localStorage.getItem(BUDGET_BASIS_KEY)) } catch { return 'consumption' }
}

export const budgetBasis = ref<BudgetBasis>(readBudgetBasis())

export const setBudgetBasis = (basis: BudgetBasis) => {
  budgetBasis.value = basis
  try { localStorage.setItem(BUDGET_BASIS_KEY, basis) } catch { /* storage unavailable: keep it for this visit */ }
}
