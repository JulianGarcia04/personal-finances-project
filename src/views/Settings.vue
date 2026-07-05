<template>
  <div class="max-w-4xl mx-auto space-y-8">
    <!-- Header -->
    <div>
      <h2 class="font-display font-bold text-3xl text-text-primary tracking-tight">Configuración</h2>
      <p class="text-text-secondary text-sm mt-1">Administra los módulos del sistema y tus llaves de inteligencia artificial.</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Left: Description -->
      <div class="md:col-span-1">
        <h3 class="font-display font-semibold text-lg text-text-primary">Módulo de IA</h3>
        <p class="text-text-secondary text-xs mt-2 leading-relaxed">
          Vault te permite subir archivos de extractos bancarios y procesar su contenido de manera autónoma utilizando Gemini 1.5. 
          Aquí puedes prender o apagar la funcionalidad, y decidir si usas la API Key del sistema o una clave personal.
        </p>
      </div>

      <!-- Right: Settings Panel -->
      <div class="md:col-span-2 space-y-6">
        <!-- Main Toggle Card -->
        <div class="glass-panel rounded-2xl p-6 space-y-6">
          <div class="flex items-start justify-between">
            <div class="space-y-1">
              <h4 class="font-display font-medium text-text-primary">Importador de Extractos Bancarios</h4>
              <p class="text-text-muted text-xs">Habilita o deshabilita la importación automatizada mediante IA.</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                v-model="aiEnabled" 
                @change="handleGeneralSettingsChange"
                class="sr-only peer"
              >
              <div class="w-11 h-6 bg-slate-800 rounded-full peer peer-focus:ring-2 peer-focus:ring-accent-emerald/20 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-slate-400 after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent-emerald peer-checked:after:bg-background"></div>
            </label>
          </div>

          <!-- Sub-options if AI is enabled -->
          <div v-if="aiEnabled" class="pt-6 border-t border-border/50 space-y-6 animate-fade-in">
            <!-- Selector de tipo de llave -->
            <div class="space-y-3">
              <span class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Método de API Key</span>
              
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <!-- Option A: Project Key -->
                <label 
                  :class="[
                    'p-4 rounded-xl border flex flex-col justify-between cursor-pointer transition-all duration-200',
                    !useCustomKey ? 'border-accent-emerald/40 bg-accent-emerald/[0.02]' : 'border-border bg-slate-900/30 hover:bg-slate-900/50'
                  ]"
                >
                  <input 
                    type="radio" 
                    :value="false" 
                    v-model="useCustomKey" 
                    @change="handleGeneralSettingsChange"
                    class="sr-only"
                  />
                  <div>
                    <h5 class="text-sm font-semibold text-text-primary">API Key del Proyecto</h5>
                    <p class="text-text-muted text-xs mt-1">Usa la API Key centralizada. Las consultas corren por cuenta del sistema.</p>
                  </div>
                  <span class="text-[10px] text-accent-emerald font-semibold mt-3 flex items-center space-x-1" v-if="!useCustomKey">
                    <span>✓ Activo</span>
                  </span>
                </label>

                <!-- Option B: Custom Key -->
                <label 
                  :class="[
                    'p-4 rounded-xl border flex flex-col justify-between cursor-pointer transition-all duration-200',
                    useCustomKey ? 'border-accent-emerald/40 bg-accent-emerald/[0.02]' : 'border-border bg-slate-900/30 hover:bg-slate-900/50'
                  ]"
                >
                  <input 
                    type="radio" 
                    :value="true" 
                    v-model="useCustomKey" 
                    @change="handleGeneralSettingsChange"
                    class="sr-only"
                  />
                  <div>
                    <h5 class="text-sm font-semibold text-text-primary">API Key Personal</h5>
                    <p class="text-text-muted text-xs mt-1">Usa tus propios créditos de Google AI Studio. Las consultas corren por tu cuenta.</p>
                  </div>
                  <span class="text-[10px] text-accent-emerald font-semibold mt-3 flex items-center space-x-1" v-if="useCustomKey">
                    <span>✓ Activo</span>
                  </span>
                </label>
              </div>
            </div>

            <!-- Custom Key Configuration Panel -->
            <div v-if="useCustomKey" class="bg-slate-900/40 border border-border rounded-xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <h5 class="text-sm font-semibold text-text-primary">Tu Gemini API Key</h5>
                  <p class="text-text-muted text-xs mt-0.5">Se guardará encriptada con AES-256 en Firestore.</p>
                </div>
                <!-- Status Badge -->
                <span 
                  :class="[
                    'text-[10px] px-2 py-0.5 rounded-full font-semibold border',
                    settingsStore.hasCustomKey 
                      ? 'bg-accent-emerald/10 border-accent-emerald/20 text-accent-emerald' 
                      : 'bg-accent-rose/10 border-accent-rose/20 text-accent-rose'
                  ]"
                >
                  {{ settingsStore.hasCustomKey ? 'Configurada' : 'Sin Configurar' }}
                </span>
              </div>

              <form @submit.prevent="saveApiKey" class="flex flex-col sm:flex-row gap-3">
                <input 
                  type="password" 
                  v-model="customKeyInput"
                  required
                  placeholder="AIzaSy..."
                  class="flex-1 px-4 py-2.5 rounded-xl bg-slate-900/80 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald"
                />
                <button 
                  type="submit"
                  :disabled="loadingKey"
                  class="px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center space-x-2"
                >
                  <span v-if="loadingKey" class="w-3.5 h-3.5 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
                  <span>{{ settingsStore.hasCustomKey ? 'Actualizar' : 'Guardar Llave' }}</span>
                </button>
              </form>

              <p v-if="successMsg" class="text-xs text-accent-emerald font-medium">{{ successMsg }}</p>
              <p v-if="errorMsg" class="text-xs text-accent-rose font-medium">{{ errorMsg }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Módulo de Gestión de Workspace -->
    <div class="border-t border-white/5 pt-8 grid grid-cols-1 md:grid-cols-3 gap-8">
      <div class="md:col-span-1">
        <h3 class="font-display font-semibold text-lg text-text-primary">Gestión de Workspace</h3>
        <p class="text-text-secondary text-xs mt-2 leading-relaxed">
          Administra tu espacio de trabajo actual. Crea nuevos espacios o invita a otros usuarios a colaborar (se requiere su correo electrónico registrado).
        </p>
      </div>

      <div class="md:col-span-2 space-y-6">
        <div class="glass-panel rounded-2xl p-6 space-y-6">
          
          <div class="space-y-4">
            <h4 class="font-display font-medium text-sm text-text-primary">Crear nuevo Workspace</h4>
            <form @submit.prevent="handleCreateWorkspace" class="flex flex-col sm:flex-row gap-3">
              <input 
                type="text" 
                v-model="newWorkspaceName"
                required
                placeholder="Nombre del Workspace (ej. Casa)"
                class="flex-1 px-4 py-2.5 rounded-xl bg-slate-900/80 border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-accent-emerald/40 focus:outline-hidden"
              />
              <button 
                type="submit"
                :disabled="creatingWorkspace"
                class="px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                <PlusIcon class="w-4 h-4" />
                <span>Crear</span>
              </button>
            </form>
          </div>

          <div class="pt-6 border-t border-border/50 space-y-4">
            <h4 class="font-display font-medium text-sm text-text-primary">
              Invitar Miembro al Workspace actual 
              <span class="text-accent-emerald">({{ currentWorkspaceName }})</span>
            </h4>
            <form @submit.prevent="handleInviteUser" class="flex flex-col sm:flex-row gap-3">
              <input 
                type="email" 
                v-model="inviteEmail"
                required
                placeholder="correo@ejemplo.com"
                class="flex-1 px-4 py-2.5 rounded-xl bg-slate-900/80 border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-accent-emerald/40 focus:outline-hidden"
              />
              <button 
                type="submit"
                :disabled="invitingUser"
                class="px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                <MailIcon class="w-4 h-4" />
                <span>Invitar</span>
              </button>
            </form>
            <p v-if="inviteMsg" :class="inviteError ? 'text-accent-rose' : 'text-accent-emerald'" class="text-xs font-medium">{{ inviteMsg }}</p>
          </div>

          <!-- ponytail: Limit setter -->
          <div class="pt-6 border-t border-border/50 space-y-4">
            <h4 class="font-display font-medium text-sm text-text-primary">
              Límite de Gastos 
              <span class="text-accent-emerald">({{ currentWorkspaceName }})</span>
            </h4>
            <form @submit.prevent="handleUpdateLimit" class="flex flex-col sm:flex-row gap-3">
              <input 
                type="number" 
                v-model="expenseLimitInput"
                placeholder="Ej. 1500000"
                class="flex-1 px-4 py-2.5 rounded-xl bg-slate-900/80 border border-border text-sm text-text-primary placeholder:text-text-muted focus:border-accent-emerald/40 focus:outline-hidden"
              />
              <button 
                type="submit"
                class="px-5 py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                <PlusIcon class="w-4 h-4" />
                <span>Actualizar</span>
              </button>
            </form>
          </div>

        </div>
      </div>
    </div>

    <!-- Módulo de Preferencias Regionales -->
    <div class="border-t border-white/5 pt-8 grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Left: Description -->
      <div class="md:col-span-1">
        <h3 class="font-display font-semibold text-lg text-text-primary">Preferencias Regionales</h3>
        <p class="text-text-secondary text-xs mt-2 leading-relaxed">
          Configura tu país de residencia y moneda principal. Esto permitirá al Asesor IA contextualizar sus recomendaciones financieras y tributarias de forma precisa.
        </p>
      </div>

      <!-- Right: Selectors Panel -->
      <div class="md:col-span-2 space-y-6">
        <div class="glass-panel rounded-2xl p-6 space-y-6">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <!-- Country Selector -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">País de Residencia</label>
              <select 
                v-model="country" 
                @change="handleCountryChange"
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold cursor-pointer"
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

            <!-- Currency Selector -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-text-secondary">Moneda Principal</label>
              <select 
                v-model="currency" 
                @change="handleGeneralSettingsChange"
                class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold cursor-pointer"
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
      </div>
    </div>

    <!-- Módulo de Categorías Personalizadas -->
    <div class="border-t border-white/5 pt-8 grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Left: Description -->
      <div class="md:col-span-1">
        <h3 class="font-display font-semibold text-lg text-text-primary">Categorías</h3>
        <p class="text-text-secondary text-xs mt-2 leading-relaxed">
          Crea nuevas categorías personalizadas para tus ingresos y egresos. Las categorías por defecto no se pueden eliminar.
        </p>
      </div>

      <!-- Right: Content Panel -->
      <div class="md:col-span-2 space-y-6">
        <div class="glass-panel rounded-2xl p-6 space-y-6">
          
          <!-- Nueva Categoría Form -->
          <form @submit.prevent="createCategory" class="space-y-4">
            <h4 class="font-display font-medium text-sm text-text-primary">Nueva Categoría</h4>
            
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <!-- Name Input -->
              <div class="space-y-1.5">
                <label class="block text-xs font-semibold text-text-secondary">Nombre de la Categoría</label>
                <input 
                  type="text" 
                  v-model="newCatName"
                  required
                  placeholder="Ej. Mascotas, Gimnasio"
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-955 border border-white/5 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-emerald/40 focus:outline-hidden"
                />
              </div>

              <!-- Type Selector -->
              <div class="space-y-1.5">
                <label class="block text-xs font-semibold text-text-secondary">Tipo de Movimiento</label>
                <select 
                  v-model="newCatType" 
                  class="w-full px-4 py-2.5 rounded-xl bg-slate-955 border border-white/5 text-sm text-text-primary focus:border-accent-emerald/40 focus:outline-hidden transition-all font-semibold cursor-pointer"
                >
                  <option value="expense">Solo Gastos (Egreso)</option>
                  <option value="income">Solo Ingresos (Ingreso)</option>
                  <option value="both">Ambos (Ingreso y Egreso)</option>
                </select>
              </div>
            </div>

            <!-- Color Palette Selector -->
            <div class="space-y-2">
              <label class="block text-xs font-semibold text-text-secondary">Color de la Categoría</label>
              <div class="flex flex-wrap gap-2 items-center">
                <button 
                  v-for="color in presetColors" 
                  :key="color"
                  type="button"
                  @click="newCatColor = color"
                  :style="{ backgroundColor: color }"
                  :class="[
                    'w-7 h-7 rounded-full transition-all border cursor-pointer',
                    newCatColor === color ? 'border-white scale-110 shadow-lg' : 'border-transparent hover:scale-105'
                  ]"
                ></button>
                <!-- Custom Color Picker -->
                <label class="relative w-7 h-7 rounded-full border border-white/10 flex items-center justify-center cursor-pointer overflow-hidden hover:scale-105 transition-all">
                  <input 
                    type="color" 
                    v-model="newCatColor" 
                    class="absolute inset-0 opacity-0 cursor-pointer" 
                  />
                  <span 
                    class="w-full h-full" 
                    :style="{ backgroundColor: newCatColor }"
                  ></span>
                </label>
                <span class="text-xs text-text-muted font-mono ml-2">{{ newCatColor }}</span>
              </div>
            </div>

            <!-- Icon Selector -->
            <div class="space-y-2">
              <label class="block text-xs font-semibold text-text-secondary">Icono de la Categoría</label>
              <div class="grid grid-cols-6 sm:grid-cols-7 gap-2 p-3 rounded-xl bg-slate-950/50 border border-white/5 max-h-48 overflow-y-auto custom-scrollbar">
                <button 
                  v-for="icon in availableIcons" 
                  :key="icon.name"
                  type="button"
                  @click="newCatIcon = icon.name"
                  :title="icon.label"
                  :class="[
                    'p-2 rounded-lg flex items-center justify-center border transition-all cursor-pointer hover:bg-white/5',
                    newCatIcon === icon.name 
                      ? 'border-accent-emerald/40 bg-accent-emerald/10 text-accent-emerald' 
                      : 'border-transparent text-text-secondary hover:text-text-primary'
                  ]"
                >
                  <component :is="getIconComponent(icon.name)" class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Submit Button -->
            <button 
              type="submit"
              :disabled="loadingCategory"
              class="w-full py-2.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm shadow-glow-emerald cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-2 transition-all"
            >
              <PlusIcon class="w-4 h-4" />
              <span>Crear Categoría</span>
            </button>
          </form>

          <!-- List of Existing Categories -->
          <div class="pt-6 border-t border-border/50 space-y-3">
            <h4 class="font-display font-medium text-sm text-text-primary">Tus Categorías</h4>
            <div class="flex flex-wrap gap-2.5">
              <span 
                v-for="cat in transactionsStore.categories" 
                :key="cat.id"
                class="inline-flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold border border-white/5 bg-slate-900/40 text-text-primary"
              >
                <!-- Dot for color -->
                <span class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: cat.color }"></span>
                <!-- Icon -->
                <component :is="getIconComponent(cat.icon)" class="w-3.5 h-3.5" :style="{ color: cat.color }" />
                <span>{{ cat.name }}</span>
                <!-- Badge for Type -->
                <span class="text-[9px] px-1.5 py-0.5 rounded-md bg-white/5 text-text-muted font-normal">
                  {{ cat.type === 'expense' ? 'Gasto' : cat.type === 'income' ? 'Ingreso' : 'Ambos' }}
                </span>
                <!-- Delete button (if custom) -->
                <button 
                  v-if="!isDefaultCategory(cat.name)"
                  type="button"
                  @click="deleteCategory(cat.id)"
                  class="p-0.5 rounded-md text-text-muted hover:text-accent-rose hover:bg-white/10 transition-all cursor-pointer ml-1"
                  title="Eliminar categoría"
                >
                  <TrashIcon class="w-3 h-3" />
                </button>
              </span>
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { ApiKeySchema, CategorySchema } from '@/schemas'
import { 
  Utensils, Car, Film, Lightbulb, Heart, GraduationCap, TrendingUp, HelpCircle,
  ShoppingBag, Home, Gift, Coffee, Plane, DollarSign, PiggyBank, Smartphone,
  Activity, Scissors, BookOpen, Wrench, Shield,
  Trash2 as TrashIcon, Plus as PlusIcon, Mail as MailIcon
} from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const workspacesStore = useWorkspacesStore()
const transactionsStore = useTransactionsStore()

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

onMounted(async () => {
  await settingsStore.loadSettings()
  aiEnabled.value = settingsStore.aiEnabled
  useCustomKey.value = settingsStore.useCustomKey
  country.value = settingsStore.country
  currency.value = settingsStore.currency
  await transactionsStore.fetchCategories()
  await workspacesStore.fetchMyWorkspaces()
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
    await workspacesStore.inviteUser(authStore.activeWorkspaceId, inviteEmail.value.trim())
    inviteMsg.value = `¡${inviteEmail.value} invitado exitosamente!`
    inviteEmail.value = ''
  } catch (err: any) {
    console.error('Error invitando usuario', err)
    inviteError.value = true
    inviteMsg.value = err.message || 'Error al invitar al usuario'
  } finally {
    invitingUser.value = false
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
