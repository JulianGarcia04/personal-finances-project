<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header / Welcome -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div class="min-w-0">
        <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight break-words">
          Bóveda de {{ authStore.user?.displayName }}
        </h2>
        <p class="text-text-secondary text-sm mt-1">Aquí tienes el resumen de tu salud financiera actual.</p>
      </div>
      
      <!-- Quick Action Shortcuts -->
      <div class="flex flex-wrap gap-3">
        <router-link 
          to="/transactions" 
          class="flex items-center min-h-11 space-x-1.5 px-4 py-2.5 rounded-xl bg-slate-900 border border-border text-xs font-semibold text-text-primary hover:bg-slate-800 transition-colors"
        >
          <PlusIcon class="w-3.5 h-3.5 text-accent-emerald" />
          <span>Transacción</span>
        </router-link>
        <router-link 
          v-if="settingsStore.aiEnabled" 
          to="/import" 
          class="flex items-center min-h-11 space-x-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-accent-emerald/10 to-accent-violet/10 border border-accent-emerald/20 text-xs font-semibold text-accent-emerald hover:brightness-110 transition-all shadow-glow-emerald"
        >
          <SparklesIcon class="w-3.5 h-3.5" />
          <span>Importar con IA</span>
        </router-link>
      </div>
    </div>

    <!-- Onboarding State if no accounts exist -->
    <div v-if="accountsStore.accounts.length === 0" class="glass-panel rounded-3xl p-6 sm:p-12 text-center max-w-2xl mx-auto space-y-6">
      <div class="w-16 h-16 rounded-2xl bg-accent-emerald/10 flex items-center justify-center mx-auto text-accent-emerald border border-accent-emerald/20 shadow-glow-emerald">
        <LandmarkIcon class="w-8 h-8" />
      </div>
      <div>
        <h3 class="font-display font-bold text-2xl text-text-primary">Comienza tu viaje financiero</h3>
        <p class="text-text-secondary text-sm mt-2 max-w-md mx-auto">
          Para ver estadísticas y analizar tus gastos, primero necesitas registrar una cuenta bancaria, una tarjeta de crédito o saldo en efectivo.
        </p>
      </div>
      <router-link 
        to="/accounts" 
        class="inline-flex items-center space-x-2 px-6 py-3 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer"
      >
        <span>Agregar mi Primera Cuenta</span>
      </router-link>
    </div>

    <!-- Dashboard Content when accounts exist -->
    <div v-else class="space-y-8 animate-fade-in">
      <!-- 0. Forward-looking KPIs (compact 2-column grid on mobile; spendable is the hero) -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
        <!-- Disponible para gastar (hero) -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden border border-white/5 glow-card-emerald col-span-2 flex flex-col justify-between">
          <div class="min-w-0">
            <div class="absolute top-0 right-0 w-32 h-32 bg-accent-emerald/10 rounded-full blur-2xl pointer-events-none"></div>
            <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Disponible para gastar</span>
            <h3
              :class="['min-w-0 font-display font-bold text-2xl sm:text-4xl tabular-nums mt-1 sm:mt-2', spendable.isDeficit ? 'text-accent-rose' : 'text-accent-emerald']"
              :title="formatKpi(spendable.amount)"
            >
              <span class="whitespace-nowrap">{{ splitMoney(formatKpi(spendable.amount))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatKpi(spendable.amount))[1] }}</span>
            </h3>
            <p v-if="!spendable.isDeficit" class="text-xs text-text-secondary mt-0.5 sm:mt-1 tabular-nums">
              ≈ {{ formatKpi(spendable.perDay) }}/día por {{ spendable.daysLeft }} {{ spendable.daysLeft === 1 ? 'día' : 'días' }}
            </p>
            <p v-else class="text-xs text-accent-rose mt-0.5 sm:mt-1">
              Déficit: tus pagos de tarjeta pendientes superan tu efectivo disponible.
            </p>
          </div>
          <div class="mt-3 pt-3 sm:mt-4 sm:pt-4 border-t border-white/5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-text-muted">
            <span>Cuentas corrientes y efectivo: <span class="font-semibold text-text-primary tabular-nums whitespace-nowrap">{{ formatKpi(availableBalance) }}</span></span>
            <span>Pagos de tarjeta este mes: <span class="font-semibold text-text-primary tabular-nums whitespace-nowrap">−{{ formatKpi(committedCards) }}</span></span>
          </div>
        </div>

        <!-- Proyección de cierre -->
        <div :class="['glass-panel rounded-2xl p-3 sm:p-6 relative overflow-hidden border border-white/5 min-w-0', creditAccounts.length === 0 ? 'col-span-2' : '']">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-violet/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Proyección de cierre</span>
          <h4
            :class="['min-w-0 font-display font-bold text-base sm:text-2xl tabular-nums mt-1 sm:mt-2', projectionExceeds ? 'text-accent-amber' : 'text-text-primary']"
            :title="formatKpi(monthEndProjection.total)"
          >
            <span class="whitespace-nowrap">{{ splitMoney(formatKpi(monthEndProjection.total))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatKpi(monthEndProjection.total))[1] }}</span>
          </h4>
          <span class="text-[10px] text-text-muted mt-0.5 block leading-tight">Gastos estimados al cierre a tu ritmo actual</span>
          <div v-if="projectionStatus.budget || projectionStatus.limit" class="mt-2 pt-2 sm:mt-3 sm:pt-3 border-t border-white/5 space-y-1.5 text-[10px] leading-tight">
            <div v-if="projectionStatus.budget" :class="projectionStatus.budget.exceeds ? 'text-accent-amber' : 'text-text-secondary'">
              <span class="block">{{ projectionStatus.budget.exceeds ? '⚠️ ' : '' }}Categorías con presupuesto</span>
              <span class="tabular-nums"><span class="whitespace-nowrap font-semibold">{{ formatKpi(projectionStatus.budget.projected) }}</span> de <span class="whitespace-nowrap">{{ formatKpi(projectionStatus.budget.cap) }}</span></span>
            </div>
            <div v-if="projectionStatus.limit" :class="projectionStatus.limit.exceeds ? 'text-accent-amber' : 'text-text-secondary'">
              <span class="block">{{ projectionStatus.limit.exceeds ? '⚠️ ' : '' }}Límite de gastos</span>
              <span class="tabular-nums"><span class="whitespace-nowrap font-semibold">{{ formatKpi(projectionStatus.limit.projected) }}</span> de <span class="whitespace-nowrap">{{ formatKpi(projectionStatus.limit.cap) }}</span></span>
            </div>
          </div>
        </div>

        <!-- Deuda en tarjetas -->
        <div v-if="creditAccounts.length > 0" class="glass-panel rounded-2xl p-3 sm:p-6 relative overflow-hidden border border-white/5 min-w-0">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-rose/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Deuda en tarjetas</span>
          <h4 class="min-w-0 font-display font-bold text-base sm:text-2xl tabular-nums mt-1 sm:mt-2 text-text-primary" :title="formatKpi(cardDebt.debt)">
            <span class="whitespace-nowrap">{{ splitMoney(formatKpi(cardDebt.debt))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatKpi(cardDebt.debt))[1] }}</span>
          </h4>
          <span v-if="cardDebt.utilization !== null" class="text-[10px] text-text-muted mt-0.5 block leading-tight">
            Total: <span :class="['font-semibold tabular-nums', utilizationTextClass(cardDebt.utilization)]">{{ cardDebt.utilization }}%</span> del cupo
          </span>
          <ul class="mt-2 pt-2 sm:mt-3 sm:pt-3 border-t border-white/5 space-y-1.5">
            <li v-for="card in cardRows" :key="card.id" class="min-w-0" :title="`${card.name}: ${formatKpi(card.debt)}`">
              <div class="flex justify-between gap-2 text-[10px] leading-tight">
                <span class="min-w-0 truncate text-text-secondary">{{ card.name }}</span>
                <span v-if="card.utilization !== null" :class="['shrink-0 font-semibold tabular-nums', utilizationTextClass(card.utilization)]">{{ card.utilization }}%</span>
                <span v-else class="shrink-0 text-text-muted">sin cupo</span>
              </div>
              <span class="hidden sm:block text-[10px] text-text-muted tabular-nums leading-tight">{{ formatKpi(card.debt) }}</span>
              <div v-if="card.utilization !== null" class="w-full h-1 bg-white/10 rounded-full overflow-hidden mt-0.5">
                <div class="h-full rounded-full transition-all" :class="utilizationBarClass(card.utilization)" :style="{ width: Math.min(card.utilization, 100) + '%' }"></div>
              </div>
            </li>
          </ul>
        </div>
      </div>
      <!-- 1. Stats Cards Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <!-- Patrimonio Neto (USD/COP default) -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group border border-white/5 glow-card-emerald flex flex-col justify-between">
          <div>
            <div class="absolute top-0 right-0 w-24 h-24 bg-accent-emerald/5 rounded-full blur-xl pointer-events-none"></div>
            <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Patrimonio Neto</span>
            <h4 class="min-w-0 font-display font-bold text-xl sm:text-2xl lg:text-lg xl:text-xl 2xl:text-2xl tabular-nums mt-2 text-text-primary" :title="formatPrimaryCurrency(netWorthValue)">
              <span class="whitespace-nowrap">{{ splitMoney(formatPrimaryCurrency(netWorthValue))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatPrimaryCurrency(netWorthValue))[1] }}</span>
            </h4>
            <span class="text-[10px] text-text-muted mt-1 block">Suma de saldos de tus cuentas</span>
          </div>
          <div class="mt-4 pt-4 border-t border-white/5 text-[10px] text-text-secondary">
            Runway: <span class="font-bold text-text-primary tabular-nums">{{ liquidityDays === null ? '∞' : liquidityDays }} días</span>
            <span class="block text-text-muted mt-0.5">Saldo líquido al ritmo de gasto de los últimos 3 meses</span>
          </div>
        </div>

        <!-- Ingresos del Mes -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group border border-white/5 flex flex-col justify-between">
          <div>
            <div class="absolute top-0 right-0 w-24 h-24 bg-accent-emerald/5 rounded-full blur-xl pointer-events-none"></div>
            <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Ingresos del Mes</span>
            <div class="flex flex-wrap items-end gap-x-2 mt-2">
              <h4 class="min-w-0 max-w-full font-display font-bold text-xl sm:text-2xl lg:text-lg xl:text-xl 2xl:text-2xl tabular-nums text-accent-emerald" :title="'+' + formatPrimaryCurrency(monthlyIncome)">
                <span class="whitespace-nowrap">+{{ splitMoney(formatPrimaryCurrency(monthlyIncome))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatPrimaryCurrency(monthlyIncome))[1] }}</span>
              </h4>
              <span :class="['text-xs mb-1 font-semibold', incomeData.percent >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
                {{ incomeData.percent > 0 ? '+' : '' }}{{ incomeData.percent }}%
              </span>
            </div>
            <span class="text-[10px] text-text-muted mt-1 block">vs mismo periodo del mes anterior ({{ formatPrimaryCurrency(incomeData.previous) }})</span>
          </div>
        </div>

        <!-- Gastos del Mes -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group border border-white/5 flex flex-col justify-between">
          <div>
            <div class="absolute top-0 right-0 w-24 h-24 bg-accent-rose/5 rounded-full blur-xl pointer-events-none"></div>
            <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Gastos imputados del Mes</span>
            <div class="flex flex-wrap items-end gap-x-2 mt-2">
              <h4 class="min-w-0 max-w-full font-display font-bold text-xl sm:text-2xl lg:text-lg xl:text-xl 2xl:text-2xl tabular-nums text-accent-rose" :title="formatPrimaryCurrency(monthlyExpenses)">
                <span class="whitespace-nowrap">{{ splitMoney(formatPrimaryCurrency(monthlyExpenses))[0] }}</span> <span class="inline-block max-w-full truncate align-bottom whitespace-nowrap">{{ splitMoney(formatPrimaryCurrency(monthlyExpenses))[1] }}</span>
              </h4>
              <span :class="['text-xs mb-1 font-semibold', expensesData.percent <= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
                {{ expensesData.percent > 0 ? '+' : '' }}{{ expensesData.percent }}%
              </span>
            </div>
            <span class="text-[10px] text-text-muted mt-1 block">vs mismo periodo del mes anterior ({{ formatPrimaryCurrency(expensesData.previous) }})</span>
            <span class="text-[10px] text-text-secondary mt-2 block">Compras registradas: {{ formatPrimaryCurrency(monthlyPurchaseTotal) }} total</span>
          </div>
          
          <div v-if="topBleeder" class="mt-4 pt-3 border-t border-white/5">
            <span class="text-[10px] font-semibold text-accent-amber block truncate">
              ⚠️ Mayor fuga: {{ topBleeder[0] }}
            </span>
          </div>

          <!-- ponytail: member breakdown -->
          <div v-if="memberExpenses.length > 0" class="mt-2 pt-2 border-t border-white/5 space-y-1">
            <div v-for="m in memberExpenses" :key="m.name" class="flex justify-between text-[10px]">
              <span class="min-w-0 text-text-secondary truncate pr-2">{{ m.name }}</span>
              <span class="shrink-0 font-semibold text-text-primary tabular-nums">{{ formatPrimaryCurrency(m.amount) }}</span>
            </div>
          </div>

          <!-- ponytail: limit indicator -->
          <div v-if="currentExpenseLimit > 0" class="mt-3">
            <div class="flex justify-between text-[10px] mb-1">
              <span class="text-text-secondary">Límite: {{ formatPrimaryCurrency(currentExpenseLimit) }}</span>
              <span :class="monthlyExpenses > currentExpenseLimit ? 'text-accent-rose' : 'text-accent-emerald'">{{ Math.round((monthlyExpenses / currentExpenseLimit) * 100) }}%</span>
            </div>
            <div class="w-full h-1 bg-white/10 rounded-full overflow-hidden">
              <div class="h-full rounded-full" :class="monthlyExpenses > currentExpenseLimit ? 'bg-accent-rose' : 'bg-accent-emerald'" :style="{ width: Math.min((monthlyExpenses / currentExpenseLimit) * 100, 100) + '%' }"></div>
            </div>
          </div>
        </div>

        <!-- Tasa de Ahorro -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group border border-white/5">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-amber/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Tasa de Ahorro</span>
          <h4 class="font-display font-bold text-xl sm:text-2xl mt-2 text-accent-amber tabular-nums truncate">
            {{ savingsRate.toFixed(1) }}%
          </h4>
          <span class="text-[10px] text-text-muted mt-1 block">
            {{ savingsRate >= 0 ? 'Fondo acumulado del ingreso' : 'Estás gastando más de lo que ganas' }}
          </span>
        </div>
      </div>

      <!-- 2. Charts Section -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Gastos por categoría (Donut) -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 md:col-span-1 flex flex-col justify-between sm:h-80 md:h-96">
          <div>
            <h4 class="font-display font-bold text-base text-text-primary">Distribución de Gastos</h4>
            <p class="text-text-muted text-xs mt-0.5">Gastos acumulados por categoría en el mes.</p>
          </div>
          
          <div class="relative h-56 sm:h-auto sm:flex-1 flex items-center justify-center p-4">
            <canvas ref="donutCanvas" class="max-h-56"></canvas>
            <p v-if="Object.keys(expensesByCategory).length === 0" class="absolute text-center text-text-muted text-xs py-8">
              No hay gastos registrados este mes.
            </p>
          </div>

          <!-- Compact HTML legend on phones (Chart.js legend is hidden below sm) -->
          <ul v-if="!isSmUp && donutLegend.length > 0" class="mt-2 space-y-1.5 border-t border-white/5 pt-3">
            <li v-for="item in donutLegend" :key="item.name" class="flex items-center gap-2 text-xs">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: item.color }"></span>
              <span class="min-w-0 flex-1 truncate text-text-secondary">{{ item.name }}</span>
              <span class="shrink-0 font-semibold text-text-primary tabular-nums">{{ formatPrimaryCurrency(item.amount) }}</span>
            </li>
          </ul>
        </div>

        <!-- Flujo mensual (Bar Chart) -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 md:col-span-2 flex flex-col justify-between h-72 sm:h-80 md:h-96">
          <div>
            <h4 class="font-display font-bold text-base text-text-primary">Flujo de Caja Mensual</h4>
            <p class="text-text-muted text-xs mt-0.5">Comparativo mensual de ingresos y gastos.</p>
          </div>
          
          <div class="relative flex-1 min-h-0 flex items-center justify-center p-2 sm:p-4">
            <canvas ref="barCanvas" class="w-full max-h-60"></canvas>
            <p v-if="transactionsStore.transactions.length === 0" class="absolute text-center text-text-muted text-xs py-8">
              No hay movimientos históricos para graficar.
            </p>
          </div>
        </div>
      </div>

      <!-- 2.5 Budget & Goals widgets -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Budget of the month -->
        <div v-if="budgetSummary" class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="min-w-0 font-display font-bold text-base text-text-primary">Presupuesto del Mes</h4>
            <router-link to="/goals" class="-my-3 -mr-2 inline-flex items-center min-h-11 px-2 shrink-0 text-xs text-accent-emerald font-semibold hover:underline">
              Ajustar
            </router-link>
          </div>
          <div class="flex items-end justify-between">
            <span class="text-[10px] text-text-muted uppercase tracking-widest">Usado</span>
            <span v-if="budgetSummary.percent !== null" :class="['font-display font-bold text-lg', budgetSummary.percent > 100 ? 'text-accent-rose' : budgetSummary.percent >= 70 ? 'text-accent-amber' : 'text-accent-emerald']">
              {{ budgetSummary.percent }}%
            </span>
            <span v-else class="text-[10px] font-semibold text-accent-amber">Sin comparación</span>
          </div>
          <div class="w-full h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              v-if="budgetSummary.percent !== null"
              :class="['h-full rounded-full transition-all', budgetSummary.percent > 100 ? 'bg-accent-rose' : budgetSummary.percent >= 70 ? 'bg-accent-amber' : 'bg-accent-emerald']"
              :style="{ width: Math.min(budgetSummary.percent, 100) + '%' }"
            ></div>
          </div>
          <p class="text-[10px] text-text-muted">
            <span v-if="budgetSummary.totalSpentReal !== null">
              Gastado en {{ budgetSummary.reportingCurrency }}: {{ formatCurrency(budgetSummary.totalSpentReal, budgetSummary.reportingCurrency) }}
            </span>
            <span v-else>Gasto incompleto en {{ budgetSummary.reportingCurrency }}.</span>
            <span aria-hidden="true"> · </span>
            <span v-if="budgetSummary.capCurrency !== null && budgetSummary.totalBudget !== null">
              Límites en {{ budgetSummary.capCurrency }}: {{ formatCurrency(budgetSummary.totalBudget, budgetSummary.capCurrency) }}
            </span>
            <span v-else>Moneda de límites por confirmar.</span>
          </p>
          <div v-if="budgetSummary.comparisonWarnings.length > 0" role="status" aria-live="polite" class="space-y-1 text-[10px] text-accent-amber">
            <p v-for="warning in budgetSummary.comparisonWarnings" :key="warning">{{ warning }}</p>
          </div>
          <div class="space-y-2 pt-2 border-t border-white/5">
            <div v-for="row in budgetSummary.rows" :key="row.name" class="space-y-1">
              <div class="flex justify-between gap-2 text-[11px]">
                <span class="min-w-0 text-text-secondary flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full shrink-0" :style="{ backgroundColor: row.color }"></span>
                  <span class="truncate">{{ row.name }}</span>
                </span>
                <span v-if="row.percent !== null" class="shrink-0" :class="row.percent > 100 ? 'text-accent-rose font-semibold' : row.percent === 100 ? 'text-accent-amber font-semibold' : 'text-text-muted'">{{ row.percent }}%</span>
                <span v-else class="shrink-0 text-accent-amber">Pendiente</span>
              </div>
              <div class="w-full h-1 rounded-full bg-white/10 overflow-hidden">
                <div
                  v-if="row.percent !== null"
                  :class="['h-full rounded-full', row.percent > 100 ? 'bg-accent-rose' : row.percent >= 70 ? 'bg-accent-amber' : 'bg-accent-emerald']"
                  :style="{ width: Math.min(row.percent, 100) + '%' }"
                ></div>
              </div>
            </div>
          </div>
        </div>

        <!-- All-budget monthly estimate -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
          <div class="flex flex-wrap items-start justify-between gap-2 sm:gap-3">
            <div class="min-w-0 flex-1">
              <h4 class="font-display font-bold text-base text-text-primary">Asignaciones mensuales estimadas</h4>
              <p class="text-text-muted text-xs mt-1 max-w-xl">
                Cuotas del mes de gastos de todos los presupuestos, incluidos los archivados y sin asignar; el principal de eventos no se suma aparte.
              </p>
            </div>
            <span class="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
              Moneda de reporte: {{ allBudgetsEstimatedMonthly.currency }}
            </span>
          </div>

          <div class="rounded-xl border border-white/5 bg-slate-950/30 p-3.5 sm:p-4 min-w-0">
            <span class="block text-[10px] font-semibold uppercase tracking-widest text-text-muted">Estimación del mes calendario</span>
            <p v-if="allBudgetsEstimatedMonthly.amount !== null" class="font-display font-bold text-xl sm:text-2xl text-text-primary tabular-nums truncate mt-1" :title="formatCurrency(allBudgetsEstimatedMonthly.amount, allBudgetsEstimatedMonthly.currency)">
              {{ formatCurrency(allBudgetsEstimatedMonthly.amount, allBudgetsEstimatedMonthly.currency) }}
            </p>
            <p v-else class="font-semibold text-sm text-accent-amber mt-1">Total incompleto; revisa las tasas manuales.</p>
          </div>

          <div v-if="allBudgetsEstimateWarnings.length > 0" role="status" aria-live="polite" class="space-y-1 text-xs text-accent-amber">
            <p v-for="warning in allBudgetsEstimateWarnings" :key="warning">{{ warning }}</p>
          </div>
        </div>

        <!-- Goals progress -->
        <div v-if="goalProgress.length > 0" class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="font-display font-bold text-base text-text-primary">Tus Metas de Ahorro</h4>
            <router-link to="/goals" class="-my-3 -mr-2 inline-flex items-center min-h-11 px-2 shrink-0 text-xs text-accent-emerald font-semibold hover:underline">
              Ver metas
            </router-link>
          </div>
          <div class="space-y-3">
            <div v-for="goal in goalProgress" :key="goal.id" class="space-y-1.5">
              <div class="flex justify-between gap-2 text-xs">
                <span class="min-w-0 text-text-primary font-semibold truncate">{{ goal.name }}</span>
                <span class="shrink-0 text-accent-emerald font-semibold">{{ goal.percent }}%</span>
              </div>
              <div class="w-full h-2 rounded-full bg-slate-950/60 overflow-hidden border border-white/5">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-accent-emerald to-accent-violet transition-all"
                  :style="{ width: Math.min(goal.percent, 100) + '%' }"
                ></div>
              </div>
              <p class="text-[10px] text-text-muted">
                {{ formatCurrency(goal.current, goal.currency) }} / {{ formatCurrency(goal.target, goal.currency) }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 2.6 Upcoming card payments (ciclo de facturación, no mes calendario) -->
      <div v-if="upcomingCardPayments.length > 0" class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h4 class="font-display font-bold text-base text-text-primary">Próximos Pagos de Tarjeta</h4>
          <router-link to="/accounts" class="-my-3 -mr-2 inline-flex items-center min-h-11 px-2 shrink-0 text-xs text-accent-emerald font-semibold hover:underline">
            Ver cuentas
          </router-link>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div
            v-for="payment in upcomingCardPayments"
            :key="payment.id"
            class="flex items-center justify-between p-3 rounded-xl bg-white/[0.01] border border-white/5"
          >
            <div class="min-w-0 flex-1 truncate pr-2">
              <p class="text-sm font-medium text-text-primary truncate">{{ payment.name }}</p>
              <p
                :class="['text-[10px] mt-0.5', payment.daysLeft <= 3 ? 'text-accent-rose font-semibold' : payment.daysLeft <= 7 ? 'text-accent-amber' : 'text-text-muted']"
              >
                {{ payment.daysLeft <= 0 ? 'Vence hoy' : `Vence en ${payment.daysLeft} días` }}
              </p>
            </div>
            <span v-if="payment.amount !== null" class="font-display font-semibold text-sm text-text-primary tabular-nums shrink-0">
              {{ formatCurrency(payment.amount, payment.currency) }}
            </span>
          </div>
        </div>
      </div>

      <!-- 3. Recent Transactions & Quick Summary -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Recent Transactions (List) -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 lg:col-span-2 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="font-display font-bold text-base text-text-primary">Transacciones Recientes</h4>
            <router-link to="/transactions" class="-my-3 -mr-2 inline-flex items-center min-h-11 px-2 shrink-0 text-xs text-accent-emerald font-semibold hover:underline">
              Ver todas
            </router-link>
          </div>

          <div class="space-y-3">
            <div 
              v-for="tx in recentTransactions" 
              :key="tx.id"
              class="flex items-center justify-between p-3 rounded-xl bg-white/[0.01] border border-white/5 hover:border-white/10 transition-all"
            >
              <div class="min-w-0 flex-1 flex items-center space-x-3 truncate">
                <div 
                  class="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-xs"
                  :style="{ backgroundColor: (getCategory(tx.categoryId)?.color || '#94a3b8') + '12', color: getCategory(tx.categoryId)?.color || '#94a3b8' }"
                  v-if="getCategory(tx.categoryId)"
                >
                  <component :is="getCategoryIcon(getCategory(tx.categoryId)?.icon || 'HelpCircle')" class="w-4 h-4" />
                </div>
                <div class="min-w-0 truncate">
                  <p class="text-sm font-semibold text-text-primary truncate">{{ tx.description }}</p>
                  <p class="text-[10px] text-text-secondary mt-0.5 truncate">{{ getAccountName(tx.accountId) }} • {{ formatDate(tx.date) }}</p>
                </div>
              </div>

              <span class="text-right shrink-0 pl-2">
                <span :class="['font-display font-bold text-sm tabular-nums', displayOf(tx).amountClass]">
                  {{ displayOf(tx).prefix }}{{ formatCurrency(displayOf(tx).amount, tx.currency) }}
                </span>
                <span v-if="displayOf(tx).route" class="block text-[10px] text-text-muted mt-0.5">{{ displayOf(tx).route }}</span>
              </span>
            </div>
            <p v-if="recentTransactions.length === 0" class="text-center text-text-muted text-xs py-6">
              No hay transacciones registradas.
            </p>
          </div>
        </div>

        <!-- Cuentas Bancarias Summary -->
        <div class="glass-panel rounded-2xl p-4 sm:p-6 lg:col-span-1 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="font-display font-bold text-base text-text-primary">Saldos de Cuentas</h4>
            <router-link to="/accounts" class="-my-3 -mr-2 inline-flex items-center min-h-11 px-2 shrink-0 text-xs text-accent-emerald font-semibold hover:underline">
              Gestionar
            </router-link>
          </div>

          <div class="space-y-3">
            <div 
              v-for="acc in accountsStore.accounts" 
              :key="acc.id"
              class="flex items-center justify-between p-3 rounded-xl bg-white/[0.01] border border-white/5"
            >
              <div class="min-w-0 flex-1 flex items-center space-x-2.5">
                <component :is="getAccountIcon(acc.type)" class="w-4 h-4 shrink-0 text-text-secondary" />
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{{ accountSummaryLabel(acc) }}</span>
              </div>
              <span :class="['shrink-0 pl-2 font-display font-semibold text-sm tabular-nums', acc.balance >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
                {{ formatCurrency(acc.balance, acc.currency) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { Account, AccountType, Transaction } from '@/types'
import { createCardBillingLookup, expenseAmountForMonth } from '@/lib/installments'
import { getTransactionDisplay } from '@/lib/transactionDisplay'
import { splitMoney } from '@/lib/money'
import { getAccountDisplayLabel, groupAccountsByPocket } from '@/lib/pockets'
import {
  alignedMonthPeriods,
  isDateInPeriod,
  expenseAmountInPeriod,
  percentChange,
  previousFullMonths,
  runwayDays,
  committedCardPayments,
  spendableUntilMonthEnd,
  projectMonthEndExpenses,
  splitMonthEndExpenses,
  cardDebtSummary,
  utilizationLevel,
  isSpendableAccount,
  projectionChecks,
  cardDebtRows
} from '@/lib/dashboardMetrics'
import { getNextOccurrence, daysUntil, expenseAmountForCycle, getStatementClosingForDueDate } from '@/lib/creditCycle'
import { DEFAULT_MONTHLY_BUDGET_ID } from '@/lib/budgets'
import { reportAllBudgetsEstimatedMonthly, reportBudgetScope } from '@/lib/budgetReporting'
import { 
  Plus as PlusIcon, 
  Sparkles as SparklesIcon,
  Landmark as LandmarkIcon,
  PiggyBank as SavingsIcon, 
  CreditCard as CreditIcon, 
  Wallet as CashIcon, 
  Building as BankIcon,
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield
} from 'lucide-vue-next'

// Importar Chart.js directamente
import { Chart, registerables } from 'chart.js'
Chart.register(...registerables)

const authStore = useAuthStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const settingsStore = useSettingsStore()
const workspacesStore = useWorkspacesStore()
const goalsStore = useGoalsStore()

const donutCanvas = ref<HTMLCanvasElement | null>(null)
const barCanvas = ref<HTMLCanvasElement | null>(null)
let donutChart: Chart | null = null
let barChart: Chart | null = null

// Chart.js legend only from sm up; phones get a compact HTML legend instead.
const smQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px)') : null
const isSmUp = ref(smQuery?.matches ?? true)
const onSmChange = (e: MediaQueryListEvent) => {
  isSmUp.value = e.matches
}
smQuery?.addEventListener('change', onSmChange)
onBeforeUnmount(() => {
  smQuery?.removeEventListener('change', onSmChange)
  donutChart?.destroy()
  barChart?.destroy()
})
watch(isSmUp, () => renderCharts())

// Compact axis labels (e.g. "1,2 M", "350 mil") so the y-axis fits on narrow screens.
const compactNumber = new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 })

