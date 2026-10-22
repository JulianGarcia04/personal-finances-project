<template>
  <div class="max-w-6xl mx-auto space-y-8 pb-12">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div class="min-w-0">
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight">
          Objetivos & Presupuesto
        </h2>
        <p class="text-text-secondary text-sm mt-1">Crea metas de ahorro a largo plazo y define la distribución de tus ingresos mensuales.</p>
      </div>

      <div class="grid grid-cols-1 min-[380px]:grid-cols-2 sm:flex sm:flex-wrap items-center gap-2.5 sm:gap-3 w-full sm:w-auto">
        <button
          @click="openBudgetModal()"
          class="inline-flex items-center justify-center min-h-11 space-x-2 px-4 py-2.5 sm:py-3 rounded-xl bg-slate-900 border border-border text-text-primary font-display font-semibold text-sm hover:bg-slate-800 transition-all cursor-pointer"
        >
          <PlusIcon class="w-4 h-4 shrink-0 text-accent-emerald" />
          <span class="truncate">Nuevo presupuesto</span>
        </button>
        <button 
          @click="showCreateModal = true"
          class="inline-flex items-center justify-center min-h-11 space-x-2 px-5 py-2.5 sm:py-3 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm transition-all shadow-glow-emerald cursor-pointer"
        >
          <PlusIcon class="w-4 h-4 shrink-0" />
          <span class="truncate">Nuevo Objetivo</span>
        </button>
      </div>
    </div>

    <!-- Main Grid layout -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      
      <!-- Left: Savings Goals (2 cols) -->
      <div class="lg:col-span-2 space-y-6">
        <h3 class="font-display font-bold text-xl text-text-primary flex items-center space-x-2">
          <TargetIcon class="w-5 h-5 text-accent-emerald" />
          <span>Tus Metas de Ahorro</span>
        </h3>

        <!-- Loading State -->
        <div v-if="goalsStore.loading && goalsStore.goals.length === 0" class="flex justify-center py-12">
          <div class="w-10 h-10 rounded-full border-2 border-accent-emerald/20 border-t-accent-emerald animate-spin"></div>
        </div>

        <!-- Empty State -->
        <div v-else-if="goalsStore.goals.length === 0" class="glass-panel rounded-2xl p-12 text-center space-y-4">
          <div class="w-12 h-12 rounded-xl bg-accent-emerald/10 flex items-center justify-center mx-auto text-accent-emerald border border-accent-emerald/20">
            <TargetIcon class="w-6 h-6" />
          </div>
          <div>
            <h4 class="font-display font-semibold text-lg text-text-primary">No tienes objetivos creados</h4>
            <p class="text-text-secondary text-xs mt-1 max-w-sm mx-auto">
              Crea tu primera meta, como comprar un carro, ahorrar para un viaje o construir un fondo de emergencias.
            </p>
          </div>
          <button 
            @click="showCreateModal = true"
            class="min-h-11 px-4 py-2 rounded-lg bg-slate-900 border border-border text-xs font-semibold text-text-primary hover:bg-slate-800 transition-colors"
          >
            Crear mi primer objetivo
          </button>
        </div>

        <!-- Goals Cards List -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div 
            v-for="goal in goalsStore.goals" 
            :key="goal.id"
            class="glass-panel rounded-2xl p-5 border border-white/5 space-y-4 hover:border-white/10 transition-all flex flex-col justify-between"
          >
            <!-- Goal Header -->
            <div class="flex justify-between items-start gap-3">
              <div class="min-w-0">
                <h4 class="font-display font-bold text-lg text-text-primary line-clamp-2 break-words" :title="goal.name">{{ goal.name }}</h4>
                <p class="text-[10px] text-text-muted mt-0.5">Meta: {{ formatDate(goal.targetDate) }}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button 
                  @click="openContributeModal(goal)"
                  title="Aportar saldo"
                  aria-label="Aportar saldo"
                  class="tap flex items-center justify-center rounded-xl bg-accent-emerald/10 border border-accent-emerald/20 text-accent-emerald hover:bg-accent-emerald/20 transition-colors cursor-pointer"
                >
                  <PiggyBankIcon class="w-4 h-4" />
                </button>
                <button 
                  @click="handleDeleteGoal(goal.id)"
                  title="Eliminar meta"
                  aria-label="Eliminar meta"
                  class="tap flex items-center justify-center rounded-xl bg-accent-rose/10 border border-accent-rose/20 text-accent-rose hover:bg-accent-rose/20 transition-colors cursor-pointer"
                >
                  <TrashIcon class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Progress Info -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-xs font-semibold">
                <span class="text-text-secondary">Progreso</span>
                <span class="text-accent-emerald">{{ getProgressPercent(goal) }}%</span>
              </div>
              
              <!-- Progress Bar -->
              <div class="w-full h-2.5 rounded-full bg-slate-950/60 overflow-hidden border border-white/5">
                <div 
                  class="h-full rounded-full bg-gradient-to-r from-accent-emerald to-accent-violet transition-all duration-500"
                  :style="{ width: `${Math.min(getProgressPercent(goal), 100)}%` }"
                ></div>
              </div>

              <!-- Amounts -->
              <div class="grid grid-cols-2 gap-2 text-xs pt-1">
                <div class="min-w-0">
                  <span class="block text-text-muted">Ahorrado</span>
                  <span class="block text-text-primary font-semibold tabular-nums whitespace-nowrap truncate" :title="formatCurrency(goal.currentAmount, goal.currency)">{{ formatCurrency(goal.currentAmount, goal.currency) }}</span>
                </div>
                <div class="min-w-0 text-right">
                  <span class="block text-text-muted">Objetivo</span>
                  <span class="block text-text-secondary font-semibold tabular-nums whitespace-nowrap truncate" :title="formatCurrency(goal.targetAmount, goal.currency)">{{ formatCurrency(goal.targetAmount, goal.currency) }}</span>
                </div>
              </div>
            </div>

            <!-- Goal Footer info -->
            <div class="text-[11px] text-text-secondary bg-slate-950/30 p-2.5 rounded-lg border border-white/5 flex flex-wrap justify-between gap-x-3 gap-y-1">
              <span class="tabular-nums">Restante: {{ formatCurrency(Math.max(goal.targetAmount - goal.currentAmount, 0), goal.currency) }}</span>
              <span class="text-accent-violet font-semibold uppercase">{{ getDaysRemainingText(goal.targetDate) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Budget Planner (1 col) -->
      <div class="space-y-6">
        <h3 class="font-display font-bold text-xl text-text-primary flex items-center space-x-2">
          <PiggyBankIcon class="w-5 h-5 text-accent-emerald" />
          <span>Plan de Presupuesto</span>
        </h3>

        <div class="glass-panel rounded-2xl p-4 sm:p-6 border border-white/5 space-y-6">
          
          <!-- Income Input -->
          <div class="space-y-2">
            <label class="block text-xs font-semibold text-text-secondary">Ingreso Mensual Estimado</label>
            <div class="relative">
              <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted font-semibold">$</span>
              <input 
                v-model.number="incomeInput"
                type="number"
                inputmode="decimal"
                min="0"
                class="field pl-8 font-semibold"
                placeholder="Ingresa tus ingresos"
                @change="saveBudget"
              />
            </div>
          </div>

          <!-- Pie / Donut Chart -->
          <div class="relative w-48 h-48 mx-auto flex items-center justify-center">
            <canvas ref="budgetChartRef"></canvas>
            <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-2">
              <span class="text-[10px] text-text-muted font-semibold uppercase tracking-wider">Ahorro</span>
              <span class="max-w-[8.5rem] truncate font-display font-bold text-base text-accent-emerald tabular-nums" :title="formatCurrency(monthlySavingsAmount, userCurrency)">
                {{ formatCompactCurrency(monthlySavingsAmount, userCurrency) }}
              </span>
            </div>
          </div>

          <!-- Distribution sliders -->
          <div class="space-y-4">
            <!-- Needs Slider (50% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between gap-2 text-xs font-semibold">
                <span class="min-w-0 text-text-secondary flex items-center gap-1.5">
                  <span class="shrink-0 w-2.5 h-2.5 rounded-full bg-accent-emerald"></span>
                  Necesidades (50%)
                </span>
                <span class="shrink-0 text-text-primary tabular-nums">{{ formatCurrency(monthlyNeedsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="needsPercent"
                type="range"
                min="0"
                max="100"
                class="range-slider text-accent-emerald"
                @input="adjustSliders('needs')"
                @change="saveBudget"
              />
            </div>

            <!-- Wants Slider (30% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between gap-2 text-xs font-semibold">
                <span class="min-w-0 text-text-secondary flex items-center gap-1.5">
                  <span class="shrink-0 w-2.5 h-2.5 rounded-full bg-accent-violet"></span>
                  Deseos (30%)
                </span>
                <span class="shrink-0 text-text-primary tabular-nums">{{ formatCurrency(monthlyWantsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="wantsPercent"
                type="range"
                min="0"
                max="100"
                class="range-slider text-accent-violet"
                @input="adjustSliders('wants')"
                @change="saveBudget"
              />
            </div>

            <!-- Savings Slider (20% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between gap-2 text-xs font-semibold">
                <span class="min-w-0 text-text-secondary flex items-center gap-1.5">
                  <span class="shrink-0 w-2.5 h-2.5 rounded-full bg-accent-amber"></span>
                  Ahorro (20%)
                </span>
                <span class="shrink-0 text-text-primary tabular-nums">{{ formatCurrency(monthlySavingsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="savingsPercent"
                type="range"
                min="0"
                max="100"
                class="range-slider text-accent-amber"
                @input="adjustSliders('savings')"
                @change="saveBudget"
              />
            </div>
          </div>

          <!-- Total Allocation indicator -->
          <div class="p-3 bg-slate-950/45 border border-white/5 rounded-xl text-center text-xs flex justify-between gap-2">
            <span class="text-text-secondary">Suma total porcentajes:</span>
            <span :class="[isPercentSumValid ? 'text-accent-emerald font-bold' : 'text-accent-rose font-bold']">
              {{ needsPercent + wantsPercent + savingsPercent }}%
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Additional operating budgets; the protected legacy baseline remains below. -->
    <section class="space-y-5" aria-labelledby="additional-budgets-heading">
      <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div class="min-w-0">
          <h3 id="additional-budgets-heading" class="font-display font-bold text-lg sm:text-xl text-text-primary flex items-center gap-2">
            <WalletIcon class="w-5 h-5 shrink-0 text-accent-emerald" />
            <span>Presupuestos adicionales</span>
          </h3>
          <p class="text-xs text-text-muted mt-1 max-w-3xl">
            Se administran separados de las metas, sus asignaciones, el plan 50/30/20 y los límites base por categoría.
            Los límites se conservan en su moneda guardada; la moneda de visualización no cambia la moneda guardada.
          </p>
        </div>
        <button
          @click="openBudgetModal()"
          class="self-start sm:self-auto inline-flex items-center justify-center min-h-11 gap-2 px-4 py-2.5 rounded-xl bg-accent-emerald/10 border border-accent-emerald/20 text-accent-emerald text-xs font-semibold hover:bg-accent-emerald/15 transition-colors cursor-pointer shrink-0"
        >
          <PlusIcon class="w-4 h-4" />
          <span>Nuevo presupuesto</span>
        </button>
      </div>

      <p v-if="goalsStore.budgetSettingsError" role="alert" class="text-xs text-accent-rose">
        {{ goalsStore.budgetSettingsError }}
      </p>
      <div v-if="goalsStore.budgetSettingsLoading && goalsStore.operatingBudgets.length === 0" class="glass-panel rounded-2xl p-6 text-center text-xs text-text-muted">
        Cargando presupuestos del espacio…
      </div>
      <div v-else-if="activeOperatingBudgets.length === 0" class="glass-panel rounded-2xl p-6 text-center text-xs text-text-muted">
        Aún no hay presupuestos adicionales. Los gastos sin presupuesto asignado permanecen en el presupuesto base mensual.
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <article v-for="entry in activeOperatingBudgets" :key="entry.budget.id" class="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5 space-y-4 flex flex-col justify-between">
          <div class="space-y-3">
            <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div class="min-w-0">
                <h4 class="font-display font-bold text-base text-text-primary line-clamp-2 break-words" :title="entry.budget.name">{{ entry.budget.name }}</h4>
                <p class="text-[11px] text-text-muted mt-1">
                  {{ entry.budget.kind === 'event' ? 'Presupuesto de evento' : 'Presupuesto mensual' }} · moneda de límites: {{ entry.budget.capCurrency }}
                </p>
              </div>
              <div class="grid grid-cols-2 sm:flex items-center gap-2 shrink-0 w-full sm:w-auto">
                <button @click="openBudgetModal(entry)" class="min-h-11 px-3 py-2 rounded-xl bg-slate-900 border border-border text-xs font-semibold text-text-primary hover:bg-slate-800 transition-colors cursor-pointer">
                  Editar presupuesto
                </button>
                <button @click="handleArchiveBudget(entry.budget.id)" class="min-h-11 px-3 py-2 rounded-xl bg-accent-rose/10 border border-accent-rose/20 text-xs font-semibold text-accent-rose hover:bg-accent-rose/15 transition-colors cursor-pointer">
                  Eliminar presupuesto
                </button>
              </div>
            </div>
            <div v-for="card in [budgetCards.get(entry.budget.id)]" :key="entry.budget.id" class="space-y-3" data-testid="budget-card-progress">
              <p v-if="!card || card.spent === null" role="status" class="text-[11px] text-accent-amber">
                Falta una tasa de cambio manual para calcular el gasto de este presupuesto.
              </p>
              <template v-else>
                <div v-if="card.funds !== null" class="space-y-1.5" data-testid="budget-card-funds">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="text-xs text-text-secondary">Disponible</span>
                    <span
                      v-if="card.available !== null"
                      class="font-display font-bold text-lg tabular-nums truncate"
                      :class="card.available < 0 ? 'text-accent-rose' : 'text-accent-emerald'"
                      :title="formatCurrency(card.available, card.currency)"
                    >
                      {{ formatCurrency(card.available, card.currency) }}
                    </span>
                    <span v-else class="text-[11px] text-accent-amber">Falta una tasa de cambio</span>
                  </div>
                  <div
                    v-if="card.fundsPercent !== null"
                    class="h-2 rounded-full bg-slate-900 overflow-hidden"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="Math.min(card.fundsPercent, 100)"
                    :aria-label="`Gastado el ${card.fundsPercent} % de los fondos`"
                  >
                    <div class="h-full rounded-full transition-all" :class="progressTone(card.fundsPercent)" :style="{ width: `${Math.min(card.fundsPercent, 100)}%` }"></div>
                  </div>
                  <p v-if="card.fundsAmount !== null" class="text-[10px] text-text-muted tabular-nums">
                    Gastado {{ formatCurrency(card.spent, card.currency) }} de {{ formatCurrency(card.fundsAmount, card.currency) }} en fondos{{ card.fundsPercent !== null ? ` · ${card.fundsPercent} %` : '' }}
                  </p>
                </div>

                <div v-if="card.limitAmount !== null" class="space-y-1.5" data-testid="budget-card-limit">
                  <div class="flex items-baseline justify-between gap-2 text-xs">
                    <span class="text-text-secondary">Límite total</span>
                    <span class="font-semibold text-text-primary tabular-nums">{{ formatCurrency(card.spent, card.currency) }} / {{ formatCurrency(card.limitAmount, card.currency) }}</span>
                  </div>
                  <div
                    class="h-1.5 rounded-full bg-slate-900 overflow-hidden"
                    role="progressbar"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-valuenow="Math.min(card.limitPercent, 100)"
                    :aria-label="`Gastado el ${card.limitPercent} % del límite total`"
                  >
                    <div class="h-full rounded-full transition-all" :class="progressTone(card.limitPercent)" :style="{ width: `${Math.min(card.limitPercent, 100)}%` }"></div>
                  </div>
                </div>
                <p v-else-if="entry.budget.totalLimit !== undefined" class="text-[11px] text-text-muted tabular-nums">
                  Límite total: {{ formatCurrency(entry.budget.totalLimit, entry.budget.capCurrency) }} · falta una tasa de cambio para compararlo
                </p>

                <p v-if="card.funds === null" class="text-sm font-semibold text-text-primary tabular-nums">
                  Gastado: {{ formatCurrency(card.spent, card.currency) }}{{ entry.budget.totalLimit === undefined ? ' · Sin límite total' : '' }}
                </p>
                <p v-if="card.funds === null" class="text-[10px] text-text-muted">
                  ¿Esta plata viene de un ingreso propio? Regístralo con este presupuesto y verás cuánto te queda disponible.
                </p>
              </template>
            </div>
          </div>
          <div v-if="budgetCategoryCapEntries(entry).length" class="flex flex-wrap gap-2">
            <span v-for="cap in budgetCategoryCapEntries(entry)" :key="cap.categoryId" class="px-2.5 py-1 rounded-lg bg-slate-950/60 border border-white/5 text-[10px] text-text-secondary tabular-nums">
              {{ categoryName(cap.categoryId) }} · {{ formatCurrency(cap.amount, entry.budget.capCurrency) }}
            </span>
          </div>
          <p v-if="entry.budget.linkedAccountIds?.length" class="flex items-start gap-1 text-[10px] text-text-secondary">
            <LinkIcon class="w-3 h-3 mt-px shrink-0 text-accent-emerald" />
            <span>Cuentas ligadas: {{ entry.budget.linkedAccountIds.map(accountName).join(', ') }}</span>
          </p>
          <p class="text-[10px] text-text-muted">Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada.</p>
          <button
            v-if="budgetMoveCandidatesById.get(entry.budget.id)?.length"
            type="button"
            data-testid="budget-move-open"
            class="tap w-full sm:w-auto inline-flex items-center justify-center gap-2 px-3 rounded-xl border border-accent-emerald/30 bg-accent-emerald/10 text-xs font-semibold text-accent-emerald hover:bg-accent-emerald/15 transition-colors cursor-pointer"
            @click="openMoveSheet(entry.budget.id)"
          >
            <MoveIcon class="w-3.5 h-3.5 shrink-0" />
            Mover {{ movementCountLabel(budgetMoveCandidatesById.get(entry.budget.id)!.length) }} existentes
          </button>
          <p v-if="entry.budget.kind === 'event' && (entry.budget.startDate || entry.budget.endDate)" class="text-[10px] text-text-muted">
            Periodo de referencia: {{ entry.budget.startDate ? formatDate(entry.budget.startDate) : 'Sin inicio' }} – {{ entry.budget.endDate ? formatDate(entry.budget.endDate) : 'Sin fin' }}
          </p>
        </article>
      </div>

      <div v-if="archivedOperatingBudgets.length" class="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5 space-y-3">
        <div>
          <h4 class="font-display font-semibold text-sm text-text-primary">Presupuestos eliminados</h4>
          <p class="text-[10px] text-text-muted mt-0.5">
            Eliminar conserva asignaciones, historial y cuotas pendientes; no borra movimientos ni límites guardados.
          </p>
        </div>
        <div v-for="entry in archivedOperatingBudgets" :key="entry.budget.id" class="flex flex-wrap items-center justify-between gap-2 text-xs border-t border-white/5 pt-3">
          <div>
            <span class="font-semibold text-text-secondary">{{ entry.budget.name }}</span>
            <span class="text-text-muted ml-2">Eliminado · límites en {{ entry.budget.capCurrency }}</span>
          </div>
          <span class="text-text-muted tabular-nums">
            {{ entry.budget.totalLimit === undefined ? 'Sin límite total' : formatCurrency(entry.budget.totalLimit, entry.budget.capCurrency) }} · {{ budgetCategoryCapEntries(entry).length }} límites por categoría conservados
          </span>
        </div>
      </div>
    </section>

    <!-- Category Budgets (presupuesto mensual recurrente) -->
    <div class="space-y-6">
      <h3 class="font-display font-bold text-lg sm:text-xl text-text-primary flex items-center space-x-2">
        <WalletIcon class="w-5 h-5 shrink-0 text-accent-emerald" />
        <span>Presupuesto Mensual por Categoría · Presupuesto base mensual protegido</span>
      </h3>

      <div class="glass-panel rounded-2xl p-4 sm:p-6 border border-white/5 space-y-4">
        <div class="rounded-xl bg-slate-950/45 border border-white/5 p-3 sm:p-4 space-y-3">
          <div v-if="goalsStore.categoryBudgetCurrency.status === 'confirmed'" class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span class="text-text-secondary">
              Moneda confirmada para los límites heredados: <strong class="text-accent-emerald">{{ goalsStore.categoryBudgetCurrency.code }}</strong>.
              Sus importes no se convierten ni se renombran al cambiar la moneda de visualización.
            </span>
          </div>
          <div v-else class="space-y-2">
            <p class="text-xs font-semibold text-accent-amber">Confirmarla una vez por espacio (recomendado)</p>
            <p class="text-xs text-text-muted">
              Selecciona la moneda real de estos límites. Se conserva aunque cambie la moneda de visualización; no se convierten importes.
            </p>
            <div class="flex flex-col sm:flex-row sm:items-end gap-3">
              <label class="space-y-1.5 sm:w-56">
                <span class="block text-[11px] font-semibold text-text-secondary">Moneda real de los límites heredados</span>
                <select
                  v-model="legacyCategoryBudgetCurrencyInput"
                  class="field font-semibold cursor-pointer"
                >
                  <option v-for="option in SUPPORTED_CURRENCIES" :key="option.code" :value="option.code">{{ option.label }}</option>
                </select>
              </label>
              <button
                type="button"
                :disabled="confirmingLegacyCurrency || !isValidCurrencyCode(legacyCategoryBudgetCurrencyInput)"
                class="w-full sm:w-auto min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-xs hover:bg-accent-emerald-hover disabled:opacity-50 cursor-pointer"
                @click="confirmLegacyCategoryBudgetCurrency"
              >
                Confirmar moneda de límites heredados
              </button>
            </div>
          </div>
          <p v-if="legacyCurrencyError" role="alert" class="text-xs text-accent-rose">{{ legacyCurrencyError }}</p>
        </div>

        <p class="text-xs text-text-muted">
          Este presupuesto base conserva los límites heredados en <code>categoryBudgets</code>. Los gastos sin presupuesto asignado permanecen aquí.
          Cuando la moneda de los límites está confirmada, el gasto se compara en {{ userCurrency }} usando las tasas manuales actuales; si falta una tasa, no se muestra una comparación incompleta.
          Tip: también puedes pedirle al <span class="text-accent-emerald font-semibold">Asesor IA</span> que analice tus gastos y te proponga presupuestos.
        </p>

        <div v-if="baselineCategories.length === 0" class="text-center py-6 text-text-muted text-sm">
          Todavía no hay categorías con límite o gasto este mes.
        </div>

        <div
          v-for="cat in baselineCategories"
          :key="cat.id"
          class="flex flex-col sm:flex-row sm:items-center gap-3 py-3 border-b border-white/5 last:border-0"
        >
          <!-- Category identity -->
          <div class="min-w-0 flex items-center space-x-2.5 sm:w-48 shrink-0">
            <span
              class="shrink-0 p-2 rounded-lg"
              :style="{ backgroundColor: cat.color + '15', color: cat.color }"
            >
              <component :is="getCategoryIcon(cat.icon)" class="w-4 h-4" />
            </span>
            <span class="min-w-0 flex-1 text-sm font-semibold text-text-primary truncate">{{ cat.name }}</span>
            <button
              v-if="categoryBudgetInputs[cat.id] || baselineAddedCategoryIds.includes(cat.id)"
              type="button"
              class="tap shrink-0 flex items-center justify-center rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer"
              :aria-label="`Quitar límite de ${cat.name}`"
              @click="removeBaselineCategory(cat.id)"
            >
              <XIcon class="w-4 h-4" />
            </button>
          </div>

          <!-- Limit input -->
          <div class="relative sm:w-40 shrink-0">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[10px] font-semibold">
              {{ goalsStore.categoryBudgetCurrency.status === 'confirmed' ? goalsStore.categoryBudgetCurrency.code : '???' }}
            </span>
            <input
              :id="`base-cap-${cat.id}`"
              :value="categoryBudgetInputs[cat.id] ?? ''"
              :aria-label="`Límite mensual de ${cat.name}`"
              type="number"
              inputmode="decimal"
              min="0"
              placeholder="Sin límite"
              :disabled="goalsStore.categoryBudgetCurrency.status !== 'confirmed'"
              class="field pl-10 disabled:opacity-50 disabled:cursor-not-allowed"
              @change="(e) => saveCategoryBudget(cat.id, (e.target as HTMLInputElement).value)"
            />
          </div>

          <!-- Progress vs real spending -->
          <div class="flex-1 space-y-1">
            <div class="flex flex-wrap justify-between gap-x-2 text-[11px] font-semibold">
              <span class="text-text-secondary tabular-nums">
                <template v-if="baselineCategoryReport(cat.id)?.monthlyAllocation.complete !== false">
                  Gastado en {{ userCurrency }}: {{ formatCurrency(baselineCategoryAmount(cat.id), userCurrency) }}
                </template>
                <template v-else>Gasto en {{ userCurrency }}: falta una tasa manual</template>
              </span>
              <span v-if="categoryBudgetInputs[cat.id] && baselineCategoryReport(cat.id)?.comparison" :class="budgetPercent(cat.id) > 100 ? 'text-accent-rose' : budgetPercent(cat.id) >= 70 ? 'text-accent-amber' : 'text-accent-emerald'">
                {{ budgetPercent(cat.id) }}%{{ budgetStatusLabel(cat.id) }}
              </span>
              <span v-else-if="categoryBudgetInputs[cat.id]" class="text-accent-amber">Comparación pendiente de moneda o tasa</span>
            </div>
            <div class="w-full h-2 rounded-full bg-slate-950/60 overflow-hidden border border-white/5">
              <div
                :class="['h-full rounded-full transition-all duration-500', budgetPercent(cat.id) > 100 ? 'bg-accent-rose' : budgetPercent(cat.id) >= 70 ? 'bg-accent-amber' : 'bg-accent-emerald']"
                :style="{ width: Math.min(budgetPercent(cat.id), 100) + '%' }"
              ></div>
            </div>
          </div>
        </div>

        <CategoryPicker
          :categories="expenseCategories"
          :selected-ids="baselineCategoryIds"
          :suggestions="baselineSuggestedCategories"
          @select="addBaselineCategory"
        />
      </div>

      <!-- 50/30/20 vs realidad del mes -->
      <div class="glass-panel rounded-2xl p-4 sm:p-6 border border-white/5 space-y-4">
        <h4 class="font-display font-semibold text-sm text-text-primary">Tu plan 50/30/20 vs este mes (real)</h4>
        <!-- ponytail: no sabemos qué categorías son "necesidad" vs "deseo"; comparamos gasto total y ahorro reales contra el plan -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div class="space-y-1.5">
            <div class="flex justify-between gap-2 font-semibold">
              <span class="min-w-0 text-text-secondary">Gasto (plan necesidades+deseos)</span>
              <span class="shrink-0 text-right text-text-primary tabular-nums">{{ formatCurrency(monthlyNeedsAmount + monthlyWantsAmount, userCurrency) }}</span>
            </div>
            <div class="flex justify-between gap-2 font-semibold">
              <span class="min-w-0 text-text-secondary">Gasto real del mes</span>
              <span class="shrink-0 text-right tabular-nums" :class="realMonthExpense > (monthlyNeedsAmount + monthlyWantsAmount) ? 'text-accent-rose' : 'text-accent-emerald'">
                {{ formatCurrency(realMonthExpense, userCurrency) }}
              </span>
            </div>
          </div>
          <div class="space-y-1.5">
            <div class="flex justify-between gap-2 font-semibold">
              <span class="min-w-0 text-text-secondary">Ahorro (plan)</span>
              <span class="shrink-0 text-right text-text-primary tabular-nums">{{ formatCurrency(monthlySavingsAmount, userCurrency) }}</span>
            </div>
            <div class="flex justify-between gap-2 font-semibold">
              <span class="min-w-0 text-text-secondary">Ahorro real del mes</span>
              <span class="shrink-0 text-right tabular-nums" :class="realMonthSavings >= monthlySavingsAmount ? 'text-accent-emerald' : 'text-accent-amber'">
                {{ formatCurrency(realMonthSavings, userCurrency) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sheet: Create or edit an additional operating budget -->
    <BaseSheet :open="showBudgetModal" :title="editingOperatingBudget ? 'Editar presupuesto' : 'Nuevo presupuesto'" :close-on-backdrop="false" @close="showBudgetModal = false">
        <p class="text-[11px] text-text-muted mb-4">Los límites son nominales en la moneda indicada; no se convierten al cambiar la moneda de visualización.</p>
        <form id="operating-budget-form" class="space-y-4" @submit.prevent="handleSaveOperatingBudget">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Nombre del presupuesto</span>
              <input v-model.trim="budgetNameInput" type="text" required maxlength="100" class="field" placeholder="Ej. Viaje de verano" />
            </label>
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Tipo</span>
              <select v-model="budgetKindInput" :disabled="!!editingOperatingBudget" class="field disabled:opacity-60">
                <option value="monthly">Mensual</option>
                <option value="event">Evento o proyecto</option>
              </select>
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Moneda del límite</span>
              <select v-model="budgetCapCurrencyInput" required :disabled="!!editingOperatingBudget" class="field font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <option v-for="option in currencyOptionsWith(editingOperatingBudget?.budget.capCurrency)" :key="option.code" :value="option.code">{{ option.label }}</option>
              </select>
              <span v-if="editingOperatingBudget" class="block text-[10px] text-text-muted">La moneda guardada {{ editingOperatingBudget.budget.capCurrency }} es fija; no se relabelan límites existentes.</span>
            </label>
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Límite total (opcional)</span>
              <input v-model="budgetTotalLimitInput" type="number" inputmode="decimal" min="0" step="any" class="field" placeholder="Sin límite total" />
            </label>
          </div>

          <div v-if="budgetKindInput === 'event'" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Inicio de referencia (opcional)</span>
              <input v-model="budgetStartDateInput" type="date" class="field" />
            </label>
            <label class="space-y-1.5">
              <span class="block text-xs font-semibold text-text-secondary">Fin de referencia (opcional)</span>
              <input v-model="budgetEndDateInput" type="date" class="field" />
            </label>
          </div>

          <div class="space-y-2 rounded-xl bg-slate-950/40 border border-white/5 p-3" data-testid="budget-linked-accounts">
            <div>
              <h4 class="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                <LinkIcon class="w-3.5 h-3.5 text-accent-emerald" />
                Cuentas ligadas (opcional)
              </h4>
              <p class="text-[10px] text-text-muted mt-1">Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada. Todos los movimientos de estas cuentas pertenecen a este presupuesto y no se pueden pasar a otro.</p>
            </div>
            <p v-if="accountsStore.accounts.length === 0" class="text-[11px] text-text-muted">Todavía no tienes cuentas.</p>
            <div v-else class="flex flex-wrap gap-2">
              <button
                v-for="acc in accountsStore.accounts"
                :key="acc.id"
                type="button"
                :aria-pressed="budgetLinkedAccountIds.includes(acc.id)"
                :class="['tap inline-flex items-center gap-1.5 px-3 rounded-full border text-xs font-medium transition-all cursor-pointer max-w-full', budgetLinkedAccountIds.includes(acc.id) ? 'border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald' : 'border-border text-text-secondary hover:text-text-primary hover:bg-white/5']"
                @click="toggleBudgetLinkedAccount(acc.id)"
              >
                <CheckIcon v-if="budgetLinkedAccountIds.includes(acc.id)" class="w-3.5 h-3.5 shrink-0" />
                <span class="truncate">{{ getAccountDisplayLabel(acc, accountsStore.accounts) }}</span>
              </button>
            </div>
            <p v-for="conflict in budgetLinkConflicts" :key="conflict.accountId" role="status" class="text-[10px] text-accent-amber">
              «{{ accountName(conflict.accountId) }}» está ligada a «{{ conflict.budgetName }}». Al guardar pasará a este presupuesto.
            </p>
          </div>

          <div class="space-y-2 rounded-xl bg-slate-950/40 border border-white/5 p-3">
            <div>
              <h4 class="text-xs font-semibold text-text-primary">Límites por categoría · {{ budgetCapCurrencyInput || 'moneda seleccionada' }}</h4>
              <p class="text-[10px] text-text-muted mt-1">Agrega sólo las categorías que quieres limitar. Quitar una elimina sólo ese límite; el presupuesto base y sus categoryBudgets no cambian.</p>
            </div>
            <p v-if="budgetSelectedCategoryIds.length === 0" class="text-[11px] text-text-muted">Todavía no hay límites por categoría.</p>
            <div v-for="categoryId in budgetSelectedCategoryIds" :key="categoryId" class="flex items-center gap-2 border-t border-white/5 pt-2.5">
              <span
                class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                :style="{ backgroundColor: categoryColor(categoryId) + '20', color: categoryColor(categoryId) }"
              >
                <component :is="getCategoryIcon(categoryIcon(categoryId))" class="w-3.5 h-3.5" />
              </span>
              <label :for="`budget-cap-${categoryId}`" class="min-w-0 flex-1 text-xs font-medium text-text-secondary truncate">{{ categoryName(categoryId) }}</label>
              <input :id="`budget-cap-${categoryId}`" :value="budgetCategoryCapInputs[categoryId] ?? ''" type="number" inputmode="decimal" min="0" step="any" class="field w-32 sm:w-40 shrink-0 text-right tabular-nums" placeholder="Sin límite" @change="(event) => updateBudgetCategoryCapInput(categoryId, (event.target as HTMLInputElement).value)" />
              <button
                type="button"
                class="tap shrink-0 flex items-center justify-center rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer"
                :aria-label="`Quitar ${categoryName(categoryId)}`"
                @click="removeBudgetCategory(categoryId)"
              >
                <XIcon class="w-4 h-4" />
              </button>
            </div>
            <CategoryPicker
              :categories="expenseCategories"
              :selected-ids="budgetSelectedCategoryIds"
              :suggestions="budgetSuggestedCategories"
              @select="addBudgetCategory"
            />
          </div>

          <p v-if="budgetManagementError" role="alert" class="text-xs text-accent-rose">{{ budgetManagementError }}</p>
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="showBudgetModal = false" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all cursor-pointer">
              Cancelar
            </button>
            <button type="submit" form="operating-budget-form" :disabled="savingOperatingBudget" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50">
              {{ savingOperatingBudget ? 'Guardando…' : editingOperatingBudget ? 'Guardar cambios' : 'Crear presupuesto' }}
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Sheet: Create Savings Goal -->
    <BaseSheet :open="showCreateModal" title="Nuevo Objetivo de Ahorro" :close-on-backdrop="false" @close="showCreateModal = false">
        <form id="create-goal-form" @submit.prevent="handleCreateGoal" class="space-y-4">
          <!-- Goal Name -->
          <div class="space-y-1.5">
            <label for="goal-name" class="block text-xs font-semibold text-text-secondary">Nombre de la Meta</label>
            <input 
              id="goal-name"
              v-model="newGoalName"
              type="text"
              required
              class="field"
              placeholder="Ej. Comprar un carro nuevo 🚗"
            />
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <!-- Target Amount -->
            <div class="space-y-1.5">
              <label for="goal-target" class="block text-xs font-semibold text-text-secondary">Monto Objetivo</label>
              <input 
                id="goal-target"
                v-model.number="newGoalTargetAmount"
                type="number"
                inputmode="decimal"
                required
                min="1"
                class="field font-semibold"
                placeholder="Monto total"
              />
            </div>

            <!-- Currency -->
            <div class="space-y-1.5">
              <label for="goal-currency" class="block text-xs font-semibold text-text-secondary">Moneda</label>
              <select 
                id="goal-currency"
                v-model="newGoalCurrency"
                class="field font-semibold cursor-pointer"
              >
                <option value="USD">USD ($)</option>
                <option value="COP">COP ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <!-- Current Amount (Optional) -->
            <div class="space-y-1.5">
              <label for="goal-current" class="block text-xs font-semibold text-text-secondary">Monto Inicial (Opcional)</label>
              <input 
                id="goal-current"
                v-model.number="newGoalCurrentAmount"
                type="number"
                inputmode="decimal"
                min="0"
                class="field"
                placeholder="Ya ahorrado"
              />
            </div>

            <!-- Target Date -->
            <div class="space-y-1.5">
              <label for="goal-date" class="block text-xs font-semibold text-text-secondary">Fecha Límite</label>
              <input 
                id="goal-date"
                v-model="newGoalTargetDate"
                type="date"
                required
                class="field cursor-pointer"
              />
            </div>
          </div>
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="showCreateModal = false" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all cursor-pointer">
              Cancelar
            </button>
            <button type="submit" form="create-goal-form" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer">
              Crear Meta
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Sheet: Contribute funds -->
    <BaseSheet :open="showContributeModal" :title="`Aportar a: ${selectedGoal?.name ?? ''}`" :close-on-backdrop="false" @close="showContributeModal = false">
        <form id="contribute-goal-form" @submit.prevent="handleContribute" class="space-y-4">
          <!-- Selected Account -->
          <div class="space-y-1.5">
            <label for="contribute-account" class="block text-xs font-semibold text-text-secondary">Deducir de la Cuenta</label>
            <select 
              id="contribute-account"
              v-model="contributeAccountId"
              required
              class="field font-semibold cursor-pointer"
            >
              <option value="" disabled>Selecciona una cuenta</option>
              <option 
                v-for="acc in accountsStore.accounts" 
                :key="acc.id" 
                :value="acc.id"
              >
                {{ getAccountDisplayLabel(acc, accountsStore.accounts) }} (Saldo disponible: {{ formatCurrency(acc.balance, acc.currency) }})
              </option>
            </select>
          </div>

          <!-- Budget the contribution counts against (inherited from a linked account) -->
          <div v-if="showContributeBudget" class="space-y-1.5 animate-fade-in" data-testid="contribute-budget">
            <label for="contribute-budget" class="block text-xs font-semibold text-text-secondary">Presupuesto</label>
            <select id="contribute-budget" v-model="contributeBudgetId" class="field cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed" :disabled="!!contributeLinkedBudget" @change="contributeBudgetTouched = true">
              <option :value="DEFAULT_MONTHLY_BUDGET_ID">Presupuesto mensual predeterminado</option>
              <option v-for="budget in activeOperatingBudgets" :key="budget.budget.id" :value="budget.budget.id">{{ budget.budget.name }}</option>
            </select>
            <p v-if="contributeLinkedBudget" class="flex items-start gap-1 text-[11px] text-accent-emerald">
              <LinkIcon class="w-3 h-3 mt-0.5 shrink-0" />
              <span>Esta cuenta está ligada a «{{ contributeLinkedBudget.name }}»: todos sus movimientos van a ese presupuesto.</span>
            </p>
          </div>

          <!-- Contribute Amount -->
          <div class="space-y-1.5">
            <label for="contribute-amount" class="block text-xs font-semibold text-text-secondary">Monto a Aportar</label>
            <div class="relative">
              <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted font-semibold pointer-events-none">
                {{ selectedGoal ? (selectedGoal.currency === 'COP' ? '$' : selectedGoal.currency) : '$' }}
              </span>
              <input 
                id="contribute-amount"
                v-model.number="contributeAmount"
                type="number"
                inputmode="decimal"
                required
                min="1"
                :class="['field font-semibold', selectedGoal && selectedGoal.currency !== 'COP' ? 'pl-14' : 'pl-8']"
                placeholder="0"
              />
            </div>
            <p class="text-[11px] text-text-muted mt-1">Este aporte se registrará automáticamente como un movimiento en tus transacciones.</p>
          </div>
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="showContributeModal = false" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all cursor-pointer">
              Cancelar
            </button>
            <button type="submit" form="contribute-goal-form" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer">
              Realizar Aporte
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Move existing default-budget movements into an event budget -->
    <BaseSheet :open="!!moveSheetBudget" :title="'Mover movimientos'" :close-on-backdrop="!movingMovements" @close="closeMoveSheet">
      <div class="space-y-3" data-testid="budget-move-sheet">
        <p class="text-[11px] text-text-muted">
          Elige qué movimientos pasan a <strong class="text-text-primary">«{{ moveSheetBudget?.name }}»</strong>. Están en el presupuesto mensual predeterminado y salen de una cuenta ligada o son de una categoría con tope<span v-if="moveSheetBudget?.startDate || moveSheetBudget?.endDate">, dentro del periodo del presupuesto</span>. Desmarca los que no quieras mover.
        </p>
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-text-secondary tabular-nums">{{ moveSelectedIds.size }} de {{ moveSheetCandidates.length }} seleccionados</span>
          <button type="button" class="tap px-2 text-accent-emerald font-semibold cursor-pointer" :disabled="movingMovements" @click="toggleAllMoveCandidates">
            {{ moveSelectedIds.size === moveSheetCandidates.length ? 'Desmarcar todos' : 'Marcar todos' }}
          </button>
        </div>
        <ul class="divide-y divide-white/5 rounded-xl border border-border/60 bg-slate-950/40">
          <li v-for="tx in moveSheetCandidates" :key="tx.id">
            <label class="flex items-center gap-3 px-3 py-2.5 min-h-11 cursor-pointer">
              <input
                type="checkbox"
                class="w-4 h-4 shrink-0 accent-emerald-500"
                :checked="moveSelectedIds.has(tx.id)"
                :disabled="movingMovements"
                @change="toggleMoveCandidate(tx.id)"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-text-primary">{{ tx.description || 'Sin descripción' }}</span>
                <span class="block truncate text-[10px] text-text-muted">{{ formatDate(tx.date) }} · {{ accountName(tx.accountId) }}</span>
              </span>
              <span class="shrink-0 text-sm font-semibold tabular-nums" :class="tx.type === 'income' ? 'text-accent-emerald' : 'text-text-primary'">
                {{ tx.type === 'income' ? '+' : '−' }}{{ formatCurrency(Math.abs(tx.amount), tx.currency) }}
              </span>
            </label>
          </li>
        </ul>
        <p v-if="movingMovements" role="status" class="text-[11px] text-text-secondary tabular-nums">Moviendo {{ moveProgress }} de {{ moveTotal }}…</p>
        <p v-if="moveError" role="alert" class="text-[11px] text-accent-rose">{{ moveError }}</p>
      </div>

      <template #footer>
        <div class="flex gap-3">
          <button type="button" :disabled="movingMovements" @click="closeMoveSheet" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all cursor-pointer disabled:opacity-50">
            Ahora no
          </button>
          <button type="button" data-testid="budget-move-apply" :disabled="movingMovements || moveSelectedIds.size === 0" @click="applyMoveSelection" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            Mover {{ movementCountLabel(moveSelectedIds.size) }}
          </button>
        </div>
      </template>
    </BaseSheet>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch, nextTick } from 'vue'
import { useGoalsStore } from '@/stores/goalsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SUPPORTED_CURRENCIES, currencyOptionsWith, defaultCurrencyCode } from '@/lib/currencies'
import type { Goal, OperatingBudgetDraft, OperatingBudgetPatch } from '@/types'
import BaseSheet from '@/components/ui/BaseSheet.vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import { suggestCategoriesBySpending, visibleBaselineCategories } from '@/lib/categoryPicker'
import { getCategoryIconComponent } from '@/lib/categoryIcons'
import { DEFAULT_MONTHLY_BUDGET_ID, budgetIdForAccount, budgetMoveCandidates, canAssignBudget, linkedAccountConflicts, linkedBudgetForAccount, resolveBudgetId, selfFundedBudgetIds } from '@/lib/budgets'
import { reportBudgetScope } from '@/lib/budgetReporting'
import type { BudgetWorkspaceBudgetSnapshot } from '@/lib/budgetWorkspaceAdapter'
import { createCardBillingLookup, expenseAmountForDate } from '@/lib/installments'
import { parseDateOnly, toDateValue, toLocalDateKey } from '@/lib/dates'
import { getAccountDisplayLabel, isPocketRelatedAccount } from '@/lib/pockets'
import {
  Target as TargetIcon,
  PiggyBank as PiggyBankIcon,
  Trash2 as TrashIcon,
  Plus as PlusIcon,
  Wallet as WalletIcon,
  X as XIcon,
  Link2 as LinkIcon,
  Check as CheckIcon,
  ArrowRightLeft as MoveIcon
} from 'lucide-vue-next'
import { Chart, registerables } from 'chart.js'

Chart.register(...registerables)

const goalsStore = useGoalsStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const settingsStore = useSettingsStore()

// State
const showCreateModal = ref(false)
const showContributeModal = ref(false)
const showBudgetModal = ref(false)
const selectedGoal = ref<Goal | null>(null)
const editingOperatingBudget = ref<BudgetWorkspaceBudgetSnapshot | null>(null)
const budgetNameInput = ref('')
const budgetKindInput = ref<'monthly' | 'event'>('monthly')
const budgetCapCurrencyInput = ref('')
const budgetTotalLimitInput = ref<string | number>('')
const budgetStartDateInput = ref('')
const budgetEndDateInput = ref('')
const budgetCategoryCapInputs = reactive<Record<string, number | undefined>>({})
// Categories shown in the sheet, in the order the user added them.
const budgetSelectedCategoryIds = ref<string[]>([])
const baselineAddedCategoryIds = ref<string[]>([])
const budgetManagementError = ref('')
const savingOperatingBudget = ref(false)
const budgetLinkedAccountIds = ref<string[]>([])
const linkableOperatingBudgets = computed(() => goalsStore.operatingBudgets.map(({ budget }) => budget))
const budgetLinkConflicts = computed(() => linkedAccountConflicts(
  linkableOperatingBudgets.value,
  budgetLinkedAccountIds.value,
  editingOperatingBudget.value?.budget.id
))
const accountName = (accountId: string): string => {
  const account = accountsStore.getAccountById(accountId)
  return account ? getAccountDisplayLabel(account, accountsStore.accounts) : 'Cuenta eliminada'
}
const toggleBudgetLinkedAccount = (accountId: string) => {
  budgetLinkedAccountIds.value = budgetLinkedAccountIds.value.includes(accountId)
    ? budgetLinkedAccountIds.value.filter(id => id !== accountId)
    : [...budgetLinkedAccountIds.value, accountId]
}
const legacyCategoryBudgetCurrencyInput = ref(defaultCurrencyCode(settingsStore.currency))
const confirmingLegacyCurrency = ref(false)
const legacyCurrencyError = ref('')

// Create Goal inputs
const newGoalName = ref('')
const newGoalTargetAmount = ref<number | null>(null)
const newGoalCurrentAmount = ref(0)
const newGoalCurrency = ref('USD')
const newGoalTargetDate = ref('')

// Contribute inputs
const contributeAccountId = ref('')
const contributeAmount = ref<number | null>(null)
const contributeBudgetId = ref(DEFAULT_MONTHLY_BUDGET_ID)
const contributeBudgetTouched = ref(false)
// Bridge-account expenses are replicated into the mirror workspace, which has its own budgets.
const showContributeBudget = computed(() =>
  !!contributeAccountId.value && !accountsStore.getAccountById(contributeAccountId.value)?.mirror)
// Every movement of a linked account belongs to its budget, so the selector is locked.
const contributeLinkedBudget = computed(() =>
  linkedBudgetForAccount(linkableOperatingBudgets.value, contributeAccountId.value))
watch(contributeAccountId, (accountId, previousAccountId) => {
  const leftLinkedAccount = linkedBudgetForAccount(linkableOperatingBudgets.value, previousAccountId ?? '')
  if (contributeBudgetTouched.value && !contributeLinkedBudget.value && !leftLinkedAccount) return
  contributeBudgetTouched.value = false
  contributeBudgetId.value = budgetIdForAccount(linkableOperatingBudgets.value, accountId)
})

// Budget Planner inputs
const incomeInput = ref(0)
const needsPercent = ref(50)
const wantsPercent = ref(30)
const savingsPercent = ref(20)

// Category budgets: copia local editable de goalsStore.categoryBudgets
const categoryBudgetInputs = reactive<Record<string, number | null>>({})

// Chart reference
const budgetChartRef = ref<HTMLCanvasElement | null>(null)
let budgetChart: Chart | null = null

// Computed
const userCurrency = computed(() => settingsStore.currency || 'COP')

// Categorías de gasto para presupuestos
const expenseCategories = computed(() =>
  transactionsStore.categories.filter(c => c.type === 'expense' || c.type === 'both')
)

const activeOperatingBudgets = computed(() =>
  goalsStore.operatingBudgets.filter(entry => !entry.budget.archived)
)
// Card view of each active budget: spending vs its funds (assigned income) and vs its total cap.
const budgetCards = computed(() => {
  const now = new Date()
  return new Map(activeOperatingBudgets.value.map(entry => {
    const report = reportBudgetScope({
      scope: {
        id: entry.budget.id,
        kind: entry.budget.kind,
        capCurrency: entry.budget.capCurrency,
        totalLimit: entry.budget.totalLimit
      },
      categoryCaps: entry.categoryCaps,
      transactions: transactionsStore.transactions,
      period: { year: now.getFullYear(), month: now.getMonth() },
      reportingCurrency: userCurrency.value,
      exchangeRates: goalsStore.exchangeRates,
      cardBilling: cardBillingFor.value
    })
    const spending = entry.budget.kind === 'event' ? report.eventCommittedPrincipal : report.monthlyAllocation
    const spent = spending?.amount ?? null
    const fundsAmount = report.funds?.amount ?? null
    const limitAmount = report.totalComparison?.limitAmount ?? null
    return [entry.budget.id, {
      currency: report.reportingCurrency,
      spent,
      funds: report.funds,
      fundsAmount,
      available: report.available,
      fundsPercent: spent !== null && fundsAmount !== null ? percentOf(spent, fundsAmount) : null,
      limitAmount,
      limitPercent: spent !== null && limitAmount !== null ? percentOf(spent, limitAmount) : 0
    }] as const
  }))
})
const percentOf = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : part > 0 ? 100 : 0
const progressTone = (percent: number): string =>
  percent >= 100 ? 'bg-accent-rose' : percent >= 80 ? 'bg-accent-amber' : 'bg-accent-emerald'
const archivedOperatingBudgets = computed(() =>
  goalsStore.operatingBudgets.filter(entry => entry.budget.archived)
)
const budgetSuggestedCategories = computed(() => suggestCategoriesBySpending({
  categories: expenseCategories.value,
  transactions: transactionsStore.transactions,
  now: new Date(),
  excludeIds: budgetSelectedCategoryIds.value,
  amountOf: tx => goalsStore.convertToPrimary(Math.abs(tx.amount), tx.currency, userCurrency.value)
}))
// Billed card installments count in the month their statement is paid.
const cardBillingFor = computed(() => createCardBillingLookup(accountsStore.accounts))

const baselineBudgetReport = computed(() => {
  const now = new Date()
  return reportBudgetScope({
    scope: {
      id: DEFAULT_MONTHLY_BUDGET_ID,
      kind: 'monthly',
      capCurrency: goalsStore.categoryBudgetCurrency.status === 'confirmed'
        ? goalsStore.categoryBudgetCurrency.code
        : null
    },
    categoryCaps: goalsStore.categoryBudgets,
    transactions: transactionsStore.transactions,
    period: { year: now.getFullYear(), month: now.getMonth() },
    reportingCurrency: userCurrency.value,
    exchangeRates: goalsStore.exchangeRates,
    cardBilling: cardBillingFor.value
  })
})

// Gasto/ingreso/ahorro real del mes (monedas convertidas a la principal)
const realMonthTotals = computed(() => {
  const now = new Date()
  let income = 0, expense = 0
  const selfFunded = selfFundedBudgetIds(transactionsStore.transactions)
  transactionsStore.transactions.forEach(t => {
    if (t.type === 'income') {
      // Income assigned to another budget funds only that budget, so it is not monthly income.
      if (resolveBudgetId(t.budgetId) !== DEFAULT_MONTHLY_BUDGET_ID) return
      if (t.date.getMonth() !== now.getMonth() || t.date.getFullYear() !== now.getFullYear()) return
      income += goalsStore.convertToPrimary(Math.abs(t.amount), t.currency, userCurrency.value)
    } else if (t.type === 'expense') {
      // Spending of a budget with its own income is paid by that income, not by the month's.
      if (selfFunded.has(resolveBudgetId(t.budgetId))) return
      const amount = expenseAmountForDate(t, now, cardBillingFor.value(t.accountId))
      expense += goalsStore.convertToPrimary(amount, t.currency, userCurrency.value)
    }
  })
  return { income, expense }
})
const realMonthExpense = computed(() => realMonthTotals.value.expense)
const realMonthSavings = computed(() => Math.max(realMonthTotals.value.income - realMonthTotals.value.expense, 0))

const monthlyNeedsAmount = computed(() => (incomeInput.value * needsPercent.value) / 100)
const monthlyWantsAmount = computed(() => (incomeInput.value * wantsPercent.value) / 100)
const monthlySavingsAmount = computed(() => (incomeInput.value * savingsPercent.value) / 100)

const isPercentSumValid = computed(() => {
  return (needsPercent.value + wantsPercent.value + savingsPercent.value) === 100
})

onMounted(async () => {
  await goalsStore.fetchGoals()
  await goalsStore.loadBudgetSettings()
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await transactionsStore.fetchTransactions()

  // Sincronizar inputs locales con store
  incomeInput.value = goalsStore.budgetIncome
  needsPercent.value = goalsStore.budgetNeedsPercent
  wantsPercent.value = goalsStore.budgetWantsPercent
  savingsPercent.value = goalsStore.budgetSavingsPercent
  Object.assign(categoryBudgetInputs, goalsStore.categoryBudgets)

  renderBudgetChart()
})

// Listen to percent changes to rerender chart
watch([needsPercent, wantsPercent, savingsPercent], () => {
  renderBudgetChart()
})

// Methods
const formatDate = (date: any) => {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' })
}

const formatCurrency = (val: number, currency: string) => {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(val)
}

// Compact form for tight spots (donut centre), e.g. "1,2 M US$".
const formatCompactCurrency = (val: number, currency: string) => {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: currency || 'USD',
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(val)
}

const baselineCategoryReport = (categoryId: string) =>
  Object.hasOwn(baselineBudgetReport.value.categories, categoryId)
    ? baselineBudgetReport.value.categories[categoryId]
    : undefined
const baselineCategoryAmount = (categoryId: string): number =>
  baselineCategoryReport(categoryId)?.monthlyAllocation.amount ?? 0
// Spending this month, including amounts that cannot be converted yet for lack of a rate.
const baselineHasSpending = (categoryId: string): boolean => {
  const report = baselineCategoryReport(categoryId)
  return report?.monthlyAllocation.complete === false || baselineCategoryAmount(categoryId) > 0
}
// Only categories in use: a limit, spending this month, or just added from the picker.
const baselineCategories = computed(() => visibleBaselineCategories({
  categories: expenseCategories.value,
  limits: categoryBudgetInputs,
  hasSpending: baselineHasSpending,
  addedIds: baselineAddedCategoryIds.value
}))
const baselineCategoryIds = computed(() => baselineCategories.value.map(category => category.id))
const baselineSuggestedCategories = computed(() => suggestCategoriesBySpending({
  categories: expenseCategories.value,
  transactions: transactionsStore.transactions,
  now: new Date(),
  excludeIds: baselineCategoryIds.value,
  amountOf: tx => goalsStore.convertToPrimary(Math.abs(tx.amount), tx.currency, userCurrency.value)
}))
const findExpenseCategory = (categoryId: string) =>
  expenseCategories.value.find(category => category.id === categoryId)
const categoryName = (categoryId: string) => findExpenseCategory(categoryId)?.name ?? categoryId
const categoryIcon = (categoryId: string) => findExpenseCategory(categoryId)?.icon ?? 'HelpCircle'
const categoryColor = (categoryId: string) => findExpenseCategory(categoryId)?.color ?? '#94a3b8'
const budgetCategoryCapEntries = (entry: BudgetWorkspaceBudgetSnapshot): Array<{ categoryId: string; amount: number }> =>
  Object.entries(entry.categoryCaps)
    .map(([categoryId, amount]) => ({ categoryId, amount }))
    .sort((left, right) => left.categoryId.localeCompare(right.categoryId))
// Default-budget movements an active event budget can take over (S3).
const budgetMoveCandidatesById = computed(() => {
  const candidates = new Map<string, Array<(typeof transactionsStore.transactions)[number]>>()
  for (const entry of goalsStore.operatingBudgets) {
    const budget = entry.budget
    if (budget.kind !== 'event' || budget.archived) continue
    candidates.set(budget.id, budgetMoveCandidates(transactionsStore.transactions, {
      linkedAccountIds: budget.linkedAccountIds ?? [],
      categoryIds: Object.keys(entry.categoryCaps),
      startDate: budget.startDate,
      endDate: budget.endDate
    }).filter(transaction =>
      // Mirror-account expenses are replicated elsewhere, and a movement of another budget's linked account stays there.
      !(transaction.type === 'expense' && accountsStore.getAccountById(transaction.accountId)?.mirror)
      && canAssignBudget(linkableOperatingBudgets.value, transaction.accountId, budget.id)))
  }
  return candidates
})
const movementCountLabel = (count: number) => `${count} ${count === 1 ? 'movimiento' : 'movimientos'}`

const moveSheetBudgetId = ref('')
const moveSelectedIds = ref(new Set<string>())
const movingMovements = ref(false)
const moveProgress = ref(0)
const moveTotal = ref(0)
const moveError = ref('')
const moveSheetBudget = computed(() =>
  goalsStore.operatingBudgets.find(entry => entry.budget.id === moveSheetBudgetId.value)?.budget ?? null)
const moveSheetCandidates = computed(() => budgetMoveCandidatesById.value.get(moveSheetBudgetId.value) ?? [])

const openMoveSheet = (budgetId: string) => {
  const candidates = budgetMoveCandidatesById.value.get(budgetId) ?? []
  if (!candidates.length) return
  moveSheetBudgetId.value = budgetId
  moveSelectedIds.value = new Set(candidates.map(transaction => transaction.id))
  moveError.value = ''
}
const closeMoveSheet = () => {
  if (movingMovements.value) return
  moveSheetBudgetId.value = ''
  moveSelectedIds.value = new Set()
  moveError.value = ''
}
const toggleMoveCandidate = (transactionId: string) => {
  const next = new Set(moveSelectedIds.value)
  if (next.has(transactionId)) next.delete(transactionId)
  else next.add(transactionId)
  moveSelectedIds.value = next
}
const toggleAllMoveCandidates = () => {
  moveSelectedIds.value = moveSelectedIds.value.size === moveSheetCandidates.value.length
    ? new Set()
    : new Set(moveSheetCandidates.value.map(transaction => transaction.id))
}

// Budget-only updates through the same assigner as a single reassignment, a few at a time.
const MOVE_BATCH_SIZE = 10
const applyMoveSelection = async () => {
  const budgetId = moveSheetBudgetId.value
  const ids = [...moveSelectedIds.value]
  if (!budgetId || !ids.length || movingMovements.value) return
  movingMovements.value = true
  moveError.value = ''
  moveProgress.value = 0
  moveTotal.value = ids.length
  const failed: string[] = []
  try {
    for (let index = 0; index < ids.length; index += MOVE_BATCH_SIZE) {
      const batch = ids.slice(index, index + MOVE_BATCH_SIZE)
      const results = await Promise.allSettled(batch.map(id => transactionsStore.assignExpenseBudget(id, budgetId)))
      results.forEach((result, position) => { if (result.status === 'rejected') failed.push(batch[position]) })
      moveProgress.value = Math.min(index + batch.length, ids.length)
    }
  } finally {
    movingMovements.value = false
  }
  if (failed.length) {
    moveSelectedIds.value = new Set(failed)
    moveError.value = `Se movieron ${ids.length - failed.length} de ${ids.length}. Los que quedaron marcados no se pudieron mover; inténtalo de nuevo.`
    return
  }
  closeMoveSheet()
}

const isValidCurrencyCode = (value: string): boolean => /^[A-Z]{3}$/.test(value.trim())

const dateInputValue = (value?: Date): string => value ? toLocalDateKey(toDateValue(value)) : ''

const openBudgetModal = (entry?: BudgetWorkspaceBudgetSnapshot) => {
  editingOperatingBudget.value = entry ?? null
  budgetNameInput.value = entry?.budget.name ?? ''
  budgetKindInput.value = entry?.budget.kind ?? 'monthly'
  budgetCapCurrencyInput.value = entry?.budget.capCurrency ?? defaultCurrencyCode(settingsStore.currency)
  budgetTotalLimitInput.value = entry?.budget.totalLimit === undefined ? '' : String(entry.budget.totalLimit)
  budgetStartDateInput.value = dateInputValue(entry?.budget.startDate)
  budgetEndDateInput.value = dateInputValue(entry?.budget.endDate)
  budgetManagementError.value = ''
  budgetLinkedAccountIds.value = [...(entry?.budget.linkedAccountIds ?? [])]
  for (const key of Object.keys(budgetCategoryCapInputs)) delete budgetCategoryCapInputs[key]
  if (entry) Object.assign(budgetCategoryCapInputs, entry.categoryCaps)
  budgetSelectedCategoryIds.value = Object.keys(entry?.categoryCaps ?? {})
    .sort((left, right) => categoryName(left).localeCompare(categoryName(right)))
  showBudgetModal.value = true
}

const focusField = async (id: string) => {
  await nextTick()
  document.getElementById(id)?.focus()
}

const addBudgetCategory = (categoryId: string) => {
  if (!budgetSelectedCategoryIds.value.includes(categoryId)) {
    budgetSelectedCategoryIds.value = [...budgetSelectedCategoryIds.value, categoryId]
  }
  void focusField(`budget-cap-${categoryId}`)
}

const removeBudgetCategory = (categoryId: string) => {
  budgetSelectedCategoryIds.value = budgetSelectedCategoryIds.value.filter(id => id !== categoryId)
  delete budgetCategoryCapInputs[categoryId]
}

const addBaselineCategory = (categoryId: string) => {
  if (!baselineAddedCategoryIds.value.includes(categoryId)) {
    baselineAddedCategoryIds.value = [...baselineAddedCategoryIds.value, categoryId]
  }
  void focusField(`base-cap-${categoryId}`)
}

const removeBaselineCategory = (categoryId: string) => {
  baselineAddedCategoryIds.value = baselineAddedCategoryIds.value.filter(id => id !== categoryId)
  if (categoryBudgetInputs[categoryId]) void saveCategoryBudget(categoryId, '')
}

const updateBudgetCategoryCapInput = (categoryId: string, rawValue: string) => {
  budgetManagementError.value = ''
  if (rawValue.trim() === '') {
    delete budgetCategoryCapInputs[categoryId]
    return
  }
  const amount = Number(rawValue)
  if (!Number.isFinite(amount) || amount < 0) {
    budgetManagementError.value = 'Cada límite por categoría debe ser un número finito no negativo.'
    return
  }
  budgetCategoryCapInputs[categoryId] = amount
}

const categoryCapDraft = (): Record<string, number> => {
  const result: Record<string, number> = {}
  for (const [categoryId, amount] of Object.entries(budgetCategoryCapInputs)) {
    if (amount !== undefined) Object.defineProperty(result, categoryId, {
      value: amount, enumerable: true, configurable: true, writable: true
    })
  }
  return result
}

const handleSaveOperatingBudget = async () => {
  budgetManagementError.value = ''
  const name = budgetNameInput.value.trim()
  const capCurrency = budgetCapCurrencyInput.value.trim().toUpperCase()
  const rawTotalLimit = String(budgetTotalLimitInput.value ?? '').trim()
  const totalLimit = rawTotalLimit === '' ? undefined : Number(rawTotalLimit)
  if (!name) {
    budgetManagementError.value = 'Escribe un nombre para el presupuesto.'
    return
  }
  if (!isValidCurrencyCode(capCurrency)) {
    budgetManagementError.value = 'Indica un código de moneda válido de tres letras.'
    return
  }
  if (totalLimit !== undefined && (!Number.isFinite(totalLimit) || totalLimit < 0)) {
    budgetManagementError.value = 'El límite total debe ser un número finito no negativo.'
    return
  }
  if (budgetStartDateInput.value && budgetEndDateInput.value && budgetEndDateInput.value < budgetStartDateInput.value) {
    budgetManagementError.value = 'La fecha final no puede preceder a la fecha inicial.'
    return
  }

  const toDate = (value: string): Date | undefined => value ? new Date(`${value}T00:00:00`) : undefined
  const caps = categoryCapDraft()
  // Accounts that move here leave their previous budget once this one is saved.
  const movedLinks = budgetLinkConflicts.value
  const linkedAccountIds = [...budgetLinkedAccountIds.value]
  savingOperatingBudget.value = true
  try {
    let budgetId: string
    if (editingOperatingBudget.value) {
      const existing = editingOperatingBudget.value.budget
      const patch: OperatingBudgetPatch = {
        name,
        totalLimit: totalLimit ?? null,
        linkedAccountIds
      }
      if (existing.kind === 'event') {
        patch.startDate = toDate(budgetStartDateInput.value) ?? null
        patch.endDate = toDate(budgetEndDateInput.value) ?? null
      }
      const updated = await goalsStore.updateOperatingBudget(existing.id, patch)
      budgetId = updated.id
    } else {
      const draft: OperatingBudgetDraft = {
        kind: budgetKindInput.value,
        name,
        capCurrency,
        ...(totalLimit === undefined ? {} : { totalLimit }),
        ...(linkedAccountIds.length ? { linkedAccountIds } : {})
      }
      if (draft.kind === 'event') {
        const startDate = toDate(budgetStartDateInput.value)
        const endDate = toDate(budgetEndDateInput.value)
        if (startDate) draft.startDate = startDate
        if (endDate) draft.endDate = endDate
      }
      const created = await goalsStore.createOperatingBudget(draft)
      budgetId = created.id
      editingOperatingBudget.value = goalsStore.operatingBudgets.find(entry => entry.budget.id === created.id)
        ?? { budget: created, categoryCaps: {} }
    }
    await goalsStore.saveOperatingBudgetCategoryCaps(budgetId, caps)
    for (const ownerId of new Set(movedLinks.map(conflict => conflict.budgetId))) {
      const owner = linkableOperatingBudgets.value.find(budget => budget.id === ownerId)
      if (!owner) continue
      const moved = new Set(movedLinks.filter(conflict => conflict.budgetId === ownerId).map(conflict => conflict.accountId))
      await goalsStore.updateOperatingBudget(ownerId, {
        linkedAccountIds: (owner.linkedAccountIds ?? []).filter(accountId => !moved.has(accountId))
      })
    }
    showBudgetModal.value = false
    // Offer to bring in the movements that already belong here.
    openMoveSheet(budgetId)
  } catch (error) {
    budgetManagementError.value = error instanceof Error ? error.message : 'No se pudo guardar el presupuesto.'
  } finally {
    savingOperatingBudget.value = false
  }
}

const handleArchiveBudget = async (budgetId: string) => {
  if (!confirm('¿Eliminar este presupuesto? Se conservarán sus asignaciones, historial y cuotas pendientes.')) return
  try {
    await goalsStore.archiveOperatingBudget(budgetId)
  } catch (error) {
    goalsStore.budgetSettingsError = error instanceof Error ? error.message : 'No se pudo eliminar el presupuesto.'
  }
}

const confirmLegacyCategoryBudgetCurrency = async () => {
  legacyCurrencyError.value = ''
  const code = legacyCategoryBudgetCurrencyInput.value.trim().toUpperCase()
  if (!isValidCurrencyCode(code)) {
    legacyCurrencyError.value = 'Indica el código real de moneda de tres letras.'
    return
  }
  confirmingLegacyCurrency.value = true
  try {
    await goalsStore.confirmLegacyCategoryBudgetCurrency(code)
  } catch (error) {
    legacyCurrencyError.value = error instanceof Error ? error.message : 'No se pudo confirmar la moneda.'
  } finally {
    confirmingLegacyCurrency.value = false
  }
}

const getProgressPercent = (goal: Goal) => {
  if (!goal.targetAmount) return 0
  return Math.round((goal.currentAmount / goal.targetAmount) * 100)
}

const getDaysRemainingText = (targetDate: any) => {
  const diffTime = new Date(targetDate).getTime() - new Date().getTime()
  if (diffTime <= 0) return 'Cumplido'
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  
  if (diffDays > 30) {
    const months = Math.round(diffDays / 30)
    return `${months} ${months === 1 ? 'mes' : 'meses'} rest.`
  }
  return `${diffDays} ${diffDays === 1 ? 'día' : 'días'} rest.`
}

// Sliders auto-balancing logic
const adjustSliders = (changed: 'needs' | 'wants' | 'savings') => {
  let needs = needsPercent.value
  let wants = wantsPercent.value
  let savings = savingsPercent.value

  const sum = needs + wants + savings
  const diff = sum - 100

  if (diff !== 0) {
    if (changed === 'needs') {
      // Ajustar proporcionalmente los otros dos
      const remainder = 100 - needs
      if (remainder <= 0) {
        wantsPercent.value = 0
        savingsPercent.value = 0
      } else {
        const factor = wants + savings === 0 ? 0.5 : wants / (wants + savings)
        wantsPercent.value = Math.round(remainder * factor)
        savingsPercent.value = 100 - needs - wantsPercent.value
      }
    } else if (changed === 'wants') {
      const remainder = 100 - wants
      if (remainder <= 0) {
        needsPercent.value = 0
        savingsPercent.value = 0
      } else {
        const factor = needs + savings === 0 ? 0.5 : needs / (needs + savings)
        needsPercent.value = Math.round(remainder * factor)
        savingsPercent.value = 100 - wants - needsPercent.value
      }
    } else if (changed === 'savings') {
      const remainder = 100 - savings
      if (remainder <= 0) {
        needsPercent.value = 0
        wantsPercent.value = 0
      } else {
        const factor = needs + wants === 0 ? 0.5 : needs / (needs + wants)
        needsPercent.value = Math.round(remainder * factor)
        wantsPercent.value = 100 - savings - needsPercent.value
      }
    }
  }
}

// Chart.js initialization
const renderBudgetChart = () => {
  if (budgetChart) budgetChart.destroy()
  if (!budgetChartRef.value) return

  const ctx = budgetChartRef.value.getContext('2d')
  if (!ctx) return

  budgetChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Necesidades', 'Deseos', 'Ahorro'],
      datasets: [{
        data: [needsPercent.value, wantsPercent.value, savingsPercent.value],
        backgroundColor: [
          '#10b981', // emerald
          '#8b5cf6', // violet
          '#fbbf24'  // amber
        ],
        borderWidth: 1,
        borderColor: '#080c14'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: (context) => ` ${context.label}: ${context.raw}%`
          }
        }
      },
      cutout: '80%'
    }
  })
}

// Create new Goal
const handleCreateGoal = async () => {
  if (!newGoalName.value || !newGoalTargetAmount.value || !newGoalTargetDate.value) return

  try {
    await goalsStore.addGoal({
      name: newGoalName.value,
      targetAmount: newGoalTargetAmount.value,
      currentAmount: newGoalCurrentAmount.value || 0,
      currency: newGoalCurrency.value,
      targetDate: parseDateOnly(newGoalTargetDate.value)
    })

    showCreateModal.value = false
    // Reset form
    newGoalName.value = ''
    newGoalTargetAmount.value = null
    newGoalCurrentAmount.value = 0
    newGoalCurrency.value = 'USD'
    newGoalTargetDate.value = ''
  } catch (err) {
    alert('Error al crear objetivo de ahorro')
  }
}

// Delete Goal
const handleDeleteGoal = async (id: string) => {
  if (confirm('¿Estás seguro de que deseas eliminar este objetivo?')) {
    try {
      await goalsStore.deleteGoal(id)
    } catch (err) {
      alert('Error al eliminar objetivo de ahorro')
    }
  }
}

// Contribute funds logic
const openContributeModal = (goal: Goal) => {
  selectedGoal.value = goal
  contributeAccountId.value = ''
  contributeAmount.value = null
  contributeBudgetId.value = DEFAULT_MONTHLY_BUDGET_ID
  contributeBudgetTouched.value = false
  showContributeModal.value = true
}

const handleContribute = async () => {
  if (!selectedGoal.value || !contributeAccountId.value || !contributeAmount.value) return

  const amount = Number(contributeAmount.value)
  const goal = selectedGoal.value
  
  // Buscar cuenta seleccionada
  const account = accountsStore.getAccountById(contributeAccountId.value)
  if (!account) return

  if (account.balance < amount) {
    if (isPocketRelatedAccount(account)) {
      alert('El saldo disponible de esta cuenta no alcanza para el aporte. No se registró ningún movimiento.')
      return
    }
    if (!confirm('El saldo de la cuenta es menor que el aporte. ¿Deseas continuar de todos modos?')) {
      return
    }
  }

  try {
    // Categoría para el aporte: 'Ahorro' si existe, si no 'Otros', si no vacío
    const savingsCat = transactionsStore.categories.find(c => c.name.toLowerCase() === 'ahorro')
      || transactionsStore.categories.find(c => c.name === 'Otros')

    // 1. Agregar transacción como Gasto (Aporte a meta)
    // El store de transacciones actualizará el saldo de la cuenta origen automáticamente
    await transactionsStore.addTransaction({
      accountId: contributeAccountId.value,
      amount: -amount, // Negativo para indicar salida de dinero de la cuenta
      description: `Aporte a meta: ${goal.name}`,
      categoryId: savingsCat?.id || '',
      date: new Date(),
      type: 'expense',
      budgetId: showContributeBudget.value ? (contributeLinkedBudget.value?.id ?? contributeBudgetId.value) : null
    })

    // 2. Sumar al saldo acumulado del objetivo de ahorro
    const newCurrentAmount = goal.currentAmount + amount
    await goalsStore.updateGoalAmount(goal.id, newCurrentAmount)

    // Recargar cuentas para reflejar saldos
    await accountsStore.fetchAccounts()

    showContributeModal.value = false
    alert('¡Aporte registrado y descontado exitosamente!')
  } catch (err) {
    console.error(err)
    alert('Error al realizar el aporte de ahorro.')
  }
}

// Save budget
const saveBudget = async () => {
  try {
    await goalsStore.saveBudgetSettings({
      budgetIncome: incomeInput.value,
      budgetNeedsPercent: needsPercent.value,
      budgetWantsPercent: wantsPercent.value,
      budgetSavingsPercent: savingsPercent.value,
      budgetAllocations: goalsStore.budgetAllocations,
      categoryBudgets: goalsStore.categoryBudgets,
      exchangeRates: goalsStore.exchangeRates
    })
  } catch (err) {
    console.error('Error al guardar presupuesto:', err)
  }
}

// Presupuesto por categoría
const saveCategoryBudget = async (categoryId: string, rawValue: string) => {
  if (goalsStore.categoryBudgetCurrency.status !== 'confirmed') {
    legacyCurrencyError.value = 'Confirma primero la moneda real de los límites heredados.'
    return
  }
  const value = rawValue === '' ? null : Math.max(0, Number(rawValue))
  categoryBudgetInputs[categoryId] = value

  const newBudgets = { ...goalsStore.categoryBudgets }
  if (value === null || value === 0) delete newBudgets[categoryId]
  else newBudgets[categoryId] = value

  try {
    await goalsStore.saveBudgetSettings({
      budgetIncome: goalsStore.budgetIncome,
      budgetNeedsPercent: goalsStore.budgetNeedsPercent,
      budgetWantsPercent: goalsStore.budgetWantsPercent,
      budgetSavingsPercent: goalsStore.budgetSavingsPercent,
      budgetAllocations: goalsStore.budgetAllocations,
      categoryBudgets: newBudgets,
      exchangeRates: goalsStore.exchangeRates
    })
  } catch (err) {
    console.error('Error al guardar presupuesto de categoría:', err)
  }
}

const budgetPercent = (categoryId: string) => {
  const comparison = baselineCategoryReport(categoryId)?.comparison
  if (!comparison || comparison.limitAmount <= 0) return 0
  return Math.round((comparison.spentAmount / comparison.limitAmount) * 100)
}

const budgetStatusLabel = (categoryId: string) => {
  const pct = budgetPercent(categoryId)
  if (pct > 100) return ' · ¡Excedido!'
  if (pct === 100) return ' · ¡A tope!'
  return ''
}

const getCategoryIcon = getCategoryIconComponent
</script>
