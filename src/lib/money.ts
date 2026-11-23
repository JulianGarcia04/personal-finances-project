// Split a formatted amount at its first (non-breaking) space so a money value can
// only wrap between the currency symbol and the number, never between digits.
export const splitMoney = (formatted: string): [string, string] => {
  const i = formatted.search(/[\s  ]/)
  return i < 0 ? ['', formatted] : [formatted.slice(0, i), formatted.slice(i + 1)]
}

/**
 * Rounds a money value to cents, half away from zero, so stored balances do not
 * accumulate binary float drift (0.1 + 0.2). Never returns negative zero.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return value
  const rounded = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100
  return rounded === 0 ? 0 : rounded
}
