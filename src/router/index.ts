import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { guestOnly: true }
  },
  {
    path: '/bienvenida',
    name: 'Landing',
    component: () => import('@/views/Landing.vue'),
    meta: { guestOnly: true }
  },
  {
    path: '/terminos',
    name: 'Terms',
    component: () => import('@/views/Legal.vue'),
    props: { doc: 'terms' }
  },
  {
    path: '/privacidad',
    name: 'Privacy',
    component: () => import('@/views/Legal.vue'),
    props: { doc: 'privacy' }
  },
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/accounts',
    name: 'Accounts',
    component: () => import('@/views/Accounts.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/transactions',
    name: 'Transactions',
    component: () => import('@/views/Transactions.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/import',
    name: 'Import',
    component: () => import('@/views/Import.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/agent',
    name: 'Agent',
    component: () => import('@/views/Agent.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/goals',
    name: 'Goals',
    component: () => import('@/views/Goals.vue'),
    meta: { requiresAuth: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// The installed app opens straight to the login, never the landing.
const isInstalledApp = () => window.matchMedia('(display-mode: standalone)').matches

// Guards de navegación basados en autenticación de Firebase
router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore()
  
  if (authStore.loading) {
    await authStore.init()
  }

  const isAuth = authStore.isAuthenticated

  if (to.meta.requiresAuth && !isAuth) {
    next(to.name === 'Dashboard' && !isInstalledApp() ? { name: 'Landing' } : { name: 'Login' })
  } else if (to.meta.guestOnly && isAuth) {
    next({ name: 'Dashboard' })
  } else {
    next()
  }
})

export default router