onMounted(async () => {
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await transactionsStore.fetchTransactions()
  await settingsStore.loadSettings()
  await goalsStore.fetchGoals()
  await goalsStore.loadBudgetSettings()

  renderCharts()
})

// Volver a renderizar gráficos si los datos cambian
watch(
  () => [transactionsStore.transactions, accountsStore.accounts],
  () => {
    renderCharts()
  },
  { deep: true }
)

// Moneda principal: la elegida por el usuario en Settings
const primaryCurrency = computed(() => settingsStore.currency || 'COP')

// Billing days per credit card: billed card installments count in the month the
// statement is paid. "Compras registradas" and the card statement widget do not use it.
const cardBillingFor = computed(() => createCardBillingLookup(accountsStore.accounts))

const allBudgetsEstimatedMonthly = computed(() => {
  const now = new Date()
  return reportAllBudgetsEstimatedMonthly({
    transactions: transactionsStore.transactions,
    period: { year: now.getFullYear(), month: now.getMonth() },
    reportingCurrency: primaryCurrency.value,
    exchangeRates: goalsStore.exchangeRates,
    cardBilling: cardBillingFor.value
  })
})

const allBudgetsEstimateWarnings = computed(() => {
  const report = allBudgetsEstimatedMonthly.value
  const warnings: string[] = []
  if (report.missingRateCurrencies.length > 0) {
    warnings.push(`Faltan tasas manuales para: ${report.missingRateCurrencies.join(', ')}`)
  }
  if (report.invalidRateCurrencies.length > 0) {
    warnings.push(`Tasas inválidas para: ${report.invalidRateCurrencies.join(', ')}`)
  }
  return warnings
})

