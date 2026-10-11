<template>
  <div class="max-w-5xl mx-auto space-y-6 sm:space-y-8">
    <!-- Header -->
    <div>
      <h2 class="font-display font-bold text-2xl sm:text-3xl text-text-primary tracking-tight">Configuración</h2>
      <p class="text-text-secondary text-sm mt-1">Ajusta tu espacio de trabajo, preferencias y módulos inteligentes.</p>
    </div>

    <div class="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-8 lg:items-start">
      <!-- Section navigation: horizontal pills on mobile, sticky vertical list on desktop -->
      <nav
        role="tablist"
        aria-label="Secciones de configuración"
        class="flex gap-2 overflow-x-auto -mx-4 px-4 sm:-mx-6 sm:px-6 pb-1 mb-6 [scrollbar-width:none] lg:mx-0 lg:px-0 lg:pb-0 lg:mb-0 lg:flex-col lg:gap-1 lg:sticky lg:top-6 lg:overflow-visible"
      >
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :id="`settings-tab-${tab.id}`"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`settings-panel-${tab.id}`"
          @click="selectTab(tab.id)"
          :class="[
            'shrink-0 min-h-11 flex items-center gap-3 rounded-xl border px-4 py-2 lg:px-3 lg:py-2.5 text-left transition-all cursor-pointer',
            activeTab === tab.id
              ? 'border-accent-emerald/30 bg-accent-emerald/10 text-text-primary'
              : 'border-white/5 bg-slate-900/30 lg:bg-transparent lg:border-transparent text-text-secondary hover:text-text-primary hover:bg-white/5'
          ]"
        >
          <component
            :is="tab.icon"
            :class="['w-4 h-4 shrink-0', activeTab === tab.id ? 'text-accent-emerald' : '']"
          />
          <span class="min-w-0">
            <span class="block text-sm font-display font-medium whitespace-nowrap">{{ tab.label }}</span>
            <span class="hidden lg:block text-[11px] text-text-muted truncate">{{ tab.hint }}</span>
          </span>
        </button>
      </nav>

      <!-- Active section -->
      <section
        :id="`settings-panel-${activeTab}`"
        role="tabpanel"
        :aria-labelledby="`settings-tab-${activeTab}`"
        class="min-w-0 space-y-6 animate-fade-in"
        :key="activeTab"
      >
        <!-- Section header -->
        <header class="flex items-start gap-3">
          <span class="w-10 h-10 shrink-0 rounded-xl bg-accent-emerald/10 border border-accent-emerald/20 flex items-center justify-center">
            <component :is="currentTab.icon" class="w-5 h-5 text-accent-emerald" />
          </span>
          <div class="min-w-0">
            <h3 class="font-display font-semibold text-lg text-text-primary">{{ currentTab.label }}</h3>
            <p class="text-text-secondary text-xs mt-1 leading-relaxed">{{ currentTab.description }}</p>
          </div>
        </header>

        <!-- ───────────── Workspace ───────────── -->
        <template v-if="activeTab === 'workspace'">
          <!-- Current workspace summary -->
          <div class="glass-panel rounded-2xl p-4 sm:p-5 flex items-center gap-3">
            <span class="w-10 h-10 shrink-0 rounded-full bg-slate-800 flex items-center justify-center font-display font-semibold text-accent-emerald uppercase">
              {{ (currentWorkspaceName || '?').charAt(0) }}
            </span>
            <div class="min-w-0">
              <p class="text-[11px] uppercase tracking-wider text-text-muted font-semibold">Workspace activo</p>
              <p class="font-display font-medium text-text-primary truncate">{{ currentWorkspaceName || 'Sin workspace' }}</p>
            </div>
          </div>

          <div class="glass-panel rounded-2xl divide-y divide-border/50">
            <!-- Invite -->
            <div class="p-4 sm:p-6 space-y-3">
              <div>
                <h4 class="font-display font-medium text-sm text-text-primary">Invitar miembro</h4>
                <p class="text-text-muted text-xs mt-1">Comparte este workspace con alguien ya registrado en Vault usando su correo.</p>
              </div>
              <form @submit.prevent="handleInviteUser" class="flex flex-col sm:flex-row gap-3">
                <input
                  type="email"
                  v-model="inviteEmail"
                  required
                  placeholder="correo@ejemplo.com"
                  aria-label="Correo del miembro"
                  autocomplete="email"
                  autocapitalize="none"
                  inputmode="email"
                  class="field flex-1"
                />
                <button
                  type="submit"
                  :disabled="invitingUser"
                  class="sm:w-36 min-h-11 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <MailIcon class="w-4 h-4" />
                  <span>Invitar</span>
                </button>
              </form>
              <p v-if="inviteMsg" :class="inviteError ? 'text-accent-rose' : 'text-accent-emerald'" class="text-xs font-medium">{{ inviteMsg }}</p>
            </div>

            <!-- Expense limit -->
            <div class="p-4 sm:p-6 space-y-3">
              <div>
                <h4 class="font-display font-medium text-sm text-text-primary">Límite de gastos mensual</h4>
                <p class="text-text-muted text-xs mt-1">Tope de egresos para este workspace, en tu moneda principal ({{ currency }}).</p>
              </div>
              <form @submit.prevent="handleUpdateLimit" class="flex flex-col sm:flex-row gap-3">
                <input
                  type="number"
                  inputmode="decimal"
                  v-model="expenseLimitInput"
                  placeholder="Ej. 1500000"
                  aria-label="Límite de gastos"
                  class="field flex-1"
                />
                <button
                  type="submit"
                  class="sm:w-36 min-h-11 px-5 py-2.5 rounded-xl border border-accent-emerald/40 text-accent-emerald hover:bg-accent-emerald/10 font-display font-semibold text-sm cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <CheckIcon class="w-4 h-4" />
                  <span>Guardar</span>
                </button>
              </form>
            </div>

            <!-- Budget alert emails (workspace-wide). Whole row toggles the switch. -->
            <div class="p-4 sm:p-6">
              <label class="flex items-start justify-between gap-4 min-h-11 cursor-pointer">
                <span class="min-w-0 space-y-1">
                  <span class="block font-display font-medium text-sm text-text-primary">Alertas de presupuesto por correo</span>
                  <span class="block text-text-muted text-xs">Avisa por correo a los miembros cuando una categoría llega al 80 % o al 100 % de su presupuesto mensual.</span>
                </span>
                <span class="relative inline-flex items-center shrink-0 min-h-11 -mt-2.5">
                  <input
                    type="checkbox"
                    v-model="budgetAlertsEnabled"
                    @change="handleBudgetAlertsChange"
                    class="sr-only peer"
                  >
                  <div class="relative w-11 h-6 bg-slate-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-accent-emerald/20 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-emerald peer-checked:after:bg-background"></div>
                </span>
              </label>
            </div>

            <!-- Create workspace -->
            <div class="p-4 sm:p-6 space-y-3">
              <div>
                <h4 class="font-display font-medium text-sm text-text-primary">Crear nuevo workspace</h4>
                <p class="text-text-muted text-xs mt-1">Separa finanzas en espacios independientes (ej. Casa, Negocio).</p>
              </div>
              <form @submit.prevent="handleCreateWorkspace" class="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  v-model="newWorkspaceName"
                  required
                  placeholder="Nombre del workspace (ej. Casa)"
                  aria-label="Nombre del Workspace"
                  class="field flex-1"
                />
                <button
                  type="submit"
                  :disabled="creatingWorkspace"
                  class="sm:w-36 min-h-11 px-5 py-2.5 rounded-xl border border-accent-emerald/40 text-accent-emerald hover:bg-accent-emerald/10 font-display font-semibold text-sm cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <PlusIcon class="w-4 h-4" />
                  <span>Crear</span>
                </button>
              </form>
            </div>
          </div>
        </template>

        <!-- ───────────── Region & currency ───────────── -->
        <template v-else-if="activeTab === 'regional'">
          <div class="glass-panel rounded-2xl p-4 sm:p-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label for="settings-country" class="block text-xs font-semibold text-text-secondary">País de residencia</label>
                <select
                  id="settings-country"
                  v-model="country"
                  @change="handleCountryChange"
                  class="field font-semibold cursor-pointer"
                >
                  <option value="CO">Colombia</option>
                  <option value="MX">México</option>
                  <option value="ES">España</option>
                  <option value="US">Estados Unidos</option>
                  <option value="CL">Chile</option>
                  <option value="AR">Argentina</option>
                  <option value="PE">Perú</option>
                </select>
              </div>

              <div class="space-y-1.5">
                <label for="settings-currency" class="block text-xs font-semibold text-text-secondary">Moneda principal</label>
                <select
                  id="settings-currency"
                  v-model="currency"
                  @change="handleGeneralSettingsChange"
                  class="field font-semibold cursor-pointer"
                >
                  <option value="COP">COP ($)</option>
                  <option value="MXN">MXN ($)</option>
                  <option value="EUR">EUR (€)</option>
                  <option value="USD">USD ($)</option>
                  <option value="CLP">CLP ($)</option>
                  <option value="ARS">ARS ($)</option>
                  <option value="PEN">PEN (S/.)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Exchange rates (consolidate multi-currency KPIs) -->
          <div class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
            <div>
              <h4 class="font-display font-medium text-sm text-text-primary">Tasas de cambio</h4>
              <p class="text-text-muted text-xs mt-1">
                Cuántos <span class="font-semibold text-text-secondary">{{ currency }}</span> vale 1 unidad de cada otra moneda de tus cuentas.
                Se usan para consolidar tu patrimonio y KPIs.
              </p>
            </div>

            <div v-if="foreignCurrencies.length === 0" class="text-xs text-text-muted rounded-xl border border-dashed border-white/10 px-4 py-3">
              Todas tus cuentas usan {{ currency }}. No se necesitan tasas de cambio.
            </div>

            <div v-else class="space-y-3">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                  v-for="cur in foreignCurrencies"
                  :key="cur"
                  class="flex items-center gap-2 rounded-xl border border-white/5 bg-slate-900/30 p-2 pl-3"
                >
                  <span class="text-sm font-semibold text-text-primary shrink-0 whitespace-nowrap">1 {{ cur }} =</span>
                  <input
                    type="number"
                    inputmode="decimal"
                    step="any"
                    min="0"
                    :value="rateInputs[cur] ?? ''"
                    :placeholder="`Tasa a ${currency}`"
                    :aria-label="`Tasa de 1 ${cur} en ${currency}`"
                    class="field flex-1 min-w-0"
                    @change="(e) => saveExchangeRate(cur, (e.target as HTMLInputElement).value)"
                  />
                  <span class="text-xs font-semibold text-text-secondary shrink-0 pr-1">{{ currency }}</span>
                </div>
              </div>
              <p v-if="ratesMsg" class="text-xs text-accent-emerald font-medium">{{ ratesMsg }}</p>
            </div>
          </div>
        </template>

        <!-- ───────────── Categories ───────────── -->
        <template v-else-if="activeTab === 'categories'">
          <!-- Existing categories -->
          <div class="glass-panel rounded-2xl p-4 sm:p-6 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-display font-medium text-sm text-text-primary">Tus categorías</h4>
              <span class="text-[11px] text-text-muted">{{ transactionsStore.categories.length }} en total</span>
            </div>
            <div class="flex flex-wrap gap-2.5">
              <span
                v-for="cat in transactionsStore.categories"
                :key="cat.id"
                class="max-w-full inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border border-white/5 bg-slate-900/40 text-text-primary"
              >
                <component :is="getIconComponent(cat.icon)" class="w-3.5 h-3.5 shrink-0" :style="{ color: cat.color }" />
                <span class="min-w-0 truncate">{{ cat.name }}</span>
                <span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 text-text-muted font-normal">
                  {{ cat.type === 'expense' ? 'Gasto' : cat.type === 'income' ? 'Ingreso' : 'Ambos' }}
                </span>
                <button
                  v-if="!isDefaultCategory(cat.name)"
                  type="button"
                  @click="deleteCategory(cat.id)"
                  class="tap -my-2.5 -mr-2.5 shrink-0 flex items-center justify-center rounded-full text-text-muted hover:text-accent-rose hover:bg-white/10 transition-all cursor-pointer"
                  title="Eliminar categoría"
                  :aria-label="`Eliminar categoría ${cat.name}`"
                >
                  <TrashIcon class="w-4 h-4" />
                </button>
              </span>
            </div>
            <p class="text-[11px] text-text-muted">Las categorías por defecto no se pueden eliminar.</p>
          </div>

          <!-- New category -->
          <form @submit.prevent="createCategory" class="glass-panel rounded-2xl p-4 sm:p-6 space-y-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h4 class="font-display font-medium text-sm text-text-primary">Nueva categoría</h4>
              <!-- Live preview -->
              <span class="max-w-full inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border border-white/10 bg-slate-900/60 text-text-primary">
                <component :is="getIconComponent(newCatIcon)" class="w-3.5 h-3.5 shrink-0" :style="{ color: newCatColor }" />
                <span class="min-w-0 truncate">{{ newCatName || 'Vista previa' }}</span>
              </span>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="space-y-1.5">
                <label for="settings-cat-name" class="block text-xs font-semibold text-text-secondary">Nombre</label>
                <input
                  id="settings-cat-name"
                  type="text"
                  v-model="newCatName"
                  required
                  placeholder="Ej. Mascotas, Gimnasio"
                  class="field"
                />
              </div>

              <div class="space-y-1.5">
                <label for="settings-cat-type" class="block text-xs font-semibold text-text-secondary">Tipo de movimiento</label>
                <select
                  id="settings-cat-type"
                  v-model="newCatType"
                  class="field font-semibold cursor-pointer"
                >
                  <option value="expense">Solo gastos</option>
                  <option value="income">Solo ingresos</option>
                  <option value="both">Ambos</option>
                </select>
              </div>
            </div>

            <div class="space-y-2">
              <span class="block text-xs font-semibold text-text-secondary">Color</span>
              <div class="flex flex-wrap gap-3 items-center">
                <button
                  v-for="color in presetColors"
                  :key="color"
                  type="button"
                  :aria-label="`Color ${color}`"
                  :aria-pressed="newCatColor === color"
                  @click="newCatColor = color"
                  :style="{ backgroundColor: color }"
                  :class="[
                    'w-9 h-9 rounded-full transition-all border cursor-pointer',
                    newCatColor === color ? 'border-white scale-110 shadow-lg' : 'border-transparent hover:scale-105'
                  ]"
                ></button>
                <label aria-label="Color personalizado" class="relative w-9 h-9 rounded-full border border-white/10 flex items-center justify-center cursor-pointer overflow-hidden hover:scale-105 transition-all">
                  <input
                    type="color"
                    v-model="newCatColor"
                    class="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <span class="w-full h-full" :style="{ backgroundColor: newCatColor }"></span>
                </label>
              </div>
            </div>

            <div class="space-y-2">
              <span class="block text-xs font-semibold text-text-secondary">Icono</span>
              <div class="grid grid-cols-5 min-[400px]:grid-cols-6 sm:grid-cols-8 md:grid-cols-11 gap-2 p-3 rounded-xl bg-slate-950/50 border border-white/5">
                <button
                  v-for="icon in availableIcons"
                  :key="icon.name"
                  type="button"
                  @click="newCatIcon = icon.name"
                  :title="icon.label"
                  :aria-label="icon.label"
                  :aria-pressed="newCatIcon === icon.name"
                  :class="[
                    'min-h-11 p-2 rounded-lg flex items-center justify-center border transition-all cursor-pointer hover:bg-white/5',
                    newCatIcon === icon.name
                      ? 'border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald'
                      : 'border-transparent text-text-secondary hover:text-text-primary'
                  ]"
                >
                  <component :is="getIconComponent(icon.name)" class="w-5 h-5 sm:w-4 sm:h-4" />
                </button>
              </div>
            </div>

            <div class="flex justify-end">
              <button
                type="submit"
                :disabled="loadingCategory"
                class="w-full sm:w-auto min-h-11 px-6 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
              >
                <PlusIcon class="w-4 h-4" />
                <span>Crear categoría</span>
              </button>
            </div>
          </form>
        </template>

        <!-- ───────────── AI ───────────── -->
        <template v-else-if="activeTab === 'ai'">
          <div class="glass-panel rounded-2xl p-4 sm:p-6">
            <!-- Whole row toggles the switch (bigger tap target on mobile) -->
            <label class="flex items-start justify-between gap-4 min-h-11 cursor-pointer">
              <span class="min-w-0 space-y-1">
                <span class="block font-display font-medium text-text-primary">Importador de extractos bancarios</span>
                <span class="block text-text-muted text-xs">Sube extractos o pega notificaciones y Gemini los convierte en movimientos.</span>
              </span>
              <span class="relative inline-flex items-center shrink-0 min-h-11 -mt-2.5">
                <input
                  type="checkbox"
                  v-model="aiEnabled"
                  @change="handleGeneralSettingsChange"
                  class="sr-only peer"
                >
                <div class="relative w-11 h-6 bg-slate-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-accent-emerald/20 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-emerald peer-checked:after:bg-background"></div>
              </span>
            </label>
          </div>

          <div v-if="aiEnabled" class="glass-panel rounded-2xl p-4 sm:p-6 space-y-5 animate-fade-in">
            <div>
              <h4 class="font-display font-medium text-sm text-text-primary">Origen de la API Key</h4>
              <p class="text-text-muted text-xs mt-1">Elige quién paga las consultas a Gemini.</p>
            </div>

            <div role="radiogroup" aria-label="Origen de la API Key" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label
                v-for="option in keyOptions"
                :key="option.label"
                :class="[
                  'p-4 rounded-xl border flex items-start gap-3 cursor-pointer transition-all duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-emerald/30',
                  useCustomKey === option.value ? 'border-accent-emerald/40 bg-accent-emerald/[0.04]' : 'border-border bg-slate-900/30 hover:bg-slate-900/50'
                ]"
              >
                <input
                  type="radio"
                  :value="option.value"
                  v-model="useCustomKey"
                  @change="handleGeneralSettingsChange"
                  class="sr-only"
                />
                <!-- Radio indicator -->
                <span
                  :class="[
                    'mt-0.5 w-4 h-4 shrink-0 rounded-full border-2 flex items-center justify-center',
                    useCustomKey === option.value ? 'border-accent-emerald' : 'border-slate-600'
                  ]"
                >
                  <span v-if="useCustomKey === option.value" class="w-1.5 h-1.5 rounded-full bg-accent-emerald"></span>
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-text-primary">{{ option.label }}</span>
                  <span class="block text-text-muted text-xs mt-1">{{ option.description }}</span>
                </span>
              </label>
            </div>

            <!-- Custom key configuration -->
            <div v-if="useCustomKey" class="bg-slate-900/40 border border-border rounded-xl p-4 sm:p-5 space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <h5 class="text-sm font-semibold text-text-primary flex items-center gap-2">
                    <KeyRoundIcon class="w-4 h-4 text-text-secondary" />
                    Tu Gemini API Key
                  </h5>
                  <p class="text-text-muted text-xs mt-0.5">Se guarda encriptada (AES-256) y nunca se expone en el navegador.</p>
                </div>
                <span
                  :class="[
                    'text-[10px] px-2 py-0.5 rounded-full font-semibold border',
                    settingsStore.hasCustomKey
                      ? 'bg-accent-emerald/10 border-accent-emerald/20 text-accent-emerald'
                      : 'bg-accent-rose/10 border-accent-rose/20 text-accent-rose'
                  ]"
                >
                  {{ settingsStore.hasCustomKey ? 'Configurada' : 'Sin configurar' }}
                </span>
              </div>

              <form @submit.prevent="saveApiKey" class="flex flex-col sm:flex-row gap-3">
                <input
                  type="password"
                  v-model="customKeyInput"
                  required
                  placeholder="AIzaSy..."
                  autocomplete="off"
                  aria-label="Gemini API Key"
                  class="field flex-1"
                />
                <button
                  type="submit"
                  :disabled="loadingKey"
                  class="sm:w-36 min-h-11 px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span v-if="loadingKey" class="w-3.5 h-3.5 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
                  <span>{{ settingsStore.hasCustomKey ? 'Actualizar' : 'Guardar' }}</span>
                </button>
              </form>

              <p v-if="successMsg" class="text-xs text-accent-emerald font-medium">{{ successMsg }}</p>
              <p v-if="errorMsg" class="text-xs text-accent-rose font-medium">{{ errorMsg }}</p>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { ApiKeySchema, CategorySchema } from '@/schemas'
