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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import { ApiKeySchema } from '@/schemas'

const settingsStore = useSettingsStore()

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

onMounted(async () => {
  await settingsStore.loadSettings()
  aiEnabled.value = settingsStore.aiEnabled
  useCustomKey.value = settingsStore.useCustomKey
  country.value = settingsStore.country
  currency.value = settingsStore.currency
})

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
