<template>
  <div class="max-w-6xl mx-auto space-y-8 pb-12">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">
          Objetivos & Presupuesto
        </h2>
        <p class="text-text-secondary text-sm mt-1">Crea metas de ahorro a largo plazo y define la distribución de tus ingresos mensuales.</p>
      </div>

      <button 
        @click="showCreateModal = true"
        class="inline-flex items-center space-x-2 px-5 py-3 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm transition-all shadow-glow-emerald cursor-pointer"
      >
        <PlusIcon class="w-4 h-4" />
        <span>Nuevo Objetivo</span>
      </button>
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
            class="px-4 py-2 rounded-lg bg-slate-900 border border-border text-xs font-semibold text-text-primary hover:bg-slate-800 transition-colors"
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
            <div class="flex justify-between items-start">
              <div>
                <h4 class="font-display font-bold text-lg text-text-primary truncate max-w-[180px]">{{ goal.name }}</h4>
                <p class="text-[10px] text-text-muted mt-0.5">Meta: {{ formatDate(goal.targetDate) }}</p>
              </div>
              <div class="flex items-center space-x-1.5">
                <button 
                  @click="openContributeModal(goal)"
                  title="Aportar saldo"
                  class="p-2 rounded-lg bg-accent-emerald/10 border border-accent-emerald/20 text-accent-emerald hover:bg-accent-emerald/20 transition-colors cursor-pointer"
                >
                  <PiggyBankIcon class="w-3.5 h-3.5" />
                </button>
                <button 
                  @click="handleDeleteGoal(goal.id)"
                  title="Eliminar meta"
                  class="p-2 rounded-lg bg-accent-rose/10 border border-accent-rose/20 text-accent-rose hover:bg-accent-rose/20 transition-colors cursor-pointer"
                >
                  <TrashIcon class="w-3.5 h-3.5" />
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
              <div class="flex justify-between text-xs pt-1">
                <div>
                  <span class="text-text-muted">Ahorrado:</span>
                  <span class="text-text-primary ml-1 font-semibold">{{ formatCurrency(goal.currentAmount, goal.currency) }}</span>
                </div>
                <div>
                  <span class="text-text-muted">Objetivo:</span>
                  <span class="text-text-secondary ml-1 font-semibold">{{ formatCurrency(goal.targetAmount, goal.currency) }}</span>
                </div>
              </div>
            </div>

            <!-- Goal Footer info -->
            <div class="text-[10px] text-text-secondary bg-slate-950/30 p-2.5 rounded-lg border border-white/5 flex justify-between">
              <span>Restante: {{ formatCurrency(Math.max(goal.targetAmount - goal.currentAmount, 0), goal.currency) }}</span>
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
                min="0"
                class="w-full pl-8 pr-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold"
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
              <span class="font-display font-bold text-lg text-accent-emerald">
                {{ formatCurrency(monthlySavingsAmount, userCurrency) }}
              </span>
            </div>
          </div>

          <!-- Distribution sliders -->
          <div class="space-y-4">
            <!-- Needs Slider (50% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-xs font-semibold">
                <span class="text-text-secondary flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-accent-emerald"></span>
                  Necesidades (50%)
                </span>
                <span class="text-text-primary">{{ formatCurrency(monthlyNeedsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="needsPercent"
                type="range"
                min="0"
                max="100"
                class="w-full accent-accent-emerald cursor-pointer"
                @input="adjustSliders('needs')"
                @change="saveBudget"
              />
            </div>

            <!-- Wants Slider (30% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-xs font-semibold">
                <span class="text-text-secondary flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-accent-violet"></span>
                  Deseos (30%)
                </span>
                <span class="text-text-primary">{{ formatCurrency(monthlyWantsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="wantsPercent"
                type="range"
                min="0"
                max="100"
                class="w-full accent-accent-violet cursor-pointer"
                @input="adjustSliders('wants')"
                @change="saveBudget"
              />
            </div>

            <!-- Savings Slider (20% default) -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-xs font-semibold">
                <span class="text-text-secondary flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-full bg-accent-amber"></span>
                  Ahorro (20%)
                </span>
                <span class="text-text-primary">{{ formatCurrency(monthlySavingsAmount, userCurrency) }}</span>
              </div>
              <input 
                v-model.number="savingsPercent"
                type="range"
                min="0"
                max="100"
                class="w-full accent-accent-amber cursor-pointer"
                @input="adjustSliders('savings')"
                @change="saveBudget"
              />
            </div>
          </div>

          <!-- Total Allocation indicator -->
          <div class="p-3 bg-slate-950/45 border border-white/5 rounded-xl text-center text-xs flex justify-between">
            <span class="text-text-secondary">Suma total porcentajes:</span>
            <span :class="[isPercentSumValid ? 'text-accent-emerald font-bold' : 'text-accent-rose font-bold']">
              {{ needsPercent + wantsPercent + savingsPercent }}%
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Category Budgets (presupuesto mensual recurrente) -->
    <div class="space-y-6">
      <h3 class="font-display font-bold text-xl text-text-primary flex items-center space-x-2">
        <WalletIcon class="w-5 h-5 text-accent-emerald" />
        <span>Presupuesto Mensual por Categoría</span>
      </h3>

      <div class="glass-panel rounded-2xl p-4 sm:p-6 border border-white/5 space-y-4">
        <p class="text-xs text-text-muted">
          Define un límite mensual por categoría. Las barras muestran el gasto real del mes en curso.
          Tip: también puedes pedirle al <span class="text-accent-emerald font-semibold">Asesor IA</span> que analice tus gastos y te proponga presupuestos.
        </p>

        <div v-if="expenseCategories.length === 0" class="text-center py-8 text-text-muted text-sm">
          No hay categorías de gasto creadas.
        </div>

        <div
          v-for="cat in expenseCategories"
          :key="cat.id"
          class="flex flex-col sm:flex-row sm:items-center gap-3 py-3 border-b border-white/5 last:border-0"
        >
          <!-- Category identity -->
          <div class="flex items-center space-x-2.5 sm:w-48 shrink-0">
            <span
              class="p-2 rounded-lg"
              :style="{ backgroundColor: cat.color + '15', color: cat.color }"
            >
              <component :is="getCategoryIcon(cat.icon)" class="w-4 h-4" />
            </span>
            <span class="text-sm font-semibold text-text-primary truncate">{{ cat.name }}</span>
          </div>

          <!-- Limit input -->
          <div class="relative sm:w-40 shrink-0">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-xs font-semibold">$</span>
            <input
              :value="categoryBudgetInputs[cat.id] ?? ''"
              type="number"
              min="0"
              placeholder="Sin límite"
              class="w-full pl-7 pr-3 py-2 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all"
              @change="(e) => saveCategoryBudget(cat.id, (e.target as HTMLInputElement).value)"
            />
          </div>

          <!-- Progress vs real spending -->
          <div class="flex-1 space-y-1">
            <div class="flex justify-between text-[11px] font-semibold">
              <span class="text-text-secondary">
                Gastado: {{ formatCurrency(spendingByCategory[cat.id] || 0, userCurrency) }}
              </span>
              <span v-if="categoryBudgetInputs[cat.id]" :class="budgetPercent(cat.id) > 100 ? 'text-accent-rose' : budgetPercent(cat.id) >= 70 ? 'text-accent-amber' : 'text-accent-emerald'">
                {{ budgetPercent(cat.id) }}%{{ budgetStatusLabel(cat.id) }}
              </span>
            </div>
            <div class="w-full h-2 rounded-full bg-slate-950/60 overflow-hidden border border-white/5">
              <div
                :class="['h-full rounded-full transition-all duration-500', budgetPercent(cat.id) > 100 ? 'bg-accent-rose' : budgetPercent(cat.id) >= 70 ? 'bg-accent-amber' : 'bg-accent-emerald']"
                :style="{ width: Math.min(budgetPercent(cat.id), 100) + '%' }"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 50/30/20 vs realidad del mes -->
      <div class="glass-panel rounded-2xl p-4 sm:p-6 border border-white/5 space-y-4">
        <h4 class="font-display font-semibold text-sm text-text-primary">Tu plan 50/30/20 vs este mes (real)</h4>
        <!-- ponytail: no sabemos qué categorías son "necesidad" vs "deseo"; comparamos gasto total y ahorro reales contra el plan -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div class="space-y-1.5">
            <div class="flex justify-between font-semibold">
              <span class="text-text-secondary">Gasto (plan necesidades+deseos)</span>
              <span class="text-text-primary">{{ formatCurrency(monthlyNeedsAmount + monthlyWantsAmount, userCurrency) }}</span>
            </div>
            <div class="flex justify-between font-semibold">
              <span class="text-text-secondary">Gasto real del mes</span>
              <span :class="realMonthExpense > (monthlyNeedsAmount + monthlyWantsAmount) ? 'text-accent-rose' : 'text-accent-emerald'">
                {{ formatCurrency(realMonthExpense, userCurrency) }}
              </span>
            </div>
          </div>
          <div class="space-y-1.5">
            <div class="flex justify-between font-semibold">
              <span class="text-text-secondary">Ahorro (plan)</span>
              <span class="text-text-primary">{{ formatCurrency(monthlySavingsAmount, userCurrency) }}</span>
            </div>
            <div class="flex justify-between font-semibold">
              <span class="text-text-secondary">Ahorro real del mes</span>
              <span :class="realMonthSavings >= monthlySavingsAmount ? 'text-accent-emerald' : 'text-accent-amber'">
                {{ formatCurrency(realMonthSavings, userCurrency) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal: Create Savings Goal -->
    <div 
      v-if="showCreateModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
    >
      <div class="glass-panel w-full max-w-md rounded-2xl border border-white/10 p-4 sm:p-6 space-y-6 max-h-[90vh] overflow-y-auto">
        <div class="flex justify-between items-center">
          <h3 class="font-display font-bold text-xl text-text-primary">Nuevo Objetivo de Ahorro</h3>
          <button @click="showCreateModal = false" class="text-text-muted hover:text-text-primary cursor-pointer">
            <XIcon class="w-5 h-5" />
          </button>
        </div>

        <form @submit.prevent="handleCreateGoal" class="space-y-4">
          <!-- Goal Name -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-text-secondary">Nombre de la Meta</label>
            <input 
              v-model="newGoalName"
              type="text"
              required
              class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all"
              placeholder="Ej. Comprar un carro nuevo 🚗"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <!-- Target Amount -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">Monto Objetivo</label>
              <input 
                v-model.number="newGoalTargetAmount"
                type="number"
                required
                min="1"
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold"
                placeholder="Monto total"
              />
            </div>

            <!-- Currency -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">Moneda</label>
              <select 
                v-model="newGoalCurrency"
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold cursor-pointer"
              >
                <option value="USD">USD ($)</option>
                <option value="COP">COP ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <!-- Current Amount (Optional) -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">Monto Inicial (Opcional)</label>
              <input 
                v-model.number="newGoalCurrentAmount"
                type="number"
                min="0"
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all"
                placeholder="Ya ahorrado"
              />
            </div>

            <!-- Target Date -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">Fecha Límite</label>
              <input 
                v-model="newGoalTargetDate"
                type="date"
                required
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all cursor-pointer"
              />
            </div>
          </div>

          <!-- Actions -->
          <div class="flex justify-end space-x-3 pt-4 border-t border-white/5">
            <button 
              type="button"
              @click="showCreateModal = false"
              class="px-4 py-2.5 rounded-xl bg-slate-950 border border-white/5 text-xs font-semibold text-text-secondary hover:text-text-primary hover:bg-slate-900 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button 
              type="submit"
              class="px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-xs hover:bg-accent-emerald-hover shadow-glow-emerald cursor-pointer"
            >
              Crear Meta
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: Contribute funds -->
    <div 
      v-if="showContributeModal"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
    >
      <div class="glass-panel w-full max-w-md rounded-2xl border border-white/10 p-4 sm:p-6 space-y-6 max-h-[90vh] overflow-y-auto">
        <div class="flex justify-between items-center">
          <h3 class="font-display font-bold text-xl text-text-primary">Aportar a: {{ selectedGoal?.name }}</h3>
          <button @click="showContributeModal = false" class="text-text-muted hover:text-text-primary cursor-pointer">
            <XIcon class="w-5 h-5" />
          </button>
        </div>

        <form @submit.prevent="handleContribute" class="space-y-4">
          <!-- Selected Account -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-text-secondary">Deducir de la Cuenta</label>
            <select 
              v-model="contributeAccountId"
              required
              class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold cursor-pointer"
            >
              <option value="" disabled>Selecciona una cuenta</option>
              <option 
                v-for="acc in accountsStore.accounts" 
                :key="acc.id" 
                :value="acc.id"
              >
                {{ acc.name }} (Saldo: {{ formatCurrency(acc.balance, acc.currency) }})
              </option>
            </select>
          </div>

          <!-- Contribute Amount -->
          <div class="space-y-1.5">
            <label class="block text-xs font-semibold text-text-secondary">Monto a Aportar</label>
            <div class="relative">
              <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted font-semibold">
                {{ selectedGoal ? (selectedGoal.currency === 'COP' ? '$' : selectedGoal.currency) : '$' }}
              </span>
              <input 
                v-model.number="contributeAmount"
                type="number"
                required
                min="1"
                class="w-full pl-8 pr-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold"
                placeholder="0"
              />
            </div>
            <p class="text-[10px] text-text-muted mt-1">Este aporte se registrará automáticamente como un movimiento en tus transacciones.</p>
          </div>

          <!-- Actions -->
          <div class="flex justify-end space-x-3 pt-4 border-t border-white/5">
            <button 
              type="button"
              @click="showContributeModal = false"
              class="px-4 py-2.5 rounded-xl bg-slate-950 border border-white/5 text-xs font-semibold text-text-secondary hover:text-text-primary hover:bg-slate-900 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button 
              type="submit"
              class="px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-xs hover:bg-accent-emerald-hover shadow-glow-emerald cursor-pointer"
            >
              Realizar Aporte
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useGoalsStore } from '@/stores/goalsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { Goal } from '@/types'
import { expenseAmountForDate } from '@/lib/installments'
import {
  Target as TargetIcon,
  PiggyBank as PiggyBankIcon,
  Trash2 as TrashIcon,
  Plus as PlusIcon,
  X as XIcon,
  Wallet as WalletIcon,
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield
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
const selectedGoal = ref<Goal | null>(null)

// Create Goal inputs
const newGoalName = ref('')
const newGoalTargetAmount = ref<number | null>(null)
const newGoalCurrentAmount = ref(0)
const newGoalCurrency = ref('USD')
const newGoalTargetDate = ref('')

// Contribute inputs
const contributeAccountId = ref('')
const contributeAmount = ref<number | null>(null)

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

const spendingByCategory = computed(() =>
  transactionsStore.spendingByCategoryThisMonth(
    (amount, currency) => goalsStore.convertToPrimary(amount, currency, userCurrency.value)
  )
)

// Gasto/ingreso/ahorro real del mes (monedas convertidas a la principal)
const realMonthTotals = computed(() => {
  const now = new Date()
  let income = 0, expense = 0
  transactionsStore.transactions.forEach(t => {
    if (t.type === 'income') {
      if (t.date.getMonth() !== now.getMonth() || t.date.getFullYear() !== now.getFullYear()) return
      income += goalsStore.convertToPrimary(Math.abs(t.amount), t.currency, userCurrency.value)
    } else if (t.type === 'expense') {
      expense += goalsStore.convertToPrimary(expenseAmountForDate(t, now), t.currency, userCurrency.value)
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
      targetDate: new Date(newGoalTargetDate.value)
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
      type: 'expense'
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
  const limit = categoryBudgetInputs[categoryId]
  if (!limit || limit <= 0) return 0
  return Math.round(((spendingByCategory.value[categoryId] || 0) / limit) * 100)
}

const budgetStatusLabel = (categoryId: string) => {
  const pct = budgetPercent(categoryId)
  if (pct > 100) return ' · ¡Excedido!'
  if (pct === 100) return ' · ¡A tope!'
  return ''
}

const getCategoryIcon = (iconName: string) => {
  const icons: Record<string, any> = {
    Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
    ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
    Activity, Scissors, BookOpen, Wrench, Shield
  }
  return icons[iconName] || HelpCircle
}
</script>

<style scoped>
/* Slider premium adjustments */
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  height: 6px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.08);
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
  border: 2px solid #080c14;
}
</style>
