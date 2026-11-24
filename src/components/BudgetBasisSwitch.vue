<script setup lang="ts">
import { computed, shallowRef, useId } from 'vue'
import {
  BUDGET_BASIS_HINTS,
  BUDGET_BASIS_LABELS,
  type BudgetBasis
} from '@/lib/budgetBasis'
import { useWorkspacesStore } from '@/stores/workspacesStore'

const options: BudgetBasis[] = ['consumption', 'payment']
const workspacesStore = useWorkspacesStore()
const ownerNoteId = useId()

// The saved workspace basis is the only selection, so a failed write keeps showing the previous one.
const basis = computed(() => workspacesStore.activeBudgetCardBasis)
const workspaceId = computed(() => workspacesStore.activeWorkspace?.id ?? '')
const saving = computed(() => workspacesStore.pendingBudgetCardBasisWrites.has(workspaceId.value))
const canChange = computed(() => workspacesStore.isActiveWorkspaceOwner && !saving.value)
const readOnlyForMember = computed(() => Boolean(workspaceId.value) && !workspacesStore.isActiveWorkspaceOwner)
// Feedback belongs to the workspace it was written for and is hidden after switching.
const failure = shallowRef<{ workspaceId: string; message: string } | null>(null)
const errorMessage = computed(() => failure.value?.workspaceId === workspaceId.value ? failure.value.message : '')

const select = async (option: BudgetBasis) => {
  const targetId = workspaceId.value
  const previous = basis.value
  if (!canChange.value || option === previous) return
  failure.value = null
  try {
    await workspacesStore.updateBudgetCardBasis(targetId, option)
  } catch {
    failure.value = { workspaceId: targetId, message: `No se pudo guardar el cambio; se mantiene «${BUDGET_BASIS_LABELS[previous]}».` }
  }
}
</script>

<template>
  <div class="space-y-2" data-testid="budget-basis-switch">
    <div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
      <div role="group" aria-label="Cómo contar los gastos con tarjeta de crédito en los presupuestos" :aria-busy="saving" class="inline-flex self-start shrink-0 p-1 rounded-xl bg-slate-900 border border-border">
        <button
          v-for="option in options"
          :key="option"
          type="button"
          :aria-pressed="basis === option"
          :disabled="!canChange"
          :aria-describedby="readOnlyForMember ? ownerNoteId : undefined"
          :class="['tap min-h-11 px-4 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed', basis === option ? 'bg-accent-emerald/15 text-accent-emerald' : 'text-text-secondary enabled:hover:text-text-primary disabled:opacity-60']"
          @click="select(option)"
        >
          {{ BUDGET_BASIS_LABELS[option] }}
        </button>
      </div>
      <p class="min-w-0 text-xs text-text-secondary" aria-live="polite">
        {{ BUDGET_BASIS_HINTS[basis] }}
      </p>
    </div>
    <p v-if="readOnlyForMember" :id="ownerNoteId" class="text-xs text-text-muted">
      Solo el dueño del espacio de trabajo puede cambiar esta opción; se aplica a todos los miembros.
    </p>
    <p v-else-if="saving" role="status" class="text-xs text-text-muted">Guardando…</p>
    <p v-if="errorMessage" role="alert" class="text-xs text-accent-rose">{{ errorMessage }}</p>
  </div>
</template>