import { 
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield,
  Trash2 as TrashIcon, Plus as PlusIcon, Mail as MailIcon, Check as CheckIcon,
  KeyRound as KeyRoundIcon, Sparkles, Users, Globe, Tags
} from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const workspacesStore = useWorkspacesStore()
const transactionsStore = useTransactionsStore()
const accountsStore = useAccountsStore()
const goalsStore = useGoalsStore()

// Section tabs (synced to ?tab= so sections are linkable and survive reloads)
type SettingsTab = 'workspace' | 'regional' | 'categories' | 'ai'
interface TabDef { id: SettingsTab; label: string; hint: string; description: string; icon: Component }

const tabs: TabDef[] = [
  {
    id: 'workspace', label: 'Workspace', hint: 'Miembros, límites y espacios', icon: Users,
    description: 'Administra tu espacio de trabajo actual: invita colaboradores, define un límite de gastos o crea nuevos espacios.'
  },
  {
    id: 'regional', label: 'Región y moneda', hint: 'País, moneda y tasas', icon: Globe,
    description: 'Tu país y moneda principal permiten al Asesor IA contextualizar recomendaciones financieras y tributarias.'
  },
  {
    id: 'categories', label: 'Categorías', hint: 'Organiza tus movimientos', icon: Tags,
    description: 'Crea categorías personalizadas para clasificar tus ingresos y egresos.'
  },
  {
    id: 'ai', label: 'Inteligencia Artificial', hint: 'Importador y API Key', icon: Sparkles,
    description: 'Activa el importador de extractos con Gemini y decide si usas la API Key del sistema o una personal.'
  }
]

