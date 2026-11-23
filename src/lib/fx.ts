const ISO3_REGEX = /^[A-Z]{3}$/

export const normalizeFxBaseCurrency = (value: unknown): string | null =>
  typeof value === 'string' && ISO3_REGEX.test(value) ? value : null

export interface EffectiveExchangeRates {
  rates: Readonly<Record<string, number>>
  /** Set when stored rates were authored for a different reporting currency than the active one. */
  mismatchedBase: string | null
}

/**
 * Returns the stored manual FX rates only when they match `reportingCurrency` (or are legacy rates
 * without an explicit base). When `baseCurrency` differs from `reportingCurrency`, returns `{}` and
 * `mismatchedBase` so rates authored for another target currency are never misapplied.
 */
export const effectiveExchangeRates = (
  exchangeRates: Readonly<Record<string, number>> | null | undefined,
  baseCurrency: string | null | undefined,
  reportingCurrency: string
): EffectiveExchangeRates => {
  const rates = exchangeRates ?? {}
  const normalizedBase = normalizeFxBaseCurrency(baseCurrency)
  const hasRates = Object.keys(rates).length > 0
  if (normalizedBase && normalizedBase !== reportingCurrency && hasRates) {
    return { rates: {}, mismatchedBase: normalizedBase }
  }
  return { rates, mismatchedBase: null }
}

/**
 * Converts `amount` from `currency` to `primaryCurrency` using manual rates when their base matches.
 * Falls back to 1:1 only for non-blocking display KPIs while `detectFxWarnings` alerts the user;
 * never multiplies by a rate authored for a different base currency.
 */
export const convertWithRates = (
  amount: number,
  currency: string,
  primaryCurrency: string,
  exchangeRates: Readonly<Record<string, number>> | null | undefined,
  baseCurrency?: string | null
): number => {
  if (!currency || currency === primaryCurrency) return amount
  const { rates } = effectiveExchangeRates(exchangeRates, baseCurrency, primaryCurrency)
  if (!Object.hasOwn(rates, currency)) return amount
  const rate = rates[currency]
  return Number.isFinite(rate) && rate > 0 ? amount * rate : amount
}

export interface FxWarnings {
  mismatchedBase: string | null
  missingCurrencies: string[]
  invalidCurrencies: string[]
}

/**
 * Detects FX rate gaps or base-currency mismatches across all foreign currencies present in
 * accounts, transactions, or budget caps.
 */
export const detectFxWarnings = (input: {
  currencies: Iterable<string | null | undefined>
  reportingCurrency: string
  exchangeRates: Readonly<Record<string, number>> | null | undefined
  exchangeRatesBaseCurrency?: string | null
}): FxWarnings => {
  const { rates, mismatchedBase } = effectiveExchangeRates(
    input.exchangeRates,
    input.exchangeRatesBaseCurrency,
    input.reportingCurrency
  )
  const missing = new Set<string>()
  const invalid = new Set<string>()

  for (const raw of input.currencies) {
    if (!raw || raw === input.reportingCurrency) continue
    if (!Object.hasOwn(rates, raw)) {
      missing.add(raw)
      continue
    }
    const rate = rates[raw]
    if (!Number.isFinite(rate) || rate <= 0) invalid.add(raw)
  }

  return {
    mismatchedBase,
    missingCurrencies: [...missing].sort(),
    invalidCurrencies: [...invalid].sort()
  }
}
