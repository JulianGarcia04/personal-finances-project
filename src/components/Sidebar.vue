<template>
  <div>
    <!-- Mobile Top Header (brand only; navigation lives in the bottom tab bar) -->
    <header
      v-if="authStore.isAuthenticated"
      class="lg:hidden fixed top-0 left-0 right-0 h-[calc(4rem+env(safe-area-inset-top))] pt-safe glass-panel border-b border-white/5 z-30 flex items-center px-4 backdrop-blur-md bg-background/80"
    >
      <div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-accent-emerald to-accent-violet flex items-center justify-center shadow-glow-emerald">
          <span class="font-display font-extrabold text-background text-sm">V</span>
        </div>
        <span class="font-display font-bold text-lg tracking-wider text-text-primary">LYNOR FINANZAS</span>
      </div>
    </header>

    <!-- Overlay when mobile menu open -->
    <Transition name="fade">
      <div
        v-if="isOpen"
        @click="isOpen = false"
        class="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
      ></div>
    </Transition>

    <!-- Sidebar Container -->
    <aside
      id="app-drawer"
      :inert="!isDesktop && !isOpen"
      :class="[
        'fixed top-0 bottom-0 left-0 z-40 w-64 max-w-[85vw] glass-panel border-r border-border flex flex-col justify-between px-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] overflow-y-auto overscroll-contain custom-scrollbar transition-transform duration-300 ease-in-out',
        isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      ]"
    >
      <!-- Top Section: Brand Logo -->
      <div>
        <div class="flex items-center space-x-3 mb-6 px-2 py-4">
          <div class="shrink-0 w-9 h-9 rounded-xl bg-gradient-to-tr from-accent-emerald to-accent-violet flex items-center justify-center shadow-glow-emerald">
            <span class="font-display font-extrabold text-background text-lg">V</span>
          </div>
          <div>
            <h1 class="font-display font-bold text-xl tracking-wider text-text-primary">LYNOR</h1>
            <p class="text-[10px] tracking-widest text-accent-emerald font-semibold uppercase">Finanzas IA</p>
          </div>
          <button
            type="button"
            @click="isOpen = false"
            aria-label="Cerrar menú"
            class="lg:hidden tap ml-auto -mr-2 flex items-center justify-center rounded-xl text-text-secondary hover:text-text-primary hover:bg-white/5 active:bg-white/10 transition-colors"
          >
            <XIcon class="w-5 h-5" />
          </button>
        </div>

        <!-- Workspace Switcher -->
        <div ref="workspaceMenuRef" class="mb-6 px-2 relative" v-if="workspacesStore.workspaces.length > 0">
          <button
            type="button"
            @click="isWorkspaceMenuOpen = !isWorkspaceMenuOpen"
            :aria-expanded="isWorkspaceMenuOpen"
            aria-haspopup="listbox"
            class="w-full min-h-11 flex items-center justify-between px-3 py-2 rounded-xl bg-slate-800/50 border border-border hover:bg-slate-700/50 transition-colors group"
          >
            <div class="flex items-center space-x-2 truncate">
              <BuildingIcon class="shrink-0 w-4 h-4 text-accent-emerald" />
              <span class="text-sm font-medium text-text-primary truncate">
                {{ activeWorkspaceName }}
              </span>
            </div>
            <ChevronDownIcon
              class="shrink-0 w-4 h-4 text-text-muted transition-transform" 
              :class="{ 'rotate-180': isWorkspaceMenuOpen }"
            />
          </button>
          
          <!-- Dropdown -->
          <div 
            v-if="isWorkspaceMenuOpen"
            class="absolute top-full left-2 right-2 mt-1 py-1 rounded-xl glass-panel border border-border z-50 overflow-hidden shadow-xl"
          >
            <button
              v-for="ws in workspacesStore.workspaces"
              :key="ws.id"
              @click="switchWorkspace(ws.id)"
              type="button"
              class="w-full min-h-11 lg:min-h-0 text-left px-4 py-2 text-sm hover:bg-white/5 transition-colors flex items-center justify-between"
              :class="{ 'text-accent-emerald font-medium bg-accent-emerald/5': ws.id === authStore.activeWorkspaceId, 'text-text-secondary': ws.id !== authStore.activeWorkspaceId }"
            >
              <span class="truncate">{{ ws.name }}</span>
              <div v-if="ws.id === authStore.activeWorkspaceId" class="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-emerald"></div>
            </button>
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
          <div class="shrink-0 w-10 h-10 rounded-full bg-slate-800 border border-border flex items-center justify-center font-display font-semibold text-accent-emerald">
            {{ userInitials }}
          </div>
          <div class="min-w-0 truncate">
            <h3 class="text-sm font-semibold text-text-primary truncate">{{ authStore.user?.displayName }}</h3>
            <p class="text-xs text-text-muted truncate">{{ authStore.user?.email }}</p>
          </div>
        </div>

        <button
          type="button"
          @click="handleLogout"
          class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium text-accent-rose hover:bg-accent-rose/10 hover:text-white transition-all duration-200"
        >
          <LogOutIcon class="w-5 h-5" />
          <span>Cerrar Sesión</span>
        </button>
      </div>
    </aside>

    <!-- Mobile Bottom Tab Bar -->
    <nav
      v-if="authStore.isAuthenticated"
      aria-label="Navegación principal"
      class="lg:hidden fixed bottom-0 inset-x-0 z-30 glass-panel border-t border-white/5 bg-background/85 backdrop-blur-md pb-safe"
    >
      <ul class="grid grid-cols-5 h-16 px-1">
        <li v-for="tab in tabItems" :key="tab.path" class="min-w-0">
          <router-link
            :to="tab.path"
            v-slot="{ href, navigate, isActive }"
            custom
          >
            <a
              :href="href"
              @click="navigate"
              :aria-current="isActive && !isOpen ? 'page' : undefined"
              :class="[
                'h-full flex flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors',
                isActive && !isOpen ? 'text-accent-emerald' : 'text-text-muted active:text-text-primary'
              ]"
            >
              <span
                :class="[
                  'flex items-center justify-center w-12 h-7 rounded-full transition-colors',
                  isActive && !isOpen ? 'bg-accent-emerald/10 shadow-glow-emerald' : ''
                ]"
              >
                <component :is="tab.icon" class="w-5 h-5" />
              </span>
              <span class="max-w-full truncate px-0.5">{{ tab.name }}</span>
            </a>
          </router-link>
        </li>
        <li class="min-w-0">
          <button
            type="button"
            @click="isOpen = !isOpen"
            :aria-expanded="isOpen"
            aria-controls="app-drawer"
            :class="[
              'w-full h-full flex flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors',
              isOpen || isMoreRouteActive ? 'text-accent-emerald' : 'text-text-muted active:text-text-primary'
            ]"
          >
            <span
              :class="[
                'flex items-center justify-center w-12 h-7 rounded-full transition-colors',
                isOpen || isMoreRouteActive ? 'bg-accent-emerald/10 shadow-glow-emerald' : ''
              ]"
            >
              <MoreIcon class="w-5 h-5" />
            </span>
            <span>Más</span>
          </button>
        </li>
      </ul>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBodyScrollLock } from '@/components/ui/useBodyScrollLock'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { 
  LayoutDashboard as DashboardIcon, 
  Landmark as AccountsIcon, 
  ArrowRightLeft as TransactionsIcon, 
  Sparkles as ImportIcon, 
  Settings as SettingsIcon, 
  LogOut as LogOutIcon,
  Ellipsis as MoreIcon,
  X as XIcon,
  Bot as AgentIcon,
  Target as GoalsIcon,
  Building as BuildingIcon,
  ChevronDown as ChevronDownIcon
} from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const workspacesStore = useWorkspacesStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const goalsStore = useGoalsStore()
const router = useRouter()
const route = useRoute()