const route = useRoute()
const router = useRouter()
const isTab = (v: unknown): v is SettingsTab => tabs.some(t => t.id === v)
const activeTab = ref<SettingsTab>(isTab(route.query.tab) ? route.query.tab : 'workspace')
const currentTab = computed(() => tabs.find(t => t.id === activeTab.value) ?? tabs[0])

const selectTab = (id: SettingsTab) => {
  activeTab.value = id
  router.replace({ query: { ...route.query, tab: id } })
}

const keyOptions = [
  { value: false, label: 'API Key del proyecto', description: 'Usa la clave centralizada. Las consultas corren por cuenta del sistema.' },
  { value: true, label: 'API Key personal', description: 'Usa tus propios créditos de Google AI Studio.' }
]

const aiEnabled = ref(true)
const useCustomKey = ref(false)
const customKeyInput = ref('')
const loadingKey = ref(false)

const country = ref('CO')
const currency = ref('COP')

const successMsg = ref('')
const errorMsg = ref('')

const countryToCurrencyMap: Record<string, string> = {
  CO: 'COP',
  MX: 'MXN',
  ES: 'EUR',
  US: 'USD',
  CL: 'CLP',
  AR: 'ARS',
  PE: 'PEN'
}

// Category Creation State
const newCatName = ref('')
const newCatType = ref<'expense' | 'income' | 'both'>('expense')
const newCatColor = ref('#10b981')
const newCatIcon = ref('HelpCircle')
const loadingCategory = ref(false)

