<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">Historial de Transacciones</h2>
        <p class="text-text-secondary text-sm mt-1">Registra movimientos o filtra tu historial financiero completo.</p>
      </div>
      <button 
        @click="showAddModal = true"
        class="flex items-center justify-center space-x-2 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer transition-all duration-200"
      >
        <PlusIcon class="w-4 h-4" />
        <span>Nueva Transacción</span>
      </button>
    </div>

    <!-- Filters Pane -->
    <div class="glass-panel rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
      <!-- Search Input -->
      <div class="space-y-1">
        <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Buscar por descripción</label>
        <input 
          v-model="filters.search" 
          type="text" 
          placeholder="Ej. Supermercado, Nomina..."
          class="w-full px-4 py-2 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald"
        />
      </div>

      <!-- Account Filter -->
      <div class="space-y-1">
        <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cuenta</label>
        <select 
          v-model="filters.accountId"
          class="w-full px-3 py-2 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
        >
          <option value="">Todas las cuentas</option>
          <option v-for="acc in accountsStore.accounts" :key="acc.id" :value="acc.id">
            {{ acc.name }} ({{ acc.currency }})
          </option>
        </select>
      </div>

      <!-- Category Filter -->
      <div class="space-y-1">
        <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Categoría</label>
        <select 
          v-model="filters.categoryId"
          class="w-full px-3 py-2 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
        >
          <option value="">Todas las categorías</option>
          <option v-for="cat in transactionsStore.categories" :key="cat.id" :value="cat.id">
            {{ cat.name }}
          </option>
        </select>
      </div>

      <!-- Type Filter -->
      <div class="space-y-1">
        <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Tipo</label>
        <select 
          v-model="filters.type"
          class="w-full px-3 py-2 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
        >
          <option value="">Todos los tipos</option>
          <option value="income">Ingreso</option>
          <option value="expense">Gasto</option>
          <option value="transfer">Transferencia</option>
        </select>
      </div>
    </div>

    <!-- Transactions List Table -->
    <div class="glass-panel rounded-3xl overflow-hidden shadow-xl border border-white/5">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-border/50 text-[10px] font-semibold text-text-secondary uppercase tracking-wider bg-slate-900/30">
              <th class="py-4 px-6">Detalles / Comercio</th>
              <th class="py-4 px-6">Cuenta</th>
              <th class="py-4 px-6">Categoría</th>
              <th class="py-4 px-6">Fecha</th>
              <th class="py-4 px-6 text-right">Monto</th>
              <th class="py-4 px-6 text-center w-24">Acciones</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/30">
            <tr 
              v-for="tx in displayedTransactions" 
              :key="tx.id"
              class="hover:bg-white/[0.02] transition-colors text-sm text-text-primary group"
            >
              <!-- Description -->
              <td class="py-4 px-6 font-medium">
                <div class="truncate max-w-xs md:max-w-md">{{ tx.description }}</div>
              </td>
              <!-- Account -->
              <td class="py-4 px-6 text-text-secondary">
                {{ getAccountName(tx.accountId) }}
              </td>
              <!-- Category -->
              <td class="py-4 px-6">
                <span 
                  v-if="getCategory(tx.categoryId)"
                  class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                  :style="{ backgroundColor: (getCategory(tx.categoryId)?.color || '#94a3b8') + '15', color: getCategory(tx.categoryId)?.color || '#94a3b8' }"
                >
                  <component :is="getCategoryIcon(getCategory(tx.categoryId)?.icon || 'HelpCircle')" class="w-3.5 h-3.5" />
                  <span>{{ getCategory(tx.categoryId)?.name }}</span>
                </span>
                <span v-else class="text-text-muted text-xs">-</span>
              </td>
              <!-- Date -->
              <td class="py-4 px-6 text-text-secondary">
                {{ formatDate(tx.date) }}
              </td>
              <!-- Amount -->
              <td :class="['py-4 px-6 text-right font-display font-semibold', tx.amount >= 0 ? 'text-accent-emerald' : 'text-accent-rose']">
                {{ tx.amount >= 0 ? '+' : '' }}{{ formatCurrency(tx.amount, tx.currency) }}
              </td>
              <!-- Actions -->
              <td class="py-4 px-6 text-center">
                <div class="flex items-center justify-center space-x-2">
                  <a 
                    v-if="tx.receiptUrl"
                    :href="tx.receiptUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="p-2 rounded-lg text-text-muted hover:text-accent-emerald hover:bg-white/5 transition-all inline-block"
                    title="Ver Comprobante"
                  >
                    <PaperclipIcon class="w-4 h-4" />
                  </a>
                  <button 
                    @click="openEditModal(tx)"
                    class="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-text-muted hover:text-accent-emerald hover:bg-white/5 transition-all"
                    title="Editar Transacción"
                  >
                    <PencilIcon class="w-4 h-4" />
                  </button>
                  <button 
                    @click="handleDelete(tx.id)"
                    class="opacity-0 group-hover:opacity-100 p-2 rounded-lg text-text-muted hover:text-accent-rose hover:bg-white/5 transition-all"
                    title="Eliminar Transacción"
                  >
                    <TrashIcon class="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="displayedTransactions.length === 0">
              <td colspan="6" class="text-center py-12 text-text-muted text-sm">
                No hay transacciones registradas que coincidan con los filtros.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add Transaction Modal -->
    <div 
      v-if="showAddModal" 
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel rounded-3xl p-6 md:p-8 shadow-2xl relative border border-white/10 animate-scale-up">
        <!-- Close Button -->
        <button 
          @click="closeAddModal"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-2">Nueva Transacción</h3>
        <p class="text-text-secondary text-xs mb-6">Registra un movimiento manual en tus cuentas.</p>

        <form @submit.prevent="saveTransaction" class="space-y-4">
          <!-- Type Toggle -->
          <div class="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-900/80 border border-border">
            <button 
              type="button"
              @click="newTx.type = 'expense'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', newTx.type === 'expense' ? 'bg-accent-rose/10 text-accent-rose border border-accent-rose/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Gasto
            </button>
            <button 
              type="button"
              @click="newTx.type = 'income'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', newTx.type === 'income' ? 'bg-accent-emerald/10 text-accent-emerald border border-accent-emerald/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Ingreso
            </button>
            <button 
              type="button"
              @click="newTx.type = 'transfer'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', newTx.type === 'transfer' ? 'bg-accent-amber/10 text-accent-amber border border-accent-amber/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Transferencia
            </button>
          </div>

          <!-- Account select -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                {{ newTx.type === 'transfer' ? 'Desde Cuenta' : 'Cuenta' }}
              </label>
              <select 
                v-model="newTx.accountId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona cuenta</option>
                <option v-for="acc in accountsStore.accounts" :key="acc.id" :value="acc.id">
                  {{ acc.name }} ({{ acc.currency }})
                </option>
              </select>
            </div>

            <!-- Destination Account (Transfer only) -->
            <div v-if="newTx.type === 'transfer'" class="space-y-1 animate-fade-in">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Hacia Cuenta</label>
              <select 
                v-model="newTx.toAccountId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona cuenta</option>
                <option v-for="acc in availableDestinationAccounts" :key="acc.id" :value="acc.id">
                  {{ acc.name }} ({{ acc.currency }})
                </option>
              </select>
            </div>

            <!-- Category (Expense/Income only) -->
            <div v-else class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Categoría</label>
              <select 
                v-model="newTx.categoryId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona categoría</option>
                <option v-for="cat in availableCategories" :key="cat.id" :value="cat.id">
                  {{ cat.name }}
                </option>
              </select>
            </div>
          </div>

          <!-- Description and amount -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Monto</label>
              <input 
                v-model.number="newTx.amount" 
                type="number" 
                step="any"
                required
                min="0.01"
                placeholder="0.00"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Fecha</label>
              <input 
                v-model="newTx.date" 
                type="date" 
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Descripción / Comercio</label>
            <input 
              v-model="newTx.description" 
              type="text" 
              required
              placeholder="Ej. Compra de mercado, Pago de salario"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
            />
          </div>

          <!-- Receipt upload -->
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider block">Comprobante (Opcional)</label>
            <div class="flex items-center space-x-3">
              <label 
                class="flex items-center justify-center space-x-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs font-semibold text-text-secondary hover:text-text-primary cursor-pointer transition-all duration-200"
              >
                <PaperclipIcon class="w-3.5 h-3.5" />
                <span>{{ uploadingReceipt ? 'Subiendo...' : selectedFileName || 'Adjuntar comprobante' }}</span>
                <input 
                  type="file" 
                  ref="receiptInput"
                  accept="image/*,application/pdf"
                  class="hidden" 
                  @change="handleReceiptSelect"
                  :disabled="uploadingReceipt"
                />
              </label>
              <button 
                v-if="uploadedReceiptUrl"
                type="button"
                @click="clearReceipt"
                class="text-xs text-accent-rose font-semibold hover:underline cursor-pointer"
              >
                Eliminar
              </button>
            </div>
            <!-- Upload progress bar -->
            <div v-if="uploadingReceipt" class="w-full bg-slate-950 rounded-full h-1 mt-1 overflow-hidden">
              <div class="bg-accent-emerald h-full animate-pulse" style="width: 100%"></div>
            </div>
            <p v-if="receiptError" class="text-[10px] text-accent-rose font-semibold mt-0.5">{{ receiptError }}</p>
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
              <span>Registrar</span>
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Transaction Modal -->
    <div 
      v-if="showEditModal" 
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
    >
      <div class="w-full max-w-md glass-panel rounded-3xl p-6 md:p-8 shadow-2xl relative border border-white/10 animate-scale-up">
        <!-- Close Button -->
        <button 
          @click="closeEditModal"
          class="absolute top-4 right-4 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <h3 class="font-display font-bold text-2xl text-text-primary mb-2">Editar Transacción</h3>
        <p class="text-text-secondary text-xs mb-6">Modifica los detalles de este movimiento.</p>

        <form @submit.prevent="saveEditedTransaction" class="space-y-4">
          <!-- Type Toggle -->
          <div class="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-900/80 border border-border">
            <button 
              type="button"
              @click="editTx.type = 'expense'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', editTx.type === 'expense' ? 'bg-accent-rose/10 text-accent-rose border border-accent-rose/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Gasto
            </button>
            <button 
              type="button"
              @click="editTx.type = 'income'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', editTx.type === 'income' ? 'bg-accent-emerald/10 text-accent-emerald border border-accent-emerald/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Ingreso
            </button>
            <button 
              type="button"
              @click="editTx.type = 'transfer'"
              :class="['py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer', editTx.type === 'transfer' ? 'bg-accent-amber/10 text-accent-amber border border-accent-amber/20' : 'text-text-secondary hover:text-text-primary']"
            >
              Transferencia
            </button>
          </div>

          <!-- Account select -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                {{ editTx.type === 'transfer' ? 'Desde Cuenta' : 'Cuenta' }}
              </label>
              <select 
                v-model="editTx.accountId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona cuenta</option>
                <option v-for="acc in accountsStore.accounts" :key="acc.id" :value="acc.id">
                  {{ acc.name }} ({{ acc.currency }})
                </option>
              </select>
            </div>

            <!-- Destination Account (Transfer only) -->
            <div v-if="editTx.type === 'transfer'" class="space-y-1 animate-fade-in">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Hacia Cuenta</label>
              <select 
                v-model="editTx.toAccountId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona cuenta</option>
                <option v-for="acc in availableEditDestinationAccounts" :key="acc.id" :value="acc.id">
                  {{ acc.name }} ({{ acc.currency }})
                </option>
              </select>
            </div>

            <!-- Category (Expense/Income only) -->
            <div v-else class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Categoría</label>
              <select 
                v-model="editTx.categoryId"
                required
                class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              >
                <option value="" disabled>Selecciona categoría</option>
                <option v-for="cat in availableEditCategories" :key="cat.id" :value="cat.id">
                  {{ cat.name }}
                </option>
              </select>
            </div>
          </div>

          <!-- Description and amount -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Monto</label>
              <input 
                v-model.number="editTx.amount" 
                type="number" 
                step="any"
                required
                min="0.01"
                placeholder="0.00"
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>

            <div class="space-y-1">
              <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Fecha</label>
              <input 
                v-model="editTx.date" 
                type="date" 
                required
                class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
              />
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Descripción / Comercio</label>
            <input 
              v-model="editTx.description" 
              type="text" 
              required
              placeholder="Ej. Compra de mercado, Pago de salario"
              class="w-full px-4 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
            />
          </div>

          <!-- Receipt upload -->
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider block">Comprobante (Opcional)</label>
            <div class="flex items-center space-x-3">
              <label 
                class="flex items-center justify-center space-x-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs font-semibold text-text-secondary hover:text-text-primary cursor-pointer transition-all duration-200"
              >
                <PaperclipIcon class="w-3.5 h-3.5" />
                <span>{{ editUploadingReceipt ? 'Subiendo...' : editSelectedFileName || 'Adjuntar comprobante' }}</span>
                <input 
                  type="file" 
                  ref="editReceiptInput"
                  accept="image/*,application/pdf"
                  class="hidden" 
                  @change="handleEditReceiptSelect"
                  :disabled="editUploadingReceipt"
                />
              </label>
              <button 
                v-if="editUploadedReceiptUrl"
                type="button"
                @click="clearEditReceipt"
                class="text-xs text-accent-rose font-semibold hover:underline cursor-pointer"
              >
                Eliminar
              </button>
            </div>
            <!-- Upload progress bar -->
            <div v-if="editUploadingReceipt" class="w-full bg-slate-950 rounded-full h-1 mt-1 overflow-hidden">
              <div class="bg-accent-emerald h-full animate-pulse" style="width: 100%"></div>
            </div>
            <p v-if="editReceiptError" class="text-[10px] text-accent-rose font-semibold mt-0.5">{{ editReceiptError }}</p>
          </div>

          <!-- Buttons -->
          <div class="flex space-x-3 pt-4">
            <button 
              type="button" 
              @click="closeEditModal"
              class="w-1/2 py-2.5 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              :disabled="loading || editUploadingReceipt"
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
import { ref, reactive, computed, onMounted } from 'vue'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { TransactionType } from '@/types'
import { TransactionSchema } from '@/schemas'
import { 
  Plus as PlusIcon, 
  Trash2 as TrashIcon, 
  X as XIcon,
  Paperclip as PaperclipIcon,
  Pencil as PencilIcon,
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield
} from 'lucide-vue-next'

