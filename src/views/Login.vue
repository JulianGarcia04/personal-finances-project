<template>
  <div class="min-h-screen flex items-center justify-center p-4 relative overflow-hidden moving-mesh">
    <!-- Decortative Glowing Orbs -->
    <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-accent-emerald/5 rounded-full blur-[100px] pointer-events-none"></div>
    <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent-violet/5 rounded-full blur-[100px] pointer-events-none"></div>

    <!-- Login/Register Card -->
    <div class="w-full max-w-md glass-panel rounded-3xl p-6 sm:p-8 md:p-10 relative z-10 shadow-2xl border border-white/5">
      <!-- Title & Branding -->
      <div class="flex flex-col items-center mb-8 text-center">
        <div class="w-12 h-12 rounded-2xl bg-gradient-to-tr from-accent-emerald to-accent-violet flex items-center justify-center shadow-glow-emerald mb-4">
          <span class="font-display font-extrabold text-background text-xl">V</span>
        </div>
        <h2 class="font-display font-bold text-3xl tracking-wide text-text-primary">
          {{ isRegister ? 'Crear una Cuenta' : 'Bienvenido a Vault' }}
        </h2>
        <p class="text-text-secondary text-sm mt-2">
          {{ isRegister ? 'Registra tus datos para empezar a gestionar tus finanzas' : 'Inicia sesión para entrar a tu bóveda personal' }}
        </p>
      </div>

      <!-- Form -->
      <form @submit.prevent="handleSubmit" class="space-y-5">
        <div v-if="isRegister" class="space-y-1">
          <label for="name" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Nombre Completo</label>
          <input 
            id="name"
            v-model="name"
            type="text" 
            required
            placeholder="John Doe"
            class="w-full px-4 py-3 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald transition-colors"
          />
        </div>

        <div class="space-y-1">
          <label for="email" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Correo Electrónico</label>
          <input 
            id="email"
            v-model="email"
            type="email" 
            required
            placeholder="correo@ejemplo.com"
            class="w-full px-4 py-3 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald transition-colors"
          />
        </div>

        <div class="space-y-1">
          <label for="password" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Contraseña</label>
          <input 
            id="password"
            v-model="password"
            type="password" 
            required
            placeholder="••••••••"
            class="w-full px-4 py-3 rounded-xl bg-slate-900/50 border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-emerald transition-colors"
          />
        </div>

        <!-- Error message -->
        <p v-if="errorMessage" class="text-xs text-accent-rose font-medium bg-accent-rose/10 px-3 py-2 rounded-lg border border-accent-rose/20">
          {{ errorMessage }}
        </p>

        <!-- Submit Button -->
        <button 
          type="submit"
          :disabled="loading"
          class="w-full py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm tracking-wide shadow-glow-emerald hover:shadow-lg transition-all duration-200 flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
        >
          <span v-if="loading" class="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
          <span>{{ isRegister ? 'Registrarse' : 'Ingresar a la Bóveda' }}</span>
        </button>
      </form>

      <!-- Toggle Mode link -->
      <div class="mt-6 text-center text-sm">
        <span class="text-text-secondary">
          {{ isRegister ? '¿Ya tienes una cuenta?' : '¿No tienes una cuenta?' }}
        </span>
        <button 
          @click="toggleMode" 
          class="ml-1 text-accent-emerald hover:text-accent-emerald-hover font-semibold transition-colors focus:outline-none"
        >
          {{ isRegister ? 'Inicia Sesión' : 'Regístrate Gratis' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const isRegister = ref(false)
const name = ref('')
const email = ref('')
const password = ref('')
const errorMessage = ref('')
const loading = ref(false)

const toggleMode = () => {
  isRegister.value = !isRegister.value
  errorMessage.value = ''
  name.value = ''
  email.value = ''
  password.value = ''
}

const handleSubmit = async () => {
  errorMessage.value = ''
  loading.value = true
  
  try {
    if (isRegister.value) {
      await authStore.signUp(email.value, password.value, name.value)
    } else {
      await authStore.signIn(email.value, password.value)
    }
    // Cargar configuraciones del usuario
    await settingsStore.loadSettings()
    router.push({ name: 'Dashboard' })
  } catch (error) {
    console.error('Auth Error:', error)
    const err = error as any
    if (err.code === 'auth/invalid-credential') {
      errorMessage.value = 'Correo o contraseña incorrectos.'
    } else if (err.code === 'auth/email-already-in-use') {
      errorMessage.value = 'El correo electrónico ya está registrado.'
    } else if (err.code === 'auth/weak-password') {
      errorMessage.value = 'La contraseña debe tener al menos 6 caracteres.'
    } else {
      errorMessage.value = err.message || 'Ocurrió un error inesperado.'
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
@keyframes mesh {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.moving-mesh {
  background: radial-gradient(circle at 20% 30%, rgba(16, 185, 129, 0.05) 0%, transparent 40%),
              radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.04) 0%, transparent 45%);
  background-size: 200% 200%;
  animation: mesh 12s ease infinite;
}
</style>
