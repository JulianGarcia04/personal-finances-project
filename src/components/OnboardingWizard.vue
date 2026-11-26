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
          <p class="text-[11px] font-semibold uppercase tracking-widest text-accent-emerald">Configuración inicial · Paso {{ stepNumber }} de {{ steps.length }}</p>
          <h2 id="onboarding-title" class="font-display font-bold text-lg text-text-primary">{{ stepTitle }}</h2>
        </header>

        <section v-if="step === 'region'" class="space-y-4">
          <p class="text-sm text-text-secondary">
            Tu país y tu moneda principal definen cómo ves tu patrimonio y tus KPIs, y le dan contexto tributario al Asesor IA.
            Puedes cambiarlos después en Configuración.
          </p>
          <label class="block space-y-1.5">
            <span class="block text-xs font-semibold text-text-secondary">País de residencia</span>
            <select v-model="countryCode" class="field font-semibold cursor-pointer" :disabled="saving" @change="handleCountryChange">
              <option v-for="option in SUPPORTED_COUNTRIES" :key="option.code" :value="option.code">{{ option.label }}</option>
            </select>
          </label>
          <label class="block space-y-1.5">
            <span class="block text-xs font-semibold text-text-secondary">Moneda principal</span>
            <select v-model="mainCurrencyCode" class="field font-semibold cursor-pointer" :disabled="saving">
              <option v-for="option in SUPPORTED_CURRENCIES" :key="option.code" :value="option.code">{{ option.label }}</option>
            </select>
          </label>
          <p v-if="error" role="alert" class="text-xs text-accent-rose">{{ error }}</p>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-sm hover:bg-accent-emerald-hover disabled:opacity-50 cursor-pointer"
            :disabled="saving || settingsStore.loading"
            @click="confirmRegion"
          >
            {{ saving ? 'Guardando…' : 'Continuar' }}
          </button>
        </section>

        <section v-else-if="step === 'currency'" class="space-y-4">
          <p class="text-sm text-text-secondary">
            Es la moneda en la que escribes los límites por categoría de tu presupuesto mensual, por ejemplo cuánto quieres gastar en comida cada mes.
            Te proponemos tu moneda principal; se fija una sola vez para este espacio y no cambia aunque después cambies tu moneda principal.
          </p>
          <label class="block space-y-1.5">
            <span class="block text-xs font-semibold text-text-secondary">Moneda de los límites</span>
            <select v-model="currencyCode" class="field font-semibold cursor-pointer" :disabled="saving || currencyConfirmed">
              <option v-for="option in SUPPORTED_CURRENCIES" :key="option.code" :value="option.code">{{ option.label }}</option>
            </select>
          </label>
          <p v-if="currencyConfirmed" class="text-xs text-text-muted">Ya quedó confirmada para este espacio.</p>
          <p v-if="error" role="alert" class="text-xs text-accent-rose">{{ error }}</p>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-sm hover:bg-accent-emerald-hover disabled:opacity-50 cursor-pointer"
            :disabled="saving"
            @click="confirmCurrency"
          >
            {{ saving ? 'Guardando…' : currencyConfirmed ? 'Continuar' : 'Confirmar y continuar' }}
          </button>
        </section>

        <section v-else-if="step === 'alerts'" class="space-y-4">
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
            @click="advance"
          >
            {{ pushStatus !== 'enabled' ? 'Omitir por ahora' : isLastStep ? 'Terminar' : 'Continuar' }}
          </button>
        </section>

        <section v-else class="space-y-4">
          <p class="text-sm text-text-secondary">
            Para registrar tus gastos e ingresos, empieza por crear tu primera cuenta: una cuenta de ahorros, una tarjeta de crédito o tu efectivo.
          </p>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-accent-emerald text-background font-display font-bold text-sm hover:bg-accent-emerald-hover cursor-pointer"
            @click="createFirstAccount"
          >
            Crear mi primera cuenta
          </button>
          <button
            type="button"
            class="w-full min-h-11 px-4 py-2.5 rounded-xl bg-slate-900 border border-border text-text-primary font-display font-semibold text-sm hover:bg-slate-800 cursor-pointer"
            @click="finish"
          >
            Más tarde
          </button>
        </section>

        <button
          v-if="canGoBack"
          type="button"
          class="w-full min-h-11 px-4 py-2.5 rounded-xl text-text-secondary font-display font-semibold text-sm hover:text-text-primary hover:bg-white/5 disabled:opacity-50 cursor-pointer"
          :disabled="saving || pushBusy"
          @click="goBack"
        >
          Atrás
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { track } from '@/lib/analytics'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SUPPORTED_COUNTRIES, SUPPORTED_CURRENCIES, currencyForCountry, defaultCurrencyCode } from '@/lib/currencies'
import { enablePush, getPushStatus, type PushStatus } from '@/lib/push'
import { useBodyScrollLock } from '@/components/ui/useBodyScrollLock'

type WizardStep = 'region' | 'currency' | 'alerts' | 'account'

const STEP_TITLES: Record<WizardStep, string> = {
  region: 'Tu país y moneda principal',
  currency: 'Moneda de tus límites de presupuesto',
  alerts: 'Alertas en este dispositivo',
  account: 'Crea tu primera cuenta'
}