const isOpen = ref(false)
const isWorkspaceMenuOpen = ref(false)
const workspaceMenuRef = ref<HTMLElement | null>(null)

// Drawer is off-canvas only below lg (1024px); keep in sync to release locks on resize.
const desktopQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null
const isDesktop = ref(desktopQuery?.matches ?? false)
const onDesktopChange = (event: MediaQueryListEvent) => {
  isDesktop.value = event.matches
  if (event.matches) isOpen.value = false
}

useBodyScrollLock(() => isOpen.value && !isDesktop.value)

// Close drawer and workspace menu whenever navigation happens.
watch(
  () => route.fullPath,
  () => {
    isOpen.value = false
    isWorkspaceMenuOpen.value = false
  }
)

watch(isOpen, (open) => {
  if (!open) isWorkspaceMenuOpen.value = false
})

const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  if (isWorkspaceMenuOpen.value) {
    isWorkspaceMenuOpen.value = false
  } else if (isOpen.value) {
    isOpen.value = false
  }
}

const onPointerDown = (event: PointerEvent) => {
  if (!isWorkspaceMenuOpen.value) return
  const target = event.target as Node | null
  if (workspaceMenuRef.value && target && !workspaceMenuRef.value.contains(target)) {
    isWorkspaceMenuOpen.value = false
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('pointerdown', onPointerDown)
  desktopQuery?.addEventListener('change', onDesktopChange)
  if (authStore.user) {
    await workspacesStore.fetchMyWorkspaces()
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('pointerdown', onPointerDown)
  desktopQuery?.removeEventListener('change', onDesktopChange)
})

const activeWorkspaceName = computed(() => {
  if (!authStore.activeWorkspaceId) return 'Cargando...'
  const ws = workspacesStore.workspaces.find(w => w.id === authStore.activeWorkspaceId)
  return ws ? ws.name : 'Workspace'
})

const switchWorkspace = async (workspaceId: string) => {
  if (workspaceId === authStore.activeWorkspaceId) {
    isWorkspaceMenuOpen.value = false
    return
  }
  
  await authStore.switchWorkspace(workspaceId)
  isWorkspaceMenuOpen.value = false
  isOpen.value = false // Cierra sidebar en móvil
  
  // Recargar datos reactivos de stores operativas para el nuevo workspace
  await Promise.all([
    accountsStore.fetchAccounts(),
    transactionsStore.fetchTransactions(),
    goalsStore.fetchGoals(),
    goalsStore.loadBudgetSettings(),
    transactionsStore.fetchCategories()
  ])
  
  // Opcional: Redirigir al dashboard para limpiar vistas profundas
  if (router.currentRoute.value.name !== 'Dashboard') {
    router.push({ name: 'Dashboard' })
  }
}

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

// Mobile bottom tab bar: primary destinations; everything else lives in the "Más" drawer.
const tabItems = [
  { name: 'Inicio', path: '/', icon: DashboardIcon },
  { name: 'Transacciones', path: '/transactions', icon: TransactionsIcon },
  { name: 'Cuentas', path: '/accounts', icon: AccountsIcon },
  { name: 'Metas', path: '/goals', icon: GoalsIcon }
]

const isMoreRouteActive = computed(() => !tabItems.some(tab => tab.path === route.path))

const handleLogout = async () => {
  try {
    await authStore.logout()
    router.push({ name: 'Login' })
  } catch (err) {
    console.error('Error al salir:', err)
  }
}
</script>
