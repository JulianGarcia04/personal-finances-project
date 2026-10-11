import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getStatementPeriod, expenseAmountForCycle, getNextOccurrence, daysUntil, getStatementClosingForDueDate } from './creditCycle.ts'

test('getStatementPeriod ubica el ciclo antes del corte en el mes anterior', () => {
  const { cycleStart, cycleEnd } = getStatementPeriod(25, new Date(2026, 7, 10)) // 10 ago, corte día 25
  assert.equal(cycleEnd.getFullYear(), 2026)
  assert.equal(cycleEnd.getMonth(), 7) // agosto
  assert.equal(cycleEnd.getDate(), 25)
  assert.equal(cycleStart.getMonth(), 6) // julio
  assert.equal(cycleStart.getDate(), 26)
})

test('getStatementPeriod ubica el ciclo después del corte en el mes siguiente', () => {
  const { cycleStart, cycleEnd } = getStatementPeriod(25, new Date(2026, 7, 28)) // 28 ago, ya pasó el corte
  assert.equal(cycleEnd.getMonth(), 8) // septiembre
  assert.equal(cycleEnd.getDate(), 25)
  assert.equal(cycleStart.getMonth(), 7) // agosto
  assert.equal(cycleStart.getDate(), 26)
})

test('expenseAmountForCycle reparte por ciclo de facturación, no por mes calendario', () => {
  // Corte día 15. Compra el 20 de febrero (después del corte) cae en el ciclo
  // feb16->mar15, que "arranca" recién el 16 de feb aunque el calendario diga
  // que la compra fue en febrero.
  const transaction = {
    type: 'expense',
    amount: -300,
    date: new Date(2026, 1, 20), // 20 feb
    installments: 3
  }

  // Mismo mes calendario (febrero) pero antes del corte: el ciclo feb16->mar15
  // todavía no arrancó, así que no hay cuota. Un cálculo por mes calendario
  // habría puesto la cuota completa en febrero; el ciclo la difiere.
  assert.equal(expenseAmountForCycle(transaction, 15, new Date(2026, 1, 10)), 0)
  // Mismo mes calendario, después del corte: primera cuota.
  assert.equal(expenseAmountForCycle(transaction, 15, new Date(2026, 1, 20)), 100)
  // Marzo antes del corte: sigue siendo el mismo ciclo (feb16->mar15), primera cuota.
  assert.equal(expenseAmountForCycle(transaction, 15, new Date(2026, 2, 10)), 100)
  // Marzo después del corte: nuevo ciclo (mar16->abr15), segunda cuota.
  assert.equal(expenseAmountForCycle(transaction, 15, new Date(2026, 2, 20)), 100)
  // Cuarto ciclo, ya sin cuotas pendientes.
  assert.equal(expenseAmountForCycle(transaction, 15, new Date(2026, 4, 20)), 0)
})

test('getNextOccurrence rueda al mes siguiente si el día ya pasó', () => {
  const next = getNextOccurrence(5, new Date(2026, 7, 20)) // 20 ago, día 5 ya pasó
  assert.equal(next.getMonth(), 8) // septiembre
  assert.equal(next.getDate(), 5)
})

test('getNextOccurrence se queda en el mes actual si el día no ha pasado', () => {
  const next = getNextOccurrence(20, new Date(2026, 7, 5)) // 5 ago, día 20 no ha pasado
  assert.equal(next.getMonth(), 7)
  assert.equal(next.getDate(), 20)
})

test('getNextOccurrence clampea día 31 en meses cortos', () => {
  const next = getNextOccurrence(31, new Date(2026, 3, 5)) // abril tiene 30 días
  assert.equal(next.getMonth(), 3)
  assert.equal(next.getDate(), 30)

  const nextFeb = getNextOccurrence(31, new Date(2026, 1, 1)) // febrero 2026 tiene 28 días
  assert.equal(nextFeb.getMonth(), 1)
  assert.equal(nextFeb.getDate(), 28)
})

test('daysUntil es sano: 0 para hoy, positivo para el futuro', () => {
  const today = new Date(2026, 7, 10)
  assert.equal(daysUntil(new Date(2026, 7, 10), today), 0)
  assert.equal(daysUntil(new Date(2026, 7, 13), today), 3)
  assert.equal(daysUntil(new Date(2026, 7, 5), today), -5)
})

test('getStatementClosingForDueDate usa el corte del mes anterior cuando el corte es posterior al pago', () => {
  // corte 25, pago 15 oct → extracto cerrado el 25 sep
  const closing = getStatementClosingForDueDate(25, new Date(2026, 9, 15))
  assert.equal(closing.getMonth(), 8)
  assert.equal(closing.getDate(), 25)
})

test('getStatementClosingForDueDate usa el corte del mismo mes cuando el corte es anterior al pago', () => {
  // corte 5, pago 20 oct → extracto cerrado el 5 oct
  const closing = getStatementClosingForDueDate(5, new Date(2026, 9, 20))
  assert.equal(closing.getMonth(), 9)
  assert.equal(closing.getDate(), 5)
})

test('getStatementClosingForDueDate trata corte el mismo día del pago como el ciclo anterior', () => {
  const closing = getStatementClosingForDueDate(15, new Date(2026, 9, 15))
  assert.equal(closing.getMonth(), 8)
  assert.equal(closing.getDate(), 15)
})

test('getStatementClosingForDueDate ajusta el corte 31 a meses cortos', () => {
  // corte 31, pago 10 mar → extracto cerrado el 28 feb
  const closing = getStatementClosingForDueDate(31, new Date(2026, 2, 10))
  assert.equal(closing.getMonth(), 1)
  assert.equal(closing.getDate(), 28)
})

test('el monto del pago sale del extracto cerrado, no del ciclo en curso después del corte', () => {
  // corte 25, pago 15 oct, hoy 11 oct: la compra del 20 sep va al pago del 15 oct;
  // la del 1 oct pertenece al siguiente extracto.
  const closing = getStatementClosingForDueDate(25, new Date(2026, 9, 15))
  const sep = { type: 'expense', amount: -100_000, date: new Date(2026, 8, 20), installments: 1 }
  const oct = { type: 'expense', amount: -50_000, date: new Date(2026, 9, 1), installments: 1 }
  assert.equal(expenseAmountForCycle(sep, 25, closing), 100_000)
  assert.equal(expenseAmountForCycle(oct, 25, closing), 0)
})
