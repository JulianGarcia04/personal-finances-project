<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div>
      <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight">Importador Inteligente con IA</h2>
      <p class="text-text-secondary text-sm mt-1">Carga o pega el extracto de tus cuentas y deja que Gemini organice tus gastos.</p>
    </div>

    <!-- Step 1: Input Setup -->
    <div v-if="!parsedTransactions.length" class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Configuration Panel -->
      <div class="md:col-span-1 space-y-6">
        <div class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
          <h3 class="font-display font-semibold text-lg text-text-primary">1. Destino de los datos</h3>
          <p class="text-text-muted text-xs leading-relaxed">Selecciona a qué cuenta deseas registrar los movimientos extraídos por la IA.</p>
          
          <div class="space-y-1">
            <label for="import-target-account" class="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">Cuenta Destino</label>
            <select 
              id="import-target-account"
              v-model="targetAccountId"
              class="field"
            >
              <option value="" disabled>Selecciona una cuenta</option>
              <option v-for="acc in importableAccounts" :key="acc.id" :value="acc.id">
                {{ getAccountDisplayLabel(acc, accountsStore.accounts) }} ({{ acc.currency }})
              </option>
            </select>
            <p class="text-[11px] text-text-muted pt-1">Las cuentas puente se omiten aquí: registra gastos compartidos desde Movimientos para crear sus dos patas.</p>
          </div>

          <div class="border-t border-border/50 pt-4 space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-x-2 text-xs">
              <span class="text-text-secondary">Método Activo:</span>
              <span class="font-semibold text-accent-emerald">
                {{ settingsStore.useCustomKey ? 'API Key Personal' : 'API Key del Proyecto' }}
              </span>
            </div>
            <p v-if="settingsStore.useCustomKey && !settingsStore.hasCustomKey" class="text-[11px] text-accent-rose font-medium">
              ⚠️ Tienes activado el uso de API Key personal pero no la has configurado en los ajustes.
            </p>
          </div>
        </div>
      </div>

      <!-- File / Text Input Panel -->
      <div class="md:col-span-2 space-y-6">
        <div class="glass-panel rounded-2xl p-4 sm:p-6 space-y-6">
          <h3 class="font-display font-semibold text-lg text-text-primary">2. Contenido del Extracto</h3>
          
          <!-- Paste Text area -->
          <div class="space-y-2">
            <label for="import-statement" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Pega el texto de tu extracto</label>
            <textarea 
              id="import-statement"
              v-model="statementText"
              rows="8"
              :readonly="!!pdfBase64"
              placeholder="Pega aquí el texto copiado de tu PDF, extracto bancario digital o correo de notificaciones..."
              class="field resize-y transition-all"
              :class="{ 'opacity-60 cursor-not-allowed bg-slate-950/20': !!pdfBase64 }"
            ></textarea>
          </div>

          <!-- Divider -->
          <div class="flex items-center text-xs text-text-muted">
            <div class="flex-1 border-t border-border/40"></div>
            <span class="px-3 text-center">O sube un archivo (Texto o PDF)</span>
            <div class="flex-1 border-t border-border/40"></div>
          </div>

          <!-- Drag and Drop area -->
          <div 
            @dragover.prevent="dragOver = true"
            @dragleave.prevent="dragOver = false"
            @drop.prevent="handleFileDrop"
            :class="[
              'border border-dashed rounded-2xl p-6 sm:p-8 text-center transition-all duration-200 cursor-pointer',
              dragOver ? 'border-accent-emerald bg-accent-emerald/[0.02]' : 'border-border bg-slate-900/20 hover:bg-slate-900/40'
            ]"
            @click="fileInput?.click()"
            @keydown.enter.prevent="fileInput?.click()"
            @keydown.space.prevent="fileInput?.click()"
            role="button"
            tabindex="0"
          >
            <input 
              type="file" 
              ref="fileInput" 
              class="hidden" 
              accept=".txt,.csv,.pdf"
              @change="handleFileSelect"
            />
            <div class="flex flex-col items-center space-y-2">
              <span class="hidden sm:inline text-xs text-text-secondary font-medium">Arrastra tu archivo .txt, .csv o .pdf aquí, o haz clic para buscar</span>
              <span class="sm:hidden text-sm text-text-secondary font-medium">Toca para elegir un archivo (.txt, .csv o .pdf)</span>
              <span class="text-[11px] text-text-muted">Tamaño máximo 5MB</span>
            </div>
          </div>

          <div v-if="fileName" class="text-xs text-accent-emerald font-semibold flex items-center justify-between gap-2 bg-slate-900/40 pl-4 pr-1 py-1 rounded-xl border border-white/5">
            <div class="min-w-0 flex items-center space-x-2">
              <span class="shrink-0 w-2 h-2 rounded-full bg-accent-emerald animate-pulse"></span>
              <span class="truncate">Archivo cargado: {{ fileName }}</span>
            </div>
            <button 
              type="button" 
              @click.stop="clearFile" 
              class="tap shrink-0 px-3 rounded-lg text-xs uppercase font-bold tracking-wider text-text-muted hover:text-accent-rose transition-colors cursor-pointer"
            >
              Quitar
            </button>
          </div>

          <!-- Error Msg -->
          <p v-if="errorMessage" class="text-xs text-accent-rose font-semibold bg-accent-rose/10 px-3 py-2 rounded-lg border border-accent-rose/20">
            {{ errorMessage }}
          </p>

          <!-- Submit Button -->
          <button 
            @click="processWithIA"
            :disabled="loading || !targetAccountId || (!statementText.trim() && !fileName)"
            class="w-full min-h-11 py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm tracking-wide shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
          >
            <span v-if="loading" class="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
            <span>{{ loading ? 'Analizando con Gemini...' : 'Procesar con Inteligencia Artificial' }}</span>
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
        
        <div class="flex flex-col-reverse sm:flex-row gap-3">
          <button 
            @click="resetImport"
            class="w-full sm:w-auto min-h-11 px-4 py-2 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:bg-white/5 font-semibold text-sm transition-all"
          >
            Volver a empezar
          </button>
          <button 
            @click="confirmBatchImport"
            :disabled="importingBatch || selectedTransactions.length === 0"
            class="w-full sm:w-auto min-h-11 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
          >
            <span v-if="importingBatch" class="w-3.5 h-3.5 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
            <span>Importar Transacciones ({{ selectedTransactions.length }})</span>
          </button>
        </div>
      </div>

      <!-- Warnings (currency mismatch, duplicates, transfers needing counterparty) -->
      <div
        v-if="currencyMismatchWarning"
        role="alert"
        data-testid="import-currency-warning"
        class="rounded-2xl border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs text-accent-amber"
      >
        {{ currencyMismatchWarning }}
      </div>
      <div
        v-if="duplicateCount > 0"
        role="status"
        data-testid="import-duplicate-warning"
        class="rounded-2xl border border-accent-amber/25 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber"
      >
        Se detectaron <strong>{{ duplicateCount }}</strong> posibles duplicados con movimientos ya existentes en esta cuenta y quedaron desmarcados por defecto. Revísalos antes de importar.
      </div>
      <div
        v-if="unsupportedTransferCount > 0"
        role="status"
        data-testid="import-unsupported-transfer-warning"
        class="rounded-2xl border border-accent-amber/25 bg-accent-amber/5 px-4 py-3 text-xs text-accent-amber"
      >
        <strong>{{ unsupportedTransferCount }}</strong> {{ unsupportedTransferCount === 1 ? 'transferencia no se puede importar' : 'transferencias no se pueden importar' }} en una cuenta con bolsillos. Quedaron desmarcadas; regístralas desde el flujo de transferencias.
      </div>
      <p v-if="reviewError" role="alert" class="text-xs text-accent-rose font-semibold bg-accent-rose/10 px-4 py-2.5 rounded-xl border border-accent-rose/20">
        {{ reviewError }}
      </p>

      <!-- Table of items parsed (desktop) -->
      <div class="glass-panel rounded-3xl overflow-hidden shadow-xl border border-white/5 hidden md:block">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-border/50 text-[10px] font-semibold text-text-secondary uppercase tracking-wider bg-slate-900/30">
                <th class="py-4 px-4 w-12 text-center">
                  <input 
                    type="checkbox" 
                    :checked="allChecked" 
                    :disabled="selectableTransactions.length === 0"
                    @change="toggleCheckAll"
                    class="rounded bg-slate-800 border-border text-accent-emerald focus:ring-accent-emerald/20"
                  />
                </th>
                <th class="py-4 px-4 w-32">Fecha</th>
                <th class="py-4 px-4">Descripción</th>
                <th class="py-4 px-4 w-36">Tipo</th>
                <th class="py-4 px-4 w-52">Categoría / Contraparte</th>
                <th class="py-4 px-4 w-36 text-right">Monto</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/30">
              <tr 
                v-for="(tx, index) in parsedTransactions" 
                :key="index"
                class="hover:bg-white/[0.01] transition-colors text-sm text-text-primary"
              >
                <!-- Checkbox selection -->
                <td class="py-3 px-4 text-center">
                  <input 
                    type="checkbox" 
                    v-model="tx.checked"
                    :disabled="Boolean(tx.unsupportedReason)"
                    class="rounded bg-slate-800 border-border text-accent-emerald focus:ring-accent-emerald/20"
                  />
                </td>

                <!-- Date input -->
                <td class="py-3 px-4">
                  <input 
                    type="date" 
                    v-model="tx.date"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  />
                </td>

                <!-- Description input + duplicate badge -->
                <td class="py-3 px-4 space-y-1">
                  <input 
                    type="text" 
                    v-model="tx.description"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  />
                  <p v-if="tx.duplicateMatch" class="text-[10px] text-accent-amber font-medium">
                    Posible duplicado: «{{ tx.duplicateMatch }}»
                  </p>
                  <p v-if="tx.unsupportedReason" class="text-[10px] text-accent-amber font-medium">
                    {{ tx.unsupportedReason }}
                  </p>
                </td>

                <!-- Type selector -->
                <td class="py-3 px-4">
                  <select
                    v-model="tx.type"
                    @change="handleRowTypeChange(tx)"
                    aria-label="Tipo de movimiento"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  >
                    <option value="expense">Gasto</option>
                    <option value="income">Ingreso</option>
                    <option value="transfer" :disabled="targetIsPocketRelated">Transferencia</option>
                  </select>
                </td>

                <!-- Category OR Counterparty Account selector -->
                <td class="py-3 px-4 space-y-1">
                  <select 
                    v-if="tx.type !== 'transfer'"
                    v-model="tx.categorySuggestion"
                    class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border border-border/70 text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                  >
                    <option v-for="cat in transactionsStore.categories" :key="cat.id" :value="cat.name">
                      {{ cat.name }}
                    </option>
                  </select>
                  <template v-else>
                    <select
                      v-model="tx.counterpartyAccountId"
                      aria-label="Cuenta contraparte"
                      class="w-full px-2 py-1.5 rounded-lg bg-slate-900/50 border text-xs text-text-primary focus:outline-none focus:border-accent-emerald"
                      :class="tx.checked && !tx.counterpartyAccountId ? 'border-accent-amber' : 'border-border/70'"
                    >
                      <option value="">Selecciona cuenta ({{ selectedAccount?.currency }})</option>
                      <option v-for="acc in transferCounterpartyAccounts" :key="acc.id" :value="acc.id">
                        {{ tx.amount > 0 ? 'Desde: ' : 'Hacia: ' }}{{ getAccountDisplayLabel(acc, accountsStore.accounts) }}
                      </option>
                    </select>
                    <p v-if="tx.checked && !tx.counterpartyAccountId" class="text-[10px] text-accent-amber">
                      Elige contraparte o desmarca si ya está registrado.
                    </p>
                  </template>
                </td>

                <!-- Amount input -->
                <td class="py-3 px-4">
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

      <!-- Parsed items cards (mobile) -->
      <div class="md:hidden space-y-3">
        <div
          v-for="(tx, index) in parsedTransactions"
          :key="index"
          class="glass-panel rounded-2xl p-4 border border-white/5 space-y-3"
        >
          <div class="flex items-center justify-between gap-3">
            <label class="min-h-11 flex-1 flex items-center gap-2.5 text-sm font-semibold text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                v-model="tx.checked"
                :disabled="Boolean(tx.unsupportedReason)"
                class="w-5 h-5 shrink-0 rounded bg-slate-800 border-border text-accent-emerald focus:ring-accent-emerald/20"
              />
              <span>Incluir</span>
            </label>
            <div class="w-36 shrink-0">
              <input
                type="number"
                inputmode="decimal"
                step="any"
                v-model.number="tx.amount"
                aria-label="Monto"
                class="field text-right font-display font-semibold"
              />
            </div>
          </div>
          <p v-if="tx.duplicateMatch" class="text-[11px] text-accent-amber font-medium">
            Posible duplicado: «{{ tx.duplicateMatch }}»
          </p>
          <p v-if="tx.unsupportedReason" class="text-[11px] text-accent-amber font-medium">
            {{ tx.unsupportedReason }}
          </p>
          <input
            type="text"
            v-model="tx.description"
            placeholder="Descripción"
            aria-label="Descripción"
            class="field"
          />
          <div class="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
            <input
              type="date"
              v-model="tx.date"
              aria-label="Fecha"
              class="field"
            />
            <select
              v-model="tx.type"
              @change="handleRowTypeChange(tx)"
              aria-label="Tipo de movimiento"
              class="field"
            >
              <option value="expense">Gasto</option>
              <option value="income">Ingreso</option>
              <option value="transfer" :disabled="targetIsPocketRelated">Transferencia</option>
            </select>
          </div>
          <select
            v-if="tx.type !== 'transfer'"
            v-model="tx.categorySuggestion"
            aria-label="Categoría"
            class="field"
          >
            <option v-for="cat in transactionsStore.categories" :key="cat.id" :value="cat.name">
              {{ cat.name }}
            </option>
          </select>
          <div v-else class="space-y-1">
            <select
              v-model="tx.counterpartyAccountId"
              aria-label="Cuenta contraparte"
              class="field"
              :class="tx.checked && !tx.counterpartyAccountId ? 'border-accent-amber' : ''"
            >
              <option value="">Selecciona cuenta contraparte ({{ selectedAccount?.currency }})</option>
              <option v-for="acc in transferCounterpartyAccounts" :key="acc.id" :value="acc.id">
                {{ tx.amount > 0 ? 'Desde: ' : 'Hacia: ' }}{{ getAccountDisplayLabel(acc, accountsStore.accounts) }}
              </option>
            </select>
            <p v-if="tx.checked && !tx.counterpartyAccountId" class="text-[11px] text-accent-amber">
              Elige contraparte o desmarca si ya está registrado.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { track } from '@/lib/analytics'
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAccountsStore } from '@/stores/accountsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { getAccountDisplayLabel, isPocketRelatedAccount } from '@/lib/pockets'
import { findPotentialDuplicate, normalizeParsedStatementRow, type StatementImportType } from '@/lib/statementImport'

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const transactionsStore = useTransactionsStore()
const router = useRouter()

