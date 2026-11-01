<script setup lang="ts">
import {
  BUDGET_BASIS_HINTS,
  BUDGET_BASIS_LABELS,
  budgetBasis,
  setBudgetBasis,
  type BudgetBasis
} from '@/lib/budgetBasis'

const options: BudgetBasis[] = ['consumption', 'payment']
</script>

<template>
  <div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4" data-testid="budget-basis-switch">
    <div role="group" aria-label="Cómo contar los gastos con tarjeta de crédito en los presupuestos" class="inline-flex self-start shrink-0 p-1 rounded-xl bg-slate-900 border border-border">
      <button
        v-for="option in options"
        :key="option"
        type="button"
        :aria-pressed="budgetBasis === option"
        :class="['tap min-h-11 px-4 rounded-lg text-xs font-semibold transition-colors', budgetBasis === option ? 'bg-accent-emerald/15 text-accent-emerald' : 'text-text-secondary hover:text-text-primary']"
        @click="setBudgetBasis(option)"
      >
        {{ BUDGET_BASIS_LABELS[option] }}
      </button>
    </div>
    <p class="min-w-0 text-xs text-text-secondary" aria-live="polite">
      {{ BUDGET_BASIS_HINTS[budgetBasis] }}
    </p>
  </div>
</template>