// ponytail: conversión con tasas manuales del workspace; sin tasa configurada se suma 1:1
const convert = (amount: number, currency: string) =>
  goalsStore.convertToPrimary(amount, currency, primaryCurrency.value)

// Patrimonio Neto consolidado en la moneda principal
const netWorthValue = computed(() => {
  const totals = accountsStore.netWorthByCurrency
  return Object.entries(totals).reduce((sum, [cur, total]) => sum + convert(total, cur), 0)
})

// Ingresos del mes actual
// MoM (Month-over-Month) aligned by elapsed days: day 1..N vs day 1..min(N, lastDay)
// of the previous month. `current` stays the full imputed month for the headline amount.
const getMoMData = (type: 'income' | 'expense') => {
  const { current: currentPeriod, previous: previousPeriod } = alignedMonthPeriods(new Date())

  let current = 0, toDate = 0, previous = 0
  transactionsStore.transactions.forEach(t => {
    if (t.type !== type) return
    if (type === 'expense') {
      const billing = cardBillingFor.value(t.accountId)
      current += convert(expenseAmountForMonth(t, currentPeriod.year, currentPeriod.month, billing), t.currency)
      toDate += convert(expenseAmountInPeriod(t, currentPeriod, billing), t.currency)
      previous += convert(expenseAmountInPeriod(t, previousPeriod, billing), t.currency)
      return
    }
    const amount = convert(Math.abs(t.amount), t.currency)
    if (t.date.getMonth() === currentPeriod.month && t.date.getFullYear() === currentPeriod.year) current += amount
    if (isDateInPeriod(t.date, currentPeriod)) toDate += amount
    if (isDateInPeriod(t.date, previousPeriod)) previous += amount
  })

  return { current, toDate, previous, percent: percentChange(toDate, previous) }
}