const presetColors = [
  '#10b981', // Emerald
  '#f43f5e', // Rose
  '#3b82f6', // Blue
  '#fbbf24', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#14b8a6', // Teal
  '#6366f1', // Indigo
  '#6b7280', // Gray
]

const availableIcons = [
  { name: 'Utensils', label: 'Comida' },
  { name: 'Car', label: 'Transporte' },
  { name: 'Film', label: 'Entretenimiento' },
  { name: 'Lightbulb', label: 'Servicios' },
  { name: 'Heart', label: 'Salud' },
  { name: 'GraduationCap', label: 'Educación' },
  { name: 'TrendingUp', label: 'Ingresos' },
  { name: 'HelpCircle', label: 'Otros' },
  { name: 'ShoppingBag', label: 'Compras' },
  { name: 'Home', label: 'Hogar' },
  { name: 'Gift', label: 'Regalos' },
  { name: 'Coffee', label: 'Café/Snacks' },
  { name: 'Plane', label: 'Viajes' },
  { name: 'DollarSign', label: 'Finanzas' },
  { name: 'PiggyBank', label: 'Ahorro' },
  { name: 'Smartphone', label: 'Tecnología' },
  { name: 'Activity', label: 'Deporte' },
  { name: 'Scissors', label: 'Cuidado' },
  { name: 'BookOpen', label: 'Libros' },
  { name: 'Wrench', label: 'Soporte' },
  { name: 'Shield', label: 'Seguros' }
]

