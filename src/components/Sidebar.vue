<template>
  <div>
    <!-- Mobile Hamburger Menu Toggle -->
    <button 
      @click="isOpen = !isOpen"
      class="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-surface border border-border text-text-primary hover:bg-slate-800 transition-colors"
      aria-label="Toggle Menu"
    >
      <component :is="isOpen ? XIcon : MenuIcon" class="w-6 h-6" />
    </button>

    <!-- Overlay when mobile menu open -->
    <div 
      v-if="isOpen" 
      @click="isOpen = false" 
      class="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
    ></div>

    <!-- Sidebar Container -->
    <aside 
      :class="[
        'fixed top-0 bottom-0 left-0 z-40 w-64 glass-panel border-r border-border flex flex-col justify-between p-6 transition-transform duration-300 ease-in-out',
        isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      ]"
    >
      <!-- Top Section: Brand Logo -->
      <div>
        <div class="flex items-center space-x-3 mb-8 px-2 py-4">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-accent-emerald to-accent-violet flex items-center justify-center shadow-glow-emerald">
            <span class="font-display font-extrabold text-background text-lg">V</span>
          </div>
          <div>
            <h1 class="font-display font-bold text-xl tracking-wider text-text-primary">VAULT</h1>
            <p class="text-[10px] tracking-widest text-accent-emerald font-semibold uppercase">Finanzas IA</p>
          </div>
        </div>

        <!-- Navigation Links -->
        <nav class="space-y-1">
          <router-link 
            v-for="item in navItems" 
            :key="item.path" 
            :to="item.path"
            @click="isOpen = false"
            class="flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 group text-text-secondary hover:text-text-primary hover:bg-white/5"
            active-class="bg-accent-emerald/10 text-accent-emerald! shadow-glow-emerald border-l-2 border-accent-emerald"
          >
            <component :is="item.icon" class="w-5 h-5 transition-transform group-hover:scale-110" />
            <span>{{ item.name }}</span>
          </router-link>
        </nav>
      </div>

      <!-- Bottom Section: User Info and Logout -->
      <div class="border-t border-border pt-4 mt-6">
        <div class="flex items-center space-x-3 px-2 py-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-slate-800 border border-border flex items-center justify-center font-display font-semibold text-accent-emerald">
            {{ userInitials }}
          </div>
          <div class="truncate">
            <h3 class="text-sm font-semibold text-text-primary truncate">{{ authStore.user?.displayName }}</h3>
            <p class="text-xs text-text-muted truncate">{{ authStore.user?.email }}</p>
          </div>
        </div>

        <button 
          @click="handleLogout"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium text-accent-rose hover:bg-accent-rose/10 hover:text-white transition-all duration-200"
        >
          <LogOutIcon class="w-5 h-5" />
          <span>Cerrar Sesión</span>
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { 
  LayoutDashboard as DashboardIcon, 
  Landmark as AccountsIcon, 
  ArrowRightLeft as TransactionsIcon, 
  Sparkles as ImportIcon, 
  Settings as SettingsIcon, 
  LogOut as LogOutIcon,
  Menu as MenuIcon,
  X as XIcon,
  Bot as AgentIcon,
  Target as GoalsIcon
} from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const isOpen = ref(false)

const userInitials = computed(() => {
  const name = authStore.user?.displayName || ''
  if (!name) return 'U'
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
})

const navItems = computed(() => {
  const items = [
    { name: 'Dashboard', path: '/', icon: DashboardIcon },
    { name: 'Cuentas', path: '/accounts', icon: AccountsIcon },
    { name: 'Transacciones', path: '/transactions', icon: TransactionsIcon },
    { name: 'Presupuestos & Metas', path: '/goals', icon: GoalsIcon }
  ]

  // Mostrar herramientas IA solo si están habilitadas en configuraciones
  if (settingsStore.aiEnabled) {
    items.push({ name: 'Asesor IA', path: '/agent', icon: AgentIcon })
    items.push({ name: 'Importador IA', path: '/import', icon: ImportIcon })
  }

  items.push({ name: 'Configuración', path: '/settings', icon: SettingsIcon })

  return items
})

const handleLogout = async () => {
  try {
    await authStore.logout()
    router.push({ name: 'Login' })
  } catch (err) {
    console.error('Error al salir:', err)
  }
}
</script>
