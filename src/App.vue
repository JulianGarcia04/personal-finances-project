<template>
  <div class="min-h-screen bg-background text-text-primary">
    <!-- Pantalla de Carga Principal -->
    <div v-if="authStore.loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div class="relative w-16 h-16 mb-4">
        <div class="absolute inset-0 rounded-full border-4 border-accent-emerald/20 border-t-accent-emerald animate-spin"></div>
      </div>
      <p class="font-display text-sm tracking-widest text-accent-emerald font-semibold uppercase animate-pulse">Cargando Bóveda...</p>
    </div>

    <!-- App Layout -->
    <div v-else class="flex min-h-screen w-full overflow-x-hidden">
      <!-- Sidebar de Navegación (Solo si está logueado) -->
      <Sidebar v-if="authStore.isAuthenticated" />

      <!-- Área de Contenido Principal -->
      <main :class="['flex-1 p-6 md:p-8 transition-all duration-300 w-full', authStore.isAuthenticated ? 'lg:pl-72 pt-20 lg:pt-8' : '']">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()

onMounted(async () => {
  // Inicializar autenticación y configuraciones
  const user = await authStore.init()
  if (user) {
    await settingsStore.loadSettings()
  }
})
</script>