const getIconComponent = (iconName: string) => {
  const icons: Record<string, any> = {
    Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
    ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
    Activity, Scissors, BookOpen, Wrench, Shield
  }
  return icons[iconName] || HelpCircle
}

const isDefaultCategory = (name: string) => {
  return ['Comida', 'Transporte', 'Entretenimiento', 'Servicios', 'Salud', 'Educación', 'Ingresos', 'Otros'].includes(name)
}

const createCategory = async () => {
  const validation = CategorySchema.safeParse({
    name: newCatName.value,
    icon: newCatIcon.value,
    color: newCatColor.value,
    type: newCatType.value
  })

  if (!validation.success) {
    alert(validation.error.errors[0].message)
    return
  }

  loadingCategory.value = true
  try {
    await transactionsStore.addCategory({
      name: newCatName.value,
      icon: newCatIcon.value,
      color: newCatColor.value,
      type: newCatType.value
    })
    newCatName.value = ''
    newCatIcon.value = 'HelpCircle'
    newCatColor.value = '#10b981'
    newCatType.value = 'expense'
  } catch (err: any) {
    console.error('Error al crear categoría:', err)
  } finally {
    loadingCategory.value = false
  }
}

const deleteCategory = async (id: string) => {
  if (confirm('¿Estás seguro de que deseas eliminar esta categoría?')) {
    try {
      await transactionsStore.deleteCategory(id)
    } catch (err) {
      console.error('Error al borrar categoría:', err)
    }
  }
}

