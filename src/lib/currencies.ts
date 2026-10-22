export interface CurrencyOption {
  readonly code: string
  readonly label: string
}

/** Currencies offered by the app's selectors, matching the regional settings list. */
export const SUPPORTED_CURRENCIES: readonly CurrencyOption[] = [
  { code: 'COP', label: 'COP ($)' },
  { code: 'MXN', label: 'MXN ($)' },
  { code: 'EUR', label: 'EUR (€)' },
  { code: 'USD', label: 'USD ($)' },
  { code: 'CLP', label: 'CLP ($)' },
  { code: 'ARS', label: 'ARS ($)' },
  { code: 'PEN', label: 'PEN (S/.)' }
]

/**
 * Selector options that always include an already stored code, so a record saved
 * with a currency outside the supported list still renders its real unit.
 */
export const currencyOptionsWith = (storedCode?: string | null): readonly CurrencyOption[] => {
  const code = storedCode?.trim().toUpperCase()
  if (!code || SUPPORTED_CURRENCIES.some(option => option.code === code)) return SUPPORTED_CURRENCIES
  return [...SUPPORTED_CURRENCIES, { code, label: code }]
}

/** Preselected code: the given preference when supported, otherwise the first option. */
export const defaultCurrencyCode = (preferred?: string | null): string => {
  const code = preferred?.trim().toUpperCase()
  return SUPPORTED_CURRENCIES.find(option => option.code === code)?.code ?? SUPPORTED_CURRENCIES[0].code
}