const authStore = useAuthStore()
const accountsStore = useAccountsStore()
const goalsStore = useGoalsStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const open = ref(false)
const step = ref<WizardStep>('region')
// Decided once, before the wizard opens, so the counter and "Atrás" never change while it is open.
const steps = ref<WizardStep[]>([])
// Without a saved country the profile currency is just a signup default, so propose the country's own.
const proposedMainCurrency = () => settingsStore.countryConfigured
  ? defaultCurrencyCode(settingsStore.currency)
  : currencyForCountry(settingsStore.country)

const countryCode = ref(settingsStore.country)
const mainCurrencyCode = ref(proposedMainCurrency())
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
const currencyConfirmed = computed(() => goalsStore.categoryBudgetCurrency.status === 'confirmed')

// Known only once the active workspace's accounts were loaded.
const hasNoAccounts = computed(() =>
  authStore.activeWorkspaceId !== null &&
  accountsStore.loadedWorkspaceId === authStore.activeWorkspaceId &&
  accountsStore.accounts.length === 0
)
// A failed accounts load must never keep the currency step from showing: it opens without the prompt.
const accountsCheckEndedFor = ref<string | null>(null)
const accountsKnown = computed(() => {
  const workspaceId = authStore.activeWorkspaceId
  return workspaceId !== null &&
    (accountsStore.loadedWorkspaceId === workspaceId || accountsCheckEndedFor.value === workspaceId)
})
const stepIndex = computed(() => steps.value.indexOf(step.value))
const stepNumber = computed(() => stepIndex.value + 1)
const canGoBack = computed(() => stepIndex.value > 0)
const isLastStep = computed(() => stepIndex.value === steps.value.length - 1)
const stepTitle = computed(() => STEP_TITLES[step.value])

const goTo = async (target: WizardStep) => {
  error.value = ''
  step.value = target
  if (target === 'alerts') await refreshPushStatus()
}

// Opens only for a workspace whose limit currency is unconfirmed (a new workspace stores it
// confirmed), once user settings are loaded so a saved country skips the region step.
const readyToOpen = computed(() => needsCurrency.value && !settingsStore.loading)

// The switcher and the Dashboard usually loaded the accounts already; load them only when they did not.
watch(readyToOpen, (ready) => {
  const workspaceId = authStore.activeWorkspaceId
  if (!ready || open.value || !workspaceId || accountsStore.loadedWorkspaceId === workspaceId) return
  void accountsStore.fetchAccounts().catch(() => false).then(() => { accountsCheckEndedFor.value = workspaceId })
}, { immediate: true })

watch(() => readyToOpen.value && accountsKnown.value, (ready) => {
  if (!ready || open.value) return
  countryCode.value = settingsStore.country
  mainCurrencyCode.value = proposedMainCurrency()
  currencyCode.value = defaultCurrencyCode(settingsStore.currency)
  steps.value = [
    ...(settingsStore.countryConfigured ? [] : ['region' as const]),
    ...(currencyConfirmed.value ? [] : ['currency' as const]),
    'alerts',
    ...(hasNoAccounts.value ? ['account' as const] : [])
  ]
  void goTo(steps.value[0])
  open.value = true
}, { immediate: true })

// User settings load in parallel with budget settings; keep the region prefill in sync until saved.
watch(() => [settingsStore.country, settingsStore.currency, settingsStore.countryConfigured], () => {
  if (step.value !== 'region' || saving.value) return
  countryCode.value = settingsStore.country
  mainCurrencyCode.value = proposedMainCurrency()
})

const advance = async () => {
  const next = steps.value[stepIndex.value + 1]
  if (next) await goTo(next)
  else finish()
}

const goBack = () => goTo(steps.value[stepIndex.value - 1])

const handleCountryChange = () => {
  mainCurrencyCode.value = currencyForCountry(countryCode.value)
}

const confirmRegion = async () => {
  saving.value = true
  error.value = ''
  try {
    await settingsStore.saveSettings({
      aiEnabled: settingsStore.aiEnabled,
      useCustomKey: settingsStore.useCustomKey,
      country: countryCode.value,
      currency: mainCurrencyCode.value
    })
    if (!currencyConfirmed.value) currencyCode.value = defaultCurrencyCode(mainCurrencyCode.value)
    await advance()
  } catch (err) {
    console.error('Error guardando país y moneda:', err)
    error.value = 'No se pudo guardar tu país y moneda. Intenta de nuevo.'
  } finally {
    saving.value = false
  }
}

const confirmCurrency = async () => {
  saving.value = true
  error.value = ''
  try {
    // Coming back to a confirmed currency only shows it; the confirmation happens once.
    if (!currencyConfirmed.value) await goalsStore.confirmLegacyCategoryBudgetCurrency(currencyCode.value)
    await advance()
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
    case 'unsupported': return 'Este navegador no soporta notificaciones push. En iPhone, instala Lynor Finanzas con Compartir → Agregar a pantalla de inicio.'
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
  track('onboarding_finished', { push_enabled: pushStatus.value === 'enabled' })
  open.value = false
}

const createFirstAccount = () => {
  finish()
  void router.push({ name: 'Accounts' })
}
</script>