// Exchange rates
const rateInputs = reactive<Record<string, number | null>>({})
const ratesMsg = ref('')

const foreignCurrencies = computed(() => {
  const set = new Set<string>()
  accountsStore.accounts.forEach(a => {
    if (a.currency && a.currency !== currency.value) set.add(a.currency)
  })
  return Array.from(set).sort()
})

const saveExchangeRate = async (cur: string, rawValue: string) => {
  const value = rawValue === '' ? null : Math.max(0, Number(rawValue))
  rateInputs[cur] = value

  const newRates = { ...goalsStore.exchangeRates }
  if (value === null || value === 0) delete newRates[cur]
  else newRates[cur] = value

  try {
    await goalsStore.saveBudgetSettings({
      budgetIncome: goalsStore.budgetIncome,
      budgetNeedsPercent: goalsStore.budgetNeedsPercent,
      budgetWantsPercent: goalsStore.budgetWantsPercent,
      budgetSavingsPercent: goalsStore.budgetSavingsPercent,
      budgetAllocations: goalsStore.budgetAllocations,
      categoryBudgets: goalsStore.categoryBudgets,
      exchangeRates: newRates
    })
    ratesMsg.value = 'Tasas de cambio actualizadas.'
    setTimeout(() => { ratesMsg.value = '' }, 2500)
  } catch (err) {
    console.error('Error al guardar tasa de cambio:', err)
  }
}

