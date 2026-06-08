<template>
  <div class="max-w-6xl mx-auto h-[calc(100vh-7rem)] grid grid-cols-1 lg:grid-cols-4 gap-6">
    
    <!-- Sidebar de Conversaciones (Escritorio) -->
    <div class="hidden lg:flex lg:col-span-1 flex-col justify-between glass-panel rounded-2xl p-4 border border-white/5 h-full overflow-hidden">
      <div class="flex flex-col h-full overflow-hidden">
        <h3 class="font-display font-bold text-sm text-text-primary tracking-wide mb-3 uppercase text-accent-amber/80">
          Conversaciones
        </h3>
        
        <!-- Botón Nueva Conversación -->
        <button 
          @click="createNewConversation"
          class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl border border-dashed border-accent-amber/20 hover:border-accent-amber/40 bg-accent-amber/5 hover:bg-accent-amber/10 text-accent-amber text-xs font-semibold tracking-wide transition-all cursor-pointer"
        >
          <PlusIcon class="w-4 h-4" />
          <span>Nueva Conversación</span>
        </button>

        <!-- Listado de Chats -->
        <div class="flex-1 overflow-y-auto mt-4 space-y-2 pr-1 scrollbar-thin">
          <div v-if="chatsStore.chats.length === 0" class="text-center py-8 text-xs text-text-muted">
            No hay conversaciones previas.
          </div>
          <div 
            v-else
            v-for="chat in chatsStore.chats" 
            :key="chat.id"
            @click="selectChat(chat.id)"
            :class="[
              'group flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer border',
              chatsStore.activeChatId === chat.id 
                ? 'bg-accent-amber/10 border-accent-amber/25 text-text-primary shadow-glow-amber' 
                : 'bg-slate-950/20 border-transparent text-text-secondary hover:bg-white/5 hover:text-text-primary'
            ]"
          >
            <div class="flex items-center space-x-2.5 min-w-0 flex-1">
              <ChatIcon class="w-4 h-4 text-accent-amber/60 shrink-0" />
              <span class="truncate pr-1">{{ chat.title }}</span>
            </div>
            <button 
              @click.stop="deleteConversation(chat.id)"
              class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer shrink-0"
              title="Eliminar conversación"
            >
              <TrashIcon class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Drawer de Conversaciones (Móvil) -->
    <transition name="fade">
      <div v-if="showHistoryDrawer" class="lg:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex">
        <div class="w-72 bg-[#0b0f19] border-r border-white/5 h-full p-4 flex flex-col justify-between animate-slide-right">
          <div class="flex flex-col h-full overflow-hidden">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-display font-bold text-sm text-text-primary tracking-wide uppercase text-accent-amber/80">
                Conversaciones
              </h3>
              <button @click="showHistoryDrawer = false" class="p-1.5 rounded-lg hover:bg-white/5 text-text-muted hover:text-text-primary transition-all">
                <XIcon class="w-4 h-4" />
              </button>
            </div>
            
            <!-- Botón Nueva Conversación en Móvil -->
            <button 
              @click="createNewConversation"
              class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl border border-dashed border-accent-amber/20 hover:border-accent-amber/40 bg-accent-amber/5 hover:bg-accent-amber/10 text-accent-amber text-xs font-semibold tracking-wide transition-all cursor-pointer"
            >
              <PlusIcon class="w-4 h-4" />
              <span>Nueva Conversación</span>
            </button>

            <!-- Listado de Chats en Móvil -->
            <div class="flex-1 overflow-y-auto mt-4 space-y-2 pr-1 scrollbar-thin">
              <div v-if="chatsStore.chats.length === 0" class="text-center py-8 text-xs text-text-muted">
                No hay conversaciones previas.
              </div>
              <div 
                v-else
                v-for="chat in chatsStore.chats" 
                :key="chat.id"
                @click="selectChat(chat.id)"
                :class="[
                  'group flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer border',
                  chatsStore.activeChatId === chat.id 
                    ? 'bg-accent-amber/10 border-accent-amber/25 text-text-primary shadow-glow-amber' 
                    : 'bg-slate-950/20 border-transparent text-text-secondary hover:bg-white/5 hover:text-text-primary'
                ]"
              >
                <div class="flex items-center space-x-2.5 min-w-0 flex-1">
                  <ChatIcon class="w-4 h-4 text-accent-amber/60 shrink-0" />
                  <span class="truncate pr-1">{{ chat.title }}</span>
                </div>
                <button 
                  @click.stop="deleteConversation(chat.id)"
                  class="p-1.5 rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer shrink-0"
                  title="Eliminar conversación"
                >
                  <TrashIcon class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="flex-1" @click="showHistoryDrawer = false"></div>
      </div>
    </transition>

    <!-- Área de Chat Principal -->
    <div class="lg:col-span-3 h-full flex flex-col justify-between overflow-hidden">
      <!-- Chat Header -->
      <div class="glass-panel rounded-2xl p-4 border border-white/5 flex items-center justify-between shrink-0">
        <div class="flex items-center space-x-3">
          <!-- Botón Historial para Móviles -->
          <button 
            @click="showHistoryDrawer = true" 
            class="lg:hidden p-2.5 rounded-xl bg-slate-950 border border-white/5 text-text-secondary hover:text-text-primary transition-all cursor-pointer mr-1"
          >
            <HistoryIcon class="w-4 h-4" />
          </button>
          
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
          <span class="hidden sm:inline">Modo Agente con acceso a BD</span>
          <span class="sm:hidden">Agente IA</span>
        </div>
      </div>

      <!-- Message History Area -->
      <div 
        ref="messageAreaRef"
        class="flex-1 overflow-y-auto py-6 space-y-4 px-2 scrollbar-thin scroll-smooth"
      >
        <!-- Suggestions when no active chat or empty messages -->
        <div 
          v-if="!activeChatMessages || activeChatMessages.length === 0" 
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
          v-for="(msg, idx) in activeChatMessages" 
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
      <div v-if="activeChatMessages && activeChatMessages.length > 0 && !loading" class="flex overflow-x-auto gap-2 pb-3 pt-1 scrollbar-none shrink-0">
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
      <div class="glass-panel rounded-2xl p-3 border border-white/5 flex items-center gap-3 shrink-0">
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useChatsStore } from '@/stores/chatsStore'
import { 
  Sparkles as SparklesIcon, 
  Send as SendIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  MessageSquare as ChatIcon,
  History as HistoryIcon,
  X as XIcon
} from 'lucide-vue-next'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const chatsStore = useChatsStore()

