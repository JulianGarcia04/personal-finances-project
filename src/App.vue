<template>
  <div class="min-h-dvh bg-background text-text-primary">
    <!-- Pantalla de Carga Principal -->
    <div v-if="authStore.loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div class="relative w-16 h-16 mb-4">
        <div class="absolute inset-0 rounded-full border-4 border-accent-emerald/20 border-t-accent-emerald animate-spin"></div>
      </div>
      <p class="font-display text-sm tracking-widest text-accent-emerald font-semibold uppercase animate-pulse">Cargando Bóveda...</p>
    </div>

    <!-- App Layout -->
    <div v-else class="flex min-h-dvh w-full overflow-x-clip">
      <!-- Sidebar de Navegación (Solo si está logueado) -->
      <Sidebar v-if="authStore.isAuthenticated" />

      <!-- Área de Contenido Principal -->
      <!-- Mobile: clear the fixed top header (4rem + notch) and bottom tab bar (4rem + home indicator). -->
      <main
        :class="[
          'flex-1 min-w-0 px-4 sm:px-6 lg:px-8 transition-all duration-300 w-full',
          authStore.isAuthenticated
            ? 'lg:pl-72 pt-[calc(5rem+env(safe-area-inset-top))] pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:py-8'
            : 'py-4 sm:py-6 lg:py-8'
        ]"
      >
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>

      <OnboardingWizard v-if="authStore.isAuthenticated" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import OnboardingWizard from '@/components/OnboardingWizard.vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { onForegroundMessage } from '@/lib/push'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()

onMounted(async () => {
  // Inicializar autenticación y configuraciones
  const user = await authStore.init()
  if (user) {
    await settingsStore.loadSettings()
    // Show push alerts that arrive while the app is open on any page (no-op if this device never opted in).
    onForegroundMessage().catch((err) => console.warn('Push foreground listener unavailable:', err))
  }
})
</script>
