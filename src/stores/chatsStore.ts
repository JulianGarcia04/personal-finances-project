import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { Chat, ChatMessage } from '@/types'
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  orderBy,
  serverTimestamp
} from 'firebase/firestore'

interface ChatsState {
  chats: Chat[];
  activeChatId: string | null;
  loading: boolean;
}

const parseDate = (val: any): Date => {
  if (!val) return new Date()
  if (typeof val.toDate === 'function') return val.toDate()
  return new Date(val)
}

export const useChatsStore = defineStore('chats', {
  state: (): ChatsState => ({
    chats: [],
    activeChatId: null,
    loading: false
  }),
  getters: {
    activeChat: (state): Chat | null => {
      if (!state.activeChatId) return null
      return state.chats.find(c => c.id === state.activeChatId) || null
    }
  },
  actions: {
    // 1. Obtener listado de chats del usuario
    async fetchChats(): Promise<void> {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        const q = query(
          collection(db, 'chats'),
          where('userId', '==', user.uid),
          orderBy('updatedAt', 'desc')
        )
        const querySnapshot = await getDocs(q)
        const chatsList: Chat[] = []
        querySnapshot.forEach((docSnap) => {
          const data = docSnap.data()
          chatsList.push({
            id: docSnap.id,
            userId: data.userId,
            title: data.title || 'Conversación sin título',
            messages: data.messages || [],
            createdAt: parseDate(data.createdAt),
            updatedAt: parseDate(data.updatedAt)
          } as Chat)
        })
        this.chats = chatsList
      } catch (error) {
        console.error('Error al cargar conversaciones de chat:', error)
      } finally {
        this.loading = false
      }
    },

    // 2. Crear una nueva conversación
    async createChat(): Promise<string> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        const newChatData = {
          userId: user.uid,
          title: 'Nueva conversación',
          messages: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }

        const docRef = await addDoc(collection(db, 'chats'), newChatData)
        
        const newChat: Chat = {
          id: docRef.id,
          userId: user.uid,
          title: 'Nueva conversación',
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date()
        }
        
        this.chats.unshift(newChat)
        this.activeChatId = docRef.id
        return docRef.id
      } catch (error) {
        console.error('Error al crear conversación:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 3. Guardar mensaje en Firestore y memoria
    async addMessageToChat(chatId: string, role: 'user' | 'assistant', content: string): Promise<void> {
      const chatIndex = this.chats.findIndex(c => c.id === chatId)
      if (chatIndex === -1) return

      const newMessage: ChatMessage = {
        role,
        content,
        createdAt: new Date().toISOString()
      }

      const chat = this.chats[chatIndex]
      chat.messages.push(newMessage)

      // Auto-generación de título con el primer mensaje del usuario
      let updatedTitle = chat.title
      if (role === 'user' && chat.messages.filter(m => m.role === 'user').length === 1) {
        const cleanContent = content.trim()
        if (cleanContent.length > 30) {
          updatedTitle = cleanContent.substring(0, 27) + '...'
        } else {
          updatedTitle = cleanContent
        }
        chat.title = updatedTitle
      }

      this.loading = true
      try {
        const chatRef = doc(db, 'chats', chatId)
        await updateDoc(chatRef, {
          title: updatedTitle,
          messages: chat.messages,
          updatedAt: serverTimestamp()
        })
        
        // Mover el chat al inicio de la lista local
        const [movedChat] = this.chats.splice(chatIndex, 1)
        movedChat.updatedAt = new Date()
        this.chats.unshift(movedChat)
      } catch (error) {
        console.error('Error al guardar mensaje en Firestore:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 4. Eliminar conversación
    async deleteChat(chatId: string): Promise<void> {
      this.loading = true
      try {
        await deleteDoc(doc(db, 'chats', chatId))
        this.chats = this.chats.filter(c => c.id !== chatId)
        
        // Si el chat eliminado era el activo, seleccionar otro o dejar en null
        if (this.activeChatId === chatId) {
          this.activeChatId = this.chats.length > 0 ? this.chats[0].id : null
        }
      } catch (error) {
        console.error('Error al eliminar conversación:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // 5. Seleccionar conversación activa
    setActiveChat(chatId: string | null): void {
      this.activeChatId = chatId
    }
  }
})