const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()

const showAddModal = ref(false)
const loading = ref(false)

const filters = reactive({
  search: '',
  accountId: '',
  categoryId: '',
  type: ''
})

// Receipt refs
const receiptInput = ref<HTMLInputElement | null>(null)
const selectedFileName = ref('')
const uploadedReceiptUrl = ref('')
const uploadingReceipt = ref(false)
const receiptError = ref('')

const newTx = ref<{
  type: TransactionType;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  amount: number | null;
  date: string;
  description: string;
}>({
  type: 'expense',
  accountId: '',
  toAccountId: '',
  categoryId: '',
  amount: null,
  date: new Date().toISOString().substring(0, 10),
  description: ''
})

// Edit Transaction modal state
const showEditModal = ref(false)
const editingTxId = ref('')
const editTx = ref<{
  type: TransactionType;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  amount: number | null;
  date: string;
  description: string;
}>({
  type: 'expense',
  accountId: '',
  toAccountId: '',
  categoryId: '',
  amount: null,
  date: new Date().toISOString().substring(0, 10),
  description: ''
})

// Edit Receipt refs
const editReceiptInput = ref<HTMLInputElement | null>(null)
const editSelectedFileName = ref('')
const editUploadedReceiptUrl = ref('')
const editUploadingReceipt = ref(false)
const editReceiptError = ref('')

