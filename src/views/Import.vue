<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div>
      <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">Importador Inteligente con IA</h2>
      <p class="text-text-secondary text-sm mt-1">Carga o pega el extracto de tus cuentas y deja que Gemini organice tus gastos.</p>
    </div>

    <!-- Step 1: Input Setup -->
    <div v-if="!parsedTransactions.length" class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Configuration Panel -->
      <div class="md:col-span-1 space-y-6">
        <div class="glass-panel rounded-2xl p-6 space-y-4">
          <h3 class="font-display font-semibold text-lg text-text-primary">1. Destino de los datos</h3>
          <p class="text-text-muted text-xs leading-relaxed">Selecciona a qué cuenta deseas registrar los movimientos extraídos por la IA.</p>
          
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-text-secondary uppercase tracking-wider">Cuenta Destino</label>
            <select 
              v-model="targetAccountId"
              class="w-full px-3 py-2.5 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary focus:outline-none focus:border-accent-emerald"
            >
              <option value="" disabled>Selecciona una cuenta</option>
              <option v-for="acc in accountsStore.accounts" :key="acc.id" :value="acc.id">
                {{ acc.name }} ({{ acc.currency }})
              </option>
            </select>
          </div>

          <div class="border-t border-border/50 pt-4 space-y-2">
            <div class="flex items-center justify-between text-xs">
              <span class="text-text-secondary">Método Activo:</span>
              <span class="font-semibold text-accent-emerald">
                {{ settingsStore.useCustomKey ? 'API Key Personal' : 'API Key del Proyecto' }}
              </span>
            </div>
            <p v-if="settingsStore.useCustomKey && !settingsStore.hasCustomKey" class="text-[10px] text-accent-rose font-medium">
              ⚠️ Tienes activado el uso de API Key personal pero no la has configurado en los ajustes.
            </p>
          </div>
        </div>
      </div>

      <!-- File / Text Input Panel -->
      <div class="md:col-span-2 space-y-6">
        <div class="glass-panel rounded-2xl p-6 space-y-6">
          <h3 class="font-display font-semibold text-lg text-text-primary">2. Contenido del Extracto</h3>
          
          <!-- Paste Text area -->
          <div class="space-y-2">
            <label class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Pega el texto de tu extracto</label>
            <textarea 
              v-model="statementText"
              rows="8"
              placeholder="Pega aquí el texto copiado de tu PDF, extracto bancario digital o correo de notificaciones..."
              class="w-full px-4 py-3 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald resize-y"
            ></textarea>
          </div>

          <!-- Divider -->
          <div class="flex items-center text-xs text-text-muted">
            <div class="flex-1 border-t border-border/40"></div>
            <span class="px-3">O sube un archivo de texto</span>
            <div class="flex-1 border-t border-border/40"></div>
          </div>

          <!-- Drag and Drop area -->
          <div 
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="handleFileDrop"
            :class="[
              'border border-dashed rounded-2xl p-8 text-center transition-all duration-200 cursor-pointer',
              dragOver ? 'border-accent-emerald bg-accent-emerald/[0.02]' : 'border-border bg-slate-900/20 hover:bg-slate-900/40'
            ]"
            @click="fileInput?.click()"
          >
            <input 
              type="file" 
              ref="fileInput" 
              class="hidden" 
              accept=".txt,.csv"
              @change="handleFileSelect"
            />
            <div class="flex flex-col items-center space-y-2">
              <span class="text-xs text-text-secondary font-medium">Arrastra tu archivo .txt o .csv aquí, o haz clic para buscar</span>
              <span class="text-[10px] text-text-muted">Tamaño máximo 5MB</span>
            </div>
          </div>

          <div v-if="fileName" class="text-xs text-accent-emerald font-semibold flex items-center space-x-2">
            <span>✓ Archivo cargado: {{ fileName }}</span>
          </div>

          <!-- Error Msg -->
          <p v-if="errorMessage" class="text-xs text-accent-rose font-semibold bg-accent-rose/10 px-3 py-2 rounded-lg border border-accent-rose/20">
            {{ errorMessage }}
          </p>

          <!-- Submit Button -->
          <button 
            @click="processWithIA"
            :disabled="loading || !targetAccountId || (!statementText.trim() && !fileName)"
            class="w-full py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm tracking-wide shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
          >
            <span v-if="loading" class="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
            <span>{{ loading ? 'Analizando con Gemini 1.5...' : 'Procesar con Inteligencia Artificial' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Step 2: Verification Panel (JSON transactions list returned from AI) -->
    <div v-else class="space-y-6 animate-scale-up">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 class="font-display font-semibold text-xl text-text-primary">Revisar Movimientos Extraídos</h3>
          <p class="text-text-secondary text-xs mt-1">Valida los detalles antes de guardarlos en tu cuenta. Modifica montos o categorías si es necesario.</p>
        </div>
        
        <div class="flex space-x-3">
          <button 
            @click="resetImport"
            class="px-4 py-2 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
          >
            Volver a empezar
          </button>
          <button 
            @click="confirmBatchImport"
            :disabled="importingBatch || selectedTransactions.length === 0"
            class="px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center space-x-2"
          >
            <span v-if="importingBatch" class="w-3.5 h-3.5 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
            <span>Importar Transacciones ({{ selectedTransactions.length }})</span>
          </button>
        </div>
      </div>

      <!-- Table of items parsed -->
      <div class="glass-panel rounded-3xl overflow-hidden shadow-xl border border-white/5">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-border/50 text-[10px] font-semibold text-text-secondary uppercase tracking-wider bg-slate-900/30">
                <th class="py-4 px-6 w-12 text-center">
                  <input 
                    type="checkbox" 
                    :checked="allChecked" 
                    @change="toggleCheckAll"
                    class="rounded bg-slate-800 border-border text-accent-emerald focus:ring-accent-emerald/20"
                  />
                </th>
                <th class="py-4 px-6 w-32">Fecha</th>
                <th class="py-4 px-6">Descripción</th>
                <th class="py-4 px-6 w-48">Categoría sugerida</th>
                <th class="py-4 px-6 w-36 text-right">Monto</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/30">
              <tr 
                v-for="(tx, index) in parsedTransactions" 
                :key="index"
                class="hover:bg-white/[0.01] transition-colors text-sm text-text-primary"
              >
                <!-- Checkbox selection -->
                <td class="py-3 px-6 text-center">
                  <input 
                    type="checkbox" 
                    v-model="tx.checked"
                    class="rounded bg-slate-800 border-border text-accent-emerald focus:ring-accent-emerald/20"
                  />
                </td>

                <!-- Date input -->
                <td class="py-3 px-6">
                  <input 
                    type="date" 
                    v-model="tx.date"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  />
                </td>

                <!-- Description input -->
                <td class="py-3 px-6">
                  <input 
                    type="text" 
                    v-model="tx.description"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  />
                </td>

                <!-- Category selector -->
                <td class="py-3 px-6">
                  <select 
                    v-model="tx.categorySuggestion"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  >
                    <option v-for="cat in transactionsStore.categories" :key="cat.id" :value="cat.name">
                      {{ cat.name }}
                    </option>
                  </select>
                </td>

                <!-- Amount input -->
                <td class="py-3 px-6">
                  <input 
                    type="number" 
                    step="any"
                    v-model.number="tx.amount"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-right text-text-primary font-display font-semibold focus:outline-none focus:border-accent-emerald"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAccountsStore } from '@/stores/accountsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const transactionsStore = useTransactionsStore()
const router = useRouter()

const targetAccountId = ref('')
const statementText = ref('')
const dragOver = ref(false)
const fileName = ref('')
const errorMessage = ref('')
const loading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

interface ParsedTx {
  date: string;
  description: string;
  amount: number;
  categorySuggestion: string;
  checked: boolean;
}

const parsedTransactions = ref<ParsedTx[]>([])
const importingBatch = ref(false)

onMounted(async () => {
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchCategories()
  await settingsStore.loadSettings()
})

const selectedTransactions = computed(() => {
  return parsedTransactions.value.filter(t => t.checked)
})

const allChecked = computed(() => {
  return parsedTransactions.value.length > 0 && parsedTransactions.value.every(t => t.checked)
})

const toggleCheckAll = () => {
  const current = allChecked.value
  parsedTransactions.value.forEach(t => t.checked = !current)
}

// Drag & Drop / File Select
const handleFileDrop = (e: DragEvent) => {
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    readFile(files[0])
  }
}

const handleFileSelect = (e: Event) => {
  const target = e.target as HTMLInputElement
  const files = target.files
  if (files && files.length > 0) {
    readFile(files[0])
  }
}

const readFile = (file: File) => {
  if (file.size > 5 * 1024 * 1024) {
    errorMessage.value = 'El archivo supera el límite de 5MB.'
    return
  }

  fileName.value = file.name
  errorMessage.value = ''
  
  const reader = new FileReader()
  reader.onload = (e: ProgressEvent<FileReader>) => {
    statementText.value = (e.target?.result as string) || ''
  }
  reader.readAsText(file)
}

// Invocación a Gemini Flow
const processWithIA = async () => {
  if (!targetAccountId.value) {
    errorMessage.value = 'Debes seleccionar una cuenta de destino.'
    return
  }
  if (!statementText.value.trim()) {
    errorMessage.value = 'No hay contenido para analizar. Escribe o sube un extracto.'
    return
  }

  loading.value = true
  errorMessage.value = ''
  
  try {
    const rawTxs = await settingsStore.parseStatementText(statementText.value)
    
    // Asignar el flag `checked` y normalizar datos
    parsedTransactions.value = rawTxs.map((t: any) => ({
      ...t,
      checked: true
    }))

    if (parsedTransactions.value.length === 0) {
      errorMessage.value = 'La IA no pudo detectar ninguna transacción en el texto provisto. Por favor verifica el contenido.'
    }
  } catch (err: any) {
    console.error(err)
    errorMessage.value = err.message || 'Error al comunicarse con el servicio de IA.'
  } finally {
    loading.value = false
  }
}

// Confirmar importación
const confirmBatchImport = async () => {
  importingBatch.value = true
  try {
    await transactionsStore.addTransactionsBatch(targetAccountId.value, selectedTransactions.value)
    router.push({ name: 'Transactions' })
  } catch (err) {
    console.error(err)
    alert('Error al guardar las transacciones.')
  } finally {
    importingBatch.value = false
  }
}

const resetImport = () => {
  parsedTransactions.value = []
  statementText.value = ''
  fileName.value = ''
}
</script>

<style scoped>
.animate-scale-up {
  animation: scaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes scaleUp {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
