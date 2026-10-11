// Split a formatted amount at its first (non-breaking) space so a money value can
// only wrap between the currency symbol and the number, never between digits.
export const splitMoney = (formatted: string): [string, string] => {
  const i = formatted.search(/[\s  ]/)
  return i < 0 ? ['', formatted] : [formatted.slice(0, i), formatted.slice(i + 1)]
}
