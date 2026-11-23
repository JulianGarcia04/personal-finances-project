<template>
  <div class="max-w-6xl mx-auto space-y-8 pb-12">
    <div class="space-y-5">
      <nav aria-label="Presupuestos y metas de ahorro" class="grid grid-cols-2 sm:inline-grid gap-1.5 rounded-xl border border-border bg-slate-950/45 p-1.5">
        <RouterLink v-for="section in sections" :key="section.id" :to="section.to" custom v-slot="{ href, navigate }">
          <a
            :href="href"
            @click="navigate"
            :aria-current="activeSection === section ? 'page' : undefined"
            :class="[
              'min-h-11 flex items-center justify-center gap-2 rounded-lg px-2.5 sm:px-4 py-2 text-center text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emerald',
              activeSection === section ? 'bg-accent-emerald/10 text-accent-emerald' : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
            ]"
          >
            <component :is="section.icon" class="hidden min-[375px]:block w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{{ section.label }}</span>
          </a>
        </RouterLink>
      </nav>

      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div class="min-w-0">
          <h2
            :key="activeSection.id"
            ref="sectionHeading"
            tabindex="-1"
            class="scroll-mt-[calc(5rem+env(safe-area-inset-top))] lg:scroll-mt-6 font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-emerald"
          >
            {{ activeSection.label }}
          </h2>
          <p class="text-text-secondary text-sm mt-1">{{ activeSection.description }}</p>
        </div>

        <button
          v-if="isSavingsSection"
          @click="showCreateModal = true"
          class="shrink-0 inline-flex items-center justify-center min-h-11 gap-2 px-5 py-2.5 sm:py-3 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm transition-all shadow-glow-emerald cursor-pointer"
        >
          <PlusIcon class="w-4 h-4 shrink-0" />
          <span>Nuevo Objetivo</span>
        </button>
        <button
          v-else
          @click="openBudgetModal()"
          class="shrink-0 inline-flex items-center justify-center min-h-11 gap-2 px-4 py-2.5 sm:py-3 rounded-xl bg-slate-900 border border-border text-text-primary font-display font-semibold text-sm hover:bg-slate-800 transition-all cursor-pointer"
        >
          <PlusIcon class="w-4 h-4 shrink-0 text-accent-emerald" />
          <span>Nuevo presupuesto</span>
        </button>
      </div>
    </div>

    <div class="grid min-w-0">
      <!-- Savings goal cards -->
      <div v-if="isSavingsSection" class="space-y-6">
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
                  :disabled="hasGoalAccountLink(goal) && getGoalProgressAmount(goal) === null"
                  title="Aportar saldo"
                  aria-label="Aportar saldo"
                  class="tap flex items-center justify-center rounded-xl bg-accent-emerald/10 border border-accent-emerald/20 text-accent-emerald hover:bg-accent-emerald/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
                <span v-if="getProgressPercent(goal) !== null" class="text-accent-emerald">{{ getProgressPercent(goal) }}%</span>
                <span v-else class="text-accent-amber">No disponible</span>
              </div>
              
              <!-- Progress Bar -->
              <div v-if="getProgressPercent(goal) !== null" class="w-full h-2.5 rounded-full bg-slate-950/60 overflow-hidden border border-white/5">
                <div 
                  class="h-full rounded-full bg-gradient-to-r from-accent-emerald to-accent-violet transition-all duration-500"
                  :style="{ width: `${Math.min(getProgressPercent(goal) ?? 0, 100)}%` }"
                ></div>
              </div>

              <!-- Amounts -->
              <div class="grid grid-cols-2 gap-2 text-xs pt-1">
                <div class="min-w-0">
                  <span class="block text-text-muted">Ahorrado</span>
                  <span v-if="getGoalProgressAmount(goal) !== null" class="block text-text-primary font-semibold tabular-nums whitespace-nowrap truncate" :title="formatCurrency(getGoalProgressAmount(goal) ?? 0, goal.currency)">{{ formatCurrency(getGoalProgressAmount(goal) ?? 0, goal.currency) }}</span>
                  <span v-else class="block text-accent-amber text-[11px]" role="status">Cuenta no disponible</span>
                </div>
                <div class="min-w-0 text-right">
                  <span class="block text-text-muted">Objetivo</span>
                  <span class="block text-text-secondary font-semibold tabular-nums whitespace-nowrap truncate" :title="formatCurrency(goal.targetAmount, goal.currency)">{{ formatCurrency(goal.targetAmount, goal.currency) }}</span>
                </div>
              </div>
            </div>

            <!-- Goal Footer info -->
            <div class="text-[11px] text-text-secondary bg-slate-950/30 p-2.5 rounded-lg border border-white/5 flex flex-wrap justify-between gap-x-3 gap-y-1">
              <span v-if="getGoalProgressAmount(goal) !== null" class="tabular-nums">Restante: {{ formatCurrency(Math.max(goal.targetAmount - (getGoalProgressAmount(goal) ?? 0), 0), goal.currency) }}</span>
              <span v-else class="text-accent-amber">La cuenta vinculada no está disponible; no se usa progreso desactualizado.</span>
              <span class="text-accent-violet font-semibold uppercase">{{ getDaysRemainingText(goal.targetDate) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="w-full max-w-lg glass-panel rounded-2xl p-4 sm:p-5 border border-white/5 space-y-2">
        <label for="estimated-monthly-income" class="block font-display font-semibold text-sm text-text-primary">Ingreso mensual estimado</label>
        <div class="flex items-center gap-3">
          <input
            id="estimated-monthly-income"
            v-model.number="incomeInput"
            type="number"
            inputmode="decimal"
            min="0"
            step="any"
            :disabled="!canEditBudgetIncome"
            aria-describedby="estimated-income-currency estimated-income-hint"
            class="field min-w-0 font-semibold disabled:opacity-60"
            @change="saveBudgetIncome"
          />
          <span id="estimated-income-currency" class="shrink-0 text-xs font-semibold text-text-muted">{{ userCurrency }}</span>
        </div>
        <p id="estimated-income-hint" class="text-xs text-text-secondary">
          Las alertas de gasto mensual usan el mayor entre este monto y los ingresos del mes sin presupuesto asignado. Se guarda al salir del campo.
        </p>
        <p v-if="incomeSaveError" role="alert" class="text-xs text-accent-rose">{{ incomeSaveError }}</p>
      </div>
    </div>

    <!-- Additional operating budgets; the protected legacy baseline remains below. -->
    <section v-if="!isSavingsSection" class="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5 space-y-3" data-testid="goals-budget-basis" aria-labelledby="budget-basis-heading">
      <h3 id="budget-basis-heading" class="font-display font-semibold text-sm text-text-primary">Cómo se cuentan los gastos en tus presupuestos</h3>
      <BudgetBasisSwitch />
    </section>

    <section v-if="!isSavingsSection" class="space-y-5" aria-labelledby="additional-budgets-heading">
      <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div class="min-w-0">
          <h3 id="additional-budgets-heading" class="font-display font-bold text-lg sm:text-xl text-text-primary flex items-center gap-2">
            <WalletIcon class="w-5 h-5 shrink-0 text-accent-emerald" />
            <span>Presupuestos adicionales</span>
          </h3>
          <p class="text-xs text-text-muted mt-1 max-w-3xl">
            Se administran separados de las metas, sus asignaciones y los límites base por categoría.
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
                  <p v-if="card.fundsAmount !== null" class="text-[10px] text-text-secondary tabular-nums">
                    Gastado {{ formatCurrency(card.spent, card.currency) }} de {{ formatCurrency(card.fundsAmount, card.currency) }} en fondos{{ card.fundsPercent !== null ? ` · ${card.fundsPercent} %` : '' }}
                  </p>
                  <p v-if="card.overdrawn" class="text-[10px] text-accent-amber">
                    Salió más plata de la que entró a este presupuesto.
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
                <p v-else-if="entry.budget.totalLimit !== undefined" class="text-[11px] text-text-secondary tabular-nums">
                  Límite total: {{ formatCurrency(entry.budget.totalLimit, entry.budget.capCurrency) }} · falta una tasa de cambio para compararlo
                </p>

                <p v-if="card.funds === null" class="text-sm font-semibold text-text-primary tabular-nums">
                  Gastado: {{ formatCurrency(card.spent, card.currency) }}{{ entry.budget.totalLimit === undefined ? ' · Sin límite total' : '' }}
                </p>
                <p v-if="card.funds === null" class="text-[10px] text-text-secondary">
                  ¿Esta plata tiene su propio origen? Registra el ingreso con este presupuesto, o transfiérela a una de sus cuentas ligadas, y verás cuánto te queda disponible.
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
          <p class="text-[10px] text-text-secondary">Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada.</p>
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

    <!-- Recurring monthly category budgets -->
    <div v-if="!isSavingsSection" class="space-y-6">
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
          El gasto se cuenta según la vista «{{ BUDGET_BASIS_LABELS[budgetBasis] }}» elegida arriba.
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
    </div>

    <!-- Sheet: Create or edit an additional operating budget -->
    <BaseSheet :open="!isSavingsSection && showBudgetModal" :title="editingOperatingBudget ? 'Editar presupuesto' : 'Nuevo presupuesto'" :close-on-backdrop="false" @close="showBudgetModal = false">
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
              <p class="text-[10px] text-text-secondary mt-1">Los movimientos entran a este presupuesto cuando se lo asignas o cuando salen de una cuenta ligada. Todos los movimientos de estas cuentas pertenecen a este presupuesto y no se pueden pasar a otro.</p>
            </div>
            <p v-if="linkableAccounts.length === 0" class="text-[11px] text-text-secondary">No tienes cuentas que se puedan ligar. Las tarjetas de crédito, las cuentas con bolsillos y las cuentas puente no se ligan a un presupuesto.</p>
            <div v-else class="flex flex-wrap gap-2">
              <button
                v-for="acc in linkableAccounts"
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
    <BaseSheet :open="isSavingsSection && showCreateModal" title="Nuevo Objetivo de Ahorro" :close-on-backdrop="false" @close="showCreateModal = false">
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

          <div class="space-y-1.5" data-testid="goal-linked-account-field">
            <label for="goal-linked-account" class="block text-xs font-semibold text-text-secondary">Cuenta para esta meta (opcional)</label>
            <select id="goal-linked-account" v-model="newGoalLinkedAccountId" class="field cursor-pointer">
              <option value="">Seguimiento virtual (sin cuenta)</option>
              <option v-for="account in linkableGoalAccounts" :key="account.id" :value="account.id">
                {{ getAccountDisplayLabel(account, accountsStore.accounts) }} · {{ formatCurrency(account.balance, account.currency) }}
              </option>
            </select>
            <p v-if="newGoalLinkedAccount" class="text-[11px] text-text-muted">
              El progreso usará el saldo actual de esta cuenta. Los aportes serán transferencias entre cuentas, no gastos.
            </p>
            <p v-else class="text-[11px] text-text-muted">
              La meta solo llevará un seguimiento virtual; los aportes no cambiarán saldos ni crearán movimientos.
            </p>
          </div>

          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <!-- Current Amount (Optional) -->
            <div v-if="!newGoalLinkedAccountId" class="space-y-1.5">
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
    <BaseSheet :open="isSavingsSection && showContributeModal" :title="`Aportar a: ${selectedGoal?.name ?? ''}`" :close-on-backdrop="false" @close="showContributeModal = false">
        <form id="contribute-goal-form" @submit.prevent="handleContribute" class="space-y-4">
          <div v-if="selectedGoal && hasGoalAccountLink(selectedGoal)" class="space-y-1.5" data-testid="goal-contribution-source">
            <label for="contribute-account" class="block text-xs font-semibold text-text-secondary">Transferir desde</label>
            <select 
              id="contribute-account"
              v-model="contributeAccountId"
              :required="goalContributionSources.length > 0"
              class="field font-semibold cursor-pointer"
            >
              <option value="" disabled>Selecciona una cuenta</option>
              <option
                v-for="acc in goalContributionSources"
                :key="acc.id" 
                :value="acc.id"
              >
                {{ getAccountDisplayLabel(acc, accountsStore.accounts) }} (Saldo disponible: {{ formatCurrency(acc.balance, acc.currency) }})
              </option>
            </select>
            <p v-if="getGoalProgressAmount(selectedGoal) === null" role="alert" class="text-[11px] text-accent-amber">
              La cuenta vinculada no está disponible o ya no cumple los requisitos; no se registró ningún aporte.
            </p>
            <p v-else-if="goalContributionSources.length === 0" role="status" class="text-[11px] text-accent-amber">
              No hay otra cuenta compatible en la misma moneda para transferir este aporte.
            </p>
          </div>
          <p v-else class="text-[11px] text-text-muted" data-testid="goal-virtual-contribution">
            Este aporte solo actualizará el seguimiento virtual; no cambiará saldos ni creará un gasto.
          </p>

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
            <p class="text-[11px] text-text-muted mt-1">
              {{ selectedGoal && hasGoalAccountLink(selectedGoal) ? 'Se registrará una transferencia entre tus cuentas, sin crear un gasto.' : 'El saldo virtual aumentará de forma segura sin modificar tus cuentas.' }}
            </p>
          </div>
        </form>

        <template #footer>
          <div class="flex gap-3">
            <button type="button" @click="showContributeModal = false" class="flex-1 min-h-11 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all cursor-pointer">
              Cancelar
            </button>
            <button type="submit" form="contribute-goal-form" :disabled="!selectedGoal || (hasGoalAccountLink(selectedGoal) && (getGoalProgressAmount(selectedGoal) === null || goalContributionSources.length === 0))" class="flex-1 min-h-11 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              Realizar Aporte
            </button>
          </div>
        </template>
    </BaseSheet>

    <!-- Move existing default-budget movements into an event budget -->
    <BaseSheet :open="!isSavingsSection && !!moveSheetBudget" :title="'Mover movimientos'" :close-on-backdrop="!movingMovements" @close="closeMoveSheet">
      <div class="space-y-3" data-testid="budget-move-sheet">
        <p class="text-[11px] text-text-secondary">
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
                <span class="block truncate text-[10px] text-text-secondary">{{ formatDate(tx.date) }} · {{ accountName(tx.accountId) }}</span>
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
import { track } from '@/lib/analytics'
import { ref, shallowRef, reactive, onMounted, computed, watch, nextTick, useTemplateRef } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useGoalsStore } from '@/stores/goalsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAuthStore } from '@/stores/authStore'
import { SUPPORTED_CURRENCIES, currencyOptionsWith, defaultCurrencyCode } from '@/lib/currencies'
import type { Goal, OperatingBudgetDraft, OperatingBudgetPatch } from '@/types'
import BaseSheet from '@/components/ui/BaseSheet.vue'
import CategoryPicker from '@/components/CategoryPicker.vue'
import { suggestCategoriesBySpending, visibleBaselineCategories } from '@/lib/categoryPicker'
import { getCategoryIconComponent } from '@/lib/categoryIcons'
import { DEFAULT_MONTHLY_BUDGET_ID, budgetMoveCandidates, canAssignBudget, linkedAccountConflicts, linkedBudgetForAccount } from '@/lib/budgets'
import { budgetCardFigures } from '@/lib/dashboardMetrics'
import { isReservedBudgetName } from '@/schemas'
import { reportBudgetScope } from '@/lib/budgetReporting'
import type { BudgetWorkspaceBudgetSnapshot } from '@/lib/budgetWorkspaceAdapter'
import { createCardBillingLookup } from '@/lib/installments'
import { BUDGET_BASIS_LABELS, budgetBasis } from '@/lib/budgetBasis'
import BudgetBasisSwitch from '@/components/BudgetBasisSwitch.vue'
import { parseDateOnly, toDateValue, toLocalDateKey } from '@/lib/dates'
import { effectiveExchangeRates } from '@/lib/fx'
import { canTransferBetweenAccounts, getAccountDisplayLabel, isPocketRelatedAccount } from '@/lib/pockets'
import { getSavingsGoalProgressAmount, isSavingsGoalAccountLinkable } from '@/lib/savingsGoals'
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

const goalsStore = useGoalsStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const settingsStore = useSettingsStore()
const authStore = useAuthStore()
const route = useRoute()

const sections = [
  { id: 'budgets', to: '/goals', label: 'Presupuestos', description: 'Organiza tus gastos con presupuestos mensuales y de eventos.', icon: WalletIcon },
  { id: 'savings', to: '/goals?tab=savings', label: 'Metas de ahorro', description: 'Crea metas de ahorro y sigue el progreso hacia tus objetivos.', icon: TargetIcon }
] as const
const activeSection = computed(() => route.query.tab === 'savings' ? sections[1] : sections[0])
const isSavingsSection = computed(() => activeSection.value.id === 'savings')
const sectionHeading = useTemplateRef<HTMLHeadingElement>('sectionHeading')
const focusSectionHeading = () => sectionHeading.value?.focus()

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
// Bridge accounts replicate expenses into another workspace, pocket movements go through their
// own flow, and credit cards are liabilities (repayments are debt settlement, not budget funds).
const linkableAccounts = computed(() =>
  accountsStore.accounts.filter(account =>
    !account.mirror && !isPocketRelatedAccount(account) && account.type !== 'credit'))
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
const newGoalLinkedAccountId = ref('')
const activeWorkspaceId = computed(() => authStore.activeWorkspaceId)
const linkableGoalAccounts = computed(() => accountsStore.accounts.filter(account =>
  isSavingsGoalAccountLinkable(account, accountsStore.accounts, activeWorkspaceId.value, newGoalCurrency.value)
))
const newGoalLinkedAccount = computed(() =>
  linkableGoalAccounts.value.find(account => account.id === newGoalLinkedAccountId.value) ?? null
)
watch(linkableGoalAccounts, accounts => {
  if (newGoalLinkedAccountId.value && !accounts.some(account => account.id === newGoalLinkedAccountId.value)) {
    newGoalLinkedAccountId.value = ''
  }
})

// Contribute inputs
const contributeAccountId = ref('')
const contributeAmount = ref<number | null>(null)
const hasGoalAccountLink = (goal: Goal | null | undefined): boolean =>
  !!goal && Object.hasOwn(goal, 'linkedAccountId') && goal.linkedAccountId !== null
const getGoalProgressAmount = (goal: Goal): number | null =>
  getSavingsGoalProgressAmount(goal, accountsStore.accounts, activeWorkspaceId.value)
const selectedGoalAccount = computed(() => {
  const goal = selectedGoal.value
  return hasGoalAccountLink(goal) ? accountsStore.getAccountById(goal?.linkedAccountId ?? '') ?? null : null
})
const goalContributionSources = computed(() => {
  const goal = selectedGoal.value
  const target = selectedGoalAccount.value
  if (!goal || !target || getGoalProgressAmount(goal) === null) return []
  return accountsStore.accounts.filter(source =>
    source.id !== target.id &&
    isSavingsGoalAccountLinkable(source, accountsStore.accounts, activeWorkspaceId.value, goal.currency) &&
    canTransferBetweenAccounts(source, target, accountsStore.accounts)
  )
})

const incomeInput = shallowRef<number | string>('')
const incomeSaveError = shallowRef('')
const budgetIncomeContextKey = computed(() => {
  const uid = authStore.user?.uid
  const workspaceId = activeWorkspaceId.value
  return uid && workspaceId ? JSON.stringify([uid, workspaceId]) : null
})
const canEditBudgetIncome = computed(() =>
  budgetIncomeContextKey.value !== null &&
  goalsStore.budgetSettingsContextKey === budgetIncomeContextKey.value &&
  !goalsStore.budgetSettingsLoading && !goalsStore.budgetSettingsError
)
watch([budgetIncomeContextKey, canEditBudgetIncome, () => goalsStore.budgetIncome], () => {
  incomeInput.value = canEditBudgetIncome.value ? goalsStore.budgetIncome : ''
  incomeSaveError.value = ''
}, { immediate: true })

// Category budgets: copia local editable de goalsStore.categoryBudgets
const categoryBudgetInputs = reactive<Record<string, number | null>>({})

// Computed
const userCurrency = computed(() => settingsStore.currency || 'COP')
const activeExchangeRates = computed(() =>
  effectiveExchangeRates(goalsStore.exchangeRates, goalsStore.exchangeRatesBaseCurrency, userCurrency.value).rates
)

// Categorías de gasto para presupuestos
const expenseCategories = computed(() =>
  transactionsStore.categories.filter(c => c.type === 'expense' || c.type === 'both')
)

const activeOperatingBudgets = computed(() =>
  goalsStore.operatingBudgets.filter(entry => !entry.budget.archived)
)
// Budget each account is linked to: transfers into or out of linked accounts move funds.
// Credit cards never count as linked funding accounts (card repayments are debt settlement).
const linkedBudgetOfAccount = (accountId: string) => {
  if (accountsStore.getAccountById(accountId)?.type === 'credit') return null
  return linkedBudgetForAccount(linkableOperatingBudgets.value, accountId)?.id ?? null
}

// Card view of each active budget: spending vs its funds (assigned income and transfers into its
// linked accounts) and vs its total cap.
const budgetCards = computed(() => {
  const now = new Date()
  return new Map(activeOperatingBudgets.value.map(entry => {
    const figures = budgetCardFigures(entry, {
      linkedBudgetOf: linkedBudgetOfAccount,
      transactions: transactionsStore.transactions,
      period: { year: now.getFullYear(), month: now.getMonth() },
      reportingCurrency: userCurrency.value,
      exchangeRates: activeExchangeRates.value,
      cardBilling: cardBillingFor.value
    })
    const { spent, fundsAmount, limitAmount } = figures
    return [entry.budget.id, {
      ...figures,
      fundsPercent: spent !== null && fundsAmount !== null ? percentOf(spent, fundsAmount) : null,
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
// Card expenses count in their statement cycle month ("Consumo del mes") or when their
// statement is paid ("Pagos del mes": payments already made count in their month, the unpaid
// rest in the statement payment month), as chosen with the budget basis switch.
const cardBillingFor = computed(() => createCardBillingLookup(accountsStore.accounts, budgetBasis.value, {
  transactions: transactionsStore.transactions
}))

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
    exchangeRates: activeExchangeRates.value,
    cardBilling: cardBillingFor.value
  })
})

onMounted(async () => {
  focusSectionHeading()
  await goalsStore.fetchGoals()
  await goalsStore.loadBudgetSettings()
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await transactionsStore.fetchTransactions()

  Object.assign(categoryBudgetInputs, goalsStore.categoryBudgets)
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
// Frozen while moving, so rows don't vanish under the cursor and the counter stays coherent.
const frozenMoveCandidates = ref<Array<(typeof transactionsStore.transactions)[number]> | null>(null)
const moveSheetCandidates = computed(() =>
  frozenMoveCandidates.value ?? budgetMoveCandidatesById.value.get(moveSheetBudgetId.value) ?? [])

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
// History navigation can leave a section while one of its sheets is open.
watch(isSavingsSection, savings => {
  if (savings) {
    showBudgetModal.value = false
    closeMoveSheet()
  } else {
    showCreateModal.value = false
    showContributeModal.value = false
  }
})
watch(isSavingsSection, focusSectionHeading, { flush: 'post' })

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
  // Expenses first: moving this month's income first would briefly lower the month's income and
  // could send a false spending alert.
  const typeOf = new Map(moveSheetCandidates.value.map(transaction => [transaction.id, transaction.type]))
  const ids = [...moveSelectedIds.value].sort((left, right) =>
    Number(typeOf.get(left) === 'income') - Number(typeOf.get(right) === 'income'))
  if (!budgetId || !ids.length || movingMovements.value) return
  frozenMoveCandidates.value = [...moveSheetCandidates.value]
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
    frozenMoveCandidates.value = null
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
  // Creating or renaming into the default budget's name; a budget already stored with it keeps it.
  const storedName = editingOperatingBudget.value?.budget.name
  if (isReservedBudgetName(name) && (storedName === undefined || !isReservedBudgetName(storedName))) {
    budgetManagementError.value = 'Ese nombre está reservado para el presupuesto mensual predeterminado.'
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
  // Accounts that move here leave their previous budget in the same write as this one.
  const movedLinks = budgetLinkConflicts.value
  const linkedAccountIds = budgetLinkedAccountIds.value.filter(
    accountId => accountsStore.getAccountById(accountId)?.type !== 'credit'
  )
  const releases = [...new Set(movedLinks.map(conflict => conflict.budgetId))].flatMap(ownerId => {
    const owner = linkableOperatingBudgets.value.find(budget => budget.id === ownerId)
    if (!owner) return []
    const moved = new Set(movedLinks.filter(conflict => conflict.budgetId === ownerId).map(conflict => conflict.accountId))
    return [{ budgetId: ownerId, linkedAccountIds: (owner.linkedAccountIds ?? []).filter(accountId => !moved.has(accountId)) }]
  })
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
      const updated = await goalsStore.updateOperatingBudget(existing.id, patch, { releases })
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
      const created = await goalsStore.createOperatingBudget(draft, { releases })
      track('budget_created', { kind: draft.kind })
      budgetId = created.id
      editingOperatingBudget.value = goalsStore.operatingBudgets.find(entry => entry.budget.id === created.id)
        ?? { budget: created, categoryCaps: {} }
    }
    await goalsStore.saveOperatingBudgetCategoryCaps(budgetId, caps)
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

const getProgressPercent = (goal: Goal): number | null => {
  const currentAmount = getGoalProgressAmount(goal)
  if (currentAmount === null) return null
  if (!goal.targetAmount) return 0
  return Math.round((currentAmount / goal.targetAmount) * 100)
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

// Create new Goal
const handleCreateGoal = async () => {
  if (!newGoalName.value || !newGoalTargetAmount.value || !newGoalTargetDate.value) return

  try {
    await goalsStore.addGoal({
      name: newGoalName.value,
      targetAmount: newGoalTargetAmount.value,
      currentAmount: newGoalCurrentAmount.value || 0,
      currency: newGoalCurrency.value,
      targetDate: parseDateOnly(newGoalTargetDate.value),
      ...(newGoalLinkedAccountId.value ? { linkedAccountId: newGoalLinkedAccountId.value } : {})
    })
    track('goal_created')

    showCreateModal.value = false
    // Reset form
    newGoalName.value = ''
    newGoalTargetAmount.value = null
    newGoalCurrentAmount.value = 0
    newGoalCurrency.value = 'USD'
    newGoalTargetDate.value = ''
    newGoalLinkedAccountId.value = ''
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
  showContributeModal.value = true
}

const handleContribute = async () => {
  const goal = selectedGoal.value
  const amount = Number(contributeAmount.value)
  if (!goal || !Number.isFinite(amount) || amount <= 0) return

  try {
    if (!hasGoalAccountLink(goal)) {
      await goalsStore.contributeToGoal(goal.id, amount)
    } else {
      const source = accountsStore.getAccountById(contributeAccountId.value)
      const target = selectedGoalAccount.value
      if (!source || !target || getGoalProgressAmount(goal) === null ||
          !isSavingsGoalAccountLinkable(source, accountsStore.accounts, activeWorkspaceId.value, goal.currency) ||
          !canTransferBetweenAccounts(source, target, accountsStore.accounts)) {
        alert('La cuenta vinculada o la cuenta de origen no están disponibles para esta transferencia.')
        return
      }

      if (source.balance < amount) {
        if (isPocketRelatedAccount(source)) {
          alert('El saldo disponible de esta cuenta no alcanza para el aporte. No se registró ningún movimiento.')
          return
        }
        if (!confirm('El saldo de la cuenta es menor que el aporte. ¿Deseas continuar de todos modos?')) return
      }

      await transactionsStore.addTransaction({
        accountId: source.id,
        toAccountId: target.id,
        amount,
        description: `Aporte a meta: ${goal.name}`,
        categoryId: '',
        date: new Date(),
        type: 'transfer'
      })
    }

    showContributeModal.value = false
    alert(hasGoalAccountLink(goal)
      ? '¡Aporte registrado como transferencia entre tus cuentas!'
      : '¡Aporte virtual registrado sin modificar los saldos de tus cuentas!')
  } catch (err) {
    console.error(err)
    alert('Error al realizar el aporte de ahorro.')
  }
}

// Save budget income
const saveBudgetIncome = async (event: Event) => {
  if (!canEditBudgetIncome.value) return
  const contextKey = budgetIncomeContextKey.value
  incomeSaveError.value = ''
  if (!(event.target as HTMLInputElement).validity.valid) {
    incomeSaveError.value = 'Ingresa un monto mayor o igual a 0.'
    return
  }
  // Clearing the input still stores zero, just as with the original field.
  try {
    await goalsStore.saveBudgetIncome(Number(incomeInput.value))
  } catch (err) {
    if (budgetIncomeContextKey.value !== contextKey) return
    incomeSaveError.value = 'No se pudo guardar el ingreso. Revisa el monto e inténtalo de nuevo.'
    console.error('Error al guardar el ingreso mensual estimado:', err)
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
