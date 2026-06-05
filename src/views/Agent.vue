<template>
  <div class="max-w-4xl mx-auto h-[calc(100vh-7rem)] flex flex-col justify-between">
    <!-- Chat Header -->
    <div class="glass-panel rounded-2xl p-4 border border-white/5 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-accent-amber to-accent-violet flex items-center justify-center shadow-glow-amber">
          <SparklesIcon class="w-5 h-5 text-slate-950" />
        </div>
        <div>
          <h2 class="font-display font-bold text-lg text-text-primary tracking-tight">Asesor Financiero IA</h2>
          <div class="flex items-center space-x-1.5 mt-0.5">
            <span class="w-2 h-2 rounded-full bg-accent-emerald animate-pulse"></span>
            <span class="text-[10px] text-text-secondary font-semibold uppercase tracking-wider">Activo & Conectado</span>
          </div>
        </div>
      </div>

      <div class="text-[10px] bg-slate-950/45 border border-white/5 px-3 py-1.5 rounded-lg text-text-secondary flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-accent-amber"></span>
        <span>Modo Agente con acceso a BD</span>
      </div>
    </div>

    <!-- Message History Area -->
    <div 
      ref="messageAreaRef"
      class="flex-1 overflow-y-auto py-6 space-y-4 px-2 scrollbar-thin scroll-smooth"
    >
      <!-- Suggestions when no messages -->
      <div 
        v-if="messages.length === 0" 
        class="flex flex-col items-center justify-center h-full text-center space-y-6 max-w-lg mx-auto py-12"
      >
        <div class="space-y-2">
          <h3 class="font-display font-bold text-xl text-text-primary">¿En qué puedo ayudarte hoy?</h3>
          <p class="text-text-secondary text-sm">
            Soy tu asesor financiero y contador personal impulsado por IA. Puedo consultar tu información de cuentas y transacciones, indexar tus movimientos e incluso crear registros por ti.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
          <button 
            v-for="chip in suggestionChips" 
            :key="chip"
            @click="sendSuggestion(chip)"
            class="p-3.5 text-left rounded-xl bg-slate-950/45 hover:bg-slate-900 border border-white/5 hover:border-accent-amber/20 text-xs text-text-secondary hover:text-text-primary transition-all duration-200 cursor-pointer"
          >
            {{ chip }}
          </button>
        </div>
      </div>

      <!-- Chat Bubbles -->
      <div 
        v-else 
        v-for="(msg, idx) in messages" 
        :key="idx"
        :class="['flex', msg.role === 'user' ? 'justify-end animate-slide-left' : 'justify-start animate-slide-right']"
      >
        <div 
          :class="[
            'max-w-[80%] rounded-2xl p-4 text-sm border shadow-md space-y-1',
            msg.role === 'user' 
              ? 'bg-gradient-to-tr from-slate-900 to-slate-950 border-white/5 text-text-primary rounded-tr-none' 
              : 'bg-slate-950/45 border-white/5 text-text-secondary rounded-tl-none font-sans leading-relaxed'
          ]"
        >
          <!-- Message Sender Header -->
          <div class="flex items-center space-x-2 text-[10px] text-text-muted font-bold uppercase mb-1">
            <span>{{ msg.role === 'user' ? 'Tú' : 'Asesor IA' }}</span>
          </div>

          <!-- Message Body with custom parsed markdown -->
          <div 
            class="markdown-content"
            v-html="renderMarkdown(msg.content)"
          ></div>
        </div>
      </div>

      <!-- Typing Indicator -->
      <div v-if="loading" class="flex justify-start">
        <div class="bg-slate-950/45 border border-white/5 rounded-2xl rounded-tl-none p-4 flex items-center space-x-1.5 shadow-md">
          <span class="w-2 h-2 rounded-full bg-accent-amber animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-2 h-2 rounded-full bg-accent-amber animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-2 h-2 rounded-full bg-accent-amber animate-bounce" style="animation-delay: 300ms"></span>
        </div>
      </div>
    </div>

    <!-- Suggestion chips (Floating context-aware shortcuts when messages exist) -->
    <div v-if="messages.length > 0 && !loading" class="flex overflow-x-auto gap-2 pb-3 pt-1 scrollbar-none">
      <button 
        v-for="chip in contextChips" 
        :key="chip"
        @click="sendSuggestion(chip)"
        class="whitespace-nowrap px-3.5 py-2 rounded-full bg-slate-900 border border-white/5 hover:border-accent-amber/25 text-[11px] text-text-secondary hover:text-text-primary transition-all cursor-pointer"
      >
        {{ chip }}
      </button>
    </div>

    <!-- Input Bar -->
    <div class="glass-panel rounded-2xl p-3 border border-white/5 flex items-center gap-3">
      <input 
        v-model="inputMessage"
        type="text"
        :disabled="loading"
        class="flex-1 px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-sm text-text-primary focus:border-accent-amber/40 focus:outline-hidden transition-all"
        placeholder="Pregúntame sobre tus gastos, metas o pídeme crear una cuenta..."
        @keyup.enter="sendMessage"
      />
      <button 
        @click="sendMessage"
        :disabled="loading || !inputMessage.trim()"
        class="p-3.5 rounded-xl bg-accent-amber hover:bg-accent-amber-hover text-slate-950 disabled:bg-slate-900 disabled:text-text-muted transition-all cursor-pointer"
      >
        <SendIcon class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { Sparkles as SparklesIcon, Send as SendIcon } from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// State
