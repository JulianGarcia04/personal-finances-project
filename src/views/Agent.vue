<template>
  <div class="agent-shell max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
    
    <!-- Sidebar de Conversaciones (Escritorio) -->
    <div class="hidden lg:flex lg:col-span-1 flex-col justify-between glass-panel rounded-2xl p-4 border border-white/5 h-full overflow-hidden">
      <div class="flex flex-col h-full overflow-hidden">
        <h3 class="font-display font-bold text-sm text-text-primary tracking-wide mb-3 uppercase text-accent-amber/80">
          Conversaciones
        </h3>
        
        <!-- Botón Nueva Conversación -->
        <button 
          @click="createNewConversation"
          class="w-full min-h-11 flex items-center justify-center space-x-2 px-4 py-3 rounded-xl border border-dashed border-accent-amber/20 hover:border-accent-amber/40 bg-accent-amber/5 hover:bg-accent-amber/10 text-accent-amber text-xs font-semibold tracking-wide transition-all cursor-pointer"
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
              class="hover-device:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer shrink-0"
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Conversaciones"
          class="w-72 max-w-[85vw] bg-[#0b0f19] border-r border-white/5 h-full px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] flex flex-col justify-between animate-slide-right"
        >
          <div class="flex flex-col h-full overflow-hidden">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-display font-bold text-sm text-text-primary tracking-wide uppercase text-accent-amber/80">
                Conversaciones
              </h3>
              <button @click="showHistoryDrawer = false" aria-label="Cerrar historial" class="tap -mr-2 flex items-center justify-center rounded-xl hover:bg-white/5 text-text-muted hover:text-text-primary transition-all">
                <XIcon class="w-5 h-5" />
              </button>
            </div>
            
            <!-- Botón Nueva Conversación en Móvil -->
            <button 
              @click="createNewConversation"
              class="w-full min-h-11 flex items-center justify-center space-x-2 px-4 py-3 rounded-xl border border-dashed border-accent-amber/20 hover:border-accent-amber/40 bg-accent-amber/5 hover:bg-accent-amber/10 text-accent-amber text-xs font-semibold tracking-wide transition-all cursor-pointer"
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
                  aria-label="Eliminar conversación"
                  class="tap -my-1.5 -mr-1.5 flex items-center justify-center rounded-lg text-text-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-all cursor-pointer shrink-0"
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
      <div class="glass-panel rounded-2xl p-2.5 sm:p-4 border border-white/5 flex items-center justify-between gap-3 shrink-0">
        <div class="min-w-0 flex items-center space-x-3">
          <!-- Botón Historial para Móviles -->
          <button 
            @click="showHistoryDrawer = true" 
            aria-label="Ver conversaciones"
            class="lg:hidden tap shrink-0 flex items-center justify-center rounded-xl bg-slate-950 border border-white/5 text-text-secondary hover:text-text-primary transition-all cursor-pointer"
          >
            <HistoryIcon class="w-5 h-5" />
          </button>
          
          <div class="hidden sm:flex w-10 h-10 shrink-0 rounded-xl bg-gradient-to-tr from-accent-amber to-accent-violet items-center justify-center shadow-glow-amber">
            <SparklesIcon class="w-5 h-5 text-slate-950" />
          </div>
          <div class="min-w-0">
            <h2 class="font-display font-bold text-base sm:text-lg text-text-primary tracking-tight truncate">Asesor Financiero IA</h2>
            <div class="flex items-center space-x-1.5 mt-0.5">
              <span class="w-2 h-2 rounded-full bg-accent-emerald animate-pulse"></span>
              <span class="text-[10px] text-text-secondary font-semibold uppercase tracking-wider">Activo & Conectado</span>
            </div>
          </div>
        </div>

        <div class="hidden sm:flex shrink-0 text-[10px] bg-slate-950/45 border border-white/5 px-3 py-1.5 rounded-lg text-text-secondary items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-accent-amber"></span>
          <span class="hidden sm:inline">Modo Agente con acceso a BD</span>
          <span class="sm:hidden">Agente IA</span>
        </div>
      </div>

      <!-- Message History Area -->
      <div 
        ref="messageAreaRef"
        class="flex-1 min-h-0 overflow-y-auto overscroll-contain py-4 sm:py-6 space-y-4 px-1 sm:px-2 scrollbar-thin scroll-smooth"
      >
        <!-- Suggestions when no active chat or empty messages -->
        <div 
          v-if="!activeChatMessages || activeChatMessages.length === 0" 
          class="flex flex-col items-center justify-center min-h-full text-center space-y-6 max-w-lg mx-auto py-6 sm:py-12"
        >
          <div class="space-y-2">
            <h3 class="font-display font-bold text-xl text-text-primary">¿En qué puedo ayudarte hoy?</h3>
            <p class="text-text-secondary text-sm">
              Soy tu asesor financiero y contador personal impulsado por IA. Puedo resumir y comparar tus gastos, revisar tu presupuesto, buscar movimientos e incluso crear registros por ti.
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
            <button 
              v-for="chip in suggestionChips" 
              :key="chip"
              @click="sendSuggestion(chip)"
              class="min-h-11 p-3.5 text-left rounded-xl bg-slate-950/45 hover:bg-slate-900 border border-white/5 hover:border-accent-amber/20 text-xs text-text-secondary hover:text-text-primary transition-all duration-200 cursor-pointer"
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
            :role="msg.isError ? 'alert' : undefined"
            :class="[
              'max-w-[88%] sm:max-w-[80%] min-w-0 break-words rounded-2xl p-3.5 sm:p-4 text-sm border shadow-md space-y-1',
              msg.role === 'user' 
                ? 'bg-gradient-to-tr from-slate-900 to-slate-950 border-white/5 text-text-primary rounded-tr-none' 
                : msg.isError
                  ? 'bg-accent-rose/5 border-accent-rose/20 text-text-secondary rounded-tl-none font-sans leading-relaxed'
                  : 'bg-slate-950/45 border-white/5 text-text-secondary rounded-tl-none font-sans leading-relaxed'
            ]"
          >
            <!-- Message Sender Header -->
            <div :class="['flex items-center space-x-2 text-[10px] font-bold uppercase mb-1', msg.isError ? 'text-accent-rose' : 'text-text-muted']">
              <span>{{ msg.role === 'user' ? 'Tú' : msg.isError ? 'Error' : 'Asesor IA' }}</span>
            </div>

            <!-- Message Body with custom parsed markdown -->
            <div 
              class="markdown-content"
              v-html="renderAgentMarkdown(msg.content)"
            ></div>

            <!-- Retry affordance: only on the latest error notice -->
            <button
              v-if="msg.isError && idx === activeChatMessages.length - 1 && !loading"
              @click="retryLastMessage"
              class="mt-2 min-h-10 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-slate-950/60 border border-accent-rose/25 hover:border-accent-rose/50 text-xs font-semibold text-text-primary transition-all cursor-pointer"
            >
              <RetryIcon class="w-3.5 h-3.5" />
              <span>Reintentar</span>
            </button>
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
          class="whitespace-nowrap min-h-10 px-3.5 py-2 rounded-full bg-slate-900 border border-white/5 hover:border-accent-amber/25 text-xs text-text-secondary hover:text-text-primary transition-all cursor-pointer"
        >
          {{ chip }}
        </button>
      </div>

      <!-- Input Bar -->
      <div class="glass-panel rounded-2xl p-2 sm:p-3 border border-white/5 flex items-end gap-2 sm:gap-3 shrink-0">
        <textarea
          ref="inputRef"
          v-model="inputMessage"
          :disabled="loading"
          :maxlength="MAX_USER_MESSAGE_CHARS"
          rows="1"
          aria-label="Mensaje para el asesor"
          :enterkeyhint="isCoarsePointer ? 'enter' : 'send'"
          class="flex-1 min-w-0 px-4 py-3 rounded-xl bg-slate-950 border border-white/5 text-base sm:text-sm text-text-primary focus:border-accent-amber/40 focus:outline-hidden transition-colors resize-none max-h-40 overflow-y-auto"
          :placeholder="inputPlaceholder"
          @input="autoResize"
          @keydown.enter.exact="onEnterKey"
        ></textarea>
        <button 
          @click="sendMessage"
          :disabled="loading || !inputMessage.trim()"
          aria-label="Enviar mensaje"
          class="tap shrink-0 flex items-center justify-center p-3.5 rounded-xl bg-accent-amber hover:bg-accent-amber-hover text-slate-950 disabled:bg-slate-900 disabled:text-text-muted transition-all cursor-pointer"
        >
          <SendIcon class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAccountsStore } from '@/stores/accountsStore'