const incomeData = computed(() => getMoMData('income'))
const monthlyIncome = computed(() => incomeData.value.current)

// Gastos del mes actual y comparativa
const expensesData = computed(() => getMoMData('expense'))
const monthlyExpenses = computed(() => expensesData.value.current)

const monthlyPurchaseTotal = computed(() => {
  const now = new Date()
  return transactionsStore.transactions.reduce((total, t) => {
    if (t.type !== 'expense' || t.date.getMonth() !== now.getMonth() || t.date.getFullYear() !== now.getFullYear()) {
      return total
    }
    return total + convert(Math.abs(t.amount), t.currency)
  }, 0)
})

// Liquid accounts: cash-like balances (checking/savings/cash). Credit cards and mirror
// bridge accounts are excluded; pockets are separate balances, so nothing is double counted.
const liquidAccounts = computed(() =>
  accountsStore.accounts.filter(acc => acc.type !== 'credit' && !acc.mirror)
)
const liquidBalance = computed(() =>
  liquidAccounts.value.reduce((sum, acc) => sum + convert(acc.balance, acc.currency), 0)
)

// Runway: liquid balance / average daily expense of the last 3 full months
// (fallback: current-month pace). null = no expenses, shown as ∞.
const liquidityDays = computed(() => {
  const now = new Date()
  const history = previousFullMonths(now, 3).map(({ year, month, days }) => ({
    days,
    expenses: transactionsStore.transactions.reduce(
      (sum, t) => sum + convert(expenseAmountForMonth(t, year, month, cardBillingFor.value(t.accountId)), t.currency),
      0
    )
  }))
  return runwayDays({
    liquidBalance: liquidBalance.value,
    history,
    monthToDateExpenses: expensesData.value.toDate,
    dayOfMonth: now.getDate()
  })
})

