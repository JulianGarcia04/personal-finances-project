import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDateOnly, toDateValue, toLocalDateKey } from './dates.ts'

const calendarDay = (date: Date) => [date.getFullYear(), date.getMonth(), date.getDate()]

test('parses a date-only value as local noon of that calendar day', () => {
  const date = parseDateOnly('2026-10-01')

  assert.deepEqual(calendarDay(date), [2026, 9, 1])
  assert.equal(date.getHours(), 12)
})

test('keeps month-end and year boundaries on the chosen day', () => {
  assert.deepEqual(calendarDay(parseDateOnly('2026-10-31')), [2026, 9, 31])
  assert.deepEqual(calendarDay(parseDateOnly('2026-12-31')), [2026, 11, 31])
  assert.deepEqual(calendarDay(parseDateOnly('2027-01-01')), [2027, 0, 1])
})

test('parses values with a time component as given', () => {
  const iso = '2026-10-10T12:00:00.000Z'

  assert.equal(parseDateOnly(iso).getTime(), Date.parse(iso))
})

test('reads back Timestamp-like values, dates, legacy date-only strings and numbers', () => {
  const stored = new Date(2026, 9, 15, 21, 0)
  const timestampLike = { toDate: () => stored }

  assert.equal(toDateValue(timestampLike), stored)
  assert.equal(toDateValue(stored).getTime(), stored.getTime())
  assert.deepEqual(calendarDay(toDateValue('2026-10-01')), [2026, 9, 1])
  assert.equal(toDateValue('2026-10-10T12:00:00.000Z').getTime(), Date.parse('2026-10-10T12:00:00.000Z'))
  assert.equal(toDateValue(stored.getTime()).getTime(), stored.getTime())
})

test('formats the local calendar day as a date input value, even late in the evening', () => {
  assert.equal(toLocalDateKey(new Date(2026, 9, 31, 20, 30)), '2026-10-31')
  assert.equal(toLocalDateKey(new Date(2026, 9, 15, 21, 0)), '2026-10-15')
  assert.equal(toLocalDateKey(new Date(2027, 0, 1, 0, 0)), '2027-01-01')
})

test('round-trips date input values through parseDateOnly', () => {
  for (const key of ['2026-01-09', '2026-10-01', '2026-12-31']) {
    assert.equal(toLocalDateKey(parseDateOnly(key)), key)
  }
})