const targetAccountId = ref('')
const statementText = ref('')
const pdfBase64 = ref('')
const MAX_STATEMENT_TEXT_CHARS = 200_000
const dragOver = ref(false)
const fileName = ref('')
const errorMessage = ref('')
const reviewError = ref('')
const detectedCurrency = ref<string | null>(null)
const loading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

interface ParsedTx {
  date: string;
  description: string;
  amount: number;
  categorySuggestion: string;
  type: StatementImportType;
  counterpartyAccountId: string;
  duplicateMatch: string | null;
  unsupportedReason: string | null;
  checked: boolean;
}

const parsedTransactions = ref<ParsedTx[]>([])
const importingBatch = ref(false)

// Bridge accounts replicate shared expenses into another workspace and cannot receive statement imports.
const importableAccounts = computed(() =>
  accountsStore.accounts.filter(acc => !acc.mirror)
)
const selectedAccount = computed(() =>
  accountsStore.getAccountById(targetAccountId.value) ?? null
)
const targetIsPocketRelated = computed(() =>
  Boolean(selectedAccount.value && isPocketRelatedAccount(selectedAccount.value))
)
const transferCounterpartyAccounts = computed(() => {
  const target = selectedAccount.value
  if (!target || targetIsPocketRelated.value) return []
  return accountsStore.accounts.filter(acc =>
    acc.id !== target.id &&
    !acc.mirror &&
    !isPocketRelatedAccount(acc) &&
    acc.currency === target.currency
  )
})
const currencyMismatchWarning = computed(() => {
  if (!detectedCurrency.value || !selectedAccount.value) return ''
  if (detectedCurrency.value === selectedAccount.value.currency) return ''
  return `El extracto parece estar en ${detectedCurrency.value}, pero la cuenta seleccionada está en ${selectedAccount.value.currency}. Verifica la cuenta destino antes de importar.`
})
const duplicateCount = computed(() =>
  parsedTransactions.value.filter(t => Boolean(t.duplicateMatch)).length
)
const unsupportedTransferCount = computed(() =>
  parsedTransactions.value.filter(t => Boolean(t.unsupportedReason)).length
)