// Disponible para gastar: top-level checking + cash (no savings, pockets, credit or
// mirror accounts) minus card payments still due this month.
const availableBalance = computed(() =>
  accountsStore.accounts
    .filter(isSpendableAccount)
    .reduce((sum, acc) => sum + convert(acc.balance, acc.currency), 0)
)

const committedCards = computed(() =>
  committedCardPayments(
    upcomingCardPayments.value.map(payment => ({
      statementAmount: payment.amount === null ? null : convert(payment.amount, payment.currency),
      debt: convert(payment.debt, payment.currency),
      dueDate: payment.dueDate
    })),
    new Date()
  )
)

const spendable = computed(() =>
  spendableUntilMonthEnd({ availableBalance: availableBalance.value, committed: committedCards.value, now: new Date() })
)

// Proyección de cierre: purchases made this month at the current daily pace plus
// amounts of earlier purchases already imputed to this month (later installments and
// card statements due this month), added once. `budgeted` only counts categories with
// a budget, so it can be compared with the budget total.
const monthEndProjection = computed(() => {
  const now = new Date()
  const budgets = goalsStore.categoryBudgets
  const options = { convert, billingFor: cardBillingFor.value }
  const all = splitMonthEndExpenses(transactionsStore.transactions, now, options)
  const budgeted = splitMonthEndExpenses(transactionsStore.transactions, now, {
    ...options,
    include: t => Boolean(t.categoryId && budgets[t.categoryId] !== undefined)
  })
  return {
    total: projectMonthEndExpenses({ paceExpensesToDate: all.pace, committedExpenses: all.committed, now }),
    budgeted: projectMonthEndExpenses({ paceExpensesToDate: budgeted.pace, committedExpenses: budgeted.committed, now })
  }
})