const messages = ref<Message[]>([])
const inputMessage = ref('')
const loading = ref(false)
const messageAreaRef = ref<HTMLDivElement | null>(null)

const suggestionChips = [
  '¿Cuál es mi patrimonio neto actual?',
  'Dáme un resumen de mis gastos de este mes',
  'Registra un gasto de 30000 COP en Comida hoy',
  '¿Cómo voy con mis metas de ahorro?'
]

const contextChips = [
  'Dáme consejos para ahorrar',
  '¿Tengo transacciones sin indexar?',
  'Indexa mis transacciones ahora',
  'Crea una cuenta llamada Efectivo con saldo 50000 COP'
]

onMounted(async () => {
  // Pre-cargar datos del store para que estén disponibles de inmediato si el agente los necesita de manera local
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchTransactions()
})

const scrollToBottom = async () => {
  await nextTick()
  if (messageAreaRef.value) {
    messageAreaRef.value.scrollTop = messageAreaRef.value.scrollHeight
  }
}

// Function dynamic URL mapper (similar to settingsStore)
const getFunctionUrl = (name: string): string => {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "vault-finances-dev"
  if (import.meta.env.DEV) {
    return `http://localhost:5001/${projectId}/us-central1/${name}`
  }
  return `https://us-central1-${projectId}.cloudfunctions.net/${name}`
}

const sendMessage = async () => {
  if (!inputMessage.value.trim() || loading.value) return

  const userText = inputMessage.value.trim()
  messages.value.push({ role: 'user', content: userText })
  inputMessage.value = ''
  loading.value = true
  await scrollToBottom()

  try {
    const user = authStore.user
    if (!user) throw new Error('Usuario no autenticado')

    // Obtener el ID Token actualizable
    // Nota: importamos firebase auth directo para asegurar token actualizado
    const { auth } = await import('@/lib/firebase')
    const activeUser = auth.currentUser
    if (!activeUser) throw new Error('No se pudo verificar la sesión actual.')
    const tokenJwt = await activeUser.getIdToken()

    const url = getFunctionUrl('chatWithAgent')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenJwt}`
      },
      body: JSON.stringify({
        messages: messages.value,
        useDefaultKey: !settingsStore.useCustomKey
      })
    })

    if (!response.ok) {
      const errData = await response.json()
      throw new Error(errData.error || 'Error al conectar con el Asesor IA')
    }

    const data = await response.json()
    messages.value.push({
      role: 'assistant',
      content: data.response || 'No recibí respuesta del asesor.'
    })

    // Sincronizar datos locales en segundo plano por si el agente creó cuentas o transacciones
    await accountsStore.fetchAccounts()
    await transactionsStore.fetchTransactions()

  } catch (err: any) {
    console.error('Error del Asesor IA:', err)
    messages.value.push({
      role: 'assistant',
      content: `⚠️ Error de conexión: ${err.message}. Asegúrate de tener los emuladores o el backend en ejecución.`
    })
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

const sendSuggestion = (text: string) => {
  inputMessage.value = text
  sendMessage()
}

// Custom simple markdown parser
const renderMarkdown = (text: string): string => {
  if (!text) return ''
  
  // Escapar HTML básico
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Negrita (**texto**)
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  
  // Iconos o chips de código (`código`)
  html = html.replace(/`(.*?)`/g, '<code class="px-1.5 py-0.5 rounded bg-slate-950 font-mono text-xs text-accent-amber border border-white/5">$1</code>')

  // Bullet points
  html = html.replace(/^[-\*]\s+(.*?)$/gm, '<li class="ml-4 list-disc">$1</li>')

  // Nuevas líneas a <br>
  html = html.replace(/\n/g, '<br>')

  return html
}
</script>

<style>
/* Animations */
@keyframes slideLeft {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes slideRight {
  from { opacity: 0; transform: translateX(-12px); }
  to { opacity: 1; transform: translateX(0); }
}
.animate-slide-left {
  animation: slideLeft 0.2s ease-out forwards;
}
.animate-slide-right {
  animation: slideRight 0.2s ease-out forwards;
}

/* Custom scrollbar hides */
.scrollbar-none::-webkit-scrollbar {
  display: none;
}
.scrollbar-none {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.markdown-content li {
  margin-top: 0.25rem;
}
.markdown-content strong {
  color: var(--color-text-primary);
}
</style>
