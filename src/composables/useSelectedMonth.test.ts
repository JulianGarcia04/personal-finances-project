import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  formatMonthKey,
  formatMonthLabel,
  parseSelectedMonth,
  shiftMonth,
  useSelectedMonth
} from './useSelectedMonth.ts'

// Fixed "today": 24 November 2026 (month index 10).
const NOW = new Date(2026, 10, 24, 15, 30)
const now = () => NOW
const NOVEMBER_2026 = { year: 2026, month: 10 }

// Runs the composable inside a real router (memory history) at `path`.
const withRoute = async (path: string) => {
  const page = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: page },
      { path: '/goals', component: page }
    ]
  })
  await router.push(path)
  const app = createApp({ render: () => null })
  app.use(router)
  const state = app.runWithContext(() => useSelectedMonth({ now }))
  return { router, state, fullPath: () => router.currentRoute.value.fullPath }
}

test('S9: ?mes parses a past YYYY-MM month and defaults to the current month', () => {
  assert.deepEqual(parseSelectedMonth(undefined, NOW), NOVEMBER_2026)
  assert.deepEqual(parseSelectedMonth('2026-10', NOW), { year: 2026, month: 9 })
  assert.deepEqual(parseSelectedMonth('2025-12', NOW), { year: 2025, month: 11 })
  assert.deepEqual(parseSelectedMonth('2026-11', NOW), NOVEMBER_2026)
})

test('S9: an invalid ?mes falls back to the current month', () => {
  for (const raw of ['', 'abc', '2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '1899-12', null, ['2026-10'], 202610]) {
    assert.deepEqual(parseSelectedMonth(raw, NOW), NOVEMBER_2026, `${JSON.stringify(raw)} falls back`)
  }
})

test('S9: a future ?mes falls back to the current month', () => {
  assert.deepEqual(parseSelectedMonth('2026-12', NOW), NOVEMBER_2026)
  assert.deepEqual(parseSelectedMonth('2031-01', NOW), NOVEMBER_2026)
})

test('S9: month keys, labels and shifts cross year boundaries', () => {
  assert.equal(formatMonthKey({ year: 2026, month: 0 }), '2026-01')
  assert.equal(formatMonthKey({ year: 2025, month: 11 }), '2025-12')
  assert.equal(formatMonthLabel({ year: 2026, month: 9 }), 'octubre de 2026')
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 })
  assert.deepEqual(shiftMonth({ year: 2025, month: 11 }, 1), { year: 2026, month: 0 })
})

test('S9: the composable exposes the selected month, whether it is the current one and its es-CO label', async () => {
  const past = await withRoute('/?mes=2026-10')
  assert.deepEqual(past.state.selectedMonth.value, { year: 2026, month: 9 })
  assert.equal(past.state.isCurrentMonth.value, false)
  assert.equal(past.state.label.value, 'octubre de 2026')
  assert.equal(past.state.canGoNext.value, true)

  const current = await withRoute('/')
  assert.deepEqual(current.state.selectedMonth.value, NOVEMBER_2026)
  assert.equal(current.state.isCurrentMonth.value, true)
  assert.equal(current.state.label.value, 'noviembre de 2026')
  assert.equal(current.state.canGoNext.value, false, 'next is disabled at the current month')

  const future = await withRoute('/?mes=2027-02')
  assert.equal(future.state.isCurrentMonth.value, true)
  assert.equal(future.state.label.value, 'noviembre de 2026')
})

test('S9: previous month writes ?mes and keeps the path and other query keys', async () => {
  const { state, fullPath } = await withRoute('/goals?tab=savings')
  await state.goToPreviousMonth()
  assert.equal(fullPath(), '/goals?tab=savings&mes=2026-10')
  assert.equal(state.label.value, 'octubre de 2026')

  await state.goToPreviousMonth()
  assert.equal(fullPath(), '/goals?tab=savings&mes=2026-09')

  const january = await withRoute('/?mes=2026-01')
  await january.state.goToPreviousMonth()
  assert.equal(january.fullPath(), '/?mes=2025-12')
})

test('S9: next month moves forward and drops ?mes on reaching the current month; it never goes past it', async () => {
  const { state, fullPath } = await withRoute('/goals?mes=2026-09&tab=savings')
  await state.goToNextMonth()
  assert.equal(fullPath(), '/goals?mes=2026-10&tab=savings')
  await state.goToNextMonth()
  assert.equal(fullPath(), '/goals?tab=savings')
  assert.equal(state.isCurrentMonth.value, true)
  await state.goToNextMonth()
  assert.equal(fullPath(), '/goals?tab=savings')
  assert.deepEqual(state.selectedMonth.value, NOVEMBER_2026)
})

test('S9: back to the current month drops ?mes, keeps other keys and replaces the history entry', async () => {
  const { router, state, fullPath } = await withRoute('/')
  await router.push('/goals?tab=savings&mes=2026-03')
  await state.goToCurrentMonth()
  assert.equal(fullPath(), '/goals?tab=savings')
  assert.equal(state.isCurrentMonth.value, true)

  await state.goToPreviousMonth()
  assert.equal(fullPath(), '/goals?tab=savings&mes=2026-10')
  // Month changes replace the entry: going back leaves the page instead of stepping through months.
  await new Promise<void>(resolve => {
    const stop = router.afterEach(() => { stop(); resolve() })
    router.back()
  })
  assert.equal(fullPath(), '/')
})