const projectionStatus = computed(() =>
  projectionChecks({
    budgetedProjection: monthEndProjection.value.budgeted,
    budgetTotal: budgetSummary.value?.totalBudget ?? 0,
    totalProjection: monthEndProjection.value.total,
    expenseLimit: currentExpenseLimit.value
  })
)
const projectionExceeds = computed(() =>
  Boolean(projectionStatus.value.budget?.exceeds || projectionStatus.value.limit?.exceeds)
)

// Deuda en tarjetas: negative credit balances and utilization of the total limit.
const creditAccounts = computed(() =>
  accountsStore.accounts.filter(acc => acc.type === 'credit' && !acc.mirror)
)
const cardDebt = computed(() =>
  cardDebtSummary(creditAccounts.value.map(acc => ({
    balance: convert(acc.balance, acc.currency),
    limit: convert(acc.limit || 0, acc.currency)
  })))
)
const cardRows = computed(() =>
  cardDebtRows(creditAccounts.value.map(acc => ({
    id: acc.id,
    name: acc.name,
    balance: convert(acc.balance, acc.currency),
    limit: convert(acc.limit || 0, acc.currency)
  })))
)
const utilizationTextClass = (utilization: number | null) => ({
  ok: 'text-accent-emerald',
  warn: 'text-accent-amber',
  alert: 'text-accent-rose'
}[utilizationLevel(utilization)])
const utilizationBarClass = (utilization: number | null) => ({
  ok: 'bg-accent-emerald',
  warn: 'bg-accent-amber',
  alert: 'bg-accent-rose'
}[utilizationLevel(utilization)])