// Computed properties for Edit Modal
const availableEditDestinationAccounts = computed(() => {
  return accountsStore.accounts.filter(a => a.id !== editTx.value.accountId)
})

const availableEditCategories = computed(() => {
  const type = editTx.value.type
  return transactionsStore.categories.filter(c => c.type === type || c.type === 'both')
})

onMounted(async () => {
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await transactionsStore.fetchTransactions()
})

const displayedTransactions = computed(() => {
  return transactionsStore.filteredTransactions(filters)
})

// Filtrar cuentas destino (transferencias) excluyendo la origen
const availableDestinationAccounts = computed(() => {
  return accountsStore.accounts.filter(a => a.id !== newTx.value.accountId)
})

// Filtrar categorías según tipo seleccionado (ingreso o gasto)
const availableCategories = computed(() => {
  const type = newTx.value.type
  return transactionsStore.categories.filter(c => c.type === type || c.type === 'both')
})

const closeAddModal = () => {
  showAddModal.value = false
  newTx.value = {
    type: 'expense',
    accountId: '',
    toAccountId: '',
    categoryId: '',
    amount: null,
    date: new Date().toISOString().substring(0, 10),
    description: ''
  }
  clearReceipt()
}

const saveTransaction = async () => {
  const parsedAmount = Number(newTx.value.amount || 0)
  let finalAmount = parsedAmount
  if (newTx.value.type === 'expense') {
    finalAmount = -Math.abs(parsedAmount)
  } else if (newTx.value.type === 'income') {
    finalAmount = Math.abs(parsedAmount)
  }

  // Zod Validation
  const validation = TransactionSchema.safeParse({
    accountId: newTx.value.accountId,
    amount: finalAmount,
    description: newTx.value.description,
    categoryId: newTx.value.type === 'transfer' ? '' : newTx.value.categoryId,
    date: new Date(newTx.value.date + 'T12:00:00'),
    type: newTx.value.type,
    toAccountId: newTx.value.type === 'transfer' ? newTx.value.toAccountId : null,
    receiptUrl: uploadedReceiptUrl.value || null
  })

  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  loading.value = true
  try {
    await transactionsStore.addTransaction({
      accountId: newTx.value.accountId,
      amount: finalAmount,
      description: newTx.value.description,
      categoryId: newTx.value.type === 'transfer' ? '' : newTx.value.categoryId,
      date: new Date(newTx.value.date + 'T12:00:00'),
      type: newTx.value.type,
      toAccountId: newTx.value.type === 'transfer' ? newTx.value.toAccountId : null,
      receiptUrl: uploadedReceiptUrl.value || null
    })
    closeAddModal()
  } catch (err: any) {
    console.error('Error guardando transacción:', err)
  } finally {
    loading.value = false
  }
}

