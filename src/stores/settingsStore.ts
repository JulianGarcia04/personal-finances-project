import { defineStore } from 'pinia'
import { db, auth } from '@/lib/firebase'
import { doc, getDoc, updateDoc } from 'firebase/firestore'

// Helper para obtener la URL de las Cloud Functions locales o en producción
const getFunctionUrl = (name: string): string => {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || "vault-finances-dev"
  if (import.meta.env.DEV) {
    return `http://localhost:5001/${projectId}/us-central1/${name}`
  }
  return `https://us-central1-${projectId}.cloudfunctions.net/${name}`
}

interface SettingsState {
  aiEnabled: boolean;
  useCustomKey: boolean;
  hasCustomKey: boolean;
  country: string;
  currency: string;
  loading: boolean;
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    aiEnabled: true,
    useCustomKey: false,
    hasCustomKey: false,
    country: 'CO',
    currency: 'COP',
    loading: false,
  }),
  actions: {
    // Carga la configuración del usuario desde Firestore y verifica si tiene una clave guardada
    async loadSettings(): Promise<void> {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        // 1. Cargar configuraciones generales del perfil del usuario
        const userDoc = await getDoc(doc(db, 'users', user.uid))
        if (userDoc.exists()) {
          const data = userDoc.data()
          this.aiEnabled = data.aiEnabled !== undefined ? data.aiEnabled : true
          this.useCustomKey = data.useCustomKey !== undefined ? data.useCustomKey : false
          this.country = data.country || 'CO'
          this.currency = data.currency || 'COP'
        }

        // 2. Verificar si existe la clave encriptada (sin traer su contenido por seguridad)
        const secureDoc = await getDoc(doc(db, 'users', user.uid, 'secure', 'settings'))
        this.hasCustomKey = secureDoc.exists() && !!secureDoc.data()?.encryptedApiKey
      } catch (error) {
        console.error('Error al cargar configuraciones:', error)
      } finally {
        this.loading = false
      }
    },

    // Guarda los flags generales en el documento del usuario
    async saveSettings({ aiEnabled, useCustomKey, country, currency }: { 
      aiEnabled: boolean; 
      useCustomKey: boolean;
      country: string;
      currency: string;
    }): Promise<void> {
      const user = auth.currentUser
      if (!user) return

      this.loading = true
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          aiEnabled,
          useCustomKey,
          country,
          currency,
        })
        this.aiEnabled = aiEnabled
        this.useCustomKey = useCustomKey
        this.country = country
        this.currency = currency
      } catch (error) {
        console.error('Error al guardar configuraciones:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Envia la API Key al servidor para encriptarla y guardarla en Firestore
    async saveCustomApiKey(apiKey: string): Promise<void> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        const token = await user.getIdToken()
        const url = getFunctionUrl('saveUserApiKey')

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ apiKey })
        })

        if (!response.ok) {
          const errData = await response.json()
          throw new Error(errData.error || 'Error al guardar la API Key en el servidor')
        }

        this.hasCustomKey = true
        // Por defecto, al agregar una clave propia, activamos su uso
        await this.saveSettings({ 
          aiEnabled: this.aiEnabled, 
          useCustomKey: true,
          country: this.country,
          currency: this.currency
        })
      } catch (error) {
        console.error('Error al guardar la API Key:', error)
        throw error
      } finally {
        this.loading = false
      }
    },

    // Invoca la Cloud Function para procesar el extracto usando el Genkit Flow
    async parseStatementText(text?: string, pdfBase64?: string): Promise<any[]> {
      const user = auth.currentUser
      if (!user) throw new Error('Usuario no autenticado')

      this.loading = true
      try {
        const token = await user.getIdToken()
        const url = getFunctionUrl('parseStatement')

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            text,
            pdfBase64,
            useDefaultKey: !this.useCustomKey
          })
        })

        if (!response.ok) {
          const errData = await response.json()
          throw new Error(errData.error || 'Error al procesar el extracto bancario')
        }

        const data = await response.json()
        return data.transactions || []
      } catch (error) {
        console.error('Error al analizar extracto:', error)
        throw error
      } finally {
        this.loading = false
      }
    }
  }
})