onMounted(async () => {
  await settingsStore.loadSettings()
  aiEnabled.value = settingsStore.aiEnabled
  useCustomKey.value = settingsStore.useCustomKey
  country.value = settingsStore.country
  currency.value = settingsStore.currency
  await transactionsStore.fetchCategories()
  await workspacesStore.fetchMyWorkspaces()
  await accountsStore.fetchAccounts()
  await goalsStore.loadBudgetSettings()
  Object.assign(rateInputs, goalsStore.exchangeRates)
  budgetAlertsEnabled.value = goalsStore.budgetAlertsEnabled
})

// Workspace Management
const newWorkspaceName = ref('')
const creatingWorkspace = ref(false)
const inviteEmail = ref('')
const invitingUser = ref(false)
const inviteMsg = ref('')
const inviteError = ref(false)

const currentWorkspaceName = computed(() => {
  if (!authStore.activeWorkspaceId) return ''
  const ws = workspacesStore.workspaces.find(w => w.id === authStore.activeWorkspaceId)
  return ws ? ws.name : ''
})

const handleCreateWorkspace = async () => {
  if (!newWorkspaceName.value.trim()) return
  
  creatingWorkspace.value = true
  try {
    await workspacesStore.createWorkspace(newWorkspaceName.value.trim())
    newWorkspaceName.value = ''
  } catch (err: any) {
    console.error('Error al crear workspace', err)
    alert(err.message || 'Error al crear workspace')
  } finally {
    creatingWorkspace.value = false
  }
}