// State
const inputMessage = ref('')
const loading = ref(false)
const messageAreaRef = ref<HTMLDivElement | null>(null)
const showHistoryDrawer = ref(false)

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

// Computed messages of active chat
const activeChatMessages = computed(() => {
  return chatsStore.activeChat?.messages || []
})

onMounted(async () => {
  // Pre-cargar datos del store para que estén disponibles de inmediato si el agente los necesita de manera local
  await accountsStore.fetchAccounts()
  await transactionsStore.fetchTransactions()
  
  // Cargar chats guardados
  await chatsStore.fetchChats()
  
  // Auto-seleccionar la última conversación si existe
  if (chatsStore.chats.length > 0 && !chatsStore.activeChatId) {
    chatsStore.setActiveChat(chatsStore.chats[0].id)
  }
  
  await scrollToBottom()
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

const createNewConversation = async () => {
  showHistoryDrawer.value = false
  await chatsStore.createChat()
  await scrollToBottom()
}

const selectChat = (chatId: string) => {
  chatsStore.setActiveChat(chatId)
  showHistoryDrawer.value = false
  scrollToBottom()
}

const deleteConversation = async (chatId: string) => {
  if (confirm('¿Estás seguro de que deseas eliminar esta conversación?')) {
    await chatsStore.deleteChat(chatId)
  }
}

const sendMessage = async () => {
  if (!inputMessage.value.trim() || loading.value) return

  const userText = inputMessage.value.trim()
  inputMessage.value = ''
  loading.value = true

  try {
    const user = authStore.user
    if (!user) throw new Error('Usuario no autenticado')

    // Si no hay un chat activo, crear uno dinámicamente
    let chatId = chatsStore.activeChatId
    if (!chatId) {
      chatId = await chatsStore.createChat()
    }

    // Agregar el mensaje del usuario
    await chatsStore.addMessageToChat(chatId, 'user', userText)
    await scrollToBottom()

    // Obtener el ID Token actualizable
    const { auth } = await import('@/lib/firebase')
    const activeUser = auth.currentUser
    if (!activeUser) throw new Error('No se pudo verificar la sesión actual.')
    const tokenJwt = await activeUser.getIdToken()

    const url = getFunctionUrl('chatWithAgent')

    // Formatear los mensajes para el backend (eliminando el campo createdAt para que coincida con lo esperado por Genkit)
    const backendMessages = activeChatMessages.value.map(m => ({
      role: m.role,
      content: m.content
    }))

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenJwt}`
      },
      body: JSON.stringify({
        messages: backendMessages,
        useDefaultKey: !settingsStore.useCustomKey
      })
    })

    if (!response.ok) {
      const errData = await response.json()
      throw new Error(errData.error || 'Error al conectar con el Asesor IA')
    }

    const data = await response.json()
    
    // Agregar la respuesta de la IA al chat
    await chatsStore.addMessageToChat(chatId, 'assistant', data.response || 'No recibí respuesta del asesor.')

    // Sincronizar datos locales en segundo plano por si el agente creó cuentas o transacciones
    await accountsStore.fetchAccounts()
    await transactionsStore.fetchTransactions()

  } catch (err: any) {
    console.error('Error del Asesor IA:', err)
    
    // Si hay un chat activo, agregar un mensaje de error local
    if (chatsStore.activeChatId) {
      await chatsStore.addMessageToChat(
        chatsStore.activeChatId, 
        'assistant', 
        `⚠️ Error de conexión: ${err.message}. Asegúrate de tener los emuladores o el backend en ejecución.`
      )
    }
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