const openEditModal = (tx: any) => {
  editingTxId.value = tx.id
  editTx.value = {
    type: tx.type,
    accountId: tx.accountId,
    toAccountId: tx.toAccountId || '',
    categoryId: tx.categoryId || '',
    amount: Math.abs(tx.amount),
    date: tx.date instanceof Date 
      ? tx.date.toISOString().substring(0, 10) 
      : new Date(tx.date).toISOString().substring(0, 10),
    description: tx.description
  }
  editUploadedReceiptUrl.value = tx.receiptUrl || ''
  editSelectedFileName.value = tx.receiptUrl ? 'Comprobante adjunto' : ''
  editReceiptError.value = ''
  showEditModal.value = true
}

const closeEditModal = () => {
  showEditModal.value = false
  editingTxId.value = ''
  editTx.value = {
    type: 'expense',
    accountId: '',
    toAccountId: '',
    categoryId: '',
    amount: null,
    date: new Date().toISOString().substring(0, 10),
    description: ''
  }
  clearEditReceipt()
}

const saveEditedTransaction = async () => {
  const parsedAmount = Number(editTx.value.amount || 0)
  let finalAmount = parsedAmount
  if (editTx.value.type === 'expense') {
    finalAmount = -Math.abs(parsedAmount)
  } else if (editTx.value.type === 'income') {
    finalAmount = Math.abs(parsedAmount)
  }

  // Zod Validation
  const validation = TransactionSchema.safeParse({
    accountId: editTx.value.accountId,
    amount: finalAmount,
    description: editTx.value.description,
    categoryId: editTx.value.type === 'transfer' ? '' : editTx.value.categoryId,
    date: new Date(editTx.value.date + 'T12:00:00'),
    type: editTx.value.type,
    toAccountId: editTx.value.type === 'transfer' ? editTx.value.toAccountId : null,
    receiptUrl: editUploadedReceiptUrl.value || null
  })

  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  loading.value = true
  try {
    await transactionsStore.updateTransaction(editingTxId.value, {
      accountId: editTx.value.accountId,
      amount: finalAmount,
      description: editTx.value.description,
      categoryId: editTx.value.type === 'transfer' ? '' : editTx.value.categoryId,
      date: new Date(editTx.value.date + 'T12:00:00'),
      type: editTx.value.type,
      toAccountId: editTx.value.type === 'transfer' ? editTx.value.toAccountId : null,
      receiptUrl: editUploadedReceiptUrl.value || null
    })
    closeEditModal()
  } catch (err: any) {
    console.error('Error actualizando transacción:', err)
  } finally {
    loading.value = false
  }
}

const handleEditReceiptSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  if (file.size > 5 * 1024 * 1024) {
    editReceiptError.value = 'El archivo supera el límite de 5MB.'
    return
  }

  editReceiptError.value = ''
  editSelectedFileName.value = file.name
  editUploadingReceipt.value = true

  try {
    const url = await transactionsStore.uploadReceipt(file)
    editUploadedReceiptUrl.value = url
  } catch (err: any) {
    console.error('Error al subir comprobante:', err)
    editReceiptError.value = 'Error al subir archivo a Storage.'
    editSelectedFileName.value = ''
  } finally {
    editUploadingReceipt.value = false
  }
}

const clearEditReceipt = () => {
  editUploadedReceiptUrl.value = ''
  editSelectedFileName.value = ''
  editReceiptError.value = ''
  if (editReceiptInput.value) {
    editReceiptInput.value.value = ''
  }
}

const handleDelete = async (id: string) => {
  if (confirm('¿Estás seguro de que deseas eliminar este movimiento? El saldo de la cuenta asociada se actualizará correspondientemente.')) {
    try {
      await transactionsStore.deleteTransaction(id)
    } catch (err) {
      console.error('Error al borrar movimiento:', err)
    }
  }
}

// Helpers
const getAccountName = (id: string) => {
  const acc = accountsStore.getAccountById(id)
  return acc ? acc.name : 'Desconocida'
}