const handleInviteUser = async () => {
  if (!inviteEmail.value.trim() || !authStore.activeWorkspaceId) return
  
  invitingUser.value = true
  inviteMsg.value = ''
  inviteError.value = false
  
  try {
    inviteMsg.value = await workspacesStore.inviteUser(authStore.activeWorkspaceId, inviteEmail.value.trim())
    inviteEmail.value = ''
  } catch (err: any) {
    console.error('Error invitando usuario', err)
    inviteError.value = true
    inviteMsg.value = err.message || 'Error al invitar al usuario'
  } finally {
    invitingUser.value = false
  }
}

const budgetAlertsEnabled = ref(true)
const handleBudgetAlertsChange = async () => {
  const enabled = budgetAlertsEnabled.value
  try {
    await goalsStore.saveBudgetAlertsEnabled(enabled)
  } catch (err) {
    console.error('Error actualizando alertas de presupuesto:', err)
    budgetAlertsEnabled.value = !enabled
  }
}

// ponytail: simple handler
const expenseLimitInput = ref<number | ''>('')
const handleUpdateLimit = async () => {
  if (authStore.activeWorkspaceId && expenseLimitInput.value !== '') {
    await workspacesStore.updateWorkspaceLimit(authStore.activeWorkspaceId, Number(expenseLimitInput.value))
    alert('Límite actualizado')
  }
}

const handleGeneralSettingsChange = async () => {
  try {
    await settingsStore.saveSettings({
      aiEnabled: aiEnabled.value,
      useCustomKey: useCustomKey.value,
      country: country.value,
      currency: currency.value
    })
  } catch (err) {
    console.error('Error actualizando configuraciones:', err)
  }
}

const handleCountryChange = async () => {
  const mappedCurrency = countryToCurrencyMap[country.value]
  if (mappedCurrency) {
    currency.value = mappedCurrency
  }
  await handleGeneralSettingsChange()
}

const saveApiKey = async () => {
  if (!customKeyInput.value) return

  successMsg.value = ''
  errorMsg.value = ''

  // Validación con Zod
  const validation = ApiKeySchema.safeParse({ apiKey: customKeyInput.value })
  if (!validation.success) {
    errorMsg.value = validation.error.errors[0].message
    return
  }

  loadingKey.value = true

  try {
    await settingsStore.saveCustomApiKey(customKeyInput.value)
    customKeyInput.value = ''
    successMsg.value = '¡API Key encriptada y guardada con éxito!'
  } catch (err: any) {
    errorMsg.value = err.message || 'Error al intentar guardar la clave.'
  } finally {
    loadingKey.value = false
  }
}
</script>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.3s ease-out forwards;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
