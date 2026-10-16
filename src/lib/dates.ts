// Calendar dates in the user's local time zone. `new Date('YYYY-MM-DD')` parses as
// UTC midnight, which is the previous evening west of UTC (19:00 in Colombia), so
// date-only values must never reach the Date constructor unchanged.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

// A `YYYY-MM-DD` value becomes local noon of that day (same convention as the manual
// date inputs); any other string keeps the standard Date parsing.
export const parseDateOnly = (value: string): Date =>
  DATE_ONLY.test(value) ? new Date(`${value}T12:00:00`) : new Date(value)

// Firestore read-back: Timestamps via toDate(), legacy date-only strings as local
// calendar days, anything else through the Date constructor.
export const toDateValue = (value: unknown): Date => {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate()
  }
  if (typeof value === 'string') return parseDateOnly(value)
  return new Date(value as number | Date)
}