import { useTransactionsStore } from '@/stores/transactionsStore'
import { useGoalsStore } from '@/stores/goalsStore'
import { useChatsStore } from '@/stores/chatsStore'
import type { ChatMessage } from '@/types'
import { 
  Sparkles as SparklesIcon, 
  Send as SendIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  MessageSquare as ChatIcon,
  History as HistoryIcon,
  RotateCcw as RetryIcon,
  X as XIcon
} from 'lucide-vue-next'
import { renderAgentMarkdown } from '@/lib/agentMarkdown'

const authStore = useAuthStore()
const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const transactionsStore = useTransactionsStore()
const goalsStore = useGoalsStore()
const chatsStore = useChatsStore()

// Request limits mirrored from functions/src/http.ts (server: 50 messages,
// 4000 chars per user message, 16000 per assistant message).
const MAX_HISTORY_MESSAGES = 40
const MAX_USER_MESSAGE_CHARS = 4000
const MAX_ASSISTANT_MESSAGE_CHARS = 8000

// Error notices are UI-only; legacy chats may still hold persisted "⚠️ …" notices.
const isErrorNotice = (m: ChatMessage) =>
  m.isError === true || (m.role === 'assistant' && m.content.startsWith('⚠️'))

// Sends only the recent history (without error notices), starting at a user turn,
// with each message clipped to the server limits.
const toBackendMessages = (messages: ChatMessage[]) => {
  const recent = messages.filter(m => !isErrorNotice(m)).slice(-MAX_HISTORY_MESSAGES)
  const firstUser = recent.findIndex(m => m.role === 'user')
  return recent.slice(Math.max(firstUser, 0)).map(m => ({
    role: m.role,
    content: m.content.slice(0, m.role === 'user' ? MAX_USER_MESSAGE_CHARS : MAX_ASSISTANT_MESSAGE_CHARS)
  }))
}