const getCategory = (id: string) => {
  return transactionsStore.categories.find(c => c.id === id)
}

const getCategoryIcon = (iconName: string) => {
  const icons: Record<string, any> = {
    Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
    ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
    Activity, Scissors, BookOpen, Wrench, Shield
  }
  return icons[iconName] || HelpCircle
}

const formatDate = (dateVal: Date | string) => {
  if (!dateVal) return ''
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal)
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(d)
}

const formatCurrency = (val: number, currency: string) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currency || 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(val)
}

// Receipt helpers
const handleReceiptSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  if (file.size > 5 * 1024 * 1024) {
    receiptError.value = 'El archivo supera el límite de 5MB.'
    return
  }

  receiptError.value = ''
  selectedFileName.value = file.name
  uploadingReceipt.value = true

  try {
    const url = await transactionsStore.uploadReceipt(file)
    uploadedReceiptUrl.value = url
  } catch (err: any) {
    console.error('Error al subir comprobante:', err)
    receiptError.value = 'Error al subir archivo a Storage.'
    selectedFileName.value = ''
  } finally {
    uploadingReceipt.value = false
  }
}

const clearReceipt = () => {
  uploadedReceiptUrl.value = ''
  selectedFileName.value = ''
  receiptError.value = ''
  if (receiptInput.value) {
    receiptInput.value.value = ''
  }
}
</script>

<style scoped>
.animate-scale-up {
  animation: scaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
.animate-fade-in {
  animation: fadeIn 0.2s ease-out forwards;
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
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
