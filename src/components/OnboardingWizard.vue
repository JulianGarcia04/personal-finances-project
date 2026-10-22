<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[70] flex items-end sm:items-center justify-center sm:p-4 bg-black/80 backdrop-blur-xs"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        class="relative flex flex-col w-full sm:max-w-md glass-panel border border-white/10 shadow-2xl rounded-t-3xl sm:rounded-2xl max-h-[92dvh] overflow-y-auto px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-6 space-y-5"
      >
        <header class="space-y-1">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-accent-emerald">Configuración inicial · Paso {{ step }} de 2</p>
          <h2 id="onboarding-title" class="font-display font-bold text-lg text-text-primary">
            {{ step === 1 ? 'Moneda de tus límites de presupuesto' : 'Alertas en este dispositivo' }}
          </h2>
        </header>

        <section v-if="step === 1" class="space-y-4">
          <p class="text-sm text-text-secondary">
            Elige la moneda en la que defines los límites de tu presupuesto mensual. Se guarda una sola vez para este espacio
            y no cambia aunque después cambies la moneda de visualización.
          </p>
          <label class="block space-y-1.5">
            <span class="block text-xs font-semibold text-text-secondary">Moneda de los límites</span>
            <select v-model="currencyCode" class="field font-semibold cursor-pointer" :disabled="saving">
              <option v-for="option in SUPPORTED_CURRENCIES" :key="option.code" :value="option.code">{{ option.label }}</option>
            </select>
          </label>
          <p v-if="error" role="alert" class="text-xs text-accent-rose">{{ error }}</p>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-sm hover:bg-accent-emerald-hover disabled:opacity-50 cursor-pointer"
            :disabled="saving"
            @click="confirmCurrency"
          >
            {{ saving ? 'Guardando…' : 'Confirmar y continuar' }}
          </button>
        </section>

        <section v-else class="space-y-4">
          <p class="text-sm text-text-secondary">
            Recibe un aviso cuando un presupuesto llegue al 80 % o al 100 %. Es opcional: las alertas también llegan por correo,
            y puedes activarlas o desactivarlas después desde Configuración.
          </p>
          <p class="text-xs" :class="pushStatus === 'enabled' ? 'text-accent-emerald' : 'text-text-muted'" role="status" aria-live="polite">
            {{ pushStatusText }}
          </p>
          <button
            v-if="pushStatus === 'disabled'"
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-sm hover:bg-accent-emerald-hover disabled:opacity-50 cursor-pointer"
            :disabled="pushBusy"
            @click="activatePush"
          >
            {{ pushBusy ? 'Activando…' : 'Activar notificaciones' }}
          </button>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-slate-900 border border-border text-text-primary font-display font-semibold text-sm hover:bg-slate-800 cursor-pointer"
            :disabled="pushBusy"
            @click="finish"
          >
            {{ pushStatus === 'enabled' ? 'Terminar' : 'Omitir por ahora' }}
          </button>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SUPPORTED_CURRENCIES, defaultCurrencyCode } from '@/lib/currencies'
import { enablePush, getPushStatus, type PushStatus } from '@/lib/push'
import { useBodyScrollLock } from '@/components/ui/useBodyScrollLock'

const authStore = useAuthStore()
const goalsStore = useGoalsStore()
const settingsStore = useSettingsStore()

const open = ref(false)
const step = ref<1 | 2>(1)
const currencyCode = ref(defaultCurrencyCode(settingsStore.currency))
const saving = ref(false)
const error = ref('')
const pushStatus = ref<PushStatus | 'loading'>('loading')
const pushBusy = ref(false)
const pushError = ref('')

useBodyScrollLock(open)

const currentContextKey = computed(() => {
  const uid = authStore.user?.uid
  const workspaceId = authStore.activeWorkspaceId
  return uid && workspaceId ? JSON.stringify([uid, workspaceId]) : null
})

// Budget settings are otherwise loaded only by Goals; load them once per workspace so
// a fresh account sees the wizard on first entry, whatever page it lands on.
watch(currentContextKey, (key) => {
  if (key && goalsStore.budgetSettingsContextKey !== key) void goalsStore.loadBudgetSettings()
}, { immediate: true })

const needsCurrency = computed(() =>
  currentContextKey.value !== null &&
  goalsStore.budgetSettingsContextKey === currentContextKey.value &&
  !goalsStore.budgetSettingsLoading &&
  !goalsStore.budgetSettingsError &&
  goalsStore.categoryBudgetCurrency.status === 'unconfirmed'
)

watch(needsCurrency, (needed) => {
  if (!needed || open.value) return
  step.value = 1
  error.value = ''
  currencyCode.value = defaultCurrencyCode(settingsStore.currency)
  open.value = true
}, { immediate: true })

// User settings load in parallel with budget settings; keep the prefill in sync until confirmed.
watch(() => settingsStore.currency, (code) => {
  if (step.value === 1 && !saving.value) currencyCode.value = defaultCurrencyCode(code)
})

const confirmCurrency = async () => {
  saving.value = true
  error.value = ''
  try {
    await goalsStore.confirmLegacyCategoryBudgetCurrency(currencyCode.value)
    step.value = 2
    await refreshPushStatus()
  } catch (err) {
    console.error('Error confirmando la moneda de los límites:', err)
    error.value = 'No se pudo guardar la moneda. Intenta de nuevo.'
  } finally {
    saving.value = false
  }
}

const pushStatusText = computed(() => {
  if (pushError.value) return pushError.value
  switch (pushStatus.value) {
    case 'enabled': return 'Activadas en este dispositivo.'
    case 'disabled': return 'Aún no están activadas en este dispositivo.'
    case 'denied': return 'El navegador las bloqueó. Puedes permitirlas en la configuración del navegador.'
    case 'unsupported': return 'Este navegador no soporta notificaciones push. En iPhone, instala Vault con Compartir → Agregar a pantalla de inicio.'
    case 'missing-vapid': return 'Las notificaciones push no están disponibles en esta instalación.'
    default: return 'Verificando…'
  }
})

const refreshPushStatus = async () => {
  try {
    pushStatus.value = await getPushStatus()
  } catch (err) {
    console.error('Error consultando notificaciones push:', err)
    pushStatus.value = 'unsupported'
  }
}

const activatePush = async () => {
  const uid = authStore.user?.uid
  if (!uid || pushBusy.value) return
  pushBusy.value = true
  pushError.value = ''
  try {
    pushStatus.value = await enablePush(uid)
  } catch (err) {
    console.error('Error activando notificaciones push:', err)
    pushError.value = 'No se pudieron activar las notificaciones. Puedes intentarlo después desde Configuración.'
  } finally {
    pushBusy.value = false
  }
}

const finish = () => {
  open.value = false
}
</script>