onMounted(async () => {
  await Promise.all([
    accountsStore.fetchAccounts(),
    transactionsStore.fetchCategories(),
    transactionsStore.fetchTransactions(),
    settingsStore.loadSettings()
  ])
})

const selectedTransactions = computed(() => {
  return parsedTransactions.value.filter(t => t.checked)
})

const selectableTransactions = computed(() => parsedTransactions.value.filter(t => !t.unsupportedReason))

const allChecked = computed(() => {
  return selectableTransactions.value.length > 0 && selectableTransactions.value.every(t => t.checked)
})

const toggleCheckAll = () => {
  const current = allChecked.value
  selectableTransactions.value.forEach(t => t.checked = !current)
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
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    reader.onload = (e: ProgressEvent<FileReader>) => {
      const result = e.target?.result as string
      pdfBase64.value = result
      statementText.value = `[Archivo PDF cargado: ${file.name}]`
    }
    reader.readAsDataURL(file)
  } else {
    pdfBase64.value = ''
    reader.onload = (e: ProgressEvent<FileReader>) => {
      statementText.value = (e.target?.result as string) || ''
    }
    reader.readAsText(file)
  }
}

const clearFile = () => {
  fileName.value = ''
  pdfBase64.value = ''
  statementText.value = ''
}

const handleRowTypeChange = (tx: ParsedTx) => {
  if (tx.type === 'expense' && tx.amount > 0) tx.amount = -tx.amount
  else if (tx.type === 'income' && tx.amount < 0) tx.amount = Math.abs(tx.amount)
  if (tx.type !== 'transfer') tx.counterpartyAccountId = ''
  tx.unsupportedReason = tx.type === 'transfer' && targetIsPocketRelated.value
    ? 'No se puede importar directamente una transferencia en una cuenta con bolsillos.'
    : null
  if (tx.unsupportedReason) tx.checked = false
  reviewError.value = ''
}

