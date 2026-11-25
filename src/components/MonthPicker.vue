<script setup lang="ts">
import { ChevronLeft as PreviousIcon, ChevronRight as NextIcon } from 'lucide-vue-next'

// Presentational month stepper; the page owns the month (useSelectedMonth) and reacts to the events.
withDefaults(defineProps<{
  /** Month shown, e.g. "octubre de 2026"; announced politely when it changes. */
  label: string
  /** False at the current month: future months are never shown. */
  canGoNext: boolean
  groupLabel?: string
}>(), { groupLabel: 'Mes' })

const emit = defineEmits<{
  previous: []
  next: []
}>()
</script>

<template>
  <div
    role="group"
    :aria-label="groupLabel"
    data-testid="month-picker"
    class="inline-flex items-center self-start shrink-0 p-1 rounded-xl bg-slate-900 border border-border"
  >
    <button
      type="button"
      aria-label="Mes anterior"
      title="Mes anterior"
      class="tap inline-flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors"
      @click="emit('previous')"
    >
      <PreviousIcon class="w-4 h-4" aria-hidden="true" />
    </button>
    <span
      aria-live="polite"
      aria-atomic="true"
      class="inline-block min-w-36 px-2 text-center text-xs font-semibold text-text-primary tabular-nums first-letter:uppercase"
    >{{ label }}</span>
    <button
      type="button"
      aria-label="Mes siguiente"
      title="Mes siguiente"
      :disabled="!canGoNext"
      class="tap inline-flex items-center justify-center rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
      @click="emit('next')"
    >
      <NextIcon class="w-4 h-4" aria-hidden="true" />
    </button>
  </div>
</template>
