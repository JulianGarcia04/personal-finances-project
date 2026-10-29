<template>
  <div class="min-h-screen min-h-dvh flex items-center justify-center px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] relative overflow-hidden moving-mesh">
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
        <h2 class="font-display font-bold text-2xl sm:text-3xl tracking-wide text-text-primary">
          {{ isReset ? 'Recupera tu contraseña' : isRegister ? 'Crear una Cuenta' : 'Bienvenido a Vault' }}
        </h2>
        <p class="text-text-secondary text-sm mt-2">
          {{ isReset ? 'Te enviaremos un enlace para crear una contraseña nueva' : isRegister ? 'Registra tus datos para empezar a gestionar tus finanzas' : 'Inicia sesión para entrar a tu bóveda personal' }}
        </p>
      </div>

      <!-- Google sign-in -->
      <template v-if="!isReset">
        <button
          type="button"
          @click="handleGoogle"
          :disabled="loading"
          class="w-full min-h-11 py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-text-primary font-semibold text-sm transition-colors flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
        >
          <svg aria-hidden="true" viewBox="0 0 48 48" class="w-4 h-4">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/>
          </svg>
          <span>Continuar con Google</span>
        </button>
        <p class="mt-3 text-xs text-text-secondary text-center leading-relaxed">
          Al continuar con Google aceptas los
          <router-link to="/terminos" target="_blank" class="text-accent-emerald hover:text-accent-emerald-hover underline">Términos</router-link>
          y autorizas el tratamiento de tus datos según la
          <router-link to="/privacidad" target="_blank" class="text-accent-emerald hover:text-accent-emerald-hover underline">Política de datos</router-link>.
        </p>

        <div class="flex items-center my-6 text-xs text-text-secondary">
          <div class="flex-1 h-px bg-white/10"></div>
          <span class="px-3">o con tu correo</span>
          <div class="flex-1 h-px bg-white/10"></div>
        </div>
      </template>

      <!-- Form -->
      <form @submit.prevent="isReset ? handleReset() : handleSubmit()" class="space-y-5">
        <div v-if="isRegister" class="space-y-1">
          <label for="name" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Nombre Completo</label>
          <input 
            id="name"
            v-model="name"
            type="text" 
            required
            autocomplete="name"
            placeholder="John Doe"
            class="field transition-colors"
          />
        </div>

        <div class="space-y-1">
          <label for="email" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Correo Electrónico</label>
          <input 
            id="email"
            v-model="email"
            type="email" 
            required
            autocomplete="email"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            inputmode="email"
            placeholder="correo@ejemplo.com"
            class="field transition-colors"
          />
        </div>

        <div v-if="!isReset" class="space-y-1">
          <div class="flex items-center justify-between">
            <label for="password" class="text-xs font-semibold text-text-secondary uppercase tracking-wider">Contraseña</label>
            <button
              v-if="!isRegister"
              type="button"
              @click="setMode('reset')"
              class="text-xs text-accent-emerald hover:text-accent-emerald-hover font-semibold transition-colors focus:outline-none"
            >
              ¿Olvidaste tu contraseña?
            </button>
          </div>
          <input 
            id="password"
            v-model="password"
            type="password" 
            required
            :autocomplete="isRegister ? 'new-password' : 'current-password'"
            placeholder="••••••••"
            class="field transition-colors"
          />
        </div>

        <label v-if="isRegister" for="legal-consent" class="flex items-start gap-3 text-xs text-text-secondary leading-relaxed cursor-pointer">
          <input
            id="legal-consent"
            v-model="acceptedLegal"
            type="checkbox"
            required
            class="mt-0.5 shrink-0 rounded border-border bg-slate-900/50 text-accent-emerald focus:ring-accent-emerald cursor-pointer"
          />
          <span>
            Acepto los
            <router-link to="/terminos" target="_blank" class="text-accent-emerald hover:text-accent-emerald-hover underline">Términos</router-link>
            y autorizo el tratamiento de mis datos personales según la
            <router-link to="/privacidad" target="_blank" class="text-accent-emerald hover:text-accent-emerald-hover underline">Política de datos</router-link>.
          </span>
        </label>

        <p v-if="noticeMessage" class="text-xs text-accent-emerald font-medium bg-accent-emerald/10 px-3 py-2 rounded-lg border border-accent-emerald/20">
          {{ noticeMessage }}
        </p>

        <!-- Error message -->
        <p v-if="errorMessage" class="text-xs text-accent-rose font-medium bg-accent-rose/10 px-3 py-2 rounded-lg border border-accent-rose/20">
          {{ errorMessage }}
        </p>

        <!-- Submit Button -->
        <button 
          type="submit"
          :disabled="loading"
          class="w-full min-h-11 py-3.5 rounded-xl bg-accent-emerald hover:bg-accent-emerald-hover text-background font-display font-semibold text-sm tracking-wide shadow-glow-emerald hover:shadow-lg transition-all duration-200 flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-50"
        >
          <span v-if="loading" class="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin"></span>
          <span>{{ isReset ? 'Enviar enlace' : isRegister ? 'Registrarse' : 'Ingresar a la Bóveda' }}</span>
        </button>
      </form>

      <!-- Toggle Mode link -->
      <div v-if="isReset" class="mt-6 text-center text-sm">
        <button
          type="button"
          @click="setMode('login')"
          class="py-2 px-1 min-h-11 text-accent-emerald hover:text-accent-emerald-hover font-semibold transition-colors focus:outline-none"
        >
          Volver a iniciar sesión
        </button>
      </div>
      <div v-else class="mt-6 text-center text-sm">
        <span class="text-text-secondary">
          {{ isRegister ? '¿Ya tienes una cuenta?' : '¿No tienes una cuenta?' }}
        </span>
        <button 
          type="button"
          @click="setMode(isRegister ? 'login' : 'register')" 
          class="ml-1 py-2 px-1 min-h-11 text-accent-emerald hover:text-accent-emerald-hover font-semibold transition-colors focus:outline-none"
        >
          {{ isRegister ? 'Inicia Sesión' : 'Regístrate Gratis' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { PASSWORD_RESET_NOTICE, authErrorMessage } from '@/lib/authProfile'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const router = useRouter()

type Mode = 'login' | 'register' | 'reset'
const mode = ref<Mode>('login')
const isRegister = computed(() => mode.value === 'register')
const isReset = computed(() => mode.value === 'reset')
const name = ref('')
const email = ref('')
const password = ref('')
const acceptedLegal = ref(false)
const errorMessage = ref('')
const noticeMessage = ref('')
const loading = ref(false)

// The email survives the switch to recovery so the user does not retype it.
const setMode = (next: Mode) => {
  if (next !== 'reset') email.value = ''
  mode.value = next
  errorMessage.value = ''
  noticeMessage.value = ''
  name.value = ''
  password.value = ''
  acceptedLegal.value = false
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
    errorMessage.value = authErrorMessage(error)
  } finally {
    loading.value = false
  }
}

const handleGoogle = async () => {
  errorMessage.value = ''
  loading.value = true

  try {
    await authStore.signInWithGoogle()
    await settingsStore.loadSettings()
    router.push({ name: 'Dashboard' })
  } catch (error) {
    console.error('Google Auth Error:', error)
    errorMessage.value = authErrorMessage(error)
  } finally {
    loading.value = false
  }
}

const handleReset = async () => {
  errorMessage.value = ''
  noticeMessage.value = ''
  loading.value = true

  try {
    await authStore.resetPassword(email.value)
    noticeMessage.value = PASSWORD_RESET_NOTICE
  } catch (error) {
    console.error('Password Reset Error:', error)
    errorMessage.value = authErrorMessage(error)
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
