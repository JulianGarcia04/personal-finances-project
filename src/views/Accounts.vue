<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">Cuentas Financieras</h2>
        <p class="text-text-secondary text-sm mt-1">Registra tus cuentas bancarias, tarjetas de crédito y efectivo.</p>
      </div>
      <button 
        @click="showAddModal = true"
        class="flex items-center justify-center space-x-2 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer transition-all duration-200"
      >
        <PlusIcon class="w-4 h-4" />
        <span>Agregar Cuenta</span>
      </button>
    </div>

    <!-- Summary of net worth by currency -->
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
      <div 
        v-for="(total, cur) in accountsStore.netWorthByCurrency" 
        :key="cur"
        class="glass-panel rounded-2xl p-4 sm:p-6 relative overflow-hidden group hover:border-white/10 transition-all"
      >
        <div class="absolute top-0 right-0 w-32 h-32 bg-accent-emerald/5 rounded-full blur-2xl pointer-events-none"></div>
        <span class="text-xs font-semibold text-text-secondary uppercase tracking-widest">Patrimonio Neto ({{ cur }})</span>
        <h3 :class="['font-display font-bold text-3xl mt-2', total >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
          {{ formatCurrency(total, cur) }}
        </h3>
      </div>
      <div v-if="Object.keys(accountsStore.netWorthByCurrency).length === 0" class="glass-panel rounded-2xl p-6 col-span-full text-center">
        <p class="text-text-muted text-sm py-4">No hay cuentas registradas. Agrega una para comenzar.</p>
      </div>
    </div>

    <!-- Accounts Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div 
        v-for="account in accountsStore.accounts" 
        :key="account.id"
        :class="['glass-panel rounded-2xl p-4 sm:p-6 flex flex-col justify-between h-52 transition-all relative overflow-hidden group border border-white/5', getGlowClass(account.type)]"
      >
        <!-- Background light blur -->
        <div :class="['absolute top-0 right-0 w-24 h-24 rounded-full blur-xl opacity-20 pointer-events-none', getOrbBgClass(account.type)]"></div>

        <!-- Card Top Details -->
        <div>
          <div class="flex items-start justify-between">
            <div class="p-3 rounded-xl bg-white/5 border border-white/5">
              <component :is="getAccountIcon(account.type)" class="w-6 h-6 text-text-secondary" />
            </div>
            
            <button 
              @click="handleDelete(account.id, account.name)"
              class="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-text-muted hover:text-accent-rose hover:bg-white/5 transition-all"
              title="Eliminar Cuenta"
            >
              <TrashIcon class="w-4 h-4" />
            </button>
          </div>

          <h4 class="font-display font-bold text-lg text-text-primary mt-4 truncate">{{ account.name }}</h4>
          <p class="text-xs text-text-secondary uppercase tracking-wide mt-1">{{ formatType(account.type) }}</p>
        </div>

        <!-- Card Bottom Details -->
        <div class="border-t border-border/50 pt-3 flex items-end justify-between mt-4">
          <div>
            <span class="text-[10px] text-text-muted font-medium block">SALDO DISPONIBLE</span>
            <span :class="['font-display font-bold text-xl mt-1 block', account.balance >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
              {{ formatCurrency(account.balance, account.currency) }}
            </span>
          </div>
          
          <div v-if="account.type === 'credit' && account.limit > 0" class="text-right">
            <span class="text-[10px] text-text-muted font-medium block">LÍMITE</span>
            <span class="text-xs text-text-secondary font-semibold mt-1 block">
              {{ formatCurrency(account.limit, account.currency) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Account Modal -->
    <div 
      v-if="showAddModal" 
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel rounded-3xl p-4 sm:p-6 md:p-8 shadow-2xl relative border border-white/10 animate-scale-up max-h-[90vh] overflow-y-auto">
        <!-- Close Button -->
        <button 
          @click="closeAddModal"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-2">Agregar Cuenta</h3>
        <p class="text-text-secondary text-xs mb-6">Configura los detalles de tu nueva cuenta bancaria o de efectivo.</p>

        <form @submit.prevent="saveAccount" class="space-y-4">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Nombre de la Cuenta</label>
            <input 
              v-model="newAcc.name" 
              type="text" 
              required
              placeholder="Ej. Tarjeta Visa Oro, Ahorros Bancolombia"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald"
            />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo de Cuenta</label>
              <select 
                v-model="newAcc.type"
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="checking">Corriente</option>
                <option value="savings">Ahorros</option>
                <option value="credit">Tarjeta Crédito</option>
                <option value="cash">Efectivo</option>
              </select>
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Moneda Base</label>
              <input 
                v-model="newAcc.currency"
                type="text"
                required
                placeholder="COP, USD, EUR"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary uppercase focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Saldo Inicial</label>
              <input 
                v-model.number="newAcc.balance"
                type="number"
                step="any"
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>

            <div v-if="newAcc.type === 'credit'" class="space-y-1 animate-fade-in">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cupo/Límite de Crédito</label>
              <input 
                v-model.number="newAcc.limit"
                type="number"
                step="any"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <!-- Buttons -->
          <div class="flex space-x-3 pt-4">
            <button 
              type="button" 
              @click="closeAddModal"
              class="w-1/2 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              :disabled="loading"
              class="w-1/2 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50"
            >
              <span>Guardar</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAccountsStore } from '@/stores/accountsStore'
import { AccountType } from '@/types'
import { AccountSchema } from '@/schemas'
import { 
  Plus as PlusIcon, 
  Trash2 as TrashIcon, 
  X as XIcon,
  PiggyBank as SavingsIcon, 
  CreditCard as CreditIcon, 
  Wallet as CashIcon, 
  Building as BankIcon 
} from 'lucide-vue-next'

const accountsStore = useAccountsStore()

const showAddModal = ref(false)
const loading = ref(false)
const newAcc = ref<{
  name: string;
  type: AccountType;
  balance: number;
  limit: number;
  currency: string;
}>({
  name: '',
  type: 'savings',
  balance: 0,
  limit: 0,
  currency: 'COP'
})

onMounted(async () => {
  await accountsStore.fetchAccounts()
})

const closeAddModal = () => {
  showAddModal.value = false
  newAcc.value = {
    name: '',
    type: 'savings',
    balance: 0,
    limit: 0,
    currency: 'COP'
  }
}

const saveAccount = async () => {
  // Zod Validation
  const validation = AccountSchema.safeParse({
    name: newAcc.value.name,
    type: newAcc.value.type,
    balance: newAcc.value.balance,
    limit: newAcc.value.limit,
    currency: newAcc.value.currency.toUpperCase()
  })

  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  loading.value = true
  try {
    await accountsStore.addAccount({
      name: newAcc.value.name,
      type: newAcc.value.type,
      balance: newAcc.value.balance,
      limit: newAcc.value.limit,
      currency: newAcc.value.currency.toUpperCase()
    })
    closeAddModal()
  } catch (err) {
    console.error('Error al guardar cuenta:', err)
  } finally {
    loading.value = false
  }
}

const handleDelete = async (id: string, name: string) => {
  if (confirm(`¿Estás seguro de que deseas eliminar la cuenta "${name}"? Todas las transacciones asociadas ya no estarán vinculadas.`)) {
    try {
      await accountsStore.deleteAccount(id)
    } catch (err) {
      console.error('Error al borrar cuenta:', err)
    }
  }
}

// Helpers visuales
const getGlowClass = (type: AccountType) => {
  if (type === 'savings') return 'glow-card-emerald'
  if (type === 'credit') return 'glow-card-rose'
  return 'glow-card-amber'
}

const getOrbBgClass = (type: AccountType) => {
  if (type === 'savings') return 'bg-accent-emerald'
  if (type === 'credit') return 'bg-accent-rose'
  return 'bg-accent-amber'
}

const getAccountIcon = (type: AccountType) => {
  if (type === 'savings') return SavingsIcon
  if (type === 'credit') return CreditIcon
  if (type === 'cash') return CashIcon
  return BankIcon
}

const formatType = (type: AccountType) => {
  const types: Record<AccountType, string> = {
    checking: 'Cuenta Corriente',
    savings: 'Cuenta de Ahorros',
    credit: 'Tarjeta de Crédito',
    cash: 'Efectivo / Cash'
  }
  return types[type] || 'Otro'
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
.animate-scale-up {
  animation: scaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes scaleUp {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