watch(targetIsPocketRelated, pocketRelated => {
  for (const transaction of parsedTransactions.value) {
    if (transaction.type !== 'transfer') continue
    transaction.unsupportedReason = pocketRelated
      ? 'No se puede importar directamente una transferencia en una cuenta con bolsillos.'
      : null
    if (pocketRelated) transaction.checked = false
  }
})

// Invocación a Gemini Flow
const processWithIA = async () => {
  if (!targetAccountId.value) {
    errorMessage.value = 'Debes seleccionar una cuenta de destino.'
    return
  }
  if (!statementText.value.trim() && !pdfBase64.value) {
    errorMessage.value = 'No hay contenido para analizar. Escribe o sube un extracto.'
    return
  }
  // Mirrors the server cap in functions/src/quota.ts (MAX_STATEMENT_TEXT_CHARS).
  if (!pdfBase64.value && statementText.value.length > MAX_STATEMENT_TEXT_CHARS) {
    errorMessage.value = 'El texto del extracto supera el máximo de 200.000 caracteres.'
    return
  }

  loading.value = true
  errorMessage.value = ''
  reviewError.value = ''
  detectedCurrency.value = null
  
  try {
    const result = await settingsStore.parseStatementText(
      pdfBase64.value ? undefined : statementText.value,
      pdfBase64.value || undefined
    )
    detectedCurrency.value = result.detectedCurrency
    const target = selectedAccount.value
    const targetType = target?.type
    const existing = transactionsStore.transactions

    parsedTransactions.value = result.transactions.map((raw: any) => {
      const normalized = normalizeParsedStatementRow(raw, targetType)
      const dup = findPotentialDuplicate(normalized, targetAccountId.value, existing)
      const unsupportedReason = targetIsPocketRelated.value && normalized.type === 'transfer'
        ? 'No se puede importar directamente una transferencia en una cuenta con bolsillos.'
        : null
      return {
        ...normalized,
        duplicateMatch: dup ? (dup.description || 'Movimiento existente') : null,
        unsupportedReason,
        checked: !dup && !unsupportedReason
      }
    })

    if (parsedTransactions.value.length === 0) {
      errorMessage.value = 'La IA no pudo detectar ninguna transacción en el extracto provisto. Por favor verifica el contenido.'
    }
  } catch (err: any) {
    console.error(err)
    errorMessage.value = err.message || 'Error al comunicarse con el servicio de IA.'
  } finally {
    loading.value = false
  }
}