// ponytail: Top Bleeder
const topBleeder = computed(() => {
  const entries = Object.entries(expensesByCategory.value)
  return entries.length ? entries.sort((a, b) => b[1] - a[1])[0] : null
})

// ponytail: Gastos por miembro (solo para workspaces compartidos)
const memberExpenses = computed(() => {
  const profiles = workspacesStore.activeWorkspaceProfiles
  if (!profiles || profiles.length <= 1) return []
  
  const now = new Date()
  const thisMonth = now.getMonth(), thisYear = now.getFullYear()
  const totals: Record<string, number> = {}
  
  transactionsStore.transactions.forEach(t => {
    if (t.type === 'expense') {
      const amount = expenseAmountForMonth(t, thisYear, thisMonth, cardBillingFor.value(t.accountId))
      if (amount === 0) return
      const uid = t.userId || authStore.user?.uid || 'unknown'
      if (!totals[uid]) totals[uid] = 0
      totals[uid] += convert(amount, t.currency)
    }
  })
  
  return Object.entries(totals).map(([uid, amount]) => {
    const profile = profiles.find(p => p.uid === uid)
    const name = profile?.displayName || profile?.email?.split('@')[0] || 'Miembro'
    return { name, amount }
  }).sort((a, b) => b.amount - a.amount)
})

// ponytail: current limit
const currentExpenseLimit = computed(() => {
  if (!authStore.activeWorkspaceId) return 0
  const ws = workspacesStore.workspaces.find(w => w.id === authStore.activeWorkspaceId)
  return ws?.expenseLimit || 0
})

const savingsRate = computed(() => {
  if (monthlyIncome.value === 0) return 0
  const savings = monthlyIncome.value - monthlyExpenses.value
  return Math.max(0, (savings / monthlyIncome.value) * 100)
})

// Lista de transacciones recientes
const recentTransactions = computed(() => {
  return transactionsStore.transactions.slice(0, 5)
})

// Compare protected legacy category caps without changing their stored denomination.
const budgetSummary = computed(() => {
  const budgets = goalsStore.categoryBudgets
  const ids = Object.keys(budgets)
  if (ids.length === 0) return null

  const now = new Date()
  const capCurrency = goalsStore.categoryBudgetCurrency.status === 'confirmed'
    ? goalsStore.categoryBudgetCurrency.code
    : null
  const report = reportBudgetScope({
    scope: { id: DEFAULT_MONTHLY_BUDGET_ID, kind: 'monthly', capCurrency },
    categoryCaps: budgets,
    transactions: transactionsStore.transactions,
    period: { year: now.getFullYear(), month: now.getMonth() },
    reportingCurrency: primaryCurrency.value,
    exchangeRates: goalsStore.exchangeRates,
    cardBilling: cardBillingFor.value
  })

  const comparisonWarnings = new Set<string>()
  if (capCurrency === null) {
    comparisonWarnings.add('Moneda de límites por confirmar en Objetivos; la comparación está desactivada.')
  }

  const rows = ids.map(catId => {
    const categoryReport = report.categories[catId]
    const allocation = categoryReport?.monthlyAllocation
    const cap = categoryReport?.cap
    if (cap?.state === 'missing-rate' && cap.currency) {
      comparisonWarnings.add(`Falta tasa manual para comparar límites en ${cap.currency}.`)
    } else if (cap?.state === 'invalid-rate' && cap.currency) {
      comparisonWarnings.add(`Tasa manual inválida para comparar límites en ${cap.currency}.`)
    }
    if (allocation) {
      allocation.missingRateCurrencies.forEach(currency => {
        comparisonWarnings.add(`Falta tasa manual para reportar gastos en ${currency}.`)
      })
      allocation.invalidRateCurrencies.forEach(currency => {
        comparisonWarnings.add(`Tasa manual inválida para reportar gastos en ${currency}.`)
      })
      if (!allocation.complete) {
        comparisonWarnings.add('El total de gasto está incompleto; revisa las tasas manuales.')
      }
    }

    const comparison = categoryReport?.comparison
    const category = getCategory(catId)
    return {
      name: category?.name || 'Categoría',
      color: category?.color || '#94a3b8',
      spent: allocation?.amount ?? null,
      limit: budgets[catId],
      percent: comparison
        ? comparison.limitAmount > 0
          ? Math.round((comparison.spentAmount / comparison.limitAmount) * 100)
          : 0
        : null
    }
  }).sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1))

  const positiveCategoryIds = ids.filter(catId => budgets[catId] > 0)
  const totalLimitForReporting = positiveCategoryIds.reduce<number | null>((total, catId) => {
    const comparison = report.categories[catId]?.comparison
    if (total === null || !comparison) return null
    return total + comparison.limitAmount
  }, capCurrency === null ? null : 0)
  const cappedSpendForReporting = positiveCategoryIds.reduce<number | null>((total, catId) => {
    const comparison = report.categories[catId]?.comparison
    if (total === null || !comparison) return null
    return total + Math.min(comparison.spentAmount, comparison.limitAmount)
  }, capCurrency === null ? null : 0)
  const percent = positiveCategoryIds.length === 0
    ? capCurrency === null ? null : 0
    : totalLimitForReporting !== null && totalLimitForReporting > 0 && cappedSpendForReporting !== null
      ? Math.round((cappedSpendForReporting / totalLimitForReporting) * 100)
      : null

  const allocations = ids.map(catId => report.categories[catId]?.monthlyAllocation)
  const totalSpentComplete = allocations.every(allocation => allocation?.complete && allocation.amount !== null)
  const totalSpentReal = totalSpentComplete
    ? allocations.reduce((total, allocation) => total + (allocation?.amount ?? 0), 0)
    : null
  const totalBudget = capCurrency === null
    ? null
    : ids.reduce((total, catId) => total + budgets[catId], 0)

  return {
    rows: rows.slice(0, 4),
    percent,
    totalBudget,
    totalSpentReal,
    capCurrency,
    reportingCurrency: report.reportingCurrency,
    comparisonWarnings: [...comparisonWarnings]
  }
})

// Progreso de metas (widget)
const goalProgress = computed(() =>
  goalsStore.goals.slice(0, 4).map(g => ({
    id: g.id,
    name: g.name,
    currency: g.currency,
    current: g.currentAmount,
    target: g.targetAmount,
    percent: g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0
  }))
)

