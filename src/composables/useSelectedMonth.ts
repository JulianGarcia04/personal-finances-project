import { computed, type ComputedRef } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'

// The month a page shows, kept in the URL as ?mes=YYYY-MM so Dashboard and Presupuestos share it.
// Without a valid past month in the URL the page shows the current month.

/** A calendar month; `month` is 0-based like Date#getMonth. */
export interface CalendarMonth {
  year: number;
  month: number;
}

export const SELECTED_MONTH_QUERY_KEY = 'mes'

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/
// Date maps years 0-99 to 1900-1999, so earlier years are not valid months.
const FIRST_VALID_YEAR = 1900

const monthIndex = ({ year, month }: CalendarMonth) => year * 12 + month

export const calendarMonthOf = (date: Date): CalendarMonth => ({ year: date.getFullYear(), month: date.getMonth() })

export const shiftMonth = ({ year, month }: CalendarMonth, delta: number): CalendarMonth =>
  calendarMonthOf(new Date(year, month + delta, 1))

export const formatMonthKey = ({ year, month }: CalendarMonth) => `${year}-${String(month + 1).padStart(2, '0')}`

const monthLabelFormat = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' })

/** es-CO month name and year, e.g. "octubre de 2026". */
export const formatMonthLabel = ({ year, month }: CalendarMonth) => monthLabelFormat.format(new Date(year, month, 1))

/** Reads a ?mes value: a past or current YYYY-MM month; anything else (missing, invalid, future) is `now`'s month. */
export const parseSelectedMonth = (raw: unknown, now: Date): CalendarMonth => {
  const current = calendarMonthOf(now)
  const match = typeof raw === 'string' ? MONTH_KEY_PATTERN.exec(raw) : null
  if (!match) return current
  const selected = { year: Number(match[1]), month: Number(match[2]) - 1 }
  if (selected.year < FIRST_VALID_YEAR || selected.month < 0 || selected.month > 11) return current
  return monthIndex(selected) > monthIndex(current) ? current : selected
}

export interface SelectedMonthState {
  selectedMonth: ComputedRef<CalendarMonth>;
  isCurrentMonth: ComputedRef<boolean>;
  /** es-CO label of the selected month, e.g. "octubre de 2026". */
  label: ComputedRef<string>;
  /** False at the current month: future months are never shown. */
  canGoNext: ComputedRef<boolean>;
  goToMonth: (month: CalendarMonth) => Promise<void>;
  goToPreviousMonth: () => Promise<void>;
  goToNextMonth: () => Promise<void>;
  goToCurrentMonth: () => Promise<void>;
}

// Month changes replace the history entry (Back leaves the page instead of stepping through
// months) and keep the path, the hash and every other query key, such as Presupuestos' ?tab.
export function useSelectedMonth({ now = () => new Date() }: { now?: () => Date } = {}): SelectedMonthState {
  const route = useRoute()
  const router = useRouter()

  const selectedMonth = computed(() => parseSelectedMonth(route.query[SELECTED_MONTH_QUERY_KEY], now()))
  const isCurrentMonth = computed(() => monthIndex(selectedMonth.value) >= monthIndex(calendarMonthOf(now())))
  const label = computed(() => formatMonthLabel(selectedMonth.value))
  const canGoNext = computed(() => !isCurrentMonth.value)

  const goToMonth = async (target: CalendarMonth) => {
    const query: LocationQuery = { ...route.query }
    // The current month (or a later one) is the default: it leaves ?mes out of the URL.
    if (monthIndex(target) < monthIndex(calendarMonthOf(now()))) query[SELECTED_MONTH_QUERY_KEY] = formatMonthKey(target)
    else delete query[SELECTED_MONTH_QUERY_KEY]
    await router.replace({ path: route.path, query, hash: route.hash })
  }

  return {
    selectedMonth,
    isCurrentMonth,
    label,
    canGoNext,
    goToMonth,
    goToPreviousMonth: () => goToMonth(shiftMonth(selectedMonth.value, -1)),
    goToNextMonth: () => canGoNext.value ? goToMonth(shiftMonth(selectedMonth.value, 1)) : Promise.resolve(),
    goToCurrentMonth: () => goToMonth(calendarMonthOf(now()))
  }
}