// State
const inputMessage = ref('')
const loading = ref(false)
const messageAreaRef = ref<HTMLDivElement | null>(null)
const showHistoryDrawer = ref(false)

const suggestionChips = [
  'Resumen de mis gastos de este mes',
  'Compara este mes con el anterior',
  '¿Cómo voy con mi presupuesto?',
  'Mis 5 gastos más grandes del mes',
  '¿Cuál es mi patrimonio neto actual?',
  'Registra un gasto de 30000 COP en Comida hoy'
]

const contextChips = [
  'Resumen de mis gastos de este mes',
  'Compara este mes con el anterior',
  '¿Cómo voy con mi presupuesto?',
  'Mis 5 gastos más grandes del mes',
  '¿Cuándo compré ropa?',
  '¿Cómo voy con mis metas de ahorro?',
  'Dáme consejos para ahorrar',
  'Crea una cuenta llamada Efectivo con saldo 50000 COP'
]

const inputRef = ref<HTMLTextAreaElement | null>(null)

// Touch keyboards: Enter inserts a newline and only the send button sends. Desktop keeps Enter-to-send.
const isCoarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

// The long placeholder wraps (and clips) in the single-row textarea on phones.
const smQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 640px)') : null
const isSmUp = ref(smQuery?.matches ?? true)
const onSmChange = (e: MediaQueryListEvent) => { isSmUp.value = e.matches }
smQuery?.addEventListener('change', onSmChange)
onBeforeUnmount(() => smQuery?.removeEventListener('change', onSmChange))
const inputPlaceholder = computed(() =>
  isSmUp.value ? 'Pregúntame sobre tus gastos, metas o pídeme crear una cuenta...' : 'Pregunta a tu asesor…'
)

const onEnterKey = (event: KeyboardEvent) => {
  if (isCoarsePointer || event.isComposing) return
  event.preventDefault()
  sendMessage()
}