// Agrupación de gastos por categoría para el gráfico de dona
const expensesByCategory = computed(() => {
  const now = new Date()
  const currentMonthExpenses = transactionsStore.transactions.filter(t => t.type === 'expense')

  const groups: Record<string, number> = {}
  currentMonthExpenses.forEach(t => {
    const cat = getCategory(t.categoryId)
    const name = cat ? cat.name : 'Otros'
    if (!groups[name]) groups[name] = 0
    groups[name] += convert(expenseAmountForMonth(t, now.getFullYear(), now.getMonth(), cardBillingFor.value(t.accountId)), t.currency)
  })
  return groups
})

const donutLegend = computed(() =>
  Object.entries(expensesByCategory.value)
    .map(([name, amount]) => ({
      name,
      amount,
      color: transactionsStore.categories.find(c => c.name === name)?.color || '#6b7280'
    }))
    .sort((a, b) => b.amount - a.amount)
)

// Gráficos renderizados con Chart.js directamente
const renderCharts = () => {
  // Destruir instancias previas si existen
  if (donutChart) donutChart.destroy()
  if (barChart) barChart.destroy()

  const donutCtx = donutCanvas.value
  const barCtx = barCanvas.value

  // Render Donut Chart
  if (donutCtx && Object.keys(expensesByCategory.value).length > 0) {
    const labels = Object.keys(expensesByCategory.value)
    const data = Object.values(expensesByCategory.value)
    const colors = labels.map(name => {
      const cat = transactionsStore.categories.find(c => c.name === name)
      return cat ? cat.color : '#6b7280'
    })

    donutChart = new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: isSmUp.value,
            position: 'bottom',
            labels: {
              boxWidth: 10,
              color: '#94a3b8',
              font: { family: 'Plus Jakarta Sans', size: 10 }
            }
          }
        },
        cutout: '70%'
      }
    })
  }

  // Render Bar Chart (Monthly Income vs Expense)
  if (barCtx && transactionsStore.transactions.length > 0) {
    // Agrupar los últimos 6 meses
    const last6Months: {
      label: string;
      month: number;
      year: number;
      income: number;
      expense: number;
    }[] = []
    const now = new Date()
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      last6Months.push({
        label: d.toLocaleString('es-CO', { month: 'short' }),
        month: d.getMonth(),
        year: d.getFullYear(),
        income: 0,
        expense: 0
      })
    }

    transactionsStore.transactions.forEach(t => {
      if (t.type === 'income') {
        const match = last6Months.find(m => m.month === t.date.getMonth() && m.year === t.date.getFullYear())
        if (match) match.income += convert(Math.abs(t.amount), t.currency)
      } else if (t.type === 'expense') {
        const billing = cardBillingFor.value(t.accountId)
        last6Months.forEach(month => {
          month.expense += convert(expenseAmountForMonth(t, month.year, month.month, billing), t.currency)
        })
      }
    })

    barChart = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: last6Months.map(m => m.label),
        datasets: [
          {
            label: 'Ingresos',
            data: last6Months.map(m => m.income),
            backgroundColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'Gastos',
            data: last6Months.map(m => m.expense),
            backgroundColor: '#f43f5e',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.03)' },
            ticks: {
              color: '#64748b',
              font: { family: 'Plus Jakarta Sans', size: 10 },
              callback: (value) => compactNumber.format(Number(value))
            }
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              boxWidth: 10,
              color: '#94a3b8',
              font: { family: 'Plus Jakarta Sans', size: 10 }
            }
          }
        }
      }
    })
  }
}

// Helpers
const getCategory = (id: string) => {
  return transactionsStore.categories.find(c => c.id === id)
}

const getCategoryIcon = (iconName: string) => {
  const icons: Record<string, any> = {
    Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
    ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank: SavingsIcon, Smartphone,
    Activity, Scissors, BookOpen, Wrench, Shield
  }
  return icons[iconName] || HelpCircle
}

const getAccountName = (id: string) => {
  const acc = accountsStore.getAccountById(id)
  return acc ? getAccountDisplayLabel(acc, accountsStore.accounts) : 'Desconocida'
}

const accountSummaryLabel = (account: Account) => {
  const group = groupAccountsByPocket(accountsStore.accounts, authStore.activeWorkspaceId || undefined)
    .find(item => item.account.id === account.id)
  return group?.pockets.length ? `${account.name} · Disponible` : getAccountDisplayLabel(account, accountsStore.accounts)
}

const displayOf = (tx: Transaction) => getTransactionDisplay(tx, getAccountName)

const getAccountIcon = (type: AccountType) => {
  if (type === 'savings') return SavingsIcon
  if (type === 'credit') return CreditIcon
  if (type === 'cash') return CashIcon
  return BankIcon
}

// Próximos pagos de tarjeta: agregación por ciclo de facturación (no mes calendario),
// ordenados por el vencimiento más cercano. Cuentas sin paymentDueDay configurado no aparecen.
const upcomingCardPayments = computed(() => {
  return accountsStore.accounts
    .filter(acc => acc.type === 'credit' && acc.paymentDueDay)
    .map(acc => {
      const dueDate = getNextOccurrence(acc.paymentDueDay!)
      // Sin statementClosingDay no se puede saber qué cae en el corte: se muestra
      // el recordatorio de fecha sin monto (ver creditCycle.ts).
      // El monto es el del extracto que se paga en dueDate (último corte antes del
      // vencimiento), no el del ciclo en curso: después del corte hoy ya cae en el siguiente.
      const closing = acc.statementClosingDay
        ? getStatementClosingForDueDate(acc.statementClosingDay, dueDate)
        : null
      const amount = closing
        ? transactionsStore.transactions
            .filter(t => t.accountId === acc.id)
            .reduce((sum, t) => sum + expenseAmountForCycle(t, acc.statementClosingDay!, closing), 0)
        : null
      return {
        id: acc.id,
        name: acc.name,
        currency: acc.currency,
        dueDate,
        daysLeft: daysUntil(dueDate),
        debt: Math.max(0, -acc.balance),
        amount
      }
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
})

const formatDate = (dateVal: Date | string) => {
  if (!dateVal) return ''
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal)
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short'
  }).format(d)
}

const formatPrimaryCurrency = (val: number) => {
  return formatCurrency(val, primaryCurrency.value)
}

// Forward-looking KPIs are estimates (pace extrapolation, converted amounts): show whole units.
const formatKpi = (val: number) => formatPrimaryCurrency(Math.round(val))

const formatCurrency = (val: number, currency: string) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(val)
}
</script>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.3s ease-out forwards;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