// Idempotency key reused only when retrying the exact same account + rows after a failure.
let pendingImport: { fingerprint: string; statementImportId: string } | null = null

// Confirmar importación
const confirmBatchImport = async () => {
  reviewError.value = ''
  const selected = selectedTransactions.value
  const unsupportedTransfer = selected.find(tx => tx.unsupportedReason)
  if (unsupportedTransfer) {
    reviewError.value = unsupportedTransfer.unsupportedReason ?? 'Desmarca las transferencias no disponibles en esta cuenta.'
    return
  }
  const missingCounterparty = selected.find(tx => tx.type === 'transfer' && !tx.counterpartyAccountId)
  if (missingCounterparty) {
    reviewError.value = `Selecciona una cuenta contraparte para la transferencia «${missingCounterparty.description || 'sin descripción'}» o desmárcala si ya fue registrada.`
    return
  }
  const invalidAmount = selected.find(tx => !Number.isFinite(tx.amount) || tx.amount === 0)
  if (invalidAmount) {
    reviewError.value = `El monto de «${invalidAmount.description || 'una fila'}» debe ser distinto de cero.`
    return
  }

  importingBatch.value = true
  const rows = selected.map(({ date, description, amount, categorySuggestion, type, counterpartyAccountId }) => ({
    date,
    description,
    amount: type === 'expense' ? -Math.abs(amount) : type === 'income' ? Math.abs(amount) : amount,
    categorySuggestion,
    type,
    ...(type === 'transfer' ? { counterpartyAccountId } : {})
  }))
  const fingerprint = JSON.stringify([targetAccountId.value, rows])
  if (pendingImport?.fingerprint !== fingerprint) {
    pendingImport = { fingerprint, statementImportId: crypto.randomUUID() }
  }
  try {
    await transactionsStore.addTransactionsBatch(targetAccountId.value, rows, {
      statementImportId: pendingImport.statementImportId
    })
    pendingImport = null
    track('statement_imported', { transactions: rows.length })
    router.push({ name: 'Transactions' })
  } catch (err) {
    console.error(err)
    // Callable errors carry a client-safe Spanish message; other failures keep the generic text.
    const code = (err as { code?: unknown } | null)?.code
    const message = (err as { message?: unknown } | null)?.message
    reviewError.value = typeof message === 'string' && message && (typeof code !== 'string' || code.startsWith('functions/'))
      ? message
      : 'Error al guardar las transacciones.'
  } finally {
    importingBatch.value = false
  }
}

const resetImport = () => {
  parsedTransactions.value = []
  statementText.value = ''
  fileName.value = ''
  pdfBase64.value = ''
  detectedCurrency.value = null
  reviewError.value = ''
  pendingImport = null
}
</script>
