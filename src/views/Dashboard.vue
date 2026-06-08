<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header / Welcome -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">
          Bóveda de {{ authStore.user?.displayName }}
        </h2>
        <p class="text-text-secondary text-sm mt-1">Aquí tienes el resumen de tu salud financiera actual.</p>
      </div>
      
      <!-- Quick Action Shortcuts -->
      <div class="flex flex-wrap gap-3">
        <router-link 
          to="/transactions" 
          class="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-slate-900 border border-border text-xs font-semibold text-text-primary hover:bg-slate-800 transition-colors"
        >
          <PlusIcon class="w-3.5 h-3.5 text-accent-emerald" />
          <span>Transacción</span>
        </router-link>
        <router-link 
          v-if="settingsStore.aiEnabled" 
          to="/import" 
          class="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-accent-emerald/10 to-accent-violet/10 border border-accent-emerald/20 text-xs font-semibold text-accent-emerald hover:brightness-110 transition-all shadow-glow-emerald"
        >
          <SparklesIcon class="w-3.5 h-3.5" />
          <span>Importar con IA</span>
        </router-link>
      </div>
    </div>

    <!-- Onboarding State if no accounts exist -->
    <div v-if="accountsStore.accounts.length === 0" class="glass-panel rounded-3xl p-12 text-center max-w-2xl mx-auto space-y-6">
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
      <!-- 1. Stats Cards Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <!-- Patrimonio Neto (USD/COP default) -->
        <div class="glass-panel rounded-2xl p-6 relative overflow-hidden group border border-white/5 glow-card-emerald">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-emerald/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Patrimonio Neto</span>
          <h4 class="font-display font-bold text-2xl mt-2 truncate text-text-primary">
            {{ formatPrimaryCurrency(netWorthValue) }}
          </h4>
          <span class="text-[10px] text-text-muted mt-1 block">Suma de saldos de tus cuentas</span>
        </div>

        <!-- Ingresos del Mes -->
        <div class="glass-panel rounded-2xl p-6 relative overflow-hidden group border border-white/5">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-emerald/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Ingresos del Mes</span>
          <h4 class="font-display font-bold text-2xl mt-2 text-accent-emerald truncate">
            +{{ formatPrimaryCurrency(monthlyIncome) }}
          </h4>
          <span class="text-[10px] text-text-muted mt-1 block">Abonos recibidos este mes</span>
        </div>

        <!-- Gastos del Mes -->
        <div class="glass-panel rounded-2xl p-6 relative overflow-hidden group border border-white/5">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-rose/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Gastos del Mes</span>
          <h4 class="font-display font-bold text-2xl mt-2 text-accent-rose truncate">
            {{ formatPrimaryCurrency(monthlyExpenses) }}
          </h4>
          <span class="text-[10px] text-text-muted mt-1 block">Consumos realizados este mes</span>
        </div>

        <!-- Tasa de Ahorro -->
        <div class="glass-panel rounded-2xl p-6 relative overflow-hidden group border border-white/5">
          <div class="absolute top-0 right-0 w-24 h-24 bg-accent-amber/5 rounded-full blur-xl pointer-events-none"></div>
          <span class="text-[10px] font-semibold text-text-secondary uppercase tracking-widest block">Tasa de Ahorro</span>
          <h4 class="font-display font-bold text-2xl mt-2 text-accent-amber truncate">
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
        <div class="glass-panel rounded-2xl p-6 md:col-span-1 flex flex-col justify-between h-96">
          <div>
            <h4 class="font-display font-bold text-base text-text-primary">Distribución de Gastos</h4>
            <p class="text-text-muted text-xs mt-0.5">Gastos acumulados por categoría en el mes.</p>
          </div>
          
          <div class="relative flex-1 flex items-center justify-center p-4">
            <canvas ref="donutCanvas" class="max-h-56"></canvas>
            <p v-if="Object.keys(expensesByCategory).length === 0" class="absolute text-center text-text-muted text-xs py-8">
              No hay gastos registrados este mes.
            </p>
          </div>
        </div>

        <!-- Flujo mensual (Bar Chart) -->
        <div class="glass-panel rounded-2xl p-6 md:col-span-2 flex flex-col justify-between h-96">
          <div>
            <h4 class="font-display font-bold text-base text-text-primary">Flujo de Caja Mensual</h4>
            <p class="text-text-muted text-xs mt-0.5">Comparativo mensual de ingresos y gastos.</p>
          </div>
          
          <div class="relative flex-1 flex items-center justify-center p-4">
            <canvas ref="barCanvas" class="w-full max-h-60"></canvas>
            <p v-if="transactionsStore.transactions.length === 0" class="absolute text-center text-text-muted text-xs py-8">
              No hay movimientos históricos para graficar.
            </p>
          </div>
        </div>
      </div>

      <!-- 3. Recent Transactions & Quick Summary -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Recent Transactions (List) -->
        <div class="glass-panel rounded-2xl p-6 lg:col-span-2 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="font-display font-bold text-base text-text-primary">Transacciones Recientes</h4>
            <router-link to="/transactions" class="text-xs text-accent-emerald font-semibold hover:underline">
              Ver todas
            </router-link>
          </div>

          <div class="space-y-3">
            <div 
              v-for="tx in recentTransactions" 
              :key="tx.id"
              class="flex items-center justify-between p-3 rounded-xl bg-white/[0.01] border border-white/5 hover:border-white/10 transition-all"
            >
              <div class="flex items-center space-x-3 truncate">
                <div 
                  class="w-9 h-9 rounded-lg flex items-center justify-center text-xs"
                  :style="{ backgroundColor: (getCategory(tx.categoryId)?.color || '#94a3b8') + '12', color: getCategory(tx.categoryId)?.color || '#94a3b8' }"
                  v-if="getCategory(tx.categoryId)"
                >
                  <component :is="getCategoryIcon(getCategory(tx.categoryId)?.icon || 'HelpCircle')" class="w-4 h-4" />
                </div>
                <div class="truncate">
                  <p class="text-sm font-semibold text-text-primary truncate">{{ tx.description }}</p>
                  <p class="text-[10px] text-text-secondary mt-0.5">{{ getAccountName(tx.accountId) }} • {{ formatDate(tx.date) }}</p>
                </div>
              </div>

              <span :class="['font-display font-bold text-sm', tx.amount >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
                {{ tx.amount >= 0 ? '+' : '' }}{{ formatCurrency(tx.amount, tx.currency) }}
              </span>
            </div>
            <p v-if="recentTransactions.length === 0" class="text-center text-text-muted text-xs py-6">
              No hay transacciones registradas.
            </p>
          </div>
        </div>

        <!-- Cuentas Bancarias Summary -->
        <div class="glass-panel rounded-2xl p-6 lg:col-span-1 space-y-4">
          <div class="flex items-center justify-between">
            <h4 class="font-display font-bold text-base text-text-primary">Saldos de Cuentas</h4>
            <router-link to="/accounts" class="text-xs text-accent-emerald font-semibold hover:underline">
              Gestionar
            </router-link>
          </div>

          <div class="space-y-3">
            <div 
              v-for="acc in accountsStore.accounts" 
              :key="acc.id"
              class="flex items-center justify-between p-3 rounded-xl bg-white/[0.01] border border-white/5"
            >
              <div class="flex items-center space-x-2.5">
                <component :is="getAccountIcon(acc.type)" class="w-4 h-4 text-text-secondary" />
                <span class="text-sm font-medium text-text-primary truncate max-w-[120px]">{{ acc.name }}</span>
              </div>
              <span :class="['font-display font-semibold text-sm', acc.balance >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
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
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { AccountType } from '@/types'
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