// Grow the textarea with its content up to its CSS max-height (max-h-40).
const autoResize = () => {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
watch(inputMessage, () => nextTick(autoResize))

// Close the mobile history drawer with Esc.
const onDrawerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') showHistoryDrawer.value = false
}
watch(showHistoryDrawer, (open) => {
  if (open) document.addEventListener('keydown', onDrawerKeydown)
  else document.removeEventListener('keydown', onDrawerKeydown)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onDrawerKeydown))

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

  let chatId = chatsStore.activeChatId
  try {
    if (!authStore.user) throw new Error('Usuario no autenticado')

    // Si no hay un chat activo, crear uno dinámicamente
    if (!chatId) {
      chatId = await chatsStore.createChat()
    }

    // Agregar el mensaje del usuario (los avisos de error previos dejan de ser relevantes)
    chatsStore.clearErrorNotices(chatId)
    await chatsStore.addMessageToChat(chatId, 'user', userText)
    await scrollToBottom()

    await requestReply(chatId)
  } catch (err: any) {
    reportError(chatId ?? chatsStore.activeChatId, err)
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

// Re-sends the history (whose last turn is the unanswered user message) after an error.
const retryLastMessage = async () => {
  const chatId = chatsStore.activeChatId
  if (!chatId || loading.value) return
  chatsStore.clearErrorNotices(chatId)
  loading.value = true
  try {
    await requestReply(chatId)
  } catch (err: any) {
    reportError(chatId, err)
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

const requestReply = async (chatId: string) => {
  // Obtener el ID Token actualizable
  const { auth } = await import('@/lib/firebase')
  const activeUser = auth.currentUser
  if (!activeUser) throw new Error('No se pudo verificar la sesión actual.')
  const tokenJwt = await activeUser.getIdToken()

  const response = await fetch(getFunctionUrl('chatWithAgent'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenJwt}`
    },
    body: JSON.stringify({
      messages: toBackendMessages(activeChatMessages.value),
      useDefaultKey: !settingsStore.useCustomKey
    })
  })

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    // Server-side rejections (quota 429, validation 400/413, ...) carry a user-facing message.
    throw Object.assign(new Error(errData.error || 'Error al conectar con el Asesor IA'), { fromServer: true })
  }

  const data = await response.json()

  // Agregar la respuesta de la IA al chat
  await chatsStore.addMessageToChat(chatId, 'assistant', data.response || 'No recibí respuesta del asesor.')

  // Sincronizar datos locales por si el agente creó cuentas, transacciones o presupuestos.
  // A sync failure must not turn a delivered reply into an error notice.
  try {
    await accountsStore.fetchAccounts()
    await transactionsStore.fetchTransactions()
    await goalsStore.loadBudgetSettings()
  } catch (syncErr) {
    console.error('Error al sincronizar datos tras la respuesta del asesor:', syncErr)
  }
}

// Shows a UI-only error notice; the user's message stays persisted so it can be retried.
const reportError = (chatId: string | null, err: any) => {
  console.error('Error del Asesor IA:', err)
  if (!chatId) return
  chatsStore.addErrorNotice(
    chatId,
    err?.fromServer
      ? `⚠️ ${err.message}`
      : `⚠️ Error de conexión: ${err?.message}. Asegúrate de tener los emuladores o el backend en ejecución.`
  )
}

const sendSuggestion = (text: string) => {
  inputMessage.value = text
  sendMessage()
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

/* Fill exactly the visible area inside App <main> padding:
   < lg: top 5rem + notch, bottom 5.5rem + home indicator (fixed header / bottom tab bar); lg: py-8. */
.agent-shell {
  height: calc(100vh - 10.5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  height: calc(100dvh - 10.5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  min-height: 16rem;
}
@media (width >= 64rem) {
  .agent-shell {
    height: calc(100vh - 4rem);
    height: calc(100dvh - 4rem);
  }
}

.markdown-content {
  overflow-wrap: anywhere;
}
.markdown-content > * + * {
  margin-top: 0.5rem;
}
.markdown-content pre {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.markdown-content strong {
  color: var(--color-text-primary);
}
.markdown-content em {
  font-style: italic;
}
.markdown-content .md-heading {
  font-family: var(--font-display, inherit);
  font-weight: 700;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.markdown-content .md-heading:not(:first-child) {
  margin-top: 0.9rem;
}
.markdown-content h3.md-heading { font-size: 1rem; }
.markdown-content h4.md-heading { font-size: 0.9375rem; }
.markdown-content h5.md-heading {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: color-mix(in oklab, var(--color-accent-amber) 80%, transparent);
}
.markdown-content .md-ul,
.markdown-content .md-ol {
  padding-left: 1.25rem;
}
.markdown-content .md-ul { list-style: disc; }
.markdown-content .md-ol { list-style: decimal; }
.markdown-content li {
  margin-top: 0.25rem;
}
.markdown-content li::marker {
  color: color-mix(in oklab, var(--color-accent-amber) 70%, transparent);
}
.markdown-content .md-code {
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  background: var(--color-slate-950, #020617);
  border: 1px solid rgb(255 255 255 / 0.05);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  color: var(--color-accent-amber);
}
.markdown-content .md-pre {
  padding: 0.75rem;
  border-radius: 0.75rem;
  background: var(--color-slate-950, #020617);
  border: 1px solid rgb(255 255 255 / 0.05);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
}
.markdown-content .md-link {
  color: var(--color-accent-amber);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.markdown-content .md-hr {
  border: 0;
  border-top: 1px solid rgb(255 255 255 / 0.08);
  margin: 0.9rem 0;
}
/* Tables scroll horizontally inside the bubble on narrow screens. */
.markdown-content .md-table-wrap {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid rgb(255 255 255 / 0.06);
  border-radius: 0.75rem;
  background: rgb(2 6 23 / 0.4);
}
.markdown-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.markdown-content th,
.markdown-content td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  white-space: nowrap;
  overflow-wrap: normal;
}
.markdown-content th {
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
}
.markdown-content td {
  color: var(--color-text-secondary);
  border-top: 1px solid rgb(255 255 255 / 0.04);
}
.markdown-content tbody tr:hover td {
  background: rgb(255 255 255 / 0.02);
}
.markdown-content th.text-right,
.markdown-content td.text-right { text-align: right; }
.markdown-content th.text-center,
.markdown-content td.text-center { text-align: center; }
</style>