const donutCanvas = ref<HTMLCanvasElement | null>(null)
const barCanvas = ref<HTMLCanvasElement | null>(null)
let donutChart: Chart | null = null
let barChart: Chart | null = null

onMounted(async () => {
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await transactionsStore.fetchTransactions()
  await settingsStore.loadSettings()

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

// Calcular Patrimonio Neto consolidado en la moneda de la primera cuenta o COP por defecto
const netWorthValue = computed(() => {
  const totals = accountsStore.netWorthByCurrency
  const currencies = Object.keys(totals)
  if (currencies.length === 0) return 0
  // Sumamos los saldos tal cual (en una app multi-moneda premium real harías conversiones, 
  // aquí mostramos la suma simplificada o la moneda principal). Mostramos el total de la primera moneda.
  return totals[currencies[0]] || 0
})

const primaryCurrency = computed(() => {
  if (accountsStore.accounts.length === 0) return 'COP'
  return accountsStore.accounts[0].currency || 'COP'
})

// Ingresos del mes actual
const monthlyIncome = computed(() => {
  const now = new Date()
  return transactionsStore.transactions
    .filter(t => t.type === 'income' && t.date.getMonth() === now.getMonth() && t.date.getFullYear() === now.getFullYear())
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)
})

// Gastos del mes actual
const monthlyExpenses = computed(() => {
  const now = new Date()
  return transactionsStore.transactions
    .filter(t => t.type === 'expense' && t.date.getMonth() === now.getMonth() && t.date.getFullYear() === now.getFullYear())
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)
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

// Agrupación de gastos por categoría para el gráfico de dona
const expensesByCategory = computed(() => {
  const now = new Date()
  const currentMonthExpenses = transactionsStore.transactions.filter(
    t => t.type === 'expense' && t.date.getMonth() === now.getMonth() && t.date.getFullYear() === now.getFullYear()
  )

  const groups: Record<string, number> = {}
  currentMonthExpenses.forEach(t => {
    const cat = getCategory(t.categoryId)
    const name = cat ? cat.name : 'Otros'
    if (!groups[name]) groups[name] = 0
    groups[name] += Math.abs(t.amount)
  })
  return groups
})

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
      const txDate = t.date
      const match = last6Months.find(m => m.month === txDate.getMonth() && m.year === txDate.getFullYear())
      if (match) {
        if (t.type === 'income') match.income += Math.abs(t.amount)
        if (t.type === 'expense') match.expense += Math.abs(t.amount)
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
            ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
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
  return acc ? acc.name : 'Desconocida'
}

const getAccountIcon = (type: AccountType) => {
  if (type === 'savings') return SavingsIcon
  if (type === 'credit') return CreditIcon
  if (type === 'cash') return CashIcon
  return BankIcon
}

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
